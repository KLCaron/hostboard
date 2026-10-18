#!/usr/bin/env python3
"""Durable SMTP transport for Netdata custom notifications and the watchdog.
Netdata evaluates metric alerts. Never log credentials or SMTP responses.
"""
import argparse
from email.message import EmailMessage
from email.utils import formatdate
import json
import os
from pathlib import Path
import smtplib
import sqlite3
import ssl
import time
import uuid


class Queue:
    def __init__(self, filename, config_file=None, sender=None):
        self.config_file = config_file or os.environ.get('HOSTBOARD_SMTP_CONFIG', '/etc/hostboard/smtp.json')
        self.sender = sender or self.smtp_send
        self.db = sqlite3.connect(filename, timeout=60)
        self.db.row_factory = sqlite3.Row
        self.db.executescript('''PRAGMA journal_mode=WAL;
          CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,key TEXT,event TEXT,subject TEXT,body TEXT,state TEXT,attempts INTEGER DEFAULT 0,next REAL,last_attempt REAL,delivered REAL,error TEXT,incident INTEGER,cooldown INTEGER DEFAULT 900);
          CREATE TABLE IF NOT EXISTS states(key TEXT PRIMARY KEY,down INTEGER,started REAL,last_sent REAL,reason TEXT);
          CREATE TABLE IF NOT EXISTS incidents(id INTEGER PRIMARY KEY,key TEXT,name TEXT,startedAt REAL,detectedAt REAL,endedAt REAL,reason TEXT,lastReason TEXT);
        ''')
        if 'incident' not in [r['name'] for r in self.db.execute('PRAGMA table_info(events)')]:
            self.db.execute('ALTER TABLE events ADD COLUMN incident INTEGER')
        if 'cooldown' not in [r['name'] for r in self.db.execute('PRAGMA table_info(events)')]:
            self.db.execute('ALTER TABLE events ADD COLUMN cooldown INTEGER DEFAULT 900')
        self.db.executescript("CREATE INDEX IF NOT EXISTS event_predecessor ON events(key,id) WHERE state IN ('pending','failed'); CREATE INDEX IF NOT EXISTS event_due ON events(state,next);")
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO metadata VALUES('mailNamespace',?)", (uuid.uuid4().hex,))
        self.namespace = self.db.execute("SELECT value FROM metadata WHERE key='mailNamespace'").fetchone()['value']

    def transition(self, key, label, down, reason, now=None, started=None, cooldown=None):
        now = time.time() if now is None else now
        cooldown = int(os.environ.get('HOSTBOARD_NOTIFY_COOLDOWN', '900')) if cooldown is None else cooldown
        with self.db:
            self.db.execute('BEGIN IMMEDIATE')
            old = self.db.execute('SELECT * FROM states WHERE key=?', (key,)).fetchone()
            if old and bool(old['down']) == down:
                self.db.execute('UPDATE states SET reason=? WHERE key=?', (reason, key))
                self.db.execute('UPDATE incidents SET lastReason=? WHERE key=? AND endedAt IS NULL', (reason, key))
                return False
            since = old['started'] if old and old['down'] else started or now
            self.db.execute('INSERT OR REPLACE INTO states VALUES(?,?,?,?,?)', (key, int(down), since if down else None, old['last_sent'] if old else None, reason))
            if not down and not (old and old['down']):
                return False
            if down:
                incident = self.db.execute('INSERT INTO incidents(key,name,startedAt,detectedAt,reason,lastReason) VALUES(?,?,?,?,?,?)', (key, label, since, now, reason, reason)).lastrowid
            else:
                current = self.db.execute('SELECT id FROM incidents WHERE key=? AND endedAt IS NULL ORDER BY id DESC LIMIT 1', (key,)).fetchone()
                incident = current['id'] if current else None
                self.db.execute('UPDATE incidents SET endedAt=?,lastReason=? WHERE id=?', (now, reason, incident))
            event = 'outage' if down else 'recovery'
            subject = f'[Hostboard] {"CRITICAL" if down else "RECOVERED"}: {label}'
            stamp = lambda t: time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime(t))
            body = f'{label}\nState: {"unavailable" if down else "available"}\nStarted: {stamp(since)}\nObserved: {stamp(now)}\nReason: {reason}\n'
            if not down:
                body += f'Elapsed outage: {round(now - since)} seconds; may include monitoring gaps.\n'
            body += 'Sent by independent host notification delivery.\n'
            due = max(now, (old['last_sent'] or 0) + cooldown) if down and old else now
            state = 'pending' if Path(self.config_file).exists() else 'disabled'
            self.db.execute('INSERT INTO events(key,event,subject,body,state,next,incident,cooldown) VALUES(?,?,?,?,?,?,?,?)', (key, event, subject, body, state, due, incident, cooldown))
        return True

    def smtp_send(self, row):
        config = json.loads(Path(self.config_file).read_text())
        message = EmailMessage()
        message['From'] = config['from']
        message['To'] = ', '.join(config['to'])
        message['Subject'] = row['subject']
        message['Date'] = formatdate(localtime=False)
        message['Message-ID'] = f'<hostboard-{os.uname().nodename}-{self.namespace}-{row["id"]}@{config["from"].split("@")[1]}>'
        latest = self.db.execute('SELECT down FROM states WHERE key=?', (row['key'],)).fetchone()
        body = row['body']
        if latest:
            body += '\nLatest recorded state at delivery: ' + ('unavailable' if latest['down'] else 'available') + '\n'
        message.set_content(body)
        context = ssl.create_default_context()
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        port = config.get('port', 587)
        if port not in (465, 587):
            raise ValueError('TLS SMTP port required')
        client = smtplib.SMTP_SSL(config['host'], port, timeout=12, context=context) if port == 465 else smtplib.SMTP(config['host'], port, timeout=12)
        with client:
            if port == 587:
                client.ehlo()
                client.starttls(context=context)
                client.ehlo()
            client.login(config['username'], config['password'])
            if client.send_message(message):
                raise ValueError('Recipient rejected')

    def flush(self, now=None, limit=3, only=None):
        now = time.time() if now is None else now
        attempted = set()
        for _ in range(min(max(limit, 0), 100)):
            rows = self.db.execute(f"SELECT e.* FROM events e WHERE e.state IN ('pending','failed') AND e.next<=? AND (? IS NULL OR e.id=?) AND NOT EXISTS (SELECT 1 FROM events p WHERE p.key=e.key AND p.id<e.id AND p.state IN ('pending','failed')) AND e.id NOT IN ({','.join('?' for _ in attempted) or '-1'}) ORDER BY e.next,e.id LIMIT 1", (now, only, only, *attempted)).fetchall()
            if not rows: break
            row = rows[0]
            attempted.add(row['id'])
            if self.db.execute("SELECT 1 FROM events WHERE key=? AND id<? AND state IN ('pending','failed')", (row['key'], row['id'])).fetchone():
                continue
            # A SQLite write lock serializes simultaneous Netdata custom senders.
            with self.db:
                self.db.execute('BEGIN IMMEDIATE')
                current = self.db.execute('SELECT * FROM events WHERE id=?', (row['id'],)).fetchone()
                if current['state'] not in ('pending', 'failed') or current['next'] > now:
                    continue
                last = self.db.execute('SELECT last_sent FROM states WHERE key=?', (row['key'],)).fetchone()
                cooldown = row['cooldown']
                if row['event'] == 'outage' and last and last['last_sent'] and last['last_sent'] + cooldown > now:
                    self.db.execute('UPDATE events SET next=? WHERE id=?', (last['last_sent'] + cooldown, row['id']))
                    continue
                self.db.execute('UPDATE events SET attempts=attempts+1,last_attempt=? WHERE id=?', (now, row['id']))
                try:
                    self.sender(row)
                    self.db.execute("UPDATE events SET state='delivered',delivered=?,error=NULL WHERE id=?", (now, row['id']))
                    if row['event'] == 'outage':
                        self.db.execute('UPDATE states SET last_sent=? WHERE key=?', (now, row['key']))
                except Exception:
                    self.db.execute("UPDATE events SET state='failed',next=?,error='SMTP delivery failed; retry scheduled' WHERE id=?", (now + min(900, 30 * 2 ** min(row['attempts'], 5)), row['id']))
        return self.summary()

    def history(self, key='hostboard-availability'):
        incidents = []
        for row in self.db.execute('SELECT * FROM incidents WHERE key=? ORDER BY id DESC LIMIT 100', (key,)):
            value = dict(row)
            value.pop('key')
            value['notifications'] = [dict(n) for n in self.db.execute('SELECT id,event,state,attempts,last_attempt AS lastAttempt,delivered AS deliveredAt,error FROM events WHERE incident=? ORDER BY id', (row['id'],))]
            incidents.append(value)
        return incidents

    def summary(self):
        return {row['state']: row['count'] for row in self.db.execute('SELECT state,COUNT(*) AS count FROM events GROUP BY state')}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--db', default=os.environ.get('HOSTBOARD_NOTIFY_DB', '/var/lib/netdata/hostboard-notify.sqlite'))
    parser.add_argument('--test', action='store_true')
    parser.add_argument('--flush', action='store_true')
    parser.add_argument('--netdata', nargs=9)
    args = parser.parse_args()
    queue = Queue(args.db)
    if args.netdata:
        host, alarm, name, status, when, duration, info, chart, value = args.netdata
        if status in ('CRITICAL', 'CLEAR'):
            queue.transition(f'netdata:{host}:{alarm}', f'{host} / {name}', status == 'CRITICAL', f'Netdata {status}; {chart}; {info}; value {value}; raised duration {duration}s', started=float(when))
        # The separate retry timer delivers: SMTP never blocks Netdata's health engine.
    test_id = None
    if args.test:
        now = time.time()
        with queue.db:
            test_id = queue.db.execute("INSERT INTO events(key,event,subject,body,state,next) VALUES(?,?,?,?,?,?)", (f'test:{now}', 'test', f'[Hostboard] SMTP delivery test from {os.uname().nodename}', 'Controlled notification transport test. No production service was interrupted.', 'pending', now)).lastrowid
    if args.flush or args.test:
        summary = queue.flush(limit=1, only=test_id)
        print(json.dumps(summary))
        if args.test and queue.db.execute('SELECT state FROM events WHERE id=?', (test_id,)).fetchone()['state'] != 'delivered':
            return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
