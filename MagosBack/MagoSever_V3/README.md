# MagosServer

MagosServer 是一个基于 Flask 的 Web 服务器应用，主要用于控制 Magos 机器人，提供可视化编程界面和多种交互功能。

## 主要功能

- **Blockly 积木编程**：通过拖拽积木编写机器人控制代码
- **蓝牙通信**：与 Magos 机器人进行无线连接和通信
- **机器人控制**：控制机器人的动作、表情和音频
- **数独游戏**：集成数独游戏功能
- **视觉识别**：支持视觉识别功能（预留接口）
- **音频播放**：支持背景音乐播放和暂停

## 技术栈

- **后端**：Python Flask
- **蓝牙**：Bleak 库
- **前端**：HTML/CSS/JavaScript
- **可视化编程**：Blockly

## 快速开始

### 环境要求

- Python 3.7+
- Windows 操作系统（蓝牙功能依赖）

### 安装步骤

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
   - 如果没有自动打开，请手动输入地址

## 使用说明

### 1. 连接机器人

1. 点击"扫描"按钮搜索蓝牙设备
2. 从下拉列表中选择 Magos 机器人
3. 点击"连接"按钮建立连接

### 2. 编写程序

1. 从左侧积木库拖拽积木到工作区
2. 组合积木创建机器人控制逻辑
3. 点击运行按钮执行程序

### 3. 控制机器人

- 使用动作积木控制机器人的动作
- 使用表情积木改变机器人的表情
- 使用音频积木播放声音

## 项目结构

```
MagosServer/
├── HttpServer/              # 主应用目录
│   ├── actions_group/      # 机器人动作组
│   ├── myFlask.py          # Flask应用
│   ├── mylib/              # 核心库
│   ├── static/             # 静态资源
│   └── templates/          # 前端模板
├── app.py                  # 项目入口
└── requirements.txt        # 依赖包列表
```

## 开发文档

详细的开发文档请查看 [DEVELOPMENT.md](DEVELOPMENT.md) 文件。

## 许可证

本项目采用 MIT 许可证。
