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
};

// Ensure Firebase Admin SDK is initialized only once
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    // console.log("Firebase Admin SDK initialized."); // Removed debug log
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
        // console.log("MongoDB already connected."); // Removed debug log
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
                strict: false,
                deprecationErrors: true,
            },
        });

        await client.connect();
        db = client.db("admin_management_db"); // Using your specific database name

        // Ensure unique index on 'uid' for the 'users' collection
        const usersCollection = db.collection('users');
        await usersCollection.createIndex({ uid: 1 }, { unique: true });
        // console.log("Ensured index on 'users' collection for 'uid'."); // Removed debug log
        await usersCollection.createIndex({ status: 1 });
        // console.log("Ensured index on 'users' collection for 'status'."); // Removed debug log
        await usersCollection.createIndex({ role: 1 });
        // console.log("Ensured index on 'users' collection for 'role'."); // Removed debug log


        // MODIFIED: Add collation indexes for userReports collection search fields
        const userReportsCollection = db.collection('userReports');

        // Add individual indexes with collation for case-insensitive regex efficiency
        await userReportsCollection.createIndex({ name: 1 }, { collation: { locale: 'en', strength: 2 } });
        // console.log("Ensured collation index on 'userReports' collection for 'name'."); // Removed debug log

        await userReportsCollection.createIndex({ facebookLink: 1 }, { collation: { locale: 'en', strength: 2 } });
        // console.log("Ensured collation index on 'userReports' collection for 'facebookLink'."); // Removed debug log

        await userReportsCollection.createIndex({ phone: 1 }, { collation: { locale: 'en', strength: 2 } });
        // console.log("Ensured collation index on 'userReports' collection for 'phone'."); // Removed debug log

        // Keep this one if you still filter by status
        await userReportsCollection.createIndex({ status: 1 });
        // console.log("Ensured index on 'userReports' collection for 'status'."); // Removed debug log

        // New index for soft delete feature
        await userReportsCollection.createIndex({ deletedAt: 1 });
        // console.log("Ensured index on 'userReports' collection for 'deletedAt'."); // Removed debug log
        // NEW: Index for deletedBy field
        await userReportsCollection.createIndex({ deletedBy: 1 });
        // console.log("Ensured index on 'userReports' collection for 'deletedBy'."); // Removed debug log


        await db.command({ ping: 1 });
        // console.log("Pinged your deployment. You successfully connected to MongoDB!"); // Removed debug log

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
            // console.log("MongoDB Atlas connection closed."); // Removed debug log
            client = null; // Clear client and db
            db = null;
        } catch (error) {
            console.error("Error closing MongoDB connection:", error);
        }
    }
}

// NEW: Middleware for general Firebase Auth Token Verification (any logged-in user)
async function verifyAuthToken(req, res, next) {
    const idToken = req.headers.authorization?.split('Bearer ')[1];

    if (!idToken) {
        return res.status(401).json({ message: 'Unauthorized: No authentication token provided.' });
    }

    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        req.user = decodedToken; // Attach decoded token to request for user's UID etc.
        next();
    } catch (error) {
        console.error('Error verifying Firebase ID token:', error);
        let errorMessage = 'Unauthorized: Invalid or expired token.';
        if (error.code === 'auth/id-token-expired') {
            errorMessage = 'Unauthorized: Authentication token expired. Please log in again.';
        } else if (error.code === 'auth/argument-error') {
            errorMessage = 'Unauthorized: Invalid authentication token.';
        }
        return res.status(401).json({ message: errorMessage });
    }
}


// --- Helper function for paginated queries with optional search and dynamic filters ---
async function fetchPaginatedData(collectionName, baseQuery = {}, req, res, includeDeleted = false) {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 25;
        const skip = (page - 1) * limit;
        const searchTerm = req.query.search;
        const statusFilter = req.query.status;
        const roleFilter = req.query.role;

        const collection = db.collection(collectionName);
        let queryConditions = { ...baseQuery };

        if (collectionName === 'userReports') {
            if (!includeDeleted) {
                queryConditions.deletedAt = { $exists: false };
            } else {
                queryConditions.deletedAt = { $exists: true };
            }
        }

        if (statusFilter) {
            queryConditions.status = statusFilter;
        }

        if (roleFilter) {
            const roles = roleFilter.split(',').map(r => r.trim());
            if (roles.length > 1) {
                queryConditions.role = { $in: roles };
            } else {
                queryConditions.role = roles[0];
            }
        }

        if (searchTerm) {
            const searchRegex = new RegExp(searchTerm, 'i');

            let searchFields = [];
            if (collectionName === 'userReports') {
                searchFields = ['name', 'facebookLink', 'phone'];
            } else if (collectionName === 'users') {
                searchFields = ['email', 'fbName'];
            }

            if (searchFields.length > 0) {
                const searchPart = {
                    $or: searchFields.map(field => ({ [field]: { $regex: searchRegex } }))
                };
                queryConditions = { $and: [queryConditions, searchPart] };
            }
        }

        if (collectionName === 'userReports' && searchTerm) {
            const exclusionPart = {
                $expr: {
                    $ne: ["$name", "$reporterName"]
                }
            };
            queryConditions = { $and: [queryConditions, exclusionPart] };
        }

        // console.log(`[fetchPaginatedData] Collection: ${collectionName}, includeDeleted: ${includeDeleted}`); // Removed debug log
        // console.log("[fetchPaginatedData] Initial baseQuery:", baseQuery); // Removed debug log
        // console.log("[fetchPaginatedData] Final MongoDB Query Conditions:", queryConditions); // Removed debug log


        const totalCount = await collection.countDocuments(queryConditions);

        const data = await collection.find(queryConditions)
            .sort({ timestamp: -1 })
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
async function verifyAdminToken(req, res, next) {
    const idToken = req.headers.authorization?.split('Bearer ')[1];

    if (!idToken) {
        return res.status(401).json({ message: 'Unauthorized: No authentication token provided.' });
    }

    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        req.user = decodedToken;

        if (decodedToken.role === 'admin' || decodedToken.role === 'superadmin') {
            req.userProfile = {
                uid: decodedToken.uid,
                email: decodedToken.email,
                fbName: decodedToken.fbName || 'N/A',
                status: decodedToken.status || 'approved',
                role: decodedToken.role
            };
            next();
            return;
        }

        // console.warn("User role not found in custom claims or insufficient, performing database lookup for role verification."); // Removed debug log

        const usersCollection = db.collection('users');
        const userProfile = await usersCollection.findOne({ uid: decodedToken.uid });

        if (!userProfile) {
            return res.status(403).json({ message: 'Access denied: User profile not found in database.' });
        }

        if (userProfile.role !== 'admin' && userProfile.role !== 'superadmin') {
            return res.status(403).json({ message: 'Access denied: Insufficient privileges. Requires admin role.' });
        }

        req.userProfile = userProfile;
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
            // No deletedAt field initially, meaning it's an active report
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

// MODIFIED: Soft delete endpoint for user reports (ONLY FOR 'user' role)
app.delete('/api/userReports/:id', ensureDbConnected, verifyAuthToken, async (req, res) => {
    try {
        const id = req.params.id;
        const requestingUserUid = req.user.uid; // UID of the currently logged-in user

        const usersCollection = db.collection('users');
        const userProfile = await usersCollection.findOne({ uid: requestingUserUid });

        if (!userProfile || userProfile.role !== 'user') {
            return res.status(403).json({ message: 'Access denied: Only regular users can move reports to trash.' });
        }

        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ message: 'Invalid ID format.' });
        }

        const userReportsCollection = db.collection('userReports');
        const report = await userReportsCollection.findOne({ _id: new ObjectId(id) });

        if (!report) {
            return res.status(404).json({ message: 'User report not found.' });
        }

        if (report.reporterId !== requestingUserUid) {
            return res.status(403).json({ message: 'Access denied: You can only move your own reports to trash.' });
        }

        const result = await userReportsCollection.updateOne(
            { _id: new ObjectId(id) },
            {
                $set: {
                    deletedAt: new Date(),
                    deletedBy: requestingUserUid
                }
            }
        );


        if (result.matchedCount === 0) {
            res.status(404).json({ message: 'User report not found or already trashed.' });
        } else if (result.modifiedCount === 0) {
            res.status(200).json({ message: 'User report was already in trash.' });
        } else {
            res.status(200).json({ message: 'User report moved to trash successfully.' });
        }

    } catch (error) {
        console.error('Error soft-deleting user report:', error);
        res.status(500).json({ message: 'Server error while soft-deleting user report.', error: error.message });
    }
});

// NEW ROUTE: Permanent delete endpoint for user reports (ONLY FOR 'admin' or 'superadmin' role)
app.delete('/api/admin/userReports/:id', ensureDbConnected, verifyAdminToken, async (req, res) => {
    try {
        const id = req.params.id;
        const requestingUserRole = req.userProfile.role;

        if (requestingUserRole !== 'admin' && requestingUserRole !== 'superadmin') {
            return res.status(403).json({ message: 'Access denied: Only administrators can permanently delete reports.' });
        }

        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ message: 'Invalid ID format.' });
        }

        const userReportsCollection = db.collection('userReports');
        
        const report = await userReportsCollection.findOne({ _id: new ObjectId(id) });
        if (!report) {
            return res.status(404).json({ message: 'Report not found.' });
        }

        const result = await userReportsCollection.deleteOne({ _id: new ObjectId(id) });

        if (result.deletedCount === 1) {
            res.status(200).json({ message: 'Report permanently deleted successfully.' });
        } else {
            res.status(404).json({ message: 'Report not found or already deleted.' });
        }

    } catch (error) {
        console.error('Error permanently deleting user report by admin:', error);
        res.status(500).json({ message: 'Server error while permanently deleting user report.', error: error.message });
    }
});


// MODIFIED: Get active user reports (excluding soft-deleted ones)
app.get('/api/userReports', ensureDbConnected, async (req, res) => {
    await fetchPaginatedData('userReports', { deletedAt: { $exists: false } }, req, res, false);
});

app.get('/api/suspendedUsers', ensureDbConnected, async (req, res) => {
    await fetchPaginatedData('userReports', { status: 'suspended', deletedAt: { $exists: false } }, req, res, false);
});

app.get('/api/bannedUsers', ensureDbConnected, async (req, res) => {
    await fetchPaginatedData('userReports', { status: 'banned', deletedAt: { $exists: false } }, req, res, false);
});

app.get('/api/allUserReports', ensureDbConnected, async (req, res) => {
    await fetchPaginatedData('userReports', { deletedAt: { $exists: false } }, req, res, false);
});

// NEW: Get trashed user reports (for admin review) - STILL ADMIN ONLY
app.get('/api/trashedReports', ensureDbConnected, verifyAdminToken, async (req, res) => {
    if (req.userProfile.role !== 'admin' && req.userProfile.role !== 'superadmin') {
        return res.status(403).json({ message: 'Access denied: Only admins can view trashed reports.' });
    }
    await fetchPaginatedData('userReports', { deletedAt: { $exists: true } }, req, res, true);
});

// NEW: Endpoint to restore a trashed report (admin action) - STILL ADMIN ONLY
app.patch('/api/trashedReports/:id/restore', ensureDbConnected, verifyAdminToken, async (req, res) => {
    try {
        if (req.userProfile.role !== 'admin' && req.userProfile.role !== 'superadmin') {
            return res.status(403).json({ message: 'Access denied: Only admins can restore reports.' });
        }

        const id = req.params.id;
        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ message: 'Invalid ID format.' });
        }

        const userReportsCollection = db.collection('userReports');
        const query = { _id: new ObjectId(id), deletedAt: { $exists: true } };

        const result = await userReportsCollection.updateOne(
            query,
            {
                $unset: { deletedAt: "", deletedBy: "" }
            }
        );

        if (result.matchedCount === 0) {
            res.status(404).json({ message: 'Trashed report not found or already restored.' });
        } else if (result.modifiedCount === 0) {
            res.status(200).json({ message: 'Report was already restored or no changes made.' });
        } else {
            res.status(200).json({ message: 'Report restored successfully.' });
        }
    } catch (error) {
        console.error('Error restoring trashed report:', error);
        res.status(500).json({ message: 'Server error while restoring trashed report.', error: error.message });
    }
});

// NEW: Endpoint to permanently delete a trashed report (admin action) - STILL ADMIN ONLY
app.delete('/api/trashedReports/:id/permanent', ensureDbConnected, verifyAdminToken, async (req, res) => {
    try {
        if (req.userProfile.role !== 'admin' && req.userProfile.role !== 'superadmin') {
            return res.status(403).json({ message: 'Access denied: Only admins can permanently delete reports.' });
        }

        const id = req.params.id;
        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ message: 'Invalid ID format.' });
        }

        const userReportsCollection = db.collection('userReports');
        const query = { _id: new ObjectId(id), deletedAt: { $exists: true } };

        const result = await userReportsCollection.deleteOne(query);

        if (result.deletedCount === 1) {
            res.status(200).json({ message: 'Report permanently deleted from trash.' });
        } else {
            res.status(404).json({ message: 'Trashed report not found.' });
        }
    } catch (error) {
        console.error('Error permanently deleting trashed report:', error);
        res.status(500).json({ message: 'Server error while permanently deleting trashed report.', error: error.message });
    }
});

// NEW: Bulk action endpoint for trashed reports (admin action) - STILL ADMIN ONLY
app.post('/api/trashedReports/bulk-action', ensureDbConnected, verifyAdminToken, async (req, res) => {
    try {
        if (req.userProfile.role !== 'admin' && req.userProfile.role !== 'superadmin') {
            return res.status(403).json({ message: 'Access denied: Only admins can perform bulk actions on reports.' });
        }

        const { ids, action } = req.body;

        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ message: 'Invalid or empty array of IDs provided.' });
        }

        if (!['restore', 'permanent_delete'].includes(action)) {
            return res.status(400).json({ message: 'Invalid action specified. Must be "restore" or "permanent_delete".' });
        }

        const objectIds = ids.map(id => {
            if (!ObjectId.isValid(id)) {
                console.warn(`Invalid ObjectId in bulk action: ${id}`);
                return null;
            }
            return new ObjectId(id);
        }).filter(id => id !== null);

        if (objectIds.length === 0) {
            return res.status(400).json({ message: 'No valid IDs found in the request for bulk action.' });
        }

        const userReportsCollection = db.collection('userReports');
        let result;

        if (action === 'restore') {
            result = await userReportsCollection.updateMany(
                { _id: { $in: objectIds }, deletedAt: { $exists: true } },
                { $unset: { deletedAt: "", deletedBy: "" } }
            );
            res.status(200).json({
                message: `${result.modifiedCount} reports restored successfully.`,
                restoredCount: result.modifiedCount
            });
        } else if (action === 'permanent_delete') {
            result = await userReportsCollection.deleteMany(
                { _id: { $in: objectIds }, deletedAt: { $exists: true } }
            );
            res.status(200).json({
                message: `${result.deletedCount} reports permanently deleted.`,
                deletedCount: result.deletedCount
            });
        }
    } catch (error) {
        console.error('Error performing bulk action on trashed reports:', error);
        res.status(500).json({ message: 'Server error while performing bulk action.', error: error.message });
    }
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
            // console.log(`User with UID ${uid} already has a profile in MongoDB.`); // Removed debug log
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

        // FIX: Fetch the user from the database
        const user = await usersCollection.findOne({ uid: uid });

        // FIX: Check user status and return appropriate message/status
        if (user) {
            if (user.status === 'pending') {
                return res.status(403).json({ message: 'Your account is currently pending admin approval. Please wait for an administrator to approve it.' });
            } else if (user.status === 'rejected') {
                return res.status(403).json({ message: 'Your account has been rejected by an administrator. Please contact support if you believe this is an error.' });
            }
            // If status is 'approved' or any other valid status, return the user
            res.status(200).json(user);
        } else {
            res.status(404).json({ message: 'User profile not found in database.' });
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
        await admin.auth().setCustomUserClaims(uid, { role: role });
        // console.log(`Updated Firebase custom claims for user ${uid}: role = ${role}`); // Removed debug log

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
            // console.log(`Successfully deleted user ${uidToDelete} from Firebase Authentication.`); // Removed debug log
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

        if (result.deletedCount === 0 && !targetUser) {
            return res.status(404).json({ message: 'User profile not found in database and not deleted from Firebase Auth (if it existed).' });
        }

        res.status(200).json({ message: `User ${uidToDelete} and their profile successfully deleted.` });

    } catch (error) {
        console.error('Error deleting user:', error);
        res.status(500).json({ message: 'Server error during user deletion.', error: error.message });
    }
});


// --- Server Startup (Conditional for Local vs. Vercel) ---
module.exports = app;

if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 5000;
    connectMongoDB().then(() => {
        app.listen(PORT, () => {
            // console.log(`Admin Management Server is running locally on port: ${PORT}`); // Removed debug log
        });
    }).catch(error => {
        console.error("Failed to start local server due to database connection error:", error);
        process.exit(1);
    });
} else {
    // console.log("Running in production environment (e.g., Vercel). Serverless function will handle startup."); // Removed debug log
}


// --- Graceful Shutdown (Less critical for serverless, but good for local) ---
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
    if (process.env.NODE_ENV !== 'production') {
        process.exit(1);
    }
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    if (process.env.NODE_ENV !== 'production') {
        process.exit(1);
    }
});
