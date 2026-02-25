# -*- coding: utf-8 -*-
import asyncio
from bleak import BleakClient, BleakScanner
from bleak.backends.characteristic import BleakGATTCharacteristic
import time
from datetime import datetime
import os

# ====== 设备配置 ======
# DEVICE_ADDR = "A0:DD:6C:86:47:C2"  # 替换为你的ESP32C3 MAC地址
NOTIFY_UUID = "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"  # 通知特征
WRITE_UUID = "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"  # 写入特征
# 设备蓝牙名称
# DEVICE_NAME = "BLE_1"  # 替换为任意设备名称

# ====== 协议定义 ======
HEADER = b"\xaa\x55"  # 帧头
FOOTER = b"\x0d\x0a"  # 帧尾


class BLEController:
    OP_POWER = 0xB0  # 电量信息操作码
    DEV_BATTERY = 0xFF  # 电量设备地址

    def __init__(self):
        self.client = None
        self.received_data = bytearray()
        self.is_connected = False
        self.device_name = ""  # 存储当前连接的设备名称
        self.last_sent_time = 0
        self.send_interval = 1.0  # 默认发送间隔(秒)
        self.ble = BleakScanner()
        self.battery_val = None  # 存储电量值
        
        # 改名防抖
        self._last_rename_time = 0
        self._last_rename_name = ""
        
        # 电量平滑滤波相关
        self._battery_history = []  # 历史电量队列
        self._battery_history_len = 15 # 增加窗口大小到15，进一步平滑
        self._last_display_battery = None # 上一次显示的电量（用于迟滞比较）
        self._has_logged_empty = False # 是否已经记录过没电状态
        self._abnormal_count = 0 # 连续异常值计数器
        
        # 运动状态锁
        self._battery_update_paused = False # 是否暂停更新电量
        self._pause_resume_time = 0 # 预计恢复更新的时间戳


    def set_battery_update_pause(self, paused, duration=0):
        """
        设置电量更新暂停状态
        paused: True/False
        duration: 如果是恢复(paused=False)，可以指定额外的延迟时间(秒)，等待电压回升
        """
        self._battery_update_paused = paused
        if not paused and duration > 0:
            self._pause_resume_time = time.time() + duration
        else:
            self._pause_resume_time = 0
            
        status = "PAUSED" if paused else ("RESUMING in {}s".format(duration) if duration > 0 else "RESUMED")
        print(f"[BLE] Battery Update: {status}")


    def notification_handler(
        self, characteristic: BleakGATTCharacteristic, data: bytearray
    ):
        """处理接收到的原始数据并解析协议帧"""
        # 打印原始数据
        print(f"Raw RX: {bytes(data).hex()}")

        # 协议解析
        self.received_data.extend(data)
        while len(self.received_data) >= 3:  # 最小检查长度改为3
            # 查找帧头
            start_idx = self.received_data.find(HEADER)
            if start_idx == -1:
                self.received_data.clear()
                return

            # 移除帧头前的无效数据
            if start_idx > 0:
                self.received_data = self.received_data[start_idx:]
                continue

            # 检查是否有足够的长度来判断操作码 (至少3字节: HEADER + OP)
            if len(self.received_data) < 3:
                return

            op_code = self.received_data[2]
            
            # 特殊处理：电量信息 (无校验)
            if op_code == self.OP_POWER:
                # 最小长度: Header(2) + OP(1) + ADDR(1) + LEN(1) + DATA(1) + Footer(2) = 8
                if len(self.received_data) < 8:
                    return # 等待更多数据
                
                # 验证帧尾
                if self.received_data[6:8] != FOOTER:
                     print("Invalid battery frame footer!")
                     # 可能是错误数据，移除一个字节尝试重新同步
                     self.received_data.pop(0)
                     continue
                
                # 提取电量
                battery = self.received_data[5] # Offset 5
                
                # 数据清洗与滤波
                
                # --- 运动状态锁检查 ---
                if self._battery_update_paused:
                    # 暂停期间，完全忽略新数据，也不更新历史记录，保持上一次的显示值不变
                    # print(f"Battery Update PAUSED (Val: {battery})")
                    self.received_data = self.received_data[8:]
                    continue
                    
                if self._pause_resume_time > 0:
                    if time.time() < self._pause_resume_time:
                         # 处于恢复等待期（电压回升期），同样忽略
                         # print(f"Battery Update WAITING RECOVERY (Val: {battery})")
                         self.received_data = self.received_data[8:]
                         continue
                    else:
                         self._pause_resume_time = 0 # 等待结束
                # ---------------------
                
                # 放宽范围限制，允许超过100的值参与计算，因为平均值会自动平滑它
                if 0 <= battery <= 255:
                    # 1. 异常值剔除 (Spike Rejection)
                    # 如果新值与当前平滑值差异过大(>15)，则视为噪声丢弃
                    # 除非连续出现多次(>=3)，说明是真实突变
                    is_abnormal = False
                    if self.battery_val is not None:
                        diff = abs(battery - self.battery_val)
                        if diff > 15: # 突变阈值
                            self._abnormal_count += 1
                            if self._abnormal_count < 3:
                                print(f"Battery Spike Ignored: {battery} (Current: {self.battery_val}, Count: {self._abnormal_count})")
                                is_abnormal = True
                            else:
                                print(f"Battery Spike ACCEPTED: {battery} (Persistent change)")
                                self._abnormal_count = 0
                                # 真实突变，建议清空历史，快速响应
                                self._battery_history.clear()
                        else:
                            self._abnormal_count = 0
                    
                    if not is_abnormal:
                        # 2. 将新值加入历史队列
                        self._battery_history.append(battery)
                        if len(self._battery_history) > self._battery_history_len:
                            self._battery_history.pop(0)
                        
                        # 3. 计算去极值平均 (Trimmed Mean)
                        # 去掉最大和最小的各20%，防止个别噪声影响
                        if len(self._battery_history) >= 5:
                            sorted_hist = sorted(self._battery_history)
                            trim_cnt = int(len(sorted_hist) * 0.2)
                            valid_data = sorted_hist[trim_cnt : len(sorted_hist)-trim_cnt]
                            if not valid_data: valid_data = sorted_hist # 防止空
                            avg_battery = int(sum(valid_data) / len(valid_data))
                        else:
                            avg_battery = int(sum(self._battery_history) / len(self._battery_history))
                        
                        # 移除满电优化策略和最大值限制，直接显示真实计算值（支持>100）
                        # if avg_battery >= 98:
                        #     avg_battery = 100
                        # else:
                        #     avg_battery = min(avg_battery, 100)
                        
                        # === 没电记录逻辑 ===
                        if avg_battery == 0:
                            if not self._has_logged_empty:
                                try:
                                    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                                    log_msg = f"[{timestamp}] Battery is DEAD (0%)\n"
                                    with open("battery_log.txt", "a", encoding="utf-8") as f:
                                        f.write(log_msg)
                                    print(f"Battery DEAD logged: {log_msg.strip()}")
                                    self._has_logged_empty = True
                                except Exception as e:
                                    print(f"Failed to log battery status: {e}")
                        else:
                            # 如果电量恢复（比如充电了），重置标志位，以便下次没电时能再次记录
                            if avg_battery > 5: # 加个小阈值防止0-1抖动导致重复记录
                                self._has_logged_empty = False
                        
                        # 4. 迟滞更新 (Hysteresis)
                        # 只有当新计算的平均值与当前显示值差异超过阈值时，才更新显示
                        # 或者，如果是第一次收到数据，直接更新
                        if self._last_display_battery is None:
                            self._last_display_battery = avg_battery
                            self.battery_val = avg_battery
                        else:
                            diff = abs(avg_battery - self._last_display_battery)
                            # 提高阈值，进一步减少UI跳动
                            threshold = 3 
                            
                            if diff >= threshold:
                                self._last_display_battery = avg_battery
                                self.battery_val = avg_battery
                                print(f"!!! UI UPDATE !!! {self._last_display_battery} -> {avg_battery}%")
                        
                        print(f"Battery Raw: {battery}% | Smoothed: {avg_battery}% | Display: {self.battery_val}%")
                else:
                    print(f"Invalid battery value ignored: {battery}")
                
                # 移除已处理的帧
                self.received_data = self.received_data[8:]
                continue

            # 兼容旧协议帧处理 (0x81, 0x82, 0xF0 等)
            # 旧协议帧结构: [HEADER][OP][ADDR][LEN][DATA][FOOTER]
            # 最小长度: Header(2) + OP(1) + Addr(1) + Len(1) + Footer(2) = 7
            if len(self.received_data) < 7:
                 return # 等待更多数据

            # 获取数据长度
            payload_len = self.received_data[4]
            total_len = 5 + payload_len + 2  # 头5B + 数据 + 尾2B

            if len(self.received_data) < total_len:
                return  # 等待完整帧

            # 提取完整帧
            full_frame = self.received_data[:total_len]
            
            # 验证帧尾
            if full_frame[-2:] != FOOTER:
                print("Invalid footer!")
                self.received_data.pop(0) # 移除一个字节重新寻找帧头
                continue
                
            # 移除已处理的帧
            self.received_data = self.received_data[total_len:]

            # 将解析后的数据转发给 BLEWorker
            # 注意：这里的逻辑是模仿 BLEWorker._notification_handler 的行为
            # 但由于 BLEController 和 BLEWorker 是分层的，这里可能需要回调或者事件分发
            # 简单起见，我们打印一下，证明解析成功
            print(f"Valid Legacy Frame: {full_frame.hex()}")
            
            # TODO: 如果需要与 BLEWorker 联动，需要在这里调用回调
            continue
            
            # --- 以下是原本的"带校验"逻辑，看来是不对的，暂时注释掉 ---
            """
            # 常规协议处理 (带校验)
            # 检查完整帧 (帧头2字节 + 长度1字节 + 数据N字节 + 校验1字节 + 帧尾2字节)
            if len(self.received_data) < 5:
                return  # 等待更多数据

            payload_len = self.received_data[2]
            total_len = 2 + 1 + payload_len + 1 + 2  # 帧头+长度+数据+校验+帧尾
            # ... (省略)
            """

    def create_frame(self, data: bytes) -> bytearray:
        """创建协议帧"""
        # 帧结构: [HEADER][LEN][DATA][CHECKSUM][FOOTER]
        frame = bytearray(HEADER)
        frame.append(len(data))  # 长度字节
        frame.extend(data)

        # 计算校验和 (数据部分异或)
        checksum = 0
        for b in data:
            checksum ^= b
        frame.append(checksum)
        frame.extend(FOOTER)
        return frame

    async def connect_directly(self, target_name, callback=None):
        """直接连接蓝牙设备"""
        device = await BleakScanner.find_device_by_name(target_name)
        if not device:
            print(f"Device {target_name} not found")
            return False

        self.client = BleakClient(device, disconnected_callback=self.on_disconnect)
        await self.client.connect()
        # if callback:
        #     await self.client.start_notify(NOTIFY_UUID, callback)
        # else:
        await self.client.start_notify(NOTIFY_UUID, self.notification_handler)

        self.is_connected = True
        self.device_name = target_name  # 记录设备名

        print("Connected successfully!")
        return True

    async def BLE_scan(self):
        devices = await BleakScanner.discover()
        return devices

    def on_disconnect(self, client):
        """断开连接回调"""
        print("Device disconnected!")
        self.is_connected = False
        self.device_name = ""

    async def disconnectBLE(self):
        if (
            self.client
            and self.client.is_connected
        ):
            print("主动断开蓝牙连接")
            try:
                await self.client.disconnect()
            except Exception as e:
                print(f"断开连接时发生错误: {e}")
            print("Over")
        else:
            print("客户端本身已经断开")

    async def send_data(self, data: bytes):
        """发送数据"""
        # print("manbo")
        if not self.is_connected or not self.client:
            print("Not connected!")
            return

        print(f"Sending data: {data.hex()}")
        await self.client.write_gatt_char(WRITE_UUID, data)
        print("Data sent successfully!")

    async def set_name(self, new_name: str):
        """修改蓝牙设备名称 (Custom Protocol)"""
        if not self.is_connected or not self.client:
            print("Not connected!")
            return False
            
        try:
            # 防抖检查：防止前端重复调用
            now = time.time()
            if new_name == self._last_rename_name and (now - self._last_rename_time) < 3.0:
                print(f"Rename '{new_name}' ignored (Debounce: {now - self._last_rename_time:.1f}s)")
                return True # 假装成功
                
            # Protocol: [HEADER][OP][ADDR][LEN][DATA][FOOTER]
            # OP_RENAME = 0xB2 (Custom defined)
            # ADDR = 0xFF (System/Broadcast)
            
            name_bytes = new_name.encode('utf-8')
            length = len(name_bytes)
            
            if length > 255:
                print(f"Name too long: {length} bytes")
                return False

            frame = bytearray()
            frame.extend(HEADER)
            frame.append(0xB2)  # OP_RENAME
            frame.append(0xE0)  # ADDR changed to E0 per user request
            frame.append(length)
            frame.extend(name_bytes)
            frame.extend(FOOTER)

            print(f"Sending Rename Frame: {frame.hex()}")
            
            # Reuse send_data logic but await it directly since we are async
            # Note: send_data is async in BLEController
            await self.send_data(frame)
            
            self.device_name = new_name # Update local cache
            self._last_rename_name = new_name
            self._last_rename_time = now
            
            return True
        except Exception as e:
            print(f"Failed to update device name: {e}")
            return False


class BLEWorker:
    # 帧头 帧尾
    HEADER = b"\xaa\x55"
    FOOTER = b"\x0d\x0a"

    # 设备类型定义
    DEV_SERVO_BASE = 0x01  # 舵机基地址 舵机1地址 (对应 MagosRobot.RightHand)
    DEV_SERVO_1 = 0x01  # 舵机1地址 (对应 MagosRobot.RightHand)
    DEV_SERVO_2 = 0x02  # 舵机2地址 (对应 MagosRobot.RightArm)
    DEV_SERVO_3 = 0x03  # 舵机3地址 (对应 MagosRobot.RightShoulder)
    DEV_SERVO_4 = 0x04  # 舵机4地址 (对应 MagosRobot.LeftHand)
    DEV_SERVO_5 = 0x05  # 舵机5地址 (对应 MagosRobot.LeftArm)
    DEV_SERVO_6 = 0x06  # 舵机6地址 (对应 MagosRobot.LeftShoulder)
    DEV_SERVO_7 = 0x07  # 舵机7地址 (对应 MagosRobot.Header)
    DEV_SERVO_8 = 0x08  # 舵机8地址 (对应 MagosRobot.Base)
    DEV_SERVO_9 = 0x09  # 舵机9地址 (对应 MagosRobot.Body)
    DEV_SERVO_10 = 0x0A  # 舵机10地址

    servo_multiple_read_addrs = [
        0x01,
        0x02,
        0x03,
        0x04,
        0x05,
        0x06,
        0x07,
        0x08,
        0x09,
        0x0A,
    ]  # 批量读取舵机地址

    DEV_Servo_UNlock = [0xA5, 0xF5, 0x5F, 0x5A]  # 解除舵机锁指令
    DEV_Servo_lock = [0x5A, 0x5F, 0xF5, 0xA5]  # 开启舵机锁指令

    DEV_CAP_KEY_BASE = 0xA1  # 电容式按键基地址
    DEV_CAP_KEY_1 = 0xA1  # 电容式按键1地址
    DEV_CAP_KEY_2 = 0xA2  # 电容式按键2地址

    key_multiple_read_addrs = [0xA1, 0xA2]  # 批量读取电容式按键地址

    DEV_VOICE_BASE = 0xB1  # 语音设备基地址
    
    # 新增电量相关定义
    OP_POWER = 0xB0
    DEV_BATTERY = 0xFF
    OP_RENAME = 0xB2 # 修改蓝牙名称
    OP_WIFI = 0xB3 # WIFI

    WIFI_Rset = 0xE1 # 重置WIFI
    WIFI_ssid = 0xE2 # WIFI的名字
    WIFI_password = 0xE3 # WIFI的密码

    # # 信号定义 扫描到的设备列表
    # devices_found = pyqtSignal(list)
    # # 添加连接状态代码
    # connection_staus_changed = pyqtSignal(bool)

    def __init__(self, ble_handle, loop):
        super().__init__()
        self.ble_handle = ble_handle  # BLE处理类实例
        self.loop = loop  # 事件循环 用于连接和扫描（主要是用于蓝牙资源的异步访问）
        self.callbacks = {}  # 设备类型到回调函数的映射
        self.buffer = bytearray()  # 用于存储接收的数据缓冲区

    async def scan(self):
        devices = await self.ble_handle.BLE_scan()
        return devices

    async def connect(self, device_name):
        return await self.ble_handle.connect_directly(device_name)

    async def set_name(self, new_name):
        return await self.ble_handle.set_name(new_name)

    async def disconnect(self):
        print(self.is_connected())
        if self.is_connected():
            asyncio.run_coroutine_threadsafe(self.ble_handle.disconnectBLE(), self.loop)

    def send_data(self, data):
        asyncio.run_coroutine_threadsafe(self.ble_handle.send_data(data), self.loop)

    def register_callback(self, device_type, callback):
        self.callbacks[device_type] = callback

    def is_connected(self):
        """检查蓝牙连接状态"""
        return self.ble_handle.is_connected

    def read_single(self, device_addr):
        """读取单个设备状态"""
        frame = bytearray()
        frame.extend(self.HEADER)
        frame.append(0x01)  # 单设备读
        frame.append(device_addr)
        frame.append(0x00)  # 数据长度0
        frame.extend(self.FOOTER)
        self.send_data(frame)

    def set_battery_display_mode(self, enabled: bool):
        """
        控制机身电量显示开关
        协议: [AA 55] [B0] [FC] [01] [00/01] [0D 0A]
        注意：已移除校验和
        """
        op_code = 0xB0
        addr = 0xFC
        data_val = 0x01 if enabled else 0x00
        
        frame = bytearray()
        frame.extend(self.HEADER)     # AA 55
        frame.append(op_code)         # B0
        frame.append(addr)            # FC
        frame.append(0x01)            # Len = 1
        frame.append(data_val)        # Data
        
        # 移除校验和
        # checksum = op_code ^ addr ^ 0x01 ^ data_val
        # frame.append(checksum)        # CheckSum
        
        frame.extend(self.FOOTER)     # 0D 0A
        
        print(f"Set Battery Display: {'ON' if enabled else 'OFF'}, Frame: {frame.hex()}")
        self.send_data(frame)

    def set_battery_update_pause(self, paused, duration=0):
        """
        设置电量更新暂停状态 (代理方法)
        """
        self.ble_handle.set_battery_update_pause(paused, duration)

    def send_wifi_reset(self):
        """发送WIFI重置指令"""
        frame = bytearray()
        frame.extend(self.HEADER)
        frame.append(self.OP_WIFI)
        frame.append(self.WIFI_Rset)
        frame.append(0x01) # Length
        frame.append(0x01) # Data: 1 to trigger
        frame.extend(self.FOOTER)
        print(f"Sending WIFI Reset: {frame.hex()}")
        self.send_data(frame)

    def send_wifi_config(self, ssid, password):
        """发送WIFI账号密码配置"""
        import time
        # 1. Send SSID
        ssid_bytes = ssid.encode('utf-8')
        frame_ssid = bytearray()
        frame_ssid.extend(self.HEADER)
        frame_ssid.append(self.OP_WIFI)
        frame_ssid.append(self.WIFI_ssid)
        frame_ssid.append(len(ssid_bytes))
        frame_ssid.extend(ssid_bytes)
        frame_ssid.extend(self.FOOTER)
        print(f"Sending WIFI SSID: {ssid} (Hex: {frame_ssid.hex()})")
        self.send_data(frame_ssid)
        
        time.sleep(0.2) # Avoid packet loss
        
        # 2. Send Password
        pwd_bytes = password.encode('utf-8')
        frame_pwd = bytearray()
        frame_pwd.extend(self.HEADER)
        frame_pwd.append(self.OP_WIFI)
        frame_pwd.append(self.WIFI_password)
        frame_pwd.append(len(pwd_bytes))
        frame_pwd.extend(pwd_bytes)
        frame_pwd.extend(self.FOOTER)
        # Mask password in log
        print(f"Sending WIFI Password: {'*' * len(password)} (Hex: {frame_pwd.hex()})")
        self.send_data(frame_pwd)

    def write_single(self, device_addr, data):
        """控制单个设备"""
        frame = bytearray()
        frame.extend(self.HEADER)
        frame.append(0x02)  # 单设备写
        frame.append(device_addr)
        frame.append(len(data))
        frame.extend(data)
        frame.extend(self.FOOTER)
        self.send_data(frame)

    def read_multiple(self, device_addrs):
        """
        批量读取设备状态
        device_addrs: [device_addr1, device_addr2, ...]
        """
        frame = bytearray()
        frame.extend(self.HEADER)
        frame.append(0x03)  # 批量读
        frame.append(0xFF)  # 批量标识

        # 数据长度 = 设备数量
        frame.append(len(device_addrs))

        # 添加设备地址
        for device_addr in device_addrs:
            frame.append(device_addr)

        frame.extend(self.FOOTER)
        self.send_data(frame)

    def write_multiple(self, commands):
        """
        批量控制设备
        commands: [(device_addr, data), ...] 
        注意：data 必须是可迭代对象(如 list, bytes, bytearray)，如果是整数需要先转换
        """
        frame = bytearray()
        frame.extend(self.HEADER)
        frame.append(0x04)  # 批量写
        frame.append(0xFF)  # 批量标识

        # 验证输入格式
        if not commands:
            print("write_multiple: Empty commands")
            return

        # 处理两种参数格式
        if isinstance(commands[0], tuple):
            # 格式1: [(device_addr, data), ...]
            
            # 预处理：确保 data 是 bytes/list 格式，如果是 int 则转为 2 字节小端
            processed_commands = []
            for device_addr, data in commands:
                if isinstance(data, int):
                    # 假设是舵机角度等 int 数据，默认转为 2 字节小端
                    # 注意：根据实际协议调整字节序和长度
                    data_bytes = data.to_bytes(2, 'little')
                    processed_commands.append((device_addr, data_bytes))
                else:
                    processed_commands.append((device_addr, data))
            
            # 计算总长度: 每个命令包含 1字节地址 + 1字节长度 + N字节数据
            data_len = sum(1 + 1 + len(data) for _, data in processed_commands)
            
            # 长度限制检查 (如果协议用1字节表示长度，最大255)
            if data_len > 255:
                print(f"write_multiple: Data too long ({data_len} > 255)")
                # 这里可能需要拆包发送，或者协议支持更长？假设目前不做拆包，仅打印警告
            
            frame.append(data_len & 0xFF)
            
            for device_addr, data in processed_commands:
                frame.append(device_addr)
                frame.append(len(data))
                frame.extend(data)
        else:
            # 格式2: [device_addr1, device_addr2, ...]
            # 这里的逻辑看起来不完整或有特定用途，暂时保持原样，但添加类型检查
            # 之前的代码：data_len = len(commands) ... for device_addr in commands: frame.append(device_addr)
            # 这似乎只是发送了一串地址？这符合 "批量写" 协议吗？
            # 假设这是为了某种特殊的无数据指令
            
            data_len = len(commands) 
            frame.append(data_len & 0xFF)
            for device_addr in commands:
                frame.append(device_addr)
                # frame.append(2)  # 数据长度固定为2
                # frame.extend([0, 0])  # 默认数据

        frame.extend(self.FOOTER)
        # print("BLE.py 314发送数据:", frame.hex())
        self.send_data(frame)

    def write_voice(self, commands):
        frame = bytearray()
        frame.extend(self.HEADER)
        frame.append(0x05)  # 语音设备控制
        frame.append(0xFF)  # 批量标识
        frame.append(len(commands))
        for device_addr in commands:
            frame.append(device_addr)
        frame.extend(self.FOOTER)
        print(frame)
        self.send_data(frame)

    def write_voices_actions(self, commands):
        frame = bytearray()
        frame.extend(self.HEADER)
        frame.append(0x06)
        frame.append(0xFF)  # 批量标识
        frame.append(len(commands))
        frame.extend(commands)
        frame.extend(self.FOOTER)
        print(frame)
        self.send_data(frame)

    def return_voices_actions(self, commands):
        frame = bytearray()
        frame.extend(self.HEADER)
        frame.append(0x07)
        frame.append(0xFF)  # 批量标识
        frame.append(1)
        frame.append(commands)
        frame.extend(self.FOOTER)
        print(frame)
        self.send_data(frame)

    def write_background_voice(self, commands):
        frame = bytearray()
        frame.extend(self.HEADER)
        frame.append(0x08)
        frame.append(0xFF)  # 批量标识
        frame.append(1)
        frame.append(commands)
        frame.extend(self.FOOTER)
        print(frame)
        self.send_data(frame)

    def write_emoji(self, commands):
        """
        发送表情 (常规表情使用新协议)
        协议: [AA 55] [09] [FF] [01] [Data] [0D 0A]
        """
        frame = bytearray()
        frame.extend(self.HEADER)
        frame.append(0x09)        # 09
        frame.append(0xFF)        # FF
        frame.append(0x01)        # 01
        frame.append(commands)    # 表情 ID
        frame.extend(self.FOOTER)
        print(f"[TX] Sending Emoji ID: {commands}, Frame: {frame.hex()}")
        self.send_data(frame)

    def write_special_emoji(self, emoji_id):
        """
        发送特殊表情
        协议: [AA 55] [B4] [01] [01] [Data] [0D 0A]
        Data: 0=猪爸爸, 1=猪妈妈, 2=猪儿子
        """
        frame = bytearray()
        frame.extend(self.HEADER)
        frame.append(0xB4)        # 操作码 B4 (显示屏)
        frame.append(0x01)        # 目标地址 01
        frame.append(0x01)        # 数据长度 01
        frame.append(emoji_id)    # 数据 (0, 1, 2)
        frame.extend(self.FOOTER)
        
        print(f"Sending Special Emoji ID: {emoji_id}, Frame: {frame.hex()}")
        self.send_data(frame)

    def write_dance(self, commands):
        """发送开启跳舞模式"""
        frame = bytearray()
        frame.extend(self.HEADER)
        frame.append(0x0A)
        frame.append(0xFF)  # 批量标识
        frame.append(commands)
        frame.extend(self.FOOTER)
        print(frame)
        self.send_data(frame)

    def write_Servo_lock(self, commands):
        """
        控制舵机锁
        commands: [(device_addr, data), ...] 或 [device_addr1, device_addr2, ...]
        """
        frame = bytearray()
        frame.extend(self.HEADER)
        frame.append(0xA5)  # 批量控制舵机锁
        frame.append(0xFF)  # 批量标识

        # 处理两种参数格式
        if isinstance(commands[0], tuple):
            # 格式1: [(device_addr, data), ...]
            data_len = sum(2 + len(data) for _, data in commands)
            frame.append(data_len)
            for device_addr, data in commands:
                frame.append(device_addr)
                frame.append(len(data))
                frame.extend(data)
        else:
            # 格式2: [device_addr1, device_addr2, ...]
            # 为每个设备地址添加默认数据[0,0]
            data_len = len(commands)  # 每个设备: 1字节地址 + 1字节长度 + 1字节数据
            frame.append(data_len)
            for device_addr in commands:
                frame.append(device_addr)
                # frame.append(2)  # 数据长度固定为2
                # frame.extend([0, 0])  # 默认数据

        frame.extend(self.FOOTER)
        print("BLE.py 348发送数据:", frame.hex())
        self.send_data(frame)

    '''def write_multiple(self,commands):
        """
        批量控制设备
        commands: [(device_addr, data), ...]
        """
        frame = bytearray()
        frame.extend(self.HEADER)
        frame.append(0x04)  # 批量写
        frame.append(0xFF)  # 批量标识

        # 计算数据总长度
        data_len = sum(1 + len(data) for _, data in commands)
        frame.append(data_len)

        # 添加命令列表
        for device_addr, data in commands:
            frame.append(device_addr)
            frame.append(len(data))
            frame.extend(data)

        frame.extend(self.FOOTER)
        self.send_data(frame)'''

    def _notification_handler(
        self, characteristic: BleakGATTCharacteristic, data: bytearray
    ):
        self.buffer.extend(data)
        print(f"ble.376 Received data: {data.hex()}")
        while len(self.buffer) >= 7:  # 最小帧长度
            # 查找帧头
            start_idx = self.buffer.find(self.HEADER)
            if start_idx == -1:
                self.buffer.clear()
                return

            if start_idx > 0:
                self.buffer = self.buffer[start_idx:]
                continue

            # 检查最小长度
            if len(self.buffer) < 7:
                return

            # 获取数据长度
            data_len = self.buffer[4]
            total_len = 5 + data_len + 2  # 头5B + 数据 + 尾2B

            if len(self.buffer) < total_len:
                return  # 等待完整帧

            # 提取完整帧
            frame = bytes(self.buffer[:total_len])
            self.buffer = self.buffer[total_len:]

            # 验证帧尾
            if frame[-2:] != self.FOOTER:
                print("Invalid frame footer")
                return

            # 解析帧
            self._parse_frame(frame)

    def _parse_frame(self, frame):
        op_type = frame[2]
        device_addr = frame[3]
        data_len = frame[4]
        data = frame[5 : 5 + data_len] if data_len > 0 else b""
        print(f"ble.416 data: {data.hex()}")

        # 单设备响应
        if op_type == 0x81:
            if device_addr in self.callbacks:
                self.callbacks[device_addr](device_addr, data)
            else:
                print(f"Received data from device {device_addr:02X}: {data.hex()}")

        # 批量响应
        elif op_type == 0x82:
            self._parse_bulk_data(device_addr, data)

        # 事件上报
        elif op_type == 0xF0:
            print(f"Event from device {device_addr:02X}: {data.hex()}")
            if device_addr in self.callbacks:
                self.callbacks[device_addr](data)

        # 写操作响应
        elif op_type in (0x02, 0x04):
            # if data_len > 0 and data[0] != 0:
            if data[0] != 0:
                print(f"Write operation failed with code {data[0]}")
            else:
                print("Write operation succeeded")

    def _parse_bulk_data(self, bulk_type, data):
        index = 0
        while index < len(data):
            dev_addr = data[index]
            index += 1
            dev_data_len = data[index]
            index += 1
            dev_data = data[index : index + dev_data_len]
            index += dev_data_len

            # 检查是否有回调函数
            if dev_addr in self.servo_multiple_read_addrs:
                if self.DEV_SERVO_BASE in self.callbacks:
                    self.callbacks[self.DEV_SERVO_BASE](dev_addr, dev_data)
            elif dev_addr in self.key_multiple_read_addrs:
                if self.DEV_CAP_KEY_BASE in self.callbacks:
                    self.callbacks[self.DEV_CAP_KEY_BASE](dev_addr, dev_data)
            else:
                print(f"Bulk data from device {dev_addr:02X}: {dev_data.hex()}")



