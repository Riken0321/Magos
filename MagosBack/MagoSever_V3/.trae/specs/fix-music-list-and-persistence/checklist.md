# Checklist

- [x] Frontend buttons `#Delete_Music` and `#Upload_Music` are removed from `index.html`.
- [x] `#MusicList` container is present in `index.html`.
- [x] `hideMusicButtons` function call and definition are removed from `custom_logic.js`.
- [x] `myFlask.py` correctly determines `data.json` path in both dev and exe (frozen) modes.
- [x] `data.json` is copied to the persistent location on startup if it doesn't exist (exe mode).
- [x] `BLEController` initialization accepts `data_json_path` in `myFlask.py`.
- [x] `BLEController` updates `data.json` at the provided path in `BLE.py`.
- [x] `/api/music_data` endpoint serves the persistent `data.json`.
- [x] `custom_logic.js` fetches music list from `/api/music_data` (polling) or SSE updates.
- [x] Music list updates correctly when new music is received via BLE (simulation).
