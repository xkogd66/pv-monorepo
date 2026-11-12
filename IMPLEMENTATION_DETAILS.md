# PhotoVault — Implementation Details

How each feature is built, why, and what it costs. Moved out of `CLAUDE.md` so that file stays short. Read this for context before opening code.

---

# System Reference

## Repository Structure

| Directory | Role | Language/Framework |
|---|---|---|
| `pv-api/` | Backend REST API | Node.js / Express 5.x |
| `pv-spa/` | Web frontend | Vue 3 / Vite / Tailwind |
| `pv-converter/` | AVIF image conversion service | Python 3.11 / FastAPI |
| `pv-metadata/` | EXIF extraction + album index writer (MinIO) | Python 3.11 / FastAPI |
| `pv-temporal-worker/` | Async batch processing worker | TypeScript / Temporal SDK |
| `k8s/` | Kubernetes manifests | YAML (base configs per service) |
| `tools/` | Utility scripts | — |

`pv_bulk_upload` (CLI bulk upload tool) was deprecated and removed — it targeted
`POST /buckets/:bucket/upload` and the `/processing-status/:jobId` SSE stream, both
removed with the legacy upload path. If ever needed again, recover it from git history.

---

## Architecture

All uploads go through Temporal. There is no synchronous upload path.

```
── Image upload ──────────────────────────────────────────────────
Browser → pv-spa → pv-api
                    │ 1. stage files to NFS
                    │ 2. start Temporal workflow → 202
                    │
                    └──→ Temporal ──→ pv-temporal-worker
                                        │ (orchestrates, per image)
                                        ├──→ pv-metadata ──→ MinIO
                                        ├──→ pv-converter ──→ MinIO
                                        ├──→ reportProgress ──→ pv-api POST /bulk/progress
                                        │                           │ (stored; polled by SPA)
                                        └──→ cleanupBatch (NFS)

── Video upload ──────────────────────────────────────────────────
Browser → pv-spa → pv-api POST /video → Temporal (processVideoUpload)

pv-api also serves:
  GET /bulk/status/:workflowId  (Temporal query)
  GET /bulk/progress/:workflowId (Temporal query)

Shared backing services (all flows):
  MinIO (S3)  ·  MariaDB  ·  Temporal server
```

**Key communication patterns:**
- **pv-temporal-worker → pv-converter**: `POST /convert` (AVIF conversion + WebP thumbnail)
- **pv-temporal-worker → pv-metadata**: `POST /extract` with the original file + converted `object_name`; pv-metadata extracts EXIF and **writes the result directly to MinIO** (`<folder>/<folder>.json`)
- **pv-api → Temporal**: gRPC to start `processBatchImages` / `processVideoUpload` workflows
- **pv-temporal-worker → MinIO**: direct S3 API
- **pv-api → browser**: the SPA polls `GET /bulk/progress/:id`; pv-api does not stream SSE

pv-api does **not** extract EXIF or call pv-converter itself. It stages files and starts
workflows. Do not reintroduce extraction into pv-api — the worker already calls pv-metadata,
and a second extraction there is thrown away.

---

## Infrastructure Dependencies

All of these must be running for the full system to work:

| Service | Address | Purpose |
|---|---|---|
| MinIO | `mjolnir:9000` | S3-compatible object storage (bucket: `photovault`) |
| MariaDB | `mariadb-service.data.svc.cluster.local:3306` | User/album relational data |
| Temporal | `temporal-frontend.temporal.svc.cluster.local:7233` | Workflow orchestration |
| NFS mount | `/nfs-storage` | Staging area for bulk uploads |
| Mapbox (optional) | API call | Reverse geocoding for GPS coordinates |
| Cloudflare Turnstile (optional) | API call | CAPTCHA on login |

---

## Dev Commands

```bash
# pv-api (Node.js / CommonJS)
cd pv-api && npm install
npm run dev      # nodemon + DEBUG logging
npm start        # production

# pv-spa (Vue 3 / Vite)
cd pv-spa && npm install
npm run dev      # Vite dev server on :5173
npm run build    # output → dist/
npm run preview

# pv-converter (Python / FastAPI)
cd pv-converter && pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 3000

# pv-metadata (Python / FastAPI)
cd pv-metadata && pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000

# pv-temporal-worker (TypeScript)
cd pv-temporal-worker && npm install
npm run dev      # ts-node src/index.ts
npm run build    # tsc output
npm start        # run compiled JS
```

---

## Configuration

**pv-api** centralizes all config in `pv-api/src/config/index.js`. Key sections:

- `server` — port 3000, environment
- `cors` — allowlist: `photos.ekskog.me`, `localhost:5173`, Capacitor app origins
- `temporal` — address, namespace, task queue, NFS path
- `minio` — endpoint, port 9000, bucket name, public URL for presigning
- `converter` — URL + 300s timeout
- `metadata` — URL + 30s timeout
- `auth` — JWT secret, 24h expiry
- `database` — MariaDB host/port/credentials
- `kubernetes` — service name, namespace, public URL

**Secrets** are managed via Kubernetes Secrets (`pv-api-secret`): `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `DB_PASSWORD`, `JWT_SECRET`, `MAPBOX_TOKEN`, `TURNSTILE_SECRET_KEY`.

Non-sensitive vars live in ConfigMaps per service under `k8s/base/<service>/configmap.yaml`.

---

## Key API Endpoints (pv-api)

| Method | Path | Description |
|---|---|---|
| POST | `/auth/login` | JWT login (with Turnstile CAPTCHA) |
| GET | `/auth/user` | Validate bearer token, return current user (used by the SPA on init/refresh to restore a session) |
| POST | `/auth/register` | User registration |
| GET | `/albums` | List albums (includes `year`, `month`, `fileCount`, `coverThumbnailUrl`, `isPrivate`); private albums omitted for anonymous callers |
| POST | `/album/:folderPath` | Create album with optional `month`/`year`/`isPrivate` metadata (admin; defaults to private) |
| PUT | `/album/:currentName` | Rename and/or edit album metadata — `name`, `description`, `month`, `year`, `cover`, `isPrivate` (admin) |
| DELETE | `/buckets/:bucketName/folders` | Delete album and its photos (admin) |
| GET | `/objects/:name` | List photos in an album (presigned URLs); 404 for anonymous callers on a private album |
| POST | `/bulk/upload/:folder` | Image upload → Temporal workflow (returns 202 + batchId) |
| POST | `/video/upload/:folder` | Video upload → Temporal workflow (returns 202 + batchId) |
| GET | `/onedrive/folders?path=` | List subfolders of `onedrive:photo-albums/<path>` via rclone (admin) |
| POST | `/onedrive/import` | `{ path, albumName, resume? }` → start OneDrive import into an existing album; `resume` skips files already stored (admin; 202 + batchId) |
| GET | `/bulk/status/:workflowId` | Poll bulk workflow status |
| GET | `/bulk/progress/:workflowId` | Poll bulk workflow progress |
| POST | `/bulk/cancel/:workflowId` | Stop a running upload/import (admin) |
| POST | `/bulk/progress` | Progress callback from the worker |
| GET | `/health` | Health check |
| GET | `/stats` | Storage and photo statistics |

---
## CI/CD

**File**: `.github/workflows/monorepo-ci.yml`  
**Trigger**: push to `main`

Each service has a matrix entry that:
1. Detects if its source directory or its `k8s/base/<service>/` manifests changed
2. Builds and pushes Docker image to GHCR (`ghcr.io/ekskog/<service>:latest` + `:<short-sha>`)
3. Deploys to the K8s cluster via `kubectl apply`

Special rule: `pv-temporal-worker` rebuilds whenever `pv-api` changes (shared types dependency).

Registry auth: `secrets.EK_GITHUB_PAT`

---

## Kubernetes Deployment

All manifests live under `k8s/base/<service>/` with per-service:
- `deployment.yaml`
- `service.yaml`
- `configmap.yaml` (non-sensitive vars)
- `secrets.yaml` (sensitive vars — do not commit actual values)

**Namespace**: `pv`  
**Public endpoints**: `https://photos.ekskog.me` (frontend), `https://vault-api.ekskog.net` (API)

---

## Testing

No test suite in any service. Verification is integration testing against the running
cluster.

---

## Resource Limits (K8s)

| Service | CPU Request | CPU Limit | Mem Request | Mem Limit |
|---|---|---|---|---|
| pv-api | 100m | 1000m | 128Mi | 512Mi |
| pv-converter | 250m | 2000m | 512Mi | 4Gi |
| pv-spa | 50m | 100m | 64Mi | 128Mi |
| pv-temporal-worker | 500m | 1000m | 512Mi | 1Gi |

`pv-converter` runs on a dedicated node (`ubumac`) via node affinity/toleration (`avif-converter` taint).

---

## Security Notes

- JWT auth, 24h expiry
- Bcrypt password hashing (`bcrypt` + `bcryptjs`)
- Cloudflare Turnstile CAPTCHA on login
- CORS allowlist — not open
- All secrets in K8s Secrets, not ConfigMaps

---

## Coding Conventions

- **pv-api**: CommonJS (`require`/`module.exports`), not ESM
- **pv-spa**: ESM Vue 3 Composition API
- **pv-temporal-worker**: TypeScript strict mode
- **pv-converter / pv-metadata**: Python 3.11, async FastAPI handlers
- No formal test suite — rely on integration testing against the running cluster

---

## SPA Runtime Configuration

The SPA is a static nginx-served Vue app. Runtime config (API URL, feature flags) is injected at container startup by an entrypoint script that reads env vars from the ConfigMap and writes `/usr/share/nginx/html/env-config.js`, which sets `window.__ENV__`.

**Critical:** `env-config.js` must never be cached. nginx is configured with `Cache-Control: no-store` for that path. If `env-config.js` gets stale (e.g. after a pod restart with a configmap change), Cloudflare may serve the old version — purge `https://photos.ekskog.me/env-config.js` from the Cloudflare cache.

The correct `API_URL` in `k8s/base/pv-spa/configmap.yaml` is **`https://vault-api.ekskog.net`** — the public API hostname. Do not use the internal K8s DNS name (`http://pv-api-service.pv.svc.cluster.local`): browsers cannot resolve it and it triggers mixed-content blocking on HTTPS pages.

The SPA's nginx (`pv-spa/nginx.conf`) also proxies API paths (`/auth`, `/albums`, `/objects`, etc.) to `http://pv-api-service` internally — this is a secondary path used for same-origin requests and does not affect how the runtime config URL is set.

---

## Public Endpoints and Networking

| Hostname | What it points to | Via |
|---|---|---|
| `photos.ekskog.me` | pv-spa nginx (port 80) | Cloudflare Tunnel |
| `vault-api.ekskog.net` | pv-api (port 3000) | Cloudflare Tunnel |
| `objects.ekskog.net` | MinIO (port 9000) | Cloudflare Proxy (orange cloud) |

All Cloudflare Tunnel routes are configured in the **Cloudflare dashboard** (not in K8s). The cloudflared pod runs in the `webapps` namespace and connects outbound to Cloudflare. It resolves backend services by K8s cluster DNS.

**MinIO presigned URLs** must be signed with the *public* hostname (`objects.ekskog.net`) as the endpoint. `pv-api` maintains a separate `publicMinioClient` for this purpose (`server.js`). The standard `minioClient` uses the internal address and must not be used for generating presigned URLs served to browsers.

---

---

# Features

## Upload Flow (Temporal — the only path)

1. Browser → `POST /bulk/upload/:folder` → 202 + batchId (sent before anything is staged)
2. In the background, files are staged to `/nfs-storage/<batchId>`
3. Temporal workflow `processBatchImages` started (workflowId `batch-<batchId>`)
4. pv-temporal-worker processes sequentially (1 concurrent; 1 GB RAM limit), calling
   pv-metadata then pv-converter per image
5. Worker POSTs progress to `/bulk/progress`; the SPA polls `GET /bulk/progress/:workflowId`
6. When the final report arrives (`state === 'complete'`, at least one success), pv-api recounts
   the album (`recountAlbum`) and sets its cover if empty (see Album Counter / Album Cover)

Videos follow the same shape via `POST /video/upload/:folder` (admin) → `processVideoUpload`,
workflowId `video-<uuid>`. That workflow does not call `reportProgress`, so it never touches the
counter or cover and has no persisted progress snapshot; its progress comes only from the
`getProgress` query.

A failure while staging or starting the workflow happens after the 202 and is only logged in
pv-api; the browser is never told.

---

## OneDrive Import (rclone)

Pulls one OneDrive folder into a new library album. Written 2026-09-22; **not yet
built, deployed or exercised end to end** against the cluster.

**Why rclone, not Microsoft Graph:** Graph needs an Azure app registration, an OAuth
flow in pv-api and a token table. rclone ships its own client ID, handles token
refresh, streaming and throttling, and the owner already used it. Chosen as the
simplest option; see the costs below.

**Flow**

```
Albums.vue toolbar (cloud-download icon, admin) → OneDriveImportDialog.vue
  │ browse: GET /onedrive/folders?path=2023     (rclone lsjson --dirs-only)
  │ 1. POST /album/:name   (existing create; private unless the checkbox is unticked; 409 if taken)
  │ 2. POST /onedrive/import { path, albumName, resume? }
  │        pv-api: rclone lsjson --files-only → filter → start processBatchImages
  │        workflowId batch-<batchId>, each file carries `remote`
  └ registerBulkUpload() → same progress polling / Monitor page as bulk upload

pv-temporal-worker, processBatchImages, per file:
  downloadFromOneDrive (rclone copyto → /nfs-storage/<batchId>/<name>)
  ├ JPEG/HEIC → extractAndPersistMetadata → convertImage   (unchanged path)
  └ video     → uploadVideoToMinIO (stored as-is at <album>/<name>)
```

It deliberately reuses `processBatchImages` and the `batch-` workflow-id prefix, so
`/bulk/progress`, `/bulk/jobs`, the Monitor page, `albums.counter` and the album cover
all work with no changes. Uploads that don't come from OneDrive have no `remote` and no
videos, so they run the same activity sequence as before (safe for in-flight workflows).

**Files**
- `pv-api/src/routes/onedrive.js` — both routes; `ROOT = "onedrive:photo-albums"`.
- `pv-temporal-worker/worker/src/activities/downloadFromOneDrive.ts` — one `rclone copyto` per file.
- `pv-temporal-worker/worker/src/workflows/image-batch-workflow.ts` — `remote` download + video routing.
- `pv-spa/src/components/OneDriveImportDialog.vue` — folder browser + import form.
- `pv-api/Dockerfile`, `pv-temporal-worker/worker/Dockerfile` — `COPY --from=rclone/rclone:1.71.1`
  (pv-api also copies the CA bundle; the slim Node image may lack one).
- `RCLONE_CONFIG` in both ConfigMaps.

**Rules**
- Only `image/jpeg`, `image/heic` (pv-converter's accepted types) and videos matching the
  `AlbumViewer.vue` extension regex are imported. Other files are left on OneDrive and
  never counted. OneDrive is read-only from pv's side: nothing is moved or deleted there.
- One folder per import, no recursion into subfolders.
- `GET /onedrive/folders` results are cached in pv-api memory per path with a 24h TTL
  (`FOLDER_TTL_MS` in `onedrive.js`). A new OneDrive album can take up to 24h to appear
  in the dialog; restart pv-api to see it immediately. The file list at import time is
  always read fresh.
- The dialog pre-fills from the folder: `2023/(02) solna` → name `solna`, month 2, year 2023.
  Anything else (`M`, `london 91-92`) just uses the folder name. All fields are editable.
- Each download is its own Temporal activity (retried), streamed to NFS — the file is
  never held in worker memory, so the 1 GiB limit doesn't apply to large videos.

**rclone config**
- Lives on NFS at `/mnt/storage/slask/pv/.rclone/rclone.conf` on mjolnir, which the pods
  see as `/nfs-storage/.rclone/rclone.conf`. Remote name: `onedrive` (personal drive).
- It must be writable: rclone rewrites the refresh token on every refresh, so a read-only
  Secret mount would go stale. Owner is `65534:65534` (`nobody`; the NFS export squashes
  clients to it), mode `600`.
- This is a dedicated config for the photo-library OneDrive account only — not the owner's
  other rclone config. `~/pv-rclone.conf` on mjolnir is a stale backup; don't use it.
- **If the token dies** (import fails with an rclone auth error), on mjolnir:
  ```bash
  sudo rclone --config /mnt/storage/slask/pv/.rclone/rclone.conf config reconnect onedrive:
  sudo chown 65534:65534 /mnt/storage/slask/pv/.rclone/rclone.conf
  ```
  Sign in with the live.com account that holds the photos.
- Never paste the config contents anywhere; it holds a token with read access to the whole drive.

**Known costs and gaps**
- If the import fails to start after the album was created (e.g. rclone error), an empty
  album is left behind and a retry gets 409. The dialog then offers **Resume import**, which
  reuses the existing album (see Upload Monitoring section); otherwise delete the album.
- JPEG/HEIC over 15 MB fail at pv-converter's existing input limit and count as failed.
- In an import, videos count toward the job's progress totals but **not** toward
  `albums.counter`, which `recountAlbum` computes from photos only (the card says "photos").
  Plain `POST /video/upload` likewise never touches the counter.
- Videos never become the cover (`lastSuccessFile` is only set for images).
- Same-name folders in one year (`(06) cph`, `(11) cph`) collide: the second gets 409 —
  rename it in the dialog.
- The token sits in plain text on NFS; anyone with root on mjolnir or access to the export can read it.
- rclone's shared client ID is throttled harder by Microsoft than a private one would be.
- No "OneDrive not connected" UI — a dead token just shows rclone's error in the dialog.


---

## SPA Layout

`App.vue` `<main>` uses `px-2 sm:px-4 py-4 sm:py-6` — minimal horizontal padding, no `max-w` constraint. Individual views that need centering (e.g. `Albums.vue`) apply their own `max-w-[1200px] mx-auto`. Do not add a global `max-w` back to `App.vue` — it causes excessive whitespace in the photo grid.

## Landing Page (`Home.vue`)

`App.vue` picks `home` on load when `!isAuthenticated` (otherwise `albums`) and on logout. It is not exclusive to anonymous visitors: `handleLoginSuccess` also sets the view to `home`, and the logo in `AppHeader.vue` (`lg` and up) navigates to `home` for anyone.

- Hero fetches `apiService.getAlbums()` on mount and uses the first 12 albums' `coverThumbnailUrl` (already presigned server-side, no per-album `getAlbumContents` calls needed) as a background collage. Falls back silently to a plain gradient if the fetch fails or no albums have a cover yet — no error shown to the visitor.
- The single CTA, **"Browse Galleries"**, emits `navigate('albums')` (handled by `@navigate="handleNavigation"` on `<Home>` in `App.vue`). `GET /albums` and `GET /objects/:name` require no auth, so anonymous browsing works. It is not the only way in: `AppHeader.vue` has an unconditional "Albums" nav button (desktop nav and mobile menu), shown to anonymous visitors too. Keep at least one anonymous route into `Albums.vue`.
- Login/Register are deliberately **not** on this page — they live only in `AppHeader.vue` (top nav / user menu), which already wires them to the same `handleLoginTrigger`/`handleRegisterTrigger` in `App.vue`. Keep auth entry points low-key here; this was a deliberate call, not an oversight.

## Statistics (`AppHeader.vue`)

Gallery statistics (`BucketStats.vue`) live in the top nav, not on the landing page. Gated on `isAuthenticated` (any logged-in user, not just admins) — a "Statistics" button in the desktop nav toggles a popover anchored to it (same pattern as the health-status dot), and the mobile menu gets an inline expand/collapse toggle instead (popovers don't work well on mobile). `BucketStats.vue` is self-contained and fetches its own data — no props needed beyond the existing `noBorder` styling flag. It fetches in `onMounted` and both containers are `v-if`, so every open of the popover/toggle requests `/stats` again (the server cache below is what keeps that cheap).

`GET /stats` (`pv-api/src/routes/stats.js`) returns `totalPhotos`, `totalVideos`, `totalAlbums`, `totalSize`, and `photosByCountry` — rendered as a 2x2 tile grid plus a scrollable country list. It used to also return a raw per-extension breakdown and a giant per-album `.avif`-count table; both were dropped (no other consumer existed) because they dumped storage internals (`.json`/`.webp` artifact counts) at the user and the per-album table overflowed the popover. `totalPhotos`/`totalVideos` are counted with the same extension regexes `AlbumViewer.vue` uses to split its photo/video grids (photos: `avif|jpe?g|png|gif|heic`; videos: `mp4|mov|avi|mkv|webm|m4v|3gp|flv|wmv`), and explicitly skip anything under `/thumbs/` — a thumbnail or metadata JSON is a storage artifact, not a photo. `totalSize`, by contrast, is the literal sum of every object's bytes (thumbnails included) since it's meant to answer "how much MinIO storage am I using," not "how many photos do I have." `totalAlbums` is the number of distinct top-level prefixes in the bucket, not rows in the `albums` table.

The result is cached in pv-api memory for 5 minutes (`STATS_CACHE_TTL_MS`), shared by all callers. This is correct only because pv-api runs a single replica; with more, each pod would keep its own copy. Uploads, deletes and renames therefore show up in the numbers up to 5 minutes late. The bucket listing is paged at 400 keys (`PAGE_SIZE`) to stay under the minio SDK's XML entity-expansion cap.

`photosByCountry` reuses geodata pv-metadata already computed at upload time — no new reverse-geocoding calls. Each photo's entry in `<album>/<album>.json` (`media[]`) carries a `location` string from Mapbox's reverse-geocode (`pv-metadata/main.py`'s `reverse_geocode`, a `place_name` like `"Carrer Del Poeta Cabanyes 50, 08004 Barcelona, Barcelona, Spain"`), and the country is reliably its last comma-separated segment. Building this means one extra `GetObject` per album (its metadata JSON), issued concurrently, beyond the existing bucket-wide listing — acceptable because the result is cached and `/stats` is only requested when the popover opens, not polled. A photo whose `location` is `"not found"` (no GPS EXIF, no `MAPBOX_TOKEN` at upload time, or a failed geocode call) is skipped rather than counted under some "Unknown" bucket, and that's permanent for that photo — like the cover backfill, there's no re-geocoding pass for old data. The sentinels `"not captured"` and `"address not found"` (left in old albums' JSON by an earlier pipeline) are skipped the same way. A missing or corrupt album JSON yields no countries for that album instead of failing the request.

## Photo Grid (`PhotoGrid.vue`)

- Renders a slice of the full photo array (`itemsPerPage: 24` default); all photos are fetched at once from the API.
- Layout: 3 columns on phone; from `sm` up `repeat(auto-fill, minmax(cellSize, 1fr))`. `cellSize` (default 400) is a prop driven by the +/- control in `AlbumViewer.vue` (150–700 px, steps of 50).
- Infinite scroll via `IntersectionObserver` on a sentinel `<div ref="scrollTrigger">` at the bottom. The sentinel uses `v-show` (not `v-if`) — `v-if` would destroy and recreate the element on each batch load, breaking the observer's DOM reference.
- `rootMargin: '200px'` on the observer pre-triggers the next batch before the user reaches the bottom.
- No extra network requests on scroll — `loadMore()` is a synchronous `Array.slice`.
- A "Showing X of Y photos" footer is shown under the grid (unlike the album grid, which has none). Changing the `photos` prop resets the window to the first batch.
- The observer is attached once, in `onMounted`, and not re-attached afterwards. `AlbumViewer.vue` mounts `PhotoGrid` (it only `v-if`s on `mediaType`) before the photos have loaded, so the sentinel is `display: none` at attach time — the same condition that stuck `Albums.vue` at its first batch (see Album Grid). Not exercised; if the photo grid stops after the first 24, re-attach from a `watch` on `hasMorePhotos` behind `nextTick()`, as `Albums.vue` does.

---

## Photo Metadata (`<album>/<album>.json`)

Per-photo metadata lives in `media[]` of the album JSON in MinIO, keyed by `sourceImage`
(`<album>/<name>.avif`). pv-metadata writes it at upload; the SPA edits it afterwards.

**"Invalid date" / "not found" on a photo usually means the file had no EXIF, not a pipeline
bug.** pv-metadata reads the *original* bytes, so a JPEG whose EXIF was stripped before upload
(e.g. a photo taken inside Messenger/WhatsApp and then saved to Photos — JFIF + Photoshop
headers, 1080×1920, Photos shows "No camera information") gets `"not found"` for date and GPS.
Native-camera HEICs carry full EXIF. Photos keeps its own date/location in its library, which
AirDrop does not write into the file. To embed them: iPhone Share → Options → Location →
*All Photos Data*, or Mac Photos → File → Export → *Export 1 Photo…* with Location Information
ticked (not "Unmodified Original"). The fix for such photos is the Edit Photo Metadata dialog.
`formatMetadataTimestamp` (`utils/timestamp.js`) shows the string `"not found"` as "Invalid date" (only an empty
value gives "No date") — left as is.

**Edit Photo Metadata** (`EditPhotoMetadata.vue` → `PUT /objects/:folderPath/:objectName`,
admin; `updatePhotoMetadata` in `albums.js`):
- Merges `coordinates`/`timestamp` into the entry; if coordinates are given the API
  reverse-geocodes them (Mapbox) and overwrites `location`. If the geocode fails the error is
  swallowed and the old `location` stays. Clearing both lat/lng sends `coordinates: "not found"`,
  which also fails the geocode, so the old `location` is not cleared.
- **Duplicate entries:** an album JSON can hold two entries for one `sourceImage` (seen on
  `bcn.challenger.walkers`; cause unknown — pv-metadata's upsert removes same-name entries, so
  re-uploads don't explain it, and a concurrent read-modify-write race is the best guess).
  The SPA lookup (`AlbumViewer.loadAlbumMetadata`) keeps the *last* entry, while the save used to
  update the *first* — so an edit returned 200 and was in MinIO but never showed. The save now
  updates the first match and drops the other duplicates. A lost update (`IMG_1647` was missing
  from that JSON entirely) was also seen and is not addressed.
- **Timestamp convention:** a time with no offset is stored as the naive wall-clock with a
  `Z` suffix (what pv-metadata does for EXIF times without an offset) and displayed as that same
  wall-clock. The `Z` is not real UTC. `fromDatetimeLocalPreservingOffset` used to convert to
  UTC via `toISOString()`, shifting the time by the viewer's offset on every first save. Photos
  edited before the fix keep their shifted value until re-saved. If the original timestamp has an
  offset, that offset is kept on save.
- **24-hour time:** the dialog uses `<input type="date">` plus a text `HH:mm` field, because
  native `datetime-local`/`time` inputs follow the browser locale (AM/PM in en-US Edge).
  Trade-off: no clock picker. A date with an empty/invalid time is blocked with a toast so it
  can't save an empty timestamp.
- **Known gap:** `deleteObjects` removes the photo's `media[]` entry by comparing `sourceImage`
  to the bare filename (`objectName`), but `sourceImage` is `<album>/<name>.avif`, so the
  comparison never matches and deleted photos keep their entry in the album JSON.

## Upload duplicate prompt (`MediaUpload.vue`)

Before a bulk photo upload, `confirmReplaceExisting()` fetches the album contents and compares
names with the extension swapped to `.avif` (so `IMG_1.heic` collides with `IMG_1.avif`). If any
match, a `window.confirm` lists up to 10 and asks to replace; Cancel aborts with nothing sent.
Client-side only — the API still accepts duplicates if called directly. It fails open if the
lookup errors, can't catch two simultaneous uploads, and doesn't cover videos.

## Toasts

`composables/useToast.js` (`showToast(message, { type, duration })`, types `info` default,
`success`, `error`, `warning`; default duration 4 s) is rendered once, globally, in `App.vue` at `z-[60]` (above the
lightbox's `z-50`). It used to be rendered only inside `AlbumViewer.vue`, so toasts only showed on
the album page. In use: album create/edit/delete, photo delete, set cover, metadata save, link
copied, skipped upload files, upload-stopped (`BulkUploadJobs.vue`), and the "upload accepted"
notices in `AlbumViewer.vue` (used only when browser Notification permission is not granted).
Left as browser dialogs on purpose: the Settings reset confirm, the duplicate-upload confirm and
the Monitor page's "Stop this upload?" confirm — a toast can't ask a question. **Unverified:** none of the toast,
duplicate-prompt or timestamp changes have been built or exercised in the app yet.


---

## Thumbnails

Thumbnails are pre-generated WebP files stored at `<album>/thumbs/<filename>.webp` in the `photovault` MinIO bucket. They are at most 400px wide (never upscaled), WebP quality 75.

**How thumbnails are created:**
- **New uploads**: `pv-converter` generates the WebP thumbnail from the source image (JPEG/HEIC) using Pillow (`ImageOps.exif_transpose()` is applied first to correct EXIF orientation before resizing) before freeing source bytes, then uploads it to `<album>/thumbs/<filename>.webp`. Every upload goes through pv-converter. A failed thumbnail generation or upload is logged as a warning and does not fail the conversion, so the photo ends up with no thumbnail (the SPA falls back to the full-res image).
- **Existing images**: there is no backfill script any more. `tools/generate-thumbs.js` was
  removed once pv-converter started generating thumbnails on every upload. If a backfill is
  ever needed again, recover it from git history rather than rewriting it.

**How thumbnails are served:**
- `pv-api` `getPhotos` generates a presigned URL for `<album>/thumbs/<filename>.webp` and returns it as `thumbnailUrl`. The presign is local and never checks the object exists. Only `.avif` names are swapped to `.webp`; for a video the URL points at a non-existent `thumbs/<name>` object.
- `PhotoCard.vue` loads `thumbnailUrl` for the grid. On error (thumbnail missing), it silently falls back to the full-res presigned URL without showing an error to the user. On successful thumbnail load, it prefetches the full-res URL so the lightbox opens instantly.
- Thumbnails are deleted alongside their parent AVIF when a photo is deleted (`albums.js` `deleteObjects`, best-effort: a failed delete is ignored).


---

## Album Year Metadata (`albums.year` / `albums.month`)

Albums carry an optional **year** and **month** that describe the album's content
(e.g. "summer 2025 photos"), stored as `INT` columns in the `albums` table. They are
**album metadata**, not `created_at` (when the album was created) and not `updated_at`
(last upload).

**How they are set:**
- Created: `CreateAlbumDialog` (SPA) → `POST /album/:folderPath` with optional `month`/`year`
  (plus `description` and `isPrivate`).
- Edited after creation: **Edit Album** dialog (`Albums.vue`, pencil button on `AlbumCard`) → `PUT /album/:currentName`.
  The dialog always sends the full set (`newName`, `description`, `month`, `year`, `isPrivate`).

**How they are exposed:**
- `GET /albums` returns `year` and `month` per album (nullable). `getAllAlbums()` in
  `pv-api/src/services/database-service.js` selects the columns; `getAlbums()` in
  `pv-api/src/routes/albums.js` passes them through.

**SPA year filter (`Albums.vue`):**
- A year `<select>` ("All years" + one option per year; shown only when at least one album has a year) filters the grid to albums whose `year` matches the selection.
  Options are the distinct non-null years across all albums, sorted most-recent-first.
- Albums with `year = NULL` appear only under "All years".
- The pipeline is `filteredAlbums` → `sortedAlbums` → `visibleAlbums`; sorting and
  the visible window compose with the filter. Selecting a year (or changing the sort)
  rewinds the window to the first batch, as does `loadAlbums()` after a
  create/edit/delete/refresh — the list is replaced wholesale, so a preserved scroll
  position would point at whatever slid into that slot.
- An empty year-filter result shows "No Albums in {year}" instead of the generic empty state.
- `selectedYear` and `sortOrder` live at **module scope** in `Albums.vue` (a plain `<script>` block),
  because `App.vue` unmounts `Albums` when an album is opened; component-local refs would reset
  the filter/sort on every return. They survive navigation but not a full page reload.
- `AlbumCard.vue`'s caption carries the album date next to the photo count — one
  `metaLine` (`36 photos · May 2026` from `month` + `year`), not a separate badge, and
  either value silently drops out when missing (see the Album Grid section below).
  Month is rendered as a full name; the edit/create dialogs send it as an integer.

**SPA sort (`Albums.vue` `sortedAlbums`):** six options in one `<select>`, default `year-desc`.
- **Chronological** (`year-desc` "Newest first" / `year-asc` "Oldest first") compares the
  album content date — `year` first, then `month` — not `created_at`/`updated_at`. This is
  the default, so the grid lands newest-first by album date.
- **Modified** (`modified-desc` "Recently modified" / `modified-asc` "Least recently
  modified") compares `updated_at`, surfaced to the SPA as `lastModified` in `loadAlbums()`.
- **Name** (`name-asc` / `name-desc`) is a plain `localeCompare`.
- Missing values sort **last in both directions**: an album with `year = NULL` never
  interleaves with dated albums, and within a year an album with `month = NULL` follows
  ones that have a month. `compareYearMonth` / `compareModified` take a `dir` (`-1` for a
  `-desc` option, `+1` for `-asc`) so each pair shares one comparator.

**`PUT /album/:currentName` (admin) — update semantics:**
Accepts `newName`, `description`, `month`, `year`, `cover`, `isPrivate` in the body. Behavior depends on the name:
- **Name unchanged** (or omitted) → metadata-only update of `description`/`month`/`year`/`cover`/`isPrivate`
  in MariaDB; no MinIO movement.
- **Name changed** → full rename: MinIO objects are copied to the new path, the album
  metadata JSON (`<folder>/<folder>.json`) is rewritten, and `name`/`path` plus any edited
  `description`/`month`/`year`/`cover`/`isPrivate` are persisted in the DB. Old objects are deleted only after
  the copy and DB update succeed.
- `month`/`year` are coerced to integers (or `NULL` when cleared). Fields not sent fall back
  to existing values, so callers can send just `{ newName }` (old rename behavior) or just
  metadata changes. `cover` and `isPrivate` are only written when sent.

---

## Album Counter (`albums.counter`)

The `albums.counter` column in MariaDB caches the **photo** count per album and is used by `GET /albums` (as `fileCount`) to avoid N MinIO list calls.

**How it is maintained:** it is **recomputed, never incremented or decremented**.
`recountAlbum(albumName)` (`pv-api/src/services/album-counter.js`) lists the album's MinIO
prefix once and writes the result with `setFileCounter()`, so it is idempotent: a re-upload
that overwrites objects, or a progress POST that arrives twice, cannot make it drift.
- Bulk upload (`temporalUploads.js`): called (fire-and-forget) when a `reportProgress` POST
  arrives with `state === 'complete'`, `albumName` set and `successful > 0`.
- Delete (`albums.js` `deleteObjects`): called (fire-and-forget) after each object delete.

**What is counted:** the same set `AlbumViewer.vue`'s Images tab shows — `<album>/<file>`
(no nested keys, so not `thumbs/`) with extension `avif|jpg|jpeg|png|gif|heic`, excluding
`*_thumb.*` and the album JSON. **Videos are not counted**, including videos imported from
OneDrive; a video-only album has `counter = 0` and shows "Empty".

**Cost / limitation:** one MinIO listing per completed batch or per deleted object — a
write-path cost; `GET /albums` still makes no list calls. Deleting many photos one by one
triggers one recount each. A failed recount is swallowed, so the cached value can be stale
until the next upload or delete. There is no audit/fix script any more (`tools/` no longer
has one); any write path can call `recountAlbum` to heal an album.

**Root cause of past counter bug (fixed):** The Temporal workflow was setting `completedAt` after the image loop but never calling `reportProgress` with that final state, so the API never saw `state === 'complete'`. Fixed in `image-batch-workflow.ts` by adding a final `reportProgress` call after `completedAt` is set.

**Do not** count objects from the per-album metadata JSON (`<folder>/<folder>.json`) to derive the counter — the JSON may contain entries for files that no longer exist in MinIO, or for original files that were converted and replaced. Count actual MinIO objects instead.

---

## Album Cover (`albums.cover`)

The `albums.cover` column holds the **filename only** of the album's cover thumbnail
(e.g. `IMG_1234.webp`) — never a full path. `GET /albums` composes the object name as
`<album.name>/thumbs/<album.cover>` and returns a presigned `coverThumbnailUrl`.

Storing a bare filename rather than a path is deliberate: `renameAlbum` copies MinIO
objects to a new prefix, so a stored path would go stale on every rename while a
filename survives it.

**Schema:**

```sql
ALTER TABLE albums ADD COLUMN cover VARCHAR(255) NULL AFTER counter;
```

**How it is set:**
- Bulk upload (`temporalUploads.js`): in the same `state === 'complete'` block (with
  `successful > 0`) that recounts `counter`, `body.lastFile` has its extension swapped for `.webp` and is
  written via `setAlbumCoverIfEmpty()`. The "only if empty" test lives in the query's
  `WHERE cover IS NULL`, so concurrent uploads cannot race — the first one wins and
  later ones are no-ops.
- Backfill (`albums.js` `backfillCover`): an album with `counter > 0` but no `cover`
  gets one MinIO list of `<album>/thumbs/` on the next `GET /albums`, and the first
  object found is persisted (via `setAlbumCoverIfEmpty`). Because `counter` counts photos
  only, a video-only album is never backfilled. This is marked `ponytail:` and is **meant to be deleted**
  once every album has a cover — it is the one thing that reintroduces the N-list-calls
  cost that `counter` exists to avoid, and it does so exactly once per album (an album whose
  thumbs/ is empty or whose list fails is retried on every `GET /albums`).
- Manual pick (`PhotoLightbox.vue` "Set as Album Cover" → `AlbumViewer.vue` `setCover` →
  `PUT /album/:currentName` with `{ cover }`): the button is gated in the SPA by
  `delete_album` (admin only today, same as rename/edit); the route itself is
  `requireRole("admin")`. Any photo in the lightbox can be picked. The API swaps
  `.avif` for `.webp` and writes the column via `updateAlbumDescription`, which
  overwrites **unconditionally** — unlike `setAlbumCoverIfEmpty`, a manual pick is not
  a one-time-only write, and a later pick (or a re-upload racing `setAlbumCoverIfEmpty`
  before the manual pick lands) can change it again.

**Presigning:** 1-hour expiry; use `publicMinioClient`, not `minioClient` — same rule as everywhere
else that hands a URL to a browser. Presigning is local HMAC with no network call, so
doing it once per album in `GET /albums` is cheap.

**Known gap:** deleting the photo that is an album's cover leaves `cover` pointing at a
missing object. `AlbumCard.vue` degrades quietly (the `@error` handler falls back to a
neutral placeholder), so nothing breaks visibly, but the album keeps no cover until
something resets it. `deleteObjects` does not currently null the column.

---

## Private Albums (`albums.is_private`)

`albums.is_private` (`TINYINT(1) NOT NULL DEFAULT 1`) hides an album from
unauthenticated visitors. Default is **private** — a newly created album (or an
existing album right after the column was added) is invisible to anonymous users
until someone explicitly makes it public.

**Enforcement is at the pv-api layer, gated by `authenticateOptional`**
(`middleware/authMW.js` — parses the bearer token if present and sets `req.user`,
but never rejects a request for having no token, unlike `authenticateToken`; an invalid
token is also treated as anonymous):
- `GET /albums`: private albums are filtered out of the list entirely for anonymous
  requests (`req.user` unset).
- `GET /album/:name`, `GET /objects/:name`, `GET /albums/:name/object/:object`: an
  anonymous request against a private album gets the same 404 as a nonexistent
  album — an anonymous caller cannot distinguish "doesn't exist" from "exists but
  is private."
- The gate is "any authenticated user," not admin-only — matches the existing
  Statistics feature's gating. Toggling privacy itself is admin-only
  (`requireRole("admin")` on `PUT /album/:currentName` with `{ isPrivate }`; the Edit Album
  dialog has a "Private" checkbox, and `CreateAlbumDialog` sets it at creation).
- `AlbumCard.vue` shows a small lock icon before the name of a private album (only
  visible to logged-in users, since anonymous requests never receive private albums).

**Known limitation:** this blocks *discovery* through pv-api only. A presigned
MinIO URL already handed to a browser (`coverThumbnailUrl`, `thumbnailUrl`,
`presignedUrl` from a prior `GET /objects/:name` response) remains valid for its
full 1-hour signature window regardless of a later privacy change — presigned URLs
are signed independently of pv-api and MinIO has no way to revoke one early. Making
an album private stops new anonymous requests from finding it; it does not revoke
URLs already issued. Fully closing that gap would mean proxying all media through
pv-api instead of presigned MinIO URLs — out of scope here.

---

## Album Grid (`AlbumCard.vue` / `Albums.vue`)

Redesigned 2026-08-28 from centred icon-tiles to a cover-led grid.

**Card anatomy:** a 4:3 cover (`aspect-[4/3]`, `rounded-lg`, `object-cover`) with the
caption beneath — name on one truncated line (with the lock icon for private albums),
then a single metadata line
(`36 photos · May 2026`, built by `AlbumCard.vue`'s `metaLine` from `fileCount` — `Empty`
when 0 — plus a
`month`/`year` date segment; a missing month or year just drops out, so an album with a
year only still reads `36 photos · 2026`). There is no card border, no shadow and no `lastModified` on the
card face; the modified date remains available through the `modified-desc` /
`modified-asc` sort options. Long album names
truncate rather than wrap — that is what keeps grid rows the same height.

**Three cover states**, in `AlbumCard.vue`: the presigned photo; a dashed "No photos
yet" block when `fileCount` is 0; a neutral `fa-images` glyph when a cover URL exists
but 404s (`coverFailed`).

**Toolbar:** an `Albums` heading with a live count (`summaryLine`, which counts what
the year filter is actually showing), then one year `<select>`, one sort `<select>`
(six options — chronological album date (default), last-modified, and name — replacing
four buttons), an icon-only refresh, an icon-only cloud-download button (admin, opens
`OneDriveImportDialog`; see OneDrive Import), and "New album". On phone "New album" is an
icon-only `+` button beside the heading; from `sm` up it is the labelled button. The year
select hides until an album has a year, and both selects hide while loading or on error.

The whole toolbar is `sticky top-16 z-20` — pinned directly under the 64px `AppHeader`
(`z-30`) so the year/sort selects stay reachable while the grid scrolls, the same pattern
`AlbumHeader.vue` uses (`top-16`). It carries an opaque `bg-gray-50` plus a `border-b` so
cards scroll *behind* it rather than through it, and `-mx-4 px-4` widens that background
across the container's own padding so nothing shows through beside the controls. Sticky
works because no ancestor sets `overflow` (`#app` and `body` are clean); the only
`overflow: hidden` in the app is the `.sr-only` utility.

**Scrolling:** the grid is infinite-scroll, not paginated (it used to render a
`Math.ceil(len / 24)` page window with prev/next buttons). `visibleAlbums` is a
`slice(0, visibleCount)` of `sortedAlbums` — a window that only grows — and a sentinel
`<div ref="scrollTrigger">` at the end of the grid drives `loadMore()` through an
`IntersectionObserver` (`rootMargin: '200px'`). All albums are still fetched in the one
`GET /albums` call, so growing the window never hits the network. There is deliberately
**no** "Showing X of Y" footer.

Two constraints on the sentinel, and the second one is the one that actually bit:

1. It uses `v-show`, not `v-if` — `v-if` would destroy and recreate the element per
   batch and break the observer's DOM reference. (`v-show` does not, however, protect
   against an *ancestor* `v-if` unmounting the sentinel.)
2. **The observer must be attached after the data lands, not from `onMounted`.** On
   first paint `sortedAlbums` is empty (the fetch has not resolved), so `hasMoreAlbums`
   is false and the `v-show` sentinel is `display: none`. A `display: none` element has
   **zero geometry** — an observer attached then records `isIntersecting = false`
   forever, because `IntersectionObserver` re-evaluates on scroll, resize, or a layout
   change inside a tracked root, **not** on a style change. When the albums arrived and
   the sentinel became visible, nothing re-fired and the grid stuck at the first 24.
   The symptom is silent: no console error, and it reproduces identically on every
   engine, which makes it look like an `IntersectionObserver` support problem when it
   is not.

`Albums.vue` therefore re-attaches from `watch([loading, hasMoreAlbums])` behind
`await nextTick()` — the `nextTick` is load-bearing, since without it the observer binds
before `v-show` has flushed `display` to the DOM and the same bug returns. That watcher
also covers refresh, error-retry and create/edit/delete (all flip `loading`), plus the
year filter dropping the count below the window and back above it. `setupObserver()`
calls `teardownObserver()` first so a re-attach cannot leak a second observer.

Tradeoffs of dropping the page buttons: there is no longer any position indicator and no
way to jump to the end, and the DOM grows unbounded as batches append (acceptable at
`ITEMS_PER_PAGE: 24` for a personal gallery). Page state was never serialised to the URL
or a store, so nothing lost a deep-link, but "link to the middle of the list" is no longer
expressible.

**Responsive rules that matter:**
- Grid is `grid-cols-2 md:grid-cols-3 lg:grid-cols-4`. Two columns on phone is
  deliberate — with full-bleed 4:3 covers, one column is roughly one album per screen.
- Controls are `h-11` (44px) on phone and `sm:h-[34px]` on pointer devices. Do not let
  the phone size drop below 44px.
- Edit/delete exist **twice**: `hidden md:flex` hover buttons on the cover, and a
  `md:hidden` dots button in the caption that opens a `<Teleport>`ed bottom sheet.
  There is no hover on touch, so the hover buttons alone are unreachable there.

**Known gap:** the touch/pointer split is a width breakpoint (`md`), not a capability
test, so a touch tablet at ≥768px gets the hover-only buttons and cannot reach them.
The correct test is `@media (hover: hover)`, which needs a custom variant in
`tailwind.config.js` (Tailwind 3.4 has no built-in one). The bottom sheet also does not
lock body scroll.

**Unverified:** the action sheet's behaviour (teleport, scrim dismissal, the emit path
back to `openEditDialog` / `confirmDelete`) has been built and compiles, but has not
been exercised on a real touch device.



---

## Upload Monitoring, Cancel, and Failed Files

**Failed-file list.** `processBatchImages` and `processVideoUpload` keep `failedFiles: [{ filename, error }]` (error cut to 300 chars) in their progress state. It is returned by the `getProgress` query and forwarded by the `reportProgress` activity (image batches only), which pv-api stores as the persisted snapshot. It is exposed as `progress.failedFiles` by `GET /bulk/progress/:id` (persisted snapshot if one exists, otherwise the live query) and `GET /bulk/status/:id` (live query only). `BulkUploadJobs.vue` renders it. It fetches progress for running jobs every poll and for finished jobs once.

**Single video uploads.** `processVideoUpload` runs one `uploadVideoToMinIO` activity per file inside try/catch, so one failure no longer fails the workflow (it ends COMPLETED with `failed > 0`). It registers the same `getProgress` query. Workflow ids are `video-<uuid>`; `GET /bulk/jobs` lists both `batch-` and `video-` ids. A video job's `batchId` keeps the `video-` prefix, so the SPA's `batch-<id>` lookup 404s and falls back to the raw id. Changing the workflow code can break in-flight workflows (non-determinism); deploy when none are running.

**Stop upload.** `POST /bulk/cancel/:workflowId` (admin) terminates the workflow (not cancel: the image workflow catches per-file errors, so a cancellation would count as a failed file and the loop would continue). The id must match `^(batch|video)-<uuid>$` because the API then removes the NFS staging dir (`<nfs>/<batchId>` for images, `<nfs>/video-<uuid>` for videos), which a terminated workflow's own `cleanupBatch` never does. The file being processed may finish. The final `reportProgress` never runs, so the album is not recounted and the cover is not set for that batch (files already converted stay in MinIO; the counter catches up at the next upload or delete).

**OneDrive visibility and resume** (extends the OneDrive section). The dialog has a **Private album** checkbox (default on) that is passed to `POST /album/:name` as `isPrivate`. A 409 from album creation shows a "Resume import" button, which skips creation and calls `POST /onedrive/import { path, albumName, resume: true }`. With `resume`, pv-api lists `<album>/` in MinIO (non-recursive) and drops OneDrive files whose result exists: `<name>.avif` for images, `<name>` for videos. The response carries `skipped`; with nothing left it returns 200 with `imageCount: 0` and no `batchId`. Granularity is per file; rclone restarts a partly downloaded file. Resume does not change `is_private`. The router receives `minioClient` (`oneDriveRoutes(getTemporalClient, config, minioClient)`).
