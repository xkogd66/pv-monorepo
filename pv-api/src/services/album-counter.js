'use strict';

// albums.counter is a cache of "how many photos are in this album". It used to be
// maintained by adding and subtracting deltas, which drifts: a re-upload overwrites
// the same MinIO objects but still credits its `successful` count, and a retried
// progress report credits it twice. Recounting instead of adjusting makes the write
// idempotent, so any write path can call this as often as it likes.
//
// Counts the same set AlbumViewer.vue's Images tab shows — <album>/<file> with an
// image extension, excluding <album>/thumbs/* and the <album>/<album>.json — so the
// album card and the album header can't disagree. Uploads all convert to .avif, but
// the wider regex matches the viewer's, which keeps any legacy .jpg counted too.
// Videos are deliberately not counted: the card says "photos", and the viewer shows
// videos under their own tab with their own count.

const config = require('../config');
const database = require('./database-service');
const { listAllObjects } = require('./minio-list-service');

const PHOTO_RE = /\.(avif|jpg|jpeg|png|gif|heic)$/i;

function isPhotoKey(key, albumName) {
  const prefix = `${albumName}/`;
  if (!key.startsWith(prefix)) return false;
  const file = key.slice(prefix.length);
  if (file.includes('/')) return false;        // thumbs/ and anything nested
  if (/_thumb\./i.test(file)) return false;
  return PHOTO_RE.test(file);
}

async function countPhotos(albumName) {
  let count = 0;
  for await (const obj of listAllObjects(
    config.minio.endpoint,
    config.minio.port,
    config.minio.useSSL,
    config.minio.accessKey,
    config.minio.secretKey,
    config.minio.bucketName,
    `${albumName}/`
  )) {
    if (isPhotoKey(obj.name, albumName)) count += 1;
  }
  return count;
}

// One MinIO listing per upload batch or delete — a write-path cost, not a read-path
// one, so GET /albums still answers from the cached column with no list calls.
async function recountAlbum(albumName) {
  const count = await countPhotos(albumName);
  await database.setFileCounter(count, albumName);
  return count;
}

module.exports = { recountAlbum, isPhotoKey };
