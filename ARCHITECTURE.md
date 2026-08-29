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

## Physical / infrastructure topology

> Observed from the live cluster, Aug 2026. `kubectl get nodes -o wide` +
> `kubectl get pods -n pv -o wide`.

### Physical host map

```
                   ┌──────────────────────────────────────────────┐
                   │           LAN 192.168.1.0/24                │
                   │                                              │
   ┌────────────┐  │  ┌──────────────────────────────────────┐   │
   │   mjolnir  │  │  │  K3s cluster (k3s, namespace `pv`)   │   │
   │   .8       │◄─┼──┤  control-plane: k3sm-pi .15 (Pi, etcd)│  │
   │ Ubuntu 26.04│ │  │  workers:                              │  │
   │  ─ MinIO   │  │  │    k3sa.hugin .120   k3sa.frigg .123  │   │
   │    :9000   │  │  │    k3sa.hela  .121*  k3sa.munin .125  │   │
   │  ─ MariaDB │  │  │    k3sa.freki .122   k3sa.idunn .126  │   │
   │    :3306   │  │  │    k3sa.wahl  .124   k3sa.wikke .127  │   │
   │  ─ NFS     │  │  │    thinkpad  .44                      │   │
   │    /nfs-storage┘  │    *hela NotReady/SchedulingDisabled │   │
   └────────────┘      └──────────────────────────────────────┘   │
                       └──────────────────────────────────────────┘

   Pod placement (pv namespace):
     k3sa.freki.001 ── pv-api
     k3sa.frigg.001 ── pv-metadata
     k3sa.wikke.001 ── pv-spa + pv-worker
     thinkpad       ── pv-avif-converter  (nodeAffinity)
```

### Hosts

| Host | Role | IP | OS / K3s | Notes |
|---|---|---|---|---|
| `k3sm-pi` | Control-plane (etcd, master) | 192.168.1.15 | Ubuntu 25.04 / v1.34.5+k3s1 | Raspberry Pi |
| `k3sa.hugin.001` | Worker | 192.168.1.120 | Ubuntu 24.04 / v1.34.3+k3s1 | |
| `k3sa.hela.001` | Worker | 192.168.1.121 | Ubuntu 24.04 / v1.35.5+k3s1 | **NotReady, SchedulingDisabled** |
| `k3sa.freki.001` | Worker | 192.168.1.122 | Ubuntu 24.04 / v1.34.3+k3s1 | runs `pv-api` |
| `k3sa.frigg.001` | Worker | 192.168.1.123 | Ubuntu 24.04 / v1.34.3+k3s1 | runs `pv-metadata` |
| `k3sa.wahl.001` | Worker | 192.168.1.124 | Ubuntu 24.04 / v1.34.6+k3s1 | |
| `k3sa.munin.001` | Worker | 192.168.1.125 | Ubuntu 24.04 / v1.34.3+k3s1 | |
| `k3sa.idunn.001` | Worker | 192.168.1.126 | Ubuntu 24.04 / v1.34.3+k3s1 | |
| `k3sa.wikke.001` | Worker | 192.168.1.127 | Ubuntu 24.04 / v1.34.6+k3s1 | runs `pv-spa` + `pv-worker` |
| `thinkpad` | Worker | 192.168.1.44 | Ubuntu 24.04 / v1.34.6+k3s1 | runs `pv-avif-converter` |
| `mjolnir` | Storage server (outside cluster) | 192.168.1.8 | Ubuntu 26.04 | MinIO, MariaDB, NFS |

> Note: CLAUDE.md still says the converter runs on `ubumac`; the manifests were
> updated to pin it to **`thinkpad`** via nodeAffinity (`kubernetes.io/hostname
> = thinkpad`) + the `dedicated=avif-converter` toleration. A stale `ubumac`
> (192.168.1.10) hostAlias remains in the pv-api deployment.

### Pod placement (pv namespace)

| Pod | Node | Pod IP |
|---|---|---|
| `pv-api-*` | k3sa.freki.001 | 10.42.15.40 |
| `pv-avif-converter-*` | thinkpad | 10.42.2.231 |
| `pv-metadata-*` | k3sa.frigg.001 | 10.42.18.132 |
| `pv-spa-*` | k3sa.wikke.001 | 10.42.5.60 |
| `pv-worker-*` | k3sa.wikke.001 | 10.42.5.58 |

### Networking highlights

- `pv-api` and `pv-spa` are **MetalLB LoadBalancers**: `pv-api-service`
  → 192.168.1.205:80, `pv-spa-service` → 192.168.1.206:80. Public exposure is
  via Cloudflare Tunnel / proxy (see Public Endpoints above).
- `mjolnir` is reached **by IP + hostAlias** (`mjolnir` → 192.168.1.8) — it is
  not cluster DNS. The converter/metadata deployments hardcode
  `MINIO_ENDPOINT=192.168.1.8:9000`.
- The Temporal server lives in a separate `temporal` namespace (not listed in
  the pv-node scan); `pv-api`/`pv-worker` reach it via
  `temporal-frontend.temporal.svc.cluster.local:7233`.

### mjolnir — disk server profile

`mjolnir` is the single storage workhorse of the platform: it hosts **MinIO**
(the photo store), **MariaDB** (PhotoVault's users/albums DB), and the **NFS
server** (upload staging + VM disks for the K3s nodes) — all on one box. It is
a single point of failure for all of these.

> MariaDB databases confirmed on mjolnir: **`photovault`** (`albums` + `users`
> — PhotoVault's store), plus `guacamole_db` and `harp_db` for other apps.
> pv-api reaches this server through the cluster DNS name
> `mariadb-service.data.svc.cluster.local` (namespace `data`), which is a
> Service that forwards to `mjolnir:3306`.

> Observed via read-only SSH, Aug 2026. No destructive commands run.

| Aspect | Detail |
|---|---|
| Hostname / OS | `mjolnir`, Ubuntu 26.04 LTS, kernel 7.0.0-30-generic |
| CPU / RAM | AMD A6-5200 APU (4 cores) · 7.2 GiB RAM (~5.2 GiB available at check) |
| Network | LAN `192.168.1.8/24` (`enp3s0`) · Tailscale `100.116.2.9` · SSH port 22 |
| Management | SSH as `lucarv` (see `~/.ssh/config` `Host mjolnir`) · **UFW inactive** |

**Storage layout** (plain ext4 — no ZFS, no mdadm RAID):

| Disk | Size | Filesystem / mount | Usage |
|---|---|---|---|
| `sda1` | 1.8 TB | ext4 → `/mnt/storage` | ~27 GB used / 1.7 TB free — big data disk |
| `sdb2` | 931 GB | ext4 → `/` (root) | **839 GB / 916 GB used — 97% full, 31 GB free** |
| `sdb1` | 512 MB | vfat → `/boot/efi` | boot |
| `sdc` | 0 B | — | empty slot |
| `sdd1` | 465 GB | ext4 → *(unmounted)* | spare, not in use |

- `/mnt/storage` holds `onedrive-kat` (17G), `slask/` (138M — the PhotoVault
  upload staging share, see below), `iot/`, `media-backups/`, `pve-backups/`.
- The K3s VM disks live under `/var/lib/pve-disks/images/` (VMIDs 100–107) —
  the likely cause of the root disk being 97% full (exact breakdown not
  enumerated; full-disk scans time out on this box).

**PhotoVault-relevant services** (native systemd units, not containers):

| Service | Version / data | Port | Notes |
|---|---|---|---|
| `minio.service` | MinIO, volumes `/var/lib/minio` | **9000** (S3), **9001** (console) | Runs as `minio-user`; env in `/etc/default/minio` (contains root credentials — keep secret) |
| `mariadb.service` | MariaDB 11.8.6, data `/var/lib/mysql` (151M) | **3306** (all interfaces) | **PhotoVault's user/album store** (DB `photovault`), plus `guacamole_db`, `harp_db` |
| NFS (`nfs-server` stack) | `/etc/exports` | 2049/111 (+SMB 139/445) | Export `/mnt/storage/slask` → cluster staging |

MinIO buckets: **`photovault`** (11 GB — the PhotoVault store), `temporal`
(2.9M — Temporal persistence), plus unrelated buckets (`blotpix`, `harp`,
`sleeves`, `audio`, `slask`, `lucarv@mjolnir`).

**NFS staging path (how it maps to the cluster):**
`k8s/base/pv-api/nfs-slask-pv.yaml` → PV `nfs-slask-pv` = `mjolnir:/mnt/storage/slask/pv`
(1000Gi, ReadWriteMany, Retain) → PVC `nfs-pv-claim` → mounted at `/nfs-storage`
in pv-api/pv-worker/pv-converter. The upload `slask` = "scratch".

**Other services on the box (not PhotoVault):** Docker `local-registry`
(`registry:2` on :5000 — LAN image mirror), PostgreSQL 18 (5432), xrdp (3389),
SMTP (25), plus the NFS/SMB shares listed above.

**Backups / resilience:**

- **No PhotoVault backup jobs found**: lucarv's crontab has only `trash-empty 30`;
  no restic/borg/rclone configs; systemd timers are all stock OS timers. Root's
  crontab was not readable without sudo.
- mjolnir is itself the backup **destination** for other machines
  (`/mnt/storage/media-backups`, `/mnt/storage/pve-backups` exports).
- **Single point of failure**: MinIO + MariaDB + NFS staging (and the K3s VM
  disks) all share one physical box with one 1.8 TB data disk, no RAID, no
  off-box backup for PhotoVault data.

**Operational risks flagged (worth addressing):**

1. **Root disk at 97%** — MinIO (`/var/lib/minio`) and MariaDB (`/var/lib/mysql`,
   including the `photovault` DB) both live on the root disk. PhotoVault growth
   will start failing (converter/metadata writes) once it fills.
2. **No redundancy** — no RAID/ZFS and no off-box backup for PhotoVault data;
   losing the single disk loses photos, albums, and users.
3. **Compute + storage colocated** — the K3s VM disks live on the same host, so a
   mjolnir outage takes down both the cluster nodes and their backing storage.
4. **No firewall** (UFW inactive) — MinIO console (:9001), MariaDB (:3306) and
   SMB (:445) are exposed on the LAN (they are not exposed publicly).

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

