import { runtimeEnv } from '../server-security';
import { getRunnerConfiguration } from '../setup-server';
import { reconcileReports } from './coordinator.mjs';
import { validateResult } from './result.mjs';

export async function getReportRuntimeConfiguration() {
  const values = runtimeEnv();
  if (values.MANAGERAI_REPORT_RUNTIME_URL || values.MANAGERAI_REPORT_RUNTIME_TOKEN) {
    if (!values.MANAGERAI_REPORT_RUNTIME_URL || !values.MANAGERAI_REPORT_RUNTIME_TOKEN) throw new Error('report_runtime_unavailable');
    const url = new URL(values.MANAGERAI_REPORT_RUNTIME_URL);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
        !(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '172.17.0.1'].includes(url.hostname)))) throw new Error('report_runtime_unavailable');
    return { url: url.origin, token: values.MANAGERAI_REPORT_RUNTIME_TOKEN };
  }
  return getRunnerConfiguration();
}

export async function inspectReportChannel(teamId: string, channelId: string, userId?: string) {
  const values = runtimeEnv();
  if (!values.MANAGERAI_SLACK_STATUS_URL || !values.MANAGERAI_SLACK_MANAGEMENT_TOKEN) throw Object.assign(new Error('report_channel_worker_unconfigured'), {code:'report_channel_worker_unconfigured'});
  const response = await fetch(new URL('/v1/report-channel', values.MANAGERAI_SLACK_STATUS_URL), {
    method: 'POST', headers: { authorization: `Bearer ${values.MANAGERAI_SLACK_MANAGEMENT_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ teamId, channelId, ...(userId ? {userId} : {}) }), signal: AbortSignal.timeout(15_000), redirect: 'manual',
  }).catch(() => { throw Object.assign(new Error('report_channel_transport_failed'), {code:'report_channel_transport_failed'}); });
  if (!response.ok) throw Object.assign(new Error('report_channel_worker_failed'), {code:`report_channel_worker_http_${response.status}`});
  return ((await response.json()) as {channel: unknown}).channel;
}

export async function reconcileReportJobs(database: D1Database) {
  const runner = await getReportRuntimeConfiguration();
  if (!runner.url || !runner.token) throw new Error('report_runtime_unavailable');
  const request = async (path: string, body?: unknown) => fetch(new URL(path, runner.url!), {
    method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${runner.token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'manual', signal: AbortSignal.timeout(30_000),
  });
  await reconcileReports(database, {
    inspectChannel: inspectReportChannel,
    runtime: async (action: string, payload: {runId: string}) => {
      const response = await request(action === 'accept' ? '/v1/reports' : `/v1/reports/${encodeURIComponent(payload.runId)}`, action === 'accept' ? payload : undefined);
      if (action === 'status' && response.status === 404) return null;
      if (!response.ok) throw new Error('report_runtime_unavailable');
      return response.json();
    },
    validateCompletion: async (result: {artifact: {artifactId: string}}, config: {reference_id: string; reference_sha256: string}, runId: string) => {
      const response = await request(`/v1/reports/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(result.artifact.artifactId)}`);
      if (!response.ok || Number(response.headers.get('content-length')) > 25 * 1024 * 1024) throw new Error('artifact_unavailable');
      const reader = response.body?.getReader();
      if (!reader) throw new Error('artifact_unavailable');
      const chunks: Uint8Array[] = []; let length = 0;
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) break;
          length += chunk.value.length; if (length > 25 * 1024 * 1024) throw new Error('artifact_limit');
          chunks.push(chunk.value);
        }
      } finally { await reader.cancel(); }
      const bytes = new Uint8Array(length); let offset=0;
      for (const chunk of chunks) { bytes.set(chunk,offset); offset+=chunk.length; }
      return validateResult(result, { runId, referenceArtifactId: config.reference_id, referenceSha256: config.reference_sha256, bytes,
        verifyEvidence: async (evidenceId: string, sha256: string) => {
          const proof = await request(`/v1/reports/${encodeURIComponent(runId)}/evidence/${encodeURIComponent(evidenceId)}`);
          if (!proof.ok) return false;
          const evidence = await proof.json() as {sha256?: string; verified?: boolean};
          return evidence.verified === true && evidence.sha256 === sha256;
        },
      });
    },
  }, 1);
}

export async function reportArtifact(runId: string, artifactId: string) {
  const runner = await getReportRuntimeConfiguration();
  if (!runner.url || !runner.token) throw new Error('report_runtime_unavailable');
  const response = await fetch(new URL(`/v1/reports/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`,runner.url), {
    headers:{authorization:`Bearer ${runner.token}`},signal:AbortSignal.timeout(30_000),redirect:'manual',
  });
  if(!response.ok || Number(response.headers.get('content-length'))>25*1024*1024) throw new Error('artifact_unavailable');
  const reader=response.body?.getReader(); if(!reader) throw new Error('artifact_unavailable');
  let binary=''; let size=0;
  try { for (;;) { const chunk=await reader.read(); if(chunk.done) break; size+=chunk.value.length;
    if(size>25*1024*1024) throw new Error('artifact_limit');
    for(let i=0;i<chunk.value.length;i+=8192) binary+=String.fromCharCode(...chunk.value.subarray(i,i+8192));
  } } finally { await reader.cancel(); }
  return btoa(binary);
}

export async function reportPreflight() {
  const runner=await getReportRuntimeConfiguration();if(!runner.url||!runner.token)throw Error('Report runtime is not configured');
  const response=await fetch(new URL('/v1/reports/preflight',runner.url),{headers:{authorization:`Bearer ${runner.token}`},redirect:'manual',signal:AbortSignal.timeout(30_000)});
  if(!response.ok)throw Error('Runtime preflight requires a recent reviewed report and matching configuration');
  return response.json() as Promise<Record<string,unknown>>;
}
