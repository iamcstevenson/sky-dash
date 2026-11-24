#!/usr/bin/env bash
# Run as root by skydash-update.timer every 5 minutes: when GitHub's main has new commits,
# runs deploy.sh (pull, install, restart). Nothing to do otherwise, so it's cheap.
set -euo pipefail
cd /opt/skydash
sudo -u skydash git fetch --quiet origin main
if [ "$(sudo -u skydash git rev-parse HEAD)" != "$(sudo -u skydash git rev-parse origin/main)" ]; then
  exec /opt/skydash/deploy/deploy.sh
fi
