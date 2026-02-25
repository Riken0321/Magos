# 电量显示调试指南

## 问题现象
后端成功传回电量数据，但UI界面无法显示。

## 修复内容

### 1. 添加详细日志
前端已添加详细的控制台日志，用于追踪数据流：
- `[Battery] Polling /api/robot/status...` - API请求开始
- `[Battery] API response received:` - 收到后端响应
- `[Battery] Display set to:` - UI更新完成

### 2. 电池文本多语言支持
在 `language` 对象中添加了电池相关文本：
```javascript
{
  BatteryDisconnected: "電量：--",
  BatteryLabel: "電量：",
}
```
- hans (简体中文): `BatteryDisconnected`, `BatteryLabel`
- hant (繁体中文): `BatteryDisconnected`, `BatteryLabel`
- en (英文): `BatteryDisconnected`, `BatteryLabel`

### 3. 保护电池显示
修改 `setInnerTextIf()` 函数，防止其他语言切换操作覆盖动态电池显示。

### 4. 改进的电池更新逻辑
- `setBatteryDisconnected()` - 使用多语言文本
- `setBatteryConnected()` - 使用多语言前缀和电量值
- `updateBatteryFromStatus()` - 详细的类型检查和日志
- `fetchBatteryStatus()` - 改进的错误处理和日志

## 调试步骤

### 步骤 1: 检查浏览器控制台
1. 打开浏览器 F12 → 控制台 (Console)
2. 搜索 `[Battery]` 开头的日志
3. 查看完整的数据流，例如：
   ```
   [Battery] Starting battery status polling (interval: 2000ms)
   [Battery] Polling /api/robot/status...
   [Battery] API response received: {is_connected: true, status: "idle", battery: 82}
   [Battery] is_connected: true -> coerced: true
   [Battery] Setting battery display to: 82%
   [Battery] Display set to: 電量：82%
   ```

### 步骤 2: 检查网络请求
1. F12 → Network 标签
2. 筛选 `status` 请求
3. 查看 Response 格式是否为：
   ```json
   {
     "is_connected": true,
     "status": "idle",
     "battery": 82
   }
   ```

### 步骤 3: 验证HTML元素
在控制台输入：
```javascript
console.log(document.getElementById("BtnBattery"));
console.log(document.getElementById("BtnBattery").textContent);
```

### 步骤 4: 手动测试
在控制台模拟后端响应：
```javascript
// 模拟连接状态，电量 75%
updateBatteryFromStatus({
  is_connected: true,
  status: "idle",
  battery: 75
});

// 模拟断开连接
updateBatteryFromStatus({
  is_connected: false,
  status: "idle",
  battery: null
});
```

## 后端接口需求

确保后端 `/api/robot/status` 端点返回以下格式：

```json
{
  "is_connected": true,
  "status": "idle",
  "battery": 82
}
```

**字段说明：**
- `is_connected` (必选): 布尔值 (true/false)
- `status` (必选): 字符串 ("idle", "running", "paused")
- `battery` (可选): 整数 (0-100) 或 null

## 常见问题

### Q1: 显示 "電量：--"
- 原因：设备未连接或电池值为null
- 检查：后端返回的 `is_connected` 是否为 true，`battery` 是否有值

### Q2: 显示不更新
- 原因：API调用失败或轮询间隔过长
- 检查：浏览器控制台是否有错误，Network标签中是否有status请求

### Q3: 显示被语言切换覆盖
- 原因：已修复，`setInnerTextIf()` 现在会跳过 BtnBattery
- 检查：不应该再出现此问题

### Q4: 显示格式不对
- 原因：多语言配置可能缺失
- 检查：language对象中是否包含BatteryLabel和BatteryDisconnected

## 关键代码位置

| 功能 | 位置 |
|------|------|
| 电池轮询启动 | `startBatteryStatusPolling()` |
| API调用 | `fetchBatteryStatus()` |
| 数据处理 | `updateBatteryFromStatus(data)` |
| UI更新 | `setBatteryConnected()` / `setBatteryDisconnected()` |
| 多语言配置 | `language` 对象的 BatteryLabel/BatteryDisconnected |
| 防止覆盖 | `setInnerTextIf()` 函数 |

## 性能参数

- 轮询间隔: `BATTERY_POLL_MS` = 2000ms (2秒)
- 低电量阈值: `BATTERY_LOW_THRESHOLD` = 20%
- 请求超时: BATTERY_POLL_MS - 200 = 1800ms

## CSS样式

电池显示的CSS类：
- `.is-muted` - 设备未连接时的灰色样式
- `.is-low` - 电量低于20%时的红色样式

## 验证清单

- [ ] 浏览器控制台显示 `[Battery] Starting battery status polling...` 日志
- [ ] 后端返回正确的JSON格式
- [ ] 页面上 `#BtnBattery` 元素显示电量数字
- [ ] 切换语言后电池显示不被覆盖
- [ ] 低电量时显示红色样式
- [ ] 设备断开连接时显示"--"
