"""Exercise the production SMTP adapter in a network-isolated container."""
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile

root=Path(__file__).resolve().parents[1]
docker=shlex.split(os.environ.get('DOCKER','docker'))
image=os.environ.get('HOSTBOARD_TEST_IMAGE','hostboard:ci')
with tempfile.TemporaryDirectory(prefix='hb-smtp-') as directory:
    fixture=Path(directory)
    shutil.copyfile(root/'tests/smtp-container.ts',fixture/'smtp-container.ts')
    subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(fixture/'key.pem'),'-out',str(fixture/'cert.pem'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    subprocess.run([*docker,'run','--rm','--network','none','--user','0:0','-v',f'{fixture}:/fixtures:ro','-e','NODE_EXTRA_CA_CERTS=/fixtures/cert.pem','--entrypoint','node',image,'/fixtures/smtp-container.ts'],check=True)
