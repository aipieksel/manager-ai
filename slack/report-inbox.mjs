import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sha256, validateRequest } from "../app/reports/request.mjs";

// SQLite's atomic transactions/full synchronous journal provide a bounded durable
// local spool and cross-process claims without unsafe stale-PID file-lock recovery.
// No Slack token, response_url, original text or history is accepted here.
export class ReportInbox {
  constructor(directory, { capacity = 100, maxAttempts = 8, now = Date.now } = {}) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1000 || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) throw new Error("invalid_spool_limits");
    const absolute = path.resolve(directory);
    fs.mkdirSync(absolute, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(absolute) !== absolute || (fs.statSync(absolute).mode & 0o077) !== 0) throw new Error("unsafe_spool_directory");
    const target = path.join(absolute, "report-inbox.sqlite");
    const fd = fs.openSync(target, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
    const stat = fs.fstatSync(fd); fs.closeSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) throw new Error("unsafe_spool_file");
    this.db = new DatabaseSync(target);
    this.db.exec("PRAGMA busy_timeout=25; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS inbox (
      key TEXT PRIMARY KEY, hash TEXT NOT NULL, body TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      available_at INTEGER NOT NULL, lease_until INTEGER NOT NULL DEFAULT 0,
      fence INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    )`);
    this.capacity = capacity; this.maxAttempts = maxAttempts; this.now = now;
  }

  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = fn(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  async put(input) {
    const request = await validateRequest(input);
    const body = JSON.stringify(request), hash = await sha256(body);
    if (Buffer.byteLength(body) > 4096) throw new Error("invalid_request");
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT hash FROM inbox WHERE key=?").get(request.invocationKey);
      if (existing) {
        if (existing.hash !== hash) throw new Error("idempotency_conflict");
        return { duplicate: true };
      }
      if (this.db.prepare("SELECT COUNT(*) AS n FROM inbox").get().n >= this.capacity) throw new Error("queue_full");
      this.db.prepare("INSERT INTO inbox(key,hash,body,available_at,created_at) VALUES(?,?,?,?,?)").run(request.invocationKey, hash, body, this.now(), this.now());
      return { duplicate: false };
    });
  }

  claim() {
    return this.transaction(() => {
      const now = this.now();
      const row = this.db.prepare("SELECT * FROM inbox WHERE state='pending' AND attempts<? AND available_at<=? AND lease_until<=? ORDER BY created_at,key LIMIT 1").get(this.maxAttempts, now, now);
      if (!row) return null;
      const fence = row.fence + 1;
      this.db.prepare("UPDATE inbox SET fence=?,attempts=attempts+1,lease_until=? WHERE key=?").run(fence, now + 60_000, row.key);
      return { key: row.key, fence, request: JSON.parse(row.body) };
    });
  }

  settle(claim, outcome, retryAfterMs = 1000) {
    if (!["accepted", "rejected", "retry"].includes(outcome)) throw new Error("invalid_spool_outcome");
    if (!Number.isFinite(retryAfterMs) || retryAfterMs < 0 || retryAfterMs > 3600_000) throw new Error("invalid_retry_delay");
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM inbox WHERE key=? AND fence=? AND lease_until>?").get(claim.key, claim.fence, this.now());
      if (!row) throw new Error("stale_claim");
      if (outcome === "accepted" || outcome === "rejected") this.db.prepare("DELETE FROM inbox WHERE key=? AND fence=?").run(claim.key, claim.fence);
      else this.db.prepare("UPDATE inbox SET state=?,available_at=?,lease_until=0 WHERE key=? AND fence=?").run(row.attempts >= this.maxAttempts ? "held" : "pending", this.now() + retryAfterMs, claim.key, claim.fence);
    });
  }

  close() { this.db.close(); }
}
