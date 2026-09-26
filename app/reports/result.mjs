import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import schema from "./contracts/report-result.v1.schema.json" with { type: "json" };
import { sha256 } from "./request.mjs";

const ajv = new Ajv2020({ strict: true, allErrors: false });
addFormats(ajv);
const validate = ajv.compile(schema);
const date = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v;

export async function validateResult(result, { runId, referenceArtifactId, referenceSha256, bytes, verifyEvidence }) {
  if (!validate(result) || result.runId !== runId || result.provenance.referenceArtifactId !== referenceArtifactId || result.provenance.referenceSha256 !== referenceSha256) throw new Error("invalid_report_result");
  for (const coverage of Object.values(result.sourceCoverage)) {
    if (!date(coverage.availableFrom) || !date(coverage.availableThrough) || !date(coverage.latestCompleteDate) || coverage.availableFrom > coverage.availableThrough || coverage.latestCompleteDate > coverage.availableThrough) throw new Error("invalid_source_coverage");
    try { new Intl.DateTimeFormat("en", { timeZone: coverage.timezone }).format(); } catch { throw new Error("invalid_source_timezone"); }
    for (const interval of coverage.missingIntervals) {
      if (!date(interval.from) || !date(interval.through) || interval.from > interval.through) throw new Error("invalid_source_coverage");
    }
    if ((coverage.coverageStatus !== "complete" || coverage.missingIntervals.length) && (!result.warnings.length || result.quality === "complete")) throw new Error("missing_coverage_warning");
  }
  const g = result.metrics.ga4;
  if (!Number.isSafeInteger(g.sessions) || !Number.isSafeInteger(g.engagedSessions) || !Number.isSafeInteger(result.metrics.firstParty.visits) || g.engagedSessions > g.sessions || (g.sessions === 0 ? g.engagementRate !== null : g.engagementRate === null || Math.abs(g.engagementRate - g.engagedSessions / g.sessions) > 1e-9)) throw new Error("invalid_report_metrics");
  const f = result.sourceCoverage.firstParty;
  if (result.artifact.filename !== `website-ai-referrals-ga4-and-first-party-${f.availableFrom}-to-${f.availableThrough}.xlsx`) throw new Error("invalid_artifact_name");
  if (bytes.byteLength !== result.artifact.byteLength || bytes.byteLength > 25 * 1024 * 1024 || await sha256(bytes) !== result.artifact.sha256) throw new Error("artifact_mismatch");
  if (!await verifyEvidence(result.validation.visualEvidenceRef, result.artifact.sha256)) throw new Error("unverified_visual_evidence");
  return result;
}
