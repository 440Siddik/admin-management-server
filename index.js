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
        // NEW: Indexes for status and role in users collection for filtering
        await usersCollection.createIndex({ status: 1 });
        console.log("Ensured index on 'users' collection for 'status'.");
        await usersCollection.createIndex({ role: 1 });
        console.log("Ensured index on 'users' collection for 'role'.");


        // MODIFIED: Add collation indexes for userReports collection search fields
        const userReportsCollection = db.collection('userReports');

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

        // New index for soft delete feature
        await userReportsCollection.createIndex({ deletedAt: 1 });
        console.log("Ensured index on 'userReports' collection for 'deletedAt'.");
        // NEW: Index for deletedBy field
        await userReportsCollection.createIndex({ deletedBy: 1 });
        console.log("Ensured index on 'userReports' collection for 'deletedBy'.");


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
// MODIFIED: Added dynamic query parameter handling for status and role
async function fetchPaginatedData(collectionName, baseQuery = {}, req, res, includeDeleted = false) {
    // db is guaranteed to be connected by ensureDbConnected middleware
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 25;
        const skip = (page - 1) * limit;
        const searchTerm = req.query.search;
        const statusFilter = req.query.status; // Get status from query
        const roleFilter = req.query.role;     // Get role from query

        const collection = db.collection(collectionName);
        let queryConditions = { ...baseQuery }; // Start with any base query conditions

        // IMPORTANT: Exclude soft-deleted reports by default for regular views
        if (collectionName === 'userReports') { // Only apply deletedAt filter to userReports
            if (!includeDeleted) {
                queryConditions.deletedAt = { $exists: false }; // Only include documents where deletedAt doesn't exist
            } else {
                queryConditions.deletedAt = { $exists: true }; // Only include documents where deletedAt exists (trashed items)
            }
        }

        // Apply status filter if present in query
        if (statusFilter) {
            queryConditions.status = statusFilter;
        }

        // Apply role filter if present in query (supports comma-separated roles)
        if (roleFilter) {
            const roles = roleFilter.split(',').map(r => r.trim());
            if (roles.length > 1) {
                queryConditions.role = { $in: roles };
            } else {
                queryConditions.role = roles[0];
            }
        }


        if (searchTerm) {
            const searchRegex = new RegExp(searchTerm, 'i'); // Case-insensitive regex for search term

            // Define search fields based on collection type
            let searchFields = [];
            if (collectionName === 'userReports') {
                searchFields = ['name', 'facebookLink', 'phone'];
            } else if (collectionName === 'users') {
                searchFields = ['email', 'fbName']; // Assuming users have email and fbName
            }

            if (searchFields.length > 0) {
                const searchPart = {
                    $or: searchFields.map(field => ({ [field]: { $regex: searchRegex } }))
                };
                // Combine existing queryConditions with searchPart
                queryConditions = { $and: [queryConditions, searchPart] };
            }
        }

        // Apply reporterName exclusion ONLY for userReports collection
        if (collectionName === 'userReports' && searchTerm) { // Only apply this exclusion if there's a searchTerm for userReports
            const exclusionPart = {
                $expr: {
                    $ne: ["$name", "$reporterName"] // $ne compares the values of the two fields
                }
            };
            // Combine with existing queryConditions (which might already include searchPart)
            queryConditions = { $and: [queryConditions, exclusionPart] };
        }


        const totalCount = await collection.countDocuments(queryConditions);

        const data = await collection.find(queryConditions)
            .sort({ timestamp: -1 }) // Sort by timestamp descending (newest first)
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
// This middleware remains for admin-only routes
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

        // NEW: Role check - only 'user' role can soft delete
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

        // IMPORTANT: Check if the requesting user is the reporter of this report
        if (report.reporterId !== requestingUserUid) {
            return res.status(403).json({ message: 'Access denied: You can only move your own reports to trash.' });
        }

        // --- THIS IS THE CRITICAL FIX: Ensure this uses updateOne, not deleteOne ---
        const result = await userReportsCollection.updateOne(
            { _id: new ObjectId(id) }, // Query by ID
            {
                $set: {
                    deletedAt: new Date(), // Set the deletion timestamp
                    deletedBy: requestingUserUid // Store the UID of the user who trashed it
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
        const requestingUserRole = req.userProfile.role; // Role from verifyAdminToken middleware

        // Role check - only 'admin' or 'superadmin' role can permanently delete
        if (requestingUserRole !== 'admin' && requestingUserRole !== 'superadmin') {
            return res.status(403).json({ message: 'Access denied: Only administrators can permanently delete reports.' });
        }

        if (!ObjectId.isValid(id)) {
            return res.status(400).json({ message: 'Invalid ID format.' });
        }

        const userReportsCollection = db.collection('userReports');
        
        // Find the report to ensure it exists before attempting deletion
        const report = await userReportsCollection.findOne({ _id: new ObjectId(id) });
        if (!report) {
            return res.status(404).json({ message: 'Report not found.' });
        }

        const result = await userReportsCollection.deleteOne({ _id: new ObjectId(id) });

        if (result.deletedCount === 1) {
            res.status(200).json({ message: 'Report permanently deleted successfully.' });
        } else {
            // This case should ideally not be reached if findOne found the report
            res.status(404).json({ message: 'Report not found or already deleted.' });
        }

    } catch (error) {
        console.error('Error permanently deleting user report by admin:', error);
        res.status(500).json({ message: 'Server error while permanently deleting user report.', error: error.message });
    }
});


// MODIFIED: Get active user reports (excluding soft-deleted ones)
app.get('/api/userReports', ensureDbConnected, async (req, res) => {
    await fetchPaginatedData('userReports', { deletedAt: { $exists: false } }, req, res, false); // Explicitly exclude deleted
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
    // Fetch only reports that have been soft-deleted
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
        const query = { _id: new ObjectId(id), deletedAt: { $exists: true } }; // Ensure it's in trash

        const result = await userReportsCollection.updateOne(
            query,
            {
                $unset: { deletedAt: "", deletedBy: "" } // Remove deletedAt and deletedBy fields
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
        const query = { _id: new ObjectId(id), deletedAt: { $exists: true } }; // Ensure it's in trash

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

        const { ids, action } = req.body; // action can be 'restore' or 'permanent_delete'

        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ message: 'Invalid or empty array of IDs provided.' });
        }

        if (!['restore', 'permanent_delete'].includes(action)) {
            return res.status(400).json({ message: 'Invalid action specified. Must be "restore" or "permanent_delete".' });
        }

        const objectIds = ids.map(id => {
            if (!ObjectId.isValid(id)) {
                // Return null for invalid IDs to filter them out later
                console.warn(`Invalid ObjectId in bulk action: ${id}`);
                return null;
            }
            return new ObjectId(id);
        }).filter(id => id !== null); // Filter out any nulls from invalid IDs

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
// MODIFIED: This route now dynamically filters by status and role from query parameters
app.get('/api/users', ensureDbConnected, verifyAdminToken, async (req, res) => {
    // fetchPaginatedData will now pick up status and role from req.query
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
