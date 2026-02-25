import asyncio
from bleak import BleakClient

# BLE配置
DEVICE_ADDR = "24:0A:C4:86:6C:DD"
TX_UUID = "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"
RX_UUID = "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"

class ESP32PeripheralProtocol:
    HEADER = b'\xAA\x55'
    FOOTER = b'\x0D\x0A'
    
    # 设备类型定义
    DEV_SERVO = 0x01 # 舵机
    DEV_CAP_KEY = 0x02 # 电容式按键
    
    def __init__(self):
        self.client = None
        self.buffer = bytearray()
        self.callbacks = {}
        
    async def connect(self):
        self.client = BleakClient(DEVICE_ADDR)
        await self.client.connect()
        await self.client.start_notify(TX_UUID, self._notification_handler)
        print("Connected to ESP32")
    
    async def disconnect(self):
        await self.client.disconnect()
    
    def register_callback(self, device_type, callback):
        self.callbacks[device_type] = callback
    
    async def read_single(self, device_addr):
        """读取单个设备状态"""
        frame = bytearray()
        frame.extend(self.HEADER)
        frame.append(0x01)  # 单设备读
        frame.append(device_addr)
        frame.append(0x00)  # 数据长度0
        frame.extend(self.FOOTER)
        await self.client.write_gatt_char(RX_UUID, frame)
    
    async def write_single(self, device_addr, data):
        """控制单个设备"""
        frame = bytearray()
        frame.extend(self.HEADER)
        frame.append(0x02)  # 单设备写
        frame.append(device_addr)
        frame.append(len(data))
        frame.extend(data)
        frame.extend(self.FOOTER)
        await self.client.write_gatt_char(RX_UUID, frame)
    
    async def read_multiple(self, device_addrs):
        """批量读取设备状态"""
        frame = bytearray()
        frame.extend(self.HEADER)
        frame.append(0x03)  # 批量读
        frame.append(0xFF)  # 批量标识
        frame.append(len(device_addrs))
        frame.extend(device_addrs)
        frame.extend(self.FOOTER)
        await self.client.write_gatt_char(RX_UUID, frame)
    
    async def write_multiple(self, commands):
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
        await self.client.write_gatt_char(RX_UUID, frame)
    
    def _notification_handler(self, sender, data: bytearray):
        self.buffer.extend(data)
        while len(self.buffer) >= 6:  # 最小帧长度
            # 查找帧头
            start_idx = self.buffer.find(self.HEADER)
            if start_idx == -1:
                self.buffer.clear()
                return
                
            if start_idx > 0:
                self.buffer = self.buffer[start_idx:]
                continue
                
            # 检查最小长度
            if len(self.buffer) < 6:
                return
                
            # 获取数据长度
            data_len = self.buffer[4]
            total_len = 6 + data_len + 2  # 头4B + 数据 + 尾2B
            
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
        data = frame[5:5+data_len] if data_len > 0 else b''
        
        # 单设备响应
        if op_type == 0x81:
            if device_addr in self.callbacks:
                self.callbacks[device_addr](data)
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
            if data_len > 0 and data[0] != 0:
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
            dev_data = data[index:index+dev_data_len]
            index += dev_data_len
            
            if dev_addr in self.callbacks:
                self.callbacks[dev_addr](dev_data)
            else:
                print(f"Bulk data from device {dev_addr:02X}: {dev_data.hex()}")


# 使用示例
async def main():
    protocol = ESP32PeripheralProtocol()
    
    # 注册设备回调
    def temp_capkey_callback(data):
        if len(data) == 1:
            temp = data[0]
            print(f"key status: {temp}")
    
    protocol.register_callback(ESP32PeripheralProtocol.DEV_CAP_KEY, temp_capkey_callback)
    
    def servo_callback(data):
        if data:
            angle = data[0]
            print(f"Servo angle: {angle}°")
    
    protocol.register_callback(ESP32PeripheralProtocol.DEV_SERVO, servo_callback)
    
    # 连接设备
    await protocol.connect()
    
    try:
        # 读取电容式按键状态
        await protocol.read_single(ESP32PeripheralProtocol.DEV_CAP_KEY)
        
        # 设置舵机角度
        await protocol.write_single(ESP32PeripheralProtocol.DEV_SERVO, bytes([90]))
        
        # 批量读取温湿度和光照
        await asyncio.sleep(1)
        await protocol.read_multiple([
            ESP32PeripheralProtocol.DEV_TEMP_HUMID,
            ESP32PeripheralProtocol.DEV_LIGHT
        ])
        
        # 批量设置设备
        await asyncio.sleep(1)
        await protocol.write_multiple([
            (ESP32PeripheralProtocol.DEV_SERVO, bytes([45])),
            (ESP32PeripheralProtocol.DEV_LED, bytes([1]))
        ])
        
        # 持续运行
        while True:
            await asyncio.sleep(1)
            
    except KeyboardInterrupt:
        pass
    finally:
        await protocol.disconnect()

if __name__ == "__main__":
    asyncio.run(main())