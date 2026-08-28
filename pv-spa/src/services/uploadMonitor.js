import { reactive, readonly } from 'vue';
import apiService from './api.js';
import WorkflowStatusService from './workflowStatusService.js';
import userSettings from './userSettings.js';

const jobsState = reactive({});
const controllers = new Map();

const TERMINAL_STATUSES = new Set([
  'COMPLETED',
  'FAILED',
  'TIMED_OUT',
  'TERMINATED',
  'CANCELED',
  'CANCELLED',
]);

const clampPercentage = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(numeric)));
};

const nowIso = () => new Date().toISOString();

export const isTerminalUploadStatus = (status) => TERMINAL_STATUSES.has(status);

const monitoringEnabledFor = (job) => !!job && !!userSettings.get('monitorBulkUploads');

const DISABLED_MESSAGE =
  'Live monitoring is disabled for bulk uploads. Enable it in Settings to poll progress here.';
const DEFAULT_MESSAGE = 'Waiting for bulk processing updates...';

const upsertJob = (jobId, patch) => {
  const current = jobsState[jobId] || {};
  jobsState[jobId] = {
    ...current,
    ...patch,
    progress: patch.progress ? { ...(current.progress || {}), ...patch.progress } : (current.progress || patch.progress),
    updatedAt: nowIso(),
  };
  return jobsState[jobId];
};

const stopMonitoring = (jobKey) => {
  const active = controllers.get(jobKey);
  if (!active) {
    return;
  }

  active.workflowStatusService?.stop();

  if (active.progressIntervalId) {
    clearInterval(active.progressIntervalId);
  }

  controllers.delete(jobKey);
};

const markTerminal = (jobKey, status, patch = {}) => {
  const current = jobsState[jobKey];
  if (!current) {
    return;
  }

  stopMonitoring(jobKey);
  upsertJob(jobKey, {
    ...patch,
    status,
    completedAt: nowIso(),
  });
};

const fetchBulkProgress = async (jobKey) => {
  const job = jobsState[jobKey];
  if (!job?.batchId || isTerminalUploadStatus(job.status)) {
    return;
  }

  const response = await apiService.getBulkJobProgress(job.batchId);
  if (!response?.progress) {
    return;
  }

  const progress = response.progress;
  upsertJob(jobKey, {
    progress: {
      uploaded: progress.uploaded ?? 0,
      total: progress.total ?? 0,
      failed: progress.failed ?? 0,
      percentage: clampPercentage(progress.percentage ?? 0),
      current: progress.current ?? progress.uploaded ?? 0,
    },
    status: 'RUNNING',
    message: `Uploaded ${progress.uploaded ?? 0} of ${progress.total ?? 0} files`,
  });
};

const handleBulkStatusUpdate = (jobKey, payload) => {
  const job = jobsState[jobKey];
  if (!job) {
    return;
  }

  const status = payload?.status || 'RUNNING';

  switch (status) {
    case 'RUNNING':
      upsertJob(jobKey, {
        status,
        message: job.progress?.total
          ? `Uploaded ${job.progress.uploaded || 0} of ${job.progress.total} files`
          : 'Bulk upload is running...',
      });
      break;

    case 'COMPLETED': {
      const result = payload?.result || {};
      const successful = result.successful ?? job.progress?.uploaded ?? 0;
      const failed = result.failed ?? job.progress?.failed ?? 0;
      const total = result.totalImages ?? job.progress?.total ?? successful + failed;
      markTerminal(jobKey, 'COMPLETED', {
        message: failed > 0
          ? `Bulk upload complete: ${successful}/${total} successful, ${failed} failed`
          : `Bulk upload complete: ${successful}/${total} successful`,
        progress: {
          current: total,
          total,
          uploaded: successful,
          failed,
          percentage: 100,
        },
      });
      break;
    }

    case 'FAILED':
    case 'TIMED_OUT':
    case 'TERMINATED':
    case 'CANCELED':
    case 'CANCELLED':
      markTerminal(jobKey, status, {
        error: payload?.error?.message || 'Bulk processing failed.',
        message: payload?.error?.message || `Bulk processing ended with status ${status}.`,
      });
      break;

    default:
      upsertJob(jobKey, {
        status,
        message: payload?.message || `Bulk upload status: ${status}`,
      });
  }
};

const handleBulkStatusError = (jobKey, error) => {
  if (!jobsState[jobKey] || isTerminalUploadStatus(jobsState[jobKey].status)) {
    return;
  }

  upsertJob(jobKey, {
    error: error?.message || 'Bulk status polling failed.',
    message: error?.message || jobsState[jobKey].message || 'Bulk status polling failed.',
  });
};

const startBulkMonitoring = (jobKey) => {
  const job = jobsState[jobKey];
  if (!job?.workflowId) {
    return;
  }

  const active = controllers.get(jobKey) || {};

  if (!active.workflowStatusService) {
    active.workflowStatusService = new WorkflowStatusService(
      apiService,
      job.workflowId,
      (payload) => handleBulkStatusUpdate(jobKey, payload),
      (error) => handleBulkStatusError(jobKey, error)
    );
    active.workflowStatusService.start();
  }

  if (!active.progressIntervalId && job.batchId) {
    fetchBulkProgress(jobKey).catch(() => {});
    active.progressIntervalId = setInterval(() => {
      fetchBulkProgress(jobKey).catch(() => {});
    }, 5000);
  }

  controllers.set(jobKey, active);

  upsertJob(jobKey, {
    status: job.status === 'ACCEPTED' ? 'RUNNING' : job.status,
    message: job.message || DEFAULT_MESSAGE,
  });
};

const syncMonitoringForJob = (jobKey) => {
  const job = jobsState[jobKey];
  if (!job || isTerminalUploadStatus(job.status)) {
    stopMonitoring(jobKey);
    return;
  }

  if (!monitoringEnabledFor(job)) {
    stopMonitoring(jobKey);
    upsertJob(jobKey, {
      status: 'ACCEPTED',
      message: DISABLED_MESSAGE,
    });
    return;
  }

  startBulkMonitoring(jobKey);
};

const syncAllMonitoring = () => {
  Object.keys(jobsState).forEach((jobKey) => syncMonitoringForJob(jobKey));
};

const registerBulkUpload = ({ workflowId, batchId, albumName }) => {
  if (!workflowId) {
    return null;
  }

  const jobKey = `bulk:${workflowId}`;
  upsertJob(jobKey, {
    id: jobKey,
    kind: 'bulk',
    status: monitoringEnabledFor({ kind: 'bulk' }) ? 'RUNNING' : 'ACCEPTED',
    title: 'Bulk upload',
    albumName: albumName || '',
    jobId: null,
    workflowId,
    batchId: batchId || null,
    message: monitoringEnabledFor({ kind: 'bulk' }) ? DEFAULT_MESSAGE : DISABLED_MESSAGE,
    progress: {
      current: 0,
      total: 0,
      uploaded: 0,
      failed: 0,
      percentage: 0,
    },
    startedAt: jobsState[jobKey]?.startedAt || nowIso(),
    completedAt: null,
    error: null,
  });
  syncMonitoringForJob(jobKey);
  return jobKey;
};

const clearTrackedJob = (jobKey) => {
  stopMonitoring(jobKey);
  delete jobsState[jobKey];
};

if (typeof userSettings.onChange === 'function') {
  userSettings.onChange(() => {
    syncAllMonitoring();
  });
}

export function useUploadMonitor() {
  return {
    jobs: readonly(jobsState),
    registerBulkUpload,
    clearTrackedJob,
    syncAllMonitoring,
  };
}