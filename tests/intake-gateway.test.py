import hashlib
import hmac
import json
import pathlib
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from intake import gateway


class IntakeGatewaySocialPostTests(unittest.TestCase):
    def signed(self, payload, principal=None):
        principal = principal or {
            "secret": "a" * 32,
            "allowedAuthority": ["notify"],
            "allowedProjects": [],
        }
        body = json.dumps(payload, separators=(",", ":")).encode()
        timestamp = str(int(time.time()))
        digest = hmac.new(principal["secret"].encode(), f"{timestamp}.".encode() + body, hashlib.sha256).hexdigest()
        headers = {"x-agent-id": "marketing-bot", "x-timestamp": timestamp, "x-signature": f"sha256={digest}"}
        return headers, body, principal

    def validate(self, payload, principal=None):
        headers, body, principal = self.signed(payload, principal)
        with patch.object(gateway, "contact_principals", return_value={"marketing-bot": principal}):
            return gateway.validate_event(headers, body, True)

    def test_accepts_notify_only_linkedin_completion(self):
        payload = {
            "type": "social.post.published",
            "idempotency_key": "linkedin-123",
            "principal": "marketing-bot",
            "authority": ["notify"],
            "platform": "linkedin",
            "post_url": "https://www.linkedin.com/posts/example-123",
            "title": "Launch note",
            "summary": "Published successfully",
        }
        normalized, principal, key = self.validate(payload)
        self.assertEqual(principal, "marketing-bot")
        self.assertEqual(key, "linkedin-123")
        self.assertEqual(normalized["authority"], ["notify"])

    def test_rejects_notify_mixed_with_broader_authority(self):
        payload = {
            "type": "social.post.published", "idempotency_key": "x-123",
            "authority": ["notify", "edit"], "platform": "x",
            "post_url": "https://x.com/example/status/123", "title": "Launch note",
        }
        principal = {"secret": "a" * 32, "allowedAuthority": ["notify", "edit"], "allowedProjects": []}
        with self.assertRaisesRegex(PermissionError, "authority_rejected"):
            self.validate(payload, principal)

    def test_rejects_wrong_hostname_and_credential_markers(self):
        bad_url = {
            "type": "social.post.published", "idempotency_key": "x-124",
            "authority": ["notify"], "platform": "x",
            "post_url": "https://x.com.evil.test/example/status/123", "title": "Launch note",
        }
        with self.assertRaisesRegex(ValueError, "invalid_social_post"):
            self.validate(bad_url)
        leaked_secret = {**bad_url, "idempotency_key": "x-125", "post_url": "https://x.com/example/status/123", "summary": "token=do-not-send"}
        with self.assertRaisesRegex(ValueError, "credential_material_rejected"):
            self.validate(leaked_secret)

    def test_accepts_static_and_variable_trigger_notifications(self):
        static_payload = {
            "type": "notification.triggered", "idempotency_key": "marketing-both-123",
            "principal": "marketing-bot", "authority": ["notify"],
            "trigger": "marketing_posts_published", "platforms": ["linkedin", "x"],
            "variables": {},
        }
        normalized, principal, key = self.validate(static_payload)
        self.assertEqual(principal, "marketing-bot")
        self.assertEqual(key, "marketing-both-123")
        self.assertEqual(normalized["trigger"], "marketing_posts_published")
        self.assertEqual(normalized["variables"], {})

        variable_payload = {
            **static_payload, "idempotency_key": "marketing-both-124",
            "variables": {"campaign": "August launch", "attempt": 2, "verified": True},
        }
        normalized, _, _ = self.validate(variable_payload)
        self.assertEqual(normalized["variables"], {"campaign": "August launch", "attempt": "2", "verified": "True"})

    def test_rejects_unsafe_trigger_shapes_and_wrong_principal(self):
        base = {
            "type": "notification.triggered", "idempotency_key": "notify-123",
            "principal": "marketing-bot", "authority": ["notify"],
            "trigger": "campaign_published", "variables": {},
        }
        for changes, error in [
            ({"trigger": "Campaign Published"}, "invalid_trigger"),
            ({"variables": {"trigger": "replacement"}}, "invalid_notification_variables"),
            ({"variables": {"campaign": ["not", "scalar"]}}, "invalid_notification_variables"),
            ({"variables": {"campaign": "secret=do-not-send"}}, "credential_material_rejected"),
            ({"platforms": ["linkedin", "facebook"]}, "invalid_notification_platforms"),
        ]:
            with self.assertRaisesRegex(ValueError, error):
                self.validate({**base, **changes})
        with self.assertRaisesRegex(PermissionError, "principal_rejected"):
            self.validate({**base, "principal": "someone-else"})

    def test_rejects_wrong_hmac_secret(self):
        payload = {
            "type": "notification.triggered", "idempotency_key": "notify-wrong-key",
            "principal": "marketing-bot", "authority": ["notify"],
            "trigger": "campaign_published", "variables": {},
        }
        headers, body, principal = self.signed(payload)
        principal["secret"] = "b" * 32
        with patch.object(gateway, "contact_principals", return_value={"marketing-bot": principal}):
            with self.assertRaisesRegex(PermissionError, "signature_rejected"):
                gateway.validate_event(headers, body, True)

    def test_concurrent_delivery_claim_posts_only_once(self):
        class Response:
            status = 202
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def read(self, _limit): return b'{"accepted":true}'

        calls = []
        def open_once(_request, timeout):
            calls.append(timeout)
            time.sleep(0.05)
            return Response()

        with tempfile.TemporaryDirectory() as directory:
            database_path = pathlib.Path(directory) / "events.sqlite3"
            with patch.object(gateway, "DATABASE", database_path), patch.object(gateway, "SIGNING_SECRET", "f" * 64), patch.object(gateway, "urlopen", side_effect=open_once):
                database = gateway.connect()
                now = int(time.time() * 1000)
                database.execute("INSERT INTO events (id,idempotency_key,agent_id,event_type,payload,payload_hash,status,received_at,next_attempt_at) VALUES (?,?,?,?,?,?,?,?,?)", ("evt_test", "contact:bot:once", "bot", "notification.triggered", b'{}', "hash", "accepted", now, 0))
                database.commit(); database.close()
                threads = [threading.Thread(target=gateway.deliver, args=("evt_test",)) for _ in range(2)]
                for thread in threads: thread.start()
                for thread in threads: thread.join()
                database = gateway.connect()
                event = database.execute("SELECT status,attempts FROM events WHERE id='evt_test'").fetchone()
                attempt_count = database.execute("SELECT COUNT(*) FROM attempts WHERE event_id='evt_test'").fetchone()[0]
                database.close()
        self.assertEqual(len(calls), 1)
        self.assertEqual((event["status"], event["attempts"], attempt_count), ("delivered", 1, 1))


class BotHandleTests(unittest.TestCase):
    def test_every_creation_mints_a_distinct_pending_handle(self):
        with tempfile.TemporaryDirectory() as directory:
            handles = pathlib.Path(directory) / "bot-handles.json"
            first = gateway.create_bot_handle(handles)
            second = gateway.create_bot_handle(handles)
            self.assertNotEqual(first["setupUrl"], second["setupUrl"])
            self.assertNotEqual(first["principal"], second["principal"])
            stored = json.loads(handles.read_text())["handles"]
            self.assertEqual(len(stored), 2)
            self.assertNotIn(first["setupUrl"].split("?key=", 1)[1], handles.read_text())
            self.assertNotIn(second["setupUrl"].split("?key=", 1)[1], handles.read_text())

    def test_single_get_setup_returns_reusable_key_instructions_and_empty_canvas(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            handles = root / "bot-handles.json"
            registry = root / "contact-principals.json"
            created = gateway.create_bot_handle(handles)
            setup_key = created["setupUrl"].split("?key=", 1)[1]
            self.assertNotIn(setup_key, handles.read_text())
            redeemed = gateway.redeem_bot_handle(setup_key, handles, registry)
            response = gateway.render_bot_setup(redeemed["principal"], redeemed["reusableKey"])
            self.assertIn(redeemed["reusableKey"], response)
            self.assertIn("Setup is complete", response)
            self.assertIn("## What you must do now", response)
            self.assertIn("## Your ongoing job", response)
            self.assertIn("when requested work succeeds", response)
            self.assertIn("when work is blocked and needs owner input", response)
            self.assertIn("do not send a meaningless test message", response)
            self.assertIn("retain the returned ManagerAI event ID", response)
            self.assertIn("does not use HMAC signatures", response)
            self.assertIn("marketing-x-bot", response)
            self.assertIn("you do not need to find or select another contract", response)
            self.assertIn('"message": ""', response)
            self.assertIn('"idempotency_key": ""', response)
            self.assertIn("Authorization: Bearer $MANAGERAI_BOT_KEY", response)
            self.assertNotIn(redeemed["reusableKey"], registry.read_text())
            stored = json.loads(registry.read_text())["principals"][0]
            self.assertEqual(stored["allowedAuthority"], ["notify"])
            self.assertEqual(stored["allowedProjects"], [])
            self.assertIn("bearerHash", stored)
            with self.assertRaisesRegex(PermissionError, "invalid_or_used_bot_handle"):
                gateway.redeem_bot_handle(setup_key, handles, registry)

    def test_reusable_key_authenticates_a_blank_canvas_message_after_it_is_filled(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            handles = root / "bot-handles.json"
            registry = root / "contact-principals.json"
            created = gateway.create_bot_handle(handles)
            redeemed = gateway.redeem_bot_handle(created["setupUrl"].split("?key=", 1)[1], handles, registry)
            payload = {"type": "notification.message", "idempotency_key": "bot-message-001", "message": "The report is ready."}
            body = json.dumps(payload, separators=(",", ":")).encode()
            with patch.object(gateway, "PRINCIPALS_FILE", registry):
                normalized, principal, key = gateway.validate_event({"authorization": f"Bearer {redeemed['reusableKey']}"}, body, True)
            self.assertEqual(principal, redeemed["principal"])
            self.assertEqual(key, "bot-message-001")
            self.assertEqual(normalized["message"], "The report is ready.")
            self.assertEqual(normalized["authority"], ["notify"])
            with patch.object(gateway, "PRINCIPALS_FILE", registry):
                with self.assertRaisesRegex(PermissionError, "bearer_rejected"):
                    gateway.validate_event({"authorization": "Bearer mai_wrong"}, body, True)

    def test_concurrent_redemption_succeeds_only_once(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            handles = root / "bot-handles.json"
            registry = root / "contact-principals.json"
            setup_key = gateway.create_bot_handle(handles)["setupUrl"].split("?key=", 1)[1]
            results = []
            errors = []

            def redeem():
                try:
                    results.append(gateway.redeem_bot_handle(setup_key, handles, registry))
                except PermissionError as error:
                    errors.append(str(error))

            threads = [threading.Thread(target=redeem) for _ in range(2)]
            for thread in threads: thread.start()
            for thread in threads: thread.join()
            self.assertEqual(len(results), 1)
            self.assertEqual(errors, ["invalid_or_used_bot_handle"])


if __name__ == "__main__":
    unittest.main()
