# SPDX-License-Identifier: AGPL-3.0-only
import importlib.util
import io
import json
import struct
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('adapter', 'scripts/log-adapter.py')
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)
CID = 'a' * 64
SOURCE = {'id': 'web', 'name': 'Web', 'labels': {'com.docker.compose.project': 'test', 'com.docker.compose.service': 'web'}}
START = '2026-01-01T00:00:00.000000000Z'
END = '2026-01-01T00:15:00.000000000Z'

def frame(text, stream=1):
    b = text if isinstance(text, bytes) else text.encode()
    return bytes([stream, 0, 0, 0]) + struct.pack('>I', len(b)) + b

class Docker:
    def __init__(self, body=b'', tty=False):
        self.body, self.tty, self.routes, self.closed = body, tty, [], False
    def json(self, route):
        self.routes.append(route)
        if route.startswith('/containers/json?'):
            return [{'Id': CID, 'Labels': SOURCE['labels']}]
        if route == '/containers/' + CID + '/json':
            return {'Name':'/test-web-1','Created':START,'HostConfig':{'LogConfig':{'Type':'json-file'}},'Config':{'Tty':self.tty}}
        raise AssertionError(route)
    def get(self, route):
        self.routes.append(route)
        return self, io.BytesIO(self.body)
    def close(self):
        self.closed = True

class AdapterTest(unittest.TestCase):
    def q(self, **kw):
        return dict(op='query',source='web',after=START,before=END,**kw)
    def test_protocol_denies_arbitrary_operations_and_unknown_fields(self):
        for q in [{'op':'exec'}, {'op':'query','source':'../x'}, {'op':'sources','url':'http://daemon'}, self.q(path='/etc/passwd'), self.q(search='x'*257), self.q(caseSensitive=1), self.q(cursor={'containerId':CID,'time':START,'skip':100001})]:
            with self.assertRaises(ValueError):a.query(q)
        with self.assertRaises(ValueError):a.handle(Docker(),[SOURCE],self.q()|{'source':'other'})
        with self.assertRaises(ValueError):a.config({'sources':[SOURCE|{'containerId':CID}]})
    def test_exact_nanosecond_boundaries_streams_search_and_sanitization(self):
        body=frame(START+' INFO hello\n')+frame('2026-01-01T00:00:00.000000001Z ERROR bad\x1b[31m red\x1b[0m\x00\n',2)+frame(END+' last\n')+frame('2026-01-01T00:15:00.000000001Z outside\n')
        d=Docker(body)
        r=a.handle(d,[SOURCE],self.q())
        self.assertEqual([e['stream'] for e in r['entries']],['stdout','stderr','stdout'])
        self.assertEqual(r['entries'][1]['text'],'ERROR bad red')
        self.assertEqual(r['entries'][-1]['time'],END)
        self.assertTrue(d.closed)
        r=a.handle(Docker(body),[SOURCE],self.q(search='error',stream='stderr'))
        self.assertEqual(len(r['entries']),1)
        self.assertEqual(len(a.handle(Docker(body),[SOURCE],self.q(search='error',caseSensitive=True))['entries']),0)
        self.assertTrue(all('/containers/' in route for route in d.routes))
        self.assertIn('follow=0',d.routes[-1])
    def test_pagination_same_timestamp_has_no_duplicates_or_loss(self):
        body=b''.join(frame(START+f' line {i}\n',1+i%2) for i in range(1100))
        first=a.handle(Docker(body),[SOURCE],self.q())
        second=a.handle(Docker(body),[SOURCE],self.q(cursor=first['nextCursor']))
        third=a.handle(Docker(body),[SOURCE],self.q(cursor=second['nextCursor']))
        self.assertEqual(len(first['entries']),500)
        self.assertEqual(len(second['entries']),500)
        self.assertEqual(len(third['entries']),100)
        self.assertFalse(third['truncated'])
        self.assertEqual({e['text'] for r in [first,second,third] for e in r['entries']},{f'line {i}' for i in range(1100)})
    def test_large_invalid_multiline_and_tty(self):
        body=frame(START.encode()+b' '+b'x'*40000+b'\n')+frame(START.encode()+b' bad\xff\n')
        r=a.handle(Docker(body),[SOURCE],self.q())
        self.assertTrue(any(e['truncated'] for e in r['entries']))
        self.assertLess(max(len(e['text']) for e in r['entries']),16500)
        self.assertTrue(any('\ufffd' in e['text'] for e in r['entries']))
        r=a.handle(Docker((START+' tty\n').encode(),True),[SOURCE],self.q())
        self.assertEqual(r['entries'][0]['stream'],'combined')
        with self.assertRaises(a.Unavailable):a.handle(Docker(b'\x03'+b'\0'*7),[SOURCE],self.q())
    def test_byte_and_scan_limits_and_container_replacement(self):
        body=b''.join(frame(START+' '+('x'*12000)+'\n') for _ in range(500))
        r=a.handle(Docker(body),[SOURCE],self.q())
        self.assertTrue(r['truncated'])
        self.assertLess(len(json.dumps(r)),700000)
        r=a.handle(Docker(body),[SOURCE],self.q(search='not present'))
        self.assertTrue(r['truncated'])
        self.assertLessEqual(r['scannedBytes'],a.MAX_RAW+8)
        with self.assertRaises(a.Unavailable):a.handle(Docker(),[SOURCE],self.q(cursor={'containerId':'b'*64,'time':START,'skip':1}))
        d=Docker()
        d.json=lambda _:[]
        with self.assertRaises(a.Unavailable):a.resolve(d,SOURCE)
    def test_query_duration_and_disconnect_close_transport(self):
        class Timed(io.BytesIO):
            def read(self,*args):raise a.Deadline()
        d=Docker()
        d.get=lambda _:(d,Timed())
        r=a.handle(d,[SOURCE],self.q())
        self.assertTrue(r['truncated'] and r['incomplete'] and d.closed)
        class Disconnected(io.BytesIO):
            def read(self,*args):raise ConnectionResetError()
        d.get=lambda _:(d,Disconnected())
        with self.assertRaises(ConnectionResetError):a.handle(d,[SOURCE],self.q())
        self.assertTrue(d.closed)
