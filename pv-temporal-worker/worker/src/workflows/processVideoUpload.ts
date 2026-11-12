import { proxyActivities, log, defineQuery, setHandler } from '@temporalio/workflow';
import type * as videoDeps from '../activities/uploadVideo';
import type * as cleanupDeps from '../activities/cleanup';

type VideoActivities = typeof videoDeps & typeof cleanupDeps;

const { uploadVideoToMinIO } = proxyActivities<VideoActivities>({
  startToCloseTimeout: '120 minutes',
  retry: { maximumAttempts: 3 },
});

const { cleanupBatch } = proxyActivities<VideoActivities>({
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 2 },
});

export interface VideoUploadWorkflowInput {
  batchId: string;
  folder: string;
  videos: Array<{
    filename: string;
    path: string;
    contentType: string;
    objectName: string;
  }>;
}

// Same query name/shape the API already reads for image batches (GET /bulk/progress/:id).
export const getVideoProgressQuery = defineQuery<any>('getProgress');

export async function processVideoUpload(input: VideoUploadWorkflowInput): Promise<void> {
  const { batchId, folder, videos } = input;
  const batchDir = `/nfs-storage/video-${batchId}`;
  const nowIso = new Date().toISOString();
  const state = {
    totalRequested: videos.length,
    processed: 0,
    successful: 0,
    failed: 0,
    percentage: 0,
    startedAt: nowIso,
    updatedAt: nowIso,
    completedAt: null as string | null,
    message: `Accepted ${videos.length} videos for upload`,
    lastSuccessFile: null as string | null,
    lastFailedFile: null as string | null,
    failedFiles: [] as Array<{ filename: string; error: string }>,
    error: null as string | null,
    albumName: folder,
  };
  setHandler(getVideoProgressQuery, () => ({ ...state, failedFiles: [...state.failedFiles] }));

  log.info('processVideoUpload: start', { batchId, folder, videoCount: videos.length });

  try {
    // One activity per file so a single failure doesn't abandon the rest.
    for (const video of videos) {
      try {
        await uploadVideoToMinIO({ batchId, folder, videos: [video] });
        state.successful++;
        state.lastSuccessFile = video.filename;
      } catch (err) {
        const msg = (err instanceof Error ? err.message : String(err)).slice(0, 300);
        log.error('processVideoUpload: file failed', { batchId, filename: video.filename, error: msg });
        state.failed++;
        state.lastFailedFile = video.filename;
        state.failedFiles.push({ filename: video.filename, error: msg });
        state.error = state.error ?? msg;
      }
      state.processed = state.successful + state.failed;
      state.percentage = Math.round((state.processed / state.totalRequested) * 100);
      state.updatedAt = new Date().toISOString();
    }
    state.completedAt = new Date().toISOString();
    state.message = 'Video upload completed';
    log.info('processVideoUpload: complete', { batchId, successful: state.successful, failed: state.failed });
  } finally {
    await cleanupBatch(batchDir);
  }
}
