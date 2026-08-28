"use strict";

const express = require("express");
const debug = require("debug");
const debugHealth = debug("pv:health");
const config = require("../config");
const database = require("../services/database-service");

/**
 * Health check route logic.
 * Decoupled to allow the pod to stay alive (200 OK) even if non-critical
 * services like Temporal or MinIO are still warming up or misconfigured.
 */

/**
 * Warm the Temporal gRPC channel once at startup so health-check calls never
 * pay the connection-setup cost. Safe to call multiple times.
 * @param {import('@temporalio/client').Client} temporalClient
 */
async function warmTemporalChannel(temporalClient) {
  if (!temporalClient) return;
  try {
    await temporalClient.workflowService.describeNamespace({
      namespace: config.temporal?.namespace || "default",
    });
    debugHealth("Temporal warm-up via describeNamespace succeeded");
  } catch (err) {
    debugHealth("Temporal channel warm-up failed (non-fatal):", err.message);
  }
}

// ---------------------------------------------------------------------------
// Individual service checks — also reused by the startup dependency check
// ---------------------------------------------------------------------------

/**
 * Reject after `ms` if `promise` hasn't settled. Needed for the MinIO SDK and
 * the Temporal gRPC client, neither of which accepts an AbortSignal — without
 * it a hung dependency hangs the readiness probe indefinitely.
 */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Returns true if MinIO is reachable and the configured bucket is listable.
 * @param {import('minio').Client} minioClient
 */
async function checkMinioHealth(minioClient) {
  if (!minioClient) return false;
  try {
    await withTimeout(minioClient.bucketExists(config.minio.bucketName), 3000, "MinIO");
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns true if the Temporal namespace is reachable.
 * 4 s is long enough for a cold-but-healthy gRPC channel and stays well
 * within the k8s readinessProbe timeoutSeconds: 5.
 * @param {import('@temporalio/client').Client} temporalClient
 */
async function checkTemporalHealth(temporalClient) {
  if (!temporalClient) return false;
  try {
    await withTimeout(
      temporalClient.workflowService.describeNamespace({
        namespace: config.temporal?.namespace || "default",
      }),
      4000,
      "Temporal gRPC",
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns true if the converter responds with a 2xx on /health.
 * Allow up to 30 s: a converter pod may be mid-conversion and legitimately
 * slow to respond without being unhealthy.
 */
async function checkConverterHealth() {
  if (!config.converter?.url) return false;
  const timeout = Math.min(parseInt(config.converter.timeout, 10) || 30000, 30000);
  try {
    const response = await fetch(`${config.converter.url}/health`, {
      signal: AbortSignal.timeout(timeout),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Runs all four checks concurrently. Never throws. */
async function checkAllDependencies(minioClient, temporalClient) {
  const [minio, db, temporal, converter] = await Promise.all([
    checkMinioHealth(minioClient),
    database.isHealthy().then(Boolean).catch(() => false),
    checkTemporalHealth(temporalClient),
    checkConverterHealth(),
  ]);
  return { minio, database: db, temporal, converter };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

const dependencyStatus = require("../services/dependency-status");

const healthCheck = (minioClient, temporalClient) => async (req, res) => {
  const results = await checkAllDependencies(minioClient, temporalClient);

  // Log individual failures for easier debugging
  for (const [name, ok] of Object.entries(results)) {
    if (!ok) debugHealth(`❌ ${name} check failed`);
  }

  // "Ready" only when every dependency is healthy
  const isReady =
    results.minio && results.converter && results.database && results.temporal;

  // "Alive" as long as the database is up — Temporal/MinIO/converter issues
  // should NOT trigger a pod restart; they can be fixed without restarting.
  const isAlive = results.database;

  res.status(isAlive ? 200 : 503).json({
    status: isReady ? "healthy" : "degraded",
    timestamp: new Date().toISOString(),
    ready: isReady,
    startupDependencies: dependencyStatus.get() || null,
    services: {
      minio: { connected: results.minio },
      database: { connected: results.database },
      temporal: { connected: results.temporal },
      converter: { connected: results.converter },
    },
    checks: {
      liveness: isAlive,
      readiness: isReady,
    },
  });
};

module.exports = (minioClient, temporalClient) => {
  const router = express.Router();
  router.get("/health", healthCheck(minioClient, temporalClient));
  return router;
};

module.exports.warmTemporalChannel = warmTemporalChannel;
module.exports.checkAllDependencies = checkAllDependencies;
