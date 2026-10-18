"""Real disposable Compose acceptance test. Requires Docker, Git and Python 3.

HOSTBOARD_TEST_IMAGE selects a previously built/published image. DOCKER may be
'sudo -n docker' on hosts where the current user cannot access the daemon.
All services, networks and temporary configuration are removed in finally.
"""
import http.cookiejar
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DOCKER = shlex.split(os.environ.get('DOCKER', 'docker'))
if DOCKER[0] == 'sudo':
    DOCKER.insert(1, '--preserve-env=COMPOSE_FILE,COMPOSE_PROJECT_NAME,HOSTBOARD_IMAGE')
IMAGE = os.environ.get('HOSTBOARD_TEST_IMAGE', 'hostboard:ci')


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def main():
    with tempfile.TemporaryDirectory(prefix='hostboard-clean-') as directory:
        root = Path(directory) / 'install'
        subprocess.run(['git', 'clone', '--quiet', '--no-hardlinks', str(ROOT), str(root)], check=True)
        assert not (root / '.env').exists() and not (root / 'private').exists()
        port, registry_port = free_port(), free_port()
        project = 'hb-test-' + secrets.token_hex(4)
        env = {**os.environ, 'COMPOSE_PROJECT_NAME': project,
               'COMPOSE_FILE': 'compose.yaml:compose.test.yaml'}
        # The scripts use `docker` directly, so a tiny wrapper supports sudo in local tests.
        if len(DOCKER) > 1:
            binary = Path(directory) / 'bin'
            binary.mkdir()
            (binary / 'docker').write_text('#!/bin/sh\nexec ' + shlex.join(DOCKER) + ' "$@"\n')
            (binary / 'docker').chmod(0o755)
            env['PATH'] = str(binary) + ':' + env['PATH']
        # Do not leak an external image override into lifecycle scripts under test.
        env.pop('HOSTBOARD_IMAGE', None)
        def run(*args, capture=False, check=True):
            return subprocess.run(args, cwd=root, env=env, check=check,
                                  stdout=subprocess.PIPE if capture else None, text=True)
        def docker(*args, **kwargs):
            return run(*DOCKER, *args, **kwargs)
        def compose(*args, **kwargs):
            return docker('compose', *args, **kwargs)
        (root / 'compose.test.yaml').write_text('''services:
  fixture:
    image: node:24-alpine
    command: [node, /fixtures/fixture-agent.ts]
    environment:
      FIXTURE_BIND: 0.0.0.0
    volumes:
      - ./tests:/fixtures:ro
    read_only: true
  registry:
    image: registry:3
    ports:
      - "127.0.0.1:%s:5000"
''' % registry_port)
        base = f'http://localhost:{port}'
        password = secrets.token_urlsafe(24)
        answers = {'origin': base, 'port': port, 'username': 'operator', 'password': password,
                   'hosts': [{'id': 'server-a', 'name': 'Example server', 'node': 'fixture-server',
                              'url': 'http://fixture:19999'}],
                   'targets': [{'host': 'fixture', 'port': 19999, 'addresses': []}]}
        jar = http.cookiejar.CookieJar()
        client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar), NoRedirect())
        def request(route, data=None, headers=None, method=None, anonymous=False):
            req = urllib.request.Request(base+route, data=data, headers=headers or {}, method=method)
            try:
                response = (urllib.request.build_opener(NoRedirect()) if anonymous else client).open(req, timeout=25)
            except urllib.error.HTTPError as response:
                return response.code, response.read()
            return response.status, response.read()
        def api(route, value=None, method=None, anonymous=False, origin=base):
            code, body = request(route, None if value is None else json.dumps(value).encode(),
                                 {'Content-Type': 'application/json', 'Origin': origin, 'X-Hostboard-Request': '1'}, method, anonymous)
            return code, json.loads(body)
        def login():
            code, page = request('/auth/login')
            assert code == 200
            token = re.search(rb'name="csrf" value="([a-f0-9]+)"', page)[1].decode()
            code, _ = request('/auth/login', urllib.parse.urlencode({'username':'operator','password':password,'csrf':token}).encode(),
                              {'Content-Type':'application/x-www-form-urlencoded','Origin':base})
            assert code == 303, code
        try:
            compose('up', '-d', 'fixture', 'registry')
            for _ in range(30):
                try:
                    urllib.request.urlopen(f'http://127.0.0.1:{registry_port}/v2/', timeout=2)
                    break
                except (OSError, urllib.error.URLError):
                    time.sleep(1)
            initial = f'localhost:{registry_port}/hostboard:initial'
            upgraded = f'localhost:{registry_port}/hostboard:upgrade'
            docker('tag', IMAGE, initial)
            docker('tag', IMAGE, upgraded)
            docker('push', initial)
            docker('push', upgraded)
            # Resolve the controlled target inside this project's network, then approve it.
            ip = compose('exec', '-T', 'fixture', 'node', '-e',
                         "require('dns').lookup('fixture',(e,a)=>{if(e)process.exit(1);console.log(a)})", capture=True).stdout.strip()
            answers['targets'][0]['addresses'] = [ip]
            answers['targets'].append({'host':ip, 'port':19999, 'addresses':[ip]})
            answer_file = root / 'answers.json'
            answer_file.write_text(json.dumps(answers))
            answer_file.chmod(0o600)
            setup_env = {**env, 'HOSTBOARD_IMAGE': IMAGE}
            subprocess.run(['bash', 'scripts/setup.sh', '--answers', '/setup/answers.json'], cwd=root, env=setup_env, check=True)
            answer_file.unlink()
            # Setup is repeat-safe, with explicit validation rather than replacing credentials.
            subprocess.run(['bash','scripts/setup.sh','--check'],cwd=root,env=setup_env,check=True)
            before = (root/'private/admin.json').read_bytes()
            repeated = subprocess.run(['bash','scripts/setup.sh'],cwd=root,env=setup_env,stdin=subprocess.DEVNULL)
            assert repeated.returncode != 0 and before == (root/'private/admin.json').read_bytes()
            envfile = root/'.env'
            envfile.write_text(re.sub(r'^HOSTBOARD_IMAGE=.*$', 'HOSTBOARD_IMAGE='+initial, envfile.read_text(), flags=re.MULTILINE))
            compose('config', '--quiet')
            compose('up','-d','--wait','--wait-timeout','90','hostboard')
            assert api('/api/fleet',anonymous=True)[0] == 401
            assert api('/api/admin/settings',{},'PUT',anonymous=True)[0] == 401
            login()
            code,fleet=api('/api/fleet'); assert code==200 and fleet['hosts'][0]['status']=='online',fleet
            config=api('/api/admin/config')[1]
            check={'name':'Acceptance check','hostId':'server-a','group':'Applications','type':'http','url':f'http://{ip}:19999/health','notify':False,'failureThreshold':1,'intervalSeconds':10}
            assert api('/api/admin/checks',{'revision':config['revision'],'definition':check,'enabled':True},'POST',origin='https://evil.example')[0] == 403
            code,added=api('/api/admin/checks',{'revision':config['revision'],'definition':check,'enabled':True},'POST');assert code==201,added
            check_id=added['id']
            for _ in range(20):
                monitor=api('/api/monitor')[1]
                if monitor['checks'] and monitor['checks'][0]['state']=='up':break
                time.sleep(1)
            assert monitor['checks'][0]['state']=='up',monitor
            config=api('/api/admin/config')[1]
            settings=config['settings']; settings['general']['temperature']='F'
            assert api('/api/admin/settings',{'revision':config['revision'],'settings':settings},'PUT')[0]==200
            compose('up','-d','--force-recreate','--wait','--wait-timeout','90','hostboard')
            login()
            persisted=api('/api/admin/config')[1]
            assert persisted['settings']['general']['temperature']=='F' and persisted['checks'][0]['id']==check_id
            run('bash','scripts/manage.sh','backup','./backups/manual')
            assert (root/'backups/manual/monitor.sqlite').stat().st_mode & 0o077 == 0
            run('bash','scripts/manage.sh','upgrade',upgraded,'./backups/before-upgrade')
            login()
            assert api('/api/admin/config')[1]['checks'][0]['id']==check_id
            # Create a real outage/incident, observe unavailable Agent, then restore.
            compose('stop','fixture')
            for _ in range(25):
                status=api('/api/monitor')[1]
                if status['incidents']:break
                time.sleep(1)
            assert status['incidents'],status
            assert api('/api/fleet')[1]['hosts'][0]['status']=='offline'
            run('bash','scripts/manage.sh','backup','./backups/with-incident')
            run('bash','scripts/manage.sh','rollback','./backups/with-incident')
            login()
            assert api('/api/monitor')[1]['incidents'][0]['id']==status['incidents'][0]['id']
            run('bash','scripts/manage.sh','rollback','./backups/before-upgrade')
            login()
            restored=api('/api/admin/config')[1]
            assert restored['checks'][0]['id']==check_id and restored['settings']['general']['temperature']=='F'
            assert initial in (root/'.env').read_text()
            compose('start','fixture')
            print('PASS: clean clone, image installation, database initialization, Agent connection, authorization/CSRF, check creation, recreation, image pull/upgrade, private backup, incident recovery, paired rollback, and unavailable-Agent handling.', flush=True)
        finally:
            compose('logs','--tail','30','hostboard',check=False)
            compose('down','--volumes','--remove-orphans',check=False)
            for ref in [f'localhost:{registry_port}/hostboard:initial', f'localhost:{registry_port}/hostboard:upgrade']:
                docker('image','rm',ref,check=False)

if __name__ == '__main__':
    main()
