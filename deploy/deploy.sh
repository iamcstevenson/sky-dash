#!/usr/bin/env bash
# Updates the server to the latest main and restarts Skydash. Run as root on the server,
# or from the Mac: ssh skydash /opt/skydash/deploy/deploy.sh
set -euo pipefail
cd /opt/skydash

before=$(sudo -u skydash git rev-parse --short HEAD)
sudo -u skydash git pull --ff-only --quiet
after=$(sudo -u skydash git rev-parse --short HEAD)
sudo -u skydash npm ci --omit=dev --no-audit --no-fund --cache /tmp/skydash-npm-cache --silent

changed=0
for unit in skydash.service skydash-backup.service skydash-backup.timer; do
  if ! cmp -s "deploy/$unit" "/etc/systemd/system/$unit"; then
    install -m 644 "deploy/$unit" "/etc/systemd/system/$unit"
    changed=1
  fi
done
if [ "$changed" = 1 ]; then
  systemctl daemon-reload
  systemctl enable --now --quiet skydash-backup.timer
fi
systemctl restart skydash
sleep 5
if systemctl is-active --quiet skydash; then
  echo "Skydash $before -> $after is running."
else
  echo "Skydash failed to start. Recent log:" >&2
  journalctl -u skydash -n 30 --no-pager >&2
  exit 1
fi
