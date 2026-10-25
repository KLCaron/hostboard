# SPDX-License-Identifier: AGPL-3.0-only
"""Exercise the real SSH deployment body against isolated fake Docker/HTTP tools."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest


class DeploymentTests(unittest.TestCase):
    def exercise(self, fail_start=False, fail_health=False):
        with tempfile.TemporaryDirectory(prefix='hb-deploy-') as temporary:
            root=Path(temporary)/'deployment';root.mkdir()
            prior=root/'releases/prior';candidate=root/'releases/candidate'
            for p in [root/'config',root/'private',root/'data',prior/'deploy',candidate/'deploy',candidate/'config']:
                p.mkdir(parents=True,exist_ok=True)
            for p in [prior/'data',prior/'private']:
                p.symlink_to(root/p.name)
            (root/'current').symlink_to(prior)
            (root/'.env').write_text('HOSTBOARD_BIND=127.0.0.1\nHOSTBOARD_PORT=8088\n')
            (root/'private/admin.json').write_text('{"original":true}')
            for name in ['hosts','checks']:(root/'config'/f'{name}.json').write_text('{}')
            (prior/'deploy/compose.host.yaml').write_text('services: {}')
            (candidate/'deploy/compose.host.yaml').write_text('services: {}')
            dbpath=root/'data/monitor.sqlite'
            with sqlite3.connect(dbpath) as db:
                db.execute('create table recovery_probe(value text)');db.execute("insert into recovery_probe values('original')")
            binaries=Path(temporary)/'bin';binaries.mkdir();log=Path(temporary)/'docker.log'
            fake=r'''#!/usr/bin/python3
import sys,json,os,pathlib,sqlite3
root=pathlib.Path(os.environ['TEST_DEPLOY_ROOT']);args=sys.argv[1:]
with open(os.environ['TEST_DEPLOY_LOG'],'a') as out:out.write(json.dumps(args)+'\n')
if args[0]=='inspect':
 if '--format' in args:
  print('sha256:'+'a'*64 if args[args.index('--format')+1]=='{{.Image}}' else 'registry.example/app@sha256:'+'b'*64)
 else:print(json.dumps([{'Mounts':[{'Destination':'/app/'+n,'Source':str(root/'releases/prior'/n)} for n in ['private','data']]}]))
elif args[0]=='compose' and 'up' in args:
 if any(a.endswith('rollback-image.yaml') for a in args):sys.exit(0)
 with sqlite3.connect(root/'data/monitor.sqlite') as db:db.execute("update recovery_probe set value='candidate'")
 if os.environ['TEST_DEPLOY_FAIL_START']=='1':sys.exit(1)
'''
            docker=binaries/'docker';docker.write_text(fake);docker.chmod(0o700)
            for name,body in [('curl','exit '+('1' if fail_health else '0')),('sleep','exit 0')]:
                p=binaries/name;p.write_text('#!/bin/sh\n'+body+'\n');p.chmod(0o700)
            source=Path('scripts/deploy.sh').read_text().split("<<'REMOTE'\n",1)[1].rsplit('\nREMOTE',1)[0]
            source=source.replace('/srv/stacks/hostboard',str(root))
            env={**os.environ,'PATH':str(binaries)+':'+os.environ['PATH'],'TEST_DEPLOY_ROOT':str(root),'TEST_DEPLOY_LOG':str(log),'TEST_DEPLOY_FAIL_START':'1' if fail_start else '0'}
            result=subprocess.run(['bash','-s','--','candidate'],input=source,text=True,env=env,capture_output=True,timeout=10)
            checkpoint=root/'backups/pre-candidate'
            override=(checkpoint/'rollback-image.yaml').read_text()
            self.assertEqual(override,'services:\n  hostboard:\n    image: sha256:'+'a'*64+'\n')
            self.assertTrue((checkpoint/'monitor.sqlite').exists(),result.stderr+result.stdout)
            with sqlite3.connect(dbpath) as db:value=db.execute('select value from recovery_probe').fetchone()[0]
            calls=[json.loads(x) for x in log.read_text().splitlines()]
            if fail_start or fail_health:
                self.assertEqual(result.returncode,1,result.stderr)
                self.assertEqual(value,'original')
                self.assertEqual((root/'current').resolve(),prior)
                rollback=[args for args in calls if 'up' in args and any(x.endswith('rollback-image.yaml') for x in args)]
                self.assertEqual(len(rollback),1)
                self.assertIn('--no-build',rollback[0]);self.assertIn('--no-deps',rollback[0]);self.assertEqual(rollback[0][-1],'hostboard')
                self.assertEqual((root/'private/admin.json').read_text(),'{"original":true}')
            else:
                self.assertEqual(result.returncode,0,result.stderr)
                self.assertEqual((root/'current').resolve(),candidate)
                self.assertEqual(value,'candidate')

    def test_accepts_symlinked_shared_mounts_and_advances_only_after_health(self):
        self.exercise()

    def test_failed_container_start_restores_paired_database_and_actual_running_image(self):
        self.exercise(fail_start=True)

    def test_failed_health_restores_paired_database_and_actual_running_image(self):
        self.exercise(fail_health=True)


if __name__=='__main__':unittest.main()
