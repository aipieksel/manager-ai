import importlib.util
from pathlib import Path
import tempfile
import threading
import unittest
import os
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runtime"))

spec = importlib.util.spec_from_file_location("reports", Path(__file__).resolve().parents[1] / "runtime/reports.py")
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)


class RuntimeBoundaryTests(unittest.TestCase):
    def test_invalid_actions_do_not_read_configuration(self):
        with tempfile.TemporaryDirectory() as tmp:
            runtime = module.ReportRuntime(Path(tmp).resolve(), "absent")
            runtime.config = lambda: self.fail("invalid request read configuration")
            for payload in [{}, {"action": "shell", "filePath": "/etc/passwd"}, []]:
                with self.assertRaisesRegex(ValueError, "invalid_report_request"):
                    runtime.accept(payload)

    def test_duplicate_and_cross_instance_capacity_use_process_locks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            config = {"projectId": "project", "revision": 1, "referenceId": "reference", "referenceSha256": "a" * 64, "sourceConfigId": "source"}
            request = dict(schemaVersion=1, action="generate_ai_referral_report", runId="run_fixture", attempt=1, projectId="project", configRevision=1, referenceId="reference", referenceSha256="a"*64, sourceConfigId="source")
            first = module.ReportRuntime(root, "unused"); second = module.ReportRuntime(root, "unused")
            first.config = second.config = lambda: config
            ready, release, done = threading.Event(), threading.Event(), threading.Event()
            calls = []
            def executor(_config, payload, state, fd):
                calls.append(payload["runId"]); ready.set()
                release.wait(5); first.write(payload["runId"], {**state, "status": "failed", "errorCode": "fixture_complete"}); os.close(fd); done.set()
            first.execute = executor
            try:
                a = first.accept(request); self.assertTrue(ready.wait(2))
                b = second.accept(request); self.assertEqual(a, b); self.assertEqual(calls, ["run_fixture"])
                with self.assertRaisesRegex(ValueError, "capacity"):
                    second.accept({**request, "runId": "run_other"})
            finally:
                release.set(); self.assertTrue(done.wait(2))

    def test_paths_reject_traversal_and_symlinks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve(); runtime = module.ReportRuntime(root, "unused")
            for run in ["../secret", "/etc/passwd", ".", "a/b"]:
                with self.assertRaises(ValueError): runtime.directory(run)
            (root / "run_link").symlink_to(root)
            with self.assertRaises(ValueError): runtime.directory("run_link")


class ReviewLifecycleTests(unittest.TestCase):
    def test_review_is_digest_bound_and_no_review_does_not_rebuild(self):
        import json, hashlib, hmac
        fixture_spec = importlib.util.spec_from_file_location("package_fixture", Path(__file__).with_name("report-package.test.py"))
        fixture_module = importlib.util.module_from_spec(fixture_spec); fixture_spec.loader.exec_module(fixture_module)
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp).resolve(); root=base/'jobs'; work=root/'run_fixture'/'work'; work.mkdir(parents=True)
            evidence=base/'evidence'; evidence.mkdir()
            config=dict(enabled=True,projectId='project',revision=1,referenceId='reference',referenceSha256='a'*64,sourceConfigId='source',reviewEvidenceDirectory=str(evidence),reviewSecret='fixture-only-'*4,skillCommit='b'*40,reportCodeCommit='c'*40)
            runtime=module.ReportRuntime(root,'unused');runtime.config=lambda:config
            (work.parent/'execution.lock').touch()
            runtime.write('run_fixture',dict(runId='run_fixture',attempt=1,status='waiting_for_review',sequence=3,configurationDigest=module.configuration_digest(config)))
            data=fixture_module.fixture(); filename='website-ai-referrals-ga4-and-first-party-2026-09-01-to-2026-09-01.xlsx';(work/filename).write_bytes(data)
            sha=hashlib.sha256(data).hexdigest()
            coverage=dict(availableFrom='2026-09-01',availableThrough='2026-09-01',latestCompleteDate='2026-09-01',timezone='UTC',collectedAt='2026-09-02T00:00:00Z',coverageStatus='complete',missingIntervals=[])
            candidate=dict(runId='run_fixture',metrics={'ga4':{'sessions':10,'engagedSessions':6,'engagementRate':.6},'firstParty':{'visits':12}},sourceCoverage={'ga4':coverage,'firstParty':coverage},artifact=dict(artifactId='artifact_fixture',filename=filename,byteLength=len(data),sha256=sha,mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'))
            (work/'candidate.json').write_text(json.dumps(candidate));(work/'normalized.json').write_text(json.dumps({'snapshotHashes':{'ga4':'d'*64,'firstParty':'e'*64}}))
            (work/'job.json').write_text(json.dumps({**config,'configRevision':1}))
            self.assertEqual(runtime.finalize('run_fixture')['status'],'waiting_for_review')
            review=dict(runId='run_fixture',sha256=sha,status='passed',sheets=fixture_module.SHEETS,evidenceId='evidence_fixture')
            receipt={'review':review,'signature':'invalid'};(evidence/'run_fixture.json').write_text(json.dumps(receipt))
            with self.assertRaisesRegex(ValueError,'review_unavailable'):runtime.finalize('run_fixture')
            receipt['signature']=hmac.new(config['reviewSecret'].encode(),json.dumps(review,sort_keys=True,separators=(',',':')).encode(),hashlib.sha256).hexdigest()
            (evidence/'run_fixture.json').write_text(json.dumps(receipt))
            candidate['runId']='run_other';(work/'candidate.json').write_text(json.dumps(candidate))
            with self.assertRaisesRegex(ValueError,'run_identity_conflict'):runtime.finalize('run_fixture')
            candidate['runId']='run_fixture';(work/'candidate.json').write_text(json.dumps(candidate))
            config['executorId']='changed'
            with self.assertRaisesRegex(ValueError,'configuration_conflict'):runtime.finalize('run_fixture')
            del config['executorId']
            state=runtime.finalize('run_fixture');self.assertEqual(state['status'],'succeeded');self.assertEqual(state['sequence'],4)
            self.assertTrue(runtime.evidence('run_fixture','evidence_fixture')['verified'])
            self.assertEqual(runtime.artifact('run_fixture','artifact_fixture')[1],data)
            with self.assertRaisesRegex(ValueError,'artifact_unavailable'):runtime.artifact('run_fixture','artifact_other')
            review['sha256']='f'*64;(evidence/'run_fixture.json').write_text(json.dumps(receipt))
            with self.assertRaisesRegex(ValueError,'review_unavailable'):runtime.evidence('run_fixture','evidence_fixture')


if __name__ == '__main__': unittest.main()
