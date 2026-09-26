import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("project_runner", Path(__file__).resolve().parents[1] / "project-runtime/runner.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class ProvenanceTests(unittest.TestCase):
    def test_only_explicit_owner_source_has_owner_label(self):
        self.assertIn("The owner sent", runner.source_provenance({"sourceType": "owner_chat"}))
        for source in ["slack_mention", "slack_command", "slack_message", "slack_thread_reply", "authenticated_agent_contact"]:
            label = runner.source_provenance({"sourceType": source, "principalId": "U123"})
            self.assertNotIn("The owner sent", label)
            self.assertIn("U123", label)

    def test_unknown_source_fails_closed(self):
        for context in [{}, {"sourceType": "unknown"}, {"sourceType": None}]:
            with self.assertRaisesRegex(ValueError, "unsupported_request_source"):
                runner.source_provenance(context)


if __name__ == "__main__":
    unittest.main()
