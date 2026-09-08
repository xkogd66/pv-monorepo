# PhotoVault Monorepo — CLAUDE.md

## Project Overview

**PhotoVault (pv)** is a Kubernetes-native photo gallery and storage platform. It handles photo uploads, HEIC/JPEG to AVIF conversion, EXIF metadata extraction, location-based tagging, and album management. All services run in a self-hosted K3s cluster.

---

## Cluster Access

Never run `kubectl` (or any other command that reads/touches the live K3s cluster) yourself. Always print the exact command and ask the user to run it and paste back the output. This applies to read-only commands (`kubectl get`, `describe`, `logs`) as well as mutating ones.

---

## Visual Verification

Do not attempt to visually verify UI changes yourself (screenshots, headless browser driving, etc.), and do not run build or dev-server commands (`npm run build`, `npm run dev`, `vite build`, etc.) to self-verify either. Make the code change, then explicitly ask the user to build/run/check it themselves (dev server or real environment). Do not claim a UI change "looks correct" or "works" based on your own screenshot or build output — you cannot see, and simulated verification is not a substitute for a human actually checking it.

---

## Explain Reasoning

Always explain the reasoning behind a change before or alongside making it — not just what was edited, but what problem it solves, why this approach over alternatives, and any capability or behavior being traded away (especially when removing/replacing existing functionality). Don't let a removed capability surface later as a bug report — flag it up front.

---

## Repository Structure

| Directory | Role | Language/Framework |
|---|---|---|
| `pv-api/` | Backend REST API | Node.js / Express 5.x |
| `pv-spa/` | Web frontend | Vue 3 / Vite / Tailwind |
| `pv-converter/` | AVIF image conversion service | Python 3.11 / FastAPI |
| `pv-metadata/` | EXIF extraction + album index writer (MinIO) | Python 3.11 / FastAPI |
| `pv-temporal-worker/` | Async batch processing worker | TypeScript / Temporal SDK |
| `pv_bulk_upload/` | CLI bulk upload tool — **currently broken**, see below | Node.js |
| `k8s/` | Kubernetes manifests | YAML (base configs per service) |
| `tools/` | Utility scripts | — |

`pv_bulk_upload` targets `POST /buckets/:bucket/upload` and the `/processing-status/:jobId`
SSE stream, both of which were removed with the legacy upload path. It needs to be
repointed at `POST /bulk/upload/:folder` or deleted.

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
| GET | `/bulk/status/:workflowId` | Poll bulk workflow status |
| GET | `/bulk/progress/:workflowId` | Poll bulk workflow progress |
| POST | `/bulk/progress` | Progress callback from the worker |
| GET | `/health` | Health check |
| GET | `/stats` | Storage and photo statistics |

---

## Upload Flow (Temporal — the only path)

1. Browser → `POST /bulk/upload/:folder` → 202 + batchId
2. Files staged to `/nfs-storage/<batchId>`
3. Temporal workflow `processBatchImages` started
4. pv-temporal-worker processes sequentially (1 concurrent; 1 GB RAM limit), calling
   pv-metadata then pv-converter per image
5. Worker POSTs progress to `/bulk/progress`; the SPA polls `GET /bulk/progress/:workflowId`

Videos follow the same shape via `POST /video/upload/:folder` → `processVideoUpload`.

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

## SPA Layout

`App.vue` `<main>` uses `px-2 sm:px-4 py-4 sm:py-6` — minimal horizontal padding, no `max-w` constraint. Individual views that need centering (e.g. `Albums.vue`) apply their own `max-w-[1200px] mx-auto`. Do not add a global `max-w` back to `App.vue` — it causes excessive whitespace in the photo grid.

## Landing Page (`Home.vue`)

Shown only when the visitor is unauthenticated — `App.vue` routes to `home` on load/logout when `!isAuthenticated`, otherwise straight to `albums`.

- Hero fetches `apiService.getAlbums()` on mount and uses each album's `coverThumbnailUrl` (already presigned server-side, no per-album `getAlbumContents` calls needed) as a background collage. Falls back silently to a plain gradient if the fetch fails or no albums have a cover yet — no error shown to the visitor.
- The single CTA, **"Browse Galleries"**, emits `navigate('albums')`. This is not decorative — `GET /albums` and `GET /objects/:name` require no auth, and this button is the *only* path an anonymous visitor has into `Albums.vue`. Do not remove it (or the `@navigate="handleNavigation"` listener on `<Home>` in `App.vue`) without replacing it with another way to browse anonymously.
- Login/Register are deliberately **not** on this page — they live only in `AppHeader.vue` (top nav / user menu), which already wires them to the same `handleLoginTrigger`/`handleRegisterTrigger` in `App.vue`. Keep auth entry points low-key here; this was a deliberate call, not an oversight.

## Statistics (`AppHeader.vue`)

Gallery statistics (`BucketStats.vue`) live in the top nav, not on the landing page. Gated on `isAuthenticated` (any logged-in user, not just admins) — a "Statistics" button in the desktop nav toggles a popover anchored to it (same pattern as the health-status dot), and the mobile menu gets an inline expand/collapse toggle instead (popovers don't work well on mobile). `BucketStats.vue` is self-contained and fetches its own data — no props needed beyond the existing `noBorder` styling flag.

## Photo Grid (`PhotoGrid.vue`)

- Renders a slice of the full photo array (`itemsPerPage: 24` default); all photos are fetched at once from the API.
- Infinite scroll via `IntersectionObserver` on a sentinel `<div ref="scrollTrigger">` at the bottom. The sentinel uses `v-show` (not `v-if`) — `v-if` would destroy and recreate the element on each batch load, breaking the observer's DOM reference.
- `rootMargin: '200px'` on the observer pre-triggers the next batch before the user reaches the bottom.
- No extra network requests on scroll — `loadMore()` is a synchronous `Array.slice`.

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

## Thumbnails

Thumbnails are pre-generated WebP files stored at `<album>/thumbs/<filename>.webp` in the `photovault` MinIO bucket. They are 400px wide, WebP quality 75.

**How thumbnails are created:**
- **New uploads**: `pv-converter` generates the WebP thumbnail from the source image (JPEG/HEIC) using Pillow (`ImageOps.exif_transpose()` is applied first to correct EXIF orientation before resizing) before freeing source bytes, then uploads it to `<album>/thumbs/<filename>.webp`. Every upload goes through pv-converter.
- **Existing images**: there is no backfill script any more. `tools/generate-thumbs.js` was
  removed once pv-converter started generating thumbnails on every upload. If a backfill is
  ever needed again, recover it from git history rather than rewriting it.

**How thumbnails are served:**
- `pv-api` `getPhotos` generates a presigned URL for `<album>/thumbs/<filename>.webp` and returns it as `thumbnailUrl`.
- `PhotoCard.vue` loads `thumbnailUrl` for the grid. On error (thumbnail missing), it silently falls back to the full-res presigned URL without showing an error to the user. On successful thumbnail load, it prefetches the full-res URL so the lightbox opens instantly.
- Thumbnails are deleted alongside their parent AVIF when a photo is deleted (`albums.js` `deleteObjects`).


---

## Album Year Metadata (`albums.year` / `albums.month`)

Albums carry an optional **year** and **month** that describe the album's content
(e.g. "summer 2025 photos"), stored as `INT` columns in the `albums` table. They are
**album metadata**, not `created_at` (when the album was created) and not `updated_at`
(last upload).

**How they are set:**
- Created: `CreateAlbumDialog` (SPA) → `POST /album/:folderPath` with optional `month`/`year`.
- Edited after creation: **Edit Album** dialog (`Albums.vue`, pencil button on `AlbumCard`) → `PUT /album/:currentName`.

**How they are exposed:**
- `GET /albums` returns `year` and `month` per album (nullable). `getAllAlbums()` in
  `pv-api/src/services/database-service.js` selects the columns; `getAlbums()` in
  `pv-api/src/routes/albums.js` passes them through.

**SPA year filter (`Albums.vue`):**
- A "Year:" dropdown filters the grid to albums whose `year` matches the selection.
  Options are the distinct non-null years across all albums, sorted most-recent-first.
- Albums with `year = NULL` appear only under "All years".
- The pipeline is `filteredAlbums` → `sortedAlbums` → `paginatedAlbums`; sorting and
  pagination compose with the filter. Selecting a year resets to page 1.
- An empty year-filter result shows "No Albums in {year}" instead of the generic empty state.
- `AlbumCard.vue` renders a small year badge next to the photo count when `album.year` is set.

**`PUT /album/:currentName` (admin) — update semantics:**
Accepts `newName`, `description`, `month`, `year` in the body. Behavior depends on the name:
- **Name unchanged** (or omitted) → metadata-only update of `description`/`month`/`year`
  in MariaDB; no MinIO movement.
- **Name changed** → full rename: MinIO objects are copied to the new path, the album
  metadata JSON (`<folder>/<folder>.json`) is rewritten, and `name`/`path` plus any edited
  `description`/`month`/`year` are persisted in the DB. Old objects are deleted only after
  the copy and DB update succeed.
- `month`/`year` are coerced to integers (or `NULL` when cleared). Fields not sent fall back
  to existing values, so callers can send just `{ newName }` (old rename behavior) or just
  metadata changes.

---

## Album Counter (`albums.counter`)

The `albums.counter` column in MariaDB caches the photo count per album and is used by `GET /albums` to avoid N MinIO list calls.

**How it is maintained:**
- Bulk upload (`temporalUploads.js`): incremented when a `reportProgress` POST arrives with `state === 'complete'`. This is the only place the counter is incremented.
- Delete (`albums.js`): decremented by 1 per deleted object.

**Known limitation:** Re-uploading the same files overwrites the MinIO objects silently but still increments the counter, causing drift. If counters look wrong, run the audit+fix script (counts actual `.avif/.jpg/.mp4` objects in MinIO per album prefix and resets the DB counter to match).

**Root cause of past counter bug (fixed):** The Temporal workflow was setting `completedAt` after the image loop but never calling `reportProgress` with that final state. The API only increments the counter when `state === 'complete'`, so the counter was never updated for bulk uploads. Fixed in `image-batch-workflow.ts` by adding a final `reportProgress` call after `completedAt` is set.

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
- Bulk upload (`temporalUploads.js`): in the same `state === 'complete'` block that
  increments `counter`, `body.lastFile` has its extension swapped for `.webp` and is
  written via `setAlbumCoverIfEmpty()`. The "only if empty" test lives in the query's
  `WHERE cover IS NULL`, so concurrent uploads cannot race — the first one wins and
  later ones are no-ops.
- Backfill (`albums.js` `backfillCover`): an album with `counter > 0` but no `cover`
  gets one MinIO list of `<album>/thumbs/` on the next `GET /albums`, and the first
  object found is persisted. This is marked `ponytail:` and is **meant to be deleted**
  once every album has a cover — it is the one thing that reintroduces the N-list-calls
  cost that `counter` exists to avoid, and it does so exactly once per album.
- Manual pick (`PhotoLightbox.vue` → `AlbumViewer.vue` → `PUT /album/:currentName`
  with `{ cover }`): a user with the same permission as album rename/edit
  (`delete_album`) can pick any photo from the lightbox as the cover. The API swaps
  `.avif` for `.webp` and writes the column via `updateAlbumDescription`, which
  overwrites **unconditionally** — unlike `setAlbumCoverIfEmpty`, a manual pick is not
  a one-time-only write, and a later pick (or a re-upload racing `setAlbumCoverIfEmpty`
  before the manual pick lands) can change it again.

**Presigning:** use `publicMinioClient`, not `minioClient` — same rule as everywhere
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
but never rejects a request for having no token, unlike `authenticateToken`):
- `GET /albums`: private albums are filtered out of the list entirely for anonymous
  requests (`req.user` unset).
- `GET /album/:name`, `GET /objects/:name`, `GET /albums/:name/object/:object`: an
  anonymous request against a private album gets the same 404 as a nonexistent
  album — an anonymous caller cannot distinguish "doesn't exist" from "exists but
  is private."
- The gate is "any authenticated user," not admin-only — matches the existing
  Statistics feature's gating. Toggling privacy itself is admin-only (same
  `delete_album` permission as rename/edit, via `PUT /album/:currentName` with
  `{ isPrivate }`).

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
caption beneath — name on one truncated line, then a single metadata line
(`36 photos · 2026`). There is no card border, no shadow and no `lastModified` on the
card face; the modified date remains available through sorting. Long album names
truncate rather than wrap — that is what keeps grid rows the same height.

**Three cover states**, in `AlbumCard.vue`: the presigned photo; a dashed "No photos
yet" block when `fileCount` is 0; a neutral `fa-images` glyph when a cover URL exists
but 404s (`coverFailed`).

**Toolbar:** an `Albums` heading with a live count (`summaryLine`, which counts what
the year filter is actually showing), then one year `<select>`, one sort `<select>`
(four options, replacing four buttons), an icon-only refresh, and "New album".

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
