const express = require("express");
const app = express();
const cors = require("cors");
require("dotenv").config(); // Load environment variables from .env file

const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb"); // Import ObjectId

// --- Firebase Admin SDK Initialization ---
const admin = require('firebase-admin');

// MODIFIED: Construct serviceAccount from environment variables
const serviceAccount = {
    "type": process.env.FIREBASE_TYPE,
    "project_id": process.env.FIREBASE_PROJECT_ID,
    "private_key_id": process.env.FIREBASE_PRIVATE_KEY_ID,
    // IMPORTANT: Replace escaped newlines if Vercel doesn't automatically handle them
    // This line ensures the private key is correctly formatted for Firebase Admin SDK
    "private_key": process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    "client_email": process.env.FIREBASE_CLIENT_EMAIL,
    "client_id": process.env.FIREBASE_CLIENT_ID,
    "auth_uri": process.env.FIREBASE_AUTH_URI,
    "token_uri": process.env.FIREBASE_TOKEN_URI,
    "auth_provider_x509_cert_url": process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL,
    "client_x509_cert_url": process.env.FIREBASE_CLIENT_X509_CERT_URL
    // OMITTED: "universe_domain" as it's not typically used by Admin SDK init from service account
};

// Ensure Firebase Admin SDK is initialized only once
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin SDK initialized.");
}


// Declare client and db variables globally
let client;
let db;

// --- Middleware ---
app.use(cors({
    origin: ['http://localhost:5173', 'https://admin-management-client.vercel.app']
}));
app.use(express.json()); // Parse JSON request bodies

// --- MongoDB Connection Setup ---
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.bcrsmwq.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// MODIFIED: connectMongoDB function to be idempotent (safe to call multiple times)
async function connectMongoDB() {
    if (db && client && client.topology && client.topology.isConnected()) {
        console.log("MongoDB already connected.");
        return; // Already connected
    }

    if (!process.env.DB_USER || !process.env.DB_PASS) {
        console.error("MongoDB credentials (DB_USER or DB_PASS) are missing from environment variables.");
        throw new Error("Missing MongoDB credentials.");
    }

    try {
        client = new MongoClient(uri, {
            serverApi: {
                version: ServerApiVersion.v1,
                // MODIFIED: Set strict to false to allow text indexes (or collation indexes)
                strict: false, // Changed from true to false
                deprecationErrors: true,
            },
        });

        await client.connect();
        db = client.db("admin_management_db"); // Using your specific database name

        // Ensure unique index on 'uid' for the 'users' collection
        const usersCollection = db.collection('users');
        await usersCollection.createIndex({ uid: 1 }, { unique: true });
        console.log("Ensured index on 'users' collection for 'uid'.");

        // MODIFIED: Add collation indexes for userReports collection search fields
        const userReportsCollection = db.collection('userReports');

        // REMOVED: The problematic text index creation
        // await userReportsCollection.createIndex({
        //     name: "text",
        //     facebookLink: "text",
        //     phone: "text",
        //     reason: "text",
        //     reporterName: "text",
        //     email: "text",
        //     fbName: "text"
        // }, { name: "search_text_index" });
        // console.log("Removed text index creation for 'userReports' collection.");

        // Add individual indexes with collation for case-insensitive regex efficiency
        await userReportsCollection.createIndex({ name: 1 }, { collation: { locale: 'en', strength: 2 } });
        console.log("Ensured collation index on 'userReports' collection for 'name'.");

        await userReportsCollection.createIndex({ facebookLink: 1 }, { collation: { locale: 'en', strength: 2 } });
        console.log("Ensured collation index on 'userReports' collection for 'facebookLink'.");

        await userReportsCollection.createIndex({ phone: 1 }, { collation: { locale: 'en', strength: 2 } });
        console.log("Ensured collation index on 'userReports' collection for 'phone'.");

        // Keep this one if you still filter by status
        await userReportsCollection.createIndex({ status: 1 });
        console.log("Ensured index on 'userReports' collection for 'status'.");

        await db.command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");

    } catch (error) {
        console.error("Failed to connect to MongoDB Atlas:", error);
        throw error;
    }
}

// MODIFIED: Middleware to ensure database connection for every request
async function ensureDbConnected(req, res, next) {
    try {
        await connectMongoDB();
        next();
    } catch (error) {
        console.error("Database connection error in middleware:", error);
        res.status(500).json({ message: 'Server is unable to connect to the database. Please try again later.' });
    }
}

// Function to close the MongoDB connection gracefully
async function closeMongoDB() {
    if (client && client.topology && client.topology.isConnected()) {
        try {
            await client.close();
            console.log("MongoDB Atlas connection closed.");
            client = null; // Clear client and db
            db = null;
        } catch (error) {
            console.error("Error closing MongoDB connection:", error);
        }
    }
}

// --- Helper function for paginated queries with optional search - UPDATED search and exclusion logic ---
async function fetchPaginatedData(collectionName, baseQuery = {}, req, res) {
    // db is guaranteed to be connected by ensureDbConnected middleware
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 25;
        const skip = (page - 1) * limit;
        const searchTerm = req.query.search;

        const collection = db.collection(collectionName);
        let queryConditions = { ...baseQuery }; // Start with any base query conditions

        if (searchTerm) {
            const searchRegex = new RegExp(searchTerm, 'i'); // Case-insensitive regex for search term

            // 1. Search only 'name', 'facebookLink', 'phone'
            const searchPart = {
                $or: [
                    { name: { $regex: searchRegex } },
                    { facebookLink: { $regex: searchRegex } },
                    { phone: { $regex: searchRegex } }
                ]
            };

            // 2. Exclusion: name should not be equal to reporterName
            const exclusionPart = {
                $expr: {
                    $ne: ["$name", "$reporterName"] // $ne compares the values of the two fields
                }
            };

            // Combine all conditions using $and.
            // This ensures that all criteria (baseQuery, search, AND exclusion) must be met.
            if (Object.keys(queryConditions).length > 0) {
                // If there's an existing baseQuery, combine it with search and exclusion
                queryConditions = {
                    $and: [
                        queryConditions, // The initial base query (e.g., { status: 'suspended' })
                        searchPart,      // The conditions for searching specific fields
                        exclusionPart    // The condition for excluding name == reporterName
                    ]
                };
            } else {
                // If no baseQuery, just combine search and exclusion
                queryConditions = {
                    $and: [
                        searchPart,
                        exclusionPart
                    ]
                };
            }
        }

        // console.log("Final Query:", JSON.stringify(queryConditions, null, 2)); // Uncomment this line for debugging the final query

        const totalCount = await collection.countDocuments(queryConditions);

        const data = await collection.find(queryConditions)
            .skip(skip)
            .limit(limit)
            .toArray();

        res.status(200).json({
            data,
            currentPage: page,
            itemsPerPage: limit,
            totalItems: totalCount,
            totalPages: Math.ceil(totalCount / limit)
        });

    } catch (error) {
        console.error(`Error fetching paginated data from ${collectionName}:`, error);
        res.status(500).json({ message: `Server error while fetching data from ${collectionName}`, error: error.message });
    }
}

// --- Middleware for Admin Token Verification and Role Check ---
// MODIFIED: To use custom claims from Firebase token for role check, reducing DB calls
async function verifyAdminToken(req, res, next) {
    const idToken = req.headers.authorization?.split('Bearer ')[1];

    if (!idToken) {
        return res.status(401).json({ message: 'Unauthorized: No authentication token provided.' });
    }

    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        req.user = decodedToken;

        // Check for custom claims first for performance
        if (decodedToken.role === 'admin' || decodedToken.role === 'superadmin') {
            // Assign userProfile from decodedToken for consistency
            req.userProfile = {
                uid: decodedToken.uid,
                email: decodedToken.email,
                fbName: decodedToken.fbName || 'N/A', // Assuming fbName might be in custom claims or from DB if needed
                status: decodedToken.status || 'approved', // Assuming status might be in custom claims
                role: decodedToken.role
            };
            next();
            return;
        }

        // Fallback to database lookup if custom claims are not present or insufficient
        // This is less performant but provides a robust fallback.
        console.warn("User role not found in custom claims or insufficient, performing database lookup for role verification.");

        // ensureDbConnected middleware already ensures db is connected here.
        const usersCollection = db.collection('users');
        const userProfile = await usersCollection.findOne({ uid: decodedToken.uid });

        if (!userProfile) {
            return res.status(403).json({ message: 'Access denied: User profile not found in database.' });
        }

        if (userProfile.role !== 'admin' && userProfile.role !== 'superadmin') {
            return res.status(403).json({ message: 'Access denied: Insufficient privileges. Requires admin role.' });
        }

        req.userProfile = userProfile; // Attach full user profile from DB
        next();
    } catch (error) {
        console.error('Error verifying Firebase ID token or checking role:', error);
        let errorMessage = 'Unauthorized: Invalid or expired token.';
        if (error.code === 'auth/id-token-expired') {
            errorMessage = 'Unauthorized: Authentication token expired. Please log in again.';
        } else if (error.code === 'auth/argument-error') {
            errorMessage = 'Unauthorized: Invalid authentication token.';
        }
        return res.status(401).json({ message: errorMessage });
    }
}


// --- Routes ---

app.get("/", (req, res) => {
    res.send("Admin Management Server is running successfully!");
});

// Apply ensureDbConnected middleware to all routes that interact with MongoDB
app.post('/api/userReports', ensureDbConnected, async (req, res) => {
    try {
        const userReportsCollection = db.collection('userReports');

        const { name, facebookLink, phone, status, reason, reporterId, reporterName } = req.body;

        if (!name || !facebookLink || !phone || !status || !reason || !reporterId || !reporterName) {
            return res.status(400).json({ message: 'All required fields (name, facebookLink, phone, status, reason, reporterId, reporterName) are required.' });
        }

        const phoneRegex = /^[+]?[0-9\s()-]*$/;
        if (!phoneRegex.test(phone)) {
            return res.status(400).json({ message: 'Invalid phone number format. Please use only digits, +, -, (, ) or spaces.' });
        }

        const urlRegex = /^(https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|https?:\/\/[a-zA-Z0-9]+\.[^\s]{2,}|[a-zA-Z0-9]+\.[^\s]{2,})$/i;
        if (!urlRegex.test(facebookLink)) {
            return res.status(400).json({ message: 'Invalid Facebook link format. Must be a valid URL.' });
        }

        const allowedStatuses = ['suspended', 'banned'];
        if (!allowedStatuses.includes(status)) {
            return res.status(400).json({ message: 'Invalid status provided.' });
        }

        const dataToSave = {
            name,
            facebookLink,
            phone,
            status,
            reason,
            reporterId,
            reporterName,
            timestamp: new Date(),
        };

        const result = await userReportsCollection.insertOne(dataToSave);

        res.status(201).json({
            message: 'User report submitted successfully!',
            insertedId: result.insertedId,
            data: dataToSave
        });

    } catch (error) {
        console.error('Error saving user report to MongoDB:', error);
        res.status(500).json({
            message: 'Failed to submit user report. Please try again later.',
            error: error.message
        });
    }
});

app.delete('/api/userReports/:id', ensureDbConnected, async (req, res) => {
    try {
        const id = req.params.id;

        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ message: 'Invalid ID format.' });
        }

        const userReportsCollection = db.collection('userReports');
        const query = { _id: new ObjectId(id) };

        const result = await userReportsCollection.deleteOne(query);

        if (result.deletedCount === 1) {
            res.status(200).json({ message: 'User report deleted successfully.' });
        } else {
            res.status(404).json({ message: 'User report not found.' });
        }
    } catch (error) {
        console.error('Error deleting user report:', error);
        res.status(500).json({ message: 'Server error while deleting user report.', error: error.message });
    }
});


app.get('/api/userReports', ensureDbConnected, async (req, res) => {
    await fetchPaginatedData('userReports', {}, req, res);
});

app.get('/api/suspendedUsers', ensureDbConnected, async (req, res) => {
    await fetchPaginatedData('userReports', { status: 'suspended' }, req, res);
});

app.get('/api/bannedUsers', ensureDbConnected, async (req, res) => {
    await fetchPaginatedData('userReports', { status: 'banned' }, req, res);
});

app.get('/api/allUserReports', ensureDbConnected, async (req, res) => {
    await fetchPaginatedData('userReports', {}, req, res);
});

// --- User Profiles Routes (for Registration and Login Checks) ---

// POST /api/users - Create a new user profile in MongoDB (initial pending state)
app.post('/api/users', ensureDbConnected, async (req, res) => {
    try {
        const usersCollection = db.collection('users');

        const { uid, email, fbName } = req.body;

        if (!uid || !email || !fbName) {
            return res.status(400).json({ message: 'UID, email, and Facebook Name are required.' });
        }

        const existingUser = await usersCollection.findOne({ uid });
        if (existingUser) {
            console.log(`User with UID ${uid} already has a profile in MongoDB.`);
            return res.status(200).json({
                message: 'User profile already exists for this UID.',
                userProfile: existingUser
            });
        }

        const newUserProfile = {
            uid: uid,
            email: email,
            fbName: fbName,
            status: 'pending',
            role: 'user', // Default role
            registrationDate: new Date()
        };

        const result = await usersCollection.insertOne(newUserProfile);

        res.status(201).json({
            message: 'User profile created successfully! Awaiting admin approval.',
            insertedId: result.insertedId,
            userProfile: newUserProfile
        });

    } catch (error) {
        console.error('Error saving new user profile to MongoDB:', error);
        res.status(500).json({
            message: 'Failed to save user profile. Please try again later.',
            error: error.message
        });
    }
});

// GET /api/users/:uid - Get a single user profile by their Firebase UID
app.get('/api/users/:uid', ensureDbConnected, async (req, res) => {
    try {
        const usersCollection = db.collection('users');
        const uid = req.params.uid;

        const user = await usersCollection.findOne({ uid: uid });

        if (user) {
            res.status(200).json(user);
        } else {
            res.status(404).json({ message: 'User profile not found.' });
        }
    } catch (error) {
        console.error('Error fetching user profile by UID:', error);
        res.status(500).json({ message: 'Server error while fetching user profile.', error: error.message });
    }
});


// --- ADMIN-SPECIFIC ROUTES (Protected by verifyAdminToken) ---

// GET /api/users - Get ALL user profiles (for admin panel display)
app.get('/api/users', ensureDbConnected, verifyAdminToken, async (req, res) => {
    await fetchPaginatedData('users', {}, req, res);
});

// PATCH /api/users/:uid/status - Update a user's approval status
app.patch('/api/users/:uid/status', ensureDbConnected, verifyAdminToken, async (req, res) => {
    try {
        // req.userProfile is available from verifyAdminToken middleware
        if (req.userProfile.role !== 'admin' && req.userProfile.role !== 'superadmin') {
            return res.status(403).json({ message: 'Access denied: Insufficient privileges to change user status.' });
        }

        const usersCollection = db.collection('users');
        const uid = req.params.uid;
        const { status } = req.body;

        if (!status || !['approved', 'pending', 'rejected'].includes(status)) {
            return res.status(400).json({ message: 'Invalid status provided. Must be "approved", "pending", or "rejected".' });
        }

        const result = await usersCollection.updateOne(
            { uid: uid },
            { $set: { status: status } }
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({ message: 'User not found.' });
        }
        if (result.modifiedCount === 0) {
            return res.status(200).json({ message: 'User status already set to this value or no changes made.' });
        }

        // OPTIONAL: Update Firebase Custom Claims if status change impacts login behavior
        // If 'status' is also a claim, you'd update it here.
        // await admin.auth().setCustomUserClaims(uid, { status: status });

        res.status(200).json({ message: `User status updated to '${status}' successfully.` });

    } catch (error) {
        console.error('Error updating user status:', error);
        res.status(500).json({ message: 'Server error while updating user status.', error: error.message });
    }
});

// PATCH /api/users/:uid/role - Update a user's role
app.patch('/api/users/:uid/role', ensureDbConnected, verifyAdminToken, async (req, res) => {
    try {
        if (req.userProfile.role !== 'superadmin') {
            return res.status(403).json({ message: 'Access denied: Only superadmins can change user roles.' });
        }

        const usersCollection = db.collection('users');
        const uid = req.params.uid;
        const { role } = req.body;

        if (!role || !['user', 'admin', 'superadmin'].includes(role)) {
            return res.status(400).json({ message: 'Invalid role provided. Must be "user", "admin", or "superadmin".' });
        }

        if (req.userProfile.uid === uid && role !== 'superadmin') {
            return res.status(400).json({ message: 'Cannot demote your own account from superadmin role.' });
        }

        const result = await usersCollection.updateOne(
            { uid: uid },
            { $set: { role: role } }
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({ message: 'User not found.' });
        }
        if (result.modifiedCount === 0) {
            return res.status(200).json({ message: 'User role already set to this value or no changes made.' });
        }

        // IMPORTANT: Update Firebase Custom Claims when role changes
        // This is crucial for the performance optimization in verifyAdminToken
        await admin.auth().setCustomUserClaims(uid, { role: role });
        console.log(`Updated Firebase custom claims for user ${uid}: role = ${role}`);

        res.status(200).json({ message: `User role updated to '${role}' successfully.` });

    } catch (error) {
        console.error('Error updating user role:', error);
        res.status(500).json({ message: 'Server error while updating user role.', error: error.message });
    }
});

// DELETE /api/users/:uid - Delete user from Firebase Auth and MongoDB
app.delete('/api/users/:uid', ensureDbConnected, verifyAdminToken, async (req, res) => {
    try {
        if (req.userProfile.role !== 'admin' && req.userProfile.role !== 'superadmin') {
            return res.status(403).json({ message: 'Access denied: Insufficient privileges to delete users.' });
        }

        const usersCollection = db.collection('users');
        const uidToDelete = req.params.uid;

        if (req.userProfile.uid === uidToDelete) {
            return res.status(400).json({ message: 'Cannot delete your own account via this interface.' });
        }

        const targetUser = await usersCollection.findOne({ uid: uidToDelete });
        if (targetUser) {
            if (req.userProfile.role === 'admin' && (targetUser.role === 'admin' || targetUser.role === 'superadmin')) {
                return res.status(403).json({ message: 'Admins cannot delete other admins or superadmins.' });
            }
        }

        // 1. Delete user from Firebase Authentication
        try {
            await admin.auth().deleteUser(uidToDelete);
            console.log(`Successfully deleted user ${uidToDelete} from Firebase Authentication.`);
        } catch (firebaseError) {
            if (firebaseError.code === 'auth/user-not-found') {
                console.warn(`User ${uidToDelete} not found in Firebase Auth, proceeding with MongoDB deletion.`);
            } else {
                console.error(`Error deleting user ${uidToDelete} from Firebase Auth:`, firebaseError);
                return res.status(500).json({ message: 'Failed to delete user from Firebase Authentication.', error: firebaseError.message });
            }
        }

        // 2. Delete user profile from MongoDB
        const result = await usersCollection.deleteOne({ uid: uidToDelete });

        if (result.deletedCount === 0 && !targetUser) { // targetUser check is if it was found *before* firebase deletion attempt
            return res.status(404).json({ message: 'User profile not found in database and not deleted from Firebase Auth (if it existed).' });
        }

        res.status(200).json({ message: `User ${uidToDelete} and their profile successfully deleted.` });

    } catch (error) {
        console.error('Error deleting user:', error);
        res.status(500).json({ message: 'Server error during user deletion.', error: error.message });
    }
});


// --- Server Startup (Conditional for Local vs. Vercel) ---
module.exports = app; // This is the standard export for Vercel

// Only listen on a port if not in a production (serverless) environment
if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 5000;
    connectMongoDB().then(() => {
        app.listen(PORT, () => {
            console.log(`Admin Management Server is running locally on port: ${PORT}`);
        });
    }).catch(error => {
        console.error("Failed to start local server due to database connection error:", error);
        process.exit(1); // Exit if DB connection fails at startup
    });
} else {
    // For Vercel (production), the `module.exports = app;` handles server startup.
    // The `ensureDbConnected` middleware will handle the database connection
    // lazily on the first request (cold start) and reuse it for subsequent
    // "warm" requests within the same serverless instance.
    console.log("Running in production environment (e.g., Vercel). Serverless function will handle startup.");
}


// --- Graceful Shutdown (Less critical for serverless, but good for local) ---
// These are primarily for local development servers. Vercel handles function
// lifecycle and connection pooling differently.
process.on('SIGINT', async () => {
    console.log('SIGINT signal received: Attempting to close MongoDB connection.');
    await closeMongoDB();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('SIGTERM signal received: Attempting to close MongoDB connection.');
    await closeMongoDB();
    process.exit(0);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // In production, you might want to log this to an error tracking service
    // rather than exiting immediately, as a single unhandled rejection
    // shouldn't crash the entire serverless instance.
    if (process.env.NODE_ENV !== 'production') {
        process.exit(1);
    }
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    // Similar to unhandled rejections, handle gracefully in production.
    if (process.env.NODE_ENV !== 'production') {
        process.exit(1);
    }
});