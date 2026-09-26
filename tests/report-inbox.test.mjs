import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ReportInbox } from "../slack/report-inbox.mjs";
import { invocationKey } from "../app/reports/request.mjs";

const example = JSON.parse(fs.readFileSync(new URL("../app/reports/examples/synthetic-request.example.json", import.meta.url)));
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "report-spool-"));
  const instances = [];
  t.after(() => { for (const db of instances) { try { db.close(); } catch {} } fs.rmSync(dir, { recursive: true }); });
  return { dir, open: () => { const db = new ReportInbox(dir, options); instances.push(db); return db; } };
}
test("intake survives close/reopen and stores only normalized metadata", async (t) => {
  const f = fixture(t); const first = f.open();
  await first.put(example); first.close();
  const next = f.open(); const claim = next.claim();
  assert.deepEqual(claim.request, example);
  next.settle(claim, "accepted");
  assert.equal(next.claim(), null);
  await assert.rejects(next.put({ ...example, response_url: "secret" }), /invalid_request/);
});
test("duplicate intake and conflicting normalized bodies", async (t) => {
  const db = fixture(t).open();
  assert.deepEqual(await db.put(example), { duplicate: false });
  assert.deepEqual(await db.put(example), { duplicate: true });
  await assert.rejects(db.put({ ...example, source: { ...example.source, userId: "UOTHER" } }), /idempotency_conflict/);
});
test("separate connections lease one item and fence stale workers", async (t) => {
  let now = 1000;
  const f = fixture(t, { now: () => now }); const a = f.open(), b = f.open();
  await a.put(example);
  const old = a.claim(); assert.equal(b.claim(), null);
  now += 60_001;
  const fresh = b.claim(); assert.ok(fresh.fence > old.fence);
  assert.throws(() => a.settle(old, "accepted"), /stale_claim/);
  b.settle(fresh, "accepted"); assert.equal(a.claim(), null);
});
test("capacity and retry budget are bounded without discarding uncertain intake", async (t) => {
  const db = fixture(t, { capacity: 1, maxAttempts: 1 }).open();
  await db.put(example);
  const source = { ...example.source, sourceEventId: "EvOTHER" };
  await assert.rejects(db.put({ ...example, source, invocationKey: await invocationKey(source) }), /queue_full/);
  db.settle(db.claim(), "retry");
  assert.equal(db.claim(), null);
  assert.equal(db.db.prepare("SELECT state FROM inbox").get().state, "held");
});
test("symlinked or public spool storage is refused", (t) => {
  const f = fixture(t);
  fs.symlinkSync(f.dir, f.dir + "-link");
  t.after(() => fs.unlinkSync(f.dir + "-link"));
  assert.throws(() => new ReportInbox(f.dir + "-link"), /unsafe_spool_directory/);
  fs.chmodSync(f.dir, 0o755);
  assert.throws(() => f.open(), /unsafe_spool_directory/);
});
