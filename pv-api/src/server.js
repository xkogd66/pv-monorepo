require("dotenv").config();
const config = require("./config"); // defaults to ./config/index.js

// Debug namespaces
const debug = require("debug");
const debugServer = debug("pv:server");
const debugDB = debug("pv:server:database");

// temporal integration
const { Connection, Client: TemporalClient } = require("@temporalio/client");

const express = require("express");
const cors = require("cors");
const app = express();
const PORT = config.server.port;

// Middleware - Log all incoming requests BEFORE CORS
app.use((req, res, next) => {
  /*
  debugServer('🔍 Incoming request from origin:', req.headers.origin);
  debugServer('🔍 Request method:', req.method);
  debugServer('🔍 Request path:', req.path);
  */
  next();
});

// Middleware
app.use(cors(config.cors));

// Log successful CORS checks
app.use((req, res, next) => {
  // console.log('✅ Request passed CORS check');
  next();
});

// Keep JSON/urlencoded limits small - large file uploads use multipart/multer (disk streaming)
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

// Import and Initialize services and dependencies

// Temporal Client Configuration
let temporalClient;

async function initTemporal() {
  try {
    const connection = await Connection.connect({
      address: config.temporal.address,
    });
    temporalClient = new TemporalClient({
      connection,
      namespace: config.temporal.namespace,
    });
    debugServer("✓ Temporal Client initialized");
  } catch (err) {
    debugServer(`Temporal initialization error: ${err.message}`);
    temporalClient = null;
  }
}

// Getter passed to routes so they always read the current client reference,
// even after a reconnect.
const getTemporalClient = () => temporalClient;

// Reconnect loop — if Temporal was down at startup or drops later,
// retry every 30 s so the routes recover without a pod restart.
async function startTemporalReconnectLoop() {
  setInterval(async () => {
    if (temporalClient) return; // already connected
    debugServer("Temporal reconnect attempt...");
    await initTemporal();
    if (temporalClient) {
      debugServer("✓ Temporal Client reconnected");
    }
  }, 30000);
}

// Minio Client Configuration

const { Client: MinioClient } = require("minio");
// MinIO Client Configuration
let minioClient;
try {
  minioClient = new MinioClient({
    endPoint: config.minio.endpoint,
    port: parseInt(config.minio.port),
    useSSL: config.minio.useSSL,
    accessKey: config.minio.accessKey,
    secretKey: config.minio.secretKey,
  });
} catch (err) {
  debugServer(
    `[server.js LINE 39]: MinIO client initialization error: ${err.message}`,
  );
  minioClient = null;
}

// Separate client whose endpoint is the public hostname so that presigned URLs
// are signed with the correct host (AWS SigV4 includes Host in the HMAC).
let publicMinioClient = null;
if (config.minio.publicUrl) {
  try {
    const pub = new URL(config.minio.publicUrl);
    const isHttps = pub.protocol === "https:";
    const port = pub.port ? parseInt(pub.port) : (isHttps ? 443 : 80);
    publicMinioClient = new MinioClient({
      endPoint: pub.hostname,
      port,
      useSSL: isHttps,
      accessKey: config.minio.accessKey,
      secretKey: config.minio.secretKey,
    });
    debugServer(`✓ Public MinIO signing client → ${config.minio.publicUrl}`);
  } catch (err) {
    debugServer(`Public MinIO client init error: ${err.message}`);
  }
}
// Import authentication components
const database = require("./services/database-service");
const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/user");
const healthRoutes = require("./routes/health");
const albumRoutes = require("./routes/albums");
const statRoutes = require("./routes/stats");
const temporalRoutes = require("./routes/temporalUploads"); // Added this for the new Temporal route
const videoUploadRoutes = require("./routes/videoUpload");

// Bulk-upload progress store (written by the worker via POST /bulk/progress)
const { persistProgress, getProgress } = require("./services/sse-service");

// Start server with database initialization
async function startServer() {
  try {
    // Initialize database connection
    await initializeDatabase();
    await initTemporal();
    startTemporalReconnectLoop();

    // Warm the Temporal gRPC channel to avoid cold-start timeouts in health checks
    try {
      if (
        healthRoutes &&
        typeof healthRoutes.warmTemporalChannel === "function"
      ) {
        healthRoutes.warmTemporalChannel(temporalClient);
      }
    } catch (err) {
      debugServer("warmTemporalChannel invocation failed:", err.message);
    }

    app.use("/auth", authRoutes);
    app.use("/user", userRoutes);
    app.use("/", albumRoutes(minioClient, { publicMinioClient }));
    app.use("/", statRoutes(minioClient));

    const deps = await healthRoutes.checkAllDependencies(minioClient, temporalClient);
    debugServer("Dependency status at startup: ", deps);
    require("./services/dependency-status").set(deps);

    app.use("/bulk", temporalRoutes(getTemporalClient, config, { persistProgress, getProgress }));
    app.use("/video", videoUploadRoutes(minioClient, { getTemporalClient }));
    app.use("/", healthRoutes(minioClient, temporalClient));

    //debugServer(`[server.js] Database initialized successfully`);
    // Start HTTP server
    app.listen(PORT, () => {
      debugServer(`Starting pv ${new Date()}...`);
      debugServer(`> pv API server running on port ${config.server.port}`);
    });
  } catch (error) {
    //debugServer(`[server.js] Failed to start server:`, error.message);
    process.exit(1);
  }
}

// Graceful shutdown
process.on("SIGINT", async () => {
  //debugServer(`[server.js] Shutting down server...`);
  await database.close();
  process.exit(0);
});

async function initializeDatabase() {
  try {
    await database.initialize();
  } catch (error) {
    debugDB(`[(262)] Database initialization failed:`, error.message);
  }
}

// Start the server
startServer();
