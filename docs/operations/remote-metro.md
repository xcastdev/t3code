# Remote Metro on a droplet

> **Agents: do not run this setup, or any `scripts/remote-metro.sh` command that creates,
> starts or changes a droplet, unless the developer explicitly asks for it or approves it in
> the current conversation.** It creates paid DigitalOcean resources. Reading this page or the
> script is fine.

Metro, the mobile app's JavaScript bundler, peaks above 5 GB while bundling. On a machine
already busy with other work, that pressure can make `systemd-oomd` kill unrelated services,
including the T3 server itself. This setup runs Metro, and optionally a T3 backend with test
data, on a DigitalOcean droplet. You keep editing here; devices run here (Android) or on an SSH
device host such as a Mac (iOS).

```
droplet: Metro :8081, backend :13773 (localhost only)
   ▲ ssh -L (t3-metro-tunnel)
this machine :8081, :13773 ──adb reverse──▶ Android emulator
   │ ssh -R (t3-metro-tunnel-<host>)
   ▼
Mac :8081, :13773 ──▶ iOS Simulator
```

Metro and the backend listen only on the droplet's localhost. Metro serves the app's source, so
it is never exposed publicly.

## Requirements

- `doctl` signed in, with an SSH key in the account (default name `Arch`; set
  `REMOTE_METRO_SSH_KEY` otherwise) whose private key is loaded here.
- `rsync`. For Android, `adb` and an emulator with the dev client installed
  (`vp run mobile:install android`).
- For iOS, a Mac added under **Settings → Devices → Add source → Machine over SSH**, with
  Xcode, an iOS simulator runtime and CocoaPods. See [iOS on a Mac](#ios-on-a-mac).

## Run it

From the repository root:

```bash
export REMOTE_METRO_BACKEND_HOME=.t3/sidebar-preview  # optional: test data for a droplet backend
export REMOTE_METRO_MIRRORS="macbook-pro:Projects/t3code"  # optional: Mac checkout for iOS builds
export REMOTE_METRO_DEVICE_HOSTS=macbook-pro          # optional: Mac whose simulator needs the ports

scripts/remote-metro.sh up       # create the droplet (if needed), sync, install deps, copy data
scripts/remote-metro.sh start    # start Metro, the backend and tunnels in the background
scripts/remote-metro.sh logs     # follow Metro (`logs backend` for the backend)
scripts/remote-metro.sh watch    # optional, in another terminal: push local edits every 2s
```

`REMOTE_METRO_BACKEND_HOME` must be a disposable T3 home, such as a worktree's `.t3/<name>`,
never `~/.t3` or other live state. Stop any local server using it before `up` copies it.

Then open the dev client against the forwarded Metro, on the emulator or the simulator:

```
t3code-dev://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081&disableAutoLaunch=1&disableFab=1
```

Pair it with the backend at `http://localhost:13773`. For the droplet backend, create the
pairing credential on the droplet:

```bash
ssh root@<droplet-ip> 'cd /opt/t3code && T3CODE_PORT=13773 node apps/server/src/bin.ts auth pairing \
  create --base-dir /opt/t3-home --base-url http://localhost:13773 --ttl 15m --label mobile'
```

Open the printed pair URL through the app's `t3code-dev://connections/new?pairingUrl=…&autoConnect=1`
route, as the `test-t3-mobile` skill's `pair-client.sh` does for a local backend.

`start` runs Metro and the backend as the `t3-metro` and `t3-backend` systemd units on the
droplet, and each tunnel as a user unit here, so closing a terminal or interrupting an agent
does not stop them. Tunnels reconnect on their own. `scripts/remote-metro.sh stop` stops them
all.

`up` is safe to run again: it reuses an existing droplet and only re-syncs and reinstalls.
`sync` pushes the code once without reinstalling. Rerun `up` after dependencies change.
`sync` and `watch` push to the droplet and to every `host:path` in `REMOTE_METRO_MIRRORS`.
Syncing is one-way from this checkout, so edit only here. `.repos/` is not copied; local
uncommitted changes are.

Copied state stores this machine's paths, so `up` links this checkout's path and this
machine's `node` path to their droplet equivalents.

## iOS on a Mac

iOS dev clients build only on macOS, so the Mac keeps a checkout for native builds while Metro
stays on the droplet.

1. Add the Mac as an SSH device host in Settings → Devices. If **Test connection** fails while
   `ssh <host>` works in your shell, check the T3 server's journal for
   `Bad owner or permissions on /etc/ssh/ssh_config.d/…`. A user service with `PrivateTmp=true`
   runs in a user namespace where root-owned SSH config looks untrusted; set `PrivateTmp=no` in
   a drop-in for the T3 service and restart it.
2. Give the Mac Node at the repo's `engines.node` version, pnpm at the `packageManager`
   version, and CocoaPods (`brew install cocoapods`). Building needs `LANG=en_US.UTF-8` and the
   checkout's `node_modules/.bin` on `PATH`, since the build calls `vp`.
3. Make the mirror a git checkout of the current commit. The native build reads `git ls-files`:
   ```bash
   git init && git remote add origin <your fork> && git fetch --depth 1 origin <HEAD sha>
   git update-ref refs/heads/<branch> FETCH_HEAD && git symbolic-ref HEAD refs/heads/<branch> && git reset
   ```
4. Install what the build needs, then build and install the dev client on a booted simulator:
   ```bash
   pnpm install --frozen-lockfile --ignore-scripts --filter '@t3tools/mobile...' --filter '@t3tools/scripts...'
   (cd apps/mobile && pnpm rebuild react-native-enriched-markdown)  # its iOS math assets
   node scripts/mobile-native-client.ts ensure ios <simulator-udid>
   ```
   The first build takes 10–15 minutes and several GB of disk. Rebuild only after native
   changes; JavaScript comes from Metro.

The Device panel lists only simulators that are booted or used before. Boot one with
`xcrun simctl boot <udid>` on the Mac if none appear.

## Tear it down

```bash
scripts/remote-metro.sh down     # stops services and tunnels, deletes the droplet; billing stops
scripts/remote-metro.sh status   # confirms nothing named t3-metro is left
```

The droplet bills hourly while it exists, stopped or not. Delete it when you are done.

## Defaults

| Setting       | Default                                           | Override                    |
| ------------- | ------------------------------------------------- | --------------------------- |
| Name          | `t3-metro`                                        | `REMOTE_METRO_NAME`         |
| Size          | `s-2vcpu-4gb` (4 GB RAM, 2 vCPU, ~$0.036/hour)    | `REMOTE_METRO_SIZE`         |
| Region        | `sfo2` (closest to Chicago that offers this size) | `REMOTE_METRO_REGION`       |
| Emulator      | `emulator-5554`                                   | `ANDROID_SERIAL`            |
| Backend port  | `13773`                                           | `REMOTE_METRO_BACKEND_PORT` |
| Backend data  | none (no droplet backend)                         | `REMOTE_METRO_BACKEND_HOME` |
| Metro workers | the droplet's vCPU count                          | `REMOTE_METRO_WORKERS`      |
| Mirrors       | none                                              | `REMOTE_METRO_MIRRORS`      |
| Device hosts  | none                                              | `REMOTE_METRO_DEVICE_HOSTS` |

Bundling is CPU-bound. Metro runs one worker per droplet vCPU, and more workers than vCPUs is
not faster. A cold first bundle takes about 5 minutes on 2 vCPUs and under 2 minutes on 4
(`s-4vcpu-8gb`); later bundles reuse the droplet's cache. A CPU and RAM resize keeps the disk,
so the code, dependencies and cache survive. The droplet also gets a 4 GB swap file.

`--localhost` matters: with the repo's usual `--lan`, Metro tells the app to fetch the bundle
from the droplet's private address, which no device can reach.
