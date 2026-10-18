import { DatabaseSync, backup } from "node:sqlite";
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
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
} else {
  // Run only while the application is stopped. The host helper enforces this.
  if (path.resolve(file) === path.resolve(live)) throw Error("Restore source must be a separate file");
  const source = new DatabaseSync(file,{readOnly:true});
  try {
    const schema = source.prepare("PRAGMA user_version").get() as {user_version:number};
    const integrity = source.prepare("PRAGMA quick_check").get() as {quick_check:string};
    if (schema.user_version !== 1 || integrity.quick_check !== "ok" || !source.prepare("SELECT id FROM app_settings WHERE id=1").get()) throw Error("Invalid or incompatible backup");
  } finally {source.close();}
  copyFileSync(file,live); chmodSync(live,0o600);
  for (const suffix of ["-wal","-shm"]) rmSync(live+suffix,{force:true});
}
console.log(`${command} completed`);
