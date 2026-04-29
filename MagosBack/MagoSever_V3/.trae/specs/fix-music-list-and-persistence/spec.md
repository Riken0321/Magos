# Fix Music List and Persistence Spec

## Why
The frontend music list is not displaying correctly, and the Upload/Delete buttons are no longer needed. Additionally, the application needs to ensure that music data updates persist when packaged as an EXE, which requires handling `data.json` storage outside the frozen application bundle.

## What Changes
- **Frontend UI**:
  - Remove "Upload Music" and "Delete Music" buttons from `index.html`.
  - Add a dedicated `<div id="MusicList">` container in `index.html` for the music list.
  - Remove `hideMusicButtons` logic from `custom_logic.js`.
  - Update `custom_logic.js` to fetch music data from a new API endpoint instead of the static file directly.

- **Backend Logic (`myFlask.py`)**:
  - Implement logic to detect if running as a frozen EXE (PyInstaller).
  - Define a persistent path for `data.json` (next to the executable in frozen mode, or in `static` folder in dev mode).
  - Ensure `data.json` is copied from the bundle to the persistent location on startup if it doesn't exist.
  - Create a new API endpoint `/api/music_data` to serve the `data.json` content.
  - Update `stream_music_data` (SSE) to read from the persistent `data.json`.
  - Pass the persistent `data.json` path to the `BLEController`.

- **BLE Logic (`BLE.py`)**:
  - Update `BLEController` to accept `data_json_path` in `__init__`.
  - Update `update_music_json` to write to the provided `data_json_path` instead of calculating a relative path.

## Impact
- **Affected specs**: None.
- **Affected code**:
  - `HttpServer/templates/index.html`
  - `HttpServer/static/myJavaScript/custom_logic.js`
  - `HttpServer/myFlask.py`
  - `HttpServer/mylib/BLE.py`

## ADDED Requirements
### Requirement: Persistent Music Data
The system SHALL store `data.json` in a writable location that persists across application restarts, even when packaged as an EXE.

### Requirement: Music Data API
The system SHALL provide an API endpoint `/api/music_data` that returns the current music list from the persistent storage.

### Requirement: Music List UI
The frontend SHALL render the music list into a dedicated `#MusicList` container and fetch data from `/api/music_data`.

## REMOVED Requirements
### Requirement: Music Management Buttons
**Reason**: Local music upload is disabled.
**Migration**: Remove `#Delete_Music` and `#Upload_Music` elements and related hiding logic.
