import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('worker', ROOT / 'run.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.old = Path.cwd()
        self.temp = tempfile.TemporaryDirectory()
        os.chdir(self.temp.name)
        Path('inputs.json').write_text(json.dumps({'query': 'video editing'}))
        self.env = patch.dict(os.environ, {'ARCMIRA_API_KEY': 'test-only'})
        self.env.start()
    def tearDown(self):
        self.env.stop()
        os.chdir(self.old)
        self.temp.cleanup()
    def test_preserves_results_and_access_limits(self):
        payload = {'chunks': [{'text': 'Example passage', 'watch_url': '/watch?v=example&t=42'}],
                   'note': 'Window limited by plan.', 'freshness': {'delay_days': 7}}
        with patch.object(worker, 'urlopen', return_value=io.StringIO(json.dumps(payload))) as call:
            result = worker.run()
        self.assertEqual(result['outputs'], {'results': 'out/results.json'})
        self.assertEqual(json.loads(Path('out/results.json').read_text()), payload)
        self.assertEqual(call.call_args.args[0].full_url, 'https://api.arcmira.com/v1/search?q=video+editing&limit=5')
    def test_missing_key_does_not_call_api(self):
        with patch.dict(os.environ, {'ARCMIRA_API_KEY': ''}), patch.object(worker, 'urlopen') as call:
            self.assertEqual(worker.run()['status'], 'error')
            call.assert_not_called()
    def test_invalid_limit_does_not_call_api(self):
        Path('inputs.json').write_text(json.dumps({'query': 'clips', 'limit': 21}))
        with patch.object(worker, 'urlopen') as call:
            self.assertEqual(worker.run()['status'], 'error')
            call.assert_not_called()
    def test_invalid_input_shape_reports_error(self):
        Path('inputs.json').write_text('[]')
        with patch.object(worker, 'urlopen') as call:
            self.assertEqual(worker.run()['status'], 'error')
            call.assert_not_called()
    def test_refusal_is_not_an_empty_success(self):
        with patch.object(worker, 'urlopen', side_effect=HTTPError('https://api.arcmira.com', 403, '', {}, None)):
            self.assertEqual(worker.run()['status'], 'error')
        self.assertFalse(Path('out/results.json').exists())

if __name__ == '__main__':
    unittest.main()
