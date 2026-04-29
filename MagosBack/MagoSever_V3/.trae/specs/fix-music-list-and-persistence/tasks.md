# Tasks

- [x] Task 1: Update Frontend UI: Remove deprecated buttons and add MusicList container.
  - [x] Remove `#Delete_Music` and `#Upload_Music` from `HttpServer/templates/index.html`.
  - [x] Add `<div id="MusicList"></div>` in place of the removed buttons.
  - [x] Remove `hideMusicButtons` function call and definition from `HttpServer/static/myJavaScript/custom_logic.js`.

- [x] Task 2: Implement Persistent Path Logic in Backend.
  - [x] In `HttpServer/myFlask.py`, implement `get_data_json_path()` to return the correct path (exe vs dev).
  - [x] On startup, if in exe mode and the persistent file doesn't exist, copy it from `static/data.json`.
  - [x] Update `BLEController` initialization to accept `data_json_path`.
  - [x] Create `/api/music_data` endpoint to serve the content of `data.json`.

- [x] Task 3: Update BLE Logic for Persistence.
  - [x] Modify `HttpServer/mylib/BLE.py` `BLEController.__init__` to accept `data_json_path`.
  - [x] Update `BLEController.update_music_json` to write to `self.data_json_path`.

- [x] Task 4: Connect Frontend to New API.
  - [x] Update `updateMusicList` in `custom_logic.js` to fetch from `/api/music_data`.
  - [x] Update `initMusicStream` (SSE) in `custom_logic.js` to handle data updates correctly.
  - [x] Ensure `updateMusicUI` renders into `#MusicList`.

- [x] Task 5: Verify Persistence and UI.
  - [x] Test in dev mode: ensure `data.json` updates are reflected in UI.
  - [x] Verify that new music added via BLE simulation appears in the list.
