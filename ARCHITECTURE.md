# PhotoVault (pv) — High-Level Architecture

> A Kubernetes-native, self-hosted photo gallery platform. It ingests JPEG/HEIC
> photos and videos, transcodes them to AVIF (with WebP thumbnails), extracts
> EXIF + GPS metadata, organizes everything into albums, and serves them back to
> a browser or mobile (Capacitor) client. It runs on a private K3s cluster and is
> exposed publicly through Cloudflare Tunnels.

## Component inventory

| Component | Stack | Role |
|---|---|---|
| **`pv-spa/`** | Vue 3 / Vite / Tailwind, nginx | Frontend SPA (single page, no router lib — view state in `App.vue`) |
| **`pv-api/`** | Node.js / Express 5 (CommonJS) | REST API — the **only entry point** for clients; JWT auth, album CRUD, upload acceptance, progress polling |
| **`pv-temporal-worker/`** | TypeScript / Temporal SDK | Async orchestration — runs Temporal workflows & activities |
| **`pv-converter/`** | Python 3.11 / FastAPI | AVIF conversion (via `avifenc`/`heif-enc` binaries) + WebP thumbnail generation; writes directly to MinIO |
| **`pv-metadata/`** | Python 3.11 / FastAPI | EXIF extraction, reverse geocoding (Mapbox), album index JSON writer; writes directly to MinIO |
| **`pv_bulk_upload/`** | Node.js CLI | **Legacy/broken** — points at removed endpoints; needs repointing or deletion (per CLAUDE.md) |
| **`k8s/`** | YAML | Consolidated per-service manifests (namespace `pv`) |
| Backing services | — | MinIO (S3), MariaDB, Temporal server, NFS mount |

## The core architectural principle

> **All uploads go through Temporal. There is no synchronous upload path.**

`pv-api` never processes media itself. It is a *front door* that stages files and
delegates. This split keeps the tiny 512Mi API pod free of CPU-heavy transcoding
and EXIF parsing.

## System diagram

```
┌─────────┐   HTTPS    ┌───────────┐        ┌──────────────┐
│ Browser │ ────────► │  pv-api   │ ─────► │   Temporal   │
│ (pv-spa)│ ◄──────── │ (Express) │  gRPC  │    server    │
└─────────┘   poll    └─────┬─────┘        └──────┬───────┘
       ▲                    │ 1. stage to NFS     │
       │                    │ 2. return 202       ▼
       │                ┌───┴───┐        ┌─────────────────┐
       │                │  NFS  │ ◄───── │ pv-temporal-    │
       │                └───────┘        │ worker (1 conc) │
       │                                 └──┬────┬────┬────┘
       │      POST /bulk/progress           │    │    │
       │ ◄──────────────────────────────────┘    │    │
       │                                         ▼    ▼
       │                        ┌────────────┐ ┌──────────┐
       │                        │ pv-converter│ │ pv-metadata│
       │                        │ (AVIF+thumb)│ │ (EXIF+geo) │
       │                        └─────┬──────┘ └────┬─────┘
       │                              │   write     │ write
       │                              ▼             ▼
       │                          ┌────────────────────┐
       │                          │   MinIO (S3)       │
       │  ── presigned URLs ────► │  bucket photovault │
       └─────────────────────────►│  + MariaDB (users, │
                                  │  albums, counters) │
                                  └────────────────────┘
```

### Image upload flow (the interesting path)

1. Browser → `POST /bulk/upload/:folder` (multipart, multer in-memory)
2. `pv-api` responds **202 with a batchId immediately**, then in the background
   writes the files to `/nfs-storage/<batchId>` and starts the Temporal workflow
   `processBatchImages` (workflowId `batch-<batchId>`).
3. The worker processes images **sequentially**
   (`maxConcurrentActivityTaskExecutions: 1` — a deliberate guard for the 1 GiB
   RAM limit). Per image it calls two activities in parallel:
   - `convertImage` → `POST pv-converter /convert` → produces AVIF
     (`<album>/<name>.avif`) + 400px WebP thumbnail
     (`<album>/thumbs/<name>.webp`), both written to MinIO by the converter.
   - `extractAndPersistMetadata` → `POST pv-metadata /extract` → EXIF + GPS +
     Mapbox reverse-geocoding; metadata is **upserted into the album index file**
     `<album>/<album>.json` in MinIO.
4. After each image, the worker calls `reportProgress` → `POST pv-api
   /bulk/progress`, which persists progress in-memory (`sse-service.js`). A final
   `reportProgress` with `state: 'complete'` is what increments the album photo
   counter in MariaDB.
5. The SPA **polls** `GET /bulk/progress/:workflowId` (Temporal query) / persisted
   store — no SSE streaming.
6. `cleanupBatch` removes the NFS staging dir, regardless of per-image failures.

### Video upload flow

Same shape but lighter: `POST /video/upload/:folder` (admin-only, disk-staged) →
`processVideoUpload` workflow → `uploadVideoToMinIO` activity streams straight
from NFS to MinIO → cleanup. No transcoding, no metadata.

### Browsing/serving path

- `GET /albums` (counts served from the MariaDB `albums.counter` cache to avoid N
  MinIO list calls), `GET /objects/:name` (presigned MinIO URLs), `GET /stats`.
- Presigned URLs are signed with a **separate `publicMinioClient`** using the
  public hostname `objects.ekskog.net` (SigV4 includes Host in the HMAC, so the
  internal client can't be used for browser URLs).
- Thumbnails load first in the grid, with silent fallback to full-res on error
  and prefetch of full-res for the lightbox.

## Communication patterns summary

- **pv-spa → pv-api**: REST + JWT (Bearer), CORS allowlist (`photos.ekskog.me`,
  localhost, Capacitor origins)
- **pv-api → Temporal**: gRPC (starts workflows); **pv-api → MinIO**: S3 API
  (list/presign)
- **pv-temporal-worker → pv-converter / pv-metadata**: HTTP POST with
  retries/timeouts
- **pv-converter / pv-metadata → MinIO**: direct S3 writes (worker never proxies
  object bytes)
- **pv-temporal-worker → pv-api**: `POST /bulk/progress` (fire-and-forget with
  backoff; never throws to break the workflow)

## State & storage

- **MinIO** = source of truth for photos, thumbnails, and per-album metadata JSON
  index
- **MariaDB** = users, albums (name/path/description/year/month/counter) — a thin
  relational cache over MinIO
- **Temporal** = durable workflow state (progress query handlers), NFS =
  transient upload staging
- **In-memory progress store** in pv-api — lost on pod restart, though the
  worker's POSTs are retried

## Deployment & CI/CD

- All services are single-replica Deployments in the `pv` namespace;
  `pv-converter` runs on a dedicated node (`ubumac`, tainted) with up to 4 GiB
  for encoding.
- GitHub Actions (`monorepo-ci.yml`) on push to `main`: per-service matrix
  detects changed paths, builds → pushes to GHCR (`ghcr.io/xkogd66/<service>:<sha>`),
  applies manifests, updates the image, waits for rollout. The worker also
  rebuilds when `pv-api` changes (shared types dependency).
- Secrets in K8s `pv-api-secret`; non-sensitive config in per-service ConfigMaps;
  SPA runtime config injected via an entrypoint that writes a no-store
  `env-config.js`.

## Notable architecture observations / rough edges

- **No tests anywhere** — verification is integration testing against the live
  cluster (documented policy).
- `pv_bulk_upload` is dead code targeting removed endpoints.
- The album counter in MariaDB can drift on re-uploads (silent MinIO overwrites
  still increment), with a manual audit/fix script as mitigation.
- There's a documented history of the workflow forgetting the final
  `reportProgress` (fixed), which shows how carefully the counter/progress
  coupling is maintained.
- `sse-service.js` still exists but SSE was replaced by polling.

