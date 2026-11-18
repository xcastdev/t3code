#!/usr/bin/env bash
# Runs the mobile app's Metro bundler, and optionally a T3 backend, on a DigitalOcean droplet,
# reached through SSH tunnels.
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
# A local T3 home (such as a worktree's .t3/<name>) to copy up and serve; never ~/.t3 or live state.
BACKEND_HOME=${REMOTE_METRO_BACKEND_HOME:-}
REMOTE_HOME=/opt/t3-home
# SSH hosts whose simulators reach Metro and the backend on their own localhost, such as a Mac.
DEVICE_HOSTS=${REMOTE_METRO_DEVICE_HOSTS:-}
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
  remote "cd $REMOTE_DIR && pnpm install --frozen-lockfile --ignore-scripts \
    --filter '@t3tools/mobile...' --filter 't3...'"
  # Copied state stores this machine's paths: the checkout, and node for dev providers.
  remote "mkdir -p '$(dirname "$ROOT")' '$(dirname "$(command -v node)")' \
    && ln -sfn $REMOTE_DIR '$ROOT' && ln -sf /usr/local/bin/node '$(command -v node)'"
  if [ -n "$BACKEND_HOME" ]; then
    rsync -az -e "ssh ${SSH_OPTS[*]}" --exclude logs --exclude provider-processes \
      "${BACKEND_HOME%/}/" "root@$(droplet_ip):$REMOTE_HOME/"
  fi
}

# Copies tracked and untracked-but-not-ignored files, so local uncommitted edits reach Metro, and to
# each `host:path` in REMOTE_METRO_MIRRORS (such as a Mac that builds the iOS dev client).
cmd_sync() {
  local files
  files=$(mktemp)
  (cd "$ROOT" && git ls-files -co --exclude-standard -z | grep -zv '^\.repos/') >"$files"
  local target
  for target in "root@$(droplet_ip):$REMOTE_DIR/" ${REMOTE_METRO_MIRRORS:-}; do
    (cd "$ROOT" && rsync -az --ignore-missing-args -e "ssh ${SSH_OPTS[*]}" --from0 --files-from="$files" ./ "${target%/}/")
  done
  rm -f "$files"
}

# Re-syncs every 2 seconds until interrupted, so Metro hot-reloads local edits.
cmd_watch() {
  while true; do
    cmd_sync
    sleep 2
  done
}

# Metro, the backend and the tunnels run as services, so they outlive the shell or agent session
# that started them.
TUNNEL_UNIT=t3-metro-tunnel

# Starts Metro (and the backend, when its home was copied) on the droplet's localhost, forwards both
# here, into a running Android emulator, and to each device host.
cmd_start() {
  remote "systemctl is-active --quiet t3-metro || systemd-run --unit=t3-metro --collect \
    -p WorkingDirectory=$REMOTE_DIR/apps/mobile -E APP_VARIANT=development \
    /usr/local/bin/pnpm exec expo start --dev-client --scheme t3code-dev --localhost --port 8081 \
    --max-workers ${REMOTE_METRO_WORKERS:-\$(nproc)}"
  remote "[ ! -d $REMOTE_HOME ] || systemctl is-active --quiet t3-backend || systemd-run \
    --unit=t3-backend --collect -p WorkingDirectory=$REMOTE_DIR/apps/server -E T3CODE_HOME=$REMOTE_HOME \
    -E T3CODE_PORT=$BACKEND_PORT -E T3CODE_NO_BROWSER=1 -E T3CODE_TELEMETRY_ENABLED=false \
    -E T3CODE_MODE=web /usr/local/bin/node src/bin.ts"
  systemctl --user is-active --quiet "$TUNNEL_UNIT" || systemd-run --user --unit="$TUNNEL_UNIT" \
    -p Restart=on-failure -p RestartSec=3 ssh "${SSH_OPTS[@]}" -N -o ExitOnForwardFailure=yes \
    -L 8081:localhost:8081 -L "$BACKEND_PORT:localhost:$BACKEND_PORT" "root@$(droplet_ip)"
  if adb -s "$SERIAL" get-state >/dev/null 2>&1; then
    adb -s "$SERIAL" reverse tcp:8081 tcp:8081
    adb -s "$SERIAL" reverse "tcp:$BACKEND_PORT" "tcp:$BACKEND_PORT"
  fi
  local host
  for host in $DEVICE_HOSTS; do
    systemctl --user is-active --quiet "$TUNNEL_UNIT-$host" || systemd-run --user \
      --unit="$TUNNEL_UNIT-$host" -p Restart=on-failure -p RestartSec=3 ssh "${SSH_OPTS[@]}" -N \
      -o ExitOnForwardFailure=yes -R 8081:localhost:8081 -R "$BACKEND_PORT:localhost:$BACKEND_PORT" "$host"
  done
  echo "Metro is starting on $NAME. Follow it with: $0 logs"
}

# Follows Metro, or the backend with `logs backend`.
cmd_logs() {
  remote "journalctl -u t3-${1:-metro} -f -o cat"
}

cmd_stop() {
  systemctl --user stop "$TUNNEL_UNIT" "$TUNNEL_UNIT-*" 2>/dev/null || true
  [ -z "$(droplet_ip)" ] || remote "systemctl stop t3-metro t3-backend 2>/dev/null || true"
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
  up | sync | watch | start | logs | stop | status | down) "cmd_$1" "${@:2}" ;;
  *)
    echo "usage: $0 {up|sync|watch|start|logs|stop|status|down}" >&2
    exit 2
    ;;
esac
