import { sha256 } from "../app/reports/request.mjs";

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const safeText = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function summary(result) {
  const g = result.metrics.ga4, f = result.metrics.firstParty;
  return [
    `Standard Website AI referral report`,
    `GA4: ${g.sessions} sessions; ${g.engagedSessions} engaged sessions; engagement rate ${g.engagementRate === null ? "not defined (zero sessions)" : `${(g.engagementRate * 100).toFixed(1)}%`}.`,
    `GA4 coverage: ${safeText(result.sourceCoverage.ga4.availableFrom)} to ${safeText(result.sourceCoverage.ga4.availableThrough)}.`,
    `First-party: ${f.visits} visits; coverage ${safeText(result.sourceCoverage.firstParty.availableFrom)} to ${safeText(result.sourceCoverage.firstParty.availableThrough)}.`,
    ...result.warnings.map((warning) => safeText(typeof warning === "string" ? warning : warning.message)),
  ].join("\n").slice(0, 3000);
}

export function completionComment(delivery) {
  if (!/^[UW][A-Z0-9]{1,79}$/.test(delivery.requesterUserId ?? "")) throw new Error("invalid_report_requester");
  return `<@${delivery.requesterUserId}> your AI referral report is ready.\n${summary(delivery.result)}`;
}

export function verifiedSlackUploadUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "files.slack.com" || url.port || url.username || url.password || url.hash || !url.pathname.startsWith("/upload/")) throw new Error("invalid_upload_target");
  return url.href;
}

export function confirmsShare(file, delivery) {
  if (file?.id !== delivery.fileId) return false;
  const shares = file.shares;
  for (const visibility of ["public", "private"]) {
    const entries = shares?.[visibility]?.[delivery.channelId];
    if (Array.isArray(entries) && entries.some((share) => share.thread_ts === delivery.rootThreadTs)) return true;
  }
  return false;
}

// Each call advances at most one external side effect. save() is a durable CAS
// against the current lease/fence; authorize() rechecks policy and lease before
// the effect. Unknown publication outcomes are held or reconciled, never replayed.
export async function advanceDelivery(delivery, { authorize, save, slack, artifact, upload }) {
  await authorize();
  if (["delivered", "held", "failed"].includes(delivery.state)) return delivery.state;
  const executionFailed = ["failed", "timed_out", "cancelled"].includes(delivery.executionStatus);
  const failureText = "The AI referral workbook could not be generated. The run is preserved in ManagerAI for the owner to review.";
  if (delivery.state === "failure_posting") { await save({ state: "held", errorCode: "failure_notice_outcome_unknown" }); return "held"; }
  if (delivery.state === "parent_ready" && executionFailed) {
    await save({ state: "failure_posting" }); await authorize();
    const response = await slack("chat.postMessage", { channel: delivery.channelId, thread_ts: delivery.rootThreadTs, text: failureText, unfurl_links: false, unfurl_media: false });
    if (!response.ok) throw new Error("failure_notice_outcome_unknown");
    await save({ state: "failed" }); return "failed";
  }
  if (delivery.state === "parent_posting") {
    await save({ state: "held", errorCode: "parent_outcome_unknown" }); return "held";
  }
  if (delivery.state === "uploading") {
    // No completion was attempted. Abandon the unshared reservation instead
    // of storing a bearer upload URL or assuming the byte upload succeeded.
    await save({ state: "parent_ready", fileId: null }); return "parent_ready";
  }
  if (delivery.state === "pending") {
    if (delivery.rootThreadTs) { await save({ state: "parent_ready" }); return "parent_ready"; }
    await save({ state: "parent_posting" });
    await authorize();
    const response = await slack("chat.postMessage", { channel: delivery.channelId, text: executionFailed ? failureText : `Generating the standard Website AI referral report. The workbook will be returned in this thread. [${delivery.runId}]`, unfurl_links: false, unfurl_media: false });
    if (!response.ok || !/^[0-9]{10,}\.[0-9]{6}$/.test(response.ts)) throw new Error("parent_outcome_unknown");
    await save({ state: executionFailed ? "failed" : "parent_ready", rootThreadTs: response.ts }); return executionFailed ? "failed" : "parent_ready";
  }
  if (delivery.state === "completing" || delivery.state === "delivery_unknown") {
    const response = await slack("files.info", { file: delivery.fileId });
    if (!response.ok) throw new Error("delivery_lookup_failed");
    if (confirmsShare(response.file, delivery)) { await save({ state: "delivered" }); return "delivered"; }
    await save({ state: "delivery_unknown", errorCode: "publication_unconfirmed" }); return "delivery_unknown";
  }
  if (delivery.state !== "parent_ready" && delivery.state !== "uploaded") throw new Error("invalid_delivery_state");
  if (!delivery.result) return delivery.state; // generation still pending
  if (delivery.state === "uploaded") {
    const comment = completionComment(delivery);
    await save({ state: "completing" });
    await authorize();
    const response = await slack("files.completeUploadExternal", { files: [{ id: delivery.fileId, title: "Website AI referral report" }], channel_id: delivery.channelId, thread_ts: delivery.rootThreadTs, initial_comment: comment });
    if (!response.ok) throw new Error("completion_outcome_unknown");
    await save({ state: "delivered" }); return "delivered";
  }
  const meta = delivery.result.artifact;
  const bytes = await artifact();
  if (meta.mimeType !== XLSX_MIME || bytes.byteLength !== meta.byteLength || bytes.byteLength > 25 * 1024 * 1024 || await sha256(bytes) !== meta.sha256) throw new Error("artifact_mismatch");
  // Reservation and upload are safe to abandon before finalization; no channel
  // side effect occurs. Persist the file ID before sending bytes.
  const reservation = await slack("files.getUploadURLExternal", { filename: meta.filename, length: meta.byteLength });
  if (!reservation.ok || !/^F[A-Z0-9]+$/.test(reservation.file_id)) throw new Error("upload_reservation_failed");
  const url = verifiedSlackUploadUrl(reservation.upload_url);
  await save({ state: "uploading", fileId: reservation.file_id });
  await authorize();
  const response = await upload(url, bytes, { redirect: "error" });
  if (!response.ok) throw new Error("byte_upload_failed");
  await save({ state: "uploaded" }); return "uploaded";
}
