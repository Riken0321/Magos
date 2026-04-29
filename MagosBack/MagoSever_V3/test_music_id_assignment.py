# -*- coding: utf-8 -*-
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

        # Numeric names must NOT hijack ID assignment.
        names = ["2133.mp3", "hello.mp3", "9999.mp3"]
        for n in names:
            mgr.add_music(n)

        urls = [str(item.get("url")) for item in mgr.music_list]
        if urls != ["1", "2", "3"]:
            raise AssertionError(f"Expected sequential IDs ['1','2','3'], got={urls}")

        print("[PASS] Music ID assignment test passed")
        print("urls:", urls)
    finally:
        if os.path.exists(data_path):
            os.remove(data_path)


if __name__ == "__main__":
    run_test()
