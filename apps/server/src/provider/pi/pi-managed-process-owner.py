"""Own the proven Linux cage before starting a worker or a setup command."""
import base64
import json
import os
import pathlib
import select
import signal
import subprocess
import sys

MAX_FRAME = 65536
CHUNK = 8192


def emit(value):
    data = (json.dumps(value, separators=(",", ":")) + "\n").encode()
    if len(data) > MAX_FRAME:
        raise RuntimeError("owner frame bound")
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def pinned(path, dev, ino, directory=False):
    flags = os.O_CLOEXEC | os.O_NOFOLLOW | (os.O_DIRECTORY if directory else os.O_RDONLY)
    fd = os.open(path, flags)
    stat = os.fstat(fd)
    if stat.st_dev != dev or stat.st_ino != ino:
        os.close(fd)
        raise RuntimeError("launch filesystem identity changed")
    return fd


def launch(spec):
    fds = []
    try:
        root = spec["workspace"]
        workspace_fd = pinned(root["path"], root["dev"], root["ino"], True)
        fds.append(workspace_fd)
        command = ["/usr/bin/bwrap", "--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv"]
        for entry in spec["runtimeFiles"]:
            fd = pinned(entry["source"], entry["dev"], entry["ino"])
            fds.append(fd)
            command += ["--ro-bind-fd", str(fd), entry["target"]]
        command += ["--bind-fd", str(workspace_fd), "/workspace", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--setenv", "HOME", "/workspace", "--setenv", "TMPDIR", "/tmp", "--setenv", "PATH", "/runtime:/bin", "--setenv", "LANG", "C.UTF-8", "--remount-ro", "/", "--chdir", "/workspace", "--"] + spec["argv"]
        child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd="/", env={}, close_fds=True, pass_fds=tuple(fds))
        try:
            pidfd = os.pidfd_open(child.pid)
        except BaseException:
            child.kill()
            child.wait()
            raise
        return child, pidfd
    finally:
        for fd in fds:
            os.close(fd)


def main():
    if len(sys.argv) != 2 or len(sys.argv[1]) > MAX_FRAME:
        raise RuntimeError("bounded launch specification required")
    spec = json.loads(base64.b64decode(sys.argv[1], validate=True))
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        raise RuntimeError("Linux pidfd required")
    invocation = os.environ.get("INVOCATION_ID", "")
    os.environ.clear()
    group = next(line[3:] for line in pathlib.Path("/proc/self/cgroup").read_text().splitlines() if line.startswith("0::"))
    if not group.endswith("/" + spec["unit"]) or len(invocation) != 32:
        raise RuntimeError("prelaunch service ownership missing")
    cgroup = pathlib.Path("/sys/fs/cgroup" + group)
    memory = int((cgroup / "memory.max").read_text())
    swap = int((cgroup / "memory.swap.max").read_text())
    oom = int((cgroup / "memory.oom.group").read_text())
    if memory != spec["memoryBytes"] or swap != 0 or oom != 1:
        raise RuntimeError("prelaunch kernel resource policy mismatch")
    emit({"type": "owner", "unit": spec["unit"], "invocation": invocation, "cgroup": str(cgroup), "pid": os.getpid(), "memoryBytes": memory, "swapBytes": swap, "oomGroup": oom, "nonce": spec["nonce"]})
    poller = select.poll()
    poller.register(0, select.POLLIN | select.POLLHUP)
    pending = bytearray()
    child = None
    pidfd = None
    try:
        while True:
            for fd, events in poller.poll():
                if fd == 0:
                    data = os.read(0, CHUNK)
                    if not data:
                        return
                    if len(pending) + len(data) > MAX_FRAME:
                        raise RuntimeError("input frame bound")
                    pending.extend(data)
                    while b"\n" in pending:
                        line, _, remainder = pending.partition(b"\n")
                        pending = bytearray(remainder)
                        request = json.loads(line)
                        if request == {"type": "start"} and child is None:
                            child, pidfd = launch(spec)
                            poller.register(pidfd, select.POLLIN)
                            poller.register(child.stdout.fileno(), select.POLLIN | select.POLLHUP)
                            poller.register(child.stderr.fileno(), select.POLLIN | select.POLLHUP)
                            emit({"type": "started", "pid": child.pid})
                        elif request.get("type") == "input" and child is not None and set(request) == {"type", "data"}:
                            chunk = base64.b64decode(request["data"], validate=True)
                            if len(chunk) > CHUNK:
                                raise RuntimeError("child input chunk bound")
                            child.stdin.write(chunk)
                            child.stdin.flush()
                        elif request == {"type": "end"} and child is not None:
                            child.stdin.close()
                        else:
                            raise RuntimeError("unexpected owner control")
                elif fd == pidfd:
                    code = child.wait()
                    # Read bytes already available before the pidfd receipt; descendants
                    # holding these pipes cannot delay the owned service's termination.
                    for pipe, name in [(child.stdout, "stdout"), (child.stderr, "stderr")]:
                        os.set_blocking(pipe.fileno(), False)
                        while True:
                            try:
                                chunk = os.read(pipe.fileno(), CHUNK)
                            except BlockingIOError:
                                break
                            if not chunk:
                                break
                            emit({"type": name, "data": base64.b64encode(chunk).decode()})
                    emit({"type": "exited", "code": code})
                    return
                else:
                    chunk = os.read(fd, CHUNK)
                    if not chunk:
                        poller.unregister(fd)
                    else:
                        emit({"type": "stdout" if fd == child.stdout.fileno() else "stderr", "data": base64.b64encode(chunk).decode()})
    finally:
        if child is not None and child.poll() is None:
            try:
                signal.pidfd_send_signal(pidfd, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait()
        if pidfd is not None:
            os.close(pidfd)
        # systemd's verified KillMode=control-group owns detached descendants.


try:
    main()
except BaseException:
    emit({"type": "failed", "message": "Managed owner could not prove or retain its launch boundary."})
    sys.exit(1)
