require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const { MongoClient } = require('mongodb');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────
// 1) تهيئة Firebase Admin
// ─────────────────────────────────────────────
// الطريقة الآمنة على Render: قراءة JSON من متغير بيئة واحد
// (أو من ملف سري في /etc/secrets/firebase-service-account.json)
let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    // عند النشر على Render نمرر محتوى JSON كاملًا في متغير بيئة
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
} else {
    // عند التشغيل المحلي نقرأ من ملف
    serviceAccount = require('./serviceAccountKey.json');
}

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

// ─────────────────────────────────────────────
// 2) اتصال MongoDB
// ─────────────────────────────────────────────
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
    console.log('✅ Connected to MongoDB Atlas');
}
connectToMongo().catch(err => {
    console.error('❌ MongoDB connection failed:', err);
});

// ─────────────────────────────────────────────
// 3) Middleware للتحقق من Firebase ID Token
// ─────────────────────────────────────────────
async function verifyFirebaseToken(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or malformed Authorization header' });
    }

    const idToken = authHeader.split('Bearer ')[1];
    try {
        // التحقق من التوقيع والصلاحية
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        req.user = decodedToken; // { uid, email, ... }
        next();
    } catch (error) {
        console.error('Token verification failed:', error.message);
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

// ─────────────────────────────────────────────
// 4) نقاط النهاية (API)
// ─────────────────────────────────────────────

// Health check (يستخدمه UptimeRobot)
app.get('/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

// جلب قائمة المراجع (أسماء الكتب) الفريدة
app.get('/api/references', verifyFirebaseToken, async (req, res) => {
    try {
        const collection = db.collection('questions');
        // QuestionData.source.bookName هو المسار في بياناتك
        const books = await collection.distinct('questionData.source.bookName');
        res.json(books.filter(Boolean).sort());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// جلب ملخص المراجع: اسم الكتاب، عدد المواضيع، عدد الأسئلة
app.get('/api/references/summary', verifyFirebaseToken, async (req, res) => {
    try {
        const collection = db.collection('questions');
        const pipeline = [
            { $match: { 'questionData.source.bookName': { $exists: true, $ne: null } } },
            {
                $group: {
                    _id: '$questionData.source.bookName',
                    questionCount: { $sum: 1 },
                    topics: {
                        $addToSet: {
                            specialtyId: '$specialtyId',
                            subjectId: '$subjectId'
                        }
                    }
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
        const summary = await collection.aggregate(pipeline).toArray();
        res.json(summary);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// جلب مواضيع مرجع معين
app.get('/api/references/:bookName/topics', verifyFirebaseToken, async (req, res) => {
    try {
        const bookName = decodeURIComponent(req.params.bookName);
        const collection = db.collection('questions');
        const pipeline = [
            { $match: { 'questionData.source.bookName': bookName } },
            {
                $group: {
                    _id: {
                        specialtyId: '$specialtyId',
                        subjectId: '$subjectId'
                    },
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
        const topics = await collection.aggregate(pipeline).toArray();
        res.json(topics);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// جلب أسئلة موضوع معين
app.get('/api/questions', verifyFirebaseToken, async (req, res) => {
    try {
        const { specialtyId, subjectId, bookName, limit = 300 } = req.query;
        if (!specialtyId || !subjectId) {
            return res.status(400).json({ error: 'specialtyId and subjectId are required' });
        }

        const filter = { specialtyId, subjectId };
        if (bookName) filter['questionData.source.bookName'] = bookName;

        const collection = db.collection('questions');
        const questions = await collection
            .find(filter)
            .limit(Math.min(parseInt(limit), 500))
            .toArray();

        res.json(questions);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ─────────────────────────────────────────────
// 5) تشغيل الخادم
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});