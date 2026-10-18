#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Real Docker API acceptance; uses only disposable controlled fixtures. Needs socket access."""
import datetime as dt
import importlib.util
import json
import subprocess
import time
import uuid
spec=importlib.util.spec_from_file_location('adapter','scripts/log-adapter.py')
a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
name='hb-log-test-'+uuid.uuid4().hex[:10]
source={'id':'fixture','name':'Fixture','labels':{'hostboard.test':name}}
def docker(*args):return subprocess.check_output(['docker',*args],text=True).strip()
def run(tty=False):
    script="for(let i=0;i<1100;i++){const text=JSON.stringify({level:i%2?'error':'info',message:'Fixture '+i});(i%2?process.stderr:process.stdout).write(text+'\\n');}console.log('\\x1b[31mANSI fixture\\x1b[0m');console.log('multiline first\\nmultiline second');console.log('x'.repeat(40000));console.log('<script>globalThis.LOG_XSS=true</script>');setInterval(()=>console.log('live fixture'),1000);"
    return docker('run','-d',*(['-t'] if tty else []),'--name',name,'--label','hostboard.test='+name,'--log-driver','json-file','--log-opt','max-size=1m','--log-opt','max-file=2','node:24-alpine','node','-e',script)
start=a.stamp(time.time_ns()-10**9)
try:
    cid=run();time.sleep(2)
    q={'op':'query','source':'fixture','after':start,'before':a.stamp(time.time_ns()),'search':'"message":"Fixture'}
    all_entries=[];cursor=None
    for _ in range(10):
        r=a.handle(a.Docker(),[source],q|({'cursor':cursor} if cursor else {}))
        all_entries.extend(r['entries']);cursor=r['nextCursor']
        if not cursor:break
    assert len(all_entries)==1100,len(all_entries)
    assert {e['stream'] for e in all_entries}=={'stdout','stderr'}
    assert {json.loads(e['text'])['message'] for e in all_entries}=={'Fixture '+str(i) for i in range(1100)}
    # Exact inclusive boundaries, both source streams, and server-side search.
    boundary=all_entries[500]['time']
    r=a.handle(a.Docker(),[source],q|{'after':boundary,'search':'"message":"Fixture','caseSensitive':True})
    assert a.ns(r['entries'][0]['time'])>=a.ns(boundary)
    assert not a.handle(a.Docker(),[source],q|{'search':'"message":"fixture','caseSensitive':True})['entries']
    r=a.handle(a.Docker(),[source],q|{'search':'','stream':'stderr'})
    assert all(e['stream']=='stderr' for e in r['entries'])
    r=a.handle(a.Docker(),[source],q|{'search':'multiline'})
    assert len(r['entries'])==2
    r=a.handle(a.Docker(),[source],q|{'search':'ANSI'})
    assert r['entries'][0]['text']=='ANSI fixture'
    r=a.handle(a.Docker(),[source],q|{'search':'xxxx'})
    assert r['entries'][0]['truncated']
    live=a.handle(a.Docker(),[source],q|{'search':'live fixture','before':a.stamp(time.time_ns())})
    time.sleep(1.5)
    follow=a.handle(a.Docker(),[source],q|{'search':'live fixture','before':a.stamp(time.time_ns()),'cursor':live['resumeCursor']})
    assert follow['entries'] and not set(e['time'] for e in live['entries'])&set(e['time'] for e in follow['entries'])
    original_cursor=follow['resumeCursor']
    docker('rm','-f',name)
    run(True);time.sleep(1)
    try:a.handle(a.Docker(),[source],q|{'cursor':original_cursor,'before':a.stamp(time.time_ns())})
    except a.Unavailable as e:assert 'replaced' in str(e)
    else:raise AssertionError('recreation not detected')
    r=a.handle(a.Docker(),[source],q|{'before':a.stamp(time.time_ns())})
    assert r['tty'] and {e['stream'] for e in r['entries']}=={'combined'}
    docker('rm','-f',name)
    try:a.handle(a.Docker(),[source],q)
    except a.Unavailable:pass
    else:raise AssertionError('removed source not detected')
    print('Real Docker acceptance passed: 1,100 entries, pagination, nanosecond boundaries, stdout/stderr, search, ANSI/large entries, incremental follow, recreation, TTY, removal')
finally:
    subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
