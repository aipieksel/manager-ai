import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'runtime'))
import report_review as review


class ReviewTests(unittest.TestCase):
    def run_case(self, mutate=None, after=None):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); (root/'execution.lock').touch()
            runtime=Mock(); runtime.directory.return_value=root; runtime.state.return_value={'status':'waiting_for_review'}
            candidate={'artifact':{'sha256':'a'*64},'metrics':{'ga4':{'sessions':10}},'sourceCoverage':{}}
            previews={sheet:b'\x89PNG\r\n\x1a\nfixture' for sheet in review.SHEETS}
            calls=[]
            def invoke(command,prompt,cwd,log,timeout):
                calls.append(command)
                decision={'runId':'run_1','sha256':'a'*64,'status':'passed','sheets':{sheet:{'status':'passed','reason':'Legible visible worksheet.'} for sheet in review.SHEETS}}
                log.write_text('{"type":"item.completed","item":{"type":"agent_message"}}\n')
                if mutate: mutate(decision, log)
                (cwd/'decision.json').write_text(json.dumps(decision))
            snapshots=[(candidate,previews,'same'),(candidate,previews,after or 'same')]
            recorder=Mock(return_value='evidence_1')
            with patch.object(review,'snapshot',side_effect=snapshots):
                outcome=review.assess(runtime,'run_1',sys.executable,invoke=invoke,recorder=recorder)
            self.assertTrue((root/'review'/'outcome.json').is_file())
            repeated=review.assess(runtime,'run_1',sys.executable,invoke=lambda *args:self.fail('repeated model call'))
            self.assertEqual(repeated['reason'],'review_already_attempted')
            return outcome,recorder,calls

    def test_all_six_required_and_no_generation_tools(self):
        result, recorder, calls=self.run_case()
        self.assertEqual(result['status'],'passed'); recorder.assert_called_once()
        self.assertEqual(calls[0].count('--image'),6)
        self.assertIn('--ignore-user-config',calls[0]);self.assertIn('read-only',calls[0]);self.assertIn('shell_tool',calls[0])

    def test_reject_failed_sheet_missing_sheet_and_wrong_identity(self):
        for mutate in [lambda d,l:d['sheets']['Summary'].update(status='failed'),lambda d,l:d['sheets'].pop('GA4 Pages'),lambda d,l:d.update(sha256='b'*64),lambda d,l:d.update(runId='other')]:
            result, recorder,_=self.run_case(mutate)
            self.assertEqual(result['status'],'waiting_for_review'); recorder.assert_not_called()

    def test_reject_changed_inputs(self):
        result,recorder,_=self.run_case(after='changed')
        self.assertEqual(result['reason'],'review_inputs_changed');recorder.assert_not_called()

    def test_reject_tool_events(self):
        result,recorder,_=self.run_case(lambda d,l:l.write_text('{"item":{"type":"command_execution"}}'))
        self.assertEqual(result['reason'],'review_unexpected_tool');recorder.assert_not_called()

    def test_package_snapshot_rejects_mismatched_hash(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); work=root/'work';work.mkdir()
            (work/'report.xlsx').write_bytes(b'bad')
            (work/'candidate.json').write_text(json.dumps({'runId':'run_1','artifact':{'filename':'report.xlsx','byteLength':3,'sha256':'a'*64}}))
            runtime=Mock();runtime.directory.return_value=root
            with self.assertRaisesRegex(ValueError,'review_artifact_changed'):review.snapshot(runtime,'run_1')


if __name__=='__main__':unittest.main()
