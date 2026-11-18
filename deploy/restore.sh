#!/usr/bin/env bash
# Downloads a backup and unpacks it into a folder. It never touches the live database.
#   restore.sh                     newest backup into /var/tmp/skydash-restore
#   restore.sh FILE.tar.gz [DIR]   a specific backup (see: rclone ls skydash-crypt:daily)
# To put it live: systemctl stop skydash; copy skydash.db and drafts/ into /var/lib/skydash
# (delete any skydash.db-wal and -shm there first); chown -R skydash:skydash /var/lib/skydash;
# systemctl start skydash.
set -euo pipefail

REMOTE=${REMOTE:-skydash-crypt:daily}
file=${1:-$(rclone lsf "$REMOTE" --s3-no-check-bucket | sort | tail -1)}
dir=${2:-/var/tmp/skydash-restore}
[ -n "$file" ] || { echo "No backups found in $REMOTE" >&2; exit 1; }

rm -rf "$dir" && mkdir -p "$dir"
rclone copy "$REMOTE/$file" "$dir" --s3-no-check-bucket
tar -xzf "$dir/$file" -C "$dir" && rm "$dir/$file"
check=$(sqlite3 "$dir/skydash.db" "PRAGMA quick_check;")
echo "Restored $file into $dir (integrity: $check, posts: $(sqlite3 "$dir/skydash.db" 'select count(*) from posts;'))"
