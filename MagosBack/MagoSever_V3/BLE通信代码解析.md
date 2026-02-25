# BLE

## BLEController

数据头：\xAA\x55

数据尾：\x0D\x0A

通知特征：6E400003-B5A3-F393-E0A9-E50E24DCCA9E

写入通知：6E400002-B5A3-F393-E0A9-E50E24DCCA9E

**帧结构: [帧头][操作码][目标地址][数据长度][数据][帧尾]**

**协议传输的字节串为：帧头(2)+操作码(1)+目标地址(1)+数据长度(1)+数据(x)+帧尾(2)**

### notification_handler方法：用于解析下位机传来的数据

1. 如果找不到帧头就把全部初始化received数据并返回

2. 找到帧头的位置,去除帧头前面的数据

3. 如果received的长度不超过5就返回,等待下一次的检验

4. 校验的方法：数据串从1开始到x异或,最终的值为校验值就通过

### create_frame方法：用于创建协议帧传给下位机

1. 先写入帧头

2. 在计算数据的长度

3. 添加数据

4. 然后计算数据的异或和作为校验值

5. 最后添加帧尾

### connect_directly 异步方法：用于连接已知设备名称蓝牙设备

1. 通过BleakScanner库来通过**目标设备的名称**来搜索蓝牙Device

2. 如果没有返回False,否则返回蓝牙的Device用于下面连接

3. 通过BleakClient来连接蓝牙设备

4. 如果提供特殊的回调方法就使用回调方法，否则使用默认解析方法

5. 更改设备的连接状态为True并且返回True

### connect 异步循环方法：用于连接蓝牙设备

1. 使用BleakScanner来扫描附近设备,返回周围的所有蓝牙设备

2. 如果找到了目标设备就会进行下一步,否则俩秒后重新执行一遍

3. 使用BleakScanner通过地址来找该蓝牙设备

4. 如果没有找到就返回

5. 使用BleakClient来连接设备,添加回调方法：默认解析方法

### BLE_scan 异步方法 ：用于扫描附件的蓝牙设备

### send_data 异步方法 ：用于发送数据

1. 先判断现在是否在连接状态中和存不存在设备

2. 使用client(BleakScanner)来发送data数据

### main_loop 异步循环方法 ：用于循环整个通信流程

1. 如果不是连接状态,就会进行重连,重连失败就等待俩秒重新执行

2. 否则,发送连接成功注释

3. 每当间隔时间超过send_interval时就会发送数据给下位机,然后更新最后的间隔时间

4. 每次循环都会等待0.1s减少性能花销

---

## BLEWorker

#### 属性

```python
    # 帧头 帧尾
    HEADER = b'\xAA\x55'
    FOOTER = b'\x0D\x0A'

    #操作码
    OP_READ_SINGLE = 0x01   #处理单个读取操作
    OP_WRITE_SINGLE = 0x02  #处理单个写入操作
    OP_READ_BULK = 0x03     #处理批量读取操作
    OP_WRITE_BULK= 0x04     #处理批量写入操作
    # OP_WRITE_XG  = 0x06
    # OP_WRITE_HY
    OP_WRITE_MP3 = 0x08     #播放背景音乐
    OP_WRITE_EMOJI = 0x09   #控制表情
    DEV_Servo_lock = 0xA5   #舵机锁
    OP_POWER       = 0xB0   #电量

    # 设备类型定义 目标地址
    DEV_SERVO_BASE = 0x01 # 舵机基地址 舵机1地址
    DEV_SERVO_1 = 0x01 # 舵机1地址
    DEV_SERVO_2 = 0x02 # 舵机2地址
    DEV_SERVO_3 = 0x03 # 舵机3地址
    DEV_SERVO_4 = 0x04 # 舵机4地址
    DEV_SERVO_5 = 0x05 # 舵机5地址
    DEV_SERVO_6 = 0x06 # 舵机6地址
    DEV_SERVO_7 = 0x07 # 舵机7地址
    DEV_SERVO_8 = 0x08 # 舵机8地址
    DEV_SERVO_9 = 0x09 # 舵机9地址
    DEV_SERVO_10 = 0x0A # 舵机10地址
 
    servo_multiple_read_addrs = [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A] # 批量读取舵机地址
    Battery     =0xFF   #电量
    Set_Show_V  =0XFC   #设置电量显示
    DEV_CAP_KEY_BASE = 0xA1 # 电容式按键基地址
    DEV_CAP_KEY_1 = 0xA1 # 电容式按键1地址
    DEV_CAP_KEY_2 = 0xA2 # 电容式按键2地址

    key_multiple_read_addrs = [0xA1, 0xA2] # 批量读取电容式按键地址

    DEV_VOICE_BASE = 0xB1 # 语音设备基地址
```

使用的传输帧：**[帧头][操作码][目标地址][数据长度][数据][帧尾]**

### scan 方法：用于获取附近的设备

1. 调用BLEController中的BLE_scan异步方法来获取设备

2. 更新devices_found的值

### connect 方法 ：通过指定设备名称来连接设备

1. 通过BLEController中的connect_directly方法来连接设备

2. 然后检测是否成功连接

### send_data 方法 ：发送数据给下位机

调用BLEController中的send_data异步方法

### register_callback 方法：注册回调

### read_single 方法：通过设备地址来发送读取请求

1. 传入帧头

2. 接上0x01代表但设备读

3. 接上目标设备的地址

4. 接上数据长度为0

5. 接上帧尾

6. 使用send_data来发送该字节串

### write_single 方法 ：通过设备地址来发送数据

1. 传入帧头

2. 接上0x02代表要写数据到设备里

3. 接上目标设备的地址

4. 接上数据的长度

5. 接上数据

6. 接上帧尾

7. 使用send_data来发送该字符串

### _notification_handler 方法 ：处理data字符串

1. 如果找不到帧头就清除该data字符串并返回

2. 截取从帧头开始的数据

3. 如果数据长度小于7就返回

4. 如果长度达不到  帧头+操作码+目标地址+[数据长度]+数据长度+帧尾的话就返回

5. 提取从帧头到帧尾的数据

6. 验证帧尾是否正确

7. 通过_Parse_frame俩解析该字符串

### _parse_frame 方法 ：解析下位机传来的数据

1. 根据op操作数来进行各种响应

2. 单设备响应：0x81,如果目标设备地址有回调函数就会执行回调函数，否则print目标设备和数据

3. 多设备响应：0x82,调用_parse_bulk_data来处理

4. 事件上报 ：0xF0,如果该设备有回调函数就会调用其回调函数

5. 写操作响应 ：0x02,0x04,如果data长度大于0并且data[0]不等于0就会返回错误码？？？？？？

### _parse_bulk_data 方法 ：解析批量数据

1. 通过指针形式来解析长串数据

2. 然后在进行回调处理

# 屏幕
## 数据帧
1. 表情
 [#][X][#][\n]
 X=1~8
2. 电量
 [+][x][\n]
 x=数据
3. 设置电量显示
 [s][x][\n]
 x=0不显示，x=1显示；