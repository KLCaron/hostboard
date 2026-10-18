import { DatabaseSync, backup } from "node:sqlite";
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, renameSync, createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
process.umask(0o077);
const [command, file] = process.argv.slice(2);
const live = process.env.HOSTBOARD_DB || "data/monitor.sqlite";
if (!file || !["backup", "restore"].includes(command)) throw Error("Usage: maintenance.js backup|restore FILE");
if (command === "backup") {
  if (!existsSync(live) || existsSync(file)) throw Error("Database missing or backup already exists");
  mkdirSync(path.dirname(file), {recursive:true,mode:0o700});
  const db = new DatabaseSync(live, {readOnly:true});
  try { await backup(db, file); chmodSync(file,0o600); }
  finally { db.close(); }
  // A standalone backup must be readable on read-only recovery media without
  // needing to create WAL/SHM sidecars next to it.
  const checkpoint = new DatabaseSync(file);
  try { checkpoint.exec("PRAGMA journal_mode=DELETE"); }
  finally { checkpoint.close(); }
} else {
  // Run only while the application is stopped. The host helper enforces this.
  if (path.resolve(file) === path.resolve(live)) throw Error("Restore source must be a separate file");
  const temporary = `${live}.restore-${randomUUID()}`;
  if (file === "-") await pipeline(process.stdin, createWriteStream(temporary, {flags:"wx",mode:0o600}));
  else copyFileSync(file, temporary);
  chmodSync(temporary,0o600);
  const source = new DatabaseSync(temporary);
  try {
    source.exec("PRAGMA journal_mode=DELETE");
    const schema = source.prepare("PRAGMA user_version").get() as {user_version:number};
    const integrity = source.prepare("PRAGMA quick_check").get() as {quick_check:string};
    if (schema.user_version !== 1 || integrity.quick_check !== "ok" || !source.prepare("SELECT id FROM app_settings WHERE id=1").get()) throw Error("Invalid or incompatible backup");
  } catch (error) {
    source.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(temporary+suffix,{force:true});
    throw error;
  }
  source.close();
  for (const suffix of ["-wal","-shm"]) rmSync(live+suffix,{force:true});
  renameSync(temporary, live);
}
console.log(`${command} completed`);
