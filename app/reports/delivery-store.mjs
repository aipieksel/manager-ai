import { authorizeReport, ReportError } from './policy.mjs';

export async function claimDelivery(db, now = Date.now()) {
  const row = await db.prepare(`SELECT d.*,j.request_json,j.result_json,r.status AS execution_status FROM slack_report_deliveries d JOIN report_jobs j ON j.run_id=d.run_id JOIN agent_runs r ON r.id=d.run_id
    WHERE d.state NOT IN ('delivered','held','failed') AND d.attempts<12 AND d.lease_until<=? AND d.next_attempt_at<=?
    AND (d.state='pending' OR r.status IN ('failed','timed_out','cancelled') OR (r.status='succeeded' AND j.result_json IS NOT NULL)) ORDER BY d.created_at LIMIT 1`).bind(now,now).first();
  if (!row) return null;
  const fence = row.fence+1;
  const changed = await db.prepare('UPDATE slack_report_deliveries SET fence=?,lease_until=?,attempts=attempts+1 WHERE run_id=? AND fence=? AND lease_until<=?')
    .bind(fence,now+120_000,row.run_id,row.fence,now).run();
  if (!changed.meta.changes) return null;
  return {runId:row.run_id,requesterUserId:JSON.parse(row.request_json).source.userId,channelId:row.channel_id,rootThreadTs:row.root_thread_ts,state:row.state,fileId:row.file_id,fence,executionStatus:row.execution_status,result:row.result_json?JSON.parse(row.result_json):null};
}

export async function authorizeDelivery(db, claim, inspectChannel, now = Date.now()) {
  if (!claim || typeof claim.runId !== 'string' || !Number.isSafeInteger(claim.fence)) throw new ReportError('invalid_delivery_claim',400);
  const job = await db.prepare(`SELECT j.* FROM report_jobs j JOIN slack_report_deliveries d ON d.run_id=j.run_id
    WHERE j.run_id=? AND d.fence=? AND d.lease_until>? AND d.state NOT IN ('delivered','held','failed')`).bind(claim.runId,claim.fence,now).first();
  if (!job) throw new ReportError('stale_delivery_claim',409);
  const current=await authorizeReport(db,JSON.parse(job.request_json),inspectChannel,now);
  if(current.revision!==job.config_revision) throw new ReportError('report_configuration_changed');
  return job;
}

const transitions = {pending:['parent_posting','parent_ready'],parent_posting:['parent_ready','held','failed'],parent_ready:['uploading','failure_posting'],failure_posting:['failed','held'],uploading:['uploaded','parent_ready'],uploaded:['completing'],completing:['delivered','delivery_unknown'],delivery_unknown:['delivered','delivery_unknown']};
export async function saveDelivery(db,claim,patch,now=Date.now()) {
  if (!patch || typeof patch !== 'object' || Object.keys(patch).some(k=>!['state','fileId','rootThreadTs','errorCode'].includes(k))) throw new ReportError('invalid_delivery_patch',400);
  const row=await db.prepare('SELECT * FROM slack_report_deliveries WHERE run_id=? AND fence=? AND lease_until>?').bind(claim.runId,claim.fence,now).first();
  if(!row || !transitions[row.state]?.includes(patch.state)) throw new ReportError('stale_delivery_claim',409);
  if(patch.fileId!==undefined && patch.fileId!==null && !/^F[A-Z0-9]+$/.test(patch.fileId)) throw new ReportError('invalid_delivery_patch',400);
  if(patch.rootThreadTs!==undefined && !/^[0-9]{10,}\.[0-9]{6}$/.test(patch.rootThreadTs)) throw new ReportError('invalid_delivery_patch',400);
  if(row.root_thread_ts && patch.rootThreadTs!==undefined && patch.rootThreadTs!==row.root_thread_ts) throw new ReportError('invalid_delivery_patch',400);
  const result=await db.prepare('UPDATE slack_report_deliveries SET state=?,file_id=?,root_thread_ts=?,error_code=?,updated_at=? WHERE run_id=? AND fence=? AND state=? AND lease_until>?')
    .bind(patch.state,patch.fileId===undefined?row.file_id:patch.fileId,patch.rootThreadTs??row.root_thread_ts,patch.errorCode?String(patch.errorCode).slice(0,100):null,now,claim.runId,claim.fence,row.state,now).run();
  if(!result.meta.changes) throw new ReportError('stale_delivery_claim',409);
}

export async function releaseDelivery(db,claim,now=Date.now()) {
  await db.prepare(`UPDATE slack_report_deliveries SET lease_until=0,next_attempt_at=?,
    state=CASE WHEN attempts>=12 AND state NOT IN ('delivered','failed') THEN 'held' ELSE state END,
    updated_at=? WHERE run_id=? AND fence=? AND lease_until>?`).bind(now+15_000,now,claim.runId,claim.fence,now).run();
}
