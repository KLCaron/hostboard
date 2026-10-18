import http.server
import importlib.util
import json
import os
import subprocess
import socket
import urllib.error
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from notify import Queue
from watchdog import check, evaluate, fetch


class WatchdogTests(unittest.TestCase):
    def test_thresholds_and_monitoring_gaps(self):
        state = None
        for n in range(3):
            state = evaluate(state, False, 'unreachable', 1000 + n * 60)
            self.assertEqual(state['confirmedDown'], n == 2)
        self.assertEqual(state['startedAt'], 1000)
        self.assertFalse(evaluate(state, True, 'recovered', 1180)['confirmedDown'])
        self.assertEqual(evaluate(state, False, 'unreachable', 2000)['failures'], 1)

    def test_independent_check_detects_http_failure_stale_metrics_and_dead_monitor(self):
        state = {'fail': None}
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                if state['fail'] == self.path:
                    self.send_response(503); self.end_headers(); return
                value = {'status': 'ok'}
                if self.path == '/api/fleet':
                    value = {'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() - (120 if state['fail'] == 'stale' else 0))), 'hosts': [{'id': 'server', 'status': 'offline' if state['fail'] == 'netdata' else 'online'}]}
                self.send_response(200); self.end_headers(); self.wfile.write(json.dumps(value).encode())
            def log_message(self, *args): pass
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        url = f'http://127.0.0.1:{server.server_port}'
        self.assertIn('available', check(url, 'server'))
        for failure in ('/api/health', '/api/monitor-health', 'stale', 'netdata'):
            state['fail'] = failure
            with self.assertRaises(Exception): check(url, 'server')
        server.shutdown(); server.server_close(); thread.join()
        with self.assertRaises(Exception): check(url, 'server')

    def test_watchdog_queue_survives_restart_and_retries_without_hostboard(self):
        with tempfile.TemporaryDirectory() as d:
            config = Path(d) / 'smtp.json'; config.write_text('{}')
            filename = str(Path(d) / 'queue.sqlite')
            sent = []
            def failure(row): raise RuntimeError('do not expose this secret')
            queue = Queue(filename, str(config), failure)
            self.assertFalse(queue.transition('watchdog', 'server / Hostboard', False, 'healthy', now=1000))
            self.assertTrue(queue.transition('watchdog', 'server / Hostboard', True, 'unreachable', now=1060))
            self.assertFalse(queue.transition('watchdog', 'server / Hostboard', True, 'unreachable', now=1120))
            self.assertEqual(queue.flush(1120), {'failed': 1})
            queue.transition('watchdog', 'server / Hostboard', False, 'recovered', now=1130)
            self.assertEqual(queue.flush(1130), {'failed': 1, 'pending': 1})
            queue.db.close()
            queue = Queue(filename, str(config), lambda row: sent.append(dict(row)))
            self.assertEqual(queue.flush(1160), {'delivered': 2})
            self.assertEqual(len(sent), 2)
            self.assertIn('Elapsed outage: 70 seconds', sent[1]['body'])
            queue.flush(1170); self.assertEqual(len(sent), 2)
            queue.db.close()

    def test_watchdog_freshness_detects_timer_failure_even_when_status_server_runs(self):
        with tempfile.TemporaryDirectory() as d:
            status = Path(d) / 'status.json'
            status.write_text(json.dumps({'timestamp': time.time() - 600, 'checkedAt': 'stale'}))
            with socket.socket() as listener:
                listener.bind(('127.0.0.1', 0))
                port = listener.getsockname()[1]
            env = dict(os.environ, HOSTBOARD_WATCH_STATE=str(status), HOSTBOARD_WATCH_BIND='127.0.0.1', HOSTBOARD_WATCH_PORT=str(port))
            process = subprocess.Popen([sys.executable, str(Path(__file__).resolve().parents[1] / 'scripts/watchdog.py'), '--serve'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            url = f'http://127.0.0.1:{port}/health'
            try:
                deadline = time.time() + 5
                while time.time() < deadline:
                    try:
                        fetch(url)
                    except ValueError:
                        break
                    except OSError:
                        time.sleep(.05)
                else:
                    self.fail('Freshness endpoint did not start')
                with self.assertRaises(ValueError): fetch(url)
                status.write_text(json.dumps({'timestamp': time.time(), 'checkedAt': 'fresh', 'available': False}))
                self.assertEqual(fetch(url)['status'], 'ok')
            finally:
                process.terminate(); process.wait(timeout=5)

    def test_native_netdata_critical_recovery_deduplication(self):
        with tempfile.TemporaryDirectory() as d:
            queue = Queue(str(Path(d) / 'queue.sqlite'), str(Path(d) / 'missing'))
            queue.transition('netdata:host:cpu', 'CPU', True, 'critical', now=1000)
            queue.transition('netdata:host:cpu', 'CPU', True, 'critical repeated', now=1060)
            queue.transition('netdata:host:cpu', 'CPU', False, 'clear', now=1120)
            self.assertEqual(queue.summary(), {'disabled': 2})
            self.assertNotIn('secret', str([dict(r) for r in queue.db.execute('SELECT * FROM events')]))
            queue.db.close()


if __name__ == '__main__':
    unittest.main()
