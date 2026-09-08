// routes/albums.js
const express = require('express');
// const debug = require('debug');
// const debugStats = debug('pv:stats');

const config = require('../config'); // defaults to ./config/index.js
const router = express.Router();


// Same extension lists AlbumViewer.vue uses to split a photo grid from a video grid.
const PHOTO_EXT = /\.(avif|jpe?g|png|gif|heic)$/i;
const VIDEO_EXT = /\.(mp4|mov|avi|mkv|webm|m4v|3gp|flv|wmv)$/i;

// pv-metadata's reverse-geocode result is a Mapbox place_name, most-specific
// segment first — e.g. "Carrer Del Poeta Cabanyes 50, 08004 Barcelona,
// Barcelona, Spain". The country is reliably the last comma-separated part.
// These sentinel strings all mean "no resolvable address" — no GPS EXIF, no
// MAPBOX_TOKEN at upload time, a failed geocode, or (the last two) leftover
// values from an older version of the pipeline that isn't in the codebase
// anymore but is still baked into old albums' metadata JSON. None of them
// name a country, so skip rather than count as "unknown".
const NO_LOCATION = new Set(['not found', 'not captured', 'address not found']);
function extractCountry(location) {
    if (!location || NO_LOCATION.has(location.trim().toLowerCase())) return null;
    const parts = location.split(',').map((s) => s.trim()).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : null;
}

async function readAlbumMedia(minioClient, bucketName, folder) {
    try {
        const stream = await minioClient.getObject(bucketName, `${folder}/${folder}.json`);
        let raw = '';
        for await (const chunk of stream) raw += chunk.toString();
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed.media) ? parsed.media : [];
    } catch (error) {
        // Missing/corrupt metadata JSON for one album shouldn't break stats
        // for every other album.
        return [];
    }
}

// ponytail: module-scope cache, correct only because pv-api runs a single
// replica (k8s/base/pv-api/deployment.yaml). If that ever changes, this needs
// a shared cache (MariaDB/Redis) instead — each pod would otherwise compute
// its own copy, which is wasteful but not actually wrong.
const STATS_CACHE_TTL_MS = 5 * 60 * 1000; // stats don't need to be second-fresh
let statsCache = null; // { data, expiresAt }

// GET /stats - Returns gallery-wide totals for the Statistics popover
const getStats = (minioClient) => async (req, res) => {
    if (statsCache && statsCache.expiresAt > Date.now()) {
        return res.json(statsCache.data);
    }

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

        // One GetObject per album's metadata JSON (already-computed location
        // strings, no new geocoding) — run concurrently so a cold cache (the
        // first request after the 5-minute TTL expires) costs roughly one
        // round trip, not 90+ of them back to back.
        const photosByCountry = {};
        const albumMediaLists = await Promise.all(
            Array.from(folderSet, (folder) => readAlbumMedia(minioClient, bucketName, folder)),
        );
        for (const media of albumMediaLists) {
            for (const item of media) {
                const country = extractCountry(item.location);
                if (country) photosByCountry[country] = (photosByCountry[country] || 0) + 1;
            }
        }

        const data = {
            success: true,
            totalPhotos,
            totalVideos,
            totalAlbums: folderSet.size,
            totalSize,
            photosByCountry,
        };
        statsCache = { data, expiresAt: Date.now() + STATS_CACHE_TTL_MS };
        res.json(data);
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