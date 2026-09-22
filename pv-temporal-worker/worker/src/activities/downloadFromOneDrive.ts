import { execFile } from 'child_process';
import { promisify } from 'util';

const run = promisify(execFile);

/**
 * Stream one file from OneDrive to the NFS batch dir via rclone
 * (config from RCLONE_CONFIG). Never buffers the file in worker memory.
 */
export async function downloadFromOneDrive(remote: string, localPath: string): Promise<void> {
  await run('rclone', ['copyto', remote, localPath]);
}
