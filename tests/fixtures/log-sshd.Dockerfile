# SPDX-License-Identifier: AGPL-3.0-only
FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f
RUN apk add --no-cache python3 openssh-server \
 && adduser -D -s /bin/sh hostboard-logs && passwd -d hostboard-logs \
 && mkdir -p /run/hostboard-logs /home/hostboard-logs/.ssh /usr/local/libexec \
 && touch /run/hostboard-logs/slot0 /run/hostboard-logs/slot1 /run/hostboard-logs/slot2 \
 && chmod 644 /run/hostboard-logs/slot* \
 && printf 'Port 2222\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\nAllowUsers hostboard-logs\nAllowTcpForwarding no\nX11Forwarding no\nPermitTTY no\nForceCommand /usr/local/libexec/hostboard-logs\n' > /etc/ssh/sshd_config
COPY scripts/log-adapter.py /usr/local/libexec/hostboard-logs
RUN chmod 755 /usr/local/libexec/hostboard-logs
CMD ["/bin/sh","-c","cp /run/auth-input /home/hostboard-logs/.ssh/authorized_keys && chown root:root /home/hostboard-logs/.ssh/authorized_keys && chmod 644 /home/hostboard-logs/.ssh/authorized_keys && addgroup -g $(stat -c %g /var/run/docker.sock) socket-access && addgroup hostboard-logs socket-access && ssh-keygen -A && exec /usr/sbin/sshd -D -e"]
