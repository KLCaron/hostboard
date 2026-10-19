import type { DatabaseSync } from "node:sqlite";

// Ordered, transactional migrations preserve all existing observations and identities.
// Older releases refuse this version; downgrade using the paired pre-upgrade backup.
export function migrateMonitor(db: DatabaseSync) {
  const version = (
    db.prepare("PRAGMA user_version").get() as { user_version: number }
  ).user_version;
  if (version > 4)
    throw Error("Monitoring database was created by a newer Hostboard release");
  db.exec("BEGIN IMMEDIATE");
  try {
    if (version < 2) {
      for (const table of ["check_evaluation", "incidents"]) {
        if (
          !(
            db.prepare(`PRAGMA table_info(${table})`).all() as {
              name: string;
            }[]
          ).some((c) => c.name === "generation")
        )
          db.exec(
            `ALTER TABLE ${table} ADD COLUMN generation INTEGER NOT NULL DEFAULT 1`,
          );
      }
      if (
        !(
          db.prepare("PRAGMA table_info(samples)").all() as { name: string }[]
        ).some((c) => c.name === "generation")
      ) {
        db.exec(`ALTER TABLE samples RENAME TO samples_v1;
        CREATE TABLE samples(checkId TEXT NOT NULL,time REAL NOT NULL,ok INTEGER,ms REAL,interval REAL NOT NULL,generation INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(checkId,generation,time));
        INSERT INTO samples SELECT checkId,time,ok,ms,interval,1 FROM samples_v1;
        DROP TABLE samples_v1;`);
      }
      if (
        !(
          db.prepare("PRAGMA table_info(external_incidents)").all() as {
            name: string;
          }[]
        ).some((c) => c.name === "generation")
      ) {
        db.exec(`ALTER TABLE external_incidents RENAME TO external_incidents_v1;
        CREATE TABLE external_incidents(checkId TEXT NOT NULL,remoteId INTEGER NOT NULL,incident INTEGER UNIQUE,generation INTEGER NOT NULL,PRIMARY KEY(checkId,generation,remoteId));
        INSERT INTO external_incidents SELECT checkId,remoteId,incident,1 FROM external_incidents_v1;
        DROP TABLE external_incidents_v1;`);
      }
      db.exec(`CREATE TABLE IF NOT EXISTS check_generations(checkId TEXT NOT NULL,generation INTEGER NOT NULL,fingerprint TEXT NOT NULL,startedAt REAL,endedAt REAL,PRIMARY KEY(checkId,generation));
      INSERT OR IGNORE INTO check_generations(checkId,generation,fingerprint) SELECT id,generation,fingerprint FROM check_evaluation;
      CREATE INDEX IF NOT EXISTS sample_success ON samples(checkId,generation,time DESC) WHERE ok=1;
      CREATE INDEX IF NOT EXISTS sample_time ON samples(time);
      CREATE INDEX IF NOT EXISTS notification_predecessor ON notifications(checkId,id) WHERE state IN ('pending','failed');
      PRAGMA user_version=2;`);
    }
    if (version < 3) {
      // Existing generations may have been renamed or replaced. A current
      // service_config definition cannot establish their original metadata.
      db.exec(`ALTER TABLE check_generations ADD COLUMN targetMetadata TEXT;
        ALTER TABLE check_generations ADD COLUMN supersededReason TEXT;
        INSERT OR IGNORE INTO check_generations(checkId,generation,fingerprint)
          SELECT checkId,generation,'' FROM samples GROUP BY checkId,generation;
        INSERT OR IGNORE INTO check_generations(checkId,generation,fingerprint)
          SELECT checkId,generation,'' FROM incidents GROUP BY checkId,generation;
        PRAGMA user_version=3;`);
    }
    if (version < 4) {
      db.exec(`CREATE TABLE server_groups(id TEXT PRIMARY KEY,name TEXT NOT NULL COLLATE NOCASE UNIQUE);
        CREATE TABLE server_registry(id TEXT PRIMARY KEY,definition TEXT NOT NULL,guid TEXT UNIQUE,enabled INTEGER NOT NULL DEFAULT 1,archived INTEGER NOT NULL DEFAULT 0,groupId TEXT,discovery TEXT,lastSeen TEXT);
        PRAGMA user_version=4;`);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
