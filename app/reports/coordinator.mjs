import { sha256 } from "./request.mjs";
import { authorizeReport } from './policy.mjs';

// Durable dispatch leases. A lost HTTP response repeats the same runtime run ID,
// never creates a replacement job. Runtime admission owns execution idempotency.
export async function reconcileReports(db, { inspectChannel, runtime, validateCompletion, now = Date.now }, limit = 5) {
  const time = now();
  const rows = await db.prepare(`SELECT j.* FROM report_jobs j JOIN agent_runs r ON r.id=j.run_id
    WHERE r.status IN ('queued','running') AND j.lease_until<=? AND j.next_attempt_at<=?
    ORDER BY j.created_at LIMIT ?`).bind(time, time, Math.min(10, limit)).all();
  for (const job of rows.results) {
    const fence = job.fence + 1;
    const claimed = await db.prepare('UPDATE report_jobs SET fence=?,lease_until=? WHERE run_id=? AND fence=? AND lease_until<=?')
      .bind(fence, time + 120_000, job.run_id, job.fence, time).run();
    if (!claimed.meta.changes) continue;
    const owns = 'EXISTS(SELECT 1 FROM report_jobs WHERE run_id=? AND fence=? AND lease_until>?)';
    try {
      if (now() - job.created_at >= 86_400_000) throw Object.assign(new Error('report_deadline_exceeded'), { status: 403 });
      const request = JSON.parse(job.request_json), config = JSON.parse(job.config_json);
      const current = await authorizeReport(db, request, inspectChannel, now());
      if (current.revision !== config.revision) throw Object.assign(new Error('report_configuration_changed'), { status: 403 });
      let status = await runtime('status', { runId: job.run_id });
      if (!status) {
        if (job.dispatch_attempts >= 8) throw Object.assign(new Error('dispatch_attempts_exhausted'), { status: 403 });
        await db.prepare('UPDATE report_jobs SET dispatch_attempts=dispatch_attempts+1 WHERE run_id=? AND fence=?').bind(job.run_id, fence).run();
        status = await runtime('accept', { schemaVersion: 1, action: 'generate_ai_referral_report', runId: job.run_id, attempt: 1,
          projectId: config.project_id, configRevision: config.revision, referenceId: config.reference_id,
          referenceSha256: config.reference_sha256, sourceConfigId: config.source_config_id });
      }
      if (status.runId !== job.run_id || status.attempt !== 1 || !Number.isSafeInteger(status.sequence) || status.sequence < job.sequence ||
          !['queued','running','waiting_for_review','succeeded','failed','timed_out'].includes(status.status)) throw new Error('invalid_runtime_status');
      const terminal = ['succeeded','failed','timed_out'].includes(status.status);
      const result = status.status === 'succeeded' ? await validateCompletion(status.result, config, job.run_id) : null;
      const structured = result ? JSON.stringify(result) : '{}';
      await db.batch([
        db.prepare(`INSERT OR IGNORE INTO agent_run_events(id,run_id,sequence,event_type,stage,message,occurred_at,received_at)
          SELECT ?,run_id,?,?,?,?,?,? FROM report_jobs WHERE run_id=? AND fence=? AND lease_until>? AND sequence<?`)
          .bind(`rue_${crypto.randomUUID()}`, status.sequence, terminal ? status.status : 'progress', status.stage || status.status,
            terminal ? `Report execution ${status.status}` : 'Report generation in progress', now(), now(), job.run_id, fence, now(), status.sequence),
        db.prepare(`INSERT OR IGNORE INTO agent_results(id,run_id,schema_name,schema_version,summary,structured_data,validation_status,content_hash,created_at)
          SELECT ?,run_id,'ai-referral-report-result',1,?,?,'valid',?,? FROM report_jobs WHERE run_id=? AND fence=? AND lease_until>? AND ?=1`)
          .bind(`res_${crypto.randomUUID()}`, result ? `AI referral report: ${result.metrics.ga4.sessions} GA4 sessions; ${result.metrics.firstParty.visits} first-party visits` : '', structured, await sha256(structured), now(), job.run_id, fence, now(), result ? 1 : 0),
        db.prepare(`UPDATE agent_runs SET status=?,failure_code=?,completed_at=?,updated_at=? WHERE id=? AND ${owns}`)
          .bind(terminal ? status.status : 'running', terminal && status.status !== 'succeeded' ? 'report_execution_failed' : null, terminal ? now() : null, now(), job.run_id, job.run_id, fence, now()),
        db.prepare('UPDATE report_jobs SET stage=?,sequence=?,result_json=?,lease_until=0,next_attempt_at=?,updated_at=? WHERE run_id=? AND fence=? AND lease_until>?')
          .bind(status.stage || status.status, status.sequence, result ? JSON.stringify(result) : null, now()+15_000, now(), job.run_id, fence, now()),
      ]);
    } catch (error) {
      const terminal = error.status === 403;
      await db.batch([
        db.prepare(`UPDATE agent_runs SET status='failed',failure_code='report_authority_or_dispatch_denied',completed_at=?,updated_at=? WHERE id=? AND ?=1 AND ${owns}`)
          .bind(now(), now(), job.run_id, terminal ? 1 : 0, job.run_id, fence, now()),
        db.prepare('UPDATE report_jobs SET lease_until=0,next_attempt_at=?,updated_at=? WHERE run_id=? AND fence=? AND lease_until>?')
          .bind(now()+60_000, now(), job.run_id, fence, now()),
      ]);
    }
  }
}
