import threading
import unittest
from unittest.mock import patch
import ocr_server


class ModelPreparationTests(unittest.TestCase):
    def setUp(self):
        with ocr_server.STATUS_LOCK:
            ocr_server.MODEL_STATUS.clear()

    def test_preparation_deduplicates_while_loading_and_reports_ready(self):
        started = threading.Event()
        finish = threading.Event()
        complete = threading.Event()

        def engine(_language):
            started.set()
            finish.wait(2)
            complete.set()
        with patch.object(ocr_server, 'get_engine', side_effect=engine) as mocked:
            self.assertEqual(ocr_server.prepare_model('ja')['state'], 'loading')
            self.assertTrue(started.wait(1))
            self.assertEqual(ocr_server.prepare_model('ja')['state'], 'loading')
            self.assertEqual(mocked.call_count, 1)
            finish.set()
            self.assertTrue(complete.wait(1))
            # Taking the engine lock ensures the worker has finished loading.
            with ocr_server.ENGINE_LOCK:
                pass
            for _ in range(100):
                with ocr_server.STATUS_LOCK:
                    if ocr_server.MODEL_STATUS['japan']['state'] == 'ready':
                        break
                threading.Event().wait(.001)
            self.assertEqual(ocr_server.MODEL_STATUS['japan']['state'], 'ready')

    def test_rejects_unknown_language_before_starting_download(self):
        with patch.object(ocr_server, 'get_engine') as mocked:
            with self.assertRaises(ValueError):
                ocr_server.prepare_model('unknown')
            mocked.assert_not_called()


if __name__ == '__main__':
    unittest.main()
