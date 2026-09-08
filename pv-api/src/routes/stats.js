// routes/albums.js
const express = require('express');
// const debug = require('debug');
// const debugStats = debug('pv:stats');

const config = require('../config'); // defaults to ./config/index.js
const router = express.Router();


// Same extension lists AlbumViewer.vue uses to split a photo grid from a video grid.
const PHOTO_EXT = /\.(avif|jpe?g|png|gif|heic)$/i;
const VIDEO_EXT = /\.(mp4|mov|avi|mkv|webm|m4v|3gp|flv|wmv)$/i;

// GET /stats - Returns gallery-wide totals for the Statistics popover
const getStats = (minioClient) => async (req, res) => {
    try {
        const bucketName = config.minio.bucketName;
        let totalPhotos = 0;
        let totalVideos = 0;
        let totalSize = 0;
        const folderSet = new Set();

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
                if (!obj.name || obj.name.endsWith('/')) continue;

                totalSize += obj.size || 0;
                const folder = obj.name.split('/')[0];
                if (folder) folderSet.add(folder);

                // Thumbnails and per-album metadata JSON are storage artifacts,
                // not photos/videos — don't let them inflate the counts.
                if (obj.name.includes('/thumbs/')) continue;
                if (PHOTO_EXT.test(obj.name)) totalPhotos++;
                else if (VIDEO_EXT.test(obj.name)) totalVideos++;
            }

            isTruncated = result.isTruncated;
            continuationToken = result.nextContinuationToken;
        }

        res.json({
            success: true,
            totalPhotos,
            totalVideos,
            totalAlbums: folderSet.size,
            totalSize,
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