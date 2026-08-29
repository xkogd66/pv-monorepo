# mjolnir Remediation Plan

> **Goal:** fix the four operational findings from `ARCHITECTURE.md`
> ("mjolnir — disk server profile"): root disk at 97%, no backups, no
> redundancy, no firewall — without breaking the running PhotoVault platform
> or the other services mjolnir serves.
>
> **Who runs what:** everything below is run by **you**, from your own terminal
> (SSH to mjolnir for host work; `kubectl` from your workstation for cluster
> work). This file is the runbook.

## Golden rules

1. Keep a **second SSH session** to mjolnir open the whole time
   (`ssh lucarv@192.168.1.8`) — it is your safety line during the firewall step.
2. Phase 1.3 (MinIO move) needs a **short maintenance window** (uploads paused).
3. Every phase ends with a verification step; every phase has a rollback (see
   the bottom of this file).
4. When in doubt, stop and re-read the diagnose output — this plan makes no
   destructive change without you explicitly running it.

## Phase 0 — Pre-flight

```bash
# 0.1 Confirm sudo (you'll be prompted for your password)
sudo -v

# 0.2 Open a second session and leave it open:
#     ssh lucarv@192.168.1.8

# 0.3 Snapshot configs you may touch (rollback reference)
sudo mkdir -p /root/mjolnir-fix-backup
sudo cp -av /etc/default/minio /etc/fstab /etc/exports \
  /etc/systemd/system/minio.service /root/mjolnir-fix-backup/ 2>/dev/null
sudo cp -av /etc/mysql /root/mjolnir-fix-backup/ 2>/dev/null
sudo cp -av /etc/nfs.conf* /root/mjolnir-fix-backup/ 2>/dev/null

# 0.4 Baseline health + disk SMART (install smartmontools if missing)
systemctl status minio mariadb --no-pager | grep -E "●|Active"
df -h /
sudo smartctl -a /dev/sda | grep -Ei 'model|overall|reallocated|pending'   # 2T WD Green
sudo smartctl -a /dev/sdb | grep -Ei 'model|overall|reallocated|pending'   # 1T Seagate
sudo smartctl -a /dev/sdd | grep -Ei 'model|overall|reallocated|pending'   # 465G Hitachi
```

```bash
# 0.5 Confirm how the cluster reaches mjolnir's MariaDB (run from your workstation):
#     expect an ExternalName Service or Endpoints → 192.168.1.8:3306
kubectl -n data get svc mariadb-service -o yaml
```

## Phase 1 — Reclaim the root disk (97% full)

### 1.1 Diagnose (read before changing anything)

```bash
sudo du -x -h --max-depth=1 / 2>/dev/null | sort -rh | head -15
sudo du -x -h --max-depth=1 /var/lib 2>/dev/null | sort -rh | head -15
sudo find / -xdev -type f -size +1G -printf '%10s %p\n' 2>/dev/null | sort -rn | head -25
sudo exportfs -v | head -40          # reconcile live NFS exports (incl. /mnt/external/2t)
df -hT /mnt/external/2t 2>/dev/null  # is there an external 2T mount we haven't seen?
```

These can take a couple of minutes on spinning disks. The likely big consumers:
`/var/lib/pve-disks` (VM disks), `/var/lib/postgres`, `/var/lib/docker`,
`/var/lib/minio` (11G), `/home/lucarv`.

### 1.2 Quick safe cleanups

```bash
# systemd journal → cap at 200 MB
sudo journalctl --vacuum-size=200M

# apt cache + orphaned deps
sudo apt-get clean
sudo apt-get autoremove --purge -y

# old snap revisions (keep 2)
sudo snap set system refresh.retain=2
snap list --all          # look for rows marked 'disabled'
# sudo snap remove chromium --revision=3499   # one line per disabled revision

# old kernels — never purge the running one
uname -r
dpkg --list 'linux-image-*' | grep '^ii'
# sudo apt-get purge --dry-run $(dpkg --list 'linux-image-*' | awk '/^ii/{print $2}' | grep -v "$(uname -r)")
```

### 1.3 Move MinIO data off root → bind-mount from `/mnt/storage`

**Why:** `/var/lib/minio` (11 GB, incl. the `photovault` bucket) sits on the
97%-full root disk while the 1.8 TB `/mnt/storage` (sda) is 97% empty. A bind
mount keeps MinIO's config, paths, and the existing NFS export unchanged.

```bash
# stop MinIO (short outage — pause uploads first)
sudo systemctl stop minio

# relocate the data dir (cross-filesystem copy + delete, ~11 GB)
sudo mv /var/lib/minio /mnt/storage/minio

# restore the empty mountpoint and bind-mount the new location
sudo mkdir -p /var/lib/minio
echo '/mnt/storage/minio /var/lib/minio none bind 0 0' | sudo tee -a /etc/fstab
sudo mount /var/lib/minio

# ownership was preserved by mv, but double-check
sudo chown -R minio-user:minio-user /mnt/storage/minio

# start and verify
sudo systemctl start minio
mc alias set mjolnir http://127.0.0.1:9000 \
  "$(sed -n 's/MINIO_ROOT_USER=//p' /etc/default/minio)" \
  "$(sed -n 's/MINIO_ROOT_PASSWORD=//p' /etc/default/minio)"
mc ls mjolnir/photovault | head
mc admin info mjolnir
```

If `mc admin info` complains, `curl -s http://127.0.0.1:9000/minio/health/live`
is sufficient.

### 1.4 Optional — move mjolnir's MariaDB data off root too

Only worth it for headroom (it is ~151 MB). Note: this MariaDB **is**
PhotoVault's DB — take the Phase 2.3 dump *before* moving its datadir.

```bash
sudo systemctl stop mariadb
sudo mv /var/lib/mysql /mnt/storage/mysql
sudo mkdir -p /var/lib/mysql
echo '/mnt/storage/mysql /var/lib/mysql none bind 0 0' | sudo tee -a /etc/fstab
sudo mount /var/lib/mysql
sudo chown -R mysql:mysql /mnt/storage/mysql
sudo systemctl start mariadb
sudo mariadb -e 'SELECT 1;'   # verify (root socket auth)
```

### 1.5 If `/var/lib/pve-disks` (or postgres/docker) is the real consumer

From 1.1 you'll know. The PVE VM disks (`/var/lib/pve-disks/images/`, VMIDs
100–107) are **live disks in use by a Proxmox cluster** — do **not** move them
by hand.

Recommended (hypervisor-level, separate project):

```bash
# On mjolnir: new export backed by the big disk
sudo mkdir -p /mnt/storage/pve-disks
echo '/mnt/storage/pve-disks 192.168.1.0/24(rw,async,no_subtree_check,no_root_squash)' | sudo tee -a /etc/exports
sudo exportfs -ra
```

```bash
# On the Proxmox node: add NFS storage → mjolnir:/mnt/storage/pve-disks,
# then migrate each VM's disk, then verify + delete the old copy:
qm move-disk <vmid> scsi0 <new-storage-name>
```

If VM disks are *not* the consumer, 1.2 + 1.3 typically free 30–50 GB and buy
plenty of time; revisit 1.5 when root usage creeps back.

### 1.6 Verify Phase 1

```bash
df -h /    # should be comfortably below 90%
# upload one photo through the SPA and confirm it lands in MinIO:
mc ls mjolnir/photovault | tail
```

## Phase 2 — Backups (currently none)

### 2.1 Mount the spare 465 GB disk (`sdd1`) as the backup target

After Phase 1, live data sits on sda and backups go on sdd → two different
physical disks (protects against single-disk loss, not whole-box loss — see 2.5).

```bash
# Inspect sdd1 first — spare or does it hold data?
sudo blkid /dev/sdd1
sudo mkdir -p /mnt/backup
sudo mount /dev/sdd1 /mnt/backup
sudo ls -la /mnt/backup    # if it has old data, keep it — do NOT format

# Persist by UUID
echo "UUID=$(sudo blkid -s UUID -o value /dev/sdd1) /mnt/backup ext4 defaults,noatime 0 2" \
  | sudo tee -a /etc/fstab
sudo mount -a
df -h /mnt/backup
```

> If Phase 0.4 showed the Hitachi is unhealthy, skip sdd and point the scripts
> below at `/mnt/storage` instead — noting that is same-disk-only protection.

### 2.2 MinIO bucket mirror (`mc` is already installed)

Script — **`/usr/local/sbin/backup-photovault-minio.sh`**:

```bash
#!/usr/bin/env bash
set -euo pipefail
# Credentials come from the MinIO env file
. /etc/default/minio
MC=/usr/local/bin/mc
SRC=/mnt/backup/photovault/minio/current
STAMP=$(date +%F)

$MC alias set mjolnir http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1

# 1) Daily exact mirror of the PhotoVault store + Temporal persistence
for bucket in photovault temporal; do
  $MC mirror --overwrite --remove "mjolnir/$bucket" "$SRC/$bucket"
done

# 2) Weekly deduplicated snapshot via hard links (space-free copy)
if [ "$(date +%u)" = "7" ]; then
  cp -al "$SRC" "/mnt/backup/photovault/minio/weekly-$STAMP"
  find /mnt/backup/photovault/minio -maxdepth 1 -name 'weekly-*' -mtime +56 -exec rm -rf {} +
fi
```

Make it executable and run a test:

```bash
sudo chmod +x /usr/local/sbin/backup-photovault-minio.sh
sudo /usr/local/sbin/backup-photovault-minio.sh
du -sh /mnt/backup/photovault/minio
```

### 2.3 MariaDB dumps (mjolnir hosts the `photovault` DB)

The MariaDB on mjolnir **is PhotoVault's DB server** — it holds the
`photovault` database (`albums` + `users`), plus `guacamole_db` and `harp_db`
for other apps. A single `--all-databases` dump covers everything:

```bash
cat <<'EOF' | sudo tee /usr/local/sbin/backup-mariadb-mjolnir.sh
#!/usr/bin/env bash
set -euo pipefail
mkdir -p /mnt/backup/mariadb
# mjolnir's MariaDB = PhotoVault's DB (photovault) + guacamole/harp
sudo mariadb-dump --all-databases --single-transaction --routines --triggers \
  > "/mnt/backup/mariadb/all-$(date +%F).sql"
find /mnt/backup/mariadb -name 'all-*.sql' -mtime +14 -delete
EOF
sudo chmod +x /usr/local/sbin/backup-mariadb-mjolnir.sh
sudo /usr/local/sbin/backup-mariadb-mjolnir.sh
ls -lh /mnt/backup/mariadb/

# Sanity: confirm the photovault DB made it into the dump
grep -c 'CREATE DATABASE.*photovault' /mnt/backup/mariadb/all-*.sql
```

> No in-cluster DB dump is needed: the cluster's `mariadb-service`
> (`data` namespace) is a Service that forwards to this MariaDB
> (confirm with `kubectl -n data get svc mariadb-service -o yaml`).

### 2.4 Schedule with cron

```bash
cat <<'EOF' | sudo tee /etc/cron.d/photovault-backup
# PhotoVault MinIO mirror + mjolnir MariaDB dump, daily
10 3 * * * root /usr/local/sbin/backup-photovault-minio.sh >> /var/log/photovault-backup.log 2>&1
20 3 * * * root /usr/local/sbin/backup-mariadb-mjolnir.sh  >> /var/log/photovault-backup.log 2>&1
EOF
sudo chmod 644 /etc/cron.d/photovault-backup
```

### 2.5 Optional — off-box copy (protects against whole-box loss)

```bash
# rclone is already installed on mjolnir; configure a remote once:
#   rclone config
rclone copy --transfers 4 /mnt/backup/photovault backup:photovault/$(hostname)/$(date +%F)
```

## Phase 3 — Firewall (UFW)

Order matters: **rules first, enable last**. Keep the second SSH session open.

### 3.1 Base policy + SSH lifeline

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from 192.168.1.0/24 to any port 22 proto tcp
sudo ufw allow from 100.64.0.0/10 to any port 22 proto tcp   # Tailscale
```

### 3.2 LAN service rules (adjust to what you actually use)

```bash
# MinIO API + console (LAN + Tailscale)
sudo ufw allow from 192.168.1.0/24 to any port 9000 proto tcp
sudo ufw allow from 192.168.1.0/24 to any port 9001 proto tcp
sudo ufw allow from 100.64.0.0/10 to any port 9000 proto tcp
sudo ufw allow from 100.64.0.0/10 to any port 9001 proto tcp

# NFS + rpcbind + dynamic mountd/statd/lockd ports (LAN only).
# The ephemeral range avoids pinning ports in /etc/nfs.conf (which would
# require an NFS restart and disrupt the Proxmox clients' live mounts).
sudo ufw allow from 192.168.1.0/24 to any port 111 proto tcp
sudo ufw allow from 192.168.1.0/24 to any port 111 proto udp
sudo ufw allow from 192.168.1.0/24 to any port 2049 proto tcp
sudo ufw allow from 192.168.1.0/24 to any port 32768:60999 proto tcp
sudo ufw allow from 192.168.1.0/24 to any port 32768:60999 proto udp

# SMB — only if something still uses it
sudo ufw allow from 192.168.1.0/24 to any port 139 proto tcp
sudo ufw allow from 192.168.1.0/24 to any port 445 proto tcp

# Other services you need reachable on the LAN
sudo ufw allow from 192.168.1.0/24 to any port 5000 proto tcp   # docker registry
sudo ufw allow from 192.168.1.0/24 to any port 5432 proto tcp   # postgres, if LAN clients
sudo ufw allow from 192.168.1.0/24 to any port 3389 proto tcp   # xrdp, if you use it
# MariaDB :3306 — REQUIRED. This IS PhotoVault's DB: pv-api reaches it via
# the in-cluster `mariadb-service` (data ns), which forwards to mjolnir:3306.
# Allow the cluster nodes; add the pod CIDR too if the Service doesn't SNAT.
sudo ufw allow from 192.168.1.0/24 to any port 3306 proto tcp
sudo ufw allow from 10.42.0.0/16 to any port 3306 proto tcp
```

### 3.3 Enable + verify + rollback

```bash
sudo ufw enable
sudo ufw status verbose
sudo ufw logging medium

# From the second, still-open session — check from another LAN machine or via SSH:
nc -vz 192.168.1.8 22 && nc -vz 192.168.1.8 9000 && nc -vz 192.168.1.8 2049
curl -s http://192.168.1.8:9000/minio/health/live

# Cluster still reaches MinIO + NFS: from any node, e.g. ssh k3sa.freki.001
#   curl -s http://mjolnir:9000/minio/health/live
#   ls /nfs-storage

# If anything breaks:
sudo ufw disable
```

## Phase 4 — Final verification

```bash
df -h /                       # should be well below 90% after Phase 1
sudo ufw status numbered      # firewall active with the expected rules
sudo /usr/local/sbin/backup-photovault-minio.sh && ls -la /mnt/backup/photovault/minio/current
systemctl status minio mariadb --no-pager | grep Active
mc admin info mjolnir         # MinIO healthy
# End-to-end: upload a photo in the SPA → mc ls mjolnir/photovault/<album>

# Restore drill (do once):
sudo mariadb -e 'CREATE DATABASE restore_test;'
sudo mariadb restore_test < /mnt/backup/mariadb/all-YYYY-MM-DD.sql
sudo mariadb -e 'DROP DATABASE restore_test;'
```

## Rollback reference

| Change | Rollback |
|---|---|
| Firewall | `sudo ufw disable` |
| MinIO bind mount | `sudo umount /var/lib/minio`; remove the fstab line; `sudo mv /mnt/storage/minio /var/lib/minio` |
| MariaDB bind mount | same pattern for `/var/lib/mysql` |
| Configs | snapshots in `/root/mjolnir-fix-backup/` (Phase 0.3) |
| NFS export added in 1.5 | remove the line from `/etc/exports`, `sudo exportfs -ra` |

MinIO data is never deleted by this plan — the original tree is preserved at
`/mnt/storage/minio` until you are happy with the move.

## Open decisions for you

1. **Is `/mnt/external/2t` a real mount?** It appeared in `exportfs`/`showmount`
   but not in `lsblk`. If it exists, it is an even better backup target than sdd
   (check with `df -hT /mnt/external/2t`).
2. **Are the k3s nodes VMs on disks from `/var/lib/pve-disks`?** Check from
   inside a node (`df -hT /`); if yes, Phase 1.5 is the real long-term fix for
   the root disk.
3. **Cluster → mjolnir traffic**: pods reach MinIO (:9000) and MariaDB (:3306)
   directly, so UFW must allow the cluster source ranges (LAN node IPs
   `192.168.1.0/24` and, if the Service doesn't SNAT, the pod CIDR
   `10.42.0.0/16`). Traffic between pods in-cluster (e.g. pv-api ↔ Temporal)
   is untouched by UFW.
4. **Off-box target for 2.5**: pick a host (heimdal/loki/another machine) or a
   cloud/Backblaze target for the rclone copy.



