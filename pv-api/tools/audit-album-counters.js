#!/usr/bin/env node
'use strict';

// Audit albums.counter against what is actually in MinIO.
//
// Reads MinIO only. It never connects to MariaDB and never writes anything —
// it prints UPDATE statements on stdout for you to review and apply yourself.
//
//   node pv-api/tools/audit-album-counters.js            # all albums
//   node pv-api/tools/audit-album-counters.js rio        # one album
//   node pv-api/tools/audit-album-counters.js --selfcheck
//
// Counts the same set AlbumViewer.vue's Images tab shows: <album>/<file> with an
// image extension, excluding <album>/thumbs/* and the <album>/<album>.json.
// Videos are deliberately not counted — the card says "photos", and the viewer
// counts them separately.

const { Client } = require('minio');
const config = require('../src/config');
const { isPhotoKey } = require('../src/services/album-counter');

// key -> album name, or null if it isn't a countable photo. The "is this a photo"
// half is the same isPhotoKey the API counts with, so the two can't disagree.
function albumOf(key) {
  const slash = key.indexOf('/');
  if (slash < 1) return null;                      // loose object at bucket root
  const album = key.slice(0, slash);
  return isPhotoKey(key, album) ? album : null;
}

function selfcheck() {
  const cases = [
    ['rio/IMG_1.avif', 'rio'],
    ['rio/IMG_2.HEIC', 'rio'],
    ['rio/thumbs/IMG_1.webp', null],
    ['rio/rio.json', null],
    ['rio/clip.mp4', null],
    ['rio/IMG_3_thumb.jpg', null],
    ['stray.avif', null],
  ];
  for (const [key, expected] of cases) {
    const got = albumOf(key);
    if (got !== expected) throw new Error(`albumOf(${key}) = ${got}, expected ${expected}`);
  }
  console.log('selfcheck ok');
}

async function main() {
  const only = process.argv[2];
  const bucket = config.minio.bucketName;

  const client = new Client({
    endPoint: config.minio.endpoint,
    port: parseInt(config.minio.port),
    useSSL: config.minio.useSSL,
    accessKey: config.minio.accessKey,
    secretKey: config.minio.secretKey,
  });

  const counts = new Map();
  await new Promise((resolve, reject) => {
    const stream = client.listObjectsV2(bucket, only ? `${only}/` : '', true);
    stream.on('data', (obj) => {
      const album = obj.name && albumOf(obj.name);
      if (album) counts.set(album, (counts.get(album) || 0) + 1);
    });
    stream.on('error', reject);
    stream.on('end', resolve);
  });

  for (const album of [...counts.keys()].sort()) {
    const sqlName = album.replace(/'/g, "''");
    console.log(`UPDATE albums SET counter = ${counts.get(album)} WHERE name = '${sqlName}';`);
  }

  console.error(`\n-- ${counts.size} album(s) with at least one photo in ${bucket}.`);
  console.error('-- Albums with zero photos in MinIO produce no statement; check those by hand.');
}

if (process.argv.includes('--selfcheck')) {
  selfcheck();
} else {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
