import * as Blockly from "blockly";
import { hans_blocks, setActionsLanguage } from "./blocks/hans_text";
import { forBlock } from "./generators/mypython";
import { pythonGenerator } from "blockly/python";
import { registerFieldAngle } from "./libs/plugins/field-angle";
import { save, load } from "./libs/serialization";
import { toolbox } from "./libs/mytoolbox";
import * as hans from "blockly/msg/zh-hans";
import * as hant from "blockly/msg/zh-hant";
import * as en from "blockly/msg/en";
import "./index.css";
import LwFirewords from 'lw_firewords'
registerFieldAngle();
Blockly.common.defineBlocks(hans_blocks);
// Blockly.defineBlocksWithJsonArray(blocks)
Object.assign(pythonGenerator.forBlock, forBlock);
// 设置属性

//鼠标启动烟花
const lw_f = new LwFirewords();//创建实例
lw_f.init();//启动事件

// ============ 将 mytoolbox 的分类颜色同步到分类内所有 blocks ============
function buildCategoryBlockColourMap() {
  const map = new Map();
  const categories = toolbox?.contents || [];
  const PROCEDURE_BLOCK_TYPES = [
    "procedures_defnoreturn",
    "procedures_defreturn",
    "procedures_callnoreturn",
    "procedures_callreturn",
    "procedures_ifreturn",
  ];
  const VARIABLE_BLOCK_TYPES = [
    "variables_get",
    "variables_set",
    "variables_get_dynamic",
    "variables_set_dynamic",
  ];
  categories.forEach((cat) => {
    if (!cat || cat.kind !== "category") return;
    const colour = cat.colour;
    if (cat.contents) {
      cat.contents.forEach((item) => {
        if (!item || item.kind !== "block" || !item.type) return;
        map.set(item.type, colour);
      });
    }
    if (cat.custom === "PROCEDURE") {
      PROCEDURE_BLOCK_TYPES.forEach((type) => map.set(type, colour));
    }
    if (cat.custom === "VARIABLE_DYNAMIC" || cat.custom === "VARIABLE") {
      VARIABLE_BLOCK_TYPES.forEach((type) => map.set(type, colour));
    }
  });
  return map;
}

function applyCategoryBlockColours() {
  const map = buildCategoryBlockColourMap();
  map.forEach((colour, type) => {
    const blockDef = Blockly.Blocks?.[type];
    if (!blockDef || blockDef.__categoryColourPatched) return;
    const originalInit = blockDef.init;
    if (typeof originalInit !== "function") return;
    blockDef.init = function initWithCategoryColour() {
      originalInit.call(this);
      if (colour !== undefined && colour !== null && this.setColour) {
        this.setColour(colour);
      }
    };
    blockDef.__categoryColourPatched = true;
  });
}

applyCategoryBlockColours();

let songs = [];
let isPlay = false;
let isDeleteMode = false;
let inputTimer = null;
let ConnectedDevice = "";
let currentLanguage = "hant";
let targetConnectDevice = "";
let isDeviceScanAnimating = false;
const STATUS_IDLE = 0;
const STATUS_RUNNING = 1;
const STATUS_PAUSED = 2;
const STATUS_DISCONNECTED = 3;
let currentRobotStatus = STATUS_IDLE;

// ============ 新增：轮询配置与状态管理 ============
const POLL_MS = 1000; // 轮询间隔（ms）
let pollTimerId = null; // 轮询定时器 ID
let isPlayButtonDisabled = false; // 防连点标志
let isTaskRequestInProgress = false; // Play 相关请求锁（start/pause/resume）
let isResetRequestInProgress = false; // Reset 请求锁
const RESET_TIMEOUT_MS = 5000; // reset 超时保护（ms）

// ============================================

const BATTERY_POLL_MS = 2000;
const BATTERY_LOW_THRESHOLD = 20;
const BATTERY_DISCONNECTED_TEXT = "電量：--";
const BATTERY_LABEL_PREFIX = "電量：";
const language = {
  hans: {
    BtnConnectPanel: "连接",
    BtnInterfacePanel: "界面",
    BtnWindowPanel: "视窗",
    BtnExportPanel: "导出",
    BtnImportPanel: "导入",
    BtnBatteryDisplayPanel: "电量显示",
    BtnNetworkPanel: "网络",
    BtnHelpPanel: "帮助",
    CodePanelTitle: "代码面板",
    GamesTitle: "更多游戏",
    PanelConnectTop: "连接",
    ParagraphScan: "扫描设备",
    ParagraphConnect: "连接设备",
    ParagraphDisConnect: "断开连接",
    PanelInterfaceTop: "界面",
    ParagraphLanguage: "语言选择",
    ParagraphTheme: "主题选择",
    PanelWindowTop: "视窗",
    ParagraphCodePanel: "代码面板",
    ParagraphMusicPanel: "寻找音乐",
    ParagraphGmaesPanel: "更多游戏",
    PanelExporeTop: "导出",
    PanelImportTop: "导入",
    PanelHelpTop: "帮助",
    PanelNetworkTop: "网络",
    ParagraphExport: "导出代码",
    ParagraphImport: "导入代码",
    ParagraphHelp: "获取帮助",
    ParagraphMusicTitle: "音乐播放清单",
    BtnUploadMusic: "上传音乐",
    BtnDeleteMusic: "删除",
    BtnDeleteMusicConfirm: "确定",
    BtnExport: "导出",
    BtnImport: "确定",
    BtnGetHelp: "获取帮助",
    BtnNetworkRestart: "重启",
    ParagraphNetworkRestart: "重启网络",
    NetworkRestartSuccess: "网络重启成功",
    NetworkRestartFailed: "网络重启失败",
    BtnConnect: "确定",
    BtnDisConnect: "确定",
    State_Scaning: "扫描中",
    StateBLE_Connected: "已连接",
    StateBLE_Connecting: "连接中",
    StateBLE_Disconnected: "未连接",
    LanguageList_hant: "繁体中文",
    LanguageList_hans: "简体中文",
    LanguageList_en: "英文",
    ThemeList_Dark: "深色",
    ThemeList_Light: "浅色",
    MusicInputPlaceholder: "|搜索音乐",
    BatteryDisconnected: "电量：--",
    BatteryLabel: "电量：",
    ParagraphRename: "更改名称",
    BtnRename: "确定",
    Rename_NotConnected: "未连接不可改名",
    Rename_Empty: "名称不能为空",
    Rename_TooLong: "名称过长(>31 bytes)",
    Rename_Failed: "重命名失败",
    Rename_Success: "重命名成功",
    ParagraphNetworkLogin: "网络登录",
    BtnNetworkLogin: "登录",
    DialogNetworkLoginTitle: "网络登录",
    NetworkAccountLabel: "账号：",
    NetworkPasswordLabel: "密码：",
    BtnNetworkLoginConfirm: "确认",
    NetworkLoginAccountInvalid: "账号长度需 1~32 字节",
    NetworkLoginPasswordInvalid: "密码长度需 6~63 字节",
    NetworkLoginSuccess: "登录成功",
    NetworkLoginFailed: "登录失败",
  },
  hant: {
    BtnConnectPanel: "連接",
    BtnInterfacePanel: "介面",
    BtnWindowPanel: "視窗",
    BtnExportPanel: "導出",
    BtnImportPanel: "導入",
    BtnBatteryDisplayPanel: "電量顯示",
    BtnNetworkPanel: "網絡",
    BtnHelpPanel: "幫助",
    CodePanelTitle: "代碼面板",
    GamesTitle: "更多遊戲",
    PanelConnectTop: "連接",
    ParagraphScan: "掃描設備",
    ParagraphConnect: "連接設備",
    ParagraphDisConnect: "斷開連接",
    PanelInterfaceTop: "介面",
    ParagraphLanguage: "語言選擇",
    ParagraphTheme: "主題選擇",
    PanelWindowTop: "視窗",
    ParagraphCodePanel: "代碼面板",
    ParagraphMusicPanel: "尋找音樂",
    ParagraphGmaesPanel: "更多遊戲",
    PanelExporeTop: "導出",
    PanelImportTop: "導入",
    PanelNetworkTop: "網絡",
    PanelHelpTop: "幫助",
    ParagraphExport: "導出代碼",
    ParagraphImport: "導入代碼",
    ParagraphHelp: "取得幫助",
    ParagraphMusicTitle: "音樂播放清單",
    BtnUploadMusic: "上傳音樂",
    BtnDeleteMusic: "刪除",
    BtnDeleteMusicConfirm: "確定",
    BtnExport: "導出",
    BtnNetworkRestart: "重啟",
    ParagraphNetworkRestart: "重啟網絡",
    NetworkRestartSuccess: "網絡重啟成功",
    NetworkRestartFailed: "網絡重啟失敗",
    BtnImport: "確定",
    BtnGetHelp: "取得幫助",
    BtnConnect: "確定",
    BtnDisConnect: "確定",
    State_Scaning: "掃描中",
    StateBLE_Connected: "已連接",
    StateBLE_Connecting: "連接中",
    StateBLE_Disconnected: "未連接",
    LanguageList_hant: "繁體中文",
    LanguageList_hans: "簡體中文",
    LanguageList_en: "英文",
    ThemeList_Dark: "深色",
    ThemeList_Light: "淺色",
    MusicInputPlaceholder: "|搜尋音樂",
    BatteryDisconnected: "電量：--",
    BatteryLabel: "電量：",
    ParagraphRename: "更改名稱",
    BtnRename: "確定",
    Rename_NotConnected: "未連接不可改名",
    Rename_Empty: "名稱不能為空",
    Rename_TooLong: "名稱過長(>31 bytes)",
    Rename_Failed: "重命名失敗",
    Rename_Success: "重命名成功",
    ParagraphNetworkLogin: "網絡登入",
    BtnNetworkLogin: "登入",
    DialogNetworkLoginTitle: "網絡登入",
    NetworkAccountLabel: "帳號：",
    NetworkPasswordLabel: "密碼：",
    BtnNetworkLoginConfirm: "確認",
    NetworkLoginAccountInvalid: "帳號長度需 1~32 位元組",
    NetworkLoginPasswordInvalid: "密碼長度需 6~63 位元組",
    NetworkLoginSuccess: "登入成功",
    NetworkLoginFailed: "登入失敗",
  },
  en: {
    BtnConnectPanel: "Connect",
    BtnInterfacePanel: "Interface",
    BtnNetworkPanel: "Network",
    BtnWindowPanel: "Window",
    BtnExportPanel: "Export",
    BtnImportPanel: "Import",
    BtnBatteryDisplayPanel: "Battery Display",
    BtnHelpPanel: "Help",
    CodePanelTitle: "Code Panel",
    GamesTitle: "More Games",
    PanelConnectTop: "Connect",
    ParagraphScan: "Scan Device",
    ParagraphConnect: "Connect Device",
    ParagraphDisConnect: "Disconnect",
    PanelInterfaceTop: "Interface",
    ParagraphLanguage: "Language Selection",
    ParagraphTheme: "Theme Selection",
    PanelWindowTop: "Window",
    ParagraphCodePanel: "Code Panel",
    PanelNetworkTop: "Network",
    ParagraphMusicPanel: "Find Music",
    ParagraphGmaesPanel: "More Games",
    PanelExporeTop: "Export",
    PanelImportTop: "Import",
    PanelHelpTop: "Help",
    ParagraphExport: "Export Code",
    ParagraphImport: "Import Code",
    ParagraphHelp: "Get Help",
    ParagraphMusicTitle: "Music Playlist",
    BtnUploadMusic: "Upload",
    ParagraphNetworkRestart: "Restart Network",
    BtnNetworkRestart: "Restart",
    NetworkRestartSuccess: "Network restarted successfully",
    NetworkRestartFailed: "Network restart failed",
    BtnDeleteMusic: "Delete",
    BtnDeleteMusicConfirm: "Confirm",
    BtnExport: "Export",
    BtnImport: "Confirm",
    BtnGetHelp: "Get Help",
    BtnConnect: "Confirm",
    BtnDisConnect: "Confirm",
    State_Scaning: "Scanning",
    StateBLE_Connected: "Connected",
    StateBLE_Connecting: "Connecting",
    StateBLE_Disconnected: "Disconnected",
    LanguageList_hant: "Traditional Chinese",
    LanguageList_hans: "Simplified Chinese",
    LanguageList_en: "English",
    ThemeList_Dark: "Dark",
    ThemeList_Light: "Light",
    MusicInputPlaceholder: "|Search music",
    BatteryDisconnected: "Battery: --",
    BatteryLabel: "Battery: ",
    ParagraphRename: "Rename",
    BtnRename: "Confirm",
    Rename_NotConnected: "Cannot rename: not connected",
    Rename_Empty: "Name cannot be empty",
    Rename_TooLong: "Name too long (>31 bytes)",
    Rename_Failed: "Rename failed",
    Rename_Success: "Rename successful",
    ParagraphNetworkLogin: "Network Login",
    BtnNetworkLogin: "Login",
    DialogNetworkLoginTitle: "Network Login",
    NetworkAccountLabel: "Account:",
    NetworkPasswordLabel: "Password:",
    BtnNetworkLoginConfirm: "Confirm",
    NetworkLoginAccountInvalid: "Account must be 1~32 bytes",
    NetworkLoginPasswordInvalid: "Password must be 6~63 bytes",
    NetworkLoginSuccess: "Login successful",
    NetworkLoginFailed: "Login failed",
  },
};

// ============ Toolbox 分类多语言映射表 ============
const TOOLBOX_CATEGORY_I18N = {
  logic: {
    hant: "邏輯",
    hans: "逻辑",
    en: "Logic"
  },
  loop: {
    hant: "循環",
    hans: "循环",
    en: "Loops"
  },
  math: {
    hant: "數學",
    hans: "数学",
    en: "Math"
  },
  text: {
    hant: "文本",
    hans: "文本",
    en: "Text"
  },
  list: {
    hant: "列表",
    hans: "列表",
    en: "Lists"
  },
  variable: {
    hant: "變量",
    hans: "变量",
    en: "Variables"
  },
  function: {
    hant: "函數",
    hans: "函数",
    en: "Functions"
  },
  magos: {
    hant: "Magos控制",
    hans: "Magos控制",
    en: "Magos Control"
  }
};
// ============================================

// 当前语言文本
const StateBLE = document.getElementById("StateBLE");
const MusicInput = document.getElementById("MusicInput");
const GamesTitle = document.getElementById("GamesTitle");
const ParagraphScan = document.getElementById("ParagraphScan");
const ContainerScan = document.getElementById("ContainerScan");
const CodePanelTitleText = document.getElementById("CodePanelTitleText");
const ParagraphTheme = document.getElementById("ParagraphTheme");
const PanelWindowTop = document.getElementById("PanelWindowTop");
const PanelExporeTop = document.getElementById("PanelExporeTop");
const PanelImportTop = document.getElementById("PanelImportTop");
const PanelHelpTop = document.getElementById("PanelHelpTop");
const ThemeList_Dark = document.getElementById("ThemeList").options[1];
const ParagraphExport = document.getElementById("ParagraphExport");
const ParagraphImport = document.getElementById("ParagraphImport");
const PanelConnectTop = document.getElementById("PanelConnectTop");
const LanguageList_en = document.getElementById("LanguageList").options[2];
const ThemeList_Light = document.getElementById("ThemeList").options[0];
const ContainerDevice = document.getElementById("ContainerDevice");
const ParagraphConnect = document.getElementById("ParagraphConnect");
const ParagraphLanguage = document.getElementById("ParagraphLanguage");
const PanelInterfaceTop = document.getElementById("PanelInterfaceTop");
const LanguageList_hant = document.getElementById("LanguageList").options[0];
const LanguageList_hans = document.getElementById("LanguageList").options[1];
const ParagraphCodePanel = document.getElementById("ParagraphCodePanel");
const ParagraphSongTitle = document.getElementById("ParagraphSongTitle");
const ParagraphDisConnect = document.getElementById("ParagraphDisConnect");
const ParagraphRename = document.getElementById("ParagraphRename");
const ParagraphMusicPanel = document.getElementById("ParagraphMusicPanel");
const ParagraphGmaesPanel = document.getElementById("ParagraphGmaesPanel");
const ParagraphMusicTitle = document.getElementById("ParagraphMusicTitle");
const ParagraphHelp = document.getElementById("ParagraphHelp");
const ParagraphNetworkRestart = document.getElementById("ParagraphNetworkRestart");
const ParagraphSongArtist = document.getElementById("ParagraphSongArtist");
const UploadMusic = document.getElementById("Upload_Music");
const DeleteMusic = document.getElementById("Delete_Music");
const UploadMusicInput = document.getElementById("Upload_Music_Input");

// div对象
const CodePanel = document.getElementById("CodePanel");
const BlocklyDiv = document.getElementById("blocklyDiv");
const PanelMusicMid = document.getElementById("PanelMusicMid");
const MinigameContainer = document.getElementById("MinigameContainer");

// 弹窗对象
const PanelMusic = document.getElementById("PanelMusic");
const PanelWindow = document.getElementById("PanelWindow");
const PanelExport = document.getElementById("PanelExpore");
const PanelImport = document.getElementById("PanelImport");
const PanelHelp = document.getElementById("PanelHelp");
const PanelConnect = document.getElementById("PanelConnect");
const PanelInterface = document.getElementById("PanelInterface");

// Btn对象
const BtnPlay = document.getElementById("BtnPlay");
const BtnReset = document.getElementById("BtnReset");
const BtnClear = document.getElementById("BtnClear");
const BtnReturn = document.getElementById("BtnReturn");
const BtnUndo = document.getElementById("BtnUndo");
const BtnMusic = document.getElementById("BtnMusic");
const BtnExport = document.getElementById("BtnExport");
const BtnImport = document.getElementById("BtnImport");
const BtnConnect = document.getElementById("BtnConnect");
const BtnMusicPlay = document.getElementById("BtnMusicPlay");
const BtnMusicLeft = document.getElementById("BtnMusicLeft");
const BtnMusicRight = document.getElementById("BtnMusicRight");
const BtnMusicOrder = document.getElementById("BtnMusicOrder");
const BtnDisConnect = document.getElementById("BtnDisConnect");
const BtnRename = document.getElementById("BtnRename");
const BtnDeviceScan = document.getElementById("BtnDeviceScan");
const BtnWindowPanel = document.getElementById("BtnWindowPanel");
const BtnExportPanel = document.getElementById("BtnExportPanel");
const BtnImportPanel = document.getElementById("BtnImportPanel");
const BtnBatteryDisplayPanel = document.getElementById("BtnBatteryDisplayPanel");
const BtnNetworkPanel = document.getElementById("BtnNetworkPanel");
const BtnHelpPanel = document.getElementById("BtnHelpPanel");
const BtnBattery = document.getElementById("BtnBattery");
const BtnConnectPanel = document.getElementById("BtnConnectPanel");
const BtnInterfacePanel = document.getElementById("BtnInterfacePanel");
const BtnThemeSelectLeft = document.getElementById("BtnThemeSelectLeft");
const BtnThemeSelectRight = document.getElementById("BtnThemeSelectRight");
const BtnDeviceSelectLeft = document.getElementById("BtnDeviceSelectLeft");
const BtnDeviceSelectRight = document.getElementById("BtnDeviceSelectRight");
const BtnLanguageSelectLeft = document.getElementById("BtnLanguageSelectLeft");
const BtnLanguageSelectRight = document.getElementById(
  "BtnLanguageSelectRight"
);
const BtnCodePanelSelectRight = document.getElementById(
  "BtnCodePanelSelectRight"
);
const BtnCodePanelSelectLeft = document.getElementById(
  "BtnCodePanelSelectLeft"
);
const BtnMusicPanelSelectLeft = document.getElementById(
  "BtnMusicPanelSelectLeft"
);
const BtnMusicPanelSelectRight = document.getElementById(
  "BtnMusicPanelSelectRight"
);
const BtnCloseCodePanel = document.getElementById("BtnCloseCodePanel");
const BtnGamesPanelSelectLeft = document.getElementById(
  "BtnGamesPanelSelectLeft"
);
const BtnGamesPanelSelectRight = document.getElementById(
  "BtnGamesPanelSelectRight"
);
const BtnGetHelp = document.getElementById("BtnGetHelp");
const BtnNetworkRestart = document.getElementById("BtnNetworkRestart");
const PanelNetwork = document.getElementById("PanelNetwork");
const PanelNetworkTop = document.getElementById("PanelNetworkTop");

// 网络登录相关
const ParagraphNetworkLogin = document.getElementById("ParagraphNetworkLogin");
const BtnNetworkLogin = document.getElementById("BtnNetworkLogin");
const DialogNetworkLogin = document.getElementById("DialogNetworkLogin");
const DialogNetworkLoginTitle = document.getElementById("DialogNetworkLoginTitle");
const NetworkAccountLabel = document.getElementById("NetworkAccountLabel");
const NetworkPasswordLabel = document.getElementById("NetworkPasswordLabel");
const NetworkLoginAccountInput = document.getElementById("NetworkLoginAccountInput");
const NetworkLoginPasswordInput = document.getElementById("NetworkLoginPasswordInput");
const BtnNetworkLoginConfirm = document.getElementById("BtnNetworkLoginConfirm");
const DialogNetworkLoginMask = document.getElementById("DialogNetworkLoginMask");

// Select对象
const ThemeList = document.getElementById("ThemeList");
const DeviceList = document.getElementById("DeviceList");
const LanguageList = document.getElementById("LanguageList");
const CodePanelList = document.getElementById("CodePanelList");
const MusicPanelList = document.getElementById("MusicPanelList");
const GamesPanelList = document.getElementById("GamesPanelList");

// 显示对象
const CodeText = document.getElementById("CodeText");
const ws = Blockly.inject(document.getElementById("blocklyDiv"), {
  toolbox: toolbox,
  media: "https://unpkg.com/blockly/media/",
  scrollbars: true,
  trashcan: false,
  renderer: "zelos",
  // theme: DarkTheme,
  grid: {
    spacing: 30,
    length: 10,
    colour: "#ccc",
    snap: true,
  },
  zoom: {
    controls: false, // 禁用默认缩放控件
    // wheel: true,
    startScale: 1.0,
    maxScale: 3,
    minScale: 0.3,
    scaleSpeed: 1.2,
  },
});

// ============ 新增：长按左键拖动工作区功能 ============
(function enableLongPressDrag() {
  let longPressTimer = null;
  let isDragging = false;
  let startX = 0, startY = 0;
  let startScrollX = 0, startScrollY = 0;
  // 长按时间阈值（毫秒），可根据手感微调
  const LONG_PRESS_DELAY = 100; 
  // 手抖容差（像素），按下后微小移动不取消长按
  const DRAG_TOLERANCE = 5;     

  const container = document.getElementById("blocklyDiv");

  const stopDrag = () => {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    if (isDragging) {
      isDragging = false;
      container.style.cursor = ""; // 恢复默认光标
    }
  };

  container.addEventListener("pointerdown", (e) => {
    // 1. 仅限鼠标左键 (button 0)
    if (e.button !== 0) return;

    // 2. 防误触检测：检查点击目标
    const t = e.target;
    // 如果点击了积木（Draggable）、工具栏、飞出菜单、滚动条、缩放控件、垃圾桶，则忽略
    if (t.closest(".blocklyDraggable") || 
        t.closest(".blocklyToolboxDiv") || 
        t.closest(".blocklyFlyout") || 
        t.closest(".blocklyScrollbarHandle") || 
        t.closest(".blocklyZoom") ||
        t.closest(".blocklyTrash")) {
      return;
    }

    // 记录初始状态
    startX = e.clientX;
    startY = e.clientY;
    startScrollX = ws.scrollX;
    startScrollY = ws.scrollY;

    // 启动长按计时
    longPressTimer = setTimeout(() => {
      isDragging = true;
      container.style.cursor = "move"; // 改变光标提示用户已激活
    }, LONG_PRESS_DELAY);
  });

  document.addEventListener("pointermove", (e) => {
    // 阶段A: 正在等待长按触发
    if (longPressTimer && !isDragging) {
      const moveX = Math.abs(e.clientX - startX);
      const moveY = Math.abs(e.clientY - startY);
      // 如果移动幅度超过容差，视为用户想点击或普通拖动，取消长按判定
      if (moveX > DRAG_TOLERANCE || moveY > DRAG_TOLERANCE) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
      return;
    }

    // 阶段B: 长按触发成功，正在拖拽
    if (isDragging) {
      // 阻止默认行为（如选中文本等）
      e.preventDefault(); 
      
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      
      // 更新工作区滚动位置
      // 这会让画布跟随鼠标移动
      ws.scroll(startScrollX + dx, startScrollY + dy);
    }
  });

  // 释放鼠标或离开窗口时结束
  document.addEventListener("pointerup", stopDrag);
  document.addEventListener("pointercancel", stopDrag);
})();
// ====================================================


// ============ 设备连接状态 UI 更新 ===========
function updateConnectedDeviceUI() {
  if (!DeviceList) return;

  if (ConnectedDevice && ConnectedDevice !== "") {
    // 已连接：显示真实设备名，禁用选择
    DeviceList.innerHTML = "";
    const opt = new Option(ConnectedDevice, ConnectedDevice);
    opt.selected = true;
    DeviceList.add(opt);
    DeviceList.disabled = true;
  } else {
    // 未连接：恢复选择状态
    DeviceList.disabled = false;
    
    // 智能保留：如果列表已经包含了预置选项（如A/B/C）且没有处于残留的连接状态，则保留
    // 判断标准：如果列表为空，或者只有1个且不是 placeholder（说明是之前连接的设备名）
    const isLeftoverConnected = DeviceList.options.length === 1 && DeviceList.options[0].value !== "";
    const isEmpty = DeviceList.options.length === 0;

    if (isEmpty || isLeftoverConnected) {
      DeviceList.innerHTML = "";
      const placeholder = new Option("选择蓝牙设备", "");
      placeholder.disabled = true;
      placeholder.selected = true;
      DeviceList.add(placeholder);
    } else {
      // 列表已有内容（如 A, B, C），不执行清空，仅重置选中
      // 注意：resetDeviceListSelection 定义在后面，但函数提升使其可用
      if (typeof resetDeviceListSelection === "function") {
        resetDeviceListSelection();
      } else {
        DeviceList.selectedIndex = 0;
        targetConnectDevice = "";
      }
    }
  }

  // Update Rename Button status
  if (BtnRename) {
    const isConnected = (ConnectedDevice && ConnectedDevice !== "");
    BtnRename.disabled = !isConnected;
    BtnRename.classList.toggle("is-disabled", !isConnected);
  }
}
//初始化更新连接设备的UI
updateConnectedDeviceUI();

// ============ 缩放比例提示：只在点击放大/缩小按钮时显示 ===========
(function initZoomTooltip() {
  // 创建提示 DOM（只创建一次，复用）
  const tooltip = document.createElement("div");
  tooltip.id = "blocklyZoomTooltip";
  tooltip.style.display = "none";
  document.body.appendChild(tooltip);

  let hideTimer = null;
  let lastTrigger = null;

  function getZoomButtonFromEvent(event) {
    const target = event && event.target;
    if (!target || !target.closest) return null;
    const btn = target.closest("#BtnBlocklyZoomIn, #BtnBlocklyZoomOut, .blocklyZoomIn, .blocklyZoomOut");
    if (!btn) return null;
    if (btn.classList.contains("blocklyZoomReset")) return null;
    return btn;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  /**
   * 显示缩放比例提示
   * @param {HTMLElement} buttonElem - 被点击的按钮元素
   */
  function showZoomScale(buttonElem) {
    if (!buttonElem) return;

    // 使用 requestAnimationFrame（两次）确保读取到点击后的 scale
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const scale = ws.scale;
        const percent = Math.round(scale * 100) + "%";
        tooltip.textContent = percent;

        // 先显示 tooltip，确保能获取到其尺寸
        tooltip.style.display = "block";

        // 获取按钮和提示框的位置信息
        const btnRect = buttonElem.getBoundingClientRect();
        const tooltipRect = tooltip.getBoundingClientRect();

        // 计算位置：按钮左侧 8px，垂直居中
        let left = btnRect.left - tooltipRect.width - 8;
        let top = btnRect.top + btnRect.height / 2 - tooltipRect.height / 2;

        // 边界保护：不让提示框跑出屏幕
        left = clamp(left, 8, window.innerWidth - tooltipRect.width - 8);
        top = clamp(top, 8, window.innerHeight - tooltipRect.height - 8);

        tooltip.style.left = `${left}px`;
        tooltip.style.top = `${top}px`;

        // 覆盖式计时：清除旧定时器，设置新定时器
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
          tooltip.style.display = "none";
          hideTimer = null;
        }, 1000);
      });
    });
  }

  function handleZoomTrigger(event) {
    const btn = getZoomButtonFromEvent(event);
    if (!btn) return;
    lastTrigger = btn;
    showZoomScale(btn);
  }

  // 捕获阶段监听，优先 pointerdown，click 兜底
  document.addEventListener("pointerdown", handleZoomTrigger, true);
  document.addEventListener("click", (event) => {
    // 如果 pointerdown 已处理过同一个按钮，仍允许 click 刷新比例（以最新缩放为准）
    const btn = getZoomButtonFromEvent(event);
    if (!btn) return;
    lastTrigger = btn;
    showZoomScale(btn);
  }, true);
})();


// ============ Custom Blockly Controls (Zoom & Trash) ============
(function initCustomBlocklyControls() {
  const btnZoomIn = document.getElementById("BtnBlocklyZoomIn");
  const btnZoomOut = document.getElementById("BtnBlocklyZoomOut");
  const btnTrash = document.getElementById("BtnBlocklyTrash");

  // Zoom Logic
  if (btnZoomIn) {
    btnZoomIn.addEventListener("click", () => {
      ws.zoomCenter(1);
    });
  }
  if (btnZoomOut) {
    btnZoomOut.addEventListener("click", () => {
      ws.zoomCenter(-1);
    });
  }

  // Trashcan Logic
  if (btnTrash) {
    // 1) Click to Delete All (Restored)
    btnTrash.addEventListener("click", (e) => {
      e.stopPropagation(); // Stop propagation to prevent interfering with other panels

      // Confirm before clearing
      const confirmMsg = {
         hant: "確定要清空工作區的所有積木嗎？",
         hans: "确定要清空工作区的所有积木吗？",
         en: "Are you sure you want to delete all blocks?"
      };
      
      const msg = confirmMsg[currentLanguage] || confirmMsg.en;
      
      if (confirm(msg)) {
         // Perform clear
         if (typeof ClearCode === 'function') {
             ClearCode();
         } else {
             ws.clear();
         }
      }
    });

    // 2) Drag and Drop Deletion
    let draggingBlockId = null;
    let isHoveringTrash = false;

    // Track if user is dragging over trashcan
    document.addEventListener("pointermove", (e) => {
      if (!draggingBlockId) return;

      const rect = btnTrash.getBoundingClientRect();
      const x = e.clientX;
      const y = e.clientY;

      // Check intersection
      const isOver = x >= rect.left && x <= rect.right &&
                     y >= rect.top && y <= rect.bottom;
      
      if (isOver !== isHoveringTrash) {
         isHoveringTrash = isOver;
         if (isHoveringTrash) {
             btnTrash.classList.add("drag-over");
         } else {
             btnTrash.classList.remove("drag-over");
         }
      }
    });

    // Listen to Blockly Events for Drag Start/End
    ws.addChangeListener((e) => {
      // Filter for drag events
      if (e.type === Blockly.Events.BLOCK_DRAG) {
        if (e.isStart) {
          draggingBlockId = e.blockId;
        } else {
          // Drag End
          if (draggingBlockId && isHoveringTrash) {
             const block = ws.getBlockById(draggingBlockId);
             if (block && block.isDeletable()) {
                 block.dispose(true);
             }
             // Reset UI
             btnTrash.classList.remove("drag-over");
          }
          draggingBlockId = null;
          isHoveringTrash = false;
        }
      }
    });
  }
})();

// ============ Toolbox 分类图标：只影响左侧分类列表（不改积木/不改 toolbox 定义）===========
function normalizeCategoryLabelText(text) {
  return String(text || "")
    .replace(/\s+/g, "")
    .trim()
    .toLowerCase();
}

function getCategoryIconKeyFromLabel(labelText) {
  const t = normalizeCategoryLabelText(labelText);

  if (!t) return null;

  if (t === "邏輯" || t === "逻辑" || t === "logic") return "logic";
  if (t === "循環" || t === "循环" || t === "loop" || t === "loops") return "loop";
  if (t === "數學" || t === "数学" || t === "math") return "math";
  if (t === "文本" || t === "文字" || t === "text") return "text";
  if (t === "列表" || t === "list" || t === "lists") return "list";
  if (t === "變量" || t === "变量" || t === "variable" || t === "variables")
    return "variable";
  if (t === "函數" || t === "函数" || t === "function" || t === "functions")
    return "function";
  if (t === "magos控制" || t === "magoscontrol" || t === "magos") return "magos";

  return null;
}

const CATEGORY_COLOR_MAP = (() => {
  const map = new Map();
  const categories = toolbox?.contents || [];
  categories.forEach((cat) => {
    if (!cat || cat.kind !== "category" || !cat.name) return;
    map.set(normalizeCategoryLabelText(cat.name), cat.colour);
  });
  return map;
})();

function formatCategoryColour(colour) {
  if (typeof colour === "string") return colour;
  if (typeof colour === "number") {
    const hueToHex = Blockly?.utils?.colour?.hueToHex;
    if (typeof hueToHex === "function") return hueToHex(colour);
    return `hsl(${colour}, 100%, 50%)`;
  }
  return "";
}

function getCategoryColourByLabel(labelText) {
  const key = normalizeCategoryLabelText(labelText);
  const colour = CATEGORY_COLOR_MAP.get(key);
  return formatCategoryColour(colour);
}

function applyToolboxCategoryIcons() {
  const toolboxDiv = document.querySelector(".blocklyToolboxDiv");
  if (!toolboxDiv) return;

  const rows = toolboxDiv.querySelectorAll(".blocklyTreeRow");
  rows.forEach((row) => {
    const label = row.querySelector(".blocklyTreeLabel");
    const key = getCategoryIconKeyFromLabel(label?.textContent);
    const colour = getCategoryColourByLabel(label?.textContent);
    if (key) {
      row.dataset.categoryIcon = key;
    } else {
      delete row.dataset.categoryIcon;
    }
    // 只在颜色未设置时才设置颜色（保持初始颜色不变）
    if (colour && !row.style.getPropertyValue("--category-color")) {
      row.style.setProperty("--category-color", colour);
    }
  });
}

function observeToolboxForCategoryIcons() {
  const toolboxDiv = document.querySelector(".blocklyToolboxDiv");
  if (!toolboxDiv) return;

  let scheduled = false;
  const scheduleApply = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      applyToolboxCategoryIcons();
    });
  };

  // 初次应用
  scheduleApply();

  // toolbox 可能会在展开/折叠/重绘时变动，使用轻量 observer 保持图标一致
  const observer = new MutationObserver(scheduleApply);
  observer.observe(toolboxDiv, { childList: true, subtree: true });
}

// 等待 toolbox DOM 完成挂载后再观察
setTimeout(() => {
  observeToolboxForCategoryIcons();
}, 0);

function bindUndoRedo() {
  if (!BtnReturn || !BtnUndo || !ws) {
    console.warn("Undo/redo init skipped: missing BtnReturn/BtnUndo or ws.");
    return;
  }
  BtnReturn.addEventListener("click", () => ws.undo(false));
  BtnUndo.addEventListener("click", () => ws.undo(true));
}

bindUndoRedo();

// #region 事件声明
function ShowCode() {
  var code = pythonGenerator.workspaceToCode(ws);
  CodeText.innerText = code;
}

function applyRobotStatus(status) {
  currentRobotStatus = status;
  const isPlay = status === STATUS_IDLE || status === STATUS_PAUSED;
  const isPause = status === STATUS_RUNNING;
  if (BtnPlay) {
    BtnPlay.classList.toggle("is-play", isPlay);
    BtnPlay.classList.toggle("is-pause", isPause);
  }
}

function notifyRunStatusError(message) {
  if (!message) return;
  console.log(message);
  alert(message);
}

// ============ 新增：轮询驱动状态管理 ============
/**
 * 启动轮询，定期查询 /api/status
 * 根据返回的 status 驱动前端状态机与 UI
 */
function startPolling() {
  if (pollTimerId !== null) {
    console.warn("Polling already running");
    return;
  }

  pollTimerId = setInterval(async () => {
    try {
      const response = await fetch("/api/status", { method: "GET" });
      if (!response.ok) {
        throw new Error("Failed to fetch status");
      }
      const data = await response.json();
      const serverStatus = data.status;

      console.log("Poll status response:", data);

      // 根据服务器返回的状态驱动前端状态机
      if (serverStatus === "running") {
        applyRobotStatus(STATUS_RUNNING);
      } else if (serverStatus === "paused") {
        applyRobotStatus(STATUS_PAUSED);
      } else if (serverStatus === "done") {
        // 任务完成，自动回到 IDLE，停止轮询
        console.log("Task completed");
        applyRobotStatus(STATUS_IDLE);
        stopPolling();
      } else if (serverStatus === "error") {
        // 任务出错，自动回到 IDLE，停止轮询
        console.error("Task error detected on server");
        notifyRunStatusError("任务执行出错，请检查代码或设备连接。");
        applyRobotStatus(STATUS_IDLE);
        stopPolling();
      }
    } catch (error) {
      console.error("Polling error:", error);
      // 网络错误不应该改变前端状态，但应该输出日志
    }
  }, POLL_MS);

  console.log("Polling started with interval:", POLL_MS, "ms");
}

/**
 * 停止轮询
 */
function stopPolling() {
  if (pollTimerId !== null) {
    clearInterval(pollTimerId);
    pollTimerId = null;
    console.log("Polling stopped");
  }
}

/**
 * 带超时的 fetch（用于 reset 防卡死）
 */
function fetchWithTimeout(url, options = {}, timeoutMs = RESET_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort();
    } else {
      options.signal.addEventListener(
        "abort",
        () => controller.abort(),
        { once: true }
      );
    }
  }

  return fetch(url, { ...options, signal: controller.signal }).finally(() => {
    clearTimeout(timeoutId);
  });
}

/**
 * 处理 BtnPlay 的单键状态机
 * 根据当前状态决定动作：
 * - IDLE: 启动任务 (RunCode)
 * - RUNNING: 暂停任务 (PauseCode)
 * - PAUSED: 继续任务 (ResumeCode)
 */
async function onPlayButtonClick() {
  // Reset 期间软阻止 Play
  if (isResetRequestInProgress) {
    console.warn("[Play] blocked: reset in progress");
    return;
  }

  // 防连点：若有请求进行中，禁用按钮
  if (isTaskRequestInProgress) {
    console.warn("[Play] blocked: task request in progress");
    return;
  }

  const status = currentRobotStatus;

  if (status === STATUS_IDLE) {
    // 启动任务
    await startTask();
  } else if (status === STATUS_RUNNING) {
    // 暂停任务
    await pauseTask();
  } else if (status === STATUS_PAUSED) {
    // 继续任务
    await resumeTask();
  } else {
    console.warn("Unknown status:", status);
  }
}

/**
 * 启动任务：从 Blockly 生成代码，POST /RunPythonCode
 */
async function startTask() {
  const code = pythonGenerator.workspaceToCode(ws);

  // 空代码保护：直接返回，不发请求
  if (code.trim() === "") {
    console.warn("Code is empty, skipping execution");
    return;
  }

  // 防连点
  isTaskRequestInProgress = true;
  isPlayButtonDisabled = true;

  try {
    // 立即切换到 RUNNING 状态，开始轮询
    // （虽然后端立刻返回，但我们信任后端会执行）
    applyRobotStatus(STATUS_RUNNING);
    startPolling();

    // 发送请求
    const response = await fetch("/RunPythonCode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });

    if (!response.ok) {
      throw new Error("Failed to start task");
    }

    console.log("Task started successfully");
  } catch (error) {
    console.error("Error starting task:", error);
    notifyRunStatusError("启动任务失败：" + error.message);
    // 错误时回到 IDLE
    applyRobotStatus(STATUS_IDLE);
    stopPolling();
  } finally {
    // 恢复按钮可用性
    isTaskRequestInProgress = false;
    isPlayButtonDisabled = false;
  }
}

/**
 * 暂停任务：POST /api/pause
 * 只有服务器返回 success 才更新状态，等待轮询最终确认
 */
async function pauseTask() {
  if (currentRobotStatus !== STATUS_RUNNING) {
    console.warn("Cannot pause: not in RUNNING state");
    return;
  }

  // 防连点
  isTaskRequestInProgress = true;
  isPlayButtonDisabled = true;

  try {
    const response = await fetch("/api/pause", { method: "POST" });
    if (!response.ok) {
      throw new Error("Failed to pause task");
    }

    const data = await response.json();
    if (data.status === "success") {
      console.log("Pause request accepted by server");
      // 不立即更新状态，等待轮询驱动
    } else {
      console.error("Pause failed:", data.message);
      notifyRunStatusError("暂停失败：" + (data.message || "Unknown error"));
    }
  } catch (error) {
    console.error("Error pausing task:", error);
    notifyRunStatusError("暂停失败：" + error.message);
  } finally {
    // 恢复按钮可用性
    isTaskRequestInProgress = false;
    isPlayButtonDisabled = false;
  }
}

/**
 * 继续任务：POST /api/resume
 * 只有服务器返回 success 才更新状态，等待轮询最终确认
 */
async function resumeTask() {
  if (currentRobotStatus !== STATUS_PAUSED) {
    console.warn("Cannot resume: not in PAUSED state");
    return;
  }

  // 防连点
  isTaskRequestInProgress = true;
  isPlayButtonDisabled = true;

  try {
    const response = await fetch("/api/resume", { method: "POST" });
    if (!response.ok) {
      throw new Error("Failed to resume task");
    }

    const data = await response.json();
    if (data.status === "success") {
      console.log("Resume request accepted by server");
      // 不立即更新状态，等待轮询驱动
    } else {
      console.error("Resume failed:", data.message);
      notifyRunStatusError("继续运行失败：" + (data.message || "Unknown error"));
    }
  } catch (error) {
    console.error("Error resuming task:", error);
    notifyRunStatusError("继续运行失败：" + error.message);
  } finally {
    // 恢复按钮可用性
    isTaskRequestInProgress = false;
    isPlayButtonDisabled = false;
  }
}

/**
 * 复位机器人：POST /api/robot/reset
 * 强制停止所有任务，舵机归位，后端状态重置为idle
 */
async function resetRobot() {
  // 防连点
  if (isResetRequestInProgress) {
    console.warn("[Reset] blocked: reset request in progress");
    return;
  }

  isResetRequestInProgress = true;

  // Reset 开始即停止轮询并强制回到 IDLE，避免状态被轮询回写
  stopPolling();
  applyRobotStatus(STATUS_IDLE);

  try {
    console.log("Resetting robot...");
    
    // 发送复位请求（带超时保护）
    const response = await fetchWithTimeout(
      "/api/robot/reset",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
      RESET_TIMEOUT_MS
    );

    if (!response.ok) {
      throw new Error("Failed to reset robot");
    }

    const data = await response.json();
    console.log("Reset response:", data);

    // 保持前端状态为 IDLE
    applyRobotStatus(STATUS_IDLE);

    console.log("Robot reset successfully");
  } catch (error) {
    if (error && error.name === "AbortError") {
      console.error(`[Reset] timeout after ${RESET_TIMEOUT_MS}ms`, error);
      notifyRunStatusError(`复位超时（${RESET_TIMEOUT_MS}ms）`);
    } else {
      console.error("Error resetting robot:", error);
      notifyRunStatusError("复位失败：" + (error && error.message ? error.message : "Unknown error"));
    }
  } finally {
    isResetRequestInProgress = false;
  }
}

// ============================================

function RunCode() {
  // 入口函数（兼容性保留，实际由 onPlayButtonClick 驱动）
  onPlayButtonClick();
}

function BLE_Connect() {
  if (targetConnectDevice === "") {
    return alert("请选择想要连接的Magos设备");
  }
  updateBLEState("connecting");
  fetch("/BLE_Connect", {
    method: "POST",
    headers: {
      "Context-type": "text/plain",
    },
    body: targetConnectDevice,
  })
    .then((response) => {
      if (!response.ok) {
        throw new Error("BLE_Connect");
      }
      return response.json();
    })
    .then((data) => {
      const isConnected = Array.isArray(data) && data[0] === "True";
      if (isConnected) {
        // 连接成功，立即同步后端真实状态与设备名
        console.log("蓝牙连接成功，正在同步设备信息...");
        syncBLEStatusWithBackend();
        targetConnectDevice = "";
      } else {
        updateBLEState("error");
        console.log("蓝牙连接失败");
      }
    })
    .catch((error) => {
      updateBLEState("error");
      console.log(error);
    });
}

function BLE_Refresh(resetSelection = false) {
  return fetch("BLE_Refresh")
    .then((response) => {
      if (!response.ok) throw new Error("BLE_Refresh???");
      return response.json();
    })
    .then((data) => {
      console.log(data);
      if (data.length === 0) {
        if (resetSelection) {
          resetDeviceListSelection();
        }
        return console.log("???????,???Magos????");
      }
      DeviceList.options.length = 1;
      data.forEach((element) => {
        DeviceList.options.add(new Option(element, element));
      });
      if (resetSelection) {
        resetDeviceListSelection();
      }
      // 刷新列表后，重新应用连接状态（若已连接，覆盖列表显示）
      syncBLEStatusWithBackend();
    })
    .catch((error) => {
      console.log("BLE_Refresh?????", error);
    });
}

function BLE_Disconnect() {
  if (ConnectedDevice === "") {
    return alert("没有正在连接的蓝牙设备");
  }
  updateBLEState("disconnecting");
  fetch("/BLE_Disconnect")
    .then((response) => response.text())
    .then((data) => {
      // 兼容 "True" 或 ["True"] 格式
      if (data && (data === "True" || data.includes("True"))) {
        ConnectedDevice = "";
        updateBLEState("connect");
        updateConnectedDeviceUI();
        console.log("蓝牙断开成功");
      } else {
        updateBLEState("error");
        console.log("蓝牙断开失败");
      }
    })
    .catch((error) => {
      updateBLEState("error");
      console.log("BLE_Disconnect出现错误, 错误码：", error);
    });
}

function ClearCode() {
  ws.clear();
}

function updateBLEState(state) {
  switch (state) {
    case "connect":
      ContainerDevice.classList.remove(
        "Disconnecting",
        "Connecting",
        "Connected",
        "Error"
      );
      ContainerDevice.classList.add("Connect");
      StateBLE.innerText = "未连接";
      break;
    case "disconnecting":
      ContainerDevice.classList.remove(
        "Error",
        "Connect",
        "Connecting",
        "Connected"
      );
      ContainerDevice.classList.add("Disconnecting");
      StateBLE.innerText = "断开中";
      break;
    case "connecting":
      ContainerDevice.classList.remove(
        "Error",
        "Connect",
        "Connected",
        "Disconnecting"
      );
      ContainerDevice.classList.add("Connecting");
      StateBLE.innerText = "连接中";
      break;
    case "connected":
      ContainerDevice.classList.remove(
        "Connect",
        "Connecting",
        "Disconnecting",
        "Error"
      );
      ContainerDevice.classList.add("Connected");
      StateBLE.innerText = "已连接";
      break;
    case "error":
      ContainerDevice.classList.remove(
        "Connect",
        "Connecting",
        "Connected",
        "Disconnecting"
      );
      ContainerDevice.classList.add("Error");
      StateBLE.innerText = "错误";
      break;
    default:
      break;
  }
  switch (state) {
  }
}

// ============ 新增：页面启动时对齐 BLE 连接状态（一次性 sync）===========
// 统一同步函数：查询 /api/status 并驱动所有 BLE UI
async function syncBLEStatusWithBackend() {
  const STATUS_ENDPOINT = "/api/status";
  try {
    const response = await fetch(STATUS_ENDPOINT, { method: "GET" });
    if (!response.ok) return;

    const json = await response.json();
    const data = (json && typeof json === "object" && "data" in json) ? json.data : json;
    
    // 1. 判断连接状态
    let isConnected = false;
    if (data.is_connected === true || data.is_connected === "True" || data.is_connected === 1) isConnected = true;
    else if (data.connected === true || data.connected === "True" || data.connected === 1) isConnected = true;
    else if (data.isConnected === true || data.isConnected === "True" || data.isConnected === 1) isConnected = true;

    // 2. 获取设备名称
    const deviceName = data.device_name || data.connected_device || data.name || data.target_device || "";

    if (isConnected) {
        if (deviceName) {
            ConnectedDevice = deviceName;
        } else if (!ConnectedDevice) {
            ConnectedDevice = "Unknown Device";
        }
        updateBLEState("connected");
        updateConnectedDeviceUI();
    } else {
        ConnectedDevice = "";
        updateBLEState("connect");
        updateConnectedDeviceUI();
    }
  } catch (error) {
    console.warn("BLE Status sync failed:", error);
  }
}
// 兼容旧名
const checkBleStatusOnLoad = syncBLEStatusWithBackend;

function playVoice() {
  // if (deviceConnect === "") {
  //   return alert("请连接Magos")
  // }
  // let song = voiceSelect.options[voiceSelect.selectedIndex].text;
  // let id = voiceSelect.options[voiceSelect.selectedIndex].value;
  let song = "";
  let id = 0;
  songs.forEach((element) => {
    if (element.title === ParagraphSongTitle.innerText) {
      song = element.title;
      id = element.id;
    }
  });
  // console.log(song);
  // console.log(id);
  if (id === "") {
    return alert("请选择想要播放的歌曲");
  }
  fetch("/Play_Background", {
    method: "POST",
    headers: {
      "Context-type": "text/plain",
    },
    body: id,
  })
    .then((data) => {
      if (data === "True") {
        console.log(`${song}已经开始播放`);
        return true;
      } else {
        alert(`${song}不存在，请添加该歌曲`);
        return false;
      }
    })
    .catch((error) => {
      console.log(error);
      return false;
    });
}

function pauseVoice() {
  // if (deviceConnect === "") {
  //   return alert("请连接Magos")
  // }
  fetch("/Pause_Background")
    .then((data) => {
      if (data === "True") {
        console.log("歌曲停止成功");
        return true;
      } else {
        console.log("歌曲停止失败");
        return false;
      }
    })
    .catch((error) => {
      console.log("pause_Background出问题:", error);
      return false;
    });
}

// ============ 导入功能：从 .py 文件恢复 Blockly Workspace ============

/**
 * 从 .py 文件内容中提取 Blockly 序列化数据
 * @param {string} fileContent - .py 文件的完整内容
 * @returns {object|null} - Blockly 序列化的 JSON 对象，解析失败返回 null
 */
function extractBlocklyDataFromPython(fileContent) {
  try {
    // 使用正则表达式匹配标记区间
    const beginMarker = "# === BLOCKLY_WORKSPACE_BEGIN ===";
    const endMarker = "# === BLOCKLY_WORKSPACE_END ===";

    const beginIndex = fileContent.indexOf(beginMarker);
    const endIndex = fileContent.indexOf(endMarker);

    if (beginIndex === -1 || endIndex === -1) {
      console.warn('未找到 Blockly 序列化标记，可能不是由导出功能生成的文件');
      return null;
    }

    // 提取标记之间的内容
    const markedContent = fileContent.substring(
      beginIndex + beginMarker.length,
      endIndex
    );

    // 去除注释符号 # 和前后空白
    const jsonString = markedContent
      .split("\n")
      .map((line) => line.replace(/^#\s*/, "").trim())
      .filter((line) => line.length > 0)
      .join("");

    // 解析 JSON
    const workspaceData = JSON.parse(jsonString);
    return workspaceData;
  } catch (error) {
    console.error('解析 Blockly 数据失败:', error);
    return null;
  }
}

/**
 * 将 Blockly 序列化数据加载到 Workspace
 * @param {object} workspaceData - Blockly 序列化的 JSON 对象
 * @returns {boolean} - 加载成功返回 true，失败返回 false
 */
function loadBlocklyWorkspace(workspaceData) {
  try {
    if (!workspaceData || typeof workspaceData !== "object") {
      throw new Error('无效的 Workspace 数据格式');
    }

    // 清空当前 Workspace
    ws.clear();

    // 使用 Blockly 原生序列化 API 加载
    Blockly.serialization.workspaces.load(workspaceData, ws);

    console.log('Workspace 加载成功');
    return true;
  } catch (error) {
    console.error('加载 Workspace 失败:', error);
    alert(`导入失败：${error.message}`);
    return false;
  }
}

/**
 * 处理导入 .py 文件的完整流程
 * @param {File} file - 用户选择的 .py 文件对象
 */
async function handleImportPythonFile(file) {
  if (!file) {
    return;
  }

  // 验证文件类型
  if (!file.name.endsWith(".py")) {
    alert('请选择 .py 文件');
    return;
  }

  try {
    // 读取文件内容
    const fileContent = await file.text();

    // 提取 Blockly 数据
    const workspaceData = extractBlocklyDataFromPython(fileContent);

    if (!workspaceData) {
      alert(
        '导入失败：文件中未找到有效的 Blockly 数据\n\n请确保该文件是通过"导出"功能生成的'
      );
      return;
    }

    // 加载到 Workspace
    const success = loadBlocklyWorkspace(workspaceData);

    if (success) {
      // 刷新代码显示
      ShowCode();

      // 关闭导入面板
      if (PanelImport) {
        PanelImport.style.visibility = "hidden";
      }

      alert('导入成功！');
    }
  } catch (error) {
    console.error('导入文件时发生错误:', error);
    alert(`导入失败：${error.message}`);
  }
}

// ============================================

const MUSIC_LIST_VERSION = "2026_02_05_001"; // 修改此版本号可强制重置浏览器缓存的音乐列表

// 初始化歌曲数据（模拟缓存）
function initializeSongs() {
  // 版本检测与缓存清理
  if (localStorage.getItem("MusicListVersion") !== MUSIC_LIST_VERSION) {
    localStorage.removeItem("miniCachedSongs_v5");
    localStorage.setItem("MusicListVersion", MUSIC_LIST_VERSION);
  }

  if (!localStorage.getItem("miniCachedSongs_v5")) {
    const defaultSongs = [
      { id: 1, title: "第一首（三隻小豬粵劇）", artist: "" },
      { id: 2, title: "第二首", artist: "" },
      { id: 3, title: "第三首", artist: "" },
      { id: 4, title: "第四首", artist: "" },
      { id: 5, title: "第五首", artist: "" },
      { id: 6, title: "第六首", artist: "" },
      { id: 7, title: "第七首", artist: "" },
      { id: 8, title: "第八首", artist: "" },
      { id: 9, title: "第九首", artist: "" },
      { id: 10, title: "第十首", artist: "" },
      { id: 11, title: "第十一首", artist: "" },
      { id: 12, title: "第十二首", artist: "" },
      { id: 13, title: "第十三首", artist: "" },
      { id: 14, title: "第十四首", artist: "" },
      { id: 15, title: "第十五首", artist: "" },
    ];
    localStorage.setItem("miniCachedSongs_v5", JSON.stringify(defaultSongs));
  }
}

// 获取所有歌曲
function getAllSongs() {
  return JSON.parse(localStorage.getItem("miniCachedSongs_v5")) || [];
}

function isPlayableAudioUrl(value) {
  if (typeof value !== "string") return false;
  const url = value.trim();
  if (!url) return false;
  return (
    url.startsWith("/") ||
    url.startsWith("http://") ||
    url.startsWith("https://") ||
    url.startsWith("blob:")
  );
}

function getSongFileUrl(song) {
  if (!song) return "";

  const candidates = [
    song.fileUrl,
    song.url,
    song.file_url,
    // legacy fields (only accepted if they are actually usable URLs)
    song.filepath,
    song.filename,
  ];

  for (const candidate of candidates) {
    if (isPlayableAudioUrl(candidate)) return candidate.trim();
  }

  // Important: never fall back to song.title (a song name is not a URL)
  return "";
}

// 搜索歌曲
function searchSongs(query) {
  const songs = getAllSongs();
  if (!query.trim()) {
    return songs;
  }

  const lowerQuery = query.toLowerCase();
  return songs.filter(
    (song) =>
      song.title.toLowerCase().includes(lowerQuery) ||
      song.artist.toLowerCase().includes(lowerQuery)
  );
}

// 显示搜索结果
function appendMusicValue(item) {
  let MusicValue = document.createElement("div");
  MusicValue.id = "MusicValue";
  MusicValue.dataset.title = item.title;
  MusicValue.dataset.artist = item.artist;
  MusicValue.dataset.fileUrl = getSongFileUrl(item);
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "music-delete-checkbox";
  checkbox.value = MusicValue.dataset.fileUrl;
  const label = document.createElement("span");
  label.className = "music-title";
  label.innerText = item.title;
  MusicValue.appendChild(checkbox);
  MusicValue.appendChild(label);
  MusicValue.addEventListener("click", (event) => {
    if (isDeleteMode) {
      if (event.target !== checkbox) {
        checkbox.checked = !checkbox.checked;
      }
      return;
    }
    console.log(label.innerText);
    ParagraphSongTitle.innerText = MusicValue.dataset.title;
    ParagraphSongArtist.innerText = MusicValue.dataset.artist;
  });
  PanelMusicMid.appendChild(MusicValue);
}

function addSongToCache(song) {
  const cachedSongs = getAllSongs();
  cachedSongs.push(song);
  localStorage.setItem("miniCachedSongs_v5", JSON.stringify(cachedSongs));
  songs = cachedSongs;
}

function displaySongs(songs) {
  let MusicValues = document.querySelectorAll("#MusicValue");
  console.log(MusicValues);
  for (var i = 0; i < MusicValues.length; i++) {
    MusicValues[i].remove();
  }
  if (songs.length === 0) {
    return;
  }
  // 限制显示数量，避免界面过于拥挤
  songs.forEach((item) => {
    appendMusicValue(item);
  });
}

function clearDeleteSelections() {
  const checkboxes = PanelMusicMid.querySelectorAll(".music-delete-checkbox");
  checkboxes.forEach((checkbox) => {
    checkbox.checked = false;
  });
}

function setDeleteMode(enabled) {
  isDeleteMode = enabled;
  PanelMusicMid.classList.toggle("delete-mode", enabled);
  if (DeleteMusic) {
    DeleteMusic.innerText = enabled
      ? language[currentLanguage]["BtnDeleteMusicConfirm"]
      : language[currentLanguage]["BtnDeleteMusic"];
  }
  if (!enabled) {
    clearDeleteSelections();
  }
}

function getSelectedDeleteFileUrls() {
  const checkboxes = PanelMusicMid.querySelectorAll(
    ".music-delete-checkbox:checked"
  );
  return Array.from(checkboxes)
    .map((checkbox) => checkbox.value)
    .filter((value) => value);
}

function removeSongsByFileUrls(fileUrls) {
  const removeSet = new Set(fileUrls);
  const cachedSongs = getAllSongs();
  const nextSongs = cachedSongs.filter(
    (song) => !removeSet.has(getSongFileUrl(song))
  );
  localStorage.setItem("miniCachedSongs_v5", JSON.stringify(nextSongs));
  songs = nextSongs;
}

async function deleteSelectedMusic() {
  const filesToDelete = getSelectedDeleteFileUrls();
  if (filesToDelete.length === 0) {
    alert("Select at least one song to delete.");
    return;
  }
  DeleteMusic.disabled = true;
  try {
    const response = await fetch("/api/delete_music", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files_to_delete: filesToDelete }),
    });
    if (!response.ok) {
      throw new Error(`Delete failed with status ${response.status}`);
    }
    removeSongsByFileUrls(filesToDelete);
    const query = MusicInput.value;
    displaySongs(searchSongs(query));
    setDeleteMode(false);
  } catch (error) {
    console.log("delete_music error:", error);
    alert("Delete failed");
  } finally {
    DeleteMusic.disabled = false;
  }
}

function getSongArtistByTitle(title) {
  const match = songs.find((song) => song.title === title);
  return match ? match.artist : "";
}

function selectSongByIndex(items, index) {
  if (!items.length) return;
  const target = items[index];
  const title = target.dataset.title || target.innerText;
  const artist = target.dataset.artist || getSongArtistByTitle(title);
  ParagraphSongTitle.innerText = title;
  ParagraphSongArtist.innerText = artist;
}

function selectAdjacentSong(offset) {
  const items = Array.from(PanelMusicMid.querySelectorAll("#MusicValue"));
  if (!items.length) return;
  const currentIndex = items.findIndex((item) => {
    const title = item.dataset.title || item.innerText;
    return title === ParagraphSongTitle.innerText;
  });
  if (currentIndex === -1) {
    selectSongByIndex(items, 0);
    return;
  }
  const nextIndex = (currentIndex + offset + items.length) % items.length;
  selectSongByIndex(items, nextIndex);
}

async function uploadMusicFile(file) {
  const formData = new FormData();
  formData.append("file", file);
  const response = await fetch("/api/upload_music", {
    method: "POST",
    body: formData,
  });
  if (!response.ok) {
    throw new Error(`Upload failed with status ${response.status}`);
  }
  return response.json();
}

async function handleMusicUpload() {
  const file = UploadMusicInput.files && UploadMusicInput.files[0];
  if (!file) return;
  UploadMusic.disabled = true;
  try {
    const result = await uploadMusicFile(file);
    const baseName = file.name.replace(/\.[^/.]+$/, "");

    // Only accept an actually accessible URL returned by backend.
    // Never use file.name / title as a URL fallback.
    const fileUrl = (result && (result.url || result.file_url)) || "";
    if (!isPlayableAudioUrl(fileUrl)) {
      throw new Error(
        "上传失败：后端未返回可访问的音频URL（字段 url 或 file_url），无法播放。"
      );
    }

    const newSong = {
      id: Date.now(),
      title: result.title || baseName,
      artist: result.artist || "Local Upload",
      filename: result.filename || file.name,
      fileUrl: fileUrl.trim(),
    };
    addSongToCache(newSong);
    const query = MusicInput.value;
    if (query && query.trim() !== "") {
      displaySongs(searchSongs(query));
    } else {
      appendMusicValue(newSong);
    }
  } catch (error) {
    console.log("upload_music error:", error);
    alert(error && error.message ? error.message : "上传失败");
  } finally {
    UploadMusic.disabled = false;
    UploadMusicInput.value = "";
  }
}

function changeTheme() {
  if (ThemeList.options[ThemeList.options.selectedIndex].value === "dark") {
    document.body.classList.remove("Light");
    document.body.classList.add("Dark");
  } else {
    document.body.classList.remove("Dark");
    document.body.classList.add("Light");
  }
}

function setInnerTextIf(element, text) {
  if (element) {
    // 不要覆盖电池显示等动态更新的元素
    if (element === BtnBattery) {
      return;
    }
    element.innerText = text;
  }
}

function setAttributeIf(element, name, value) {
  if (element) {
    element.setAttribute(name, value);
  }
}

function coerceBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
  }
  return false;
}

function normalizeBatteryValue(value) {
  // null 或 undefined 直接返回 null
  if (value === null || value === undefined) {
    return null;
  }
  // 接受任何数字类型（包括浮点数），注意 0 是有效值
  if (typeof value === "number" && !isNaN(value)) {
    return Math.round(value);
  }
  // 接受字符串格式的数字
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = parseFloat(value);
    if (!isNaN(parsed)) return Math.round(parsed);
  }
  return null;
}

function isValidBatteryValue(value) {
  // 明确排除 null/undefined，但 0 是合法值
  if (value === null || value === undefined) {
    return false;
  }
  // 检查是否为有效数字且在 0-100 范围内（包含 0）
  return typeof value === "number" && !isNaN(value) && value >= 0 && value <= 100;
}

function setBatteryDisconnected() {
  // 每次都重新查询 DOM 节点
  const batteryElement = document.getElementById("BtnBattery");
  if (!batteryElement) {
    console.error("[Battery] BtnBattery element not found when setting disconnected!");
    return;
  }
  
  const text = language[currentLanguage]?.BatteryDisconnected || BATTERY_DISCONNECTED_TEXT;
  console.log("[Battery] setBatteryDisconnected - text:", text);
  
  batteryElement.textContent = text;
  batteryElement.classList.add("is-muted");
  batteryElement.classList.remove("is-low");
  
  console.log("[Battery] setBatteryDisconnected - final textContent:", batteryElement.textContent);
}

function setBatteryConnected(battery) {
  // 每次都重新查询 DOM 节点
  const batteryElement = document.getElementById("BtnBattery");
  if (!batteryElement) {
    console.error("[Battery] BtnBattery element not found when setting connected!");
    return;
  }
  
  const prefix = language[currentLanguage]?.BatteryLabel || BATTERY_LABEL_PREFIX;
  const displayText = `${prefix}${battery}%`;
  
  console.log("[Battery] setBatteryConnected - battery value:", battery);
  console.log("[Battery] setBatteryConnected - display text:", displayText);
  
  batteryElement.textContent = displayText;
  batteryElement.classList.remove("is-muted");
  batteryElement.classList.toggle("is-low", battery <= BATTERY_LOW_THRESHOLD);
  
  console.log("[Battery] setBatteryConnected - final textContent:", batteryElement.textContent);
  console.log("[Battery] setBatteryConnected - classList:", batteryElement.className);
}

function updateBatteryLanguage() {
  if (!BtnBattery) return;
  
  console.log("[Battery] updateBatteryLanguage called for language:", currentLanguage);
  
  // 判断当前是否显示电量值或断开状态
  const currentText = BtnBattery.textContent || "";
  const isMuted = BtnBattery.classList.contains("is-muted");
  
  console.log("[Battery] Current text:", currentText, "isMuted:", isMuted);
  console.log("[Battery] Language config:", language[currentLanguage]);
  
  if (isMuted) {
    // 显示断开连接状态
    const text = language[currentLanguage]?.BatteryDisconnected || BATTERY_DISCONNECTED_TEXT;
    BtnBattery.textContent = text;
    console.log("[Battery] Language updated to disconnected:", text);
  } else {
    // 显示电量值，提取数字
    const match = currentText.match(/(\d+)%/);
    if (match) {
      const battery = parseInt(match[1]);
      const prefix = language[currentLanguage]?.BatteryLabel || BATTERY_LABEL_PREFIX;
      BtnBattery.textContent = `${prefix}${battery}%`;
      console.log("[Battery] Language updated to:", BtnBattery.textContent);
    } else {
      console.warn("[Battery] Could not extract battery value from:", currentText);
    }
  }
}

function updateBatteryFromStatus(data) {
  console.log("[Battery] ========== Update Start ==========");
  console.log("[Battery] Raw data received:", JSON.stringify(data));
  
  // 检查 BtnBattery DOM 节点是否存在
  const batteryElement = document.getElementById("BtnBattery");
  if (!batteryElement) {
    console.error("[Battery] BtnBattery element not found in DOM!");
    return;
  }
  console.log("[Battery] BtnBattery element exists:", batteryElement);
  
  if (!data || typeof data !== "object") {
    console.warn("[Battery] Invalid data structure, showing disconnected");
    setBatteryDisconnected();
    return;
  }
  
  const isConnected = coerceBoolean(data.is_connected);
  console.log("[Battery] is_connected:", data.is_connected, "-> coerced:", isConnected);
  
  // 未连接时显示 "电量：--"
  if (!isConnected) {
    console.log("[Battery] Device not connected, showing disconnected");
    setBatteryDisconnected();
    return;
  }
  
  // 明确检查 battery 是否为 null/undefined
  const rawBattery = data.battery;
  console.log("[Battery] Raw battery value:", rawBattery, "type:", typeof rawBattery);
  
  // battery 为 null 或 undefined 时显示 "电量：--"
  if (rawBattery === null || rawBattery === undefined) {
    console.log("[Battery] Battery is null/undefined, showing disconnected");
    setBatteryDisconnected();
    return;
  }
  
  const batteryValue = normalizeBatteryValue(rawBattery);
  console.log("[Battery] Normalized battery:", batteryValue);
  
  // 验证电量值是否有效（0 是有效值）
  if (!isValidBatteryValue(batteryValue)) {
    console.warn("[Battery] Invalid battery value after normalization:", batteryValue, "showing disconnected");
    setBatteryDisconnected();
    return;
  }
  
  // 设置电量显示（batteryValue 可以是 0）
  console.log("[Battery] Setting battery display to:", batteryValue + "%");
  setBatteryConnected(batteryValue);
  console.log("[Battery] Final textContent:", batteryElement.textContent);
  console.log("[Battery] ========== Update End ==========");
}

function fetchBatteryStatus() {
  // 每次都重新查询 DOM 节点，防止引用失效
  const batteryElement = document.getElementById("BtnBattery");
  if (!batteryElement) {
    console.error("[Battery] BtnBattery element not found in DOM!");
    return;
  }
  
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    BATTERY_POLL_MS - 200
  );
  
  console.log("[Battery] Polling /api/status...");
  
  // 使用正确的接口路径 /api/status
  fetch("/api/status", { method: "GET", signal: controller.signal })
    .then((response) => {
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return response.json();
    })
    .then((data) => {
      console.log("[Battery] API /api/status response:", JSON.stringify(data));
      updateBatteryFromStatus(data);
    })
    .catch((error) => {
      if (error.name === 'AbortError') {
        console.warn("[Battery] Request timeout");
      } else {
        console.error("[Battery] API fetch failed:", error.message);
      }
      setBatteryDisconnected();
    })
    .finally(() => {
      clearTimeout(timeoutId);
    });
}

function startBatteryStatusPolling() {
  const batteryElement = document.getElementById("BtnBattery");
  if (!batteryElement) {
    console.error("[Battery] Cannot start polling: BtnBattery element not found in DOM!");
    return;
  }
  
  console.log("[Battery] ========================================");
  console.log("[Battery] Starting battery status polling");
  console.log("[Battery] Interval:", BATTERY_POLL_MS + "ms");
  console.log("[Battery] API endpoint: /api/status");
  console.log("[Battery] BtnBattery element:", batteryElement);
  console.log("[Battery] ========================================");
  
  setBatteryDisconnected();
  fetchBatteryStatus();
  setInterval(fetchBatteryStatus, BATTERY_POLL_MS);
}

// ============ Magos Block Messages ============
const MAGOS_MESSAGES = {
  hant: {
    MAGOS_ADD_TEXT: "Add text %1",
    MAGOS_SERVO_CONTROL_TITLE: "Magos%1旋轉的角度%2",
    MAGOS_LEFT_HAND: "左手",
    MAGOS_LEFT_ARM: "左臂",
    MAGOS_LEFT_SHOULDER: "左肩",
    MAGOS_RIGHT_HAND: "右手",
    MAGOS_RIGHT_ARM: "右臂",
    MAGOS_RIGHT_SHOULDER: "右肩",
    MAGOS_HEADER: "頭部",
    MAGOS_BASE: "底座",
    MAGOS_BODY: "身體",
    MAGOS_ANIMATIONS_START_TITLE: "播放動畫組：%1",
    MAGOS_PLAY_BG_MUSIC_TITLE: "播放背景音樂：%1",
    MAGOS_MUSIC_THREE_PIGS_OPERA: "三隻小豬粵劇",
    MAGOS_STOP_BG_MUSIC_TITLE: "暫停背景音樂",
    MAGOS_CHANGE_EMOJI_TITLE: "變換表情：%1",
    MAGOS_EMOJI_EXCITED: "興奮",
    MAGOS_EMOJI_ANGRY: "憤怒",
    MAGOS_EMOJI_DISDAIN: "不屑",
    MAGOS_EMOJI_PANIC: "驚恐",
    MAGOS_EMOJI_SAD: "難過",
    MAGOS_EMOJI_LOOK_UP_RIGHT: "右上看",
    MAGOS_EMOJI_LOOK_UP_LEFT: "左上看",
    MAGOS_EMOJI_BLINK: "眨眼",
    MAGOS_EMOJI_PIG_DAD: "豬爸爸",
    MAGOS_EMOJI_PIG_MOM: "豬媽媽",
    MAGOS_EMOJI_PIG_SON: "豬兒子",
    MAGOS_SAY_TITLE: "Magos說：%1",
    MAGOS_TEST_TITLE: "Magos测试:%1",
    MAGOS_PAUSE_TITLE: "Magos暂停：%1 s",
    MAGOS_ARM_TITLE: "%1 arm",
    MAGOS_ARM_LEFT: "left",
    MAGOS_ARM_RIGHT: "right"
  },
  hans: {
    MAGOS_ADD_TEXT: "Add text %1",
    MAGOS_SERVO_CONTROL_TITLE: "Magos%1旋转的角度%2",
    MAGOS_LEFT_HAND: "左手",
    MAGOS_LEFT_ARM: "左臂",
    MAGOS_LEFT_SHOULDER: "左肩",
    MAGOS_RIGHT_HAND: "右手",
    MAGOS_RIGHT_ARM: "右臂",
    MAGOS_RIGHT_SHOULDER: "右肩",
    MAGOS_HEADER: "头部",
    MAGOS_BASE: "底座",
    MAGOS_BODY: "身体",
    MAGOS_ANIMATIONS_START_TITLE: "播放动画组：%1",
    MAGOS_PLAY_BG_MUSIC_TITLE: "播放背景音乐：%1",
    MAGOS_MUSIC_THREE_PIGS_OPERA: "三只小猪粤剧",
    MAGOS_STOP_BG_MUSIC_TITLE: "暂停背景音乐",
    MAGOS_CHANGE_EMOJI_TITLE: "变换表情：%1",
    MAGOS_EMOJI_EXCITED: "兴奋",
    MAGOS_EMOJI_ANGRY: "愤怒",
    MAGOS_EMOJI_DISDAIN: "不屑",
    MAGOS_EMOJI_PANIC: "惊恐",
    MAGOS_EMOJI_SAD: "难过",
    MAGOS_EMOJI_LOOK_UP_RIGHT: "右上看",
    MAGOS_EMOJI_LOOK_UP_LEFT: "左上看",
    MAGOS_EMOJI_BLINK: "眨眼",
    MAGOS_EMOJI_PIG_DAD: "猪爸爸",
    MAGOS_EMOJI_PIG_MOM: "猪妈妈",
    MAGOS_EMOJI_PIG_SON: "猪儿子",
    MAGOS_SAY_TITLE: "Magos说：%1",
    MAGOS_TEST_TITLE: "Magos测试:%1",
    MAGOS_PAUSE_TITLE: "Magos暂停：%1 s",
    MAGOS_ARM_TITLE: "%1 arm",
    MAGOS_ARM_LEFT: "left",
    MAGOS_ARM_RIGHT: "right"
  },
  en: {
    MAGOS_ADD_TEXT: "Add text %1",
    MAGOS_SERVO_CONTROL_TITLE: "Magos %1 rotate angle %2",
    MAGOS_LEFT_HAND: "Left Hand",
    MAGOS_LEFT_ARM: "Left Arm",
    MAGOS_LEFT_SHOULDER: "Left Shoulder",
    MAGOS_RIGHT_HAND: "Right Hand",
    MAGOS_RIGHT_ARM: "Right Arm",
    MAGOS_RIGHT_SHOULDER: "Right Shoulder",
    MAGOS_HEADER: "Head",
    MAGOS_BASE: "Base",
    MAGOS_BODY: "Body",
    MAGOS_ANIMATIONS_START_TITLE: "Play Animation Group: %1",
    MAGOS_PLAY_BG_MUSIC_TITLE: "Play Background Music: %1",
    MAGOS_MUSIC_THREE_PIGS_OPERA: "Three Little Pigs Opera",
    MAGOS_STOP_BG_MUSIC_TITLE: "Stop Background Music",
    MAGOS_CHANGE_EMOJI_TITLE: "Change Emoji: %1",
    MAGOS_EMOJI_EXCITED: "Excited",
    MAGOS_EMOJI_ANGRY: "Angry",
    MAGOS_EMOJI_DISDAIN: "Disdain",
    MAGOS_EMOJI_PANIC: "Panic",
    MAGOS_EMOJI_SAD: "Sad",
    MAGOS_EMOJI_LOOK_UP_RIGHT: "Look Up Right",
    MAGOS_EMOJI_LOOK_UP_LEFT: "Look Up Left",
    MAGOS_EMOJI_BLINK: "Blink",
    MAGOS_EMOJI_PIG_DAD: "Pig Dad",
    MAGOS_EMOJI_PIG_MOM: "Pig Mom",
    MAGOS_EMOJI_PIG_SON: "Pig Son",
    MAGOS_SAY_TITLE: "Magos Say: %1",
    MAGOS_TEST_TITLE: "Magos Test: %1",
    MAGOS_PAUSE_TITLE: "Magos Pause: %1 s",
    MAGOS_ARM_TITLE: "%1 arm",
    MAGOS_ARM_LEFT: "left",
    MAGOS_ARM_RIGHT: "right"
  }
};

function updateMagosMessages(langCode) {
  const msgs = MAGOS_MESSAGES[langCode] || MAGOS_MESSAGES['hant'];
  for (const key in msgs) {
    Blockly.Msg[key] = msgs[key];
  }
}

// Initialize Magos messages immediately with default language (Traditional Chinese)
// This ensures that when load(ws) is called, the messages are already available
// preventing "Message does not reference all args" errors during block initialization.
updateMagosMessages("hant");

function changeLang() {
  currentLanguage =
    LanguageList.options[LanguageList.options.selectedIndex].value;
  console.log("[Language] Changed to:", currentLanguage);
  switch (currentLanguage) {
    case "hans":
      Blockly.setLocale(hans);
      break;
    case "hant":
      Blockly.setLocale(hant);
      break;
    case "en":
      Blockly.setLocale(en);
      break;
    default:
      break;
  }

  // 更新 Magos 自定义 Blocks 的翻译
  updateMagosMessages(currentLanguage);

  // Update actions dropdown language
  setActionsLanguage(currentLanguage);

  // 刷新 Workspace 中的所有 Blocks (保存 -> 加载)
  // 这样做可以确保已存在的 Blocks 使用新的 Message 重新渲染
  if (ws) {
    const state = Blockly.serialization.workspaces.save(ws);
    // 重新加载以触发 Block 初始化
    Blockly.serialization.workspaces.load(state, ws);
  } else {
    load(ws);
  }
  
  // 等待 toolbox 渲染完成后更新分类标签（使用双 rAF 确保 DOM 更新完成）
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      updateToolboxCategoryLabels();
    });
  });
  
  setInnerTextIf(
    BtnConnectPanel,
    language[currentLanguage]["BtnConnectPanel"]
  );
  setInnerTextIf(
    BtnInterfacePanel,
    language[currentLanguage]["BtnInterfacePanel"]
  );
  setInnerTextIf(
    BtnWindowPanel,
    language[currentLanguage]["BtnWindowPanel"]
  );
  setInnerTextIf(
    BtnExportPanel,
    language[currentLanguage]["BtnExportPanel"]
  );
  setInnerTextIf(
    BtnImportPanel,
    language[currentLanguage]["BtnImportPanel"]
  );
  setInnerTextIf(
    BtnHelpPanel,
    language[currentLanguage]["BtnHelpPanel"]
  );
  setInnerTextIf(
    BtnNetworkPanel,
    language[currentLanguage]["BtnNetworkPanel"]
  );
  setInnerTextIf(
    BtnBatteryDisplayPanel,
    language[currentLanguage]["BtnBatteryDisplayPanel"]
  );
  setInnerTextIf(
    CodePanelTitleText,
    language[currentLanguage]["CodePanelTitle"]
  );
  setInnerTextIf(GamesTitle, language[currentLanguage]["GamesTitle"]);
  setInnerTextIf(PanelConnectTop, language[currentLanguage]["PanelConnectTop"]);
  setInnerTextIf(ParagraphScan, language[currentLanguage]["ParagraphScan"]);
  setInnerTextIf(
    ParagraphConnect,
    language[currentLanguage]["ParagraphConnect"]
  );
  setInnerTextIf(
    ParagraphDisConnect,
    language[currentLanguage]["ParagraphDisConnect"]
  );
  setInnerTextIf(
    ParagraphRename,
    language[currentLanguage]["ParagraphRename"]
  );
  setInnerTextIf(BtnRename, language[currentLanguage]["BtnRename"]);
  setInnerTextIf(
    PanelInterfaceTop,
    language[currentLanguage]["PanelInterfaceTop"]
  );
  setInnerTextIf(
    ParagraphLanguage,
    language[currentLanguage]["ParagraphLanguage"]
  );
  setInnerTextIf(ParagraphTheme, language[currentLanguage]["ParagraphTheme"]);
  setInnerTextIf(PanelWindowTop, language[currentLanguage]["PanelWindowTop"]);
  setInnerTextIf(PanelHelpTop, language[currentLanguage]["PanelHelpTop"]);
  setInnerTextIf(PanelNetworkTop, language[currentLanguage]["PanelNetworkTop"]);
  setInnerTextIf(BtnNetworkRestart, language[currentLanguage]["BtnNetworkRestart"]);
  setInnerTextIf(ParagraphNetworkRestart, language[currentLanguage]["ParagraphNetworkRestart"]);
  setInnerTextIf(
    ParagraphCodePanel,
    language[currentLanguage]["ParagraphCodePanel"]
  );
  setInnerTextIf(
    ParagraphMusicPanel,
    language[currentLanguage]["ParagraphMusicPanel"]
  );
  setInnerTextIf(
    ParagraphGmaesPanel,
    language[currentLanguage]["ParagraphGmaesPanel"]
  );
  setInnerTextIf(PanelExporeTop, language[currentLanguage]["PanelExporeTop"]);
  setInnerTextIf(PanelImportTop, language[currentLanguage]["PanelImportTop"]);
  setInnerTextIf(ParagraphHelp, language[currentLanguage]["ParagraphHelp"]);
  setInnerTextIf(BtnGetHelp, language[currentLanguage]["BtnGetHelp"]);
  setInnerTextIf(ParagraphExport, language[currentLanguage]["ParagraphExport"]);
  setInnerTextIf(ParagraphImport, language[currentLanguage]["ParagraphImport"]);
  setInnerTextIf(
    ParagraphMusicTitle,
    language[currentLanguage]["ParagraphMusicTitle"]
  );
  setInnerTextIf(UploadMusic, language[currentLanguage]["BtnUploadMusic"]);
  if (DeleteMusic) {
    DeleteMusic.innerText = isDeleteMode
      ? language[currentLanguage]["BtnDeleteMusicConfirm"]
      : language[currentLanguage]["BtnDeleteMusic"];
  }
  setInnerTextIf(BtnExport, language[currentLanguage]["BtnExport"]);
  setInnerTextIf(BtnImport, language[currentLanguage]["BtnImport"]);
  setInnerTextIf(BtnConnect, language[currentLanguage]["BtnConnect"]);
  setInnerTextIf(BtnDisConnect, language[currentLanguage]["BtnDisConnect"]);
  setInnerTextIf(
    LanguageList_hant,
    language[currentLanguage]["LanguageList_hant"]
  );
  setInnerTextIf(
    LanguageList_hans,
    language[currentLanguage]["LanguageList_hans"]
  );
  setInnerTextIf(
    LanguageList_en,
    language[currentLanguage]["LanguageList_en"]
  );
  setInnerTextIf(ThemeList_Dark, language[currentLanguage]["ThemeList_Dark"]);
  setInnerTextIf(ThemeList_Light, language[currentLanguage]["ThemeList_Light"]);
  setAttributeIf(
    MusicInput,
    "placeholder",
    language[currentLanguage]["MusicInputPlaceholder"]
  );

  setInnerTextIf(ParagraphNetworkLogin, language[currentLanguage].ParagraphNetworkLogin);
  setInnerTextIf(BtnNetworkLogin, language[currentLanguage].BtnNetworkLogin);
  setInnerTextIf(DialogNetworkLoginTitle, language[currentLanguage].DialogNetworkLoginTitle);
  setInnerTextIf(NetworkAccountLabel, language[currentLanguage].NetworkAccountLabel);
  setInnerTextIf(NetworkPasswordLabel, language[currentLanguage].NetworkPasswordLabel);
  setInnerTextIf(BtnNetworkLoginConfirm, language[currentLanguage].BtnNetworkLoginConfirm);
  
  // 更新电池显示的语言
  updateBatteryLanguage();
}

/**
 * 更新 Blockly Toolbox 分类标签的语言
 * 根据当前语言 currentLanguage 更新左侧分类文本
 */
function updateToolboxCategoryLabels() {
  const toolboxDiv = document.querySelector(".blocklyToolboxDiv");
  if (!toolboxDiv) return;

  const rows = toolboxDiv.querySelectorAll(".blocklyTreeRow");
  rows.forEach((row) => {
    const labelElement = row.querySelector(".blocklyTreeLabel");
    if (!labelElement) return;

    const currentText = labelElement.textContent.trim();
    
    // 根据当前文本匹配对应的分类 key
    let categoryKey = null;
    for (const [key, translations] of Object.entries(TOOLBOX_CATEGORY_I18N)) {
      if (
        translations.hant === currentText ||
        translations.hans === currentText ||
        translations.en === currentText
      ) {
        categoryKey = key;
        break;
      }
    }

    // 如果找到匹配的分类，更新为当前语言
    if (categoryKey && TOOLBOX_CATEGORY_I18N[categoryKey][currentLanguage]) {
      const newText = TOOLBOX_CATEGORY_I18N[categoryKey][currentLanguage];
      if (labelElement.textContent !== newText) {
        labelElement.textContent = newText;
      }
    }
  });
}

function changeMusicPanel() {
  if (
    MusicPanelList.options[MusicPanelList.options.selectedIndex].value === "Yes"
  ) {
    PanelMusic.style.visibility = "visible";
  } else {
    PanelMusic.style.visibility = "hidden";
  }
}

function changeCodePanel() {
  if (
    CodePanelList.options[CodePanelList.options.selectedIndex].value === "Yes"
  ) {
    CodePanel.style.width = "30%";
    BlocklyDiv.style.width = "70%";
  } else {
    CodePanel.style.width = "0%";
    BlocklyDiv.style.width = "100%";
  }
}

function changGamesPanel() {
  if (
    GamesPanelList.options[GamesPanelList.options.selectedIndex].value === "Yes"
  ) {
    MinigameContainer.style.visibility = "visible";
  } else {
    MinigameContainer.style.visibility = "hidden";
  }
}

function setTargetDevice() {
  let targetdevice = DeviceList.options[DeviceList.options.selectedIndex].value;
  console.log(targetdevice);
  if (targetdevice === "") {
    targetConnectDevice = "";
    return;
  }
  targetConnectDevice = targetdevice;
}

function resetDeviceListSelection() {
  if (DeviceList.options.length === 0) return;
  if (DeviceList.selectedIndex === 0) {
    targetConnectDevice = "";
    return;
  }
  while (DeviceList.selectedIndex !== 0) {
    BtnDeviceSelectLeft.click();
  }
  targetConnectDevice = "";
}


function animateDeviceScanButton() {
  return new Promise((resolve) => {
    const handleAnimationEnd = () => {
      BtnDeviceScan.classList.remove("BtnDeviceScan--rotating");
      resolve();
    };
    BtnDeviceScan.removeEventListener("animationend", handleAnimationEnd);
    BtnDeviceScan.addEventListener("animationend", handleAnimationEnd, {
      once: true,
    });
    BtnDeviceScan.classList.remove("BtnDeviceScan--rotating");
    void BtnDeviceScan.offsetWidth;
    BtnDeviceScan.classList.add("BtnDeviceScan--rotating");
  });
}

async function onDeviceScanClick() {
  if (isDeviceScanAnimating) return;
  isDeviceScanAnimating = true;
  await animateDeviceScanButton();
  await BLE_Refresh(false);
  resetDeviceListSelection();
  isDeviceScanAnimating = false;
}

//#endregion

// UI对象事件注册
ws.addChangeListener((e) => {
  if (e.isUiEvent) return;
  ShowCode(e);
  save(ws);
});
if (BtnCloseCodePanel) {
  BtnCloseCodePanel.addEventListener("click", (event) => {
    event.stopPropagation();
    CodePanelList.selectedIndex = 0;
    changeCodePanel();
  });
}
BtnCodePanelSelectLeft.addEventListener("click", () => {
  if (CodePanelList.options.selectedIndex === 1) {
    CodePanelList.selectedIndex = 0;
  } else {
    CodePanelList.selectedIndex = 1;
  }
  changeCodePanel();
});
BtnCodePanelSelectRight.addEventListener("click", () => {
  if (CodePanelList.options.selectedIndex === 1) {
    CodePanelList.selectedIndex = 0;
  } else {
    CodePanelList.selectedIndex = 1;
  }
  changeCodePanel();
});
BtnMusicPanelSelectLeft.addEventListener("click", () => {
  if (MusicPanelList.options.selectedIndex === 1) {
    MusicPanelList.selectedIndex = 0;
  } else {
    MusicPanelList.selectedIndex = 1;
  }
  changeMusicPanel();
});
BtnMusicPanelSelectRight.addEventListener("click", () => {
  if (MusicPanelList.options.selectedIndex === 1) {
    MusicPanelList.selectedIndex = 0;
  } else {
    MusicPanelList.selectedIndex = 1;
  }
  changeMusicPanel();
});
BtnGamesPanelSelectLeft.addEventListener("click", () => {
  if (GamesPanelList.options.selectedIndex === 1) {
    GamesPanelList.selectedIndex = 0;
  } else {
    GamesPanelList.selectedIndex = 1;
  }
  changGamesPanel();
});
BtnGamesPanelSelectRight.addEventListener("click", () => {
  if (GamesPanelList.options.selectedIndex === 1) {
    GamesPanelList.selectedIndex = 0;
  } else {
    GamesPanelList.selectedIndex = 1;
  }
  changGamesPanel();
});
BtnThemeSelectLeft.addEventListener("click", () => {
  if (ThemeList.options.selectedIndex === 1) {
    ThemeList.selectedIndex = 0;
  } else {
    ThemeList.selectedIndex = 1;
  }
  changeTheme();
});
BtnThemeSelectRight.addEventListener("click", () => {
  if (ThemeList.options.selectedIndex === 1) {
    ThemeList.selectedIndex = 0;
  } else {
    ThemeList.selectedIndex = 1;
  }
  changeTheme();
});
BtnLanguageSelectLeft.addEventListener("click", () => {
  if (LanguageList.selectedIndex === 0) {
    LanguageList.selectedIndex = LanguageList.options.length - 1;
  } else {
    LanguageList.selectedIndex =
      --LanguageList.selectedIndex % LanguageList.options.length;
  }
  changeLang();
});
BtnLanguageSelectRight.addEventListener("click", () => {
  LanguageList.selectedIndex =
    ++LanguageList.selectedIndex % LanguageList.options.length;
  changeLang();
});
BtnDeviceSelectLeft.addEventListener("click", () => {
  if (DeviceList.selectedIndex === 0) {
    DeviceList.selectedIndex = DeviceList.options.length - 1;
  } else {
    DeviceList.selectedIndex =
      --DeviceList.selectedIndex % DeviceList.options.length;
  }
  setTargetDevice();
});
BtnDeviceSelectRight.addEventListener("click", () => {
  DeviceList.selectedIndex =
    ++DeviceList.selectedIndex % DeviceList.options.length;
  setTargetDevice();
});
BtnConnectPanel.addEventListener("click", () => {
  if (PanelConnect.style.visibility === "hidden") {
    PanelConnect.style.visibility = "visible";
    PanelExport.style.visibility = "hidden";
    PanelInterface.style.visibility = "hidden";
    PanelWindow.style.visibility = "hidden";
    return;
  }
  PanelConnect.style.visibility = "hidden";
});
BtnInterfacePanel.addEventListener("click", () => {
  if (PanelInterface.style.visibility === "hidden") {
    PanelInterface.style.visibility = "visible";
    PanelExport.style.visibility = "hidden";
    PanelWindow.style.visibility = "hidden";
    PanelConnect.style.visibility = "hidden";
    return;
  }
  PanelInterface.style.visibility = "hidden";
});
BtnWindowPanel.addEventListener("click", () => {
  if (PanelWindow.style.visibility === "hidden") {
    PanelWindow.style.visibility = "visible";
    PanelExport.style.visibility = "hidden";
    PanelInterface.style.visibility = "hidden";
    PanelConnect.style.visibility = "hidden";
    return;
  }
  PanelWindow.style.visibility = "hidden";
});
BtnExportPanel.addEventListener("click", () => {
  if (PanelExport.style.visibility === "hidden") {
    PanelExport.style.visibility = "visible";
    PanelImport.style.visibility = "hidden";
    PanelInterface.style.visibility = "hidden";
    PanelWindow.style.visibility = "hidden";
    PanelConnect.style.visibility = "hidden";
    return;
  }
  PanelExport.style.visibility = "hidden";
});
BtnImportPanel.addEventListener("click", () => {
  if (PanelImport.style.visibility === "hidden") {
    PanelImport.style.visibility = "visible";
    PanelExport.style.visibility = "hidden";
    PanelInterface.style.visibility = "hidden";
    PanelWindow.style.visibility = "hidden";
    PanelConnect.style.visibility = "hidden";
    return;
  }
  PanelImport.style.visibility = "hidden";
});
BtnHelpPanel.addEventListener("click", () => {
  if (PanelHelp.style.visibility === "hidden") {
    PanelHelp.style.visibility = "visible";
    PanelExport.style.visibility = "hidden";
    PanelImport.style.visibility = "hidden";
    PanelInterface.style.visibility = "hidden";
    PanelWindow.style.visibility = "hidden";
    PanelConnect.style.visibility = "hidden";
    return;
  }
  PanelHelp.style.visibility = "hidden";
});

BtnNetworkPanel.addEventListener("click", () => {
  if (PanelNetwork.style.visibility === "hidden") {
    PanelNetwork.style.visibility = "visible";
    PanelHelp.style.visibility = "hidden";
    PanelExport.style.visibility = "hidden";
    PanelImport.style.visibility = "hidden";
    PanelInterface.style.visibility = "hidden";
    PanelWindow.style.visibility = "hidden";
    PanelConnect.style.visibility = "hidden";
    return;
  }
  PanelNetwork.style.visibility = "hidden";
});

BtnNetworkRestart.addEventListener("click", async () => {
  try {
    const response = await fetch("/api/network", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action: "restart",
        source: "ui",
        ts: Date.now()
      }),
    });
    const result = await response.json();
    if (result.ok) {
        alert(language[currentLanguage]["NetworkRestartSuccess"]);
    } else {
        alert(language[currentLanguage]["NetworkRestartFailed"] + ": " + (result.error || "Unknown error"));
    }
  } catch (error) {
    alert(language[currentLanguage]["NetworkRestartFailed"] + ": " + error.message);
  }
});

BtnMusic.addEventListener("click", () => {
  if (
    MusicPanelList.options[MusicPanelList.options.selectedIndex].value === "Yes"
  ) {
    MusicPanelList.selectedIndex = 0;
  } else {
    MusicPanelList.selectedIndex = 1;
  }
  changeMusicPanel();
});
BtnExport.addEventListener("click", () => {
  // 生成 Python 代码
  var code = pythonGenerator.workspaceToCode(ws);
  if (code.trim() === "") {
    return;
  }

  // 序列化 Blockly Workspace（用于导入还原）
  const workspaceState = Blockly.serialization.workspaces.save(ws);
  const serializedJson = JSON.stringify(workspaceState);

  // 生成文件头部（包含 Blockly 序列化数据）
  const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
  const filename = `blockly_code_${timestamp}.py`;
  const fileHeader = `# MagosMaster编程生成的代码
# 生成时间: ${new Date().toLocaleString("zh-CN")}
# 文件: ${filename}
#
# 此代码由Blockly编程环境自动生成
#
# === BLOCKLY_WORKSPACE_BEGIN ===
# ${serializedJson}
# === BLOCKLY_WORKSPACE_END ===
#
`;
  const fullCode = fileHeader + code;

  // 创建下载链接
  const blob = new Blob([fullCode], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  // 创建下载元素
  const downloadLink = document.createElement("a");
  downloadLink.href = url;
  downloadLink.download = filename;
  downloadLink.style.display = "none";

  // 添加到页面并触发下载
  document.body.appendChild(downloadLink);
  downloadLink.click();

  // 清理
  setTimeout(() => {
    document.body.removeChild(downloadLink);
    URL.revokeObjectURL(url);
  }, 100);
});
BtnImport.addEventListener("click", () => {
  // 触发隐藏的文件输入框
  const ImportFileInput = document.getElementById("ImportFileInput");
  if (ImportFileInput) {
    ImportFileInput.click();
  }
});
if (BtnGetHelp) {
  BtnGetHelp.addEventListener("click", () => {
    window.open("/api/manual", "_blank");
  });
}

// 监听文件选择
const ImportFileInput = document.getElementById("ImportFileInput");
if (ImportFileInput) {
  ImportFileInput.addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (file) {
      handleImportPythonFile(file);
      // 清空 input，允许重复选择同一文件
      event.target.value = "";
    }
  });
}

BtnMusicPlay.addEventListener("click", () => {
  if (!isPlay) {
    if (playVoice()) {
      isPlay = true;
    }
  } else {
    if (pauseVoice()) {
      isPlay = false;
    }
  }
});
BtnMusicLeft.addEventListener("click", () => {
  selectAdjacentSong(-1);
});
BtnMusicRight.addEventListener("click", () => {
  selectAdjacentSong(1);
});
if (UploadMusic && UploadMusicInput) {
  UploadMusic.addEventListener("click", () => {
    UploadMusicInput.click();
  });
  UploadMusicInput.addEventListener("change", handleMusicUpload);
}
if (DeleteMusic) {
  DeleteMusic.addEventListener("click", () => {
    if (!isDeleteMode) {
      setDeleteMode(true);
      return;
    }
    deleteSelectedMusic();
  });
}
// 点击事件
BtnPlay.addEventListener("click", RunCode);
BtnReset.addEventListener("click", resetRobot);
BtnClear.addEventListener("click", ClearCode);
BtnConnect.addEventListener("click", BLE_Connect);
BtnDeviceScan.addEventListener("click", onDeviceScanClick);
BtnDisConnect.addEventListener("click", BLE_Disconnect);
if (BtnRename) {
  BtnRename.addEventListener("click", async () => {
    if (ConnectedDevice === "") return; // Should be disabled anyway
    
    const promptTitle = language[currentLanguage]["ParagraphRename"];
    const input = prompt(promptTitle, ConnectedDevice);
    if (input === null) return; // Cancel
    
    const newName = input.trim();
    if (!newName) {
      alert(language[currentLanguage]["Rename_Empty"]);
      return;
    }
    
    if (new TextEncoder().encode(newName).length > 31) {
      alert(language[currentLanguage]["Rename_TooLong"]);
      return;
    }

    try {
      BtnRename.disabled = true;
      const res = await fetch("/api/ble/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ new_name: newName }),
      });
      const data = await res.json().catch(() => ({}));
      
      if (data.status === "success") {
        ConnectedDevice = data.new_name || newName;
        updateConnectedDeviceUI();
        // Option: alert(language[currentLanguage]["Rename_Success"]);
      } else {
        alert(data.message || language[currentLanguage]["Rename_Failed"]);
      }
    } catch (err) {
      console.error(err);
      alert(language[currentLanguage]["Rename_Failed"]);
    } finally {
      updateConnectedDeviceUI();
    }
  });
}
// 变化事件
ThemeList.addEventListener("change", changeTheme);
DeviceList.addEventListener("change", setTargetDevice);
LanguageList.addEventListener("change", changeLang);
CodePanelList.addEventListener("change", changeCodePanel);
GamesPanelList.addEventListener("change", changGamesPanel);
MusicPanelList.addEventListener("change", changeMusicPanel);
MusicInput.addEventListener("input", () => {
  clearTimeout(inputTimer);
  inputTimer = setTimeout(async () => {
    const query = MusicInput.value;
    const results = searchSongs(query);
    // console.log(results);
    displaySongs(results);
  }, 500);
});

// Since changeLang() loads the workspace (if needed), we should call it first
// or ensure messages are set before loading.
// We already called updateMagosMessages("hant") above.

// ============ 新增：服务器重启时强制清除workspace和trashcan ============
// 清除localStorage中的workspace数据，确保每次服务器重启后工作区和垃圾桶都是空白的
try {
  window.localStorage?.removeItem('mainWorkspace');
  console.log('[Init] Cleared workspace storage on server restart');
} catch (e) {
  console.warn('[Init] Failed to clear workspace storage:', e);
}
// 清空当前workspace（确保工作区完全空白）
if (ws && typeof ws.clear === 'function') {
  ws.clear();
}
// 清空trashcan中的blocks
try {
  if (ws && ws.trashcan) {
    // 清空trashcan的contents
    if (ws.trashcan.contents && Array.isArray(ws.trashcan.contents)) {
      ws.trashcan.contents = [];
    }
    // 如果trashcan有flyout，关闭它
    if (ws.trashcan.flyout) {
      ws.trashcan.flyout.hide?.();
    }
    // 关闭trashcan
    if (typeof ws.trashcan.close === 'function') {
      ws.trashcan.close();
    }
    console.log('[Init] Cleared trashcan on server restart');
  }
} catch (e) {
  console.warn('[Init] Failed to clear trashcan:', e);
}
// ============================================

// Load workspace from localStorage before changeLang to preserve blocks
load(ws);
changeLang(); 
// load(ws) is called inside changeLang(), so we don't strictly need it here if changeLang runs.
// However, changeLang might depend on UI state.
// Let's keep load(ws) but ensure it runs SAFELY.
if (!Blockly.Msg.MAGOS_PLAY_BG_MUSIC_TITLE) {
  updateMagosMessages("hant");
}

ShowCode();
BLE_Refresh();
initializeSongs();
displaySongs(searchSongs(""));
changeTheme();
// changeLang(); // Moved up
startBatteryStatusPolling();
songs = getAllSongs();

// 初始化并绑定电量显示配置菜单
function initBatteryDisplayConfig() {
  const btn = document.getElementById('BtnBatteryDisplayPanel');
  const menu = document.getElementById('battery_config_menu');
  const items = menu ? Array.from(menu.querySelectorAll('.battery-config-item')) : [];
  let isPosting = false;

  if (!btn || !menu) return;

  function openMenu() {
    // position menu under the button using viewport coords
    const r = btn.getBoundingClientRect();
    menu.style.left = `${Math.max(8, r.left)}px`;
    menu.style.top = `${r.bottom + 6}px`;
    menu.style.display = 'block';
    menu.setAttribute('aria-hidden', 'false');
    btn.setAttribute('aria-expanded', 'true');
    // focus first item for keyboard access
    const first = items[0];
    if (first) first.focus();
  }

  function closeMenu() {
    menu.style.display = 'none';
    menu.setAttribute('aria-hidden', 'true');
    btn.setAttribute('aria-expanded', 'false');
  }

  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (menu.style.display === 'block') closeMenu();
    else openMenu();
  });

  // click outside closes
  document.addEventListener('click', (ev) => {
    if (!menu || !btn) return;
    if (menu.style.display !== 'block') return;
    if (ev.target === btn || menu.contains(ev.target)) return;
    closeMenu();
  });

  // keyboard: Esc closes
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && menu.style.display === 'block') {
      closeMenu();
    }
  });

  function setItemsDisabled(disabled) {
    items.forEach((it) => {
      it.disabled = !!disabled;
      if (disabled) it.setAttribute('aria-disabled', 'true');
      else it.removeAttribute('aria-disabled');
    });
  }

  async function handleSelect(mode) {
    if (isPosting) return;
    isPosting = true;
    setItemsDisabled(true);
    try {
      await postBatteryDisplayMode(mode);
      console.log('Battery display mode set to', mode);
      try { alert('設定成功'); } catch (e) {}
    } catch (err) {
      console.error('Failed to set battery display mode', err);
      try { alert('設定失敗'); } catch (e) {}
    } finally {
      isPosting = false;
      setItemsDisabled(false);
      closeMenu();
    }
  }

  items.forEach((it) => {
    it.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const v = parseInt(it.getAttribute('data-value'));
      handleSelect(v);
    });
    // keyboard Enter/Space will trigger button click by default
  });
}

async function postBatteryDisplayMode(mode) {
  const payload = { display_mode: Number(mode) };
  const opts = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };
  const res = await fetch('/api/robot/battery_display', opts);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText} ${text}`);
  }
  return res.json().catch(() => ({}));
}

// call initializer
initBatteryDisplayConfig();

// 启动完成后立即做一次 BLE 状态对齐（仅一次）
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", checkBleStatusOnLoad, {
    once: true,
  });
} else {
  checkBleStatusOnLoad();
}

// ============ 新增：强制 Blockly 重新计算布局（仅 svgResize + ws.resize）===========
function forceBlocklyLayout() {
  try {
    if (!ws) return;
    if (typeof Blockly !== "undefined" && typeof Blockly.svgResize === "function") {
      Blockly.svgResize(ws);
    }
    if (typeof ws.resize === "function") {
      ws.resize();
    }
  } catch (error) {
    console.warn("forceBlocklyLayout failed:", error);
  }
}

window.addEventListener("load", () => {
  // load 后资源/字体可能仍在最后 settle：立即 + 0ms + 100ms 各触发一次
  forceBlocklyLayout();
  setTimeout(forceBlocklyLayout, 0);
  setTimeout(forceBlocklyLayout, 100);
});

window.addEventListener("resize", () => {
  // 只做布局重算，不修改 toolbox 宽度/定位
  setTimeout(forceBlocklyLayout, 0);
});
// ============================================

// ============ 新增：页面卸载时清理轮询 ============
window.addEventListener("beforeunload", () => {
  stopPolling();
});
// ============================================

// ============ 新增：面板互斥管理器（捕获阶段叠加，不改现有 click 逻辑） ============
function initExclusivePanels() {
  // 要管理的面板 id 列表（如不存在则跳过）
  const panelIds = [
    'PanelConnect',
    'PanelInterface',
    'PanelWindow',
    'PanelExpore',
    'PanelImport',
    'PanelBatteryDisplay',
    'PanelNetwork',
    'PanelHelp'
  ];

  // 按钮 -> 面板 映射（明确写出，避免自动推断出错）
  const btnToPanel = {
    BtnConnectPanel: 'PanelConnect',
    BtnInterfacePanel: 'PanelInterface',
    BtnWindowPanel: 'PanelWindow',
    BtnExportPanel: 'PanelExpore',
    BtnImportPanel: 'PanelImport',
    BtnBatteryDisplayPanel: 'PanelBatteryDisplay',
    BtnNetworkPanel: 'PanelNetwork',
    BtnHelpPanel: 'PanelHelp'
  };

  const nav = document.getElementById('Navigation');
  if (!nav) {
    console.warn('[initExclusivePanels] #Navigation not found, skipping');
    return;
  }

  // 收集存在的 panel 元素
  const panels = panelIds.map(id => ({ id, el: document.getElementById(id) })).filter(p => p.el);

  // ============ 新增：关闭 Blockly Flyout ============
  function closeBlocklyFlyout() {
    try {
      if (!ws) return;
      // 优先使用官方 API 关闭 Flyout
      const flyout = ws.getFlyout?.() || ws.getToolbox?.()?.getFlyout?.();
      if (flyout && typeof flyout.hide === 'function') {
        flyout.hide();
      }
      // 清除 toolbox 选中态（如果存在）
      const toolbox = ws.getToolbox?.();
      if (toolbox && typeof toolbox.clearSelection === 'function') {
        toolbox.clearSelection();
      }
    } catch (e) {
      // 容错：如果关闭失败则跳过（不影响其他逻辑）
    }
  }

  // ============ 新增：关闭 Blockly 垃圾桶展开状态 ============
  function closeBlocklyTrashcan() {
    try {
      if (!ws) return;
      // 获取垃圾桶对象并关闭其 flyout
      const trashcan = ws.trashcan;
      if (trashcan && typeof trashcan.close === 'function') {
        trashcan.close();
      }
    } catch (e) {
      // 容错：如果关闭失败则跳过（不影响其他逻辑）
    }
  }

  // ============ 新增：关闭电量配置菜单 ============
  function closeBatteryConfigMenuIfOpen() {
    try {
      const menu = document.getElementById('battery_config_menu');
      if (!menu) return;
      if (menu.style.display === 'block') {
        menu.style.display = 'none';
        menu.setAttribute('aria-hidden', 'true');
        // 同步按钮状态
        const btn = document.getElementById('BtnBatteryDisplayPanel');
        if (btn) {
          btn.setAttribute('aria-expanded', 'false');
        }
      }
    } catch (e) {
      // 容错：如果关闭失败则跳过
    }
  }

  function closeAllExcept(allowedPanelId) {
    panels.forEach(({ id, el }) => {
      if (id === allowedPanelId) return; // 保留允许的面板（由原逻辑决定打开/关闭）
      try {
        // 原工程大量使用 style.visibility 控制显隐，沿用该方式关闭
        if (el && typeof el.style !== 'undefined') {
          el.style.visibility = 'hidden';
        }
      } catch (e) {
        console.warn('[initExclusivePanels] failed to hide', id, e);
      }
    });
  }

  // 在 Navigation 上使用捕获阶段监听，先关闭其他面板，再让原有 click 回调执行
  nav.addEventListener('click', (ev) => {
    const btn = ev.target.closest('#BtnConnectPanel, #BtnInterfacePanel, #BtnWindowPanel, #BtnExportPanel, #BtnImportPanel, #BtnBatteryDisplayPanel, #BtnNetworkPanel, #BtnHelpPanel');
    if (!btn) return; // 不是我们关心的按钮
    // 如果按钮存在但对应面板不存在，也应照样关闭其它面板
    const targetPanelId = btnToPanel[btn.id] || null;
    closeAllExcept(targetPanelId);
    // ============ 新增：关闭 Blockly Flyout 和电量配置菜单 ============
    closeBlocklyFlyout();
    closeBatteryConfigMenuIfOpen();
    // 注意：不调用 stopPropagation/preventDefault，保留原有逻辑继续执行
  }, true); // 捕获阶段

  // 点击页面空白处（既不在 Navigation，也不在任一面板内部）关闭所有面板
  document.addEventListener('click', (ev) => {
    // 如果点在导航内，忽略
    if (nav.contains(ev.target)) return;
    // 如果点在任一面板内，忽略
    for (const p of panels) {
      if (p.el.contains(ev.target)) return;
    }
    // 否则关闭全部
    closeAllExcept(null);
    // ============ 新增：点击空白区域时关闭垃圾桶 ============
    closeBlocklyTrashcan();
    // ====================================================
  }, true); // 捕获阶段，优先于冒泡阶段的其他逻辑

  // ============ 新增：监听 Blockly toolbox 选择事件 ============
  // 当用户点击左侧分类（逻辑/循环/数学等）时，关闭所有顶部面板
  try {
    if (ws && typeof ws.addChangeListener === 'function') {
      ws.addChangeListener((event) => {
        try {
          // 捕捉 toolbox 选择事件（Blockly.Events.TOOLBOX_ITEM_SELECT）
          if (event.type === Blockly.Events.TOOLBOX_ITEM_SELECT) {
            // 只有在真正选择了新分类时才关闭顶部面板（newItem 不为 null）
            // 如果是清除选择（newItem 为 null），则忽略，避免与顶部按钮点击冲突
            if (event.newItem != null) {
              // 用户选择了左侧分类，关闭所有顶部面板和电量菜单
              closeAllExcept(null);
              closeBatteryConfigMenuIfOpen();
            }
          }
        } catch (e) {
          // 事件处理失败不影响其他逻辑
        }
      });
    }
  } catch (e) {
    console.warn('[initExclusivePanels] failed to add Blockly change listener', e);
  }

  // 小提示（非必要）：若没有任何面板存在则记录一次信息
  if (panels.length === 0) {
    console.warn('[initExclusivePanels] no managed panels found, nothing to do');
  }
}

// ============ Random Star Feature ============
function addRandomPentagram() {
  const star = document.createElement("div");
  star.innerHTML = "★";
  star.style.position = "fixed";
  star.style.left = Math.random() * window.innerWidth + "px";
  star.style.top = Math.random() * window.innerHeight + "px";
  star.style.fontSize = (Math.random() * 50 + 20) + "px";
  star.style.color = "red";
  star.style.zIndex = "9999";
  star.style.pointerEvents = "none";
  star.style.userSelect = "none";
  document.body.appendChild(star);
}
// Add a star on load
addRandomPentagram();

// 插入点：在脚本末尾初始化互斥管理器
try {
  initExclusivePanels();
} catch (e) {
  console.error('[initExclusivePanels] init failed', e);
}

// ===================================
// Network Login Interface Implementation
// ===================================
if (BtnNetworkLogin && DialogNetworkLogin) {
  BtnNetworkLogin.addEventListener("click", () => {
    DialogNetworkLogin.style.display = "block";
    if (NetworkLoginAccountInput) NetworkLoginAccountInput.value = "";
    if (NetworkLoginPasswordInput) NetworkLoginPasswordInput.value = "";
  });

  if (DialogNetworkLoginMask) {
    DialogNetworkLoginMask.addEventListener("click", () => {
      DialogNetworkLogin.style.display = "none";
    });
  }

  if (BtnNetworkLoginConfirm) {
    BtnNetworkLoginConfirm.addEventListener("click", () => {
      const account = NetworkLoginAccountInput.value || "";
      const password = NetworkLoginPasswordInput.value || "";
      const enc = new TextEncoder();
      const accountBytes = enc.encode(account).length;
      const passBytes = enc.encode(password).length;

      const langData = language[currentLanguage] || language.en;

      if (accountBytes < 1 || accountBytes > 32) {
        alert(langData.NetworkLoginAccountInvalid);
        return;
      }
      if (passBytes < 6 || passBytes > 63) {
        alert(langData.NetworkLoginPasswordInvalid);
        return;
      }

      fetch("/api/network/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "login",
          account: account,
          password: password,
          ts: Date.now(),
          source: "ui"
        })
      })
      .then(res => res.json())
      .then(data => {
        if (data.ok) {
          alert(langData.NetworkLoginSuccess);
          DialogNetworkLogin.style.display = "none";
        } else {
          alert(langData.NetworkLoginFailed + (data.error ? ": " + data.error : ""));
        }
      })
      .catch(err => {
         alert(langData.NetworkLoginFailed + ": " + err);
      });
    });
  }
}



