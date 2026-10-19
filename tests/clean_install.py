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
import sqlite3
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
PREVIOUS_IMAGE = os.environ.get('HOSTBOARD_PREVIOUS_IMAGE','ghcr.io/klcaron/hostboard@sha256:4cbffac2c76f353c365c057842cb8142a30b048de83de437e52227865b05512b')


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
        # Exercise the candidate lifecycle validator before a release commit too.
        shutil.copy2(ROOT/'scripts/backup_paths.py', root/'scripts/backup_paths.py')
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
            if docker('image','inspect','--format','{{.Id}}',PREVIOUS_IMAGE,capture=True,check=False).returncode != 0:
                docker('pull',PREVIOUS_IMAGE)
            docker('tag', PREVIOUS_IMAGE, initial)
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
            version = json.loads((root/'package.json').read_text())['version']
            assert f'HOSTBOARD_IMAGE=ghcr.io/klcaron/hostboard:{version}\n' in envfile.read_text(), 'Setup selected an obsolete release'
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
            # HB-007: genuine alternate private AND external data bind mounts.
            # Deliberately retain a different stale ./private to catch the original bug.
            compose('stop','hostboard')
            external_private=Path(directory)/'external-private'
            external_data=Path(directory)/'external-data'
            shutil.copytree(root/'private',external_private)
            shutil.copytree(root/'data',external_data)
            (external_private/'installation-marker').write_text('active')
            (root/'private/installation-marker').write_text('stale')
            text=envfile.read_text().replace('HOSTBOARD_PRIVATE_DIR=./private',f'HOSTBOARD_PRIVATE_DIR={external_private}').replace('HOSTBOARD_DATA_DIR=./data',f'HOSTBOARD_DATA_DIR={external_data}')
            envfile.write_text(text)
            compose('up','-d','--wait','--wait-timeout','90','hostboard');login()
            run('bash','scripts/manage.sh','backup','./backups/external')
            checkpoint=root/'backups/external'
            assert (checkpoint/'private/installation-marker').read_text()=='active'
            assert (checkpoint/'private/admin.json').read_bytes()==before
            assert all(p.stat().st_mode & 0o077 == 0 for p in (checkpoint/'private').rglob('*') if p.is_file())
            with sqlite3.connect(checkpoint/'monitor.sqlite') as db:
                assert db.execute('pragma integrity_check').fetchone()[0]=='ok'
                assert db.execute('select count(*) from service_config').fetchone()[0]==1
            # Missing/unreadable configuration refuses a backup without stopping the app.
            admin=external_private/'admin.json';admin.rename(external_private/'saved-admin')
            assert run('bash','scripts/manage.sh','backup','./backups/missing',check=False).returncode!=0
            (external_private/'saved-admin').rename(admin);admin.chmod(0)
            assert run('bash','scripts/manage.sh','backup','./backups/unreadable',check=False).returncode!=0
            admin.chmod(0o600)
            (external_private/'installation-marker').write_text('changed')
            run('bash','scripts/manage.sh','rollback','./backups/external');login()
            assert (external_private/'installation-marker').read_text()=='active'
            assert (root/'private/installation-marker').read_text()=='stale'
            assert api('/api/admin/config')[1]['checks'][0]['id']==check_id
            container_id=compose('ps','-q','hostboard',capture=True).stdout.strip()
            corrupt=root/'backups/corrupt';shutil.copytree(checkpoint,corrupt)
            (corrupt/'monitor.sqlite').write_bytes(b'corrupt checkpoint')
            assert run('bash','scripts/manage.sh','rollback','./backups/corrupt',check=False).returncode!=0
            assert compose('ps','-q','hostboard',capture=True).stdout.strip()==container_id
            print('PASS HB-007: actual alternate-private/external-data Docker mounts, stale local configuration excluded, missing/unreadable rejection, paired restore, restrictive permissions, corrupt restore rejection.',flush=True)
            run('bash','scripts/manage.sh','upgrade',upgraded,'./backups/before-upgrade')
            login()
            assert api('/api/admin/config')[1]['checks'][0]['id']==check_id
            with sqlite3.connect(root/'backups/before-upgrade/monitor.sqlite') as db:
                previous_schema=db.execute('pragma user_version').fetchone()[0]
                assert previous_schema in (1,2,3)
                old_samples=db.execute('select count(*) from samples').fetchone()[0]
            with sqlite3.connect(external_data/'monitor.sqlite') as db:
                assert db.execute('pragma user_version').fetchone()[0]==4
                assert db.execute('select count(*) from samples where generation=1').fetchone()[0]>=old_samples
            print(f'PASS: real preserved image/schema{previous_schema} to candidate image/schema4 migration with retained observations.',flush=True)
            # Create a real outage/incident, observe unavailable Agent, then restore.
            compose('stop','fixture')
            for _ in range(25):
                status=api('/api/monitor')[1]
                if status['incidents']:break
                time.sleep(1)
            assert status['incidents'],status
            # Fleet responses can initially show the bounded pending-refresh placeholder.
            # Wait for the independent request timeout to establish definitive offline state.
            for _ in range(20):
                unavailable=api('/api/fleet')[1]['hosts'][0]
                if unavailable['status']=='offline': break
                time.sleep(0.5)
            assert unavailable['status']=='offline',unavailable
            run('bash','scripts/manage.sh','backup','./backups/with-incident')
            run('bash','scripts/manage.sh','rollback','./backups/with-incident')
            login()
            assert api('/api/monitor')[1]['incidents'][0]['id']==status['incidents'][0]['id']
            run('bash','scripts/manage.sh','rollback','./backups/before-upgrade')
            login()
            restored=api('/api/admin/config')[1]
            assert restored['checks'][0]['id']==check_id and restored['settings']['general']['temperature']=='F'
            saved_image=(root/'backups/before-upgrade/image.txt').read_text().split()[1]
            assert saved_image in (root/'.env').read_text()
            assert docker('inspect','--format','{{.Image}}',compose('ps','-q','hostboard',capture=True).stdout.strip(),capture=True).stdout.strip()==saved_image
            with sqlite3.connect(external_data/'monitor.sqlite') as db:
                assert db.execute('pragma user_version').fetchone()[0]==previous_schema
            compose('start','fixture')
            print('PASS: clean clone, image installation, database initialization, Agent connection, authorization/CSRF, check creation, recreation, image pull/upgrade, private backup, incident recovery, paired rollback, and unavailable-Agent handling.', flush=True)
        finally:
            compose('logs','--tail','30','hostboard',check=False)
            compose('down','--volumes','--remove-orphans',check=False)
            for ref in [f'localhost:{registry_port}/hostboard:initial', f'localhost:{registry_port}/hostboard:upgrade']:
                docker('image','rm',ref,check=False)

if __name__ == '__main__':
    main()
