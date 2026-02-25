# Magos Blockly 开发文档

## 1. 项目概述

Magos Blockly 是一个基于 Google Blockly 的可视化编程环境，专为 Magos 机器人设计。用户可以通过拖拽积木块的方式创建程序，然后将生成的代码下载或直接运行到 Magos 机器人上。

### 核心功能

- 基于 Blockly 的可视化编程界面
- 支持生成 Python 代码
- 代码运行和保存功能
- 蓝牙设备连接与控制
- 主题切换（深色/浅色）
- 多语言支持（简体中文、繁体中文、英文）
- 背景音乐播放控制

## 2. 快速开始

### 2.1 环境要求

- Node.js 14.x 或更高版本
- npm 6.x 或更高版本

### 2.2 安装依赖

```bash
npm install
```

### 2.3 开发模式

```bash
npm run start
```

该命令将启动一个开发服务器，默认监听 3000 端口，并自动打开浏览器访问应用程序。

### 2.4 构建生产版本

```bash
npm run build
```

构建后的文件将输出到 `dist` 目录。

## 3. 项目结构

```
Magos_Webpack/
├── .npmignore            # npm 忽略文件配置
├── .vscode/              # VS Code 配置
├── dist/                 # 构建输出目录
├── package-lock.json     # npm 依赖锁定文件
├── package.json          # 项目配置文件
├── public/               # 公共资源目录
│   └── data.json         # 动画和音频数据
├── src/                  # 源代码目录
│   ├── assets/           # 静态资源
│   │   └── images/       # 图片资源
│   ├── blocks/           # Blockly 自定义块定义
│   │   └── hans_text.js  # 中文文本块定义
│   ├── generators/       # 代码生成器
│   │   ├── javascript.js # JavaScript 代码生成器
│   │   └── mypython.js   # Python 代码生成器
│   ├── index.css         # 全局样式
│   ├── index.html        # 主页面模板
│   ├── index.js          # 主逻辑文件
│   └── libs/             # 工具库和插件
│       ├── mytoolbox.js  # 工具箱配置
│       ├── plugins/      # Blockly 插件
│       └── serialization.js # 序列化工具
└── webpack.config.js     # Webpack 配置文件
```

## 4. 核心功能模块

### 4.1 可视化编程界面

基于 Blockly 实现的可视化编程界面，用户可以通过拖拽积木块创建程序。

**主要文件**：

- `src/index.js`：Blockly java script 初始化和配置
- `src/libs/plugins`：Blockly 的插件库
- `src/libs/serialization.js`：Blockly库的浏览器缓存和加载
- `src/libs/mytoolbox.js`：Blockly的工具箱配置
- `src/blocks/hans_text.js`：自定义块定义
- `src/generators/mypython.js`：自定义块的代码定义

**核心功能**：

- 积木块拖拽和连接
- 积木块配置和编辑
- 工作区缩放和滚动
- 网格对齐功能

### 4.2 代码生成与运行

将 Blockly 积木程序转换为 Python 代码，并提供运行和保存功能。

**主要文件**：

- `src/generators/mypython.js`：Python 代码生成器
- `src/index.js`：代码运行和保存功能

**核心功能**：

- 将积木程序转换为 Python 代码
- 代码语法高亮显示
- 运行生成的代码
- 保存代码到本地文件

### 4.3 蓝牙设备控制

通过蓝牙连接到 Magos 机器人设备，并发送控制命令。

**主要文件**：

- `src/index.js`：蓝牙设备连接和控制功能

**核心功能**：

- 扫描蓝牙设备
- 连接到指定设备
- 断开设备连接
- 发送控制命令

### 4.4 多语言与主题支持

支持多语言切换和主题切换功能。

**主要配置属性**：

- `src/index.js中lang`：多语言配置

**核心功能**：

- `changeLang()`：简体中文、繁体中文、英文支持
- `changeTheme()`：深色/浅色主题切换

### 4.5 背景音乐控制

提供背景音乐播放和暂停功能。

**核心功能**：

- `displaySongs()`音乐列表显示
- `searchSongs(query)`音乐搜索功能
- `playVoice()和pauseVoice()`：播放和暂停控制

## 5. 自定义块开发

### 5.1 创建自定义块

在 `src/libs/mytoolbox.js` 文件下创建自定义块定义文件，例如：

```javascript
// src/blocks/custom_blocks.js
import * as Blockly from 'blockly/core';

export const customBlocks = [
  {
    type: 'custom_block_type',
    message0: '自定义块 %1',
    args0: [
      {
        type: 'input_value',
        name: 'VALUE',
        check: 'String'
      }
    ],
    previousStatement: null,
    nextStatement: null,
    colour: 160,
    tooltip: '自定义块的提示信息',
    helpUrl: ''
  }
];
```

### 5.2 代码生成器

在 `src/generators/` 目录下创建对应的代码生成器，例如：

```javascript
// src/generators/mypython.js
export const forBlock = Object.create(null);

forBlock["custom_block_type"] = function (block, generator) {
  const value = generator.valueToCode(block, 'VALUE', generator.ORDER_ATOMIC);
  return `custom_function(${value})\n`;
};
```

## 5.3 给工具箱添加自己的自定义块

在 `src/libs/mytoolbox.js`文件寻找下面Magos控制，然后再contents中添加自定义的块

```
{
      kind: "category",
      name: "Magos控制",
      colour: 100,
      contents: [
        {
          kind: "block",
          type: "custom_block_type",
        },
```

## 6. 代码生成器开发

### 6.1 创建代码生成器

在 `src/generators/` 目录下创建代码生成器文件：

```javascript
// src/generators/mygenerator.js
export const forBlock = Object.create(null);

// 为每个块类型定义代码生成逻辑
forBlock["block_type"] = function (block, generator) {
  // 获取块的字段值
  const fieldValue = block.getFieldValue("FIELD_NAME");
  // 获取输入值
  const inputValue = generator.valueToCode(block, 'INPUT_NAME', generator.ORDER_ATOMIC);
  // 生成代码
  return `generated_code(${fieldValue}, ${inputValue})\n`;
};
```

### 6.2 注册代码生成器

在 `src/index.js` 中注册代码生成器：

```javascript
import { forBlock } from './generators/mygenerator';
import { pythonGenerator } from 'blockly/python';

Object.assign(pythonGenerator.forBlock, forBlock);
```

## 7. Webpack 配置

项目使用 Webpack 进行模块打包和构建，配置文件为 `webpack.config.js`。

### 7.1 主要配置项

- **入口文件**：`src/index.js`
- **输出目录**：`dist/`
- **开发服务器**：监听 3000 端口
- **插件**：
  - HtmlWebpackPlugin：生成 HTML 文件
  - CopyWebpackPlugin：复制静态资源

### 7.2 构建命令

```bash
# 开发模式
npm run start

# 生产模式
npm run build
```

## 8. 部署指南

### 8.1 构建生产版本

```bash
npm run build
```

构建后的文件将输出到 `dist/` 目录。

### 8.2 部署到服务器

将 `dist/` 目录下的所有文件部署到 Web 服务器的根目录或指定目录。

## 9. 开发规范

### 9.1 代码规范

- 使用 ES6+ 语法
- 遵循 JavaScript 编码规范
- 使用 2 个空格缩进
- 函数和变量命名使用驼峰式

### 9.2 提交规范

- 使用语义化提交信息
- 每次提交只包含一个功能或修复
- 提交前确保代码通过编译

## 10. 故障排除

### 10.1 常见问题

1. **Blockly 工作区不显示**

   - 检查 `src/index.js` 中的 Blockly 初始化代码
   - 确保 DOM 元素 `blocklyDiv` 存在
2. **代码生成错误**

   - 检查自定义块的定义是否正确
   - 确保代码生成器与块定义匹配
3. **蓝牙连接失败**

   - 确保蓝牙设备已开启并处于可发现状态
   - 检查设备名称是否正确
