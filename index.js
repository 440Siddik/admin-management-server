const express = require("express");
const app = express();
const cors = require("cors");
require("dotenv").config(); // Load environment variables from .env file (for local development)

const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb"); // Import ObjectId

// Declare client and db variables globally so they can be accessed by routes and shutdown logic
let client;
let db; // This will hold our connected database instance

// --- Middleware ---
// CORS Configuration: IMPORTANT - Remove the trailing slash from localhost:5173.
// Ensure your deployed frontend URL also does NOT have a trailing slash here.
app.use(cors({
  // The origins array should contain the exact URLs that your frontend will be running on.
  // 'http://localhost:5173' for your local development.
  // 'https://admin-management-frontend.vercel.app' for your deployed Vercel frontend.
  origin: ['http://localhost:5173', 'https://admin-management-frontend.vercel.app'] 
  // If you are still unsure about the frontend Vercel URL, or for broader testing, you can use:
  // origin: '*' // Temporarily allow all origins for testing. REMEMBER TO CHANGE THIS LATER FOR SECURITY!
}));

app.use(express.json()); // Parse JSON request bodies

// --- MongoDB Connection Setup ---
// Ensure DB_USER and DB_PASS are set in your .env file (for local) or Vercel Environment Variables (for deploy)
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.bcrsmwq.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Function to connect to MongoDB
async function connectMongoDB() {
  // Check if DB_USER or DB_PASS are missing before attempting connection
  if (!process.env.DB_USER || !process.env.DB_PASS) {
    console.error("MongoDB credentials (DB_USER or DB_PASS) are missing from environment variables.");
    throw new Error("Missing MongoDB credentials.");
  }

  // Only connect if client is not already initialized or connected
  if (!client || !client.topology || !client.topology.isConnected()) {
    try {
      client = new MongoClient(uri, {
        serverApi: {
          version: ServerApiVersion.v1,
          strict: true,
          deprecationErrors: true,
        },
      });

      await client.connect();
      
      db = client.db("admin_management_db"); // Using your specific database name

      await db.command({ ping: 1 });
      console.log("Pinged your deployment. You successfully connected to MongoDB!");

    } catch (error) {
      console.error("Failed to connect to MongoDB Atlas:", error);
      throw error; 
    }
  } else {
    console.log("MongoDB client already connected.");
  }
}

// Function to close the MongoDB connection gracefully (less relevant for serverless, but good practice)
async function closeMongoDB() {
  if (client && client.topology && client.topology.isConnected()) {
    try {
      await client.close();
      console.log("MongoDB Atlas connection closed.");
    } catch (error) {
      console.error("Error closing MongoDB connection:", error);
    }
  }
}

// --- Helper function for paginated queries with optional search ---
async function fetchPaginatedData(collectionName, baseQuery = {}, req, res) {
  try {
    await connectMongoDB(); // Ensure connection is active for each request
  } catch (error) {
    return res.status(500).json({ message: 'Failed to connect to database.', error: error.message });
  }

  try {
    const page = parseInt(req.query.page) || 1; // Default to page 1
    const limit = parseInt(req.query.limit) || 25; // Default to 25 items per page
    const skip = (page - 1) * limit;
    const searchTerm = req.query.search; // Get the search term from query parameters

    const collection = db.collection(collectionName);
    let finalQuery = { ...baseQuery }; // Start with the base query (e.g., { status: 'suspended' })

    // If a search term is provided, add $or conditions for searching across fields
    if (searchTerm) {
      const searchRegex = new RegExp(searchTerm, 'i'); // 'i' for case-insensitive search
      finalQuery = {
        ...finalQuery, // Keep existing filters (like status)
        $or: [
          { name: { $regex: searchRegex } },
          { facebookLink: { $regex: searchRegex } },
          { phone: { $regex: searchRegex } },
          { reason: { $regex: searchRegex } },
          { reporterName: { $regex: searchRegex } } // Added reporterName to search
        ]
      };
    }

    const totalCount = await collection.countDocuments(finalQuery);

    const data = await collection.find(finalQuery)
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


// --- Routes ---

app.get("/", (req, res) => {
  res.send("Admin Management Server is running successfully!");
});

app.post('/api/userReports', async (req, res) => {
  try {
    await connectMongoDB(); // Ensure connection is active for this request
    const userReportsCollection = db.collection('userReports'); // Collection to store reports

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

app.delete('/api/userReports/:id', async (req, res) => {
  try {
    await connectMongoDB(); // Ensure connection is active for this request
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


app.get('/api/userReports', async (req, res) => {
  await fetchPaginatedData('userReports', {}, req, res);
});

app.get('/api/suspendedUsers', async (req, res) => {
  await fetchPaginatedData('userReports', { status: 'suspended' }, req, res);
});

app.get('/api/bannedUsers', async (req, res) => {
  await fetchPaginatedData('userReports', { status: 'banned' }, req, res);
});

app.get('/api/allUserReports', async (req, res) => {
  await fetchPaginatedData('userReports', {}, req, res);
});


// --- Server Startup (Conditional for Local vs. Vercel) ---
module.exports = app;

if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 5000;
  connectMongoDB().then(() => {
    app.listen(PORT, () => {
      console.log(`Admin Management Server is running locally on port: ${PORT}`);
    });
  }).catch(error => {
    console.error("Failed to start local server due to database connection error:", error);
    process.exit(1);
  });
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
