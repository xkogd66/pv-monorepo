const debug = require('debug');
const debugSSE = debug('pv:server:sse');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const progressStore = new Map();

const PERSIST_DIR = path.join(__dirname, '..', 'data', 'bulk_progress');

async function ensurePersistDir() {
  try {
    await fsp.mkdir(PERSIST_DIR, { recursive: true });
  } catch (e) {
    debugSSE(`[sse-service] Failed to ensure persist dir: ${e.message}`);
  }
}

async function writePersistedFile(jobId, payload) {
  try {
    await ensurePersistDir();
    const filePath = path.join(PERSIST_DIR, `${jobId}.json`);
    await fsp.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
  } catch (e) {
    debugSSE(`[sse-service] Failed to write persisted file for ${jobId}: ${e.message}`);
  }
}

function persistProgress(jobId, data = {}) {
  if (!jobId) return;
  // Persist in-memory for fast reads
  if (data && data.progress) {
    try {
      progressStore.set(jobId, data.progress);
    } catch (e) {
      debugSSE(`[sse-service] Failed to persist progress in-memory for ${jobId}: ${e.message}`);
    }
  }

  // Persist to disk asynchronously (includes progress or full result)
  (async () => {
    try {
      const filePayload = {};
      if (data.progress) filePayload.progress = data.progress;
      if (data.result) filePayload.result = data.result;
      // If nothing meaningful, skip
      if (Object.keys(filePayload).length === 0) return;
      await writePersistedFile(jobId, filePayload);
      debugSSE(`[sse-service] Persisted progress/result for ${jobId} to disk`);
    } catch (e) {
      debugSSE(`[sse-service] Error persisting progress to disk for ${jobId}: ${e.message}`);
    }
  })();
}

function getProgress(jobId) {
  try {
    if (progressStore.has(jobId)) return progressStore.get(jobId);

    // Fallback - try reading persisted file
    const filePath = path.join(PERSIST_DIR, `${jobId}.json`);
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      try {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.progress) return parsed.progress;
      } catch (e) {
        debugSSE(`[sse-service] Failed to parse persisted file for ${jobId}: ${e.message}`);
      }
    }

    return null;
  } catch (e) {
    debugSSE(`[sse-service] Failed to get progress for ${jobId}: ${e.message}`);
    return null;
  }
}

module.exports = {
  persistProgress,
  getProgress,
};
