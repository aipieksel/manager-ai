import { sha256, validateRequest } from "./request.mjs";
import { authorizeReport, ReportError } from "./policy.mjs";

export async function acceptReport(db, payload, inspectChannel, now = Date.now()) {
  let request;
  try { request = await validateRequest(payload); } catch { throw new ReportError("invalid_request", 400); }
  const config = await authorizeReport(db, request, inspectChannel, now);
  const body = JSON.stringify(request), hash = await sha256(body);
  const existing = await db.prepare("SELECT run_id,payload_hash FROM report_jobs WHERE invocation_key=?").bind(request.invocationKey).first();
  if (existing) {
    if (existing.payload_hash !== hash) throw new ReportError("idempotency_conflict", 409);
    return { accepted: true, duplicate: true, runId: existing.run_id };
  }
  const runId = `run_${crypto.randomUUID().replaceAll("-", "")}`;
  const s = request.source;
  // D1 batch is one transaction. Conditional insert enforces capacity and
  // live grant/config checks in that same write transaction; all dependent
  // inserts SELECT only this newly-created run and roll back on uniqueness.
  try {
    await db.batch([
      db.prepare(`INSERT INTO report_jobs(run_id,invocation_key,payload_hash,installation_id,project_id,requester_id,channel_id,config_revision,request_json,config_json,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE
        (SELECT COUNT(*) FROM report_jobs j JOIN agent_runs r ON r.id=j.run_id WHERE r.status IN ('queued','running'))<100
        AND (SELECT COUNT(*) FROM report_jobs j JOIN agent_runs r ON r.id=j.run_id WHERE j.requester_id=? AND j.installation_id=? AND r.status IN ('queued','running'))<3
        AND EXISTS(SELECT 1 FROM report_configurations WHERE report_key=? AND enabled=1 AND revision=?)
        AND EXISTS(SELECT 1 FROM report_grants WHERE installation_id=? AND user_id IN (?,?) AND report_key=? AND project_id=? AND active=1)
        AND EXISTS(SELECT 1 FROM report_channel_policies WHERE installation_id=? AND channel_id=? AND report_key=? AND enabled=1)`)
        .bind(runId, request.invocationKey, hash, config.installation_id, config.project_id, s.userId, s.channelId, config.revision, body, JSON.stringify(config), now, now, s.userId, config.installation_id, request.reportKey, config.revision, config.installation_id, s.userId, `channel:${s.channelId}`, request.reportKey, config.project_id, config.installation_id, s.channelId, request.reportKey),
      db.prepare(`INSERT INTO agent_runs(id,agent_id,agent_version_id,project_id,trigger_type,trigger_ref,input_snapshot,idempotency_key,status,requested_by,created_at,updated_at)
        SELECT run_id,?,?,project_id,'slack_report',invocation_key,request_json,invocation_key,'queued',?,?,? FROM report_jobs WHERE run_id=?`)
        .bind(config.executor_id, config.executor_version_id, `slack:${s.userId}`, now, now, runId),
      db.prepare(`INSERT INTO agent_run_events(id,run_id,sequence,event_type,stage,message,occurred_at,received_at)
        SELECT ?,run_id,1,'queued','preflight','Standard AI referral report accepted',?,? FROM report_jobs WHERE run_id=?`).bind(`rue_${crypto.randomUUID()}`, now, now, runId),
      db.prepare(`INSERT INTO slack_report_deliveries(run_id,installation_id,channel_id,root_thread_ts,created_at,updated_at)
        SELECT run_id,installation_id,channel_id,?,?,? FROM report_jobs WHERE run_id=?`).bind(s.rootThreadTs, now, now, runId),
      db.prepare(`INSERT INTO audit_events(id,actor,action,object_type,object_id,result,metadata,occurred_at)
        SELECT ?,?,'Accepted AI referral report','agent_run',run_id,'queued','{}',? FROM report_jobs WHERE run_id=?`).bind(`aud_${crypto.randomUUID()}`, `slack:${s.userId}`, now, runId),
    ]);
  } catch {
    const raced = await db.prepare("SELECT run_id,payload_hash FROM report_jobs WHERE invocation_key=?").bind(request.invocationKey).first();
    if (!raced) throw new ReportError("report_acceptance_write_failed", 503);
    if (raced.payload_hash !== hash) throw new ReportError("idempotency_conflict", 409);
    return { accepted: true, duplicate: true, runId: raced.run_id };
  }
  if (!await db.prepare("SELECT run_id FROM report_jobs WHERE run_id=?").bind(runId).first()) throw new ReportError("queue_full", 429);
  return { accepted: true, duplicate: false, runId, executionStatus: "queued", deliveryStatus: "pending" };
}
