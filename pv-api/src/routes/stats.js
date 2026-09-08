// routes/albums.js
const express = require('express');
// const debug = require('debug');
// const debugStats = debug('pv:stats');

const config = require('../config'); // defaults to ./config/index.js
const router = express.Router();


// GET /stats - Returns statistics for the bucket
const getStats = (minioClient) => async (req, res) => {
    try {
        const bucketName = config.minio.bucketName;
        let fileCount = 0;
        let totalSize = 0;
        const folderSet = new Set();
        const fileTypeCounts = {};
        const folderTypeCounts = {};

        // ponytail: 400 keys/page keeps each page's XML under the minio SDK's
        // bundled fast-xml-parser entity-expansion cap (1000 per document) --
        // a full 1000-key page of ETags trips that cap on a bucket this size.
        // Raise this if that upstream cap is ever fixed/configurable.
        const PAGE_SIZE = 400;
        let continuationToken = '';
        let isTruncated = true;

        while (isTruncated) {
            const result = await minioClient.listObjectsV2Query(bucketName, '', continuationToken, '', PAGE_SIZE, '');

            for (const obj of result.objects) {
                if (obj.name && !obj.name.endsWith('/')) {
                    fileCount++;
                    totalSize += obj.size || 0;
                    const pathParts = obj.name.split('/');
                    const folder = pathParts.length > 1 ? pathParts[0] : '';
                    if (folder) folderSet.add(folder);

                    // Get file extension
                    const extMatch = obj.name.match(/\.([a-zA-Z0-9]+)$/);
                    const ext = extMatch ? extMatch[1].toLowerCase() : 'unknown';

                    // Count file types globally
                    fileTypeCounts[ext] = (fileTypeCounts[ext] || 0) + 1;

                    // Count file types per folder
                    if (folder) {
                        if (!folderTypeCounts[folder]) folderTypeCounts[folder] = {};
                        folderTypeCounts[folder][ext] = (folderTypeCounts[folder][ext] || 0) + 1;
                    }
                }
            }

            isTruncated = result.isTruncated;
            continuationToken = result.nextContinuationToken;
        }

        res.json({
            success: true,
            bucket: bucketName,
            fileCount,
            totalSize,
            uniqueFolders: Array.from(folderSet),
            fileTypeCounts,
            folderTypeCounts,
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

// Export factory function that accepts dependencies
module.exports = (minioClient) => {
    // Stats endpoint
    router.get('/stats', getStats(minioClient));
    return router;
};