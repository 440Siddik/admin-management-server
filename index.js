const express = require("express");
const app = express();
const cors = require("cors");
require("dotenv").config(); // Load environment variables from .env file

const port = process.env.PORT || 5000;

// --- Middleware ---
app.use(cors({
  origin:'http://localhost:5173/'
})); 

app.use(express.json()); // Parse JSON request bodies

// --- MongoDB Connection Setup ---
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb"); // Import ObjectId

// Ensure DB_USER and DB_PASS are set in your .env file
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.bcrsmwq.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Declare client and db variables globally so they can be accessed by routes and shutdown logic
let client;
let db; // This will hold our connected database instance

async function connectMongoDB() {
  try {
    // Create a MongoClient with a MongoClientOptions object to set the Stable API version
    client = new MongoClient(uri, {
      serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
      },
    });

    // Connect the client to the server
    // await client.connect();

    // Assign the database instance to the global 'db' variable
    db = client.db("admin_management_db"); // Using a specific database name

    // Send a ping to confirm a successful connection
    // await db.command({ ping: 1 });
    // console.log("Pinged your deployment. You successfully connected to MongoDB!");

  } catch (error) {
    console.error("Failed to connect to MongoDB Atlas:", error);
    // Exit the process if the database connection fails at startup
    process.exit(1);
  }
}

// Function to close the MongoDB connection gracefully
async function closeMongoDB() {
  if (client) {
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
  if (!db) {
    return res.status(500).json({ message: 'Database not connected.' });
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
          { reason: { $regex: searchRegex } }, // Added reason to search
          // You might also want to search by reporterName
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

// Handle submission of user reports from Home.js
app.post('/api/userReports', async (req, res) => {
  if (!db) { // Check if database is connected
    return res.status(500).json({ message: 'Database not connected.' });
  }

  try {
    const userReportsCollection = db.collection('userReports'); // Collection to store reports

    // --- NEW: Destructure reporterId and reporterName from req.body ---
    const { name, facebookLink, phone, status, reason, reporterId, reporterName } = req.body;

    // Basic validation: Check if required fields exist, including new ones
    if (!name || !facebookLink || !phone || !status || !reason || !reporterId || !reporterName) {
        return res.status(400).json({ message: 'All required fields (name, facebookLink, phone, status, reason, reporterId, reporterName) are required.' });
    }

    // Phone number validation: Allow digits, optional leading plus, spaces, hyphens, parentheses
    const phoneRegex = /^[+]?[0-9\s()-]*$/;
    if (!phoneRegex.test(phone)) {
        return res.status(400).json({ message: 'Invalid phone number format. Please use only digits, +, -, (, ) or spaces.' });
    }

    // Optional: Validate facebookLink format (basic URL check)
    const urlRegex = /^(https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|https?:\/\/[a-zA-Z0-9]+\.[^\s]{2,}|[a-zA-Z0-9]+\.[^\s]{2,})$/i;
    if (!urlRegex.test(facebookLink)) {
        return res.status(400).json({ message: 'Invalid Facebook link format. Must be a valid URL.' });
    }

    // Optional: Validate status against allowed values
    const allowedStatuses = ['suspended', 'banned'];
    if (!allowedStatuses.includes(status)) {
        return res.status(400).json({ message: 'Invalid status provided.' });
    }
    // --- END SERVER-SIDE VALIDATION ---


    // Data to save (using validated fields and including new reporter data)
    const dataToSave = {
      name,
      facebookLink,
      phone,
      status,
      reason,
      reporterId,   // Include reporterId
      reporterName, // Include reporterName
      timestamp: new Date(), // Use new Date() for MongoDB BSON Date type
    };

    const result = await userReportsCollection.insertOne(dataToSave);

    // Send a success response back to the frontend
    res.status(201).json({
      message: 'User report submitted successfully!',
      insertedId: result.insertedId,
      data: dataToSave // Echo back the saved data (optional)
    });

  } catch (error) {
    console.error('Error saving user report to MongoDB:', error);
    // Send an error response back to the frontend
    res.status(500).json({
      message: 'Failed to submit user report. Please try again later.',
      error: error.message
    });
  }
});

// --- DELETE Route for User Reports (Logs Removed) ---
app.delete('/api/userReports/:id', async (req, res) => {
    if (!db) {
        return res.status(500).json({ message: 'Database not connected.' });
    }

    const id = req.params.id;

    if (!ObjectId.isValid(id)) {
        return res.status(400).json({ message: 'Invalid ID format.' });
    }

    try {
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
// --- END DELETE Route ---


// Route: Get all user reports (no filter, now paginated and searchable)
app.get('/api/userReports', async (req, res) => {
  await fetchPaginatedData('userReports', {}, req, res);
});

// Route: Get only suspended users (now paginated and searchable)
app.get('/api/suspendedUsers', async (req, res) => {
  await fetchPaginatedData('userReports', { status: 'suspended' }, req, res);
});

// Route: Get only banned users (now paginated and searchable)
app.get('/api/bannedUsers', async (req, res) => {
  await fetchPaginatedData('userReports', { status: 'banned' }, req, res);
});

// Route: Get all user reports (suspended, banned, and others - this is redundant with /api/userReports now)
// This route is effectively the same as /api/userReports, consider removing one if redundant
app.get('/api/allUserReports', async (req, res) => {
  await fetchPaginatedData('userReports', {}, req, res);
});


// --- Server Startup ---

// Connect to MongoDB first, then start the Express server
connectMongoDB()
  .then(() => {
    app.listen(port, () => {
      console.log(`Admin Management Server is running on port: ${port}`);
    });
  })
  .catch(error => {
    console.error("Failed to start server due to database connection error:", error);
    process.exit(1);
  });

// --- Graceful Shutdown ---
process.on('SIGINT', async () => {
  console.log('SIGINT signal received: Closing MongoDB connection.');
  await closeMongoDB();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('SIGTERM signal received: Closing MongoDB connection.');
  await closeMongoDB();
  process.exit(0);
});

// Catch unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Catch uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});
