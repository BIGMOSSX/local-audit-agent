// Holds a write (RESERVED) lock on a SQLite file for a while, then releases it.
// usage: node hold-db-lock.mjs <file> <holdMs>   (prints "locked" once the lock is held)
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(process.argv[2]);
db.exec("BEGIN IMMEDIATE");
console.log("locked");
setTimeout(() => {
  db.exec("COMMIT");
  db.close();
}, Number(process.argv[3]));
