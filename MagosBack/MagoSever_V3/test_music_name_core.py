# -*- coding: utf-8 -*-
import io
import json
import os
import tempfile
from types import SimpleNamespace

from flask import Flask

from HttpServer.myFlask import FlaskApp


def _build_test_app(tmp_dir: str):
    app = Flask(__name__)
    fa = FlaskApp.__new__(FlaskApp)
    fa.app = app
    fa.current_dir = tmp_dir
    fa.magos = SimpleNamespace(
        play_calls=[],
        stop_calls=0,
    )

    def _play(index):
        fa.magos.play_calls.append(index)

    def _stop():
        fa.magos.stop_calls += 1

    fa.magos.play_background_audio = _play
    fa.magos.stop_background_audio = _stop
    return fa, app


def run_test():
    with tempfile.TemporaryDirectory() as td:
        static_dir = os.path.join(td, "static")
        os.makedirs(static_dir, exist_ok=True)
        data_path = os.path.join(static_dir, "data.json")
        with open(data_path, "w", encoding="utf-8") as f:
            json.dump({"music": []}, f, ensure_ascii=False, indent=2)

        fa, app = _build_test_app(td)

        # 1) First upload by name "hello"
        with app.test_request_context(
            "/api/upload_music",
            method="POST",
            data={
                "name": "hello",
                "file": (io.BytesIO(b"aaa"), "hello.mp3"),
            },
            content_type="multipart/form-data",
        ):
            resp = fa.upload_music()
            payload = resp.get_json()
            if resp.status_code != 200:
                raise AssertionError(f"upload1 failed: {resp.status_code}, payload={payload}")
            first_url = payload.get("url")

        # 2) Re-upload same name with another file: should replace, not append.
        with app.test_request_context(
            "/api/upload_music",
            method="POST",
            data={
                "name": "hello",
                "file": (io.BytesIO(b"bbb"), "hello_v2.mp3"),
            },
            content_type="multipart/form-data",
        ):
            resp = fa.upload_music()
            payload = resp.get_json()
            if resp.status_code != 200:
                raise AssertionError(f"upload2 failed: {resp.status_code}, payload={payload}")
            if payload.get("mode") != "replace":
                raise AssertionError(f"expected replace mode, got {payload}")
            second_url = payload.get("url")
            if second_url == first_url:
                raise AssertionError("second upload should produce a new url")

        manifest = fa._load_music_manifest()
        music = manifest.get("music", [])
        if len(music) != 1:
            raise AssertionError(f"name-core overwrite failed, music={music}")
        if str(music[0].get("name")).lower() != "hello":
            raise AssertionError(f"unexpected song name after replace: {music[0]}")

        # 3) Play by name should pass song name into magos.play_background_audio
        with app.test_request_context(
            "/api/play_music",
            method="POST",
            json={"name": "hello"},
        ):
            resp = fa.play_music_by_name()
            payload = resp.get_json()
            if resp.status_code != 200:
                raise AssertionError(f"play failed: {resp.status_code}, payload={payload}")
        if fa.magos.play_calls != ["hello"]:
            raise AssertionError(f"play name mismatch, calls={fa.magos.play_calls}")

        # 4) Delete by name
        with app.test_request_context(
            "/api/delete_music",
            method="POST",
            json={"names": ["hello"]},
        ):
            resp = fa.delete_music()
            payload = resp.get_json()
            if resp.status_code != 200:
                raise AssertionError(f"delete failed: {resp.status_code}, payload={payload}")

        manifest = fa._load_music_manifest()
        if manifest.get("music"):
            raise AssertionError(f"delete by name failed, manifest={manifest}")

        print("[PASS] music name-core test passed")


if __name__ == "__main__":
    run_test()
