# Remote Metro on a droplet

> **Agents: do not run this setup, or any `scripts/remote-metro.sh` command that creates,
> starts or changes a droplet, unless the developer explicitly asks for it or approves it in
> the current conversation.** It creates paid DigitalOcean resources. Reading this page or the
> script is fine.

Metro, the mobile app's JavaScript bundler, peaks above 5 GB while bundling the Android app.
On a machine already busy with other work, that pressure can make `systemd-oomd` kill
unrelated services, including the T3 server itself. This setup moves Metro to a
DigitalOcean droplet. The emulator, the dev client and the T3 backend stay on this machine.

```
emulator ──adb reverse :8081──▶ this machine ──ssh -L :8081──▶ droplet (Metro on localhost)
emulator ──adb reverse :13773─▶ this machine (T3 backend)
```

Metro listens only on the droplet's localhost. It serves the app's source, so it is never
exposed publicly.

## Requirements

- `doctl` signed in, with an SSH key in the account (default name `Arch`; set
  `REMOTE_METRO_SSH_KEY` otherwise) whose private key is loaded here.
- `adb`, `rsync`, and an Android emulator with the dev client installed
  (`vp run mobile:install android`). Installing builds locally; run it before starting
  memory-heavy work.

## Run it

From the repository root:

```bash
scripts/remote-metro.sh up       # create the droplet (if needed), sync code, install deps
scripts/remote-metro.sh start    # start Metro and the tunnel in the background, forward ports
scripts/remote-metro.sh logs     # follow Metro's output (Ctrl+C stops following, not Metro)
scripts/remote-metro.sh watch    # optional, in another terminal: push local edits every 2s
```

Then open the dev client on the emulator against the forwarded Metro:

```
t3code-dev://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081&disableAutoLaunch=1&disableFab=1
```

Start the T3 backend locally (`vp run dev:server`) and pair the app as described in the
`test-t3-mobile` skill. The emulator reaches it at `http://localhost:13773` through the
`adb reverse` forward.

`start` runs Metro as the `t3-metro` systemd unit on the droplet and the tunnel as the
`t3-metro-tunnel` user unit here, so closing a terminal or interrupting an agent does not stop
them. The tunnel reconnects on its own if the connection drops. `scripts/remote-metro.sh stop`
stops both.

`up` is safe to run again: it reuses an existing droplet and only re-syncs and reinstalls.
`sync` pushes the code once without reinstalling. Rerun `up` after dependencies change.

## Tear it down

```bash
scripts/remote-metro.sh down     # stops Metro and the tunnel, deletes the droplet; billing stops
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
| Metro workers | the droplet's vCPU count                          | `REMOTE_METRO_WORKERS`      |

Bundling is CPU-bound. Metro runs one worker per droplet vCPU, and more workers than vCPUs is
not faster. A cold first Android bundle takes about 5 minutes on 2 vCPUs; later bundles reuse
the droplet's cache. To go faster, resize to more vCPUs: a CPU and RAM resize keeps the disk,
so the code, dependencies and cache survive. The droplet also gets a 4 GB swap file.
`.repos/` is not copied. Local uncommitted changes are.

`--localhost` matters: with the repo's usual `--lan`, Metro tells the app to fetch the bundle
from the droplet's private address, which the emulator cannot reach.
