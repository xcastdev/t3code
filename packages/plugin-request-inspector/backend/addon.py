"""T3 request inspector addon for mitmdump.

Streams finished flows to the inspector worker over its control socket as NDJSON, and replays
requests the worker sends. Header pairs and bodies travel as base64 bytes.
"""

import asyncio
import base64
import json
import os
import time

from mitmproxy import connection, ctx, http

REPLAY_ID = "t3_inspector_replay_id"
READ_LIMIT = 8 * 1024 * 1024


def _b64(data):
    return base64.b64encode(data).decode("ascii")


def _unb64(text):
    return base64.b64decode(text.encode("ascii"), validate=True)


class Inspector:
    def __init__(self):
        self.writer = None
        self.max_body = int(os.environ.get("T3_INSPECTOR_MAX_BODY_BYTES", "1048576"))

    async def running(self):
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
                if isinstance(message, dict) and message.get("type") == "replay":
                    self._replay(message)
        except Exception:
            pass
        self.writer = None
        ctx.master.shutdown()

    def _replay(self, message):
        replay_id = message.get("replayId")
        try:
            r = message["request"]
            with open(r["bodyFile"], "rb") as body_file:
                content = body_file.read()
            fields = tuple((_unb64(name), _unb64(value)) for name, value in r["headers"])
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
            server = connection.Server(address=(request.host, request.port))
            flow = http.HTTPFlow(client, server)
            flow.request = request
            flow.metadata[REPLAY_ID] = replay_id
            playback = ctx.master.addons.get("clientplayback")
            refusal = "Client playback is unavailable." if playback is None else playback.check(flow)
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
            "headers": [[_b64(n), _b64(v)] for n, v in request.headers.fields],
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
            self._send(self._record(flow))
        await self._drain()

    async def response(self, flow):
        await self._finished(flow)

    async def error(self, flow):
        await self._finished(flow)

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
