require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const { MongoClient, ObjectId } = require('mongodb');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ───────────── Firebase Admin ─────────────
const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
    : require('./serviceAccountKey.json');

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

// ───────────── MongoDB ─────────────
const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.DB_NAME || 'qbank_db';
let db;

async function connectToMongo() {
    const client = new MongoClient(MONGO_URI, {
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 5000
    });
    await client.connect();
    db = client.db(DB_NAME);
    // فهارس مفيدة
    await db.collection('users').createIndex({ uid: 1 }, { unique: true });
    await db.collection('sessions').createIndex({ uid: 1, sessionId: 1 }, { unique: true });
    await db.collection('sessions').createIndex({ uid: 1, updatedAt: -1 });
    console.log('✅ MongoDB connected');
}
connectToMongo().catch(err => {
    console.error('❌ MongoDB connection failed:', err);
    process.exit(1);
});

// ───────────── Middlewares ─────────────
async function verifyFirebaseToken(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing Authorization header' });
    }
    try {
        const decoded = await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1]);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

async function requireAdmin(req, res, next) {
    const profile = await db.collection('users').findOne({ uid: req.user.uid });
    if (!profile?.isAdmin) {
        return res.status(403).json({ error: 'Admin only' });
    }
    next();
}

// ───────────── Health ─────────────
app.get('/health', (req, res) =>
    res.json({ status: 'ok', time: new Date().toISOString() })
);

// ───────────── Users ─────────────

// قراءة ملفي الشخصي
app.get('/api/users/me', verifyFirebaseToken, async (req, res) => {
    try {
        const user = await db.collection('users').findOne({ uid: req.user.uid });
        if (!user) return res.status(404).json({ error: 'Profile not found' });
        delete user._id; // لا نرسل ObjectId للتطبيق
        res.json(user);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// إنشاء/تحديث ملفي الشخصي
app.post('/api/users/me', verifyFirebaseToken, async (req, res) => {
    try {
        const {
            firstName = '', lastName = '', phone = '',
            specialty = '', trainingProgram = '', level = '',
            photoUrl = '', profileComplete = true
        } = req.body || {};

        const now = Date.now();
        const update = {
            $set: {
                uid: req.user.uid,
                email: req.user.email || '',
                firstName, lastName, phone,
                specialty, trainingProgram, level,
                photoUrl, profileComplete,
                updatedAt: now
            },
            $setOnInsert: {
                isPro: false,
                isAdmin: false,
                subscriptionType: '',
                subscriptionMethod: '',
                subscriptionExpiry: 0,
                createdAt: now
            }
        };
        await db.collection('users').updateOne(
            { uid: req.user.uid }, update, { upsert: true }
        );

        const saved = await db.collection('users').findOne({ uid: req.user.uid });
        delete saved._id;
        res.json(saved);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// تفعيل اشتراك
app.post('/api/users/me/subscription', verifyFirebaseToken, async (req, res) => {
    try {
        const { method = '', months = 1 } = req.body || {};
        const expiry = Date.now() + months * 30L * 24 * 60 * 60 * 1000;
        await db.collection('users').updateOne(
            { uid: req.user.uid },
            {
                $set: {
                    isPro: true,
                    subscriptionType: `months_${months}`,
                    subscriptionMethod: method,
                    subscriptionExpiry: expiry,
                    updatedAt: Date.now()
                }
            }
        );
        const saved = await db.collection('users').findOne({ uid: req.user.uid });
        delete saved._id;
        res.json(saved);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// قائمة كل المستخدمين (admin)
app.get('/api/users', verifyFirebaseToken, requireAdmin, async (req, res) => {
    try {
        const users = await db.collection('users')
            .find({})
            .sort({ createdAt: -1 })
            .limit(500)
            .toArray();
        users.forEach(u => delete u._id);
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ───────────── Sessions ─────────────

// قائمة جلساتي
app.get('/api/sessions', verifyFirebaseToken, async (req, res) => {
    try {
        const sessions = await db.collection('sessions')
            .find({ uid: req.user.uid })
            .sort({ updatedAt: -1 })
            .limit(50)
            .toArray();
        sessions.forEach(s => delete s._id);
        res.json(sessions);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// حفظ/تحديث جلسة
app.post('/api/sessions', verifyFirebaseToken, async (req, res) => {
    try {
        const {
            sessionId, mode = 'study', subjects = [],
            lastIndex = 0, answers = {}, completed = false, score = null
        } = req.body || {};
        if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

        await db.collection('sessions').updateOne(
            { uid: req.user.uid, sessionId },
            {
                $set: {
                    uid: req.user.uid,
                    sessionId,
                    mode,
                    subjects,
                    lastIndex,
                    answers,
                    completed,
                    score,
                    updatedAt: Date.now()
                }
            },
            { upsert: true }
        );
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ───────────── Config / free_access ─────────────

app.get('/api/config/free_access', verifyFirebaseToken, async (req, res) => {
    try {
        const cfg = await db.collection('config').findOne({ _id: 'free_access' });
        res.json({
            freeReferences: cfg?.freeReferences || [],
            freeTopics: cfg?.freeTopics || []
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/config/free_access', verifyFirebaseToken, requireAdmin, async (req, res) => {
    try {
        const { freeReferences = [], freeTopics = [] } = req.body || {};
        await db.collection('config').updateOne(
            { _id: 'free_access' },
            { $set: { freeReferences, freeTopics, updatedAt: Date.now() } },
            { upsert: true }
        );
        res.json({ ok: true, freeReferences, freeTopics });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ───────────── Questions (كما هي) ─────────────

app.get('/api/references/summary', verifyFirebaseToken, async (req, res) => {
    try {
        const pipeline = [
            { $match: { 'questionData.source.bookName': { $exists: true, $ne: null } } },
            {
                $group: {
                    _id: '$questionData.source.bookName',
                    questionCount: { $sum: 1 },
                    topics: { $addToSet: { specialtyId: '$specialtyId', subjectId: '$subjectId' } }
                }
            },
            {
                $project: {
                    _id: 0,
                    name: '$_id',
                    questionCount: 1,
                    topicCount: { $size: '$topics' }
                }
            },
            { $sort: { name: 1 } }
        ];
        const summary = await db.collection('questions').aggregate(pipeline).toArray();
        res.json(summary);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/references/:bookName/topics', verifyFirebaseToken, async (req, res) => {
    try {
        const bookName = decodeURIComponent(req.params.bookName);
        const pipeline = [
            { $match: { 'questionData.source.bookName': bookName } },
            {
                $group: {
                    _id: { specialtyId: '$specialtyId', subjectId: '$subjectId' },
                    questionCount: { $sum: 1 }
                }
            },
            {
                $project: {
                    _id: 0,
                    specialtyId: '$_id.specialtyId',
                    subjectId: '$_id.subjectId',
                    questionCount: 1
                }
            },
            { $sort: { specialtyId: 1, subjectId: 1 } }
        ];
        const topics = await db.collection('questions').aggregate(pipeline).toArray();
        res.json(topics);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/questions', verifyFirebaseToken, async (req, res) => {
    try {
        const { specialtyId, subjectId, bookName, limit = 300 } = req.query;
        if (!specialtyId || !subjectId) {
            return res.status(400).json({ error: 'specialtyId and subjectId required' });
        }
        const filter = { specialtyId, subjectId };
        if (bookName) filter['questionData.source.bookName'] = bookName;

        const docs = await db.collection('questions')
            .find(filter)
            .limit(Math.min(parseInt(limit), 500))
            .toArray();
        docs.forEach(d => delete d._id);
        res.json(docs);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ───────────── Start ─────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
