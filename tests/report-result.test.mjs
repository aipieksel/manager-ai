import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { validateResult } from "../app/reports/result.mjs";
import { sha256 } from "../app/reports/request.mjs";

const example = JSON.parse(fs.readFileSync(new URL("../app/reports/examples/synthetic-result.example.json", import.meta.url)));
async function fixture() {
  const result = structuredClone(example), bytes = new TextEncoder().encode("fixture bytes, not an actual XLSX");
  result.artifact.byteLength = bytes.length; result.artifact.sha256 = await sha256(bytes);
  return { result, context: { runId: result.runId, referenceArtifactId: result.provenance.referenceArtifactId, referenceSha256: result.provenance.referenceSha256, bytes, verifyEvidence: async () => true } };
}
test("valid synthetic result requires actual matching bytes and evidence callback", async () => {
  const { result, context } = await fixture();
  assert.equal(await validateResult(result, context), result);
  await assert.rejects(validateResult(result, { ...context, verifyEvidence: async () => false }), /unverified_visual_evidence/);
  await assert.rejects(validateResult(result, { ...context, bytes: new Uint8Array(0) }), /artifact_mismatch/);
  await assert.rejects(validateResult(result, { ...context, runId: "run_other" }), /invalid_report_result/);
});
test("unknown fields, wrong rates, impossible dates and changed reference are rejected", async () => {
  for (const change of [r => { r.filePath = "/private"; }, r => { r.metrics.ga4.engagementRate = .2; }, r => { r.metrics.ga4.engagedSessions = 101; }, r => { r.sourceCoverage.ga4.availableFrom = "2026-02-30"; }, r => { r.sourceCoverage.ga4.availableThrough = "2025-01-01"; }, r => { r.artifact.filename = "report.xlsx"; }, r => { r.provenance.referenceSha256 = "f".repeat(64); }]) {
    const { result, context } = await fixture(); change(result);
    await assert.rejects(validateResult(result, context));
  }
});
