#!/usr/bin/env python3
"""Independent Hostboard supervision. Run on another host with direct SMTP."""
import argparse
import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import socket
import sys
import time
import urllib.request
from notify import Queue


def fetch(url, timeout=8):
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    try:
        with urllib.request.build_opener(NoRedirect).open(url, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        error.close()
        raise ValueError('Monitoring endpoint returned an unsuccessful HTTP status') from None


def check(url, host_id):
    if fetch(url.rstrip('/') + '/api/health').get('status') != 'ok':
        raise ValueError('Hostboard HTTP health is unavailable')
    if os.environ.get('HOSTBOARD_WATCH_REQUIRE_MONITOR', '1') != '0' and fetch(url.rstrip('/') + '/api/monitor-health').get('status') != 'ok':
        raise ValueError('Hostboard service monitor is unavailable')
    fleet = fetch(url.rstrip('/') + '/api/fleet', 15)
    generated = datetime.datetime.fromisoformat(fleet['generatedAt'].replace('Z', '+00:00')).timestamp()
    if not -60 <= time.time() - generated <= 30:
        raise ValueError('Hostboard fleet snapshot is stale')
    host = next((h for h in fleet['hosts'] if h['id'] == host_id), None)
    if not host or host['status'] != 'online':
        raise ValueError('Hosting server Netdata metrics are unavailable or stale')
    return 'Hostboard HTTP, check scheduler and hosting-server Netdata metrics are available'


def evaluate(previous, ok, reason, now, threshold=3, max_gap=180):
    previous = previous or {}
    gap = now - previous.get('timestamp', now) > max_gap
    failures = 0 if ok else (0 if gap else previous.get('failures', 0)) + 1
    started = None if ok else previous.get('startedAt') if failures > 1 else now
    return {'timestamp': now, 'checkedAt': datetime.datetime.fromtimestamp(now, datetime.timezone.utc).isoformat(),
            'available': ok, 'confirmedDown': not ok and failures >= threshold, 'failures': failures,
            'startedAt': started, 'message': reason, 'monitoringGap': gap}


def serve():
    destination = Path(os.environ.get('HOSTBOARD_WATCH_STATE', '/var/lib/hostboard-watchdog/status.json'))
    bind = os.environ.get('HOSTBOARD_WATCH_BIND', '127.0.0.1')
    import ipaddress
    address = ipaddress.ip_address(bind)
    if not (address.is_private or address.is_loopback) or address.is_unspecified:
        raise ValueError('Watchdog status listener must be private or loopback')
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path != '/health':
                self.send_error(404)
                return
            try:
                state = json.loads(destination.read_text())
                fresh = 0 <= time.time() - state['timestamp'] < 180
                payload = json.dumps({'status': 'ok' if fresh else 'stale', 'checkedAt': state['checkedAt'], 'notificationDelivery': state.get('notifications', {}), 'incidents': state.get('incidents', [])}).encode()
            except (OSError, ValueError, KeyError):
                fresh = False
                payload = b'{"status":"unavailable"}'
            self.send_response(200 if fresh else 503)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        def log_message(self, *args):
            pass
    ThreadingHTTPServer((bind, int(os.environ.get('HOSTBOARD_WATCH_PORT', '8090'))), Handler).serve_forever()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--serve', action='store_true')
    args = parser.parse_args()
    if args.serve:
        serve()
        return 0
    destination = Path(os.environ.get('HOSTBOARD_WATCH_STATE', '/var/lib/hostboard-watchdog/status.json'))
    try:
        previous = json.loads(destination.read_text())
    except (OSError, ValueError):
        previous = None
    try:
        reason = check(os.environ['HOSTBOARD_WATCH_URL'], os.environ['HOSTBOARD_WATCH_HOST'])
        ok = True
    except Exception as error:
        ok = False
        reason = str(error) if isinstance(error, ValueError) and not isinstance(error, json.JSONDecodeError) else 'Hostboard or hosting-server monitoring unavailable'
        host = os.environ.get('HOSTBOARD_WATCH_ADDRESS')
        if host:
            try:
                with socket.create_connection((host, 22), timeout=3):
                    reason += '; hosting-server SSH listener reachable'
            except OSError:
                reason += '; hosting-server SSH listener also unreachable (host or network failure)'
    state = evaluate(previous, ok, reason, time.time(), int(os.environ.get('HOSTBOARD_WATCH_THRESHOLD', '3')))
    queue = Queue(str(destination.with_name('notifications.sqlite')))
    if ok or state['confirmedDown']:
        label = os.environ.get('HOSTBOARD_WATCH_LABEL', os.environ['HOSTBOARD_WATCH_HOST'] + ' / Hostboard availability')
        queue.transition('hostboard-availability', label, not ok, reason, started=state['startedAt'], cooldown=int(os.environ.get('HOSTBOARD_WATCH_COOLDOWN', '900')))
    state['notifications'] = queue.flush(limit=1)
    state['incidents'] = queue.history()
    temporary = destination.with_suffix('.tmp')
    temporary.write_text(json.dumps(state) + '\n')
    temporary.replace(destination)
    print(json.dumps({k: v for k, v in state.items() if k != 'incidents'}), flush=True)
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
