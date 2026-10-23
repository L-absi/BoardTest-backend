require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const { MongoClient } = require('mongodb');
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

    await db.collection('users').createIndex({ uid: 1 }, { unique: true });
    await db.collection('sessions').createIndex({ uid: 1, sessionId: 1 }, { unique: true });
    await db.collection('sessions').createIndex({ uid: 1, updatedAt: -1 });
    await db.collection('notifications').createIndex({ timestamp: -1 });

    const existing = await db.collection('config').findOne({ _id: 'free_access' });
    if (!existing) {
        await db.collection('config').insertOne({
            _id: 'free_access',
            freeReferences: [],
            freeTopics: [],
            updatedAt: Date.now()
        });
    }
    console.log('✅ MongoDB connected');
}

connectToMongo().catch(err => {
    console.error('❌ MongoDB connection failed:', err);
    process.exit(1);
});

// ───────────── Middlewares ─────────────
async function verifyFirebaseToken(req, res, next) {
    const h = req.headers.authorization;
    if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' });
    try {
        req.user = await admin.auth().verifyIdToken(h.split('Bearer ')[1]);
        next();
    } catch {
        return res.status(401).json({ error: 'Invalid token' });
    }
}

async function requireAdmin(req, res, next) {
    const profile = await db.collection('users').findOne({ uid: req.user.uid });
    if (!profile?.isAdmin) return res.status(403).json({ error: 'Admin only' });
    next();
}

// ───────────── Health ─────────────
app.get('/health', (req, res) =>
    res.json({ status: 'ok', time: new Date().toISOString() })
);

// ───────────── Users ─────────────

app.get('/api/users/me', verifyFirebaseToken, async (req, res) => {
    try {
        const user = await db.collection('users').findOne({ uid: req.user.uid });
        if (!user) return res.status(404).json({ error: 'Profile not found' });
        delete user._id;
        res.json(user);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/users/me', verifyFirebaseToken, async (req, res) => {
    try {
        const {
            firstName = '', lastName = '', phone = '',
            specialty = '', trainingProgram = '', level = '',
            photoUrl = '', profileComplete = true
        } = req.body || {};
        const now = Date.now();
        await db.collection('users').updateOne(
            { uid: req.user.uid },
            {
                $set: {
                    uid: req.user.uid, email: req.user.email || '',
                    firstName, lastName, phone, specialty, trainingProgram, level,
                    photoUrl, profileComplete, updatedAt: now
                },
                $setOnInsert: {
                    isPro: false, isAdmin: false,
                    subscriptionType: '', subscriptionMethod: '',
                    subscriptionExpiry: 0, createdAt: now
                }
            },
            { upsert: true }
        );
        const saved = await db.collection('users').findOne({ uid: req.user.uid });
        delete saved._id;
        res.json(saved);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/users/me/subscription', verifyFirebaseToken, async (req, res) => {
    try {
        const { method = '', months = 1 } = req.body || {};
        const expiry = Date.now() + months * 30 * 24 * 60 * 60 * 1000;
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
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── جديد: تسجيل FCM token ───
app.post('/api/users/me/fcm-token', verifyFirebaseToken, async (req, res) => {
    try {
        const { token } = req.body || {};
        if (!token) return res.status(400).json({ error: 'token required' });
        await db.collection('users').updateOne(
            { uid: req.user.uid },
            { $addToSet: { fcmTokens: token } }
        );
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── جديد: حذف FCM token عند تسجيل الخروج ───
app.delete('/api/users/me/fcm-token', verifyFirebaseToken, async (req, res) => {
    try {
        const { token } = req.body || {};
        if (token) {
            await db.collection('users').updateOne(
                { uid: req.user.uid },
                { $pull: { fcmTokens: token } }
            );
        }
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── جديد: قائمة المستخدمين (admin) ───
app.get('/api/users', verifyFirebaseToken, requireAdmin, async (req, res) => {
    try {
        const users = await db.collection('users')
            .find({}).sort({ createdAt: -1 }).limit(500).toArray();
        users.forEach(u => {
            delete u._id;
            delete u.fcmTokens; // لا نرسل التوكنات للتطبيق
        });
        res.json(users);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── جديد: مستخدم واحد (admin) ───
app.get('/api/users/:uid', verifyFirebaseToken, requireAdmin, async (req, res) => {
    try {
        const user = await db.collection('users').findOne({ uid: req.params.uid });
        if (!user) return res.status(404).json({ error: 'Not found' });
        delete user._id;
        delete user.fcmTokens;
        res.json(user);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── جديد: تحديث مستخدم (admin) — isPro / isAdmin ───
app.patch('/api/users/:uid', verifyFirebaseToken, requireAdmin, async (req, res) => {
    try {
        const { isPro, isAdmin, subscriptionExpiry, subscriptionType } = req.body || {};
        const updates = {};
        if (typeof isPro === 'boolean') updates.isPro = isPro;
        if (typeof isAdmin === 'boolean') updates.isAdmin = isAdmin;
        if (typeof subscriptionExpiry === 'number') updates.subscriptionExpiry = subscriptionExpiry;
        if (typeof subscriptionType === 'string') updates.subscriptionType = subscriptionType;

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }
        updates.updatedAt = Date.now();
        await db.collection('users').updateOne({ uid: req.params.uid }, { $set: updates });
        const user = await db.collection('users').findOne({ uid: req.params.uid });
        delete user._id;
        delete user.fcmTokens;
        res.json(user);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ───────────── Sessions ─────────────
app.get('/api/sessions', verifyFirebaseToken, async (req, res) => {
    try {
        const s = await db.collection('sessions')
            .find({ uid: req.user.uid }).sort({ updatedAt: -1 }).limit(50).toArray();
        s.forEach(x => delete x._id);
        res.json(s);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/sessions', verifyFirebaseToken, async (req, res) => {
    try {
        const { sessionId, mode = 'study', subjects = [], lastIndex = 0,
                answers = {}, completed = false, score = null } = req.body || {};
        if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
        await db.collection('sessions').updateOne(
            { uid: req.user.uid, sessionId },
            {
                $set: {
                    uid: req.user.uid, sessionId, mode, subjects,
                    lastIndex, answers, completed, score, updatedAt: Date.now()
                }
            },
            { upsert: true }
        );
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ───────────── Notifications (MongoDB + FCM) ─────────────

// قراءة الإشعارات
app.get('/api/notifications', verifyFirebaseToken, async (req, res) => {
    try {
        const list = await db.collection('notifications')
            .find({}).sort({ timestamp: -1 }).limit(100).toArray();
        list.forEach(n => delete n._id);
        res.json(list);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// إنشاء إشعار + إرسال FCM لكل من لديه توكن
app.post('/api/notifications', verifyFirebaseToken, requireAdmin, async (req, res) => {
    try {
        const {
            title = '', body = '',
            actionUrl = '', actionLabel = '', imageUrl = ''
        } = req.body || {};
        if (!title.trim() || !body.trim()) {
            return res.status(400).json({ error: 'title and body required' });
        }

        const notif = {
            title: title.trim(),
            body: body.trim(),
            actionUrl, actionLabel, imageUrl,
            timestamp: Date.now(),
            createdBy: req.user.uid
        };

        const result = await db.collection('notifications').insertOne(notif);

        // ─── إرسال FCM لكل الأجهزة المسجلة ───
        let fcmSent = 0;
        let fcmFailed = 0;
        try {
            const users = await db.collection('users')
                .find({ fcmTokens: { $exists: true, $ne: [] } },
                      { projection: { fcmTokens: 1 } })
                .toArray();

            const allTokens = [...new Set(users.flatMap(u => u.fcmTokens || []))];
            console.log(`📢 Sending FCM to ${allTokens.length} devices…`);

            // FCM يدعم 500 توكن كحد أقصى لكل طلب
            for (let i = 0; i < allTokens.length; i += 500) {
                const batch = allTokens.slice(i, i + 500);
                const response = await admin.messaging().sendEachForMulticast({
                    tokens: batch,
                    notification: { title: notif.title, body: notif.body },
                    data: {
                        actionUrl: notif.actionUrl,
                        actionLabel: notif.actionLabel,
                        notificationId: String(result.insertedId)
                    },
                    android: {
                        priority: 'high',
                        notification: {
                            channelId: 'default',
                            icon: 'ic_notification'
                        }
                    }
                });
                fcmSent += response.successCount;
                fcmFailed += response.failureCount;

                // احذف التوكنات الفاشلة (جهاز معطّل/حُذف التطبيق)
                const failedTokens = [];
                response.responses.forEach((r, idx) => {
                    if (!r.success) failedTokens.push(batch[idx]);
                });
                if (failedTokens.length > 0) {
                    await db.collection('users').updateMany(
                        { fcmTokens: { $in: failedTokens } },
                        { $pull: { fcmTokens: { $in: failedTokens } } }
                    );
                }
            }
        } catch (fcmErr) {
            console.error('FCM send error:', fcmErr);
        }

        res.json({
            ok: true,
            notificationId: String(result.insertedId),
            fcmSent,
            fcmFailed
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ───────────── Config / free_access ─────────────
app.get('/api/config/free_access', verifyFirebaseToken, async (req, res) => {
    try {
        const cfg = await db.collection('config').findOne({ _id: 'free_access' });
        res.json({
            freeReferences: cfg?.freeReferences || [],
            freeTopics: cfg?.freeTopics || []
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/config/free_access', verifyFirebaseToken, requireAdmin, async (req, res) => {
    try {
        const { freeReferences = [], freeTopics = [] } = req.body || {};
        await db.collection('config').updateOne(
            { _id: 'free_access' },
            { $set: { freeReferences, freeTopics, updatedAt: Date.now() } },
            { upsert: true }
        );
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ───────────── Questions ─────────────
app.get('/api/references/summary', verifyFirebaseToken, async (req, res) => {
    try {
        const hiddenCfg = await db.collection('config').findOne({ _id: 'hidden_references' });
        const hidden = new Set(hiddenCfg?.books || []);

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
                    _id: 0, name: '$_id',
                    questionCount: 1, topicCount: { $size: '$topics' }
                }
            },
            { $sort: { name: 1 } }
        ];
        let summary = await db.collection('questions').aggregate(pipeline).toArray();
        summary = summary.filter(s => !hidden.has(s.name));
        res.json(summary);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/references/:bookName/topics', verifyFirebaseToken, async (req, res) => {
    try {
        const bookName = decodeURIComponent(req.params.bookName);
        const hiddenCfg = await db.collection('config').findOne({ _id: 'hidden_references' });
        if (hiddenCfg?.books?.includes(bookName))
            return res.status(404).json({ error: 'Not available' });

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
        res.json(await db.collection('questions').aggregate(pipeline).toArray());
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/questions', verifyFirebaseToken, async (req, res) => {
    try {
        const { specialtyId, subjectId, bookName, limit = 300 } = req.query;
        if (!specialtyId || !subjectId)
            return res.status(400).json({ error: 'specialtyId and subjectId required' });
        const filter = { specialtyId, subjectId };
        if (bookName) filter['questionData.source.bookName'] = bookName;
        const docs = await db.collection('questions')
            .find(filter).limit(Math.min(parseInt(limit), 500)).toArray();
        docs.forEach(d => delete d._id);
        res.json(docs);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ───────────── Start ─────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
