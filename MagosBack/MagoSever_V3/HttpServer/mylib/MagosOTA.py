# -*- coding: utf-8 -*-
import asyncio
import struct
import logging
import os
from bleak import BleakClient

# 配置日志
logger = logging.getLogger("MagosOTA")
if not logger.handlers:
    handler = logging.StreamHandler()
    formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
    handler.setFormatter(formatter)
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)

# UUID 常量 (基于标准 Base UUID，实际使用时请根据设备调整)
# 0000xxxx-0000-1000-8000-00805f9b34fb
BASE_UUID_FORMAT = "0000{}-0000-1000-8000-00805f9b34fb"
RECV_FW_CHAR_UUID = "00008020-0000-1000-8000-00805f9b34fb" # 数据传输(Write) + ACK接收(Notify)
COMMAND_CHAR_UUID = "00008022-0000-1000-8000-00805f9b34fb" # 指令下发(Write)

# 协议常量
SECTOR_SIZE = 4096
ACK_SUCCESS = 0x0000
ACK_ERROR = 0x0002
CMD_OTA_START = 0x0001
CMD_OTA_END = 0x0002

class MagosOTAManager:
    def __init__(self, client: BleakClient, file_path: str):
        """
        初始化 OTA 管理器
        :param client: 已连接的 BleakClient 实例
        :param file_path: 固件文件路径
        """
        self.client = client
        self.file_path = file_path
        self.file_size = 0
        self.total_sectors = 0
        self.ack_event = asyncio.Event()
        self.last_ack_data = None
        self.is_transferring = False
        
        # 挂载 Event 到 BLEController 以便接收回调
        # client._backend._client 是 BleakClientWinRT 实例
        # 我们需要找到 BLEController 实例。
        # 更好的方式是从外部传入 BLEController，但为了兼容现有接口，我们假设 client 的 notification_handler 绑定在 BLEController 上
        # Hack: 在 myFlask.py 中我们已经通过 BLEWorker 获取了 client，这里我们只能尝试通过回调函数反推，或者在 start_ota 中设置
        self.ble_controller = None

    def set_controller(self, controller):
        """设置 BLEController 实例以便挂载事件"""
        self.ble_controller = controller
        self.ble_controller.ota_ack_event = self.ack_event

    def _crc16_ccitt(self, data: bytes) -> int:
        """
        计算 CRC16-CCITT (Poly: 0x1021, Init: 0xFFFF)
        """
        crc = 0xFFFF
        for byte in data:
            crc ^= (byte << 8)
            for _ in range(8):
                if crc & 0x8000:
                    crc = (crc << 1) ^ 0x1021
                else:
                    crc = crc << 1
            crc &= 0xFFFF
        return crc

    async def _notification_handler(self, sender, data):
        """
        [DEPRECATED] 
        This handler is NOT used when integrating with BLEController.
        The data comes from BLEController via self.ack_event.
        """
        # logger.debug(f"Received ACK: {data.hex()}")
        self.last_ack_data = data
        self.ack_event.set()

    async def _wait_for_ack(self, timeout=3.0):
        """
        等待 ACK 回复
        """
        self.ack_event.clear()
        try:
            await asyncio.wait_for(self.ack_event.wait(), timeout)
            # 从 BLEController 获取数据
            if self.ble_controller:
                return self.ble_controller.ota_ack_data
            return self.last_ack_data
        except asyncio.TimeoutError:
            # logger.warning("Wait for ACK timeout")
            # 根据用户反馈，下位机可能不回复或上位机无需等待，这里改为返回 None 但不报错中断
            # 如果是 CMD_START 后的 ACK，可能真的很重要；如果是扇区 ACK，可能影响流程
            # 暂时保持返回 None，由调用者决定是否重试
            return None

    def _is_unreachable_error(self, exc: Exception) -> bool:
        text = str(exc or "").lower()
        return "unreachable" in text or "not connected" in text

    async def _send_command(self, cmd_id: int, payload: bytes = b"", max_attempts: int = 3, retry_delay: float = 0.3):
        """
        发送命令包
        Structure: <H (Cmd ID) 16s (Payload) H (CRC16)
        """
        # Payload 必须是 16 字节，不足补 0
        if len(payload) < 16:
            payload = payload + b'\x00' * (16 - len(payload))
        elif len(payload) > 16:
            payload = payload[:16]

        # 计算 CRC (Cmd ID + Payload)
        temp_pack = struct.pack("<H 16s", cmd_id, payload)
        crc = self._crc16_ccitt(temp_pack)

        packet = struct.pack("<H 16s H", cmd_id, payload, crc)
        
        logger.info(f"Sending Command: ID=0x{cmd_id:04X}, Payload={payload.hex()}, CRC=0x{crc:04X}")
        last_exc = None
        for attempt in range(1, max_attempts + 1):
            try:
                await self.client.write_gatt_char(COMMAND_CHAR_UUID, packet, response=True)
                return
            except Exception as e:
                last_exc = e
                if attempt < max_attempts and self._is_unreachable_error(e):
                    logger.warning(
                        "Command write unreachable, retrying cmd=0x%04X (%s/%s)",
                        cmd_id, attempt, max_attempts
                    )
                    await asyncio.sleep(retry_delay)
                    continue
                raise

        if last_exc:
            raise last_exc

    async def start_ota(self):
        """
        开始 OTA 流程
        """
        if not os.path.exists(self.file_path):
            logger.error(f"Firmware file not found: {self.file_path}")
            return False

        self.file_size = os.path.getsize(self.file_path)
        self.total_sectors = (self.file_size + SECTOR_SIZE - 1) // SECTOR_SIZE
        
        logger.info(f"Starting OTA. File: {self.file_path}, Size: {self.file_size} bytes, Sectors: {self.total_sectors}")

        # 暂停电量轮询等后台任务
        if self.ble_controller:
            self.ble_controller.set_battery_update_pause(True)
            self.ble_controller.ota_transfer_raw_progress = 0
            self.ble_controller.ota_status = "starting"

        try:
            # 1. 订阅通知
            logger.info("Subscribing to OTA notifications...")
            if self.ble_controller and self.ble_controller.notification_handler:
                try:
                     # 订阅数据 ACK
                     await self.client.start_notify(RECV_FW_CHAR_UUID, self.ble_controller.notification_handler)
                     # 订阅命令 ACK
                     await self.client.start_notify(COMMAND_CHAR_UUID, self.ble_controller.notification_handler)
                     logger.info("OTA notifications subscribed.")
                except Exception as e:
                     logger.warning(f"Failed to subscribe to OTA chars (might already be subscribed?): {e}")

            # 2. 发送开始命令
            # payload: 文件大小 (4 bytes) + 填充
            start_payload = struct.pack("<I", self.file_size) 
            await self._send_command(CMD_OTA_START, start_payload)
            
            # 3. 开始传输扇区
            ack = await self._wait_for_ack(timeout=3.0)
            if not ack:
                 logger.warning("Start CMD ACK timed out, proceeding anyway...")
            else:
                 logger.info(f"Start CMD ACK received: {ack.hex()}")

            current_sector = 0
            max_retries = 5
            retry_count = 0

            with open(self.file_path, "rb") as f:
                while current_sector < self.total_sectors:
                    if retry_count > max_retries:
                        logger.error(f"Max retries exceeded for sector {current_sector}. OTA Aborted.")
                        return False

                    logger.info(f"Transmitting Sector {current_sector}/{self.total_sectors - 1} (Retry: {retry_count})...")
                    
                    # 读取扇区数据
                    f.seek(current_sector * SECTOR_SIZE)
                    sector_data = f.read(SECTOR_SIZE)
                    
                    # 发送并等待结果
                    success, next_sector = await self._send_sector_data(current_sector, sector_data)
                    
                    if success:
                        # 严格步进：只有成功才 +1
                        logger.info(f"Sector {current_sector} ACK OK. Moving to {next_sector}")
                        current_sector = current_sector + 1
                        retry_count = 0 
                        
                        # 进度显示
                        progress = (current_sector / self.total_sectors) * 100
                        if self.ble_controller:
                            self.ble_controller.ota_transfer_raw_progress = round(progress, 1)
                            self.ble_controller.ota_status = "transferring"
                        logger.info(f"Progress: {progress:.1f}%")
                    else:
                        if next_sector is not None:
                            # 明确要求跳转
                            logger.warning(f"Device requested jump to sector {next_sector}")
                            current_sector = next_sector
                            retry_count = 0 
                        else:
                            # 通信超时或未知错误，重试当前扇区
                            logger.warning(f"Sector {current_sector} failed/timeout. Retrying...")
                            retry_count += 1
                            await asyncio.sleep(1.0) 

            # 4. 发送结束命令
            # 注意：部分固件在完成写入后会立即重启，导致 END 写入出现 Unreachable。
            # 若所有扇区已完成，这种瞬断视为“已完成”而非失败。
            try:
                await self._send_command(CMD_OTA_END, max_attempts=2, retry_delay=0.2)
            except Exception as e:
                if current_sector >= self.total_sectors and self._is_unreachable_error(e):
                    logger.warning("OTA END unreachable after all sectors completed; treat as success.")
                else:
                    raise
            logger.info("OTA Update Completed Successfully!")
            if self.ble_controller:
                self.ble_controller.ota_transfer_raw_progress = 100
                self.ble_controller.ota_status = "done"
            return True

        except Exception as e:
            logger.exception(f"OTA Process Exception: {str(e)}")
            if self.ble_controller:
                self.ble_controller.ota_status = "error"
            return False
        finally:
            # 恢复电量轮询
            if self.ble_controller:
                self.ble_controller.set_battery_update_pause(False)

            try:
                await self.client.stop_notify(RECV_FW_CHAR_UUID)
                await self.client.stop_notify(COMMAND_CHAR_UUID)
            except:
                pass

    async def _send_sector_data(self, sector_index: int, data: bytes) -> tuple[bool, int]:
        """
        发送单个扇区数据并等待确认
        """
        # 计算整个扇区的 CRC (用于最后一包)
        sector_crc = self._crc16_ccitt(data)
        
        # 动态计算 MTU 分包大小
        # BleakClient.mtu_size 通常包含了 ATT Header (3 bytes)
        # 实际可用 Payload = mtu_size - 3
        # 安全起见，如果获取不到或异常，回退到 20
        mtu_payload = 20
        if hasattr(self.client, 'mtu_size'):
            mtu_payload = max(20, self.client.mtu_size - 3)
        
        # 我们的协议包结构: Header(3B) + Data(N)
        # 所以 Data(N) = mtu_payload - 3
        # 但如果 MTU 很大 (e.g. 247)，Payload 可以到 244。
        # 只要接收端 ESP32 支持长包即可。
        # 假设 ESP32 端 buffer 足够。
        CHUNK_SIZE = mtu_payload - 3
        
        # 生成分片
        chunks = [data[i:i + CHUNK_SIZE] for i in range(0, len(data), CHUNK_SIZE)]
        
        # 1. 发送数据包 (盲发)
        for seq, chunk in enumerate(chunks):
            # Packet_Seq 循环 (0-255)
            packet_seq = seq % 256
            
            header = struct.pack("<H B", sector_index, packet_seq)
            packet = header + chunk
            
            try:
                await self.client.write_gatt_char(RECV_FW_CHAR_UUID, packet, response=False)
            except Exception as e:
                logger.error(f"Write failed: {e}")
                return False, None
            
            # 流控：每 30 包延时一下，防止拥塞 (大幅减少延时频率)
            if seq % 30 == 0 and seq > 0:
                await asyncio.sleep(0.001)

        # 2. 发送扇区结束包 (Seq = 0xFF, 附带 Sector CRC)
        # 结构: Sector (2B) + 0xFF (1B) + CRC (2B) + Padding...
        end_payload = struct.pack("<H", sector_crc) # 2 bytes CRC
        # 补齐 0 到 16 字节 Payload (总长 3+16=19)
        end_payload += b'\x00' * (16 - 2) 
        
        end_header = struct.pack("<H B", sector_index, 0xFF)
        end_packet = end_header + end_payload 
        
        logger.debug(f"Sending End Packet (0xFF): Sector={sector_index}, CRC=0x{sector_crc:04X}")
        
        try:
            # 最后一包盲发，然后等待 ACK
            await self.client.write_gatt_char(RECV_FW_CHAR_UUID, end_packet, response=False)
        except Exception as e:
            logger.error(f"End packet write failed: {e}")
            return False, None

        # 3. 等待 ACK (超时 5 秒 - 增加超时以等待 Flash 写入)
        ack = await self._wait_for_ack(timeout=5.0)
        
        if not ack:
            logger.error(f"Sector {sector_index} ACK timeout")
            return False, None
        
        # 4. 解析 ACK
        if len(ack) >= 6:
            try:
                # ACK 格式: [Sector_Index(2), Status(2), Expected_Sector(2)...]
                recv_sector = struct.unpack_from("<H", ack, 0)[0]
                status = struct.unpack_from("<H", ack, 2)[0]
                
                if status == ACK_SUCCESS:
                    return True, sector_index + 1 # 成功，期望 +1
                
                elif status == ACK_ERROR: # 0x0002 Sector Error
                    expected_sector = struct.unpack_from("<H", ack, 4)[0]
                    logger.warning(f"Sector Error. Recv: {recv_sector}, Status: {status}, Expected: {expected_sector}")
                    return False, expected_sector
                
                else:
                    logger.error(f"ACK Error Status: 0x{status:04X}, RecvSector: {recv_sector}")
                    return False, None
            except Exception as e:
                logger.error(f"ACK parse error: {e}")
                return False, None
        else:
            logger.error(f"Invalid ACK length: {len(ack)}")
            return False, None
