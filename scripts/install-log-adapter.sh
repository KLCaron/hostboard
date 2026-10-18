#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Run locally on a monitored Docker host, after reviewing the privilege boundary.
set -euo pipefail
umask 077
[[ $EUID == 0 ]] || { echo 'Run as root on the Docker host.' >&2; exit 1; }
config=${1:?Usage: install-log-adapter.sh SOURCES_JSON PUBLIC_KEY_FILE EXACT_CLIENT_IP}
public_key=${2:?Public key file required}
client_ip=${3:?Exact SSH client source IP required}
base=$(cd "$(dirname "$0")/.." && pwd)
python3 - "$base/scripts/log-adapter.py" "$config" "$public_key" "$client_ip" <<'PY'
import importlib.util,ipaddress,json,sys
spec=importlib.util.spec_from_file_location('adapter',sys.argv[1]);a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
with open(sys.argv[2]) as f:a.config(json.load(f))
key=open(sys.argv[3]).read().strip().split()
assert len(key)>=2 and key[0]=='ssh-ed25519' and all(c.isalnum() or c in '+/=' for c in key[1]),'Use one Ed25519 public key'
assert len(open(sys.argv[3]).read().strip().splitlines())==1
ipaddress.ip_address(sys.argv[4])
PY
getent group docker >/dev/null
# This dedicated account has Docker's root-equivalent socket privilege. Its SSH
# interface is forced and cannot accept shell, forwarding, SFTP or arbitrary API calls.
if ! id hostboard-logs >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/hostboard-logs --shell /bin/sh --password '*' hostboard-logs
fi
python3 - <<'PYUSER'
import pwd
p=pwd.getpwnam('hostboard-logs')
assert p.pw_uid!=0 and p.pw_dir=='/var/lib/hostboard-logs' and p.pw_shell=='/bin/sh','Unexpected existing log account; review before installation'
PYUSER
usermod -a -G docker hostboard-logs
install -d -o root -g root -m 755 /var/lib/hostboard-logs /var/lib/hostboard-logs/.ssh /usr/local/libexec
install -o root -g root -m 755 "$base/scripts/log-adapter.py" /usr/local/libexec/hostboard-logs
install -o root -g root -m 644 "$config" /etc/hostboard-logs.json
read -r key_type key_body _ < "$public_key"
printf 'restrict,from="%s",command="/usr/local/libexec/hostboard-logs" %s %s\n' "$client_ip" "$key_type" "$key_body" > /var/lib/hostboard-logs/.ssh/authorized_keys
chmod 644 /var/lib/hostboard-logs/.ssh/authorized_keys
install -d -o root -g root -m 755 /etc/ssh/sshd_config.d
cat > /etc/ssh/sshd_config.d/90-hostboard-logs.conf <<'CONF'
Match User hostboard-logs
    AuthenticationMethods publickey
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    DisableForwarding yes
    PermitTTY no
    PermitUserRC no
    ForceCommand /usr/local/libexec/hostboard-logs
Match all
CONF
cat > /etc/tmpfiles.d/hostboard-logs.conf <<'CONF'
d /run/hostboard-logs 0755 root root -
f /run/hostboard-logs/slot0 0644 root root -
f /run/hostboard-logs/slot1 0644 root root -
f /run/hostboard-logs/slot2 0644 root root -
CONF
systemd-tmpfiles --create /etc/tmpfiles.d/hostboard-logs.conf
/usr/sbin/sshd -t
# Verify that sshd actually includes the drop-in and applies the restrictions.
/usr/sbin/sshd -T -C "user=hostboard-logs,host=localhost,addr=$client_ip" | python3 -c 'import sys;v=dict(line.rstrip().split(" ",1) for line in sys.stdin);assert v["forcecommand"]=="/usr/local/libexec/hostboard-logs" and v["disableforwarding"]=="yes" and v["passwordauthentication"]=="no" and v["permittty"]=="no", "sshd must include its config.d directory"'
systemctl reload ssh.service
printf 'Installed forced-command log adapter. No new port was opened. Review source selectors and SSH source restrictions before activation.\n'
