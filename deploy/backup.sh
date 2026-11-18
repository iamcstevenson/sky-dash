#!/usr/bin/env bash
# Nightly backup: a consistent copy of the database plus drafts, compressed, uploaded through
# the encrypted rclone remote "skydash-crypt" (Cloudflare R2), keeping 14 days.
# Run by skydash-backup.timer; can also be run by hand as root.
set -euo pipefail

DATA=/var/lib/skydash
REMOTE=${REMOTE:-skydash-crypt:daily}
KEEP=${KEEP:-14d}
STAMP=$(date -u +%Y-%m-%dT%H%MZ)
WORK=$(mktemp -d -p /var/tmp skydash-backup.XXXXXX)
trap 'rm -rf "$WORK"' EXIT

# SQLite's online backup copies a consistent snapshot while Skydash keeps running.
sqlite3 -cmd ".timeout 60000" "$DATA/skydash.db" ".backup '$WORK/skydash.db'"
check=$(sqlite3 "$WORK/skydash.db" "PRAGMA quick_check;")
[ "$check" = "ok" ] || { echo "Backup copy failed its integrity check: $check" >&2; exit 1; }

archive="$WORK/skydash-$STAMP.tar.gz"
if [ -d "$DATA/drafts" ]; then
  tar -czf "$archive" -C "$WORK" skydash.db -C "$DATA" drafts
else
  tar -czf "$archive" -C "$WORK" skydash.db
fi

# --s3-no-head: R2 checks the upload against its MD5 on arrival; the extra HEAD
# rclone 1.60 makes afterwards asks for a versionId, which R2 rejects (501).
rclone copy "$archive" "$REMOTE" --s3-no-check-bucket --s3-no-head
rclone delete "$REMOTE" --min-age "$KEEP" --s3-no-check-bucket
echo "Uploaded skydash-$STAMP.tar.gz ($(du -h "$archive" | cut -f1)); kept the last $KEEP."
