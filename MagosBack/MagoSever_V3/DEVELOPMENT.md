# MagosServer 开发文档

## 1. 项目概述

MagosServer 是一个基于 Flask 的 Web 服务器应用，主要用于控制 Magos 机器人。它提供了一个直观的 Blockly 积木编程界面，允许用户通过拖拽积木来编写机器人控制代码，并支持蓝牙通信、音频播放、数独游戏和视觉识别等功能。

### 1.1 目标用户

- 教育机构：用于机器人编程教学
- 开发者：用于开发和测试机器人应用
- 机器人爱好者：用于控制和探索机器人功能

### 1.2 主要功能

- **Blockly 积木编程**：提供可视化编程界面，支持简体中文和繁体中文以及英文语言切换
- **蓝牙通信**：与 Magos 机器人进行蓝牙连接和通信
- **机器人控制**：通过编程控制机器人的动作、表情和音频
- **数独游戏**：集成数独游戏功能，支持记录游戏数据
- **视觉识别**：支持视觉识别功能，用于给老人院老人做动作
- **音频播放**：支持背景音乐播放和暂停
- **数据管理**：提供数据管理页面（预留功能）

## 2. 技术架构

### 2.1 技术栈

- **后端框架**：Python Flask
- **蓝牙通信**：Bleak 库
- **数据处理**：Pandas库
- **前端技术**：HTML/CSS/JavaScript/Vue/Webpack
- **可视化编程**：Blockly

### 2.2 项目结构

```
MagosServer/
├── HttpServer/
│   ├── actions_group/          # 机器人动作组JSON文件
│   ├── myFlask.py              # Flask应用主类
│   ├── mylib/                  # 库文件目录
│   │   ├── BLE.py              # 蓝牙通信实现
│   │   ├── ESP_BLE.py          # ESP32蓝牙通信（备用）
│   │   ├── Magos.py            # 机器人控制类
│   │   └── robot_data.py       # 机器人数据管理
│   ├── static/                 # 静态资源文件
│   │   ├── assets/             # 前端资源
│   │   ├── data.json           # 数据文件
│   │   ├── images/             # 图片资源
│   │   └── myJavaScript/       # JavaScript文件
│   └── templates/              # 前端模板
│       ├── DataManager.html    # 数据管理页面
│       ├── RehabCam.html       # 视觉识别页面
│       ├── index.html          # 主页面
│       ├── shudu.html          # 数独游戏页面
│       └── test.html           # 测试页面
├── README.md                   # 项目说明
├── app.py                      # 项目入口文件
├── pyproject.toml              # Python项目配置
├── requirements.txt            # 依赖包列表
└── uv.lock                     # 依赖锁定文件
```

### 2.3 核心模块关系

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   app.py        │────▶│  myFlask.py     │────▶│   Magos.py      │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                    │
                                                    ▼
                                              ┌─────────────────┐
                                              │    BLE.py       │
                                              └─────────────────┘
                                                    │
                                                    ▼
                                              ┌─────────────────┐
                                              │ 机器人硬件        │
                                              └─────────────────┘
```

## 3. 安装与配置

### 3.1 环境要求

- Python 3.13
- Windows 操作系统（蓝牙功能依赖于 Windows 蓝牙服务）
- 蓝牙适配器（支持 BLE）

### 3.2 安装步骤

### 方法一 （正常方法）

1. 克隆或下载项目代码

2. 安装依赖包
   
   ```bash
   pip install -r requirements.txt
   ```

3. 启动服务器
   
   ```bash
   python app.py
   ```

4. 访问应用
   
   - 浏览器会自动打开 `http://localhost:5500`
   - 如果没有自动打开，请手动在浏览器中输入地址

### 方法二 (使用UV管理工具)

* 克隆或下载项目代码

* 在Windows中安装uv   [安装 | uv 中文文档](https://uv.doczh.com/getting-started/installation/)
  
  ```powershell
  powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
  ```

* 进入vscode打开该项目
  
  ```cmd
  venv\Scripts\activate
  ```

* 启动服务器
  
  ```cmd
  uv run app.py
  ```

* 访问应用
  
  * 浏览器会自动打开 `http://localhost:5500`
  * 如果没有自动打开，请手动在浏览器中输入地址

### 3.3 配置说明

- **端口配置**：在 `app.py` 中修改 `_port` 参数
- **蓝牙设备名称**：沟通林工（林焕文）
- **动作组配置**：在 `HttpServer/actions_group/` 目录下添加或修改Blockly中动作组的 JSON 文件

### 3.4 开发环境设置

1. 安装 Python 3.13
2. 安装依赖包：`pip install -r requirements.txt`
3. 安装开发工具：推荐使用 VS Code 或 PyCharm ，Tear
4. 启用调试模式：在 `app.py` 中设置 `_debug=True`

## 4. 核心功能模块

### 4.1 Flask 应用模块

**文件**：`HttpServer/myFlask.py`

**功能**：

- 初始化 Flask 应用
- 注册路由和视图函数
- 管理蓝牙连接
- 处理前端请求

**核心类**：`FlaskApp`

**主要方法**：

- `__init__()`：初始化应用，设置路由和蓝牙连接
- `_configure_app()`：配置 Flask 应用
- `_register_routes()`：注册所有路由
- `BLE_inti_()`：用于蓝牙的所有初始化
- `BLE_Refresh()`：刷新蓝牙设备列表
- `BLE_Connect()`：连接蓝牙设备
- `BLE_Disconnect()`：断开蓝牙连接
- `RunPythonCode()`：执行 Blockly 生成的 Python 代码
- `VoicePlay()`：使用Magos内部的语言合成模块来生成对应的声音

### 4.2 机器人控制模块

**文件**：`HttpServer/mylib/Magos.py`

**功能**：

- 控制机器人的动作、表情和音频
- 执行动作组
- 管理机器人数据

**核心类**：`MagosRobot`

**主要方法**：

- `play_audio(voice)`：播放音频
- `play_background_audio(index)`：播放背景音乐
- `stop_background_audio()`：停止背景音乐
- `change_emoji(index)`：改变机器人表情
- `set_robot_server(index, angle, duration)`：设置单个舵机角度
- `animations_start(animations_name)`：执行动作组
- `_execute_motion_frame()`：给下位机发送位置信息（不推荐修改）
- `get_all_servos_positions()`：获取下位机所有舵机位置（不推荐修改）

### 4.3 蓝牙通信模块

**文件**：`HttpServer/mylib/BLE.py`

**功能**：

- 扫描和连接蓝牙设备
- 发送和接收蓝牙数据
- 实现自定义通信协议

**核心类**：

- `BLEController`：蓝牙控制器，负责底层蓝牙通信
- `BLEWorker`：蓝牙工作者，提供高级通信接口

**主要方法**：

- `connect(device_name)`：连接蓝牙设备
- `disconnect()`：断开蓝牙连接
- `write_single(device_addr, data)`：控制单个设备
- `write_multiple(commands)`：批量控制设备
- `is_connected()`：检查蓝牙连接状态

### 4.4 Blockly 编程模块（新的项目WebPack）

**文件**：前端代码（`HttpServer/static/assets/bundle.js`）

**功能**：

- 提供可视化积木编程界面
- 支持代码生成和执行
- 支持主题和语言切换

## 5. API 接口

### 5.1 页面路由

| 路由           | 方法  | 功能                |
| ------------ | --- | ----------------- |
| `/`          | GET | 主页面（Blockly 编程界面） |
| `/to_shudu`  | GET | 数独游戏页面            |
| `/to_habcam` | GET | 视觉识别页面            |
| `/to_data`   | GET | 数据管理页面            |

### 5.2 蓝牙接口

| 路由                | 方法   | 功能       | 请求参数      | 返回值              |
| ----------------- | ---- | -------- | --------- | ---------------- |
| `/BLE_Refresh`    | GET  | 刷新蓝牙设备列表 | 无         | JSON 格式的设备列表     |
| `/BLE_Connect`    | POST | 连接蓝牙设备   | 设备名称（请求体） | "True" 或 "False" |
| `/BLE_Disconnect` | GET  | 断开蓝牙连接   | 无         | "True" 或 "False" |
| `/BLE_State`      | GET  | 获取蓝牙连接状态 | 无         | "True" 或 "False" |

### 5.3 控制接口

| 路由               | 方法   | 功能         | 请求参数                           | 返回值          |
| ---------------- | ---- | ---------- | ------------------------------ | ------------ |
| `/RunPythonCode` | POST | 执行Python代码 | JSON 格式的代码对象 `{"code": "..."}` | 代码执行输出       |
| `/VoicePlay`     | POST | 播放音频       | 音频文本（请求体）                      | "True" 或错误信息 |

## 6. 开发指南

### 6.1 添加新功能

1. 在 `myFlask.py` 中注册新路由
2. 实现对应的视图函数
3. 如果需要，在前端模板中添加相应的UI元素
4. 在 `Magos.py` 中添加机器人控制方法
5. 更新 `BLE.py` 以支持新的通信协议

### 6.2 添加新动作组（需要使用PyQt来进行开发）

1. 在 `HttpServer/actions_group/` 目录下创建新的 JSON 文件
2. 按照以下格式定义动作组：

```json
[
  {
    "joint_angles": [角度1, 角度2, ...],
    "duration": 持续时间
  },
  ...
]
```

### 6.3 调试技巧

- 使用 `print()` 语句输出调试信息
- 检查蓝牙连接状态
- 查看浏览器控制台的 JavaScript 错误
- 使用 Flask 的调试模式（`_debug=True`）

## 7. 部署说明

### 7.1 本地部署

1. 确保所有依赖已安装
2. 运行 `python app.py` 启动服务器
3. 访问 `http://localhost:5500`

### 7.2 打包部署

参考 `打包请看.md` 文件的说明进行打包部署。

## 8. 注意事项

1. 蓝牙功能仅在 Windows 操作系统上可用，依赖于 Windows 蓝牙服务
2. 确保机器人已开启并处于可连接状态
3. 动作组文件必须符合指定的 JSON 格式
4. 长时间运行可能会导致内存占用增加，建议定期重启服务器
5. 首次连接蓝牙设备时可能需要输入配对码（通常为 0000 或 1234）
6. Blockly 生成的 Python 代码需要遵循特定的语法规则，避免使用不安全的操作
7. 视觉识别功能目前为预留接口，需要额外配置才能使用

## 9. 故障排除

### 9.1 蓝牙连接问题

- 确保蓝牙适配器已启用
- 检查机器人是否已开启并处于可连接状态
- 尝试重新扫描蓝牙设备
- 关闭其他可能占用蓝牙的应用程序
- 重启计算机和机器人

### 9.2 机器人无响应

- 检查蓝牙连接状态
- 确保动作组文件格式正确
- 检查舵机角度是否在有效范围内（通常为 0-180 度）
- 尝试重新连接机器人

### 9.3 服务器启动失败

- 检查 Python 版本是否符合要求
- 确保所有依赖包已正确安装
- 检查端口是否被占用
- 查看控制台输出的错误信息
