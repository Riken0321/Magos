# -*- coding: utf-8 -*-
import json
from flask import Flask

from HttpServer.myFlask import FlaskApp
from HttpServer.mylib.BLE import BLEWorker
from HttpServer.mylib.Magos import MagosRobot


def _capture_bg_frame(value):
    worker = BLEWorker.__new__(BLEWorker)
    worker.HEADER = b"\xAA\x55"
    worker.FOOTER = b"\x0D\x0A"
    sent = []
    worker.send_data = lambda data: sent.append(bytes(data))
    BLEWorker.write_background_voice(worker, value)
    if not sent:
        raise AssertionError("No frame sent")
    return sent[-1].hex()


def _capture_bg_delete_frame(value):
    worker = BLEWorker.__new__(BLEWorker)
    worker.HEADER = b"\xAA\x55"
    worker.FOOTER = b"\x0D\x0A"
    worker.is_connected = lambda: True
    sent = []
    worker.send_data = lambda data: sent.append(bytes(data))
    result = BLEWorker.write_background_voice_delete(worker, value, wait_ack=False)
    if not sent:
        raise AssertionError("No delete frame sent")
    return sent[-1].hex(), result


def _test_ble_frames():
    hex_happy_mp3 = _capture_bg_frame("happy.mp3")
    if hex_happy_mp3 != "aa5508ff0968617070792e6d70330d0a":
        raise AssertionError(f"happy.mp3 frame mismatch: {hex_happy_mp3}")

    hex_happy = _capture_bg_frame("happy")
    if hex_happy != "aa5508ff0968617070792e6d70330d0a":
        raise AssertionError(f"happy auto-suffix frame mismatch: {hex_happy}")

    hex_numeric_name = _capture_bg_frame("0001")
    if hex_numeric_name != "aa5508ff08303030312e6d70330d0a":
        raise AssertionError(f"0001 name-mode frame mismatch: {hex_numeric_name}")

    hex_stop = _capture_bg_frame(0xFF)
    if hex_stop != "aa55080101010d0a":
        raise AssertionError(f"stop frame mismatch: {hex_stop}")

    try:
        _capture_bg_frame(0x01)
        raise AssertionError("int payload != 0xFF should fail")
    except ValueError:
        pass


def _test_delete_ble_frames():
    hex_delete_happy, result_happy = _capture_bg_delete_frame("happy.mp3")
    if hex_delete_happy != "aa5508020968617070792e6d70330d0a":
        raise AssertionError(f"delete happy.mp3 frame mismatch: {hex_delete_happy}")
    if result_happy.get("file_name") != "happy.mp3":
        raise AssertionError(f"delete file_name mismatch: {result_happy}")

    hex_delete_happy_short, _ = _capture_bg_delete_frame("happy")
    if hex_delete_happy_short != "aa5508020968617070792e6d70330d0a":
        raise AssertionError(f"delete happy auto-suffix mismatch: {hex_delete_happy_short}")

    hex_delete_cn, _ = _capture_bg_delete_frame("青花瓷.mp3")
    if hex_delete_cn != "aa5508020de99d92e88ab1e793b72e6d70330d0a":
        raise AssertionError(f"delete 青花瓷.mp3 frame mismatch: {hex_delete_cn}")

    too_long_name = ("a" * 252) + ".mp3"  # 256-byte filename payload should fail
    try:
        _capture_bg_delete_frame(too_long_name)
        raise AssertionError("too long delete filename should fail")
    except ValueError:
        pass


def _test_resolver_name_core():
    robot = MagosRobot.__new__(MagosRobot)
    robot._load_music_manifest_entries = lambda: [
        {"name": "happy"},
        {"name": "0001"},
    ]

    if robot._resolve_background_music_selector("happy.mp3") != "happy.mp3":
        raise AssertionError("resolver failed for happy.mp3")
    if robot._resolve_background_music_selector("happy") != "happy.mp3":
        raise AssertionError("resolver failed for happy")
    if robot._resolve_background_music_selector("0001") != "0001.mp3":
        raise AssertionError("resolver failed for numeric filename")


def _test_api_reject_index():
    app = Flask(__name__)
    fa = FlaskApp.__new__(FlaskApp)
    fa.app = app

    with app.test_request_context(
        "/api/play_music",
        method="POST",
        json={"index": 1},
    ):
        result = fa.play_music_by_name()

    if isinstance(result, tuple):
        resp, status = result
    else:
        resp = result
        status = resp.status_code

    payload = resp.get_json() or {}
    if int(status) != 400:
        raise AssertionError(f"index should be rejected with 400, got {status}, payload={payload}")
    if "index" not in str(payload.get("msg", "")):
        raise AssertionError(f"index rejection message mismatch: {payload}")


def _test_delete_api_strong_consistency():
    app = Flask(__name__)
    fa = FlaskApp.__new__(FlaskApp)
    fa.app = app
    fa._normalize_music_name = FlaskApp._normalize_music_name.__get__(fa, FlaskApp)

    original_manifest = {
        "music": [
            {"name": "happy", "url": "./static/happy_a.mp3"},
            {"name": "moon", "url": "./static/moon_a.mp3"},
        ]
    }
    saved_payloads = []
    removed_urls = []

    fa._load_music_manifest = lambda: json.loads(json.dumps(original_manifest))
    fa._save_music_manifest = lambda payload: saved_payloads.append(payload)
    fa._remove_music_file_by_url = lambda url: removed_urls.append(url)

    class _MagosSuccess:
        def delete_background_audio(self, music_name):
            return {"success": True, "name": music_name}

    fa.magos = _MagosSuccess()

    with app.test_request_context(
        "/api/delete_music",
        method="POST",
        json={"names": ["happy"]},
    ):
        result = fa.delete_music()

    if isinstance(result, tuple):
        resp, status = result
    else:
        resp = result
        status = resp.status_code
    payload = resp.get_json() or {}

    if int(status) != 200:
        raise AssertionError(f"delete success status mismatch: {status}, payload={payload}")
    if not saved_payloads:
        raise AssertionError("manifest should be saved on success")
    if removed_urls != ["./static/happy_a.mp3"]:
        raise AssertionError(f"removed file urls mismatch: {removed_urls}")

    saved_payloads.clear()
    removed_urls.clear()

    class _MagosFail:
        def delete_background_audio(self, music_name):
            raise RuntimeError(f"device delete failed for {music_name}")

    fa.magos = _MagosFail()

    with app.test_request_context(
        "/api/delete_music",
        method="POST",
        json={"names": ["moon"]},
    ):
        result_fail = fa.delete_music()

    if isinstance(result_fail, tuple):
        resp_fail, status_fail = result_fail
    else:
        resp_fail = result_fail
        status_fail = resp_fail.status_code
    payload_fail = resp_fail.get_json() or {}

    if int(status_fail) != 502:
        raise AssertionError(
            f"delete fail status mismatch: {status_fail}, payload={payload_fail}"
        )
    if saved_payloads:
        raise AssertionError("manifest should not be saved when device delete fails")
    if removed_urls:
        raise AssertionError("local files should not be removed when device delete fails")


def run_test():
    _test_ble_frames()
    _test_delete_ble_frames()
    _test_resolver_name_core()
    _test_api_reject_index()
    _test_delete_api_strong_consistency()
    print("[PASS] background music filename protocol test passed")


if __name__ == "__main__":
    run_test()
