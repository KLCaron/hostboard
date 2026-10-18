#!/usr/bin/python3 -I
# SPDX-License-Identifier: AGPL-3.0-only
"""Forced-command Docker log reader. No shell, Docker CLI, or HTTP listener."""
import datetime as dt
import fcntl
import http.client
import json
import os
import re
import resource
import signal
import socket
import struct
import sys
import time
import urllib.parse

MAX_RAW = 2 * 1024 * 1024
MAX_OUTPUT = 512 * 1024
MAX_LINES = 500
MAX_ENTRY = 16384
ID = re.compile(r"^[a-f0-9]{64}$")
SLUG = re.compile(r"^[a-zA-Z0-9_.-]{1,80}$")
STAMP = re.compile(r"^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)\.(\d{1,9})Z$")
ANSI = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))")
CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]")


class Unavailable(Exception):
    pass


class Deadline(Exception):
    pass


def ns(value):
    if not isinstance(value, str) or not STAMP.fullmatch(value):
        raise ValueError("Use a UTC timestamp with fractional seconds")
    m = STAMP.fullmatch(value)
    return int(dt.datetime.fromisoformat(m[1] + "+00:00").timestamp()) * 10**9 + int(m[2].ljust(9, "0"))


def stamp(value):
    return dt.datetime.fromtimestamp(value // 10**9, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S") + f".{value % 10**9:09d}Z"


def clean(data):
    return CONTROL.sub("", ANSI.sub("", data.decode("utf-8", "replace")))


def query(value):
    if not isinstance(value, dict) or set(value) - {"op", "source", "after", "before", "search", "caseSensitive", "stream", "cursor"}:
        raise ValueError("Unknown query fields")
    if value.get("op") == "sources" and set(value) == {"op"}:
        return value
    if value.get("op") != "query" or not isinstance(value.get("source"), str) or not SLUG.fullmatch(value["source"]):
        raise ValueError("Choose an approved source")
    after, before = ns(value.get("after")), ns(value.get("before"))
    if not 0 <= after < before or before - after > 86400 * 10**9 or before > time.time_ns() + 60 * 10**9:
        raise ValueError("Choose a range of at most 24 hours, ending no later than now")
    if not isinstance(value.get("search", ""), str) or len(value.get("search", "")) > 256:
        raise ValueError("Search is limited to 256 characters")
    if type(value.get("caseSensitive", False)) is not bool or value.get("stream", "all") not in ("all", "stdout", "stderr", "combined"):
        raise ValueError("Invalid filter")
    c = value.get("cursor")
    if c is not None:
        if not isinstance(c, dict) or set(c) != {"containerId", "time", "skip"} or not isinstance(c["containerId"], str) or not ID.fullmatch(c["containerId"]) or type(c["skip"]) is not int or not 0 <= c["skip"] <= 100000:
            raise ValueError("Invalid cursor")
        if not after <= ns(c["time"]) <= before:
            raise ValueError("Cursor outside range")
    return value


class UnixHTTP(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect("/var/run/docker.sock")


class Docker:
    def get(self, route):
        # Every caller builds a fixed GET route from validated IDs; never a proxy.
        conn = UnixHTTP("localhost", timeout=3)
        conn.request("GET", "/v1.47" + route)
        res = conn.getresponse()
        if res.status != 200:
            conn.close()
            raise Unavailable("Docker log source unavailable; it may have been removed or its logging driver cannot be read")
        return conn, res

    def json(self, route):
        conn, res = self.get(route)
        try:
            body = res.read(1024 * 1024 + 1)
            if len(body) > 1024 * 1024:
                raise Unavailable("Docker metadata exceeds limit")
            return json.loads(body)
        finally:
            conn.close()


def config(value):
    if not isinstance(value, dict) or set(value) != {"sources"} or not isinstance(value["sources"], list) or len(value["sources"]) > 100:
        raise ValueError("Invalid adapter configuration")
    seen = set()
    for s in value["sources"]:
        if not isinstance(s, dict) or set(s) - {"id", "name", "labels", "containerId"} or not SLUG.fullmatch(s.get("id", "")) or s["id"] in seen or not isinstance(s.get("name"), str) or not 1 <= len(s["name"]) <= 100:
            raise ValueError("Invalid source configuration")
        seen.add(s["id"])
        if ("labels" in s) == ("containerId" in s):
            raise ValueError("Choose an exact container ID or a label selector")
        if "containerId" in s and not ID.fullmatch(s["containerId"]):
            raise ValueError("Use a full container ID")
        if "labels" in s and (not isinstance(s["labels"], dict) or not 1 <= len(s["labels"]) <= 8 or any(not isinstance(k, str) or not isinstance(v, str) or not 1 <= len(k) <= 128 or not 1 <= len(v) <= 128 for k, v in s["labels"].items())):
            raise ValueError("Invalid label selector")
    return value["sources"]


def resolve(docker, source):
    if "containerId" in source:
        identity = source["containerId"]
    else:
        filters = urllib.parse.urlencode({"all": "1", "filters": json.dumps({"label": [f"{k}={v}" for k, v in source["labels"].items()]})})
        matches = docker.json("/containers/json?" + filters)
        matches = [m for m in matches if all(m.get("Labels", {}).get(k) == v for k, v in source["labels"].items()) and m.get("Labels", {}).get("com.docker.compose.oneoff", "False").lower() != "true"]
        if len(matches) != 1:
            raise Unavailable("No unique container matches the approved selector; administrator confirmation is required")
        identity = matches[0]["Id"]
    if not isinstance(identity, str) or not ID.fullmatch(identity):
        raise Unavailable("Invalid Docker identity")
    c = docker.json("/containers/" + identity + "/json")
    return {"containerId": identity, "containerName": c["Name"].lstrip("/"), "created": c["Created"], "driver": c["HostConfig"]["LogConfig"]["Type"], "tty": bool(c["Config"].get("Tty"))}


def logs(docker, source, q):
    meta = resolve(docker, source)
    cursor = q.get("cursor")
    if cursor and cursor["containerId"] != meta["containerId"]:
        raise Unavailable("Container was replaced. Earlier logs belong to the previous container and may no longer exist. Reload to inspect the current container")
    if meta["driver"] == "none":
        raise Unavailable("This container disables Docker logging")
    before = ns(q["before"])
    start = ns(cursor["time"]) if cursor else ns(q["after"])
    def unix(value):
        return f"{value // 10**9}.{value % 10**9:09d}"
    params = urllib.parse.urlencode({"stdout": "1", "stderr": "1", "timestamps": "1", "follow": "0", "tail": "all", "since": unix(max(0, start - 1)), "until": unix(before)})
    conn, response = docker.get("/containers/" + meta["containerId"] + "/logs?" + params)
    records, pending, dropping = [], {}, {}
    consumed = scanned = 0
    scan_limited = False

    def line(stream, raw, cut=False):
        nonlocal scanned
        scanned += 1
        date, sep, message = raw.partition(b" ")
        try:
            when = ns(date.decode("ascii"))
        except (ValueError, UnicodeError):
            # Docker's timestamps option must supply real timestamps. Fail explicitly.
            raise Unavailable("Docker returned an entry without a valid timestamp")
        if start <= when <= before:
            records.append({"time": stamp(when), "stream": stream, "text": clean(message) + (" … [entry truncated]" if cut else ""), "truncated": cut})
        return scanned >= 5000

    def feed(stream, data):
        buf = pending.get(stream, b"")
        # Only LF delimits records; terminal control characters are stripped later.
        parts = data.split(b"\n")
        for index, part in enumerate(parts):
            end = index < len(parts) - 1
            if dropping.get(stream):
                if end:
                    dropping[stream] = False
                continue
            buf += part
            if len(buf) > MAX_ENTRY:
                stop = line(stream, buf[:MAX_ENTRY], True)
                buf = b""
                dropping[stream] = not end
            elif end:
                stop = line(stream, buf.rstrip(b"\r"))
                buf = b""
            else:
                stop = False
            if stop:
                pending[stream] = b""
                return True
        pending[stream] = buf
        return False

    try:
        while True:
            if meta["tty"]:
                data = response.read1(min(16384, MAX_RAW - consumed + 1))
                if not data:
                    break
                consumed += len(data)
                stop = feed("combined", data)
            else:
                header = response.read(8)
                if not header:
                    break
                if len(header) != 8 or header[0] not in (1, 2) or header[1:4] != b"\0\0\0":
                    raise Unavailable("Malformed Docker log framing")
                size = struct.unpack(">I", header[4:])[0]
                if size > MAX_RAW - consumed:
                    # Never allocate according to an untrusted frame length.
                    scan_limited = True
                    break
                data = response.read(size)
                if len(data) != size:
                    raise Unavailable("Incomplete Docker log frame")
                consumed += size + 8
                stop = feed("stdout" if header[0] == 1 else "stderr", data)
            if stop or consumed >= MAX_RAW:
                scan_limited = True
                break
        if not scan_limited:
            for stream, data in pending.items():
                if data:
                    line(stream, data)
    except (Deadline, TimeoutError, socket.timeout):
        scan_limited = True
    finally:
        conn.close()
    # Engine multiplexing can interleave stdout/stderr differently on each read.
    # Sort the complete bounded scan before paginating. Never promise continuation
    # through an incomplete scan: doing so could silently omit earlier timestamps.
    records.sort(key=lambda e: (e["time"], e["stream"], e["text"]))
    entries, output, last, ordinal, last_time = [], 0, None, 0, None
    output_limited = False
    search = q.get("search", "")
    if not q.get("caseSensitive"):
        search = search.lower()
    for entry in records:
        when = entry["time"]
        if when != last_time:
            ordinal = 0
            last_time = when
        ordinal += 1
        if cursor and ns(when) == ns(cursor["time"]) and ordinal <= cursor["skip"]:
            continue
        text = entry["text"]
        match = search in (text if q.get("caseSensitive") else text.lower()) and q.get("stream", "all") in ("all", entry["stream"])
        size = len(json.dumps(entry, ensure_ascii=True).encode())
        if match and (len(entries) >= MAX_LINES or output + size > MAX_OUTPUT):
            output_limited = True
            break
        last = {"containerId": meta["containerId"], "time": when, "skip": ordinal}
        if match:
            entries.append(entry)
            output += size
    resume = last if output_limited else {"containerId": meta["containerId"], "time": stamp(before), "skip": sum(e["time"] == stamp(before) for e in records)}
    return {**meta, "entries": entries, "truncated": scan_limited or output_limited, "nextCursor": last if output_limited and not scan_limited else None, "resumeCursor": (cursor if scan_limited else resume), "scannedBytes": consumed, "notice": "Only retained Docker stdout/stderr is available. Rotation may remove entries; absence does not prove no events occurred.", "incomplete": scan_limited}


def handle(docker, sources, value):
    q = query(value)
    if q["op"] == "sources":
        results = []
        for s in sources:
            try:
                meta = resolve(docker, s)
                results.append({"id": s["id"], "name": s["name"], "available": meta["driver"] != "none", **meta, **({"error": "Docker logging is disabled"} if meta["driver"] == "none" else {})})
            except Unavailable as e:
                results.append({"id": s["id"], "name": s["name"], "available": False, "error": str(e)})
        return {"sources": results}
    source = next((s for s in sources if s["id"] == q["source"]), None)
    if not source:
        raise ValueError("Source is not approved")
    return logs(docker, source, q)


def main():
    resource.setrlimit(resource.RLIMIT_AS, (192 * 1024**2, 192 * 1024**2))
    resource.setrlimit(resource.RLIMIT_CPU, (5, 5))
    resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(Deadline()))
    signal.alarm(8)
    if os.environ.get("SSH_ORIGINAL_COMMAND") != "hostboard-logs-v1":
        raise ValueError("Only hostboard-logs-v1 is permitted")
    slots = []
    for i in range(3):
        fd = os.open(f"/run/hostboard-logs/slot{i}", os.O_RDONLY)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            slots.append(fd)
            break
        except BlockingIOError:
            os.close(fd)
    if not slots:
        raise Unavailable("Log reader busy; retry shortly")
    with open("/etc/hostboard-logs.json", encoding="utf-8") as f:
        sources = config(json.load(f))
    raw = sys.stdin.buffer.read(4097)
    if len(raw) > 4096:
        raise ValueError("Query exceeds limit")
    result = handle(Docker(), sources, json.loads(raw))
    sys.stdout.write(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, Unavailable, Deadline, OSError, KeyError, TypeError, http.client.HTTPException):
        # Operational error details are limited to our own fixed messages.
        exc = sys.exc_info()[1]
        message = str(exc) if isinstance(exc, (ValueError, Unavailable)) and not isinstance(exc, json.JSONDecodeError) else "Log adapter unavailable or query timed out"
        sys.stdout.write(json.dumps({"error": message[:240]}))
        sys.exit(1)
