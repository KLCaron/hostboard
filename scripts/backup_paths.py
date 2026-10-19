#!/usr/bin/env python3
"""Copy the effective Compose bind mounts. Never evaluate .env as shell code."""
import json
import os
from pathlib import Path
import shutil
import re
import sqlite3
import subprocess
import sys


def mounts(env_file=None):
    args = ['docker', 'compose']
    if env_file: args += ['--env-file', str(env_file)]
    config = json.loads(subprocess.check_output(args + ['config', '--format', 'json']))
    volumes = config['services']['hostboard']['volumes']
    result = {}
    for name in ('config', 'private', 'data'):
        volume = next((v for v in volumes if v['target'] == '/app/' + name), None)
        if not volume or volume['type'] != 'bind':
            raise ValueError('Lifecycle backups require directory bind mounts at /app/config, /app/private and /app/data')
        result[name] = Path(volume['source']).resolve()
    if len(set(result.values())) != 3 or any(a in b.parents for a in result.values() for b in result.values() if a!=b):
        raise ValueError('Configuration and data mounts must be separate directories')
    return result


def tree(directory):
    yield directory
    if directory.is_dir():
        if directory.stat().st_mode & 0o500 != 0o500: raise ValueError('Unreadable configuration directory')
        for child in directory.iterdir():
            if child.is_symlink(): raise ValueError('Configuration symlinks are unsupported')
            yield from tree(child)


def validate_tree(directory):
    if not directory.is_dir(): raise ValueError('Backup configuration directory missing')
    for path in tree(directory):
        if path.is_symlink() or not (path.is_file() or path.is_dir()):
            raise ValueError('Configuration backup requires regular files and directories, without symlinks')
        if path.is_file():
            if path.stat().st_mode & 0o444 == 0: raise ValueError('Unreadable configuration file')
            with path.open('rb') as source: source.read(1)


def copy_tree(source, destination):
    validate_tree(source)
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    for path in tree(source):
        target = destination / path.relative_to(source)
        if target.is_symlink(): raise ValueError('Refusing to restore through symlinks')
        if path.is_dir(): target.mkdir(exist_ok=True, mode=0o700); target.chmod(0o700)
        else: shutil.copyfile(path, target); target.chmod(0o600)
        if os.geteuid()==0: os.chown(target,path.stat().st_uid,path.stat().st_gid)


def main():
    command, backup_arg = sys.argv[1:]
    checkpoint = Path(backup_arg).resolve()
    if command == 'capture':
        selected = mounts()
        container = subprocess.check_output(['docker','compose','ps','-q','hostboard'], text=True).strip()
        running = json.loads(subprocess.check_output(['docker','inspect',container]))[0]['Mounts']
        for name, source in selected.items():
            actual = next((v for v in running if v['Destination'] == '/app/'+name), None)
            if not actual or Path(actual['Source']).resolve() != source:
                raise ValueError('Running mounts differ from Compose; refuse an unpaired backup')
            if checkpoint == source or source in checkpoint.parents or checkpoint in source.parents:
                raise ValueError('Backup destination must be outside active mount directories')
        for name in ('private','config'): validate_tree(selected[name])
        if not (selected['private']/'admin.json').is_file() or not (selected['config']/'hosts.json').is_file():
            raise ValueError('Required installation configuration missing')
        for name in ('private','config'): copy_tree(selected[name],checkpoint/name)
        shutil.copyfile('.env',checkpoint/'.env'); (checkpoint/'.env').chmod(0o600)
        if os.geteuid()==0: os.chown(checkpoint/'.env',Path('.env').stat().st_uid,Path('.env').stat().st_gid)
        (checkpoint/'mounts.json').write_text(json.dumps({k:str(v) for k,v in selected.items()})+'\n')
        (checkpoint/'mounts.json').chmod(0o600)
    elif command in ('validate','restore'):
        for name in ('private','config'): validate_tree(checkpoint/name)
        if not (checkpoint/'private/admin.json').is_file() or not (checkpoint/'config/hosts.json').is_file():
            raise ValueError('Backup is missing required configuration')
        with sqlite3.connect(f'file:{checkpoint}/monitor.sqlite?mode=ro',uri=True) as db:
            if db.execute('PRAGMA quick_check').fetchone()[0]!='ok' or db.execute('PRAGMA user_version').fetchone()[0] not in (1,2,3,4):
                raise ValueError('Invalid database checkpoint')
            if not db.execute('SELECT id FROM app_settings WHERE id=1').fetchone(): raise ValueError('Missing configuration database')
        # Resolve and verify the exact saved image before stopping the running service.
        reference, image_id = (checkpoint/'image.txt').read_text().strip().split()
        if not re.fullmatch(r'sha256:[a-f0-9]{64}',image_id): raise ValueError('Invalid checkpoint image identity')
        available=subprocess.run(['docker','image','inspect',image_id],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0
        if not available:
            subprocess.run(['docker','pull',reference],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            resolved=subprocess.check_output(['docker','image','inspect','--format','{{.Id}}',reference],text=True).strip()
            if resolved!=image_id: raise ValueError('Saved image tag no longer matches checkpoint; recover the preserved image')
        selected = mounts(checkpoint/'.env')
        if any(checkpoint==source or source in checkpoint.parents or checkpoint in source.parents for source in selected.values()):
            raise ValueError('Checkpoint must be outside restored mounts')
        if command == 'restore':
            for name in ('private','config'):
                # The validated tree replaces the selected installation's files, including removals.
                destination=selected[name]
                destination.mkdir(parents=True,exist_ok=True,mode=0o700)
                validate_tree(destination)
                for child in destination.iterdir():
                    if child.is_dir(): shutil.rmtree(child)
                    else: child.unlink()
                copy_tree(checkpoint/name,destination)
            environment=(checkpoint/'.env').read_text()
            # Pin the restored local content ID; an updated/mutable tag cannot select new code.
            environment=re.sub(r'^HOSTBOARD_IMAGE=.*$',f'HOSTBOARD_IMAGE={image_id}',environment,flags=re.MULTILINE)
            if not re.search(r'^HOSTBOARD_IMAGE=',environment,flags=re.MULTILINE): environment+=f'\nHOSTBOARD_IMAGE={image_id}\n'
            Path('.env').write_text(environment); Path('.env').chmod(0o600)
            if os.geteuid()==0: os.chown('.env',(checkpoint/'.env').stat().st_uid,(checkpoint/'.env').stat().st_gid)
    else: raise ValueError('Unknown backup operation')


if __name__ == '__main__':
    try: main()
    except Exception:
        # Avoid printing parsed Compose configuration or subprocess output containing secrets.
        sys.exit('Backup configuration validation/copy failed; check mounts, files and permissions')
