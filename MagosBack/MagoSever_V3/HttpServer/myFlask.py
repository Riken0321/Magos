import json, logging, asyncio, threading, sys, datetime, os, webbrowser, time, subprocess, platform, re, uuid, inspect

# import pandas as pd
import importlib
import importlib.metadata
from io import StringIO

from flask import Flask, request, jsonify, render_template, send_file, Response
from werkzeug.utils import secure_filename
from HttpServer.mylib import BLE, Magos, TaskManager, OTAService, MusicTransferManager
from HttpServer.mylib.LicenseManager import AGENT_LICENSE_TARGETS, LicenseManager
from HttpServer.mylib.ShortcutActions import (
    GlobalShortcutListener,
    ShortcutActionRepository,
    macos_accessibility_hint,
    normalize_key_binding,
)

try:
    from waitress import serve
except ModuleNotFoundError:
    serve = None

WAITRESS = serve is not None
SERVERLOG = True


_access_logger = logging.getLogger("magos.access")
_access_logger_configured = False


def _configure_magos_access_logging():
    """One-line English access log; hide Werkzeug default access spam."""
    global _access_logger_configured
    if _access_logger_configured:
        return
    _access_logger.setLevel(logging.INFO)
    _access_logger.propagate = False
    if not _access_logger.handlers:
        _h = logging.StreamHandler(sys.stderr)
        _h.setFormatter(
            logging.Formatter("%(asctime)s %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
        )
        _access_logger.addHandler(_h)
    logging.getLogger("werkzeug").setLevel(logging.WARNING)
    _access_logger_configured = True


def _access_line_for_request(method: str, path: str):
    """Return English summary, or None to skip."""
    m = (method or "GET").upper()
    p = path or ""
    if m == "GET" and p == "/favicon.ico":
        return None
    if m == "GET" and p.startswith("/static/"):
        if p.startswith("/static/bundle.js"):
            return "Load frontend bundle"
        if p == "/static/data.json" or p.endswith("/data.json"):
            return "Load app data JSON"
        return None
    key = (m, p)
    exact = {
        ("GET", "/"): "Load main page",
        ("GET", "/to_shudu"): "Open Sudoku page",
        ("GET", "/to_habcam"): "Open HAB camera page",
        ("GET", "/to_data"): "Open data manager page",
        ("GET", "/api/music_data"): "Read music catalog",
        ("GET", "/api/shortcut_actions"): "List shortcut actions",
        ("GET", "/api/license/status"): "Read license status",
        ("GET", "/api/license/list"): "List licenses",
        ("GET", "/api/shortcut_actions/stream"): "Open shortcut event stream",
        ("GET", "/api/status"): "Poll robot status",
        ("GET", "/api/robot/status"): "Poll robot status",
        ("GET", "/api/test_connection"): "Ping backend",
        ("GET", "/api/ota/stream"): "Open OTA progress stream",
        ("GET", "/api/ota/status"): "Read OTA status",
        ("GET", "/api/music_upload/stream"): "Open music upload stream",
        ("GET", "/BLE_Refresh"): "Scan BLE devices",
        ("GET", "/BLE_Disconnect"): "Disconnect BLE",
        ("GET", "/BLE_State"): "Read BLE state",
        ("POST", "/BLE_Connect"): "Connect BLE device",
        ("POST", "/RunPythonCode"): "Run Blockly program",
        ("POST", "/api/pause"): "Pause task",
        ("POST", "/api/resume"): "Resume task",
        ("POST", "/api/stop"): "Stop task",
        ("POST", "/api/robot/reset"): "Reset robot",
        ("POST", "/api/upload_music"): "Upload music",
        ("POST", "/api/play_music"): "Play music",
        ("POST", "/api/pause_music"): "Pause music",
        ("POST", "/api/delete_music"): "Delete music",
        ("POST", "/api/music/sync_now"): "Sync music list",
        ("POST", "/api/cloud_update"): "Cloud firmware update",
        ("POST", "/ota/local_upload"): "Local OTA upload",
        ("POST", "/VoicePlay"): "Voice play",
    }
    if key in exact:
        return exact[key]
    if p.startswith("/api/"):
        tail = p.removeprefix("/api/").strip("/").replace("/", " ")
        return f"API {m} {tail}".strip()
    return f"HTTP {m} {p}".strip()


def _register_magos_access_after_request(app):
    @app.after_request
    def _magos_access_after_request_impl(response):
        try:
            line = _access_line_for_request(request.method, request.path)
            if line:
                _access_logger.info(line)
        except Exception:
            pass
        return response


class SlotMagosMap:
    """exec 环境中的 magos：按槽位下标访问，如 magos['A']。"""

    __slots__ = ("_by",)

    def __init__(self, magos_by_slot):
        self._by = dict(magos_by_slot or {})

    def __getitem__(self, key):
        k = str(key).strip().upper()
        if k not in self._by:
            raise KeyError(k)
        return self._by[k]

    def _default_robot(self):
        # 兼容旧代码：优先回退到 A 槽；若不存在则取第一个可用槽位
        if "A" in self._by:
            return self._by["A"]
        for _, robot in self._by.items():
            return robot
        return None

    def __getattr__(self, name):
        # 兼容旧脚本：关节下标等类常量（LeftHand、Header…）来自 MagosRobot 类；方法绑定到默认槽位实例
        MagosRobot = Magos.MagosRobot
        robot = self._default_robot()
        if hasattr(MagosRobot, name):
            cls_attr = getattr(MagosRobot, name)
            if isinstance(cls_attr, property):
                if robot is None:
                    raise AttributeError(f"'SlotMagosMap' object has no attribute '{name}'")
                return getattr(robot, name)
            if inspect.isroutine(cls_attr):
                if robot is None:
                    raise AttributeError(f"'SlotMagosMap' object has no attribute '{name}'")
                return getattr(robot, name)
            return cls_attr
        if robot is not None and hasattr(robot, name):
            return getattr(robot, name)
        raise AttributeError(f"'SlotMagosMap' object has no attribute '{name}'")


class FlaskApp:
    # comment fixed
    CAMERA_SCORES_FILE = "cameraScores.json"
    CAMERA_SCORES_DETAIL_FILE = "cameraScoresDetail.json"
    SUDOKU_SCORES_FILE = "sudokuScores.json"
    UPLOAD_FOLDER = "uploads"
    MAX_MUSIC_UPLOAD_BYTES = 10 * 1024 * 1024
    MAX_MUSIC_UPLOAD_FORM_OVERHEAD_BYTES = 512 * 1024
    sudoku_excel_file_path = "sudokuData.xlsx"
    # comment fixed
    current_script_path = os.path.abspath(__file__)
    # comment fixed
    current_dir = os.path.dirname(current_script_path)
    # comment fixed
    actions_group_path = os.path.join(current_dir, "actions_group")

    def __init__(self, _host="0.0.0.0", _port=5001, _debug=True, _threaded=True):
        # comment fixed
        self.LoadActionGroup()

        # region
        self.ROBOT_SLOTS = tuple("ABCDEF")
        self.slot_bindings = {s: {} for s in self.ROBOT_SLOTS}
        self._ble_handles = {}
        self._ble_workers = {}
        self._magos_by_slot = {}
        self._music_manifest_lock = threading.RLock()
        self.BLE_worker = None
        self.BLE_Handle = None
        self.BLE_init_()
        self._ble_last_error = {}
        self.task_manager = TaskManager.TaskManager()
        for s in self.ROBOT_SLOTS:
            self._magos_by_slot[s] = Magos.MagosRobot(
                self._ble_workers[s], self.task_manager
            )
        self.BLE_worker = self._ble_workers["A"]
        self.BLE_Handle = self._ble_handles["A"]
        self.magos = self._magos_by_slot["A"]
        self._init_ota_runtime()
        self._init_music_upload_runtime()
        self._init_music_sync_runtime()
        self._init_shortcut_actions_runtime()
        self._init_license_runtime()
        self._bind_ble_callbacks()
        self._start_shortcut_listener()
        # endregion

        # region
        self.app = Flask(__name__)
        # comment fixed
        if SERVERLOG:
            log_dir = os.path.join(os.path.expanduser("~"), "magosServerLog")
            os.makedirs(log_dir, exist_ok=True)

            logging.basicConfig(
                level=logging.INFO,
                format="%(asctime)s - %(levelname)s - %(message)s",
                handlers=[
                    logging.FileHandler(os.path.join(log_dir, "app.log")),
                    logging.StreamHandler(),
                ],
            )

            self.logger = logging.getLogger(__name__)

        _configure_magos_access_logging()
        self._configure_app(_debug)
        self._register_routes()
        url = f"http://localhost:{_port}"

        self.testdefuntion()

        if not os.environ.get("NO_BROWSER"):
            threading.Thread(
                target=self.open_broweser, args=(url,), daemon=True
            ).start()

        _access_logger.info("Server started %s", url)
        try:
            if not WAITRESS:
                self.app.run(host=_host, port=_port, debug=_debug, threaded=_threaded)
            else:
                serve(self.app, host=_host, port=_port, threads=4)
        except KeyboardInterrupt:
            _access_logger.info("Server shutdown")
        except Exception as e:
            logging.error("Server error: %s", e)
            print("Server error:", str(e))
            input("按回车退出...")

        # endregion

    # comment fixed
    def testdefuntion(self):
        # self.magos.set_robot_server(0, 0)
        # self.magos.set_robot_server(1, 15)
        # self.magos.set_robot_server(2, 30)
        # self.magos.set_robot_server(3, 45)
        # self.magos.set_robot_server(4, 60)
        # self.magos.set_robot_server(5, 75)
        # self.magos.set_robot_server(6, 90)
        pass

    def test_connection(self):
        return {"status": "success", "message": "Backend is online!"}

    def pause_task(self):
        if self.task_manager.pause_task():
            # Stop background music when pausing
            if hasattr(self, "magos") and self.magos:
                self._stop_music_on_connected_slots()
            return jsonify({"status": "success", "message": "Task paused"})
        return jsonify({"status": "failed", "message": "No running task or already paused"})

    def resume_task(self):
        if self.task_manager.resume_task():
            return jsonify({"status": "success", "message": "Task resumed"})
        return jsonify({"status": "failed", "message": "No running task or already running"})

    def stop_task(self):
        if self.task_manager.stop_task():
            return jsonify({"status": "success", "message": "Task stopped"})
        return jsonify({"status": "failed", "message": "No running task"})

    def serve_manual(self):
        # comment fixed
        pdf_path = os.path.join(self.app.root_path, 'static', 'docs', 'INSTRUCTION Manual.pdf')
        if not os.path.exists(pdf_path):
            self.logger.error(f"Manual file not found at: {pdf_path}")
            return jsonify({"error": "Manual not found"}), 404
        return send_file(pdf_path, mimetype='application/pdf', as_attachment=False)

    # region
    def _configure_app(self, IS_DEBUG):
        """基础设置"""
        self.app.config.update(
            DEBUG=IS_DEBUG, ENV="development", TEMPLATES_AUTO_RELOAD=True
        )
        _register_magos_access_after_request(self.app)

    def _register_routes(self):
        """Register all routes."""
        _access_logger.info("Register HTTP routes")
        self.app.add_url_rule("/", view_func=self.index)
        self.app.add_url_rule("/to_shudu", view_func=self.sudu, methods=["GET"])
        # ...
        
        # comment fixed
        self.app.add_url_rule("/to_habcam", view_func=self.habcam, methods=["GET"])
        self.app.add_url_rule("/to_data", view_func=self.data, methods=["GET"])
        self.app.errorhandler(self.handle_error)
        self.app.add_url_rule(
            "/BLE_Refresh", view_func=self.BLE_Refresh, methods=["GET"]
        )
        self.app.add_url_rule(
            "/BLE_Connect", view_func=self.BLE_Connect, methods=["POST"]
        )
        self.app.add_url_rule(
            "/BLE_Disconnect", view_func=self.BLE_Disconnect, methods=["GET"]
        )
        self.app.add_url_rule("/BLE_State", view_func=self.BLE_State, methods=["GET"])
        self.app.add_url_rule(
            "/RunPythonCode", view_func=self.RunPythonCode, methods=["POST"]
        )
        # self.app.add_url_rule('/Test', view_func=self.Test, methods=['POST','GET'])
        self.app.add_url_rule("/VoicePlay", view_func=self.VoicePlay, methods=["POST"])
        self.app.add_url_rule(
            "/api/test_connection", view_func=self.test_connection, methods=["GET"]
        )
        self.app.add_url_rule(
            "/api/upload_music", view_func=self.upload_music, methods=["POST"]
        )
        self.app.add_url_rule(
            "/api/play_music", view_func=self.play_music_by_name, methods=["POST"]
        )
        self.app.add_url_rule(
            "/api/pause_music", view_func=self.pause_music, methods=["POST"]
        )
        self.app.add_url_rule(
            "/api/music_data", view_func=self.get_music_data, methods=["GET"]
        )
        self.app.add_url_rule(
            "/api/music/sync_now", view_func=self.music_sync_now, methods=["POST"]
        )
        self.app.add_url_rule(
            "/api/music_upload/stream", view_func=self.music_upload_stream, methods=["GET"]
        )
        self.app.add_url_rule(
            "/api/music_upload/status/<transfer_id>",
            view_func=self.music_upload_status,
            methods=["GET"],
        )
        self.app.add_url_rule(
            "/api/delete_music", view_func=self.delete_music, methods=["POST"]
        )
        self.app.add_url_rule(
            "/api/pause", view_func=self.pause_task, methods=["POST", "GET"]
        )
        self.app.add_url_rule(
            "/api/resume", view_func=self.resume_task, methods=["POST", "GET"]
        )
        self.app.add_url_rule(
            "/api/stop", view_func=self.stop_task, methods=["POST", "GET"]
        )
        
        self.app.add_url_rule(
            "/api/robot/reset", view_func=self.reset_robot, methods=["POST"]
        )
        self.app.add_url_rule(
            "/api/robot/status", view_func=self.robot_status, methods=["GET"]
        )
        self.app.add_url_rule(
            "/api/robot/battery_display", view_func=self.set_battery_display, methods=["POST"]
        )
        self.app.add_url_rule(
            "/api/manual", view_func=self.serve_manual, methods=["GET"]
        )
        # comment fixed
        self.app.add_url_rule(
            "/api/status", view_func=self.robot_status, methods=["GET"]
        )
        self.app.add_url_rule(
            "/api/ble/rename", view_func=self.rename_device, methods=["POST"]
        )
        self.app.add_url_rule(
            "/api/ble/diagnostics", view_func=self.ble_diagnostics, methods=["GET"]
        )
        self.app.add_url_rule(
            "/api/network", view_func=self.network_restart, methods=["POST"]
        )
        self.app.add_url_rule(
            "/api/network/login", view_func=self.network_login, methods=["POST"]
        )
        self.app.add_url_rule(
            "/api/agent/set", view_func=self.set_ai_agent, methods=["POST"]
        )
        self.app.add_url_rule(
            "/api/license/status", view_func=self.license_status_api, methods=["GET"]
        )
        self.app.add_url_rule(
            "/api/license/import", view_func=self.license_import_api, methods=["POST"]
        )
        self.app.add_url_rule(
            "/api/license/list", view_func=self.license_list_api, methods=["GET"]
        )
        self.app.add_url_rule(
            "/api/license/<license_id>",
            view_func=self.license_delete_api,
            methods=["DELETE"],
        )
        self.app.add_url_rule(
            "/api/action_group/create",
            view_func=self.create_action_group,
            methods=["POST"],
        )
        self.app.add_url_rule(
            "/api/action_group/user_list",
            view_func=self.action_group_user_list,
            methods=["GET"],
        )
        self.app.add_url_rule(
            "/api/action_group/<action_id>",
            view_func=self.delete_action_group,
            methods=["DELETE"],
        )
        self.app.add_url_rule(
            "/api/action_group/current_pose",
            view_func=self.action_group_current_pose,
            methods=["GET"],
        )
        self.app.add_url_rule(
            "/api/action_group/preview_servo",
            view_func=self.action_group_preview_servo,
            methods=["POST"],
        )
        self.app.add_url_rule(
            "/api/cloud_update", view_func=self.cloud_update, methods=["POST"]
        )
        self.app.add_url_rule(
            "/ota/local_upload", view_func=self.local_upload, methods=["POST"]
        )
        self.app.add_url_rule(
            "/api/ota/stream", view_func=self.ota_stream, methods=["GET"]
        )
        self.app.add_url_rule(
            "/api/ota/status", view_func=self.ota_status, methods=["GET"]
        )
        self.app.add_url_rule(
            "/api/shortcut_actions",
            view_func=self.shortcut_actions_api,
            methods=["GET", "POST"],
        )
        self.app.add_url_rule(
            "/api/shortcut_actions/<shortcut_id>",
            view_func=self.shortcut_action_delete_api,
            methods=["DELETE"],
        )
        self.app.add_url_rule(
            "/api/shortcut_actions/stream",
            view_func=self.shortcut_actions_stream,
            methods=["GET"],
        )
        self.app.add_url_rule(
            "/api/shortcut_actions/confirm",
            view_func=self.shortcut_actions_confirm,
            methods=["POST"],
        )
        self.app.add_url_rule(
            "/api/shortcut_actions/trigger",
            view_func=self.shortcut_actions_trigger,
            methods=["POST"],
        )
        self.app.add_url_rule(
            "/api/action_group/action_map",
            view_func=self.upsert_action_map,
            methods=["POST"],
        )
        print("DEBUG: Registered /api/robot/status and /api/status")
        # self.HttpSever.add_url_rule('/BLE_Send', view_func=self.BLE_Send, methods=['GET'])
        # self.HttpSever.add_url_rule('/ReAction', view_func=self.ReAction, methods=['POST'])
        # self.app.add_url_rule('/upload',view_func=self.upload_file,methods=['POST'])
        # self.app.add_url_rule('/submit_movement',view_func=self.submit_movement,methods=['POST'])
        # self.app.add_url_rule('/submit_movement_detail',view_func=self.submit_movement_detail,methods=['POST'])
        # self.app.add_url_rule('/request_camera',view_func=self.request_camera,methods=['GET'])
        # self.app.add_url_rule('/request_game',view_func=self.request_game,methods=['GET'])
        # self.app.add_url_rule('/submit_game',view_func=self.submit_game,methods=['POST'])

    def open_broweser(self, url):
        time.sleep(2.5)
        try:
            webbrowser.open(url)
        except:
            pass

    def LoadActionGroup(self):
        try:
            if os.path.exists(self.actions_group_path):
                json_files = [
                    f
                    for f in os.listdir(self.actions_group_path)
                    if f.endswith(".json")
                ]
                
                data_json_path = os.path.join(self.current_dir, "static", "data.json")
                
                # comment fixed
                existing_data = {}
                existing_actions_map = {} # filename -> display_name

                if os.path.exists(data_json_path):
                    try:
                        with open(data_json_path, "r", encoding="utf-8") as f:
                            existing_data = json.load(f)
                            # comment fixed
                            if isinstance(existing_data, dict) and "actions" in existing_data and isinstance(existing_data["actions"], list):
                                for action in existing_data["actions"]:
                                    if isinstance(action, list) and len(action) >= 2:
                                        display_name, filename = action[0], action[1]
                                        existing_actions_map[filename] = display_name
                    except Exception:
                        existing_data = {}
                
                # comment fixed
                if isinstance(existing_data, list):
                    existing_data = {"music": existing_data}
                elif not isinstance(existing_data, dict):
                    existing_data = {}

                actions_data = []
                for item in json_files:
                    filename = str(item[:-5])
                    # comment fixed
                    display_name = existing_actions_map.get(filename, filename)
                    actions_data.append([display_name, filename])
                
                # comment fixed
                existing_data["actions"] = actions_data
 
                with open(data_json_path, "w", encoding="utf-8") as f:
                    json.dump(existing_data, f, indent=2, ensure_ascii=False)
            else:
                print("缺失 actions_group 文件")
        except Exception as e:
            print(f"应用版问题：文件路径错误 {e}")

    # endregion

    # region
    def handle_error(self, e):
        if SERVERLOG:
            self.logger.error(f"服务器出现错误: {str(e)}")
            return jsonify({"error": "Interr server error"}), 500

    def index(self):
        return render_template("index.html")

    def sudu(self):
        return render_template("shudu.html")

    def habcam(self):
        return render_template("RehabCam.html")

    def data(self):
        return render_template("DataManager.html")

    # comment fixed
    def BLE_State(self):
        if self.magos.BLE_worker.is_connected():
            return ["True"]
        return ["False"]

    def _ble_error_response(self, code, message, http_status=500, detail=None, stage="scan"):
        payload = {
            "code": str(code or "ble_error"),
            "error": str(message or "BLE operation failed"),
        }
        if detail:
            payload["detail"] = str(detail)
        self._ble_last_error = {
            "code": payload["code"],
            "message": payload["error"],
            "detail": payload.get("detail"),
            "stage": str(stage),
            "at": time.time(),
            "http_status": int(http_status),
        }
        return jsonify(payload), http_status

    def _normalize_robot_slot(self, raw, default="A"):
        s = str(raw or default).strip().upper()
        slots = getattr(self, "ROBOT_SLOTS", tuple("ABCDEF"))
        return s if s in slots else default

    def _stop_music_on_connected_slots(self):
        success_slots = []
        skipped_slots = []
        failed = []
        for slot in getattr(self, "ROBOT_SLOTS", tuple("ABCDEF")):
            mag = self._magos_by_slot.get(slot) if getattr(self, "_magos_by_slot", None) else None
            worker = mag.BLE_worker if mag else None
            if not worker or not worker.is_connected():
                skipped_slots.append(slot)
                continue
            try:
                mag.stop_background_audio()
                success_slots.append(slot)
            except Exception as exc:
                failed.append({"slot": slot, "error": str(exc)})
        return {
            "success_slots": success_slots,
            "skipped_slots": skipped_slots,
            "failed_slots": failed,
        }

    def _map_ble_exception(self, error, default_code="ble_scan_failed"):
        if isinstance(error, TimeoutError):
            return ("scan_timeout", "Bluetooth scan timed out", 504)

        text = f"{type(error).__name__}: {error}".lower()
        if isinstance(error, ModuleNotFoundError) or "no module named" in text:
            return ("ble_unavailable", "Bluetooth runtime dependency missing", 500)
        if "permission" in text or "denied" in text or "access" in text:
            return ("permission_denied", "Bluetooth permission denied", 403)
        if "bluetooth" in text and (
            "off" in text or "disabled" in text or "unavailable" in text
        ):
            return ("adapter_off", "Bluetooth adapter is off or unavailable", 503)
        if "winrt" in text and ("not found" in text or "missing" in text):
            return ("ble_unavailable", "Bluetooth runtime dependency missing", 500)
        return (default_code, "Bluetooth operation failed", 500)

    @staticmethod
    def _is_mac_address_text(text: str) -> bool:
        return bool(re.fullmatch(r"(?:[0-9A-F]{2}:){5}[0-9A-F]{2}", str(text or "").strip(), re.IGNORECASE))

    # comment fixed
    def BLE_Refresh(self):
        """Refresh BLE device list."""
        try:
            # comment fixed
            # comment fixed
            if not self.BLE_worker or not self.BLE_worker.loop:
                 print("ERROR: BLE_worker or loop not initialized")
                 return self._ble_error_response(
                     "ble_unavailable",
                     "BLE system not ready",
                     500,
                     stage="scan",
                 )

            future = asyncio.run_coroutine_threadsafe(
                self.magos.BLE_worker.scan(), 
                self.magos.BLE_worker.loop
            )
            
            # comment fixed
            devices = future.result(timeout=8)
            device_list = []
            filtered_out = 0
            for item in devices or []:
                if isinstance(item, dict):
                    address = str(item.get("address") or "").strip().upper()
                    name = str(item.get("name") or "").strip()
                    display_name = str(item.get("display_name") or "").strip()
                    rssi = item.get("rssi")
                else:
                    address = str(getattr(item, "address", "") or "").strip().upper()
                    name = str(getattr(item, "name", "") or "").strip()
                    display_name = ""
                    rssi = getattr(item, "rssi", None)

                if not address and not name:
                    continue

                # 屏蔽无名称设备与纯地址广播名，避免前端看到无意义地址列表。
                if not name:
                    filtered_out += 1
                    continue
                if self._is_mac_address_text(name):
                    filtered_out += 1
                    continue

                if not address:
                    address = name
                # UI 只展示设备名，不展示地址。
                display_name = name
                try:
                    rssi = int(rssi) if rssi is not None else None
                except (TypeError, ValueError):
                    rssi = None

                device_list.append(
                    {
                        "address": address,
                        "name": name,
                        "display_name": display_name,
                        "rssi": rssi,
                    }
                )
            
            self._ble_last_error = {}
            return jsonify(device_list)
            
        except TimeoutError:
            logging.getLogger(__name__).error("BLE scan timed out")
            return self._ble_error_response(
                "scan_timeout",
                "Scan timed out",
                504,
                stage="scan",
            )
        except Exception as e:
            code, message, http_status = self._map_ble_exception(
                e, default_code="ble_scan_failed"
            )
            logger = getattr(self, "logger", logging.getLogger(__name__))
            logger.exception("BLE_Refresh failed")
            return self._ble_error_response(
                code,
                message,
                http_status,
                detail=str(e),
                stage="scan",
            )

    # comment fixed
    def BLE_Connect(self):
        """BLE设备连接"""
        print("DEBUG: BLE_Connect called (Sync mode)")
        try:
            payload = request.get_json(silent=True)
            selected_device = request.data.decode("utf-8").strip() if request.data else ""
            target = {}
            slot = "A"
            if isinstance(payload, dict):
                slot = self._normalize_robot_slot(payload.get("slot"), "A")
                target = {
                    "address": str(payload.get("address") or "").strip(),
                    "name": str(payload.get("name") or "").strip(),
                }
            elif selected_device:
                target = {"address": selected_device, "name": selected_device}

            print(f"DEBUG: Connecting slot={slot} target={target}")
            if not target.get("address") and not target.get("name"):
                print("错误：没有选中蓝牙设备")
                return ["False"]

            mag = self._magos_by_slot.get(slot) or self.magos
            worker = mag.BLE_worker if mag else None
            if not worker or not worker.loop:
                 print("ERROR: BLE_worker or loop not initialized")
                 return self._ble_error_response(
                     "ble_unavailable",
                     "BLE system not ready",
                     500,
                     stage="connect",
                 )

            future = asyncio.run_coroutine_threadsafe(
                worker.connect(target),
                worker.loop
            )
            
            # comment fixed
            result = future.result(timeout=10)
            
            if result == True:
                print("连接成功")
                self._ble_last_error = {}
                dh = worker.ble_handle
                addr = (
                    str(getattr(dh, "device_address", "") or target.get("address") or "")
                    .strip()
                    .upper()
                )
                nm = str(
                    getattr(dh, "device_name", "") or target.get("name") or ""
                ).strip()
                disp = nm or addr
                if isinstance(payload, dict):
                    d = str(payload.get("display_name") or "").strip()
                    if d:
                        disp = d
                self.slot_bindings[slot] = {
                    "address": addr,
                    "name": nm,
                    "display_name": disp,
                }
                return ["True"]
            print("连接失败")
            return ["False"]
            
        except TimeoutError:
            print("ERROR: BLE_Connect timed out")
            return self._ble_error_response(
                "connect_timeout",
                "Connection timed out",
                504,
                stage="connect",
            )
        except Exception as e:
            logger = getattr(self, "logger", logging.getLogger(__name__))
            logger.exception("BLE_Connect failed")
            self._ble_last_error = {
                "code": "ble_connect_failed",
                "message": str(e),
                "detail": str(e),
                "stage": "connect",
                "at": time.time(),
                "http_status": 500,
            }
            return ["False"]

    def ble_diagnostics(self):
        """Return BLE runtime diagnostics for packaged troubleshooting."""
        diagnostics = {
            "platform": {
                "system": platform.system(),
                "release": platform.release(),
                "version": platform.version(),
                "machine": platform.machine(),
            },
            "python": {
                "version": sys.version,
                "executable": sys.executable,
            },
            "bleak": {
                "version": None,
                "import_ok": False,
                "error": "",
            },
            "winrt": {},
            "radio": {
                "available": False,
                "entries": [],
                "error": "",
            },
            "scan_cache": {
                "size": 0,
                "preview": [],
            },
            "last_error": dict(getattr(self, "_ble_last_error", {})),
        }

        try:
            diagnostics["bleak"]["version"] = importlib.metadata.version("bleak")
            importlib.import_module("bleak")
            diagnostics["bleak"]["import_ok"] = True
        except Exception as e:
            diagnostics["bleak"]["error"] = str(e)

        winrt_modules = [
            "winrt.windows.devices.bluetooth",
            "winrt.windows.devices.bluetooth.advertisement",
            "winrt.windows.devices.enumeration",
            "winrt.windows.devices.radios",
            "winrt.windows.foundation",
            "winrt.windows.storage.streams",
        ]
        for module_name in winrt_modules:
            try:
                importlib.import_module(module_name)
                diagnostics["winrt"][module_name] = {"ok": True}
            except Exception as e:
                diagnostics["winrt"][module_name] = {"ok": False, "error": str(e)}

        try:
            cached = self.BLE_Handle.get_last_scan_records()
            diagnostics["scan_cache"]["size"] = len(cached)
            diagnostics["scan_cache"]["preview"] = cached[:5]
        except Exception as e:
            diagnostics["scan_cache"]["error"] = str(e)

        if platform.system().lower() == "windows":
            try:
                from winrt.windows.devices.radios import Radio

                async def _load_radios():
                    radios = await Radio.get_radios_async()
                    items = []
                    for radio in radios:
                        items.append(
                            {
                                "name": str(getattr(radio, "name", "")),
                                "kind": str(getattr(radio, "kind", "")),
                                "state": str(getattr(radio, "state", "")),
                            }
                        )
                    return items

                try:
                    entries = asyncio.run(_load_radios())
                except RuntimeError:
                    temp_loop = asyncio.new_event_loop()
                    try:
                        entries = temp_loop.run_until_complete(_load_radios())
                    finally:
                        temp_loop.close()

                diagnostics["radio"]["available"] = True
                diagnostics["radio"]["entries"] = entries
            except Exception as e:
                diagnostics["radio"]["error"] = str(e)

        return jsonify(diagnostics)

    # comment fixed
    def BLE_Disconnect(self):
        """BLE设备断开连接"""
        print("DEBUG: BLE_Disconnect called (Sync mode)")
        try:
            slot = self._normalize_robot_slot(request.args.get("slot"), "A")
            mag = self._magos_by_slot.get(slot) or self.magos
            worker = mag.BLE_worker if mag else None
            if not worker or not worker.loop:
                 print("ERROR: BLE_worker or loop not initialized")
                 return jsonify({"error": "BLE system not ready"}), 500

            future = asyncio.run_coroutine_threadsafe(
                worker.disconnect(),
                worker.loop
            )
            
            # comment fixed
            # comment fixed
            future.result(timeout=5)
            
            # comment fixed
            if worker.is_connected():
                return ["False"]
            self.slot_bindings[slot] = {}
            return ["True"]
        except TimeoutError:
            print("ERROR: BLE_Disconnect timed out")
            return jsonify({"error": "Disconnect timed out"}), 504
        except Exception as e:
            print("发生错误", e)
            import traceback
            traceback.print_exc()
            return ["False"]

    def reset_robot(self):
        """Reset robot."""
        try:
            # comment fixed
            self.magos.handle_reset()
            return jsonify({"status": "success", "message": "Robot reset successfully"})
        except Exception as e:
            print(f"Reset failed: {e}")
            return jsonify({"status": "failed", "message": str(e)}), 500

    def robot_status(self):
        """Get robot status."""
        try:
            task_status = self.task_manager.status_code
            updated_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            slots_out = []

            def _battery_from_handle(dh):
                if not dh:
                    return None
                raw_battery = getattr(dh, "battery_val", None)
                if raw_battery is None:
                    return None
                try:
                    b = int(raw_battery)
                    if b < 0:
                        b = 0
                    if b > 100:
                        b = 100
                    return b
                except (ValueError, TypeError):
                    return None

            for s in getattr(self, "ROBOT_SLOTS", tuple("ABCDEF")):
                mag = self._magos_by_slot.get(s) if getattr(self, "_magos_by_slot", None) else None
                w = mag.BLE_worker if mag else None
                conn = bool(w.is_connected()) if w else False
                dh = w.ble_handle if w else None
                bind = (self.slot_bindings or {}).get(s) or {}
                device_name = (
                    str(getattr(dh, "device_name", "") or "").strip()
                    or str(bind.get("display_name") or bind.get("name") or "").strip()
                )
                addr = str(getattr(dh, "device_address", "") or bind.get("address") or "").strip().upper()
                firmware_version = getattr(dh, "firmware_version", None) if dh else None
                agent_id = getattr(dh, "agent_id", None) if dh else None
                conn_interval_target_units = (
                    getattr(dh, "conn_interval_target_units", None) if dh else None
                )
                conn_interval_target_ms = (
                    getattr(dh, "conn_interval_target_ms", None) if dh else None
                )
                conn_interval_rx_units = (
                    getattr(dh, "conn_interval_rx_units", None) if dh else None
                )
                conn_interval_rx_ms = getattr(dh, "conn_interval_rx_ms", None) if dh else None
                bat = _battery_from_handle(dh)
                license_agent_allowed = None
                aid_str = str(agent_id or "").strip()
                if aid_str and getattr(self, "license_manager", None):
                    try:
                        license_agent_allowed = bool(
                            self.license_manager.is_agent_allowed(aid_str)
                        )
                    except Exception:
                        license_agent_allowed = None
                slots_out.append(
                    {
                        "slot": s,
                        "is_connected": conn,
                        "connected": conn,
                        "isConnected": conn,
                        "device_name": device_name,
                        "address": addr,
                        "battery": bat,
                        "firmware_version": firmware_version,
                        "firmwareVersion": firmware_version,
                        "agent_id": agent_id,
                        "agentId": agent_id,
                        "license_agent_allowed": license_agent_allowed,
                        "licenseAgentAllowed": license_agent_allowed,
                        "conn_interval_target_units": conn_interval_target_units,
                        "conn_interval_target_ms": conn_interval_target_ms,
                        "conn_interval_rx_units": conn_interval_rx_units,
                        "conn_interval_rx_ms": conn_interval_rx_ms,
                    }
                )

            slot_a = next((r for r in slots_out if r.get("slot") == "A"), None)
            if slot_a:
                is_connected = bool(slot_a["is_connected"])
                device_name = slot_a.get("device_name") or ""
                firmware_version = slot_a.get("firmware_version")
                agent_id = slot_a.get("agent_id")
                conn_interval_target_units = slot_a.get("conn_interval_target_units")
                conn_interval_target_ms = slot_a.get("conn_interval_target_ms")
                conn_interval_rx_units = slot_a.get("conn_interval_rx_units")
                conn_interval_rx_ms = slot_a.get("conn_interval_rx_ms")
                battery = slot_a.get("battery")
            else:
                is_connected = False
                device_name = ""
                firmware_version = None
                agent_id = None
                conn_interval_target_units = None
                conn_interval_target_ms = None
                conn_interval_rx_units = None
                conn_interval_rx_ms = None
                battery = None

            any_connected = any(bool(r.get("is_connected")) for r in slots_out)

            response_data = {
                "is_connected": is_connected,
                "connected": is_connected,
                "isConnected": is_connected,
                "any_connected": any_connected,
                "device_name": device_name,
                "connected_device": device_name,
                "name": device_name,
                "status": task_status,
                "battery": battery,
                "firmware_version": firmware_version,
                "firmwareVersion": firmware_version,
                "agent_id": agent_id,
                "agentId": agent_id,
                "conn_interval_target_units": conn_interval_target_units,
                "connIntervalTargetUnits": conn_interval_target_units,
                "conn_interval_target_ms": conn_interval_target_ms,
                "connIntervalTargetMs": conn_interval_target_ms,
                "conn_interval_rx_units": conn_interval_rx_units,
                "connIntervalRxUnits": conn_interval_rx_units,
                "conn_interval_rx_ms": conn_interval_rx_ms,
                "connIntervalRxMs": conn_interval_rx_ms,
                "updated_at": updated_at,
                "slots": slots_out,
            }
            return jsonify(response_data)
        except Exception as e:
            print(f"Get status failed: {e}")
            return jsonify({"error": str(e)}), 500

    def set_battery_display(self):
        """Set battery display mode."""
        try:
            data = request.get_json(silent=True) or {}
            if not data or "display_mode" not in data:
                return jsonify({"status": "failed", "message": "Missing 'display_mode' parameter"}), 400
            
            mode = int(data["display_mode"])
            enabled = (mode == 1)

            raw_slots = data.get("slots")
            target_slots = []
            if isinstance(raw_slots, list):
                for item in raw_slots:
                    s = self._normalize_robot_slot(item, "")
                    if s and s not in target_slots:
                        target_slots.append(s)
            elif raw_slots:
                s = self._normalize_robot_slot(raw_slots, "")
                if s:
                    target_slots.append(s)

            # 兼容旧逻辑：未指定 slots 时，沿用默认槽位实例（含 mock 行为）
            if not target_slots:
                is_mock = True
                if is_mock and (
                    not self.magos
                    or not self.magos.BLE_worker
                    or not self.magos.BLE_worker.is_connected()
                ):
                    print(
                        f"[MOCK] 模拟发送指令: Set Battery Display -> {'ON' if enabled else 'OFF'}"
                    )
                    return jsonify(
                        {
                            "status": "success",
                            "mode": mode,
                            "target_slots": ["A"],
                            "success_count": 1,
                            "failed_count": 0,
                            "failed_slots": [],
                            "results": [
                                {
                                    "slot": "A",
                                    "status": "success",
                                    "message": f"[MOCK] Battery display set to {'ON' if enabled else 'OFF'}",
                                }
                            ],
                            "message": f"[MOCK] Battery display set to {'ON' if enabled else 'OFF'}",
                        }
                    )

                if not self.magos or not self.magos.BLE_worker:
                    return (
                        jsonify({"status": "failed", "message": "BLE worker not initialized"}),
                        500,
                    )
                if not self.magos.BLE_worker.is_connected():
                    return jsonify({"status": "failed", "message": "Robot not connected"}), 400

                self.magos.BLE_worker.set_battery_display_mode(enabled)
                return jsonify(
                    {
                        "status": "success",
                        "mode": mode,
                        "target_slots": ["A"],
                        "success_count": 1,
                        "failed_count": 0,
                        "failed_slots": [],
                        "results": [
                            {
                                "slot": "A",
                                "status": "success",
                                "message": f"Battery display set to {'ON' if enabled else 'OFF'}",
                            }
                        ],
                        "message": f"Battery display set to {'ON' if enabled else 'OFF'}",
                    }
                )

            results = []
            for slot in target_slots:
                row = {"slot": slot, "status": "failed", "message": ""}
                try:
                    mag = self._magos_by_slot.get(slot)
                    worker = mag.BLE_worker if mag else None
                    if not worker:
                        row["message"] = "BLE worker not initialized"
                    elif not worker.is_connected():
                        row["message"] = "Robot not connected"
                    else:
                        worker.set_battery_display_mode(enabled)
                        row["status"] = "success"
                        row["message"] = f"Battery display set to {'ON' if enabled else 'OFF'}"
                except Exception as slot_error:
                    row["message"] = str(slot_error)
                results.append(row)

            success_count = sum(1 for r in results if r.get("status") == "success")
            failed = [r for r in results if r.get("status") != "success"]
            failed_count = len(failed)
            failed_slots = [str(r.get("slot") or "").upper() for r in failed if r.get("slot")]
            if success_count > 0 and failed_count == 0:
                status = "success"
                message = f"Battery display set for {success_count} device(s)"
            elif success_count > 0:
                status = "partial"
                message = f"Applied to {success_count} device(s), {failed_count} failed"
            else:
                status = "failed"
                message = "No target device updated"

            return jsonify(
                {
                    "status": status,
                    "mode": mode,
                    "target_slots": target_slots,
                    "success_count": success_count,
                    "failed_count": failed_count,
                    "failed_slots": failed_slots,
                    "results": results,
                    "message": message,
                }
            )
            
        except Exception as e:
            print(f"Set battery display failed: {e}")
            return jsonify({"status": "failed", "message": str(e)}), 500

    def rename_device(self):
        """修改蓝牙设备名称"""
        try:
            data = request.get_json()
            if not data or "new_name" not in data:
                return jsonify({"status": "failed", "message": "Missing 'new_name' parameter"}), 400
            
            new_name = str(data["new_name"]).strip()
            if not new_name:
                 return jsonify({"status": "failed", "message": "New name cannot be empty"}), 400
            
            # comment fixed
            if len(new_name.encode('utf-8')) > 20:
                return jsonify({"status": "failed", "message": "Name too long (max 20 bytes)"}), 400

            if not self.magos or not self.magos.BLE_worker:
                 return jsonify({"status": "failed", "message": "BLE worker not initialized"}), 500
                 
            # comment fixed
            if not self.magos.BLE_worker.is_connected():
                return jsonify({"status": "failed", "message": "Robot not connected"}), 400

            # comment fixed
            if not self.magos.BLE_worker.loop:
                 return jsonify({"status": "failed", "message": "BLE loop not ready"}), 500

            future = asyncio.run_coroutine_threadsafe(
                self.magos.BLE_worker.set_name(new_name), 
                self.magos.BLE_worker.loop
            )
            
            # comment fixed
            result = future.result(timeout=5)
            
            if result:
                return jsonify({"status": "success", "message": f"Device renamed to {new_name}", "new_name": new_name})
            else:
                return jsonify({"status": "failed", "message": "Failed to write device name"}), 500
            
        except TimeoutError:
             return jsonify({"status": "failed", "message": "Rename operation timed out"}), 504
        except Exception as e:
            print(f"Rename device failed: {e}")
            return jsonify({"status": "failed", "message": str(e)}), 500

    def set_ai_agent(self):
        try:
            data = request.get_json(silent=True) or {}
            agent_id = str(data.get("agent_id") or data.get("agentId") or "").strip()
            if not agent_id:
                return jsonify({"status": "failed", "message": "Missing 'agent_id' parameter"}), 400
            if len(agent_id.encode("utf-8")) > 64:
                return jsonify({"status": "failed", "message": "agent_id too long (max 64 bytes)"}), 400

            raw_slot = data.get("slot") or data.get("Slot") or data.get("slot_id")
            slot = self._normalize_robot_slot(raw_slot, "A") if raw_slot else "A"

            if not getattr(self, "license_manager", None):
                return (
                    jsonify(
                        {
                            "status": "failed",
                            "code": "license_runtime_unavailable",
                            "message": "License runtime is not available",
                        }
                    ),
                    503,
                )

            if not self.license_manager.is_agent_allowed(agent_id):
                return (
                    jsonify(
                        {
                            "status": "failed",
                            "code": "license_required",
                            "message": "License required for this AI agent",
                            "required_agent_id": agent_id,
                            "requiredAgentId": agent_id,
                            "slot": slot,
                        }
                    ),
                    403,
                )

            mag = (self._magos_by_slot or {}).get(slot) if getattr(self, "_magos_by_slot", None) else None
            if not mag:
                mag = self.magos
            if not mag:
                return jsonify({"status": "failed", "message": "Magos not initialized"}), 500

            worker = getattr(mag, "BLE_worker", None)
            if not worker or not worker.is_connected():
                return (
                    jsonify(
                        {
                            "status": "failed",
                            "code": "slot_not_connected",
                            "message": f"Slot {slot} is not connected",
                            "slot": slot,
                        }
                    ),
                    409,
                )

            ok = bool(mag.set_ai_agent_id(agent_id))
            if ok and worker and worker.ble_handle:
                worker.ble_handle.agent_id = agent_id

            if not ok:
                return jsonify({"status": "failed", "message": "Failed to set AI agent ID", "slot": slot}), 500

            return jsonify(
                {
                    "status": "success",
                    "message": "AI agent ID updated",
                    "agent_id": agent_id,
                    "agentId": agent_id,
                    "slot": slot,
                }
            )
        except Exception as e:
            print(f"Set AI agent failed: {e}")
            return jsonify({"status": "failed", "message": str(e)}), 500

    # region License
    def _init_license_runtime(self):
        self.license_manager = None
        self._license_runtime_error = ""
        try:
            self.license_manager = LicenseManager(
                app_name="Magos", fallback_base_dir=self.current_dir
            )
        except Exception as e:
            self._license_runtime_error = str(e)
            self.license_manager = None

    def _license_status_fallback(self, status_text="failed"):
        return {
            "status": status_text,
            "licensed": False,
            "customer_name": "",
            "license_id": "",
            "expires_at": "",
            "entitlements": {"agents": []},
            "agent_access": {agent_id: False for agent_id in AGENT_LICENSE_TARGETS},
            "items": [],
        }

    def license_status_api(self):
        if not getattr(self, "license_manager", None):
            payload = self._license_status_fallback(status_text="failed")
            payload["code"] = "license_runtime_unavailable"
            payload["message"] = self._license_runtime_error or "License runtime unavailable"
            return jsonify(payload), 503
        try:
            payload = self.license_manager.status()
            return jsonify(payload)
        except Exception as e:
            payload = self._license_status_fallback(status_text="failed")
            payload["code"] = "license_status_failed"
            payload["message"] = str(e)
            return jsonify(payload), 500

    def license_import_api(self):
        if not getattr(self, "license_manager", None):
            return (
                jsonify(
                    {
                        "status": "failed",
                        "code": "license_runtime_unavailable",
                        "message": self._license_runtime_error or "License runtime unavailable",
                    }
                ),
                503,
            )
        license_file = request.files.get("license_file")
        if not license_file:
            return (
                jsonify(
                    {
                        "status": "failed",
                        "code": "invalid_format",
                        "message": "Missing license_file",
                    }
                ),
                400,
            )
        filename = str(license_file.filename or "").strip()
        if not filename:
            return (
                jsonify(
                    {
                        "status": "failed",
                        "code": "invalid_format",
                        "message": "Empty filename",
                    }
                ),
                400,
            )
        try:
            blob = license_file.read()
            ok, code, message, imported = self.license_manager.import_license_blob(
                filename, blob
            )
            if not ok:
                return (
                    jsonify({"status": "failed", "code": code, "message": message}),
                    400,
                )
            payload = self.license_manager.status()
            payload["message"] = "License imported"
            payload["imported"] = imported
            return jsonify(payload)
        except Exception as e:
            return (
                jsonify(
                    {
                        "status": "failed",
                        "code": "license_import_failed",
                        "message": str(e),
                    }
                ),
                500,
            )

    def license_list_api(self):
        if not getattr(self, "license_manager", None):
            return (
                jsonify(
                    {
                        "status": "failed",
                        "code": "license_runtime_unavailable",
                        "message": self._license_runtime_error or "License runtime unavailable",
                        "items": [],
                    }
                ),
                503,
            )
        try:
            return jsonify(
                {
                    "status": "success",
                    "items": self.license_manager.list_licenses(),
                    "store_dir": self.license_manager.store_dir,
                }
            )
        except Exception as e:
            return (
                jsonify(
                    {
                        "status": "failed",
                        "code": "license_list_failed",
                        "message": str(e),
                        "items": [],
                    }
                ),
                500,
            )

    def license_delete_api(self, license_id):
        if not getattr(self, "license_manager", None):
            return (
                jsonify(
                    {
                        "status": "failed",
                        "code": "license_runtime_unavailable",
                        "message": self._license_runtime_error or "License runtime unavailable",
                    }
                ),
                503,
            )
        target = str(license_id or "").strip()
        if not target:
            return (
                jsonify(
                    {
                        "status": "failed",
                        "code": "invalid_format",
                        "message": "license_id is required",
                    }
                ),
                400,
            )
        try:
            deleted = self.license_manager.delete_license(target)
            if not deleted:
                return (
                    jsonify(
                        {
                            "status": "failed",
                            "code": "not_found",
                            "message": "License not found",
                        }
                    ),
                    404,
                )
            payload = self.license_manager.status()
            payload["message"] = "License deleted"
            payload["deleted"] = target
            return jsonify(payload)
        except Exception as e:
            return (
                jsonify(
                    {
                        "status": "failed",
                        "code": "license_delete_failed",
                        "message": str(e),
                    }
                ),
                500,
            )
    # endregion

    def _sanitize_action_group_name(self, raw_name: str) -> str:
        name = str(raw_name or "").strip()
        if not name:
            return ""
        name = re.sub(r'[<>:"/\\|?*\x00-\x1F]', "", name)
        name = re.sub(r"\s+", " ", name).strip().rstrip(". ")
        return name[:64]

    def _action_group_registry_path(self):
        return os.path.join(
            self.current_dir, "runtime", "action_group_user_registry.json"
        )

    def _load_action_group_registry(self):
        path = self._action_group_registry_path()
        if not os.path.exists(path):
            return {"items": []}

        try:
            with open(path, "r", encoding="utf-8") as f:
                payload = json.load(f)
        except Exception:
            return {"items": []}

        if isinstance(payload, list):
            payload = {"items": payload}
        if not isinstance(payload, dict):
            return {"items": []}

        items = payload.get("items")
        if not isinstance(items, list):
            items = []

        normalized = []
        seen = set()
        for item in items:
            if isinstance(item, str):
                action_id = self._sanitize_action_group_name(item)
                action_name = action_id
                created_at = 0
            elif isinstance(item, dict):
                action_id = self._sanitize_action_group_name(item.get("id"))
                action_name = str(item.get("name") or action_id).strip() or action_id
                try:
                    created_at = int(item.get("created_at") or 0)
                except (TypeError, ValueError):
                    created_at = 0
            else:
                continue

            if not action_id or action_id in seen:
                continue
            seen.add(action_id)
            normalized.append(
                {"id": action_id, "name": action_name, "created_at": created_at}
            )

        return {"items": normalized}

    def _save_action_group_registry(self, payload):
        path = self._action_group_registry_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp_path = f"{path}.tmp.{uuid.uuid4().hex}"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, path)

    def _upsert_user_action_group_registry(self, action_id: str, display_name: str):
        normalized_id = self._sanitize_action_group_name(action_id)
        if not normalized_id:
            return

        payload = self._load_action_group_registry()
        items = payload.get("items")
        if not isinstance(items, list):
            items = []
            payload["items"] = items

        now_ms = int(time.time() * 1000)
        normalized_name = str(display_name or normalized_id).strip() or normalized_id
        for item in items:
            if not isinstance(item, dict):
                continue
            if str(item.get("id") or "") == normalized_id:
                item["name"] = normalized_name
                if not item.get("created_at"):
                    item["created_at"] = now_ms
                self._save_action_group_registry(payload)
                return

        items.append(
            {"id": normalized_id, "name": normalized_name, "created_at": now_ms}
        )
        self._save_action_group_registry(payload)

    def _remove_user_action_group_registry(self, action_id: str):
        normalized_id = self._sanitize_action_group_name(action_id)
        payload = self._load_action_group_registry()
        items = payload.get("items")
        if not isinstance(items, list):
            return False

        before = len(items)
        payload["items"] = [
            item
            for item in items
            if str((item or {}).get("id") if isinstance(item, dict) else "") != normalized_id
        ]
        changed = len(payload["items"]) != before
        if changed:
            self._save_action_group_registry(payload)
        return changed

    def _remove_action_group_manifest_entry(self, action_id: str):
        normalized_id = self._sanitize_action_group_name(action_id)
        if not normalized_id:
            return

        payload = self._load_music_manifest()
        changed = False

        action_map = payload.get("action_map")
        if isinstance(action_map, dict) and normalized_id in action_map:
            action_map.pop(normalized_id, None)
            changed = True

        actions_list = payload.get("actions")
        if isinstance(actions_list, list):
            filtered = []
            for item in actions_list:
                if isinstance(item, list) and len(item) >= 2:
                    if str(item[1]) == normalized_id:
                        changed = True
                        continue
                filtered.append(item)
            payload["actions"] = filtered

        if changed:
            self._save_music_manifest(payload)

    def _angle_to_raw_value(self, servo_key: str, angle_value) -> int:
        try:
            target = float(angle_value)
        except (TypeError, ValueError):
            raise ValueError(f"Invalid angle for {servo_key}")
        target = max(0.0, min(180.0, target))

        clamp = {}
        if getattr(self, "magos", None) and hasattr(self.magos, "ServerClamp"):
            clamp = self.magos.ServerClamp

        v0, v90, v180 = clamp.get(servo_key, (500, 500, 500))
        if target <= 90.0:
            raw = v0 + (v90 - v0) * (target / 90.0)
        else:
            raw = v90 + (v180 - v90) * ((target - 90.0) / 90.0)
        return int(round(raw))

    def _default_action_joint_angles(self):
        defaults = None
        try:
            if self.magos:
                defaults = self.magos.get_all_servos_positions()
        except Exception:
            defaults = None

        if isinstance(defaults, (list, tuple)):
            values = [int(v) if v is not None else 500 for v in defaults]
        else:
            values = []

        if len(values) < 10:
            values = []
            limits = []
            if getattr(self, "magos", None) and getattr(self.magos, "robotData", None):
                limits = getattr(self.magos.robotData, "raw_limits", []) or []
            for lo, hi in limits[:10]:
                values.append(int((int(lo) + int(hi)) / 2))
            while len(values) < 10:
                values.append(500)

        return values[:10]

    def _action_group_servo_mapping(self):
        return [
            {
                "payload_key": "left_shoulder",
                "clamp_key": "LeftShoulder",
                "raw_index": 5,
                "command_index": 5,
            },
            {
                "payload_key": "left_arm",
                "clamp_key": "LeftArm",
                "raw_index": 4,
                "command_index": 4,
            },
            {
                "payload_key": "left_hand",
                "clamp_key": "LeftHand",
                "raw_index": 3,
                "command_index": 3,
            },
            {
                "payload_key": "right_shoulder",
                "clamp_key": "RightShoulder",
                "raw_index": 2,
                "command_index": 2,
            },
            {
                "payload_key": "right_arm",
                "clamp_key": "RightArm",
                "raw_index": 1,
                "command_index": 1,
            },
            {
                "payload_key": "right_hand",
                "clamp_key": "RightHand",
                "raw_index": 0,
                "command_index": 0,
            },
        ]

    def _raw_to_angle_value(self, servo_key: str, raw_value) -> int:
        try:
            raw_target = float(raw_value)
        except (TypeError, ValueError):
            return 90

        best_angle = 90
        best_error = float("inf")
        for angle in range(181):
            estimate_raw = self._angle_to_raw_value(servo_key, angle)
            error = abs(estimate_raw - raw_target)
            if error < best_error:
                best_error = error
                best_angle = angle
        return int(max(0, min(180, best_angle)))

    def _try_refresh_servo_positions_once(self, timeout_ms=500) -> bool:
        ble_worker = getattr(getattr(self, "magos", None), "BLE_worker", None)
        if not ble_worker or not ble_worker.is_connected():
            return False

        base_addr = int(getattr(ble_worker, "DEV_SERVO_BASE", 0x01))
        read_targets = list(range(base_addr, base_addr + 10))
        received = {}
        received_lock = threading.Lock()
        done_event = threading.Event()

        callbacks = getattr(ble_worker, "callbacks", None)
        previous_callback = callbacks.get(base_addr) if isinstance(callbacks, dict) else None

        def _decode_servo_raw(dev_data):
            if isinstance(dev_data, (bytes, bytearray)):
                payload = bytes(dev_data)
            elif isinstance(dev_data, list):
                payload = bytes(int(x) & 0xFF for x in dev_data)
            else:
                return None

            if len(payload) >= 2:
                return int.from_bytes(payload[:2], byteorder="little", signed=False)
            if len(payload) == 1:
                return int(payload[0])
            return None

        def _on_servo_data(dev_addr, dev_data):
            raw_value = _decode_servo_raw(dev_data)
            if raw_value is None:
                return

            try:
                addr = int(dev_addr)
            except (TypeError, ValueError):
                return

            logic_index = addr - base_addr
            if logic_index < 0 or logic_index >= 10:
                return

            if self.magos and getattr(self.magos, "robotData", None):
                try:
                    self.magos.robotData.update_single_angle(int(raw_value), logic_index)
                except Exception as update_error:
                    print(f"ActionGroup servo cache update failed: {update_error}")

            with received_lock:
                received[logic_index] = int(raw_value)
                if len(received) >= 10:
                    done_event.set()

        try:
            ble_worker.register_callback(base_addr, _on_servo_data)
            ble_worker.read_multiple(read_targets)
            wait_sec = max(0.05, float(timeout_ms) / 1000.0)
            done_event.wait(wait_sec)
        except Exception as e:
            print(f"ActionGroup live pose refresh failed: {e}")
        finally:
            if isinstance(callbacks, dict):
                if previous_callback is None:
                    callbacks.pop(base_addr, None)
                else:
                    callbacks[base_addr] = previous_callback

        return bool(received)

    def _build_action_group_pose(self):
        joint_angles = self._default_action_joint_angles()
        pose = {}
        for mapping in self._action_group_servo_mapping():
            raw_index = mapping["raw_index"]
            raw_value = joint_angles[raw_index] if raw_index < len(joint_angles) else 500
            pose[mapping["payload_key"]] = self._raw_to_angle_value(
                mapping["clamp_key"], raw_value
            )
        return pose

    def action_group_current_pose(self):
        try:
            ble_worker = getattr(getattr(self, "magos", None), "BLE_worker", None)
            if not ble_worker or not ble_worker.is_connected():
                return jsonify({"status": "failed", "message": "BLE not connected"}), 409

            source = "cache"
            if self._try_refresh_servo_positions_once(timeout_ms=500):
                source = "live"

            return jsonify(
                {
                    "status": "success",
                    "source": source,
                    "servos": self._build_action_group_pose(),
                }
            )
        except Exception as e:
            print(f"Get action group current pose failed: {e}")
            return jsonify({"status": "failed", "message": str(e)}), 500

    def action_group_preview_servo(self):
        try:
            ble_worker = getattr(getattr(self, "magos", None), "BLE_worker", None)
            if not ble_worker or not ble_worker.is_connected():
                return jsonify({"status": "failed", "message": "BLE not connected"}), 409
            if not self.magos:
                return jsonify({"status": "failed", "message": "Magos not initialized"}), 500

            data = request.get_json(silent=True) or {}
            servo_key = str(data.get("servo") or "").strip()
            mapping_lookup = {
                item["payload_key"]: item for item in self._action_group_servo_mapping()
            }
            mapping = mapping_lookup.get(servo_key)
            if not mapping:
                return jsonify({"status": "failed", "message": "Invalid servo key"}), 400

            try:
                target_angle = float(data.get("angle"))
            except (TypeError, ValueError):
                return jsonify({"status": "failed", "message": "Invalid angle"}), 400
            target_angle = int(round(max(0.0, min(180.0, target_angle))))

            sent_raw = self.magos.set_robot_server(mapping["command_index"], target_angle)
            if sent_raw is None:
                return jsonify({"status": "failed", "message": "Failed to send servo command"}), 500

            return jsonify(
                {
                    "status": "success",
                    "servo": servo_key,
                    "angle": target_angle,
                }
            )
        except Exception as e:
            print(f"Preview action group servo failed: {e}")
            return jsonify({"status": "failed", "message": str(e)}), 500

    def create_action_group(self):
        try:
            data = request.get_json(silent=True) or {}
            display_name = str(data.get("name") or "").strip()
            file_stem = self._sanitize_action_group_name(display_name)
            if not file_stem:
                return jsonify({"status": "failed", "message": "Action group name is required"}), 400

            registry = self._load_action_group_registry()
            registry_ids = {
                str(item.get("id") or "").strip()
                for item in registry.get("items", [])
                if isinstance(item, dict)
            }

            # BLE guard: action group creation requires an active BLE connection.
            ble_worker = getattr(getattr(self, "magos", None), "BLE_worker", None)
            if not ble_worker or not ble_worker.is_connected():
                return jsonify({"status": "failed", "message": "BLE not connected"}), 409

            servos = data.get("servos") or {}
            if not isinstance(servos, dict):
                return jsonify({"status": "failed", "message": "Invalid servos payload"}), 400

            try:
                duration = float(data.get("duration", 1.0))
            except (TypeError, ValueError):
                duration = 1.0
            duration = max(0.1, min(duration, 10.0))

            joint_angles = self._default_action_joint_angles()
            servo_mapping = self._action_group_servo_mapping()
            for item in servo_mapping:
                payload_key = item["payload_key"]
                clamp_key = item["clamp_key"]
                raw_index = item["raw_index"]
                if payload_key not in servos:
                    continue
                joint_angles[raw_index] = self._angle_to_raw_value(
                    clamp_key, servos.get(payload_key)
                )

            os.makedirs(self.actions_group_path, exist_ok=True)
            file_path = os.path.join(self.actions_group_path, f"{file_stem}.json")
            if os.path.exists(file_path) and file_stem not in registry_ids:
                return (
                    jsonify(
                        {
                            "status": "failed",
                            "message": "Action group name already exists",
                        }
                    ),
                    409,
                )

            action_name = display_name or file_stem
            payload = [
                {
                    "action_name": action_name,
                    "duration": duration,
                    "image_path": f"action_groups\\{file_stem}.png",
                    "joint_angles": joint_angles,
                    "switch_data": 1,
                    "sync": False,
                    "type": "motion",
                    "voice": "",
                }
            ]

            tmp_path = f"{file_path}.tmp.{uuid.uuid4().hex}"
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, indent=2)
            os.replace(tmp_path, file_path)
            self._upsert_user_action_group_registry(file_stem, action_name)

            self.LoadActionGroup()
            return jsonify(
                {
                    "status": "success",
                    "message": "Action group saved",
                    "name": action_name,
                    "filename": file_stem,
                }
            )
        except ValueError as e:
            return jsonify({"status": "failed", "message": str(e)}), 400
        except Exception as e:
            print(f"Create action group failed: {e}")
            return jsonify({"status": "failed", "message": str(e)}), 500

    def action_group_user_list(self):
        try:
            payload = self._load_action_group_registry()
            items = payload.get("items")
            if not isinstance(items, list):
                items = []

            normalized = []
            for item in items:
                if not isinstance(item, dict):
                    continue
                action_id = self._sanitize_action_group_name(item.get("id"))
                if not action_id:
                    continue
                display_name = str(item.get("name") or action_id).strip() or action_id
                try:
                    created_at = int(item.get("created_at") or 0)
                except (TypeError, ValueError):
                    created_at = 0
                normalized.append(
                    {"id": action_id, "name": display_name, "created_at": created_at}
                )

            normalized.sort(key=lambda x: int(x.get("created_at") or 0), reverse=True)
            return jsonify({"status": "success", "items": normalized})
        except Exception as e:
            print(f"Action group user list failed: {e}")
            return jsonify({"status": "failed", "message": str(e), "items": []}), 500

    def delete_action_group(self, action_id):
        try:
            normalized_id = self._sanitize_action_group_name(action_id)
            raw_id = str(action_id or "").strip()
            if not normalized_id or normalized_id != raw_id:
                return jsonify({"status": "failed", "message": "Invalid action id"}), 400

            registry = self._load_action_group_registry()
            registry_ids = {
                str(item.get("id") or "").strip()
                for item in registry.get("items", [])
                if isinstance(item, dict)
            }

            action_file_path = os.path.join(self.actions_group_path, f"{normalized_id}.json")
            if normalized_id not in registry_ids:
                if os.path.exists(action_file_path):
                    return (
                        jsonify(
                            {
                                "status": "failed",
                                "message": "Action group is read-only",
                            }
                        ),
                        403,
                    )
                return jsonify({"status": "failed", "message": "Action group not found"}), 404

            if os.path.exists(action_file_path):
                os.remove(action_file_path)

            self._remove_action_group_manifest_entry(normalized_id)
            self._remove_user_action_group_registry(normalized_id)
            self.LoadActionGroup()

            return jsonify(
                {
                    "status": "success",
                    "message": "Action group deleted",
                    "deleted": normalized_id,
                }
            )
        except Exception as e:
            print(f"Delete action group failed: {e}")
            return jsonify({"status": "failed", "message": str(e)}), 500

    def upsert_action_map(self):
        """Upsert multilingual action labels into static/data.json action_map."""
        try:
            data = request.get_json(silent=True) or {}
            action_key = str(data.get("action_key") or "").strip()
            labels = data.get("labels")

            if not action_key:
                return jsonify({"status": "failed", "message": "action_key is required"}), 400
            if not isinstance(labels, dict):
                return jsonify({"status": "failed", "message": "labels must be an object"}), 400

            normalized_labels = {}
            for lang in ("hans", "hant", "en"):
                if lang not in labels:
                    continue
                text = str(labels.get(lang) or "").strip()
                if text:
                    normalized_labels[lang] = text

            if not normalized_labels:
                return (
                    jsonify(
                        {
                            "status": "failed",
                            "message": "labels must include at least one non-empty value for hans/hant/en",
                        }
                    ),
                    400,
                )

            payload = self._load_music_manifest()
            if not isinstance(payload, dict):
                payload = {"music": []}

            if not isinstance(payload.get("music"), list):
                payload["music"] = []

            if not isinstance(payload.get("action_map"), dict):
                payload["action_map"] = {}

            existing = payload["action_map"].get(action_key)
            if not isinstance(existing, dict):
                existing = {}
            existing.update(normalized_labels)
            payload["action_map"][action_key] = existing

            self._save_music_manifest(payload)
            return jsonify(
                {
                    "status": "success",
                    "message": "action_map updated",
                    "action_key": action_key,
                    "labels": existing,
                }
            )
        except Exception as e:
            print(f"Upsert action_map failed: {e}")
            return jsonify({"status": "failed", "message": str(e)}), 500

    # region Shortcut Actions
    def _init_shortcut_actions_runtime(self):
        self.shortcut_repo = None
        self.shortcut_listener = None
        self._shortcut_stream_lock = threading.Lock()
        self._shortcut_stream_changed = threading.Condition(self._shortcut_stream_lock)
        self._shortcut_stream_version = 0
        init_error = ""
        store_path = ""
        try:
            self.shortcut_repo = ShortcutActionRepository(self.current_dir)
            store_path = getattr(self.shortcut_repo, "store_path", "")
        except Exception as e:
            init_error = str(e)
            self.shortcut_repo = None

        init_message = "Shortcut runtime ready" if not init_error else "Shortcut runtime disabled"
        self._shortcut_stream_payload = {
            "event_type": "init",
            "message": init_message,
            "error": init_error,
            "ts": time.time(),
        }
        self._shortcut_pending_events = {}
        self._shortcut_listener_status = {
            "enabled": False,
            "error": init_error,
            "permissions_hint": macos_accessibility_hint(),
            "store_path": store_path,
        }

    def _start_shortcut_listener(self):
        if not getattr(self, "shortcut_repo", None):
            return
        if getattr(self, "shortcut_listener", None):
            try:
                self.shortcut_listener.stop()
            except Exception:
                pass

        bindings = []
        for item in self.shortcut_repo.list_items():
            kb = item.key_binding if isinstance(item.key_binding, dict) else {}
            normalized = str(kb.get("normalized") or "").strip().lower()
            if normalized:
                bindings.append(normalized)

        self.shortcut_listener = GlobalShortcutListener(
            on_trigger=self._on_shortcut_binding_trigger
        )
        ok = self.shortcut_listener.start(bindings)
        self._shortcut_listener_status["enabled"] = bool(ok)
        self._shortcut_listener_status["error"] = (
            "" if ok else str(getattr(self.shortcut_listener, "last_error", "") or "")
        )
        self._emit_shortcut_event(
            {
                "event_type": "listener_status",
                "enabled": self._shortcut_listener_status["enabled"],
                "error": self._shortcut_listener_status["error"],
                "permissions_hint": self._shortcut_listener_status["permissions_hint"],
            }
        )

    def _refresh_shortcut_listener_bindings(self):
        if not getattr(self, "shortcut_listener", None):
            return
        if not getattr(self, "shortcut_repo", None):
            return
        bindings = []
        for item in self.shortcut_repo.list_items():
            kb = item.key_binding if isinstance(item.key_binding, dict) else {}
            normalized = str(kb.get("normalized") or "").strip().lower()
            if normalized:
                bindings.append(normalized)
        self.shortcut_listener.update_bindings(bindings)

    def _emit_shortcut_event(self, payload: dict):
        with self._shortcut_stream_changed:
            next_payload = dict(payload or {})
            next_payload["ts"] = time.time()
            self._shortcut_stream_payload = next_payload
            self._shortcut_stream_version += 1
            self._shortcut_stream_changed.notify_all()

    def _cleanup_shortcut_pending_events(self, now_ts=None):
        if now_ts is None:
            now_ts = time.time()
        expires = now_ts - 120.0
        stale_ids = [
            event_id
            for event_id, item in self._shortcut_pending_events.items()
            if float(item.get("created_at", 0.0)) < expires
        ]
        for event_id in stale_ids:
            self._shortcut_pending_events.pop(event_id, None)

    def _parse_actions_from_code(self, execution_code: str):
        lines = execution_code.splitlines()
        actions = []
        for line in lines:
            raw_line = str(line or "").strip()
            if not raw_line:
                continue
            if raw_line.startswith("#"):
                continue

            action_type = "python"
            label = raw_line

            m = re.search(r'magos\.animations_start\(["\'](.+?)["\']\)', raw_line)
            if m:
                action_type = "motion"
                label = f"动作组: {m.group(1)}"
            else:
                m = re.search(r'magos\.play_audio\(["\'](.+?)["\']\)', raw_line)
                if m:
                    action_type = "audio"
                    label = f"语音: {m.group(1)}"
                else:
                    m = re.search(
                        r'magos\.play_background_audio\(["\'](.+?)["\']\)', raw_line
                    )
                    if m:
                        action_type = "music"
                        label = f"背景音乐: {m.group(1)}"
                    elif "magos.stop_background_audio(" in raw_line:
                        action_type = "music"
                        label = "停止背景音乐"
                    else:
                        m = re.search(r"magos\.change_emoji\((.+?)\)", raw_line)
                        if m:
                            action_type = "emoji"
                            label = f"表情: {m.group(1)}"
                        else:
                            m = re.search(r"magos\.magos_time\((.+?)\)", raw_line)
                            if m:
                                action_type = "wait"
                                label = f"暂停: {m.group(1)}s"
                            else:
                                m = re.search(
                                    r'shortcut_action_start\(["\'](.+?)["\']\)',
                                    raw_line,
                                )
                                if m:
                                    action_type = "shortcut_ref"
                                    label = f"快捷键动作: {m.group(1)}"
            actions.append({"type": action_type, "label": label, "raw": raw_line})
            if len(actions) >= 200:
                break
        return actions

    def _serialize_shortcut_action(self, item, include_code=False):
        data = item.to_dict() if hasattr(item, "to_dict") else dict(item or {})
        if not include_code:
            data.pop("execution_code", None)
        return data

    def _on_shortcut_binding_trigger(self, normalized_binding: str):
        if not getattr(self, "shortcut_repo", None):
            return None
        shortcut = self.shortcut_repo.find_by_binding(normalized_binding)
        if not shortcut:
            return None

        status = str(getattr(self.task_manager, "status_code", "") or "").lower()
        if status in {"running", "paused"}:
            payload = {
                "event_type": "rejected_busy",
                "shortcut_id": shortcut.id,
                "shortcut_name": shortcut.name,
                "key_binding_display": shortcut.key_binding.get("display", ""),
                "message": "Robot is busy",
            }
            self._emit_shortcut_event(payload)
            return payload

        event_id = uuid.uuid4().hex
        with self._shortcut_stream_changed:
            self._cleanup_shortcut_pending_events()
            self._shortcut_pending_events[event_id] = {
                "event_id": event_id,
                "shortcut_id": shortcut.id,
                "created_at": time.time(),
            }

        payload = {
            "event_type": "trigger",
            "event_id": event_id,
            "shortcut_id": shortcut.id,
            "shortcut_name": shortcut.name,
            "key_binding_display": shortcut.key_binding.get("display", ""),
            "triggered_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        self._emit_shortcut_event(payload)
        return payload

    def _build_python_task_runner(
        self, code: str, source: str = "manual", root_shortcut_id: str = ""
    ):
        execution_code = str(code or "")
        root_sid = str(root_shortcut_id or "").strip()

        def run_code():
            output_lines = []
            result = {}
            call_stack = []
            if root_sid:
                call_stack.append(root_sid)

            def custom_print(*args, **kwargs):
                sep = kwargs.get("sep", " ")
                end = kwargs.get("end", "\n")
                if not self.task_manager.check_status():
                    raise SystemExit("Task stopped by user")
                output_lines.append(sep.join(map(str, args)) + end)

            class TimeWrapper:
                def __init__(self, original_time, task_mgr):
                    self._original_time = original_time
                    self._task_mgr = task_mgr

                def sleep(self, seconds):
                    if not self._task_mgr.smart_sleep(seconds):
                        raise SystemExit("Task stopped")

                def __getattr__(self, name):
                    return getattr(self._original_time, name)

            env = {
                "__builtins__": __builtins__,
                "print": custom_print,
                "magos": SlotMagosMap(getattr(self, "_magos_by_slot", {})),
                "time": TimeWrapper(time, self.task_manager),
            }

            def magos_parallel_wait_all(branch_functions):
                if not isinstance(branch_functions, (list, tuple)):
                    raise TypeError("magos_parallel_wait_all expects list/tuple")
                task_mgr = self.task_manager
                if not task_mgr.check_status():
                    raise SystemExit("Task stopped by user")

                errors = []
                err_lock = threading.Lock()

                class _ParallelBranchThread(threading.Thread):
                    def __init__(self, idx, fn):
                        super().__init__(daemon=True)
                        self.idx = idx
                        self.fn = fn

                    def run(self):
                        if not task_mgr.check_status():
                            return
                        try:
                            self.fn()
                        except SystemExit as e:
                            with err_lock:
                                errors.append(("stopped", self.idx, e))
                        except Exception as e:
                            with err_lock:
                                errors.append(("error", self.idx, e))

                threads = []
                for idx, fn in enumerate(branch_functions):
                    if not callable(fn):
                        raise TypeError(
                            f"magos_parallel_wait_all branch {idx} is not callable"
                        )
                    threads.append(_ParallelBranchThread(idx, fn))

                for t in threads:
                    if not task_mgr.check_status():
                        raise SystemExit("Task stopped by user")
                    t.start()
                for t in threads:
                    t.join()

                if errors:
                    for kind, _idx, err in errors:
                        if kind == "stopped":
                            raise SystemExit(str(err) or "Task stopped by user")
                    first = errors[0]
                    raise RuntimeError(
                        f"Parallel branch {first[1]} failed: {first[2]}"
                    )
                return True

            def shortcut_action_start(shortcut_id):
                sid = str(shortcut_id or "").strip()
                if not sid:
                    return
                if not getattr(self, "shortcut_repo", None):
                    raise RuntimeError("Shortcut runtime is not available")
                if sid in call_stack:
                    raise RuntimeError(f"Recursive shortcut action detected: {sid}")
                if not self.task_manager.check_status():
                    raise SystemExit("Task stopped by user")

                nested = self.shortcut_repo.get_item(sid)
                if not nested:
                    raise RuntimeError(f"Shortcut action not found: {sid}")

                call_stack.append(sid)
                try:
                    exec(nested.execution_code, env, result)
                finally:
                    call_stack.pop()

            env["shortcut_action_start"] = shortcut_action_start
            env["magos_parallel_wait_all"] = magos_parallel_wait_all

            try:
                exec(execution_code, env, result)
            except SystemExit:
                print(f"[{source}] code execution stopped by user")
            except Exception as e:
                print(f"[{source}] code execution error: {e}")

            return "".join(output_lines)

        return run_code

    def _run_python_code_task(
        self, code: str, source: str = "manual", root_shortcut_id: str = ""
    ):
        runner = self._build_python_task_runner(
            code=code, source=source, root_shortcut_id=root_shortcut_id
        )
        return self.task_manager.start_task(runner)

    def shortcut_actions_api(self):
        if not getattr(self, "shortcut_repo", None):
            return (
                jsonify(
                    {
                        "status": "failed",
                        "message": "Shortcut runtime is not available",
                        "listener": dict(getattr(self, "_shortcut_listener_status", {})),
                    }
                ),
                503,
            )
        if request.method == "GET":
            items = [
                self._serialize_shortcut_action(item, include_code=False)
                for item in self.shortcut_repo.list_items()
            ]
            return jsonify(
                {
                    "status": "success",
                    "items": items,
                    "listener": dict(self._shortcut_listener_status),
                }
            )

        data = request.get_json(silent=True) or {}
        name = str(data.get("name") or "").strip()
        key_binding = data.get("key_binding") or data.get("keyBinding") or {}
        execution_code = str(data.get("execution_code") or data.get("code") or "")
        actions = data.get("actions")

        if not isinstance(actions, list):
            actions = self._parse_actions_from_code(execution_code)

        try:
            item = self.shortcut_repo.create_item(
                name=name,
                key_binding=key_binding,
                actions=actions,
                execution_code=execution_code,
            )
            self._refresh_shortcut_listener_bindings()
            return jsonify(
                {
                    "status": "success",
                    "item": self._serialize_shortcut_action(item, include_code=False),
                }
            )
        except ValueError as e:
            msg = str(e)
            code = 409 if "already exists" in msg.lower() else 400
            return jsonify({"status": "failed", "message": msg}), code
        except Exception as e:
            return jsonify({"status": "failed", "message": str(e)}), 500

    def shortcut_action_delete_api(self, shortcut_id):
        if not getattr(self, "shortcut_repo", None):
            return jsonify({"status": "failed", "message": "Shortcut runtime is not available"}), 503
        deleted = self.shortcut_repo.delete_item(shortcut_id)
        if not deleted:
            return jsonify({"status": "failed", "message": "Shortcut action not found"}), 404
        self._refresh_shortcut_listener_bindings()
        return jsonify({"status": "success", "deleted": shortcut_id})

    def shortcut_actions_stream(self):
        wait_timeout_sec = 15

        def event_stream():
            last_version = -1
            while True:
                with self._shortcut_stream_changed:
                    if self._shortcut_stream_version == last_version:
                        self._shortcut_stream_changed.wait(timeout=wait_timeout_sec)
                    payload = dict(self._shortcut_stream_payload or {})
                    version = int(self._shortcut_stream_version)

                if version == last_version:
                    yield ": keep-alive\n\n"
                    continue

                last_version = version
                yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"

        return Response(
            event_stream(),
            mimetype="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    def shortcut_actions_confirm(self):
        if not getattr(self, "shortcut_repo", None):
            return jsonify({"status": "failed", "message": "Shortcut runtime is not available"}), 503
        data = request.get_json(silent=True) or {}
        event_id = str(data.get("event_id") or "").strip()
        confirm = bool(data.get("confirm"))
        if not event_id:
            return jsonify({"status": "failed", "message": "event_id is required"}), 400

        with self._shortcut_stream_changed:
            self._cleanup_shortcut_pending_events()
            pending = self._shortcut_pending_events.pop(event_id, None)

        if not pending:
            return jsonify({"status": "failed", "message": "Pending event not found"}), 404

        shortcut_id = str(pending.get("shortcut_id") or "")
        shortcut = self.shortcut_repo.get_item(shortcut_id)
        if not shortcut:
            return jsonify({"status": "failed", "message": "Shortcut action not found"}), 404

        if not confirm:
            self._emit_shortcut_event(
                {
                    "event_type": "canceled",
                    "event_id": event_id,
                    "shortcut_id": shortcut.id,
                    "shortcut_name": shortcut.name,
                }
            )
            return jsonify({"status": "success", "message": "Canceled"})

        status = str(getattr(self.task_manager, "status_code", "") or "").lower()
        if status in {"running", "paused"}:
            self._emit_shortcut_event(
                {
                    "event_type": "rejected_busy",
                    "event_id": event_id,
                    "shortcut_id": shortcut.id,
                    "shortcut_name": shortcut.name,
                }
            )
            return jsonify({"status": "failed", "message": "Robot is busy"}), 409

        started = self._run_python_code_task(
            code=shortcut.execution_code,
            source=f"shortcut:{shortcut.id}",
            root_shortcut_id=shortcut.id,
        )
        if not started:
            return jsonify({"status": "failed", "message": "Failed to start shortcut task"}), 500

        self._emit_shortcut_event(
            {
                "event_type": "executed",
                "event_id": event_id,
                "shortcut_id": shortcut.id,
                "shortcut_name": shortcut.name,
            }
        )
        return jsonify({"status": "success", "message": "Shortcut action started"})

    def shortcut_actions_trigger(self):
        if not getattr(self, "shortcut_repo", None):
            return jsonify({"status": "failed", "message": "Shortcut runtime is not available"}), 503

        data = request.get_json(silent=True) or {}
        raw_binding = (
            data.get("normalized")
            or data.get("binding")
            or data.get("key_binding")
            or data.get("keyBinding")
            or ""
        )
        try:
            normalized = normalize_key_binding(raw_binding).get("normalized", "")
        except Exception as e:
            return jsonify({"status": "failed", "message": str(e)}), 400

        payload = self._on_shortcut_binding_trigger(normalized)
        if not payload:
            return jsonify({"status": "failed", "message": "Shortcut action not found"}), 404
        return jsonify({"status": "success", "event": payload})

    # endregion

    # comment fixed
    def VoicePlay(self):
        try:
            voice = request.data.decode("utf-8")
            print(voice)
            self.magos.play_audio(voice)
            return "True"
        except Exception as e:
            print("VoicePlay error:", e)

    # region Device Music Sync Runtime
    def _init_music_sync_runtime(self):
        self._music_sync_lock = threading.Lock()
        self._music_sync_changed = threading.Condition(self._music_sync_lock)
        self._music_sync_version = 0
        self._music_sync_watchdog = None
        self._music_sync_timeout_sec = 10.0
        self._music_sync_state = {
            "sync_session_id": "",
            "sync_state": "idle",
            "slot": "A",
            "message": "",
            "error": None,
            "updated_at": 0.0,
        }

    def _bind_ble_callbacks(self):
        handles = getattr(self, "_ble_handles", None)
        if handles:
            for slot_id, h in handles.items():
                if h is not None:
                    h.music_update_callback = (
                        lambda payload, _slot=slot_id: self._on_ble_music_update(_slot, payload)
                    )
        elif getattr(self, "BLE_Handle", None):
            self.BLE_Handle.music_update_callback = (
                lambda payload: self._on_ble_music_update("A", payload)
            )

    def _get_music_sync_snapshot(self):
        with self._music_sync_changed:
            snapshot = dict(self._music_sync_state)
            snapshot["version"] = self._music_sync_version
            return snapshot

    def _emit_music_sync_state(
        self,
        sync_state=None,
        message=None,
        error=None,
        sync_session_id=None,
        slot=None,
        ensure_session=False,
    ):
        with self._music_sync_changed:
            changed = False
            target_state = None
            if sync_session_id is not None:
                next_id = str(sync_session_id or "")
                if next_id != self._music_sync_state.get("sync_session_id"):
                    self._music_sync_state["sync_session_id"] = next_id
                    changed = True
            elif ensure_session and not self._music_sync_state.get("sync_session_id"):
                self._music_sync_state["sync_session_id"] = uuid.uuid4().hex
                changed = True

            if sync_state is not None:
                next_state = str(sync_state or "idle").strip().lower() or "idle"
                target_state = next_state
                if next_state != self._music_sync_state.get("sync_state"):
                    self._music_sync_state["sync_state"] = next_state
                    changed = True

            if slot is not None:
                next_slot = self._normalize_robot_slot(slot, "A")
                if next_slot != self._music_sync_state.get("slot"):
                    self._music_sync_state["slot"] = next_slot
                    changed = True

            if message is not None:
                next_msg = str(message)
                if next_msg != self._music_sync_state.get("message"):
                    self._music_sync_state["message"] = next_msg
                    changed = True

            if error is not None:
                next_error = str(error) if error else None
                if next_error != self._music_sync_state.get("error"):
                    self._music_sync_state["error"] = next_error
                    changed = True
            elif sync_state is not None and str(sync_state).lower() != "error":
                if self._music_sync_state.get("error") is not None:
                    self._music_sync_state["error"] = None
                    changed = True

            if changed:
                self._music_sync_state["updated_at"] = time.time()
                self._music_sync_version += 1
                self._music_sync_changed.notify_all()

            if target_state in {"done", "error", "idle"}:
                self._cancel_music_sync_watchdog_locked()

            return dict(self._music_sync_state)

    def _begin_music_sync_session(self, message="requesting device music sync", slot="A"):
        sync_session_id = uuid.uuid4().hex
        self._emit_music_sync_state(
            sync_state="syncing",
            message=str(message),
            error=None,
            sync_session_id=sync_session_id,
            slot=slot,
            ensure_session=True,
        )
        with self._music_sync_changed:
            self._schedule_music_sync_watchdog_locked(sync_session_id)
        return sync_session_id

    def _cancel_music_sync_watchdog_locked(self):
        if self._music_sync_watchdog is not None:
            try:
                self._music_sync_watchdog.cancel()
            except Exception:
                pass
            self._music_sync_watchdog = None

    def _schedule_music_sync_watchdog_locked(self, sync_session_id: str):
        self._cancel_music_sync_watchdog_locked()
        session_id = str(sync_session_id or "")
        if not session_id:
            return
        timeout_sec = max(3.0, float(getattr(self, "_music_sync_timeout_sec", 10.0)))
        timer = threading.Timer(
            timeout_sec,
            lambda: self._music_sync_watchdog_fire(session_id),
        )
        timer.daemon = True
        self._music_sync_watchdog = timer
        timer.start()

    def _music_sync_watchdog_fire(self, sync_session_id: str):
        with self._music_sync_changed:
            current_session_id = str(self._music_sync_state.get("sync_session_id") or "")
            current_state = str(self._music_sync_state.get("sync_state") or "idle").lower()
            if current_state != "syncing" or current_session_id != str(sync_session_id or ""):
                return
        self._emit_music_sync_state(
            sync_state="error",
            message="device music sync timeout",
            error="music sync timeout",
            sync_session_id=sync_session_id,
            ensure_session=True,
        )

    def _refresh_music_sync_watchdog(self):
        with self._music_sync_changed:
            sync_session_id = str(self._music_sync_state.get("sync_session_id") or "")
            sync_state = str(self._music_sync_state.get("sync_state") or "idle").lower()
            if sync_session_id and sync_state == "syncing":
                self._schedule_music_sync_watchdog_locked(sync_session_id)

    def _on_ble_music_update(self, slot_id, payload):
        resolved_slot = self._normalize_robot_slot(slot_id, "A")
        event_name = ""
        if isinstance(payload, dict):
            event_name = str(payload.get("event") or "").strip().lower()
            payload_slot = str(payload.get("slot") or "").strip().upper()
            if payload_slot:
                resolved_slot = self._normalize_robot_slot(payload_slot, resolved_slot)
        elif isinstance(payload, list):
            event_name = "music_sync_progress"
        else:
            event_name = "music_sync_progress"

        if event_name in {"music_sync_start"}:
            self._emit_music_sync_state(
                sync_state="syncing",
                message="device music sync started",
                error=None,
                slot=resolved_slot,
                ensure_session=True,
            )
            self._refresh_music_sync_watchdog()
            return

        if event_name in {"music_sync_progress"}:
            count = 0
            if isinstance(payload, dict):
                try:
                    count = int(payload.get("count") or 0)
                except Exception:
                    count = 0
            self._emit_music_sync_state(
                sync_state="syncing",
                message=f"syncing songs: {max(0, count)}",
                error=None,
                slot=resolved_slot,
                ensure_session=True,
            )
            self._refresh_music_sync_watchdog()
            return

        if event_name in {"music_sync_done"}:
            count = 0
            if isinstance(payload, dict):
                try:
                    count = int(payload.get("count") or 0)
                except Exception:
                    count = 0
            self._emit_music_sync_state(
                sync_state="done",
                message=f"device music sync done: {max(0, count)} songs",
                error=None,
                slot=resolved_slot,
                ensure_session=True,
            )
            return

        if event_name in {"music_sync_error"}:
            error_text = ""
            if isinstance(payload, dict):
                error_text = str(payload.get("error") or "")
            self._emit_music_sync_state(
                sync_state="error",
                message="device music sync failed",
                error=error_text or "music sync error",
                slot=resolved_slot,
                ensure_session=True,
            )
            return

        self._emit_music_sync_state(
            sync_state="syncing",
            message="device music sync updating",
            error=None,
            slot=resolved_slot,
            ensure_session=True,
        )
        self._refresh_music_sync_watchdog()
    # endregion

    def _music_data_json_path(self):
        return os.path.join(self.current_dir, "static", "data.json")

    def _music_slot_from_request(self, payload=None, default="A"):
        body = payload if isinstance(payload, dict) else {}
        raw_slot = (
            body.get("slot")
            or request.args.get("slot")
            or request.form.get("slot")
        )
        return self._normalize_robot_slot(raw_slot, default)

    def _ensure_manifest_slot_lists(self, payload):
        payload = payload if isinstance(payload, dict) else {}
        music_by_slot = payload.get("music_by_slot")
        if not isinstance(music_by_slot, dict):
            music_by_slot = {}

        normalized_map = {}
        for key, value in music_by_slot.items():
            slot = self._normalize_robot_slot(key, "")
            if not slot:
                continue
            normalized_map[slot] = value if isinstance(value, list) else []

        legacy_music = payload.get("music", [])
        if not isinstance(legacy_music, list):
            legacy_music = []

        if "A" not in normalized_map and legacy_music:
            # 兼容旧格式：默认把顶层 music 视为 A 槽数据。
            normalized_map["A"] = [dict(item) for item in legacy_music if isinstance(item, dict)]

        payload["music_by_slot"] = normalized_map
        payload["music"] = list(normalized_map.get("A", []))
        return payload

    def _get_music_list_for_slot(self, payload, slot):
        manifest = self._ensure_manifest_slot_lists(payload)
        slot_id = self._normalize_robot_slot(slot, "A")
        music_by_slot = manifest.get("music_by_slot") or {}
        music_list = music_by_slot.get(slot_id, [])
        return list(music_list) if isinstance(music_list, list) else []

    def _set_music_list_for_slot(self, payload, slot, music_list):
        manifest = self._ensure_manifest_slot_lists(payload)
        slot_id = self._normalize_robot_slot(slot, "A")
        safe_music_list = music_list if isinstance(music_list, list) else []
        manifest["music_by_slot"][slot_id] = safe_music_list
        manifest["music"] = list(manifest["music_by_slot"].get("A", []))
        return manifest

    def _music_static_dir(self):
        return os.path.join(self.current_dir, "static")

    def _music_version(self):
        data_json_path = self._music_data_json_path()
        try:
            if os.path.exists(data_json_path):
                return int(os.path.getmtime(data_json_path) * 1000)
        except Exception:
            pass
        return int(time.time() * 1000)

    def _normalize_music_name(self, name: str) -> str:
        raw = str(name or "").strip()
        if not raw:
            return ""
        base = os.path.basename(raw)
        stem, _ = os.path.splitext(base)
        normalized = (stem or base).strip()
        normalized = re.sub(r"\s+", " ", normalized)
        return normalized

    def _resolve_uploaded_file_size(self, file_storage):
        try:
            stream = getattr(file_storage, "stream", None)
            if stream is None:
                return None
            current_pos = stream.tell()
            stream.seek(0, os.SEEK_END)
            size = stream.tell()
            stream.seek(current_pos, os.SEEK_SET)
            return int(size)
        except Exception:
            try:
                size = int(getattr(file_storage, "content_length", 0) or 0)
                if size > 0:
                    return size
            except Exception:
                pass
        return None

    def _load_music_manifest(self):
        data_json_path = self._music_data_json_path()
        with self._music_manifest_lock:
            if not os.path.exists(data_json_path):
                return self._ensure_manifest_slot_lists({"music": []})

            with open(data_json_path, "r", encoding="utf-8") as f:
                try:
                    payload = json.load(f)
                except json.JSONDecodeError:
                    payload = {"music": []}

        if isinstance(payload, list):
            payload = {"music": payload}
        if not isinstance(payload, dict):
            payload = {"music": []}
        return self._ensure_manifest_slot_lists(payload)

    def _save_music_manifest(self, payload):
        data_json_path = self._music_data_json_path()
        normalized = self._ensure_manifest_slot_lists(payload)
        with self._music_manifest_lock:
            os.makedirs(os.path.dirname(data_json_path), exist_ok=True)
            tmp_path = f"{data_json_path}.tmp.{int(time.time() * 1000)}"
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(normalized, f, ensure_ascii=False, indent=4)
            os.replace(tmp_path, data_json_path)

    def _remove_music_file_by_url(self, music_url: str):
        if not music_url:
            return
        filename = secure_filename(os.path.basename(str(music_url)))
        if not filename:
            return
        file_path = os.path.join(self._music_static_dir(), filename)
        if os.path.exists(file_path):
            try:
                os.remove(file_path)
                print(f"[Music] Removed file: {file_path}")
            except Exception as e:
                print(f"[Music] Failed removing file {file_path}: {e}")

    def _remove_music_file_by_path(self, file_path: str):
        path = str(file_path or "").strip()
        if not path:
            return
        if os.path.exists(path):
            try:
                os.remove(path)
                print(f"[Music] Removed file: {path}")
            except Exception as e:
                print(f"[Music] Failed removing file {path}: {e}")

    def _find_music_index_by_name(self, music_list, target_name: str):
        target = self._normalize_music_name(target_name).lower()
        if not target:
            return -1
        for idx, item in enumerate(music_list):
            if not isinstance(item, dict):
                continue
            name_norm = self._normalize_music_name(item.get("name", "")).lower()
            if name_norm == target:
                return idx
        return -1

    def get_music_data(self):
        slot = self._music_slot_from_request(default="A")
        payload = self._load_music_manifest()
        sync_snapshot = self._get_music_sync_snapshot()
        sync_slot = self._normalize_robot_slot(sync_snapshot.get("slot"), "A")
        sync_state = "idle"
        sync_session_id = ""
        if slot == sync_slot:
            sync_state = str(sync_snapshot.get("sync_state") or "idle")
            sync_session_id = str(sync_snapshot.get("sync_session_id") or "")
        music_items = self._get_music_list_for_slot(payload, slot)
        response = jsonify(
            {
                "code": 200,
                "slot": slot,
                "music": music_items,
                "music_version": self._music_version(),
                "sync_state": sync_state,
                "sync_session_id": sync_session_id,
            }
        )
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        return response

    def music_sync_now(self):
        try:
            payload = request.get_json(silent=True) or {}
            slot = self._music_slot_from_request(payload=payload, default="A")
            mag = self._magos_by_slot.get(slot) or self.magos
            if not mag or not mag.BLE_worker:
                return jsonify({"code": 500, "msg": "BLE worker not initialized"}), 500

            if not mag.BLE_worker.is_connected():
                return jsonify({"code": 409, "msg": "Robot not connected"}), 409

            sync_session_id = self._begin_music_sync_session(
                "requesting device music sync",
                slot=slot,
            )
            mag.BLE_worker.request_music_sync()
            snapshot = self._get_music_sync_snapshot()
            return jsonify(
                {
                    "code": 200,
                    "slot": slot,
                    "sync_session_id": sync_session_id,
                    "sync_state": snapshot.get("sync_state", "syncing"),
                    "message": snapshot.get("message", "syncing"),
                }
            )
        except Exception as e:
            self._emit_music_sync_state(
                sync_state="error",
                message="request sync failed",
                error=str(e),
                ensure_session=True,
            )
            return jsonify({"code": 500, "msg": str(e)}), 500

    def play_music_by_name(self):
        try:
            data = request.get_json(silent=True) or {}
            slot = self._music_slot_from_request(payload=data, default="A")
            mag = self._magos_by_slot.get(slot) or self.magos
            if "index" in data:
                return jsonify({"code": 400, "msg": "index 参数已废弃，请使用 name"}), 400
            song_name = str(data.get("name") or "").strip()
            if not song_name:
                return jsonify({"code": 400, "msg": "缺少 name"}), 400

            manifest = self._load_music_manifest()
            music_list = self._get_music_list_for_slot(manifest, slot)
            idx = self._find_music_index_by_name(music_list, song_name)
            if idx < 0:
                return jsonify({"code": 404, "msg": f"未找到歌曲: {song_name}"}), 404

            item = music_list[idx] if idx < len(music_list) else {}
            play_name = str(item.get("name") or song_name).strip()
            mag.play_background_audio(play_name)
            return jsonify(
                {
                    "code": 200,
                    "msg": "播放成功",
                    "slot": slot,
                    "name": play_name,
                }
            )
        except ValueError as e:
            return jsonify({"code": 400, "msg": str(e)}), 400
        except Exception as e:
            print(f"播放接口异常: {e}")
            return jsonify({"code": 500, "msg": str(e)}), 500

    def pause_music(self):
        try:
            result = self._stop_music_on_connected_slots()
            if result["failed_slots"]:
                return (
                    jsonify(
                        {
                            "code": 500,
                            "msg": "部分机位停止失败",
                            "stopped_slots": result["success_slots"],
                            "skipped_slots": result["skipped_slots"],
                            "failed_slots": result["failed_slots"],
                        }
                    ),
                    500,
                )
            return jsonify(
                {
                    "code": 200,
                    "msg": "暂停成功",
                    "stopped_slots": result["success_slots"],
                    "skipped_slots": result["skipped_slots"],
                }
            )
        except Exception as e:
            print(f"暂停接口异常: {e}")
            return jsonify({"code": 500, "msg": str(e)}), 500

    def upload_music(self):
        max_bytes = int(self.MAX_MUSIC_UPLOAD_BYTES)
        content_length = request.content_length
        if (
            isinstance(content_length, int)
            and content_length > max_bytes + int(self.MAX_MUSIC_UPLOAD_FORM_OVERHEAD_BYTES)
        ):
            return jsonify({"code": 413, "msg": "MP3 file must be <= 10MB"}), 413

        if "file" not in request.files:
            return jsonify({"code": 400, "msg": "No file found"}), 400

        file = request.files["file"]
        if file.filename == "":
            return jsonify({"code": 400, "msg": "Filename is empty"}), 400
        filename = str(file.filename or "").strip()
        if not filename.lower().endswith(".mp3"):
            return jsonify({"code": 400, "msg": "Only MP3 format is supported"}), 400

        file_size = self._resolve_uploaded_file_size(file)
        if file_size is not None and int(file_size) > max_bytes:
            return jsonify({"code": 413, "msg": "MP3 file must be <= 10MB"}), 413

        slot = self._music_slot_from_request(default="A")
        requested_name = request.form.get("name", "")
        fallback_name = os.path.splitext(os.path.basename(file.filename))[0]
        music_name = (
            self._normalize_music_name(requested_name)
            or self._normalize_music_name(fallback_name)
            or "unnamed_music"
        )

        filename = secure_filename(file.filename)
        unique_filename = f"{int(time.time())}_{filename}"
        music_folder = self._music_static_dir()
        save_path = os.path.join(music_folder, unique_filename)
        os.makedirs(music_folder, exist_ok=True)
        file.save(save_path)

        new_music_entry = {
            "name": music_name,
            "url": f"./static/{unique_filename}",
        }

        try:
            transfer_id = ""
            stage = "queued"
            device_message = "queued"
            music_version = self._music_version()
            remote_name = f"{music_name}.mp3"

            ble_controller = self._ble_handles.get(slot) or self.BLE_Handle
            transfer_id = self.music_transfer_manager.start_transfer(
                file_path=save_path,
                remote_name=remote_name,
                ble_controller=ble_controller,
                loop=self.loop,
                postprocess_callback=self._music_upload_postprocess_callback,
                postprocess_context={
                    "slot": slot,
                    "music_name": new_music_entry["name"],
                    "music_url": new_music_entry["url"],
                    "save_path": save_path,
                },
            )
            transfer_status = self.music_transfer_manager.get_status(transfer_id)
            if transfer_status:
                stage = str(transfer_status.get("transfer_status") or "queued")
                device_message = str(transfer_status.get("device_message") or "queued")
                try:
                    status_version = int(transfer_status.get("music_version") or 0)
                    if status_version > 0:
                        music_version = status_version
                except Exception:
                    pass

            return jsonify(
                {
                    "code": 200,
                    "msg": "Upload accepted",
                    "slot": slot,
                    "name": new_music_entry["name"],
                    "url": new_music_entry["url"],
                    "mode": "pending",
                    "data": new_music_entry,
                    "transfer_id": transfer_id,
                    "stage": stage,
                    "device_message": device_message,
                    "music_version": music_version,
                }
            )
        except Exception as e:
            self._remove_music_file_by_path(save_path)
            return jsonify({"code": 500, "msg": f"Upload start failed: {str(e)}"}), 500

    def delete_music(self):
        try:
            data = request.get_json(silent=True) or {}
            slot = self._music_slot_from_request(payload=data, default="A")
            mag = self._magos_by_slot.get(slot) or self.magos

            raw_names = []
            if isinstance(data.get("name"), str):
                raw_names.append(data.get("name"))
            if isinstance(data.get("names"), list):
                raw_names.extend([item for item in data.get("names") if isinstance(item, str)])

            target_name_keys = {
                self._normalize_music_name(name).lower()
                for name in raw_names
                if self._normalize_music_name(name)
            }

            target_urls = set()
            if isinstance(data.get("url"), str) and data.get("url").strip():
                target_urls.add(data.get("url").strip())
            if isinstance(data.get("files_to_delete"), list):
                target_urls.update(
                    str(item).strip()
                    for item in data.get("files_to_delete")
                    if str(item).strip()
                )

            if not target_name_keys and not target_urls:
                return jsonify({"code": 400, "msg": "参数错误: 缺少 name/names/url/files_to_delete"}), 400

            target_basenames = {secure_filename(os.path.basename(url)) for url in target_urls if url}

            manifest = self._load_music_manifest()
            music_list = self._get_music_list_for_slot(manifest, slot)

            kept = []
            matched_items = []
            for item in music_list:
                if not isinstance(item, dict):
                    continue
                item_name = str(item.get("name") or "")
                item_url = str(item.get("url") or "").strip()
                item_key = self._normalize_music_name(item_name).lower()
                item_base = secure_filename(os.path.basename(item_url))

                matched = False
                if item_key and item_key in target_name_keys:
                    matched = True
                elif item_url and item_url in target_urls:
                    matched = True
                elif item_base and item_base in target_basenames:
                    matched = True

                if matched:
                    matched_items.append(item)
                else:
                    kept.append(item)

            if not matched_items:
                return jsonify({"code": 404, "msg": "未找到要删除的歌曲"}), 404

            device_delete_names = []
            seen_device_keys = set()
            for item in matched_items:
                item_name = self._normalize_music_name(item.get("name", ""))
                if not item_name:
                    item_url = str(item.get("url") or "")
                    item_name = self._normalize_music_name(os.path.basename(item_url))
                name_key = item_name.lower()
                if not item_name or not name_key or name_key in seen_device_keys:
                    continue
                seen_device_keys.add(name_key)
                device_delete_names.append(item_name)

            if not device_delete_names:
                return jsonify({"code": 400, "msg": "删除失败: 缺少有效歌曲名"}), 400

            device_deleted = []
            device_dispatch_errors = []

            for music_name in device_delete_names:
                try:
                    # "发送即成功"策略：仅下发删除命令，不阻塞等待设备ACK。
                    mag.delete_background_audio(music_name, wait_ack=False)
                    device_deleted.append(music_name)
                except Exception as device_exc:
                    device_dispatch_errors.append(
                        {"name": music_name, "error": str(device_exc)}
                    )
                    print(
                        f"[Music] Device delete dispatch failed for {music_name}: {device_exc}"
                    )

            manifest = self._set_music_list_for_slot(manifest, slot, kept)
            self._save_music_manifest(manifest)

            for item in matched_items:
                self._remove_music_file_by_url(item.get("url", ""))

            return jsonify(
                {
                    "code": 200,
                    "msg": "删除成功",
                    "slot": slot,
                    "removed_count": len(matched_items),
                    "removed_names": [str(item.get("name") or "") for item in matched_items],
                    "device_deleted": device_deleted,
                    "device_dispatch": "dispatch_error" if device_dispatch_errors else "sent",
                    "failed_device_names": [str(item.get("name") or "") for item in device_dispatch_errors],
                    "device_dispatch_errors": device_dispatch_errors,
                }
            )
        except Exception as e:
            print(f"删除接口异常: {e}")
            return jsonify({"code": 500, "msg": str(e)}), 500

    # region Music Upload API
    def _init_music_upload_runtime(self):
        self.music_transfer_manager = MusicTransferManager.MusicTransferManager()

    def _music_upload_postprocess_callback(self, transfer_id, stage, status, context):
        status = status if isinstance(status, dict) else {}
        context = context if isinstance(context, dict) else {}
        slot = self._normalize_robot_slot(context.get("slot"), "A")
        music_name = self._normalize_music_name(context.get("music_name"))
        music_url = str(context.get("music_url") or "").strip()
        save_path = str(context.get("save_path") or "").strip()

        if str(stage or "").lower() != "done":
            if save_path:
                self._remove_music_file_by_path(save_path)
            return {"ok": True, "message": "Music transfer failed", "error": str(status.get("error") or "")}

        if not music_name or not music_url:
            if save_path:
                self._remove_music_file_by_path(save_path)
            return {"ok": False, "message": "Music transfer post-process failed", "error": "Missing music name/url"}

        try:
            manifest = self._load_music_manifest()
            music_list = self._get_music_list_for_slot(manifest, slot)

            new_music_entry = {"name": music_name, "url": music_url}
            existing_idx = self._find_music_index_by_name(music_list, music_name)
            mode = "append"
            if existing_idx >= 0:
                old_entry = music_list[existing_idx] if existing_idx < len(music_list) else {}
                old_url = str((old_entry or {}).get("url") or "")
                music_list[existing_idx] = new_music_entry
                mode = "replace"
                if old_url and old_url != music_url:
                    self._remove_music_file_by_url(old_url)
            else:
                music_list.append(new_music_entry)

            manifest = self._set_music_list_for_slot(manifest, slot, music_list)
            self._save_music_manifest(manifest)
            music_version = self._music_version()
            return {
                "ok": True,
                "message": f"Music transfer completed ({mode})",
                "music_version": music_version,
            }
        except Exception as e:
            if save_path:
                self._remove_music_file_by_path(save_path)
            return {
                "ok": False,
                "message": "Music transfer post-process failed",
                "error": str(e),
            }

    def _normalize_music_upload_stage(self, stage):
        value = str(stage or "").strip().lower()
        if value in {"done", "success"}:
            return "done"
        if value in {"error", "failed"}:
            return "error"
        if value in {"transferring", "uploading"}:
            return "transferring"
        if value in {"queued", "waiting"}:
            return "queued"
        if value in {"uploading_local"}:
            return "uploading_local"
        return "queued"

    def _music_upload_payload_from_status(self, status):
        stage = self._normalize_music_upload_stage(status.get("transfer_status"))

        try:
            device_progress = float(status.get("progress", 0.0))
        except (TypeError, ValueError):
            device_progress = 0.0
        device_progress = max(0.0, min(100.0, device_progress))

        local_progress = 100.0
        if stage == "uploading_local":
            try:
                local_progress = float(status.get("local_progress", 0.0))
            except (TypeError, ValueError):
                local_progress = 0.0
            local_progress = max(0.0, min(100.0, local_progress))

        if stage == "done":
            local_progress = 100.0
            device_progress = 100.0

        overall_progress = (local_progress * 0.3) + (device_progress * 0.7)
        overall_progress = max(0.0, min(100.0, overall_progress))
        if stage == "done":
            overall_progress = 100.0

        try:
            music_version = int(status.get("music_version") or 0)
        except Exception:
            music_version = 0

        return {
            "transfer_id": str(status.get("transfer_id") or ""),
            "stage": stage,
            "local_progress": round(local_progress, 1),
            "device_progress": round(device_progress, 1),
            "overall_progress": round(overall_progress, 1),
            "message": str(status.get("device_message") or stage),
            "error": str(status.get("error") or ""),
            "music_version": music_version,
        }

    def music_upload_status(self, transfer_id):
        transfer_id = str(transfer_id or "").strip()
        if not transfer_id:
            return jsonify({"code": 400, "msg": "transfer_id is required"}), 400

        status = self.music_transfer_manager.get_status(transfer_id)
        if not status:
            return jsonify({"code": 404, "msg": "transfer not found"}), 404

        return jsonify({"code": 200, **self._music_upload_payload_from_status(status)})

    def music_upload_stream(self):
        transfer_id = str(request.args.get("transfer_id") or "").strip()
        if not transfer_id:
            return jsonify({"code": 400, "msg": "transfer_id is required"}), 400

        wait_timeout_sec = 15.0

        def event_stream():
            last_payload = None
            while True:
                status = self.music_transfer_manager.get_status(transfer_id)
                if not status:
                    not_found_payload = {
                        "transfer_id": transfer_id,
                        "stage": "error",
                        "local_progress": 0.0,
                        "device_progress": 0.0,
                        "overall_progress": 0.0,
                        "message": "transfer not found",
                        "error": "transfer not found",
                    }
                    if last_payload != not_found_payload:
                        yield f"data: {json.dumps(not_found_payload, ensure_ascii=False)}\n\n"
                    break

                payload = self._music_upload_payload_from_status(status)
                if payload != last_payload:
                    last_payload = payload
                    yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"

                if payload.get("stage") in {"done", "error"}:
                    break

                updated = self.music_transfer_manager.wait_for_update(timeout=wait_timeout_sec)
                if not updated:
                    yield ": keep-alive\n\n"

        return Response(
            event_stream(),
            mimetype="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    # region OTA API
    def _init_ota_runtime(self):
        self.ota_service = OTAService.OTAService(self.BLE_worker)
        self._ota_state_lock = threading.Lock()
        self._ota_state_changed = threading.Condition(self._ota_state_lock)
        self._ota_state_version = 0
        self._ota_state = {
            "ota_session_id": "",
            "ota_started_at": 0.0,
            "ota_status": "idle",
            "ota_progress": 0.0,
            "ota_message": "",
            "ota_error": None,
            "ota_target_slot": "A",
        }

    def _is_ota_running_status(self, status):
        return str(status or "").lower() in {"starting", "downloading", "transferring"}

    def _normalize_ota_status(self, status, progress):
        raw_status = str(status or "").strip().lower()
        try:
            progress_val = float(progress)
        except (TypeError, ValueError):
            progress_val = 0.0

        if raw_status in {"done", "success"}:
            return "done"
        if raw_status in {"error", "failed"}:
            return "error"
        if raw_status in {"transferring", "uploading"}:
            return "transferring"
        if raw_status in {"downloading"}:
            return "downloading"
        if raw_status in {"starting"}:
            return "starting"
        if raw_status in {"running"}:
            if progress_val >= 40:
                return "transferring"
            if progress_val > 0:
                return "downloading"
            return "starting"
        return "starting"

    def _begin_ota_session(
        self,
        initial_status="starting",
        message="Initializing",
        reject_if_running=False,
        target_slot="A",
    ):
        with self._ota_state_changed:
            current_status = self._ota_state.get("ota_status", "idle")
            if reject_if_running and self._is_ota_running_status(current_status):
                return None

            session_id = uuid.uuid4().hex
            self._ota_state = {
                "ota_session_id": session_id,
                "ota_started_at": time.time(),
                "ota_status": self._normalize_ota_status(initial_status, 0),
                "ota_progress": 0.0,
                "ota_message": str(message or "Initializing"),
                "ota_error": None,
                "ota_target_slot": self._normalize_robot_slot(target_slot, "A"),
            }
            self._ota_state_version += 1
            self._ota_state_changed.notify_all()
            return session_id

    def _get_ota_snapshot(self):
        with self._ota_state_changed:
            snapshot = dict(self._ota_state)
            snapshot["version"] = self._ota_state_version
            return snapshot

    def _emit_ota_state(self, session_id, progress=None, status=None, message=None, error=None):
        with self._ota_state_changed:
            if session_id != self._ota_state.get("ota_session_id"):
                return False

            changed = False

            if progress is not None:
                try:
                    progress_value = float(progress)
                except (TypeError, ValueError):
                    progress_value = float(self._ota_state.get("ota_progress", 0.0))
                progress_value = max(0.0, min(100.0, progress_value))
                if progress_value != self._ota_state.get("ota_progress"):
                    self._ota_state["ota_progress"] = progress_value
                    changed = True

            if status is not None:
                normalized_status = self._normalize_ota_status(
                    status, self._ota_state.get("ota_progress", 0.0)
                )
                if normalized_status == "done" and progress is None:
                    self._ota_state["ota_progress"] = 100.0
                    changed = True
                if normalized_status != self._ota_state.get("ota_status"):
                    self._ota_state["ota_status"] = normalized_status
                    changed = True

            if message is not None:
                message_text = str(message)
                if message_text != self._ota_state.get("ota_message"):
                    self._ota_state["ota_message"] = message_text
                    changed = True

            if error is not None:
                error_text = str(error) if error else None
                if error_text != self._ota_state.get("ota_error"):
                    self._ota_state["ota_error"] = error_text
                    changed = True
            elif status is not None and self._ota_state.get("ota_status") != "error":
                if self._ota_state.get("ota_error") is not None:
                    self._ota_state["ota_error"] = None
                    changed = True

            if changed:
                self._ota_state_version += 1
                self._ota_state_changed.notify_all()
            return True

    def _ota_payload_from_snapshot(self, snapshot):
        return {
            "session_id": snapshot.get("ota_session_id", ""),
            "progress": snapshot.get("ota_progress", 0.0),
            "status": snapshot.get("ota_status", "idle"),
            "message": snapshot.get("ota_message", ""),
            "error": snapshot.get("ota_error"),
            "slot": snapshot.get("ota_target_slot", "A"),
        }

    def _resolve_ota_target_worker(self, slot):
        slot_id = self._normalize_robot_slot(slot, "A")
        mag = self._magos_by_slot.get(slot_id) if getattr(self, "_magos_by_slot", None) else None
        worker = mag.BLE_worker if mag else None
        return slot_id, worker

    def _run_cloud_ota_session(self, session_id, force_update=False, target_slot="A"):
        self._emit_ota_state(
            session_id,
            progress=0,
            status="downloading",
            message="Initializing OTA",
            error=None,
        )

        def on_update_callback(progress, message, status):
            normalized_status = self._normalize_ota_status(status, progress)
            error_text = str(message) if normalized_status == "error" else None
            self._emit_ota_state(
                session_id,
                progress=progress,
                status=normalized_status,
                message=message,
                error=error_text,
            )

        try:
            slot_id, worker = self._resolve_ota_target_worker(target_slot)
            if not worker or not worker.is_connected():
                raise RuntimeError(f"Slot {slot_id} BLE not connected")
            self.ota_service.ble_worker = worker
            self.ota_service.start_cloud_update(on_update_callback, force_update=force_update)
            snapshot = self._get_ota_snapshot()
            if (
                snapshot.get("ota_session_id") == session_id
                and snapshot.get("ota_status") not in {"done", "error"}
            ):
                self._emit_ota_state(
                    session_id,
                    progress=100,
                    status="done",
                    message="OTA complete",
                    error=None,
                )
        except Exception as e:
            self._emit_ota_state(
                session_id,
                status="error",
                message=f"OTA failed: {str(e)}",
                error=str(e),
            )

    def _run_local_ota_session(self, session_id, firmware_path, target_slot="A"):
        try:
            self._emit_ota_state(
                session_id,
                progress=0,
                status="starting",
                message="Initializing OTA",
                error=None,
            )
            slot_id, worker = self._resolve_ota_target_worker(target_slot)
            if not worker or not worker.is_connected():
                raise RuntimeError(f"Slot {slot_id} BLE not connected")
            self.ota_service.ble_worker = worker
            self.ota_service.firmware_bin_path = firmware_path

            def on_update_callback(progress, message, status):
                normalized_status = self._normalize_ota_status(status, progress)
                if normalized_status in {"starting", "downloading"}:
                    normalized_status = "transferring"
                error_text = str(message) if normalized_status == "error" else None
                self._emit_ota_state(
                    session_id,
                    progress=progress,
                    status=normalized_status,
                    message=message,
                    error=error_text,
                )

            self._emit_ota_state(
                session_id,
                progress=40,
                status="transferring",
                message="Transferring firmware",
                error=None,
            )
            self.ota_service._flash_firmware(on_update_callback)
            self._emit_ota_state(
                session_id,
                progress=100,
                status="done",
                message="OTA complete",
                error=None,
            )
        except Exception as e:
            self._emit_ota_state(
                session_id,
                status="error",
                message=f"OTA failed: {str(e)}",
                error=str(e),
            )
        finally:
            try:
                self.ota_service._cleanup()
            except Exception:
                pass

    def cloud_update(self):
        payload = request.get_json(silent=True) or {}
        force_update = bool(payload.get("force_update"))
        slot = self._normalize_robot_slot(payload.get("slot"), "A")
        _, ble_worker = self._resolve_ota_target_worker(slot)
        if not ble_worker or not ble_worker.is_connected():
            return jsonify({"status": "error", "message": "BLE not connected", "slot": slot}), 409

        session_id = self._begin_ota_session(
            initial_status="downloading",
            message="Initializing OTA",
            reject_if_running=True,
            target_slot=slot,
        )
        if not session_id:
            return jsonify({"status": "error", "message": "OTA already running"}), 409

        threading.Thread(
            target=self._run_cloud_ota_session,
            args=(session_id, force_update, slot),
            daemon=True,
        ).start()

        return jsonify(
            {
                "status": "starting",
                "message": "Cloud OTA started",
                "session_id": session_id,
                "slot": slot,
            }
        )

    def local_upload(self):
        slot = self._normalize_robot_slot(request.form.get("slot"), "A")
        upload_file = request.files.get("file")
        if not upload_file or not upload_file.filename:
            return jsonify({"status": "error", "message": "Missing .bin file"}), 400

        original_name = secure_filename(upload_file.filename)
        if not original_name.lower().endswith(".bin"):
            return jsonify({"status": "error", "message": "Only .bin is supported"}), 400
        _, ble_worker = self._resolve_ota_target_worker(slot)
        if not ble_worker or not ble_worker.is_connected():
            return jsonify({"status": "error", "message": "BLE not connected", "slot": slot}), 409

        session_id = self._begin_ota_session(
            initial_status="starting",
            message="Initializing OTA",
            reject_if_running=True,
            target_slot=slot,
        )
        if not session_id:
            return jsonify({"status": "error", "message": "OTA already running"}), 409

        ota_dir = getattr(self.ota_service, "ota_dir", "") or os.path.join(
            self.current_dir, "uploads", "ota"
        )
        os.makedirs(ota_dir, exist_ok=True)
        bin_name = f"local_{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}_{original_name}"
        firmware_path = os.path.join(ota_dir, bin_name)

        try:
            upload_file.save(firmware_path)
        except Exception as e:
            self._emit_ota_state(
                session_id,
                status="error",
                message=f"Save file failed: {str(e)}",
                error=str(e),
            )
            return (
                jsonify(
                    {
                        "status": "error",
                        "message": f"Save file failed: {str(e)}",
                        "session_id": session_id,
                        "slot": slot,
                    }
                ),
                500,
            )

        threading.Thread(
            target=self._run_local_ota_session,
            args=(session_id, firmware_path, slot),
            daemon=True,
        ).start()

        return jsonify(
            {
                "status": "starting",
                "message": "Local OTA started",
                "session_id": session_id,
                "slot": slot,
            }
        )

    def ota_stream(self):
        request_session_id = (request.args.get("session_id") or "").strip()
        wait_timeout_sec = 15

        def event_stream():
            last_version = -1
            while True:
                with self._ota_state_changed:
                    if self._ota_state_version == last_version:
                        self._ota_state_changed.wait(timeout=wait_timeout_sec)

                    snapshot = dict(self._ota_state)
                    version = self._ota_state_version

                if version == last_version:
                    yield ": keep-alive\n\n"
                    continue

                last_version = version
                payload = self._ota_payload_from_snapshot(snapshot)
                if request_session_id and payload.get("session_id") != request_session_id:
                    continue

                yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"

        return Response(
            event_stream(),
            mimetype="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    def ota_status(self):
        snapshot = self._get_ota_snapshot()
        payload = self._ota_payload_from_snapshot(snapshot)
        payload["started_at"] = snapshot.get("ota_started_at", 0.0)
        return jsonify(payload)
    # endregion

    # region Network API
    def network_restart(self):
        """API to trigger network restart"""
        try:
            data = request.get_json()
            if not data or data.get("action") != "restart":
                return jsonify({"ok": False, "error": "invalid action"}), 400
            
            # Trigger background task
            threading.Thread(target=self._restart_network_background, daemon=True).start()
            
            return jsonify({"ok": True, "action": "restart", "message": "network restart triggered"}), 200
        except Exception as e:
            return jsonify({"ok": False, "error": f"restart failed: {str(e)}"}), 500

    def _restart_network_background(self):
        """Background task to trigger Robot WIFI reset via BLE"""
        try:
            print("[Network] Triggering Robot WIFI Reset via BLE...")
            # Wait a bit to ensure the response is sent
            time.sleep(0.5)
            
            if self.magos:
                success = self.magos.wifi_reset()
                if success:
                    print("[Network] BLE command sent successfully.")
                else:
                    print("[Network] Failed to send BLE command (BLE_worker not ready).")
            else:
                print("[Network] Magos instance not found.")
                
        except Exception as e:
            print(f"[Network] Background task failed: {e}")
            
    def network_login(self):
        """
        POST /api/network/login
        Handle network authentication requests.
        """
        try:
            # 1. JSON Parsing Check
            if not request.is_json:
                return jsonify({"ok": False, "action": "login", "error": "invalid json"}), 400
            
            data = request.get_json()
            if not data:
                return jsonify({"ok": False, "action": "login", "error": "invalid json"}), 400

            # 2. Action Check
            if data.get("action") != "login":
                return jsonify({"ok": False, "action": "login", "error": "invalid action"}), 400

            # 3. Parameter Presence Check
            account = data.get("account")
            password = data.get("password")

            if not isinstance(account, str) or not account:
                return jsonify({"ok": False, "action": "login", "error": "account must be 1~32 bytes"}), 400
            
            if not isinstance(password, str) or not password:
                return jsonify({"ok": False, "action": "login", "error": "password must be 6~63 bytes"}), 400

            # 4. Length Check (UTF-8 Bytes)
            account_bytes = len(account.encode('utf-8'))
            password_bytes = len(password.encode('utf-8'))

            if not (1 <= account_bytes <= 32):
                return jsonify({"ok": False, "action": "login", "error": "account must be 1~32 bytes"}), 400
            
            if not (6 <= password_bytes <= 63):
                return jsonify({"ok": False, "action": "login", "error": "password must be 6~63 bytes"}), 400

            # 5. Business Logic (Placeholder)
            # Log securely (mask password)
            masked_account = account[:2] + "***" + account[-2:] if len(account) > 4 else account
            print(f"[Network] Login request received. Account: {masked_account}, PwdLen: {password_bytes}")

            # Trigger background task
            threading.Thread(
                target=self._network_login_background, 
                args=(account, password), 
                daemon=True
            ).start()

            # 6. Response
            return jsonify({
                "ok": True, 
                "action": "login", 
                "message": "login accepted", 
                "account": masked_account
            }), 200

        except Exception as e:
            self.logger.error(f"Network login error: {str(e)}")
            return jsonify({"ok": False, "action": "login", "error": f"login failed: {str(e)}"}), 500

    def _network_login_background(self, account, password):
        """Background task for network login"""
        try:
            # Simulate network delay
            time.sleep(1)
            print(f"[Network] Sending WiFi credentials to Robot via BLE...")
            
            if self.magos:
                success = self.magos.send_wifi_config(account, password)
                if success:
                    print(f"[Network] WiFi config sent successfully for {account[:2]}***")
                else:
                    print(f"[Network] Failed to send WiFi config (BLE not ready)")
            else:
                print(f"[Network] Magos instance not found")
                
        except Exception as e:
            print(f"[Network] Background login failed: {e}")

    # endregion

    # region
    # comment fixed
    # def upload_file(self):
    #     if 'image' not in request.files:
    #         return jsonify({'error': 'No file part'}), 400

    #     file = request.files['image']
    #     if file.filename == '':
    #         return jsonify({'error': 'No selected file'}), 400

    #     filename = f"{datetime.now().strftime('%Y%m%d%H%M%S')}-{file.filename}"
    #     file.save(os.path.join(self.UPLOAD_FOLDER, filename))
    # comment fixed

    # comment fixed
    # def submit_movement(self):
    #     try:
    #         data = request.json
    # comment fixed

    #         with open(self.CAMERA_SCORES_FILE, 'r+') as f:
    #             scores = json.load(f)
    #             scores.append({'data': data})
    #             f.seek(0)
    #             json.dump(scores, f, indent=2)

    #         return jsonify({
    #             'success': True,
    # comment fixed
    #         })
    #     except Exception as error:
    # comment fixed
    #         return jsonify({
    #             'success': False,
    # comment fixed
    #         }), 500

    # comment fixed
    # def submit_movement_detail(self):
    #     try:
    #         data = request.json

    #         with open(self.CAMERA_SCORES_DETAIL_FILE, 'r+') as f:
    #             scores = json.load(f)
    #             scores.append({'data': data})
    #             f.seek(0)
    #             json.dump(scores, f, indent=2)

    #         return jsonify({
    #             'success': True,
    # comment fixed
    #         })
    #     except Exception as error:
    # comment fixed
    #         return jsonify({
    #             'success': False,
    # comment fixed
    #         }), 500

    # comment fixed
    # def request_camera(self):
    #     try:
    #         with open(self.CAMERA_SCORES_FILE, 'r') as f:
    #             return jsonify(json.load(f))
    #     except Exception as error:
    # comment fixed
    # comment fixed

    # comment fixed
    # def request_game(self):
    #     try:
    #         with open(self.SUDOKU_SCORES_FILE, 'r') as f:
    #             return jsonify(json.load(f))
    #     except Exception as error:
    # comment fixed
    # comment fixed

    # comment fixed
    # def submit_game(self):
    #     try:
    #         data = request.json
    #         name = data.get('name')
    #         time = data.get('time')
    #         difficulty = data.get('difficulty')
    #         errors = data.get('errors')
    #         hints = data.get('hints')

    #         difficultyR = 5 - difficulty
    #         date_str = datetime.now().strftime('%Y-%m-%d')

    #         print(f'Received data: {name}, {time}, {difficultyR}, {errors}, {hints}')

    # comment fixed
    #         with open(self.SUDOKU_SCORES_FILE, 'r+') as f:
    #             scores = json.load(f)
    #             scores.append({
    #                 'name': name,
    #                 'time': time,
    #                 'difficulty': difficulty,
    #                 'errors': errors,
    #                 'hints': hints,
    #                 'dateStr': date_str
    #             })
    #             f.seek(0)
    #             json.dump(scores, f, indent=2)

    # comment fixed
    #         self.save_to_excel(name, time, difficultyR, errors, date_str, hints)

    #         return jsonify({
    #             'success': True,
    #             'message': 'Data received and saved successfully'
    #         })
    #     except Exception as error:
    #         print('Error processing request:', error)
    #         return jsonify({
    #             'success': False,
    #             'message': 'Internal server error',
    #             'error': str(error)
    #         }), 500
    # endregion

    # comment fixed
    def RunPythonCode(self):
        """运行传来的Python代码"""
        code = request.json.get("code")
        if not code:
            return jsonify({"status": "failed", "message": "No code provided"}), 400

        if self._run_python_code_task(code=code, source="manual"):
            return jsonify({"status": "success", "message": "Task started"})
        else:
            return jsonify({"status": "failed", "message": "Failed to start task"}), 500

    # endregion

    # region
    # def save_to_excel(self,name, time, difficulty, errors, date, hints):
    # comment fixed
    #     new_data = {
    #         'Name': [name],
    #         'Time': [time],
    #         'Difficulty': [difficulty],
    #         'Errors': [errors],
    #         'Hints': [hints],
    #         'Date': [date]
    #     }

    # comment fixed
    #     df_new = pd.DataFrame(new_data)

    # comment fixed
    #     if os.path.exists(self.sudoku_excel_file_path):
    # comment fixed
    #         df_existing = pd.read_excel(self.sudoku_excel_file_path)
    # comment fixed
    #         df_combined = pd.concat([df_existing, df_new], ignore_index=True)
    #     else:
    #         df_combined = df_new

    # comment fixed
    #     df_combined.to_excel(self.sudoku_excel_file_path, index=False)

    # comment fixed
    # def load_data(self,file_path):
    # comment fixed
    #     try:
    #         data = []
    #         with open(file_path, 'r') as f:
    #             actions_data = json.load(f)
    #         for i, action_data in enumerate(actions_data):
    # comment fixed
    #             temps = {'joint_angles':action_data['joint_angles']}
    #             data.append(temps)
    # comment fixed
    #         return data
    #     except Exception as e:
    # comment fixed
    #         return None

    # comment fixed
    def save_data(self, file_path):
        print("保存动作组数据")

    # endregion

    # region
    def BLE_init_(self):
        self.loop = asyncio.new_event_loop()
        threading.Thread(target=self.loop.run_forever, daemon=True).start()
        slots = getattr(self, "ROBOT_SLOTS", tuple("ABCDEF"))
        data_json_path = self._music_data_json_path()
        self._ble_handles.clear()
        self._ble_workers.clear()
        for s in slots:
            handle = BLE.BLEController(
                data_json_path=data_json_path,
                slot_id=s,
                manifest_lock=self._music_manifest_lock,
            )
            worker = BLE.BLEWorker(handle, self.loop)
            self._ble_handles[s] = handle
            self._ble_workers[s] = worker
        self.BLE_Handle = self._ble_handles.get("A")
        self.BLE_worker = self._ble_workers.get("A")

    # endregion


