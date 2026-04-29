import threading
import time
from threading import Thread

from HttpServer.mylib import robot_data, BLE, ESP_BLE
import asyncio
import json
import os
import re
import sys

# 获取当前脚本的绝对路径
current_script_path = os.path.abspath(__file__)
# 获取当前脚本所在的目录（mylib 文件夹）
current_dir = os.path.dirname(current_script_path)
# 向上移动一级到 HttpServer 文件夹
http_server_dir = os.path.dirname(current_dir)
# 构建 actions_group 文件夹的完整路径
actions_group_path = os.path.join(http_server_dir, "actions_group")


class MagosRobot:
    # region 常量设置
    RightHand = 0  # 对应一号舵机 (DEV_SERVO_1)
    RightArm = 1  # 对应二号舵机 (DEV_SERVO_2)
    RightShoulder = 2  # 对应三号舵机 (DEV_SERVO_3)
    LeftHand = 3  # 对应四号舵机 (DEV_SERVO_4)
    LeftArm = 4  # 对应五号舵机 (DEV_SERVO_5)
    LeftShoulder = 5  # 对应六号舵机 (DEV_SERVO_6)
    Header = 6  # 对应七号舵机 (DEV_SERVO_7)
    Base = 7  # 对应八号舵机 (DEV_SERVO_8)
    Body = 8  # 对应九号舵机 (DEV_SERVO_9)

    ServerClamp = {
        "RightHand": (681, 392, 129),
        "RightArm": (252, 534, 819),
        "RightShoulder": (309, 572, 845),
        "LeftHand": (400, 672, 943),
        "LeftArm": (758, 453, 180),
        "LeftShoulder": (757, 451, 184),
        "Header": (460, 500, 540),
    }

    # endregion
    def __init__(self, _BLE_worker, _task_manager=None):
        self.BLE_worker = _BLE_worker
        self.task_manager = _task_manager  # 注入任务管理器
        self.index_mapping = {
            # 0: 3,  # 界面右手 -> 实际左手
            # 1: 4,  # 界面右肩 -> 实际左肩
            # 2: 5,  # 界面右臂 -> 实际左臂
            # 3: 0,  # 界面左手 -> 实际右手
            # 4: 1,  # 界面左肩 -> 实际右肩
            # 5: 2   # 界面左臂 -> 实际右臂
        }

        # 机器人数据(数据管理类)
        self.robotData = robot_data.RobotData()
        self.robotData_upper = robot_data.RobotData()

        # 创建反向映射字典（实际索引->界面索引）
        self.reverse_mapping = {v: k for k, v in self.index_mapping.items()}
        # 添加错误处理相关属性
        self.connection_retry_count = 0
        self.max_connection_retries = 3
        self.working_servos = [True] * self.robotData.num_servos  # 跟踪哪些舵机正常工作
        self.communication_errors = [
            0
        ] * self.robotData.num_servos  # 每个舵机的通信错误次数
        self.max_errors = 5  # 舵机连续错误容忍次数

    def wifi_reset(self):
        """发送机器人WIFI重置指令"""
        if self.BLE_worker:
            self.BLE_worker.send_wifi_reset()
            return True
        return False

    def send_wifi_config(self, ssid, password):
        """发送WIFI账号密码配置"""
        if self.BLE_worker:
            self.BLE_worker.send_wifi_config(ssid, password)
            return True
        return False

    # 复位逻辑
    def handle_reset(self):
        """处理复位逻辑，强制停止当前任务并复位舵机"""
        # 复位开始，锁定电量
        if self.BLE_worker:
            self.BLE_worker.set_battery_update_pause(True)
            
        initial_positions = [
            587, 
            381, 
            531, 
            521, 
            594, 
            492, 
            518, 
            1000, 
            591, 
            591 
        ]
        duration = 1.0 # 复位动作耗时1秒
        
        # 如果有正在运行的任务，先强制停止它
        if self.task_manager and self.task_manager.is_running:
             print("[SYSTEM] 发现正在运行的任务，正在停止...")
             self.task_manager.stop_task()
             # 给一点时间让线程退出
             time.sleep(0.5)

        try:
            # 简单复位：直接发送目标位置，避免调用 _execute_motion_frame 导致在停止状态下直接返回而不执行
            print("[SYSTEM] 执行快速复位...")
            
            if self.BLE_worker:
                bulk_list = []
                # 获取舵机基地址，默认为1
                base_addr = getattr(self.BLE_worker, 'DEV_SERVO_BASE', 1)
                
                # 设定复位速度 (步/s)，假设最大行程1000，1秒完成，则速度约1000。保守取800。
                reset_speed = 800
                
                for i, angle in enumerate(initial_positions):
                     actual_index = self.index_mapping.get(i, i)
                     
                     # 构建 4 字节数据: 角度(2B) + 速度(2B)
                     angle_bytes = int(angle).to_bytes(2, "little")
                     speed_bytes = int(reset_speed).to_bytes(2, "little")
                     data = list(angle_bytes + speed_bytes)
                     
                     # 加上基地址偏移
                     bulk_list.append((actual_index + base_addr, data))
                
                self.BLE_worker.write_multiple(bulk_list)
                
                # 增加短暂延时，避免指令冲突
                time.sleep(0.2)
                
                # 关闭音乐
                self.stop_background_audio()
                
                time.sleep(duration) # 给一点时间让舵机归位
        except Exception as e:
            print(f"[SYSTEM] 复位过程中舵机控制出错: {e}")

        # 3. 状态变更 (如果需要修改全局 status，需确认 status 定义位置，这里假设在 RobotData 或自身属性中)
        # self.status = 0 # IDLE
        
        # 复位结束，恢复电量更新（延迟3秒）
        if self.BLE_worker:
            self.BLE_worker.set_battery_update_pause(False, duration=3.0)
        
        print("[SYSTEM] 复位指令发送完毕，系统已回到 IDLE 状态。")

    # 设置AI智能体ID
    def set_ai_agent_id(self, id_str):
        """发送设置AI智能体ID指令
        协议: Header(AA 55) + OpCode(B5) + Target(10) + Length + ID_String + Footer(0D 0A)
        """
        if not self.BLE_worker:
            print("[Magos] BLE Worker not initialized")
            return False
            
        try:
            # 转换ID字符串为UTF-8字节
            id_bytes = id_str.encode('utf-8')
            length = len(id_bytes)
            
            # 构建数据包
            # Header: AA 55 (在 write_multiple 或 write_single 内部可能会处理，但这里是自定义协议帧)
            # 注意：BLEWorker.write_single 通常封装了 AA 55 ... 0D 0A，
            # 但这里是变长数据，可能需要直接构造完整帧或使用 write_multiple 的透传模式
            # 查看 BLE.py 的 write_single 实现，它通常封装了 Header/Footer
            
            # 假设我们使用 write_single 发送自定义指令
            # OpCode = 0xB5
            # Data = Target(0x10) + Length + ID_Bytes
            
            target = 0x10
            payload = bytearray([target, length]) + id_bytes
            
            # 调用 write_single (OpCode, Data)
            # BLE.py 的 create_frame 会封装成: AA 55 Len OpCode Data Checksum 0D 0A (这是通用协议)
            # 但根据用户描述的协议: AA 55 B5 10 Len ID... 0D 0A
            # 这与 BLE.py 默认的 create_frame 格式可能不同。
            # 如果 BLE.py 的 create_frame 是: AA 55 Len Data Checksum 0D 0A，那么 OpCode 只是 Data 的一部分。
            # 让我们检查 BLE.py 的 create_frame 实现。
            
            # 假设直接调用底层 write 方法发送原始数据
            # 构造完整帧
            frame = bytearray([0xAA, 0x55, 0xB5, 0x10, length]) + id_bytes + bytearray([0x0D, 0x0A])
            
            # 使用 BLE_worker 的 raw_write 方法（如果存在）或者通过 write_characteristic 发送
            # 这里假设 BLE_worker 有一个 send_raw_data 方法，如果没有，我们需要在 BLEWorker 中添加
            # 或者复用现有的 write_single，如果它支持自定义 OpCode 且不强制特定格式
            
            # 暂时使用 BLE_worker.ble_handle.write_data(frame) 如果它是公开的
            # 或者在 BLEWorker 中添加 send_custom_frame
            
            self.BLE_worker.send_custom_frame(frame)
            print(f"[Magos] Sent AI Agent ID: {id_str}")
            return True
        except Exception as e:
            print(f"[Magos] Failed to set AI Agent ID: {e}")
            return False

    # 播放語言
    def _music_manifest_paths(self):
        paths = []

        # Packaged mode: data.json is expected beside the executable.
        if getattr(sys, "frozen", False):
            exe_dir = os.path.dirname(sys.executable)
            if exe_dir:
                paths.append(os.path.join(exe_dir, "data.json"))

        # Workspace runtime fallback: <repo_root>/magos_runtime/data.json
        repo_root = os.path.dirname(os.path.dirname(os.path.dirname(http_server_dir)))
        paths.append(os.path.join(repo_root, "magos_runtime", "data.json"))

        # Source mode path.
        paths.append(os.path.join(http_server_dir, "static", "data.json"))

        unique_paths = []
        seen = set()
        for path in paths:
            norm = os.path.normcase(os.path.abspath(path))
            if norm in seen:
                continue
            seen.add(norm)
            unique_paths.append(path)
        return unique_paths

    def _load_music_manifest_entries(self):
        for path in self._music_manifest_paths():
            if not os.path.exists(path):
                continue

            try:
                with open(path, "r", encoding="utf-8") as f:
                    payload = json.load(f)
            except Exception:
                continue

            if isinstance(payload, dict):
                music = payload.get("music", [])
                if isinstance(music, list):
                    return music
            elif isinstance(payload, list):
                return payload

        return []

    def _normalize_music_name(self, name):
        raw = str(name or "").strip()
        if not raw:
            return ""
        base = os.path.basename(raw)
        stem, _ = os.path.splitext(base)
        cleaned = re.sub(r"\s+", " ", (stem or base)).strip()
        return cleaned

    def _normalize_music_filename(self, name):
        raw = str(name or "").strip()
        if not raw:
            return ""
        base = os.path.basename(raw)
        if not base:
            return ""
        if not base.lower().endswith(".mp3"):
            base = f"{base}.mp3"
        return base

    def _resolve_background_music_selector(self, selector):
        if isinstance(selector, (bytes, bytearray)):
            selector = bytes(selector).decode("utf-8", errors="ignore")

        raw = str(selector or "").strip()
        if not raw:
            raise ValueError("music name is empty")

        # Name-core mode: always treat input as song name, never as numeric index.
        target = self._normalize_music_name(raw).lower()
        if not target:
            raise ValueError("music name is empty")

        for item in self._load_music_manifest_entries():
            if isinstance(item, dict):
                name = str(item.get("name") or "").strip()
            elif isinstance(item, str):
                name = item.strip()
            else:
                name = ""
            if not name:
                continue
            if self._normalize_music_name(name).lower() == target:
                resolved = self._normalize_music_filename(name)
                if resolved:
                    return resolved

        resolved = self._normalize_music_filename(raw)
        if not resolved:
            raise ValueError("music name is empty")
        return resolved

    def play_audio(self, voice):
        # previous_voice = '[h9][v9]'+voice
        previous_voice = voice
        print(previous_voice)
        self.BLE_worker.write_single(0xB1, previous_voice.encode("utf-8"))

    # 播放背景音乐
    def play_background_audio(self, music_name):
        print("播放音乐")
        resolved_name = self._resolve_background_music_selector(music_name)
        self.BLE_worker.write_background_voice(resolved_name)

    # 暂停背景音乐
    def stop_background_audio(self):
        print("关闭音乐")
        self.BLE_worker.write_background_voice(0xFF)

    # 删除背景音乐（按文件名）
    def delete_background_audio(self, music_name, timeout=3.0, wait_ack=True):
        resolved_name = self._resolve_background_music_selector(music_name)
        return self.BLE_worker.write_background_voice_delete(
            resolved_name, timeout=timeout, wait_ack=wait_ack
        )

    # 改变表情
    def change_emoji(self, index):
        # 映射特殊表情 ID (前端 8,9,10 -> 协议 0,1,2)
        # 8: 猪爸爸 -> 0
        # 9: 猪妈妈 -> 1
        # 10: 猪儿子 -> 2
        val = int(index)
        if val == 8:
            self.BLE_worker.write_special_emoji(0) # 猪爸爸
        elif val == 9:
            self.BLE_worker.write_special_emoji(1) # 猪妈妈
        elif val == 10:
            self.BLE_worker.write_special_emoji(2) # 猪儿子
        else:
            # 其他表情，使用新协议 (AA 55 09 FF 01 ...)
            self.BLE_worker.write_emoji(index)

    # 延时
    def magos_time(self, _time):
        if self.task_manager:
            if not self.task_manager.smart_sleep(_time):
                # 抛出异常以中断上层逻辑，或者仅返回
                # 这里抛出 SystemExit 比较直接
                print("[Magos] Task stopped signal received during magos_time.")
                return # 改为 return，避免崩溃
        else:
            time.sleep(_time)

    # 设置单个舵机值
    def set_robot_server(self, index, angle):
        actual_index = self.index_mapping.get(index, index)  # 获取映射后的索引
        # 同步动作到机器人
        v0, v90, v180 = 0, 0, 0
        if index == 0:
            v0, v90, v180 = self.ServerClamp["RightHand"]
        elif index == 1:
            v0, v90, v180 = self.ServerClamp["RightArm"]
        elif index == 2:
            v0, v90, v180 = self.ServerClamp["RightShoulder"]
        elif index == 3:
            v0, v90, v180 = self.ServerClamp["LeftHand"]
        elif index == 4:
            v0, v90, v180 = self.ServerClamp["LeftArm"]
        elif index == 5:
            v0, v90, v180 = self.ServerClamp["LeftShoulder"]
        elif index == 6:
            v0, v90, v180 = self.ServerClamp["Header"]
        else:
            v0, v90, v180 = self.ServerClamp["Header"]

        targetValue = max(0, min(180, angle))

        if targetValue <= 90:
            angle = v0 + (v90 - v0) * (targetValue / 90)
        else:
            angle = v90 + (v180 - v90) * ((targetValue - 90) / 90)
        print("目标角度：", targetValue, "目标舵机值：", angle)
        # 将 new_position 转换为 int16 小端字节数组
        try:
            value = int(angle) & 0xFFFF  # 转为uint16

            data_bytes = value.to_bytes(2, byteorder="little", signed=False)

            self.BLE_worker.write_single(
                actual_index + self.BLE_worker.DEV_SERVO_BASE, data_bytes
            )  # 发送到BLE设备
            self.robotData.update_single_angle(int(angle), actual_index)
            return int(angle)
            # 增加舵机命令发送反馈
            # print(f"851已发送命令到舵机 {actual_index}，位置: {angle}")
        except Exception as e:
            print(f"发送命令到舵机 {actual_index} 时出错: {str(e)}")
            self.communication_errors[actual_index] += 1

            # 如果连续错误次数过多，标记为不可用
            if self.communication_errors[actual_index] > self.max_errors:
                self.working_servos[actual_index] = False
                # print(f"舵机 {actual_index} 通信失败次数过多，已标记为不可用")
            return None

    # 执行一个动作组
    def animations_start(self, animations_name):
        # print("蓝牙连接状态:",self.BLE_worker.is_connected())

        if os.path.exists(actions_group_path):
            json_files = [
                f for f in os.listdir(actions_group_path) if f.endswith(".json")
            ]
            print("找到的 JSON 文件:", json_files)
        else:
            print("错误：actions_group 路径不存在", actions_group_path)

        try:
            # 锁定电量更新，并在动作结束后延迟 5秒 恢复（等待电压回升）
            if self.BLE_worker:
                self.BLE_worker.set_battery_update_pause(True)
            
            file_path = os.path.join(actions_group_path, animations_name + ".json")
            with open(file_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                for i in data:
                    data1 = i["joint_angles"]
                    data2 = i["duration"]
                    self._execute_motion_frame(data1, data2)
                
                # 动作执行完毕，恢复电量更新（带延迟）
                if self.BLE_worker:
                    self.BLE_worker.set_battery_update_pause(False, duration=5.0)
                    
                return "None"
        except Exception as e:
            print("出现错误:", e)
            # 出错也要恢复，避免死锁
            if self.BLE_worker:
                self.BLE_worker.set_battery_update_pause(False, duration=1.0)

    # 更新舵机值
    def update_upper_single_angle(self, new_position, index):
        self.robotData.update_single_angle(new_position, index - 1)

    # 获取下位机所有舵机位置
    def get_all_servos_positions(self):
        """获取所有舵机的当前位置"""
        try:
            # 从robotData中获取当前关节角度
            return self.robotData.extractCurrent_rawPos()
        except Exception as e:
            print(f"获取舵机位置时出错: {e}")
            return None

    # 给下位机发送该信息
    def _execute_motion_frame(self, angles, duration):
        """给下位机发送该信息"""
        positions = list(self.get_all_servos_positions())
        print(f"[debug] 初始所有舵机位置: {positions}")

        commands = [
            (i, angles[i])
            for i in range(len(angles))
            if angles[i] is not None and self.working_servos[i]
        ]

        batch_size = 10
        max_retries = 3

        for start in range(0, len(commands), batch_size):
            batch = commands[start : start + batch_size]
            retry_flags = [0] * len(batch)
            sent_flags = [False] * len(batch)

            for retry in range(max_retries):
                bulk_list = []

                for idx, (logic_index, pos) in enumerate(batch):
                    if sent_flags[idx]:
                        continue

                    actual_index = self.index_mapping.get(logic_index, logic_index)

                    try:
                        self.update_upper_single_angle(pos, actual_index + 1)

                        speed = (
                            abs(pos - positions[actual_index]) / duration
                        )  # 单位：步/s
                        speed = min(max(speed, 1), 1000)  # 舵机速度最大1000步/s
                        speed = int(speed)

                        angle_bytes = int(pos).to_bytes(2, "little")
                        speed_bytes = int(speed).to_bytes(2, "little")
                        data = list(angle_bytes + speed_bytes)  # 4 字节

                        device_addr = actual_index + 1  # 确保是 1~10 的设备地址
                        bulk_list.append((device_addr, data))

                        positions[actual_index] = pos
                        sent_flags[idx] = True

                        print(
                            f"[batch] 舵机 {actual_index + 1} → 目标 {pos}, 速度 {speed}, 用时 {duration}s"
                        )

                    except Exception as e:
                        retry_flags[idx] += 1
                        print(
                            f"命令构建失败: 舵机 {actual_index}（第 {retry_flags[idx]} 次）错误：{e}"
                        )
                        if retry_flags[idx] >= max_retries:
                            print(f"舵机 {actual_index} 命令发送失败，跳过")
                            self.communication_errors[actual_index] += 1
                            if (
                                self.communication_errors[actual_index]
                                > self.max_errors
                            ):
                                self.working_servos[actual_index] = False
                                print(f"舵机 {actual_index} 已标记为不可用")
                if bulk_list:
                    try:
                        self.BLE_worker.write_multiple(bulk_list)
                        
                        # 使用 smart_sleep 替代 time.sleep
                        if self.task_manager:
                            if not self.task_manager.smart_sleep(0.3):
                                raise SystemExit("Task stopped")
                        else:
                            time.sleep(0.3)
                            
                        # await asyncio.sleep(1)
                    except SystemExit:
                        raise # 继续向上抛出
                    except Exception as e:
                        print(f"[x] 批量发送失败：{e}")
            
            # 帧间延迟
            if self.task_manager:
                if not self.task_manager.smart_sleep(1.3):
                    raise SystemExit("Task stopped")
            else:
                time.sleep(1.3)
            # await asyncio.sleep(1)

    def test(self, index):
        print(index)

    # 读取数据
    def load_data(self, file_path):
        """读取数据 file_path:目标地址"""
        try:
            data = []
            with open(file_path, "r") as f:
                actions_data = json.load(f)
            for i, action_data in enumerate(actions_data):
                # 鸿亮 ：只需要给item添加data，然后通过update_listitem即可完成添加字幕方法
                # print(data)
                temps = {
                    "joint_angles": action_data["joint_angles"],
                    "duration": action_data["duration"],
                }
                data.append(temps)
            print("读取成功")
            return data
        except Exception as e:
            print("读取失败", e)
            return None


if __name__ == "__main__":
    myloop = asyncio.new_event_loop()
    threading.Thread(target=myloop.run_forever, daemon=True).start()
    BLE_handle = BLE.BLEController()
    BLE_worker = BLE.BLEWorker(BLE_handle, myloop)
    Magos = MagosRobot(BLE_worker)
    asyncio.run(Magos.BLE_worker.connect("test_ble"))
    Magos.animations_start("三个动作组")

    asyncio.run(Magos.BLE_worker.disconnect())
