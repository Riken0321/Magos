import json, logging, asyncio, threading, sys, datetime, os, webbrowser, time, subprocess, platform

# import pandas as pd
from io import StringIO

from flask import Flask, request, jsonify, render_template, send_file
from werkzeug.utils import secure_filename
from HttpServer.mylib import BLE, Magos, TaskManager

try:
    from waitress import serve
except ModuleNotFoundError:
    serve = None

WAITRESS = serve is not None
SERVERLOG = True


class FlaskApp:
    # 文件路径定义
    CAMERA_SCORES_FILE = "cameraScores.json"
    CAMERA_SCORES_DETAIL_FILE = "cameraScoresDetail.json"
    SUDOKU_SCORES_FILE = "sudokuScores.json"
    UPLOAD_FOLDER = "uploads"
    sudoku_excel_file_path = "sudokuData.xlsx"
    # 获取当前脚本的绝对路径
    current_script_path = os.path.abspath(__file__)
    # 获取当前脚本所在的目录（mylib 文件夹）
    current_dir = os.path.dirname(current_script_path)
    # 构建 actions_group 文件夹的完整路径
    actions_group_path = os.path.join(current_dir, "actions_group")

    def __init__(self, _host="0.0.0.0", _port=5001, _debug=True, _threaded=True):
        # 加载动作组（需要在开发模式下使用）
        self.LoadActionGroup()

        # region  成员初始化
        self.BLE_worker = None
        self.BLE_Handle = None
        self.BLE_init_()
        self.task_manager = TaskManager.TaskManager()
        self.magos = Magos.MagosRobot(self.BLE_worker, self.task_manager)
        # endregion

        # region Web初始化
        self.app = Flask(__name__)
        # 日志配置
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

        self._configure_app(_debug)
        self._register_routes()
        url = f"http://localhost:{_port}"

        self.testdefuntion()

        if not os.environ.get("NO_BROWSER"):
            threading.Thread(
                target=self.open_broweser, args=(url,), daemon=True
            ).start()

        self.logger.info(f"服务器启动于:{url}")
        try:
            if not WAITRESS:
                self.app.run(host=_host, port=_port, debug=_debug, threaded=_threaded)
            else:
                serve(self.app, host=_host, port=_port, threads=4)
        except KeyboardInterrupt:
            logging.info("服务器关闭")
        except Exception as e:
            logging.error(f"服务器出现问题：{str(e)}")
            print(f"服务器出现问题：{str(e)}")
            input("按回车退出...")

        # endregion

    # 测试函数
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
            if hasattr(self, 'magos') and self.magos:
                try:
                    self.magos.stop_background_audio()
                except Exception as e:
                    print(f"Error stopping audio on pause: {e}")
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
        # 确保 static/docs/INSTRUCTION Manual.pdf 存在
        pdf_path = os.path.join(self.app.root_path, 'static', 'docs', 'INSTRUCTION Manual.pdf')
        if not os.path.exists(pdf_path):
            self.logger.error(f"Manual file not found at: {pdf_path}")
            return jsonify({"error": "Manual not found"}), 404
        return send_file(pdf_path, mimetype='application/pdf', as_attachment=False)

    # region Web服务器的设置
    def _configure_app(self, IS_DEBUG):
        """基础设置"""
        self.app.config.update(
            DEBUG=IS_DEBUG, ENV="development", TEMPLATES_AUTO_RELOAD=True
        )

    def _register_routes(self):
        """注册所有按钮事件"""
        print("DEBUG: Registering routes including /api/delete_music")
        self.app.add_url_rule("/", view_func=self.index)
        self.app.add_url_rule("/to_shudu", view_func=self.sudu, methods=["GET"])
        # ...
        
        # 打印路由映射以确认
        print("DEBUG: Current URL Map:")
        print(self.app.url_map)
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
        # 兼容性别名：/api/status
        self.app.add_url_rule(
            "/api/status", view_func=self.robot_status, methods=["GET"]
        )
        self.app.add_url_rule(
            "/api/ble/rename", view_func=self.rename_device, methods=["POST"]
        )
        self.app.add_url_rule(
            "/api/network", view_func=self.network_restart, methods=["POST"]
        )
        self.app.add_url_rule(
            "/api/network/login", view_func=self.network_login, methods=["POST"]
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
                
                # 读取现有数据
                existing_data = {}
                existing_actions_map = {} # filename -> display_name

                if os.path.exists(data_json_path):
                    try:
                        with open(data_json_path, "r", encoding="utf-8") as f:
                            existing_data = json.load(f)
                            # 构建现有动作的映射表，保留自定义显示名称
                            if isinstance(existing_data, dict) and "actions" in existing_data and isinstance(existing_data["actions"], list):
                                for action in existing_data["actions"]:
                                    if isinstance(action, list) and len(action) >= 2:
                                        display_name, filename = action[0], action[1]
                                        existing_actions_map[filename] = display_name
                    except Exception:
                        existing_data = {}
                
                # 兼容性处理
                if isinstance(existing_data, list):
                    existing_data = {"music": existing_data}
                elif not isinstance(existing_data, dict):
                    existing_data = {}

                actions_data = []
                for item in json_files:
                    filename = str(item[:-5])
                    # 使用现有的显示名称（如果有），否则使用文件名
                    display_name = existing_actions_map.get(filename, filename)
                    actions_data.append([display_name, filename])
                
                # 更新 actions 字段
                existing_data["actions"] = actions_data
 
                with open(data_json_path, "w", encoding="utf-8") as f:
                    json.dump(existing_data, f, indent=2, ensure_ascii=False)
            else:
                print("缺失actions_group文件")
        except Exception as e:
            print(f"应用版问题：文件路径不对 {e}")

    # endregion

    # region 网页绑定
    def handle_error(self, e):
        if SERVERLOG:
            self.logger.error(f"服务器出现错误:{str(e)}")
            return jsonify({"error": "Interr server error"}), 500

    def index(self):
        return render_template("index.html")

    def sudu(self):
        return render_template("shudu.html")

    def habcam(self):
        return render_template("RehabCam.html")

    def data(self):
        return render_template("DataManager.html")

    # 获取蓝牙连接状态
    def BLE_State(self):
        if self.magos.BLE_worker.is_connected():
            return ["True"]
        return ["False"]

    # 刷新蓝牙设备
    def BLE_Refresh(self):
        """获取BLE的设备"""
        print("DEBUG: BLE_Refresh called (Sync mode)")
        try:
            # 使用 run_coroutine_threadsafe 在后台 loop 中执行扫描
            # 这样可以避免 Flask/Waitress 线程与 Bleak 的 Async 上下文冲突
            if not self.BLE_worker or not self.BLE_worker.loop:
                 print("ERROR: BLE_worker or loop not initialized")
                 return jsonify({"error": "BLE system not ready"}), 500

            future = asyncio.run_coroutine_threadsafe(
                self.magos.BLE_worker.scan(), 
                self.magos.BLE_worker.loop
            )
            
            # 阻塞等待结果 (扫描默认5秒，这里设置8秒超时)
            devices = future.result(timeout=8)
            
            # 构建设备字典列表
            device_list = []
            for mac in devices:
                if mac.name is not None:
                    device_list.append(mac.name)
            
            print(f"DEBUG: Found devices: {device_list}")
            return jsonify(device_list)
            
        except TimeoutError:
            print("ERROR: BLE_Refresh timed out")
            return jsonify({"error": "Scan timed out"}), 504
        except Exception as e:
            print(f"ERROR: BLE_Refresh failed: {e}")
            import traceback
            traceback.print_exc()
            return jsonify({"error": str(e)}), 500

    # 进行连接
    def BLE_Connect(self):
        """BLE设备连接"""
        print("DEBUG: BLE_Connect called (Sync mode)")
        try:
            selected_device = request.data.decode("utf-8")
            print(f"DEBUG: Connecting to {selected_device}")
            if not selected_device:
                print("错误：没有选中蓝牙设备")
                return ["False"]

            if not self.BLE_worker or not self.BLE_worker.loop:
                 print("ERROR: BLE_worker or loop not initialized")
                 return jsonify({"error": "BLE system not ready"}), 500

            future = asyncio.run_coroutine_threadsafe(
                self.magos.BLE_worker.connect(selected_device), 
                self.magos.BLE_worker.loop
            )
            
            # 阻塞等待连接结果 (连接可能较慢，设置 10 秒超时)
            result = future.result(timeout=10)
            
            if result == True:
                print("连接成功")
                return ["True"]
            print("连接失败")
            return ["False"]
            
        except TimeoutError:
            print("ERROR: BLE_Connect timed out")
            return jsonify({"error": "Connection timed out"}), 504
        except Exception as e:
            print(f"ERROR: BLE_Connect failed: {e}")
            import traceback
            traceback.print_exc()
            return ["False"]

    # 断开连接
    def BLE_Disconnect(self):
        """BLE设备连接"""
        print("DEBUG: BLE_Disconnect called (Sync mode)")
        try:
            if not self.BLE_worker or not self.BLE_worker.loop:
                 print("ERROR: BLE_worker or loop not initialized")
                 return jsonify({"error": "BLE system not ready"}), 500

            future = asyncio.run_coroutine_threadsafe(
                self.magos.BLE_worker.disconnect(), 
                self.magos.BLE_worker.loop
            )
            
            # 阻塞等待结果 (断开连接应该很快，设置 5 秒超时)
            # disconnect() 没有返回值，但我们需要等待它完成
            future.result(timeout=5)
            
            # 如果是True 就返回False表示断开失败，否则反之
            if self.magos.BLE_worker.is_connected():
                return ["False"]
            else:
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
        """机器人复位接口"""
        try:
            # 执行复位逻辑（这里面已经包含了停止任务的逻辑）
            self.magos.handle_reset()
            return jsonify({"status": "success", "message": "Robot reset successfully"})
        except Exception as e:
            print(f"Reset failed: {e}")
            return jsonify({"status": "failed", "message": str(e)}), 500

    def robot_status(self):
        """获取机器人综合状态"""
        try:
            # 1. 连接状态 (强制转为布尔值)
            is_connected = False
            device_name = ""
            
            if self.magos and self.magos.BLE_worker:
                is_connected = bool(self.magos.BLE_worker.is_connected())
                # 获取设备名
                if self.magos.BLE_worker.ble_handle:
                    # 使用 getattr 避免属性不存在报错
                    device_name = getattr(self.magos.BLE_worker.ble_handle, "device_name", "")
            
            # 2. 运行状态
            # 直接使用 TaskManager 中维护的 status_code
            task_status = self.task_manager.status_code
            
            # 3. 电量信息 (确保是整数或None)
            battery = None
            if self.magos and self.magos.BLE_worker and self.magos.BLE_worker.ble_handle:
                raw_battery = self.magos.BLE_worker.ble_handle.battery_val
                if raw_battery is not None:
                    try:
                        battery = int(raw_battery)
                        # 双重保险：再次检查范围
                        if battery < 0: battery = 0
                        if battery > 100: battery = 100 # 恢复限制：前端统一显示100
                    except (ValueError, TypeError):
                        battery = None
            
            # 4. 生成时间戳
            updated_at = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
            
            response_data = {
                "is_connected": is_connected,
                "connected": is_connected, # 兼容字段
                "isConnected": is_connected, # 兼容字段
                "device_name": device_name,
                "connected_device": device_name, # 兼容字段
                "name": device_name, # 兼容字段
                "status": task_status,
                "battery": battery,
                "updated_at": updated_at
            }
            # print(f"DEBUG: /api/robot/status response: {response_data}") # 调试打印
            return jsonify(response_data)
        except Exception as e:
            print(f"Get status failed: {e}")
            return jsonify({"error": str(e)}), 500

    def set_battery_display(self):
        """控制机身电量显示开关"""
        try:
            # 2. 获取参数
            data = request.get_json()
            if not data or "display_mode" not in data:
                return jsonify({"status": "failed", "message": "Missing 'display_mode' parameter"}), 400
            
            mode = int(data["display_mode"])
            enabled = (mode == 1)
            
            # --- MOCK 测试模式 ---
            # 如果没有连接蓝牙，或者是测试环境，允许直接返回成功
            # 这样前端就能看到 "Success" 弹窗了
            is_mock = True # 开启Mock模式
            if is_mock and (not self.magos or not self.magos.BLE_worker or not self.magos.BLE_worker.is_connected()):
                print(f"[MOCK] 假装发送指令: Set Battery Display -> {'ON' if enabled else 'OFF'}")
                return jsonify({"status": "success", "message": f"[MOCK] Battery display set to {'ON' if enabled else 'OFF'}"})
            # --------------------

            if not self.magos or not self.magos.BLE_worker:
                 return jsonify({"status": "failed", "message": "BLE worker not initialized"}), 500
                 
            # 1. 检查连接状态
            if not self.magos.BLE_worker.is_connected():
                return jsonify({"status": "failed", "message": "Robot not connected"}), 400

            # 3. 发送指令
            self.magos.BLE_worker.set_battery_display_mode(enabled)
            
            return jsonify({"status": "success", "message": f"Battery display set to {'ON' if enabled else 'OFF'}"})
            
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
            
            # 长度限制 (GAP Name 通常限制较短，例如 < 20 字节)
            if len(new_name.encode('utf-8')) > 20:
                return jsonify({"status": "failed", "message": "Name too long (max 20 bytes)"}), 400

            if not self.magos or not self.magos.BLE_worker:
                 return jsonify({"status": "failed", "message": "BLE worker not initialized"}), 500
                 
            # 1. 检查连接状态
            if not self.magos.BLE_worker.is_connected():
                return jsonify({"status": "failed", "message": "Robot not connected"}), 400

            # 2. 执行改名 (Sync wait)
            if not self.magos.BLE_worker.loop:
                 return jsonify({"status": "failed", "message": "BLE loop not ready"}), 500

            future = asyncio.run_coroutine_threadsafe(
                self.magos.BLE_worker.set_name(new_name), 
                self.magos.BLE_worker.loop
            )
            
            # 等待结果 (5秒超时)
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


    # 播放语音
    def VoicePlay(self):
        try:
            voice = request.data.decode("utf-8")
            print(voice)
            self.magos.play_audio(voice)
            return "True"
        except Exception as e:
            print("错误：", e)

    def upload_music(self):
        # 1. 检查是否有文件
        if "file" not in request.files:
            return jsonify({"code": 400, "msg": "未找到文件"}), 400

        file = request.files["file"]
        custom_name = request.form.get("name", "未命名音乐")

        if file.filename == "":
            return jsonify({"code": 400, "msg": "文件名为空"}), 400

        if file and file.filename.endswith(".mp3"):
            # 2. 保存文件 (加时间戳防止重名)
            filename = secure_filename(file.filename)
            unique_filename = f"{int(time.time())}_{filename}"
            # 使用 self.current_dir 构建路径
            music_folder = os.path.join(self.current_dir, "static")
            save_path = os.path.join(music_folder, unique_filename)

            # 确保目录存在
            if not os.path.exists(music_folder):
                os.makedirs(music_folder)

            file.save(save_path)

            # 3. 更新 data.json
            new_music_entry = {
                "name": custom_name,
                "url": f"./static/{unique_filename}",  # 注意：这里是给前端用的相对路径
            }

            data_json_path = os.path.join(self.current_dir, "static", "data.json")

            try:
                # 读取旧数据
                if os.path.exists(data_json_path):
                    with open(data_json_path, "r", encoding="utf-8") as f:
                        try:
                            data = json.load(f)
                        except json.JSONDecodeError:
                            data = []
                else:
                    data = []

                # 智能处理：如果是列表直接加，如果是字典加到 'music' 字段
                if isinstance(data, list):
                    data.append(new_music_entry)
                elif isinstance(data, dict):
                    if "music" not in data:
                        data["music"] = []
                    data["music"].append(new_music_entry)
                else:
                    return jsonify({"code": 500, "msg": "data.json 格式异常"}), 500

                # 写回文件
                with open(data_json_path, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)

                return jsonify({"code": 200, "msg": "上传成功", "data": new_music_entry})

            except Exception as e:
                return jsonify({"code": 500, "msg": f"数据写入失败: {str(e)}"}), 500

        return jsonify({"code": 400, "msg": "仅支持 MP3 格式"}), 400

    def delete_music(self):
        try:
            data = request.json
            music_url = data.get("url")  # 前端传 url，例如 "./static/123_song.mp3"
            
            if not music_url:
                return jsonify({"code": 400, "msg": "参数错误: 缺少 url"}), 400

            # 解析文件名
            filename = os.path.basename(music_url)
            # 安全检查
            filename = secure_filename(filename)

            music_folder = os.path.join(self.current_dir, "static")
            file_path = os.path.join(music_folder, filename)

            # 1. 删除文件
            if os.path.exists(file_path):
                try:
                    os.remove(file_path)
                    print(f"文件已删除: {file_path}")
                except Exception as e:
                    print(f"删除文件失败: {e}")
                    return jsonify({"code": 500, "msg": f"删除文件失败: {str(e)}"}), 500
            else:
                print(f"文件不存在: {file_path}")

            # 2. 更新 data.json
            data_json_path = os.path.join(self.current_dir, "static", "data.json")
            if os.path.exists(data_json_path):
                with open(data_json_path, "r", encoding="utf-8") as f:
                    try:
                        music_data = json.load(f)
                    except json.JSONDecodeError:
                        music_data = []

                # 从数据中移除
                if isinstance(music_data, list):
                    new_data = [m for m in music_data if os.path.basename(m.get("url", "")) != filename]
                    music_data = new_data
                elif isinstance(music_data, dict) and "music" in music_data:
                    new_list = [m for m in music_data["music"] if os.path.basename(m.get("url", "")) != filename]
                    music_data["music"] = new_list
                
                with open(data_json_path, "w", encoding="utf-8") as f:
                    json.dump(music_data, f, ensure_ascii=False, indent=2)

            return jsonify({"code": 200, "msg": "删除成功"})

        except Exception as e:
            print(f"删除接口异常: {e}")
            return jsonify({"code": 500, "msg": str(e)}), 500

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

    # region 用于服务器的功能
    # # 上传文件
    # def upload_file(self):
    #     if 'image' not in request.files:
    #         return jsonify({'error': 'No file part'}), 400

    #     file = request.files['image']
    #     if file.filename == '':
    #         return jsonify({'error': 'No selected file'}), 400

    #     filename = f"{datetime.now().strftime('%Y%m%d%H%M%S')}-{file.filename}"
    #     file.save(os.path.join(self.UPLOAD_FOLDER, filename))
    #     return jsonify({'message': f'文件 "{file.filename}" 已成功上传！'})

    # # 提交移动数据
    # def submit_movement(self):
    #     try:
    #         data = request.json
    #         print('接收到的数据:', data)

    #         with open(self.CAMERA_SCORES_FILE, 'r+') as f:
    #             scores = json.load(f)
    #             scores.append({'data': data})
    #             f.seek(0)
    #             json.dump(scores, f, indent=2)

    #         return jsonify({
    #             'success': True,
    #             'message': '数据上传成功！'
    #         })
    #     except Exception as error:
    #         print('处理数据时出错:', error)
    #         return jsonify({
    #             'success': False,
    #             'message': '服务器处理数据时出错'
    #         }), 500

    # # 处理数据
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
    #             'message': '数据上传成功！'
    #         })
    #     except Exception as error:
    #         print('处理数据时出错:', error)
    #         return jsonify({
    #             'success': False,
    #             'message': '服务器处理数据时出错'
    #         }), 500

    # # 读取摄像机数据
    # def request_camera(self):
    #     try:
    #         with open(self.CAMERA_SCORES_FILE, 'r') as f:
    #             return jsonify(json.load(f))
    #     except Exception as error:
    #         print('读取JSON文件时出错:', error)
    #         return jsonify({'error': '服务器内部错误'}), 500

    # # 请求游戏
    # def request_game(self):
    #     try:
    #         with open(self.SUDOKU_SCORES_FILE, 'r') as f:
    #             return jsonify(json.load(f))
    #     except Exception as error:
    #         print('读取JSON文件时出错:', error)
    #         return jsonify({'error': '服务器内部错误'}), 500

    # # 提交游戏
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

    #         # 更新JSON文件
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

    #         # 更新Excel文件
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

    # 运行Blockly代码
    def RunPythonCode(self):
        """运行传来的Python代码"""
        code = request.json.get("code")
        if not code:
            return jsonify({"status": "failed", "message": "No code provided"}), 400

        def run_code():
            output_lines = []
            result = {}

            # 自定义打印函数
            def custom_print(*args, **kwargs):
                sep = kwargs.get("sep", " ")
                end = kwargs.get("end", "\n")
                # 检查任务状态
                if not self.task_manager.check_status():
                    raise SystemExit("Task stopped by user")
                output_lines.append(sep.join(map(str, args)) + end)

            # 创建执行环境
            # 封装 time 模块以支持暂停/停止
            class TimeWrapper:
                def __init__(self, original_time, task_mgr):
                    self._original_time = original_time
                    self._task_mgr = task_mgr
                
                def sleep(self, seconds):
                    # 使用 smart_sleep 替代原生的 sleep
                    if not self._task_mgr.smart_sleep(seconds):
                        raise SystemExit("Task stopped")
                
                def __getattr__(self, name):
                    return getattr(self._original_time, name)

            env = {
                "__builtins__": __builtins__,
                "print": custom_print,
                "magos": self.magos,
                "time": TimeWrapper(time, self.task_manager), # 使用封装后的 time
            }
            
            try:
                exec(code, env, result)
            except SystemExit:
                print("Code execution stopped by user")
            except Exception as e:
                print(f"Code execution error: {e}")
            
            return "".join(output_lines)

        # 启动新任务（会自动停止旧任务）
        if self.task_manager.start_task(run_code):
            return jsonify({"status": "success", "message": "Task started"})
        else:
            return jsonify({"status": "failed", "message": "Failed to start task"}), 500

    # endregion

    # region 其他方法
    # def save_to_excel(self,name, time, difficulty, errors, date, hints):
    #     # 创建数据字典
    #     new_data = {
    #         'Name': [name],
    #         'Time': [time],
    #         'Difficulty': [difficulty],
    #         'Errors': [errors],
    #         'Hints': [hints],
    #         'Date': [date]
    #     }

    #     # 创建DataFrame
    #     df_new = pd.DataFrame(new_data)

    #     # 检查Excel文件是否存在
    #     if os.path.exists(self.sudoku_excel_file_path):
    #         # 读取现有数据
    #         df_existing = pd.read_excel(self.sudoku_excel_file_path)
    #         # 合并数据
    #         df_combined = pd.concat([df_existing, df_new], ignore_index=True)
    #     else:
    #         df_combined = df_new

    #     # 保存到Excel
    #     df_combined.to_excel(self.sudoku_excel_file_path, index=False)

    # 读取数据
    # def load_data(self,file_path):
    #     """读取数据 file_path:目标地址"""
    #     try:
    #         data = []
    #         with open(file_path, 'r') as f:
    #             actions_data = json.load(f)
    #         for i, action_data in enumerate(actions_data):
    #             # 鸿亮 ：只需要给item添加data，然后通过update_listitem即可完成添加字幕方法
    #             temps = {'joint_angles':action_data['joint_angles']}
    #             data.append(temps)
    #         print("读取成功")
    #         return data
    #     except Exception as e:
    #         print("读取失败",e)
    #         return None

    # 保存数据
    def save_data(self, file_path):
        print("保存动作数据")

    # endregion

    # region 各模块初始化
    def BLE_init_(self):
        self.loop = asyncio.new_event_loop()
        threading.Thread(target=self.loop.run_forever, daemon=True).start()
        self.BLE_Handle = BLE.BLEController()
        self.BLE_worker = BLE.BLEWorker(self.BLE_Handle, self.loop)

    # endregion
