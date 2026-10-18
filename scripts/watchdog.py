#!/usr/bin/env python3
"""Independent, read-only Hostboard check. Configure on a different machine."""
import datetime
import json
import os
from pathlib import Path
import sys
import urllib.request


def check(url, host_id):
    with urllib.request.urlopen(url.rstrip('/') + '/api/health', timeout=8) as response:
        if json.load(response).get('status') != 'ok':
            raise ValueError('Hostboard health endpoint did not report ok')
    with urllib.request.urlopen(url.rstrip('/') + '/api/fleet', timeout=20) as response:
        fleet = json.load(response)
    age = datetime.datetime.now(datetime.timezone.utc) - datetime.datetime.fromisoformat(fleet['generatedAt'].replace('Z', '+00:00'))
    if age.total_seconds() > 30 or age.total_seconds() < -60:
        raise ValueError('Hostboard returned an out-of-date fleet snapshot')
    host = next((h for h in fleet['hosts'] if h['id'] == host_id), None)
    if not host or host['status'] != 'online':
        raise ValueError('Hosting server is not reporting fresh Netdata metrics')
    return 'Hostboard HTTP and hosting-server metrics are available'


def main():
    state = {'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'available': False}
    try:
        state['message'] = check(os.environ['HOSTBOARD_WATCH_URL'], os.environ['HOSTBOARD_WATCH_HOST'])
        state['available'] = True
    except Exception as error:
        state['message'] = str(error)
    destination = Path(os.environ.get('HOSTBOARD_WATCH_STATE', '/var/lib/hostboard-watchdog/status.json'))
    previous = None
    if destination.exists():
        try:
            previous = json.loads(destination.read_text()).get('available')
        except (OSError, ValueError):
            pass
    temporary = destination.with_suffix('.tmp')
    temporary.write_text(json.dumps(state) + '\n')
    temporary.replace(destination)
    transition = 'changed' if previous != state['available'] else 'unchanged'
    print(f"Hostboard availability {transition}: {json.dumps(state)}", flush=True)
    return 0 if state['available'] else 1


if __name__ == '__main__':
    sys.exit(main())
