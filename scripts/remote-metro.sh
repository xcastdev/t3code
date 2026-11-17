#!/usr/bin/env bash
# Runs the mobile app's Metro bundler on a DigitalOcean droplet, reached through an SSH tunnel.
# Usage and rules: docs/operations/remote-metro.md. It creates paid cloud resources; agents run it
# only when the developer explicitly asks.
set -euo pipefail

NAME=${REMOTE_METRO_NAME:-t3-metro}
SIZE=${REMOTE_METRO_SIZE:-s-2vcpu-4gb}
REGION=${REMOTE_METRO_REGION:-sfo2}
IMAGE=${REMOTE_METRO_IMAGE:-ubuntu-24-04-x64}
SSH_KEY_NAME=${REMOTE_METRO_SSH_KEY:-Arch}
SERIAL=${ANDROID_SERIAL:-emulator-5554}
BACKEND_PORT=${REMOTE_METRO_BACKEND_PORT:-13773}
REMOTE_DIR=/opt/t3code
ROOT=$(git rev-parse --show-toplevel)
# Skips the system-wide ssh_config, which ssh rejects where root-owned files appear as nobody.
SSH_CONFIG=${REMOTE_METRO_SSH_CONFIG:-$HOME/.ssh/config}
[ -f "$SSH_CONFIG" ] || SSH_CONFIG=/dev/null
SSH_OPTS=(-F "$SSH_CONFIG" -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30)
NODE_VERSION=$(node -p "require('$ROOT/package.json').engines.node")
PNPM_VERSION=$(node -p "require('$ROOT/package.json').packageManager.split('@')[1]")

droplet_ip() {
  doctl compute droplet list --format Name,PublicIPv4 --no-header | awk -v n="$NAME" '$1 == n { print $2 }'
}

remote() {
  ssh "${SSH_OPTS[@]}" "root@$(droplet_ip)" "$@"
}

cmd_up() {
  if [ -z "$(droplet_ip)" ]; then
    key_id=$(doctl compute ssh-key list --format ID,Name --no-header | awk -v n="$SSH_KEY_NAME" '$2 == n { print $1 }')
    [ -n "$key_id" ] || { echo "No DigitalOcean SSH key named $SSH_KEY_NAME" >&2; exit 1; }
    doctl compute droplet create "$NAME" --size "$SIZE" --region "$REGION" --image "$IMAGE" \
      --ssh-keys "$key_id" --tag-names t3-metro --wait >/dev/null
  fi
  echo "Droplet $NAME at $(droplet_ip)"
  until remote true 2>/dev/null; do sleep 3; done
  remote "NODE_VERSION=$NODE_VERSION PNPM_VERSION=$PNPM_VERSION bash -s" <<'EOF'
set -euo pipefail
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
if [ "$(node --version 2>/dev/null)" != "v$NODE_VERSION" ]; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq rsync xz-utils libatomic1 >/dev/null \
    || { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq rsync xz-utils libatomic1 >/dev/null; }
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" \
    | tar -xJ -C /usr/local --strip-components=1
fi
[ "$(pnpm --version 2>/dev/null)" = "$PNPM_VERSION" ] || npm install -g --silent "pnpm@$PNPM_VERSION"
EOF
  cmd_sync
  remote "cd $REMOTE_DIR && pnpm install --frozen-lockfile --ignore-scripts --filter '@t3tools/mobile...'"
}

# Copies tracked and untracked-but-not-ignored files, so local uncommitted edits reach Metro.
cmd_sync() {
  (cd "$ROOT" && git ls-files -co --exclude-standard -z | grep -zv '^\.repos/' \
    | rsync -az -e "ssh ${SSH_OPTS[*]}" --from0 --files-from=- ./ "root@$(droplet_ip):$REMOTE_DIR/")
}

# Re-syncs every 2 seconds until interrupted, so Metro hot-reloads local edits.
cmd_watch() {
  while true; do
    cmd_sync
    sleep 2
  done
}

# Metro and the tunnel run as services, so they outlive the shell or agent session that started them.
TUNNEL_UNIT=t3-metro-tunnel

# Starts Metro on the droplet's localhost, forwards it here, then into the emulator.
cmd_start() {
  remote "systemctl is-active --quiet t3-metro || systemd-run --unit=t3-metro --collect \
    -p WorkingDirectory=$REMOTE_DIR/apps/mobile -E APP_VARIANT=development \
    /usr/local/bin/pnpm exec expo start --dev-client --scheme t3code-dev --localhost --port 8081 \
    --max-workers ${REMOTE_METRO_WORKERS:-\$(nproc)}"
  systemctl --user is-active --quiet "$TUNNEL_UNIT" || systemd-run --user --unit="$TUNNEL_UNIT" \
    -p Restart=on-failure -p RestartSec=3 \
    ssh "${SSH_OPTS[@]}" -N -o ExitOnForwardFailure=yes -L 8081:localhost:8081 "root@$(droplet_ip)"
  adb -s "$SERIAL" reverse tcp:8081 tcp:8081
  adb -s "$SERIAL" reverse "tcp:$BACKEND_PORT" "tcp:$BACKEND_PORT"
  echo "Metro is starting on $NAME. Follow it with: $0 logs"
}

cmd_logs() {
  remote "journalctl -u t3-metro -f -o cat"
}

cmd_stop() {
  systemctl --user stop "$TUNNEL_UNIT" 2>/dev/null || true
  [ -z "$(droplet_ip)" ] || remote "systemctl stop t3-metro 2>/dev/null || true"
}

cmd_status() {
  doctl compute droplet list --format Name,PublicIPv4,Memory,Region,Status --no-header \
    | awk -v n="$NAME" '$1 == n' | grep . || echo "No droplet named $NAME"
}

cmd_down() {
  cmd_stop
  doctl compute droplet delete "$NAME" --force
}

case "${1:-}" in
  up | sync | watch | start | logs | stop | status | down) "cmd_$1" ;;
  *)
    echo "usage: $0 {up|sync|watch|start|logs|stop|status|down}" >&2
    exit 2
    ;;
esac
