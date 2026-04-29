# -*- coding: utf-8 -*-
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path

_REPO = Path(__file__).resolve().parents[1]
if str(_REPO) not in sys.path:
    sys.path.insert(0, str(_REPO))

from HttpServer.myFlask import FlaskApp
from HttpServer.mylib.BLE import MusicManager


class _FakeWorker:
    def __init__(self, connected):
        self._connected = bool(connected)

    def is_connected(self):
        return self._connected


class _FakeMagos:
    def __init__(self, connected=True, fail_stop=False):
        self.BLE_worker = _FakeWorker(connected)
        self.fail_stop = fail_stop
        self.stop_calls = 0

    def stop_background_audio(self):
        self.stop_calls += 1
        if self.fail_stop:
            raise RuntimeError("stop failed")


class MusicSlotStorageAndStopTests(unittest.TestCase):
    def _build_app(self):
        app = object.__new__(FlaskApp)
        app.ROBOT_SLOTS = tuple("ABC")
        app._music_manifest_lock = threading.RLock()
        return app

    def test_legacy_manifest_migrates_to_slot_a(self):
        app = self._build_app()
        manifest = app._ensure_manifest_slot_lists(
            {"music": [{"name": "song_a", "url": "1"}]}
        )
        self.assertIn("music_by_slot", manifest)
        self.assertIn("A", manifest["music_by_slot"])
        self.assertEqual(manifest["music_by_slot"]["A"][0]["name"], "song_a")

    def test_set_and_get_music_list_per_slot(self):
        app = self._build_app()
        manifest = {"music": []}
        manifest = app._set_music_list_for_slot(
            manifest, "B", [{"name": "song_b", "url": "2"}]
        )
        list_b = app._get_music_list_for_slot(manifest, "B")
        list_a = app._get_music_list_for_slot(manifest, "A")
        self.assertEqual(len(list_b), 1)
        self.assertEqual(list_b[0]["name"], "song_b")
        self.assertEqual(list_a, [])

    def test_stop_music_only_targets_connected_slots(self):
        app = self._build_app()
        mag_a = _FakeMagos(connected=True, fail_stop=False)
        mag_b = _FakeMagos(connected=False, fail_stop=False)
        mag_c = _FakeMagos(connected=True, fail_stop=True)
        app._magos_by_slot = {"A": mag_a, "B": mag_b, "C": mag_c}

        result = app._stop_music_on_connected_slots()
        self.assertEqual(result["success_slots"], ["A"])
        self.assertEqual(result["skipped_slots"], ["B"])
        self.assertEqual(len(result["failed_slots"]), 1)
        self.assertEqual(result["failed_slots"][0]["slot"], "C")
        self.assertEqual(mag_a.stop_calls, 1)
        self.assertEqual(mag_b.stop_calls, 0)
        self.assertEqual(mag_c.stop_calls, 1)

    def test_music_manager_writes_slot_scoped_manifest(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            data_path = Path(tmpdir) / "data.json"
            data_path.write_text(
                json.dumps({"music": [{"name": "legacy_song", "url": "legacy.mp3"}]}),
                encoding="utf-8",
            )
            manager = MusicManager(
                data_json_path=str(data_path),
                slot_id="B",
                manifest_lock=threading.RLock(),
            )
            manager.music_list = [{"name": "slot_b_song", "url": "1"}]
            manager.save_to_json()

            payload = json.loads(data_path.read_text(encoding="utf-8"))
            self.assertIn("music_by_slot", payload)
            self.assertIn("B", payload["music_by_slot"])
            self.assertEqual(payload["music_by_slot"]["B"][0]["name"], "slot_b_song")
            self.assertIn("music", payload)


if __name__ == "__main__":
    unittest.main()
