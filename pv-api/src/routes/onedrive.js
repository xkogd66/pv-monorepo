const express = require("express");
const router = express.Router();
const { execFile } = require("child_process");
const { promisify } = require("util");
const { randomUUID } = require("crypto");
const path = require("path");
const mime = require("mime-types");
const debug = require("debug");
const { authenticateToken, requireRole } = require("../middleware/authMW");

const debugOneDrive = debug("pv:onedrive");
const run = promisify(execFile);

// rclone remote (from the rclone.conf pointed at by RCLONE_CONFIG) and the
// OneDrive folder that holds the year/album tree.
const ROOT = "onedrive:photo-albums";
// Same list AlbumViewer.vue / stats.js use to recognise videos.
const VIDEO_EXT = /\.(mp4|mov|avi|mkv|webm|m4v|3gp|flv|wmv)$/i;
// pv-converter only accepts these; other images are left on OneDrive.
const IMAGE_TYPES = new Set(["image/jpeg", "image/heic"]);

const lsjson = async (relPath, flag) => {
  const { stdout } = await run("rclone", ["lsjson", flag, `${ROOT}/${relPath}`], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout);
};

// ponytail: listings cached per path for 24h; new OneDrive albums show up after the
// TTL (or a pod restart). Lower the TTL if albums start being added more often.
const FOLDER_TTL_MS = 24 * 60 * 60 * 1000;
const folderCache = new Map(); // relPath -> { folders, at }

// Names already stored directly under <album>/ in MinIO (not thumbs/ or the JSON).
const listStored = async (minioClient, bucket, album) => {
  const names = new Set();
  const stream = minioClient.listObjectsV2(bucket, `${album}/`, false);
  for await (const obj of stream) if (obj.name) names.add(obj.name.slice(album.length + 1));
  return names;
};

module.exports = (getTemporalClient, config, minioClient) => {
  // GET /onedrive/folders?path=2023 — subfolders of photo-albums/<path>
  router.get("/folders", authenticateToken, requireRole("admin"), async (req, res) => {
    const relPath = req.query.path || "";
    try {
      let hit = folderCache.get(relPath);
      if (!hit || Date.now() - hit.at > FOLDER_TTL_MS) {
        const entries = await lsjson(relPath, "--dirs-only");
        hit = { folders: entries.map((e) => e.Name).sort(), at: Date.now() };
        folderCache.set(relPath, hit);
      }
      res.json({ folders: hit.folders });
    } catch (err) {
      debugOneDrive(`list folders failed: ${err.stderr || err.message}`);
      res.status(502).json({ error: "OneDrive listing failed", message: err.stderr || err.message });
    }
  });

  // POST /onedrive/import { path, albumName } — the album must already exist
  // (SPA creates it via POST /album/:name first). Files are downloaded by the
  // worker inside processBatchImages, so progress/monitoring is the bulk path's.
  router.post("/import", authenticateToken, requireRole("admin"), async (req, res) => {
    const { path: relPath, albumName, resume } = req.body || {};
    if (!relPath || !albumName) {
      return res.status(400).json({ error: "path and albumName are required" });
    }
    const temporalClient = getTemporalClient();
    if (!temporalClient) {
      return res.status(503).json({ error: "Temporal client not available" });
    }

    try {
      const batchId = randomUUID();
      const batchDir = path.join(config.temporal.nfsPath, batchId);
      // resume: skip files whose result is already in the album (<name>.avif for images,
      // <name> for videos), so an interrupted import carries on instead of redoing everything.
      const stored = resume ? await listStored(minioClient, config.minio.bucketName, albumName) : new Set();
      const candidates = (await lsjson(relPath, "--files-only"))
        .map((f) => ({ name: f.Name, type: mime.lookup(f.Name) }))
        .filter((f) => IMAGE_TYPES.has(f.type) || VIDEO_EXT.test(f.name));
      const images = candidates
        .filter((f) => !stored.has(VIDEO_EXT.test(f.name) ? f.name : f.name.replace(/\.[^.]+$/, ".avif")))
        .map((f) => ({
          filename: f.name,
          path: path.join(batchDir, f.name),
          contentType: f.type,
          remote: `${ROOT}/${relPath}/${f.name}`,
        }));

      if (images.length === 0 && resume && candidates.length > 0) {
        return res.json({ success: true, imageCount: 0, skipped: candidates.length, folder: albumName });
      }
      if (images.length === 0) {
        return res.status(400).json({ error: "No JPEG, HEIC or video files in that folder" });
      }

      await temporalClient.workflow.start("processBatchImages", {
        taskQueue: config.temporal.taskQueue,
        workflowId: `batch-${batchId}`,
        args: [{ batchId, batchDir, images, folder: albumName, albumName }],
      });

      debugOneDrive(`import ${relPath} → ${albumName}: ${images.length} files, batch ${batchId}`);
      res.status(202).json({ success: true, batchId, imageCount: images.length, skipped: candidates.length - images.length, folder: albumName });
    } catch (err) {
      debugOneDrive(`import failed: ${err.stderr || err.message}`);
      res.status(502).json({ error: "OneDrive import failed", message: err.stderr || err.message });
    }
  });

  return router;
};
