import { routeReport, REPORT_HELP } from './report-routing.mjs';

// Report requests never fall through to the general-purpose agent path.
// The Slack acknowledgement happens only after the durable spool commit.
export async function intakeReport(envelope, installation, inbox, acknowledge) {
  const routed = await routeReport(envelope, installation);
  if (routed.kind === 'unrelated') return false;
  if (routed.kind !== 'request') {
    await acknowledge(envelope, REPORT_HELP);
    return true;
  }
  if (!inbox) {
    await acknowledge(envelope, 'AI referral reports are not enabled.');
    return true;
  }
  await inbox.put(routed.request);
  await acknowledge(envelope);
  return true;
}

export async function drainReportInbox(inbox, send, limit = 10, onReject = async () => {}) {
  if (!inbox) return;
  for (let i = 0; i < limit; i++) {
    const claim = inbox.claim();
    if (!claim) break;
    try {
      const result = await send({ action: 'report.request', request: claim.request });
      if (!result.accepted || typeof result.runId !== 'string') throw new Error('invalid_acceptance');
      inbox.settle(claim, 'accepted');
    } catch (error) {
      const rejected = [400, 403, 409].includes(error.status);
      if (rejected) { try { await onReject(claim.request); } catch { inbox.settle(claim, 'retry', 30_000); continue; } }
      inbox.settle(claim, rejected ? 'rejected' : 'retry', 30_000);
    }
  }
}
