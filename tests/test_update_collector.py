# SPDX-License-Identifier: AGPL-3.0-only
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace as N
import unittest
import urllib.error
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('updates', Path(__file__).parents[1] / 'scripts/update-collector.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

def origin(archive='noble-updates', trusted=True, source='Ubuntu', label='Ubuntu'):
    return N(archive=archive, trusted=trusted, origin=source, label=label, site='archive.ubuntu.com', component='main')

def pkg(name='example', versions=None):
    candidate=N(version='3', origins=[origin()])
    return N(name=name, is_installed=True, is_upgradable=True, installed=N(version='1'),
             candidate=candidate, versions=versions or [candidate])

def digest(x):
    return 'sha256:' + hashlib.sha256(x).hexdigest()

class PackageTests(unittest.TestCase):
    def test_zero_pending_and_versions(self):
        self.assertEqual(m.package_inventory([], lambda a,b:int(a)-int(b)), [])
        p=m.package_inventory([pkg()],lambda a,b:int(a)-int(b))[0]
        self.assertEqual((p['installed'],p['available'],p['security']),('1','3',False))
        self.assertIn('Ubuntu/noble-updates/main/archive.ubuntu.com',p['sources'])

    def test_security_metadata_and_superseding_fix(self):
        p=pkg('not-a-security-name',[N(version='2',origins=[origin('noble-security')])])
        self.assertTrue(m.package_inventory([p],lambda a,b:int(a)-int(b))[0]['security'])
        self.assertFalse(m.security_origin(origin()))
        self.assertTrue(m.security_origin(origin('stable-security',source='Debian',label='Debian-Security')))
        self.assertIsNone(m.security_origin(origin('noble-security',trusted=False)))
        self.assertIsNone(m.security_origin(origin('security',source='Other')))
        self.assertFalse(m.package_inventory([pkg('security-fix')],lambda a,b:int(a)-int(b))[0]['security'])

    def test_reboot_freshness_and_unsupported(self):
        import sys
        fake_apt=N(Cache=lambda **kw: []); fake_pkg=N(version_compare=lambda a,b:0)
        with patch.dict(sys.modules,{'apt':fake_apt,'apt_pkg':fake_pkg}), patch.object(m.Path,'exists',return_value=True), patch.object(m.Path,'is_file',return_value=True), patch.object(m.Path,'stat',return_value=N(st_mtime=m.time.time())):
            result=m.collect_packages(); self.assertEqual(result['state'],'ok'); self.assertTrue(result['rebootRequired'])
        with patch.dict(sys.modules,{'apt':fake_apt,'apt_pkg':fake_pkg}), patch.object(m.Path,'exists',side_effect=lambda p=None: True), patch.object(m.Path,'is_file',return_value=False):
            result=m.collect_packages();self.assertEqual(result['state'],'stale');self.assertIsNone(result['metadataAt'])
        with patch.object(m.Path,'exists',return_value=False):
            self.assertEqual(m.collect_packages()['state'],'unsupported')
        with patch.dict(sys.modules,{'apt':None}):
            with patch.object(m.Path,'exists',return_value=True):
                self.assertEqual(m.collect_packages()['state'],'unavailable')

class RegistryTests(unittest.TestCase):
    def setUp(self):
        self.image={'Os':'linux','Architecture':'amd64','RepoDigests':['example@sha256:'+'a'*64]}
        self.container={'Id':'b'*64,'Image':'sha256:'+'a'*64,'Config':{'Image':'example:latest','Labels':{'com.docker.compose.project':'web','com.docker.compose.service':'app'}}}

    def test_changed_unchanged_and_special_images(self):
        registry=N(resolve=lambda *args:('sha256:'+'c'*64,'sha256:'+'d'*64))
        self.assertEqual(m.service_status(self.container,self.image,registry)['state'],'update')
        registry.resolve=lambda *args:('sha256:'+'c'*64,self.container['Image'])
        self.assertEqual(m.service_status(self.container,self.image,registry)['state'],'current')
        self.container['Config']['Image']='example@sha256:'+'a'*64
        self.assertEqual(m.service_status(self.container,self.image,registry)['state'],'pinned')
        self.container['Config']['Image']='example:latest';self.image['RepoDigests']=[]
        self.assertEqual(m.service_status(self.container,self.image,registry)['state'],'local')

    def test_containerd_index_id_is_never_compared_to_an_image_config(self):
        self.image['Descriptor']={'digest':self.container['Image'],'mediaType':'application/vnd.oci.image.index.v1+json'}
        deployed='sha256:'+'c'*64
        self.container['ImageManifestDescriptor']={'digest':deployed,'platform':{'os':'linux','architecture':'amd64'}}
        registry=N(resolve=lambda *a:(deployed,'sha256:'+'e'*64))
        result=m.service_status(self.container,self.image,registry,True)
        self.assertEqual(result['state'],'current');self.assertIsNone(result['deployedConfig']);self.assertEqual(result['deployedManifest'],deployed)
        registry.resolve=lambda *a:('sha256:'+'d'*64,'sha256:'+'e'*64)
        result=m.service_status(self.container,self.image,registry,True)
        self.assertEqual(result['state'],'update');self.assertIn('newer software version is not confirmed',result['message'])
        del self.container['ImageManifestDescriptor']
        result=m.service_status(self.container,self.image,registry,True)
        self.assertEqual(result['state'],'unavailable');self.assertIsNone(result['checkedAt'])
        del self.image['Descriptor']
        self.assertEqual(m.service_status(self.container,self.image,registry,True)['state'],'unavailable')

    def test_platform_index_and_verified_config(self):
        config=json.dumps({'os':'linux','architecture':'amd64'}).encode(); config_digest=digest(config)
        manifest=json.dumps({'schemaVersion':2,'config':{'digest':config_digest}}).encode(); manifest_digest=digest(manifest)
        index=json.dumps({'schemaVersion':2,'manifests':[{'digest':manifest_digest,'platform':{'os':'linux','architecture':'amd64'}},{'digest':'sha256:'+'e'*64,'platform':{'os':'linux','architecture':'arm64'}}]}).encode()
        r=m.Registry({'registry-1.docker.io':{}})
        responses={'latest':index,manifest_digest:manifest,config_digest:config}
        r.get=lambda url,headers,*args:responses[url.rsplit('/',1)[1]]
        self.assertEqual(r.resolve('example:latest','linux','amd64',''),(manifest_digest,config_digest))
        self.assertLessEqual(len(r.cache),3)
        with self.assertRaisesRegex(ValueError,'platform'):
            r.resolve('example:latest','windows','amd64','')
        responses['latest']=manifest;r.cache.clear()
        with self.assertRaisesRegex(ValueError,'platform'):
            r.resolve('example:latest','linux','arm64','')
        responses[config_digest]=b'changed';r.cache.clear()
        with self.assertRaisesRegex(ValueError,'digest mismatch'):
            r.resolve('example:latest','linux','amd64','')

    def test_network_auth_rate_limits_and_destination_allowlist(self):
        for code in (401,403,429,500):
            r=m.Registry({'registry-1.docker.io':{}})
            def fail(*a):raise urllib.error.HTTPError('https://registry',code,'error',{},None)
            r.get=fail
            with self.assertRaises(ValueError):r.resolve('example','linux','amd64','')
        r=m.Registry({})
        with self.assertRaisesRegex(ValueError,'not approved'):r.resolve('private.example/app','linux','amd64','')
        r=m.Registry({'registry-1.docker.io':{}});r.get=lambda *a:(_ for _ in ()).throw(TimeoutError())
        with self.assertRaisesRegex(ValueError,'network'):r.resolve('example','linux','amd64','')
        result=m.service_status(self.container,self.image,r);self.assertEqual(result['state'],'unavailable');self.assertIsNone(result['checkedAt'])

    def test_token_realm_protects_credentials_and_requests_pull_scope_only(self):
        r=m.Registry({'registry-1.docker.io':{'username':'user','password':'secret','tokenRealms':['https://auth.example/token']}})
        calls=[]
        def get(url,headers,*args):
            calls.append((url,headers.copy()))
            if len(calls)==1:raise urllib.error.HTTPError(url,401,'auth',{'WWW-Authenticate':'Bearer realm="https://evil.example/token",service="registry"'},None)
            raise AssertionError('Credentials sent to unapproved realm')
        r.get=get
        with self.assertRaisesRegex(ValueError,'realm'):r.resolve('example','linux','amd64','')
        self.assertEqual(len(calls),1);self.assertNotIn('Authorization',calls[0][1])
        calls.clear()
        def good(url,headers,*args):
            calls.append((url,headers.copy()))
            if len(calls)==1:raise urllib.error.HTTPError(url,401,'auth',{'WWW-Authenticate':'Bearer realm="https://auth.example/token",scope="repository:other:push",service="registry"'},None)
            if len(calls)==2:return b'{"token":"fixture-token"}'
            return b'{"schemaVersion":2,"config":{"digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}'
        r.get=good;r.manifest('registry-1.docker.io','library/example','latest')
        self.assertIn('repository%3Alibrary%2Fexample%3Apull',calls[1][0]);self.assertNotIn('push',calls[1][0])
        self.assertTrue(calls[1][1]['Authorization'].startswith('Basic '))

    def test_redirects_drop_credentials_and_require_explicit_https_destination(self):
        r=m.Registry({}); calls=[]
        class Response:
            def __enter__(self):return self
            def __exit__(self,*a):pass
            def read(self,*a):return b'config'
        def open_request(req,**kwargs):
            calls.append(req)
            if len(calls)==1:raise urllib.error.HTTPError(req.full_url,307,'redirect',{'Location':'https://cdn.example/blob?signed=value'},None)
            return Response()
        r.opener=N(open=open_request)
        self.assertEqual(r.get('https://registry.example/blob',{'Authorization':'Bearer secret'},['cdn.example']),b'config')
        self.assertNotIn('Authorization',calls[1].headers)
        calls.clear()
        with self.assertRaisesRegex(ValueError,'not approved'):r.get('https://registry.example/blob',{'Authorization':'secret'})

    def test_reference_normalization_and_no_traversal(self):
        self.assertEqual(m.image_reference('alpine:3'),('registry-1.docker.io','library/alpine','3'))
        self.assertEqual(m.image_reference('docker.io/org/app'),('registry-1.docker.io','org/app','latest'))
        self.assertEqual(m.image_reference('registry.example:5000/org/app:tag'),('registry.example:5000','org/app','tag'))
        for value in ['../../x','https://evil/image','user:secret@evil/app','image;id']:
            with self.assertRaises(ValueError):m.image_reference(value)

    def test_docker_permissions_and_partial_results(self):
        with patch.object(m,'command',side_effect=PermissionError()):
            result=m.collect_docker({});self.assertEqual(result['state'],'unavailable');self.assertEqual(result['services'],[])
        with patch.object(m,'command',side_effect=lambda args: b'[]' if args[1]=='info' else b''):
            result=m.collect_docker({});self.assertEqual(result['state'],'ok');self.assertEqual(result['services'],[])
        def command(args):
            if args[1]=='ps':return ('b'*64).encode()
            if args[1]=='info':return b'[]'
            return json.dumps([self.container if args[1]=='container' else self.image]).encode()
        with patch.object(m,'command',side_effect=command):
            result=m.collect_docker({});self.assertEqual(result['state'],'unavailable');self.assertEqual(result['services'][0]['state'],'unavailable')

    def test_command_output_bounded_and_nonzero_failure(self):
        with self.assertRaises(ValueError):m.command(['/usr/bin/python3','-c','print("x"*4000001)'])
        with self.assertRaises(ValueError):m.command(['/usr/bin/python3','-c','raise SystemExit(1)'])

    def test_snapshot_atomic_and_bounded(self):
        with tempfile.TemporaryDirectory() as d:
            dest=Path(d)/'status.json';m.write_snapshot({'version':1},dest);self.assertEqual(json.loads(dest.read_text()),{'version':1})
            with self.assertRaises(ValueError):m.write_snapshot({'x':'a'*m.MAX_BYTES},dest)
            self.assertEqual(json.loads(dest.read_text()),{'version':1})

class CollectorPolicyTests(unittest.TestCase):
    def test_policy_report_contains_names_only_and_no_network_configuration_from_app(self):
        config = {'hostId':'host','nodeGuid':'guid','staleSeconds':43200,'registries':{'lscr.io':{'username':'private-user','password':'private-secret','tokenRealms':['https://private.example/token']}}}
        with patch.object(m,'collect_packages',return_value={}), patch.object(m,'collect_docker',return_value={}) as docker:
            snapshot = m.snapshot(config)
        self.assertEqual(snapshot['collector'], {'approvedRegistries':['lscr.io'],'packageStaleSeconds':43200})
        self.assertNotIn('private-secret', json.dumps(snapshot))
        self.assertNotIn('private-user', json.dumps(snapshot))
        self.assertNotIn('private.example', json.dumps(snapshot))
        docker.assert_called_once_with(config['registries'])

if __name__=='__main__':unittest.main()
