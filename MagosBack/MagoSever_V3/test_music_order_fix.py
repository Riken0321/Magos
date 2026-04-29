# -*- coding: utf-8 -*-
import json
import os
import tempfile

from HttpServer.mylib.BLE import MusicManager


def run_test():
    with tempfile.NamedTemporaryFile(delete=False, suffix=".json") as tf:
        data_path = tf.name
        tf.write(b"{}")

    try:
        mgr = MusicManager(data_json_path=data_path)
        mgr.start_sync()

        # Numeric filename should NOT hijack id assignment.
        mgr.add_music("2133.mp3")
        mgr.add_music("哈喽.mp3")
        with open(data_path, "r", encoding="utf-8") as f:
            payload = json.load(f)
        first_round = payload.get("music", [])
        first_ids = [str(item.get("url")) for item in first_round]
        if first_ids[:2] != ["1", "2"]:
            raise AssertionError(f"numeric-name id hijack detected, ids={first_ids}")

        # Start new sync session and re-check fresh id assignment.
        mgr.start_sync()

        # Simulate device report order issue: last two swapped.
        names = [
            "1.song.mp3",
            "2.song.mp3",
            "3.song.mp3",
            "4.song.mp3",
            "5.song.mp3",
            "6.song.mp3",
            "7.song.mp3",
            "8.song.mp3",
            "10.song.mp3",
            "9.song.mp3",
        ]
        for name in names:
            mgr.add_music(name)

        with open(data_path, "r", encoding="utf-8") as f:
            payload = json.load(f)
        music = payload.get("music", [])
        ids = [int(str(item.get("url"))) for item in music if str(item.get("url", "")).isdigit()]

        if ids != sorted(ids):
            raise AssertionError(f"music order not stable, got={ids}")

        if ids[-2:] != [9, 10]:
            raise AssertionError(f"tail order mismatch, expected [9,10], got={ids[-2:]}")

        print("[PASS] Music order fix test passed")
        print("ids:", ids)
    finally:
        if os.path.exists(data_path):
            os.remove(data_path)


if __name__ == "__main__":
    run_test()
