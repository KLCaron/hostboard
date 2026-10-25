#!/usr/bin/python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Scheduled local observation only. No remotely supplied arguments or operations.
APT cache is opened read-only; Docker commands are limited to ps and inspect.
Run with /usr/bin/python3 (distribution python-apt), not a virtualenv.
"""
import hashlib
import json
import os
import re
import signal
import selectors
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

MAX_BYTES = 4_000_000
DIGEST = re.compile(r'^sha256:[a-f0-9]{64}$')
MANIFEST_TYPES = ', '.join(['application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.v2+json'])


def unavailable(message, manager='unknown'):
    return dict(state='unavailable', message=message, checkedAt=None,
                metadataAt=None, rebootRequired=None, manager=manager, packages=[])


def security_origin(origin):
    """Signed Release origin/archive/label, never a package-name heuristic."""
    if not origin.trusted:
        return None
    if origin.origin == 'Ubuntu':
        return origin.archive.endswith('-security')
    if origin.origin == 'Debian':
        return origin.label == 'Debian-Security' or origin.archive.endswith('-security')
    return None  # Third-party advisories require a separate provider.


def package_inventory(cache, version_compare):
    updates = []
    for pkg in cache:
        if not pkg.is_installed or not pkg.is_upgradable or not pkg.candidate:
            continue
        installed, candidate = pkg.installed.version, pkg.candidate.version
        origins = pkg.candidate.origins
        security = [security_origin(o) for o in origins]
        # A newer ordinary candidate can supersede an outstanding security fix.
        for v in pkg.versions:
            if version_compare(v.version, installed) > 0 and version_compare(v.version, candidate) <= 0:
                security.extend(security_origin(o) for o in v.origins)
        classification = True if True in security else False if security and all(s is False for s in security) else None
        sources = sorted(set('/'.join([o.origin, o.archive, o.component, o.site]) for o in origins))
        updates.append(dict(name=pkg.name, installed=installed, available=candidate,
                            security=classification, sources=sources[:30]))
        if len(updates) > 10000:
            raise ValueError('Package inventory exceeds bound')
    return sorted(updates, key=lambda p: (p['security'] is not True, p['name']))


def collect_packages(stale_seconds=86400):
    if not Path('/var/lib/dpkg/status').exists():
        result = unavailable('Package manager is unsupported; APT provider only.')
        result['state'] = 'unsupported'
        return result
    try:
        import apt
        import apt_pkg
        # Cache() reads installed status and existing lists. Never update(), commit(),
        # upgrade(), acquire downloads, or run apt hooks. No apt CLI invocation.
        packages = package_inventory(apt.Cache(memonly=True), apt_pkg.version_compare)
        stamp = Path('/var/lib/apt/periodic/update-success-stamp')
        metadata = stamp.stat().st_mtime if stamp.is_file() else None
        now = time.time()
        stale = metadata is None or metadata > now + 300 or now - metadata > stale_seconds
        return dict(state='stale' if stale else 'ok',
            message='APT metadata freshness is unverified or stale. No repository refresh was performed.' if stale else 'Existing APT cache; no repository refresh performed.',
            checkedAt=now, metadataAt=metadata if metadata is None or metadata <= now + 300 else None,
            rebootRequired=Path('/run/reboot-required').exists(), manager='apt', packages=packages)
    except ImportError:
        return unavailable('Distribution python3-apt is missing; use /usr/bin/python3.', 'apt')
    except Exception:
        return unavailable('APT cache could not be read; check permissions and metadata.', 'apt')


def command(args):
    """Only callers below use fixed docker ps/inspect commands; no shell."""
    child = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'HOME': '/nonexistent'})
    output = bytearray()
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            deadline = time.monotonic() + 12
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not selector.select(remaining):
                    raise TimeoutError('Docker read timed out')
                chunk = os.read(child.stdout.fileno(), 65536)
                if not chunk:
                    break
                output.extend(chunk)
                if len(output) > MAX_BYTES:
                    raise ValueError('Docker response exceeds bound')
        if child.wait(timeout=max(0.1, deadline - time.monotonic())) != 0:
            raise ValueError('Docker read failed')
        return bytes(output)
    finally:
        if child.poll() is None:
            child.kill()
        child.wait()
        child.stdout.close()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Registry:
    """Bounded HTTPS manifest reads; secrets stay in root-owned host config.
    A configured registry may name exact trusted HTTPS token realms. Never trust
    arbitrary auth challenges, proxy environment, redirects or credential helpers.
    """
    def __init__(self, config):
        self.config = config
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        self.requests = 0
        self.cache = {}
        self.failed = set()
        self.tokens = {}
        self.deadline = time.monotonic() + 180
        self.cache_bytes = 0

    def get(self, url, headers, redirect_hosts=(), hops=0):
        self.requests += 1
        if time.monotonic() >= self.deadline:
            raise ValueError('Registry collection deadline reached')
        if self.requests > 200:
            raise ValueError('Registry request budget exhausted')
        request = urllib.request.Request(url, headers=headers, method='GET')
        try:
            with self.opener.open(request, timeout=max(0.1, min(8, self.deadline - time.monotonic()))) as response:
                body = response.read(2_000_001)
                if len(body) > 2_000_000:
                    raise ValueError('Registry response exceeds bound')
                return body
        except urllib.error.HTTPError as error:
            if error.code in (301, 302, 303, 307, 308):
                target = urllib.parse.urlsplit(error.headers.get('Location', ''))
                error.close()
                if (hops >= 2 or target.scheme != 'https' or target.username or target.password
                        or target.netloc not in redirect_hosts or target.fragment):
                    raise ValueError('Registry redirect destination is not approved') from None
                # Signed CDN URL only; never forward registry Authorization.
                return self.get(target.geturl(), {}, redirect_hosts, hops + 1)
            raise

    def manifest(self, host, repo, ref, kind="manifests"):
        key = (host, repo, ref, kind)
        if key in self.cache:
            return self.cache[key]
        if host in self.failed:
            raise ValueError('Registry unavailable in this collection')
        policy = self.config.get(host)
        if policy is None:
            raise ValueError('Registry is not approved in collector configuration')
        url = 'https://' + host + '/v2/' + repo + '/' + kind + '/' + ref
        headers = {'Accept': MANIFEST_TYPES}
        token_key = (host, repo)
        if token_key in self.tokens:
            headers['Authorization'] = 'Bearer ' + self.tokens[token_key]
        try:
            try:
                body = self.get(url, headers, policy.get('blobRedirectHosts', []) if kind == 'blobs' else [])
            except urllib.error.HTTPError as error:
                if error.code != 401:
                    raise
                challenge = error.headers.get('WWW-Authenticate', '')
                error.close()
                if not challenge.lower().startswith('bearer '):
                    raise ValueError('Registry authentication is unsupported or failed')
                values = dict(re.findall(r'(\w+)="([^"\r\n]*)"', challenge[7:]))
                realm = values.get('realm', '')
                u = urllib.parse.urlsplit(realm)
                if (realm not in policy.get('tokenRealms', []) or u.scheme != 'https'
                        or u.username or u.password or u.query or u.fragment):
                    raise ValueError('Registry token realm is not approved')
                query = urllib.parse.urlencode({'service': values.get('service', ''), 'scope': 'repository:' + repo + ':pull'})
                auth_headers = {}
                if policy.get('username') and policy.get('password'):
                    import base64
                    auth_headers['Authorization'] = 'Basic ' + base64.b64encode((policy['username'] + ':' + policy['password']).encode()).decode()
                token = json.loads(self.get(realm + '?' + query, auth_headers))
                bearer = token.get('token') or token.get('access_token')
                if not isinstance(bearer, str) or not bearer or len(bearer) > 16384 or '\n' in bearer or '\r' in bearer:
                    raise ValueError('Registry authentication failed')
                self.tokens[token_key] = bearer
                headers['Authorization'] = 'Bearer ' + bearer
                body = self.get(url, headers, policy.get('blobRedirectHosts', []) if kind == 'blobs' else [])
            actual = 'sha256:' + hashlib.sha256(body).hexdigest()
            if DIGEST.fullmatch(ref) and actual != ref:
                raise ValueError('Registry manifest digest mismatch')
            value = json.loads(body)
            if kind == 'manifests' and value.get('schemaVersion') != 2:
                raise ValueError('Unsupported manifest schema')
            self.cache_bytes += len(body)
            if self.cache_bytes > 16_000_000:
                raise ValueError('Registry cache exceeds bound')
            self.cache[key] = (value, actual)
            # Modest pacing, no retry loops (including HTTP 429).
            time.sleep(0.1)
            return self.cache[key]
        except urllib.error.HTTPError as error:
            error.close()
            if error.code in (401, 403):
                message = 'Registry authentication failed'
            elif error.code == 429:
                self.failed.add(host)
                message = 'Registry rate limit reached'
            else:
                message = 'Registry manifest unavailable'
            raise ValueError(message) from None
        except (TimeoutError, OSError):
            self.failed.add(host)
            raise ValueError('Registry network unavailable or timed out') from None

    def resolve(self, image, os_name, arch, variant):
        host, repo, ref = image_reference(image)
        manifest, digest = self.manifest(host, repo, ref)
        for _ in range(3):
            if 'manifests' not in manifest:
                config_digest = manifest.get('config', {}).get('digest', '')
                if not DIGEST.fullmatch(config_digest):
                    raise ValueError('Image config digest unavailable')
                config, _ = self.manifest(host, repo, config_digest, 'blobs')
                if (config.get('os') != os_name or config.get('architecture') != arch
                        or (variant and config.get('variant', '') != variant)):
                    raise ValueError('Upstream image platform does not match deployment')
                return digest, config_digest
            matches = [m for m in manifest['manifests'] if m.get('platform', {}).get('os') == os_name
                       and m.get('platform', {}).get('architecture') == arch
                       and (not variant or m.get('platform', {}).get('variant', '') == variant)]
            if len(matches) != 1 or not DIGEST.fullmatch(matches[0].get('digest', '')):
                raise ValueError('Image platform is missing or ambiguous')
            manifest, digest = self.manifest(host, repo, matches[0]['digest'])
        raise ValueError('Image index nesting exceeds bound')


def image_reference(image):
    if not isinstance(image, str) or len(image) > 512 or not re.fullmatch(r'[a-zA-Z0-9_./:@-]+', image) or '@' in image:
        raise ValueError('Unsupported image reference')
    first, sep, tail = image.partition('/')
    if sep and ('.' in first or ':' in first or first == 'localhost'):
        host, name = first, tail
    else:
        host, name = 'registry-1.docker.io', image
    if host in ('docker.io', 'index.docker.io'):
        host = 'registry-1.docker.io'
    name, colon, tag = name.rpartition(':') if ':' in name else (name, '', 'latest')
    if not colon:
        tag = 'latest'
    if host == 'registry-1.docker.io' and '/' not in name:
        name = 'library/' + name
    if any(s in ('', '.', '..') for s in name.split('/')) or not re.fullmatch(r'[a-z0-9._/-]+', name):
        raise ValueError('Unsupported repository name')
    return host, name, tag


def service_status(container, image, registry, containerd_store=False):
    labels = container.get('Config', {}).get('Labels') or {}
    ref = container['Config']['Image']
    config = container['Image']
    if not DIGEST.fullmatch(config):
        raise ValueError('Deployed image digest unavailable')
    descriptor = container.get('ImageManifestDescriptor') or {}
    modern = containerd_store or bool(image.get('Descriptor')) or bool(descriptor)
    deployed_manifest = descriptor.get('digest') if modern else None
    if deployed_manifest is not None and not DIGEST.fullmatch(deployed_manifest):
        deployed_manifest = None
    platform = descriptor.get('platform') or {}
    os_name = platform.get('os') or image.get('Os', '')
    arch = platform.get('architecture') or image.get('Architecture', '')
    variant = platform.get('variant') or image.get('Variant', '')
    result = dict(project=labels['com.docker.compose.project'], service=labels['com.docker.compose.service'],
        container=container['Id'], image=ref, deployedImageId=config,
        deployedConfig=None if modern else config, deployedManifest=deployed_manifest,
        deployedDigests=image.get('RepoDigests') or [], platform='/'.join(filter(None, [os_name, arch, variant])),
        state='unavailable', message='', upstreamDigest=None, upstreamConfig=None, checkedAt=None)
    if '@' in ref:
        result.update(state='pinned', message='Immutable digest pin; no moving tag to check.')
    elif not result['deployedDigests']:
        result.update(state='local', message='Local build or imported image; registry provenance unavailable.')
    else:
        try:
            if modern and not deployed_manifest:
                raise ValueError('Deployed platform manifest unavailable; Docker API/CLI upgrade may be required')
            if not os_name or not arch:
                raise ValueError('Deployed platform unavailable')
            upstream, candidate = registry.resolve(ref, os_name, arch, variant)
            unchanged = upstream == deployed_manifest if modern else candidate == config
            comparison = 'platform manifest' if modern else 'image config'
            result.update(upstreamDigest=upstream, upstreamConfig=candidate, checkedAt=time.time(),
                state='current' if unchanged else 'update', message='Deployed and upstream ' + comparison + ' digests are unchanged.' if unchanged else 'Upstream ' + comparison + ' digest differs from deployment; a newer software version is not confirmed.')
        except ValueError as error:
            result['message'] = str(error)[:240]
        except Exception:
            result['message'] = 'Registry check failed; no update status is known.'
    return result


def collect_docker(config):
    services = []
    deadline = time.monotonic() + 240
    try:
        ids = command(['/usr/bin/docker', 'ps', '-aq', '--filter', 'label=com.docker.compose.project',
                       '--filter', 'label=com.docker.compose.service']).decode().split()
        if len(ids) > 500 or any(not re.fullmatch('[a-f0-9]{12,64}', i) for i in ids):
            raise ValueError('Container inventory exceeds bound')
        driver = json.loads(command(['/usr/bin/docker', 'info', '--format', '{{json .DriverStatus}}']))
        if not isinstance(driver, list):
            raise ValueError('Docker storage driver is unknown')
        containerd_store = ['driver-type', 'io.containerd.snapshotter.v1'] in driver
        registry = Registry(config)
        images = {}
        for ident in ids:
            if time.monotonic() >= deadline:
                raise ValueError('Docker collection deadline reached')
            # Inspect individual objects to keep raw Docker JSON bounded. It may
            # include environment secrets in memory; never persist or emit it.
            c = json.loads(command(['/usr/bin/docker', 'container', 'inspect', ident]))[0]
            labels = c.get('Config', {}).get('Labels') or {}
            if str(labels.get('com.docker.compose.oneoff', '')).lower() == 'true':
                continue
            image_id = c['Image']
            if not DIGEST.fullmatch(image_id):
                raise ValueError('Invalid deployed image ID')
            if image_id not in images:
                images[image_id] = json.loads(command(['/usr/bin/docker', 'image', 'inspect', image_id]))[0]
            services.append(service_status(c, images[image_id], registry, containerd_store))
        failed = any(s['state'] == 'unavailable' for s in services)
        return dict(state='unavailable' if failed else 'ok', message='Some registry checks failed; successful service results are retained.' if failed else 'Compose-labeled containers, including stopped services. One-off jobs excluded.',
                    checkedAt=time.time(), services=services)
    except Exception:
        return dict(state='unavailable', message='Docker inventory unavailable; check daemon access and collector bounds.', checkedAt=None, services=services)


def snapshot(config):
    packages = collect_packages(config.get('staleSeconds', 86400))
    docker = collect_docker(config.get('registries', {'registry-1.docker.io': {'tokenRealms': ['https://auth.docker.io/token'], 'blobRedirectHosts': ['production.cloudfront.docker.com', 'production.cloudflare.docker.com']}}))
    return dict(version=1, hostId=config['hostId'], nodeGuid=config['nodeGuid'],
                collector=dict(approvedRegistries=sorted(config.get('registries', {'registry-1.docker.io': {}})),
                               packageStaleSeconds=config.get('staleSeconds', 86400)),
                collectedAt=time.time(), packages=packages, docker=docker)


def write_snapshot(value, destination):
    data = json.dumps(value, separators=(',', ':')).encode()
    if len(data) > MAX_BYTES:
        raise ValueError('Snapshot exceeds bound')
    temporary = destination.with_suffix('.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o640)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, destination)


def main():
    # Standalone execution accepts no remote operations, commands, paths or URLs.
    if len(sys.argv) != 1:
        raise SystemExit('This collector accepts no arguments')
    signal.alarm(300)
    os.umask(0o027)
    import fcntl
    with open('/var/lib/hostboard-updates/collector.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        config = json.loads(Path('/etc/hostboard-updates.json').read_text())
        value = snapshot(config)
        value['collectedAt'] = time.time()
        write_snapshot(value, Path('/var/lib/hostboard-updates/status.json'))


if __name__ == '__main__':
    main()
