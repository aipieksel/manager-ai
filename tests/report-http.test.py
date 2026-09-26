import http.client
import importlib.util
import json
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'runtime'))
spec = importlib.util.spec_from_file_location('report_server', Path(__file__).resolve().parents[1] / 'runtime/report-server.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
TOKEN = 'http-test-token-' * 4


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.runtime = Mock()
        self.runtime.accept.return_value = {'runId': 'run_1', 'status': 'accepted'}
        self.runtime.preflight.return_value = {'ready': True}
        self.runtime.finalize.return_value = {'runId': 'run_1', 'status': 'succeeded'}
        self.runtime.evidence.return_value = {'verified': True}
        self.runtime.artifact.return_value = ({'byteLength': 3}, b'abc')
        self.server = module.ReportServer(('127.0.0.1', 0), self.runtime, TOKEN)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()

    def request(self, path, method='GET', body=None, auth=True, headers=None):
        conn = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        values = {'Content-Type': 'application/json'}
        if auth: values['Authorization'] = 'Bearer ' + TOKEN
        values.update(headers or {})
        try:
            conn.request(method, path, body=body, headers=values)
            response = conn.getresponse()
            return response.status, response.read(), dict(response.getheaders())
        finally: conn.close()

    def test_auth_on_every_route_and_no_generic_routes(self):
        for path in ['/v1/reports', '/v1/reports/preflight', '/v1/reports/run_1', '/v1/reports/run_1/artifacts/a', '/v1/reports/run_1/evidence/e', '/v1/jobs/setup']:
            for method in ['GET', 'POST', 'DELETE']:
                self.assertEqual(self.request(path, method, auth=False)[0], 401)
        self.assertEqual(self.request('/v1/jobs/setup')[0], 404)
        self.assertEqual(self.request('/v1/reports', 'DELETE')[0], 405)
        self.assertEqual(self.runtime.mock_calls, [])

    def test_status_preflight_evidence_artifact(self):
        self.assertEqual(self.request('/v1/reports/preflight')[0], 200)
        self.assertEqual(self.request('/v1/reports/run_1')[0], 200)
        self.runtime.recover_interrupted.assert_called_once()
        self.runtime.finalize.assert_called_once_with('run_1')
        self.assertEqual(self.request('/v1/reports/run_1/evidence/review')[0], 200)
        code, data, headers = self.request('/v1/reports/run_1/artifacts/artifact')
        self.assertEqual((code, data), (200, b'abc'))
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.runtime.finalize.return_value = None
        self.assertEqual(self.request('/v1/reports/missing')[0], 404)

    def test_body_limits_and_shape(self):
        self.assertEqual(self.request('/v1/reports', 'POST', '{}')[0], 202)
        self.runtime.accept.assert_called_once_with({})
        for body in ['[]', 'null', '{broken']:
            self.assertEqual(self.request('/v1/reports', 'POST', body)[0], 400)
        self.assertEqual(self.request('/v1/reports', 'POST', '{}', headers={'Content-Length': str(module.MAX_BODY+1)})[0], 413)
        self.assertEqual(self.request('/v1/reports', 'POST', '{}', headers={'Content-Type': 'text/plain'})[0], 415)
        self.assertEqual(self.request('/v1/reports', 'POST', '{}', headers={'Transfer-Encoding': 'chunked'})[0], 400)

    def test_encoded_and_literal_traversal_rejected(self):
        for path in ['/v1/reports/..', '/v1/reports/%2e%2e', '/v1/reports/run_1/artifacts/..', '/v1/reports/run_1/artifacts/a%2fb', '/v1/reports/run_1?secret=x', '/v1/reports//']:
            self.assertEqual(self.request(path)[0], 404)
        self.assertEqual(self.runtime.mock_calls, [])

    def test_errors_do_not_leak_and_artifact_is_bounded(self):
        self.runtime.finalize.side_effect = ValueError('/private/secret')
        code, data, _ = self.request('/v1/reports/run_1')
        self.assertEqual(code, 409); self.assertNotIn(b'secret', data)
        self.runtime.finalize.side_effect = RuntimeError('/private/secret')
        self.assertEqual(self.request('/v1/reports/run_1')[0], 500)
        self.runtime.artifact.return_value = ({'byteLength': 4}, b'abc')
        self.assertEqual(self.request('/v1/reports/run_1/artifacts/a')[0], 409)
        old = module.MAX_ARTIFACT
        try:
            module.MAX_ARTIFACT = 2
            self.runtime.artifact.return_value = ({'byteLength': 3}, b'abc')
            self.assertEqual(self.request('/v1/reports/run_1/artifacts/a')[0], 409)
        finally: module.MAX_ARTIFACT = old


if __name__ == '__main__': unittest.main()
