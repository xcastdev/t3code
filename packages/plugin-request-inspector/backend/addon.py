"""T3 request inspector addon for mitmdump.

Streams finished flows and pass-through tunnels to the inspector worker over its control socket
as NDJSON, applies the worker's control messages, and replays requests the worker sends. Header
pairs and bodies travel as base64 bytes.

Host lists arrive as regex sources compiled by shared/hostPatterns.ts, so there is one pattern
implementation. Both lists go into mitmproxy's ignore_hosts (no TLS is terminated for either);
this addon decides which ignored connections to record. The worker puts the startup lists on
argv and upstream auth in a config file, because mitmproxy listens before this addon runs.

With T3_INSPECTOR_IMPORT set, the process listens for nothing: it streams the HTTP flows of that
file as flow records, then sends importDone and waits for the worker to stop it.
"""

import asyncio
import base64
import json
import os
import re
import sys
import time

from mitmproxy import connection, ctx, http
from mitmproxy import io as flow_io
from mitmproxy.exceptions import FlowReadException
from mitmproxy.addons.upstream_auth import parse_upstream_auth
from mitmproxy.proxy import mode_specs
from mitmproxy.proxy.layers.tls import parse_client_hello

REPLAY_ID = "t3_inspector_replay_id"
READ_LIMIT = 8 * 1024 * 1024
MAX_HELLO_BYTES = 64 * 1024
MAX_IMPORT_ERROR_CHARS = 300


def _b64(data):
    return base64.b64encode(data).decode("ascii")


def _unb64(text):
    return base64.b64decode(text.encode("ascii"), validate=True)


def _compile(sources):
    return [re.compile(source, re.IGNORECASE) for source in sources]


def _matches(patterns, targets):
    return any(pattern.search(target) for pattern in patterns for target in targets)


def match_host(sources, host, port):
    """The same check as matchHost in shared/hostPatterns.ts, on compiled sources."""
    return _matches(_compile(sources), [f"{host}:{port}"])


def _in_upstream_mode():
    modes = ctx.options.mode
    return bool(modes) and modes[0].startswith("upstream:")


def _without_upstream_auth(fields):
    """Drops the Proxy-Authorization that upstream_auth added, so the credential is never kept."""
    auth = ctx.options.upstream_auth
    if not auth or not _in_upstream_mode():
        return fields
    added = parse_upstream_auth(auth)
    return tuple(
        (name, value)
        for name, value in fields
        if name.lower() != b"proxy-authorization" or value != added
    )


def _addr(address):
    if not address:
        return None
    host, port, *_ = address
    return host, port


class Inspector:
    def __init__(self):
        self.writer = None
        self.max_body = int(os.environ.get("T3_INSPECTOR_MAX_BODY_BYTES", "1048576"))
        self.recording = os.environ.get("T3_INSPECTOR_RECORD") == "1"
        self.tunnels = {}
        # mitmproxy already has these lists from argv; the addon only needs them compiled.
        self.startup_error = None
        try:
            hosts = json.loads(os.environ.get("T3_INSPECTOR_HOSTS") or "{}")
            self.passthrough = _compile(hosts.get("passthrough", []))
            self.ignored = _compile(hosts.get("ignored", []))
        except Exception as error:
            self.passthrough = []
            self.ignored = []
            self.startup_error = error

    async def running(self):
        try:
            if self.startup_error is not None:
                raise self.startup_error
            # Only a replay-only process, which never listens, gets its auth this way.
            auth = os.environ.get("T3_INSPECTOR_UPSTREAM_AUTH")
            if auth:
                ctx.options.update(upstream_auth=auth)
        except Exception as error:
            print(
                f"T3 inspector: invalid startup options ({type(error).__name__})", file=sys.stderr
            )
            ctx.master.shutdown()
            return
        try:
            reader, writer = await asyncio.open_connection(
                "127.0.0.1", int(os.environ["T3_INSPECTOR_CONTROL_PORT"]), limit=READ_LIMIT
            )
        except Exception:
            ctx.master.shutdown()
            return
        self.writer = writer
        self._send({"type": "hello", "token": os.environ["T3_INSPECTOR_CONTROL_TOKEN"]})
        await self._drain()
        self.reader_task = asyncio.create_task(self._read(reader))
        import_path = os.environ.get("T3_INSPECTOR_IMPORT")
        if import_path:
            self.import_task = asyncio.create_task(self._import(import_path))

    async def _import(self, path):
        skipped = 0
        error = None
        try:
            with open(path, "rb") as source:
                for flow in flow_io.FlowReader(source).stream():
                    if self.writer is None:
                        return
                    if isinstance(flow, http.HTTPFlow):
                        self._send(self._record(flow))
                        await self._drain()
                    else:
                        skipped += 1
        except FlowReadException as read_error:
            # Some messages quote the bad record, so only a short one without it is passed on.
            message = str(read_error)
            error = (
                "The file holds a record that is not a flow."
                if "loaded=" in message or len(message) > MAX_IMPORT_ERROR_CHARS
                else message
            )
        except Exception as read_error:
            error = f"The file could not be read ({type(read_error).__name__})."
        self._send({"type": "importDone", "skipped": skipped, "error": error})
        await self._drain()

    def _apply_hosts(self, passthrough, ignored):
        self.passthrough = _compile(passthrough)
        self.ignored = _compile(ignored)
        updates = {"ignore_hosts": [*passthrough, *ignored]}
        # A future mitmproxy records ignored flows by default and drops this option; the tcp_*
        # hooks then run without it.
        if "show_ignored_hosts" in ctx.options:
            updates["show_ignored_hosts"] = len(passthrough) > 0
        ctx.options.update(**updates)

    async def _read(self, reader):
        try:
            while True:
                line = await reader.readline()
                if not line:
                    break
                try:
                    message = json.loads(line)
                except ValueError:
                    continue
                if isinstance(message, dict):
                    self._control(message)
                    await self._drain()
        except Exception:
            pass
        self.writer = None
        ctx.master.shutdown()

    def _control(self, message):
        kind = message.get("type")
        if kind == "replay":
            self._replay(message)
            return
        if kind not in ("record", "hosts"):
            return
        try:
            if kind == "record":
                self.recording = message.get("enabled") is True
            else:
                self._apply_hosts(message.get("passthrough", []), message.get("ignored", []))
            self._send({"type": "applied", "id": message.get("id")})
        except Exception as error:
            self._send({"type": "applied", "id": message.get("id"), "error": type(error).__name__})

    def _replay(self, message):
        replay_id = message.get("replayId")
        try:
            r = message["request"]
            with open(r["bodyFile"], "rb") as body_file:
                content = body_file.read()
            fields = _without_upstream_auth(
                tuple((_unb64(name), _unb64(value)) for name, value in r["headers"])
            )
            now = time.time()
            # The constructor keeps content raw; Request.make and the .content setter would
            # re-encode it per Content-Encoding and rewrite Content-Length.
            request = http.Request(
                r["host"],
                int(r["port"]),
                r["method"].encode(),
                r["scheme"].encode(),
                r["authority"].encode(),
                r["path"].encode(),
                r["httpVersion"].encode(),
                http.Headers(fields),
                content,
                None,
                now,
                now,
            )
            client = connection.Client(peername=("", 0), sockname=("", 0), timestamp_start=now)
            # upstream_auth adds Proxy-Authorization to plain-HTTP requests only when the
            # client's mode is upstream; clientplayback routes by ctx.options.mode alone.
            if _in_upstream_mode():
                client.proxy_mode = mode_specs.ProxyMode.parse(ctx.options.mode[0])
            server = connection.Server(address=(request.host, request.port))
            flow = http.HTTPFlow(client, server)
            flow.request = request
            flow.metadata[REPLAY_ID] = replay_id
            playback = ctx.master.addons.get("clientplayback")
            refusal = (
                "Client playback is unavailable." if playback is None else playback.check(flow)
            )
            if refusal:
                self._send({"type": "replayResult", "replayId": replay_id, "error": refusal})
                return
            ctx.master.commands.call("replay.client", [flow])
        except Exception as error:
            self._send(
                {
                    "type": "replayResult",
                    "replayId": replay_id,
                    "error": f"The replay could not start: {type(error).__name__}",
                }
            )

    def _body(self, raw):
        if raw is None:
            return None
        return {"data": _b64(raw[: self.max_body]), "truncated": len(raw) > self.max_body}

    def _record(self, flow):
        request = flow.request
        response = flow.response
        is_websocket = flow.websocket is not None or (
            response is not None and response.status_code == 101
        )
        return {
            "type": "flow",
            "startedAt": int(request.timestamp_start * 1000),
            "flowType": "websocket" if is_websocket else "http",
            "method": request.method,
            "scheme": request.scheme,
            "host": request.host,
            "port": request.port,
            "authority": request.authority,
            "path": request.path,
            "httpVersion": request.http_version,
            "headers": [
                [_b64(n), _b64(v)] for n, v in _without_upstream_auth(request.headers.fields)
            ],
            "body": self._body(request.raw_content),
            "response": None
            if response is None
            else {
                "status": response.status_code,
                "reason": response.reason,
                "httpVersion": response.http_version,
                "headers": [[_b64(n), _b64(v)] for n, v in response.headers.fields],
                "body": self._body(response.raw_content),
            },
            "error": None if flow.error is None else flow.error.msg,
        }

    def _is_ignored_request(self, flow):
        # A plain-HTTP proxy request to a listed host is never a tunnel: mitmproxy's HTTP layer
        # forwards it. Pass-through hosts record it as a flow; ignored hosts drop it here.
        if not self.ignored:
            return False
        targets = [f"{flow.request.host}:{flow.request.port}"]
        address = _addr(flow.server_conn.address)
        if address is not None:
            targets.append(f"{address[0]}:{address[1]}")
        return _matches(self.ignored, targets)

    async def _finished(self, flow):
        replay_id = flow.metadata.get(REPLAY_ID)
        if flow.is_replay == "request":
            if replay_id is None:
                return
            if flow.response is None and flow.error is not None:
                self._send({"type": "replayResult", "replayId": replay_id, "error": flow.error.msg})
            else:
                self._send(
                    {"type": "replayResult", "replayId": replay_id, "flow": self._record(flow)}
                )
        elif flow.is_replay is None:
            # Not recording: forward only, and never serialize bodies.
            if not self.recording or self._is_ignored_request(flow):
                return
            self._send(self._record(flow))
        await self._drain()

    async def response(self, flow):
        await self._finished(flow)

    async def error(self, flow):
        await self._finished(flow)

    def tcp_start(self, flow):
        self.tunnels[flow.id] = {"up": 0, "down": 0, "hello": bytearray(), "sni": None}

    def tcp_message(self, flow):
        # TCPLayer forwards its own reference to the message content, so clearing the list
        # changes nothing on the wire and keeps a long tunnel from growing in memory.
        message = flow.messages[-1]
        flow.messages.clear()
        state = self.tunnels.get(flow.id)
        if state is None:
            return
        size = len(message.content)
        if not message.from_client:
            state["down"] += size
            return
        state["up"] += size
        hello = state["hello"]
        if hello is None:
            return
        hello.extend(message.content)
        try:
            parsed = parse_client_hello(bytes(hello))
        except Exception:
            state["hello"] = None
            return
        if parsed is not None:
            state["sni"] = parsed.sni
            state["hello"] = None
        elif len(hello) > MAX_HELLO_BYTES:
            state["hello"] = None

    async def tcp_end(self, flow):
        await self._tunnel_done(flow, None)

    async def tcp_error(self, flow):
        await self._tunnel_done(flow, "error" if flow.error is None else flow.error.msg)

    async def _tunnel_done(self, flow, error):
        state = self.tunnels.pop(flow.id, None)
        address = _addr(flow.server_conn.address)
        if state is None or address is None or not self.recording:
            return
        host, port = address
        sni = state["sni"]
        targets = [f"{host}:{port}"]
        if sni:
            targets.append(f"{sni}:{port}")
        if _matches(self.ignored, targets) or not _matches(self.passthrough, targets):
            return
        peer = _addr(flow.client_conn.peername)
        self._send(
            {
                "type": "tunnel",
                "startedAt": int(flow.timestamp_created * 1000),
                "endedAt": int(time.time() * 1000),
                "host": sni or host,
                "port": port,
                "sni": sni,
                "clientAddr": None if peer is None else f"{peer[0]}:{peer[1]}",
                "bytesUp": state["up"],
                "bytesDown": state["down"],
                "error": error,
            }
        )
        await self._drain()

    def _send(self, message):
        writer = self.writer
        if writer is None or writer.is_closing():
            return
        writer.write(json.dumps(message, separators=(",", ":")).encode() + b"\n")

    async def _drain(self):
        writer = self.writer
        if writer is None:
            return
        try:
            await writer.drain()
        except Exception:
            self.writer = None

    def done(self):
        writer = self.writer
        self.writer = None
        if writer is not None:
            writer.close()


addons = [Inspector()]
