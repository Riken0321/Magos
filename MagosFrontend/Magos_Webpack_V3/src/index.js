import * as Blockly from "blockly";
import {
  hans_blocks,
  setActionsLanguage,
  refreshActionOptionsData,
  refreshShortcutActionOptionsData,
} from "./blocks/hans_text";
import { forBlock } from "./generators/mypython";
import { pythonGenerator } from "blockly/python";
import { registerFieldAngle } from "./libs/plugins/field-angle";
import { registerFieldSignedAngle } from "./libs/plugins/field-signed-angle";
import { save, load } from "./libs/serialization";
import { toolbox } from "./libs/mytoolbox";
import * as hans from "blockly/msg/zh-hans";
import * as hant from "blockly/msg/zh-hant";
import * as en from "blockly/msg/en";
import "./index.css";
import LwFirewords from 'lw_firewords'
registerFieldAngle();
registerFieldSignedAngle();
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
const MAGOS_MUSIC_SELECTED_SLOT_KEY = "magos_music_selected_slot_v1";
let magosMusicSelectedSlot = "";
// [MAGOS_DEMO_BEGIN __MAGOS_DEMO_PREVIEW__ feature=music_multi_slot]
const MAGOS_DEMO_KEY = "magos_demo_mode";
const MAGOS_MUSIC_DEMO_SLOT_KEY = "magos_music_demo_slot";
// [MAGOS_DEMO_END]
let targetConnectDevice = null;
const bleDiscoveredDeviceMap = new Map();
let isDeviceScanAnimating = false;
let isBleScanInFlight = false;
let bleAutoScanTimer = null;
let bleLastAutoScanErrorAt = 0;
const BLE_AUTO_SCAN_INTERVAL_MS = 10000;
const BLE_AUTO_SCAN_ERROR_ALERT_INTERVAL_MS = 30000;

// ============ Multi-Robot Slot State ============
const ROBOT_SLOT_STORAGE_KEY = "magos_robot_slot_ids_v1";
const ROBOT_SLOT_MAX = 6;
const DEFAULT_ROBOT_SLOT_IDS = ["A", "B", "C", "D"];
const BLOCK_TYPES_WITH_ROBOT_ID = new Set([
  "ServoControl",
  "animations_start",
  "shortcut_action_start",
  "play_background_audio",
  "stop_background_audio",
  "change_emoji",
  "play_audio",
  "magos_time",
]);

function loadActiveRobotSlotIds() {
  try {
    const raw = localStorage.getItem(ROBOT_SLOT_STORAGE_KEY);
    if (!raw) return [...DEFAULT_ROBOT_SLOT_IDS];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return [...DEFAULT_ROBOT_SLOT_IDS];
    }
    const out = [];
    for (let i = 0; i < Math.min(ROBOT_SLOT_MAX, parsed.length); i++) {
      const expected = String.fromCharCode(65 + i);
      if (parsed[i] !== expected) break;
      out.push(expected);
    }
    return out.length ? out : [...DEFAULT_ROBOT_SLOT_IDS];
  } catch {
    return [...DEFAULT_ROBOT_SLOT_IDS];
  }
}

function saveActiveRobotSlotIds() {
  try {
    localStorage.setItem(ROBOT_SLOT_STORAGE_KEY, JSON.stringify(activeRobotSlotIds));
  } catch (e) {
    console.warn("saveActiveRobotSlotIds failed", e);
  }
}

let activeRobotSlotIds = loadActiveRobotSlotIds();
const robotSlots = new Map();

function ensureRobotSlotState(id) {
  if (!robotSlots.has(id)) {
    robotSlots.set(id, {
      id,
      connectedDevice: "",
      targetDevice: null,
      status: "connect",
      battery: null,
    });
  }
}
activeRobotSlotIds.forEach((id) => ensureRobotSlotState(id));
const STATUS_IDLE = 0;
const STATUS_RUNNING = 1;
const STATUS_PAUSED = 2;
const STATUS_DISCONNECTED = 3;
let currentRobotStatus = STATUS_IDLE;
let isParallelExecutionActive = false;

// ============ 新增：轮询配置与状态管理 ============
const POLL_MS = 1000; // 轮询间隔（ms）
let pollTimerId = null; // 轮询定时器 ID
let isPlayButtonDisabled = false; // 防连点标志
let isTaskRequestInProgress = false; // Play 相关请求锁（start/pause/resume）
let isResetRequestInProgress = false; // Reset 请求锁
const RESET_TIMEOUT_MS = 5000; // reset 超时保护（ms）
let otaEventSource = null;
let otaCurrentSessionId = "";
let otaStartRequestInFlight = false;
let otaStatusFallbackTimer = null;
let otaStatusFallbackSessionId = "";
let otaStatusFallbackFailCount = 0;
const OTA_STATUS_FALLBACK_INTERVAL_MS = 1000;
const OTA_STATUS_FALLBACK_MAX_FAIL_COUNT = 10;
let isSetAiAgentRequestInFlight = false;
let isActionGroupSaveRequestInFlight = false;
let isActionGroupPoseLoading = false;
let isActionGroupPreviewAllowed = true;
let actionGroupUserItems = [];
let actionGroupDeleteRequestInFlightId = "";
let actionGroupUserListLoading = false;
let actionGroupPreviewNeedBleShown = false;
let actionGroupPreviewErrorShown = false;
let actionGroupPreviewFlushTimer = null;
let actionGroupPreviewSending = false;
const actionGroupPreviewPendingByServo = new Map();
const actionGroupLastPreviewAngleByServo = new Map();
const ACTION_GROUP_PREVIEW_THROTTLE_MS = 80;
const ACTION_GROUP_HINT_ID = "ActionGroupHint";
let musicUploadEventSource = null;
let musicUploadTransferId = "";
let musicUploadRequestInFlight = false;
let musicUploadFallbackTimer = null;
let musicUploadFallbackActive = false;
let musicUploadStatusPollTimer = null;
let musicUploadStatusPollActive = false;
let musicUploadStatusPollRetries = 0;
let musicUploadTerminalStage = "";
const musicListVersionSeenBySlot = {};
let musicSyncInFlight = null;
let musicLastDoneSyncAt = 0;
const MUSIC_UPLOAD_FALLBACK_INTERVAL_MS = 1000;
const MUSIC_UPLOAD_FALLBACK_MAX_RETRIES = 5;
const MUSIC_UPLOAD_STATUS_POLL_INTERVAL_MS = 1000;
const MUSIC_UPLOAD_STATUS_POLL_MAX_RETRIES = 90;
const MAX_MUSIC_UPLOAD_BYTES = 10 * 1024 * 1024;
const MUSIC_SYNC_DONE_DEDUPE_MS = 800;
const MUSIC_SYNC_HINT_ID = "MusicSyncHint";
const MUSIC_DEVICE_SYNC_POLL_INTERVAL_MS = 800;
const MUSIC_DEVICE_SYNC_MAX_POLLS = 20;
let musicDeviceSyncPollTimer = null;
let musicDeviceSyncPollCount = 0;
let musicDeviceSyncSessionId = "";
let musicDeviceSyncRequestInFlight = false;
let wasBleConnected = false;
let shortcutActions = [];
let shortcutEventSource = null;
let shortcutIsCapturing = false;
let shortcutCapturedBinding = null;
let shortcutConfirmQueue = [];
let shortcutPendingConfirmEvent = null;
let shortcutListenerWarningShown = false;
const shortcutLocalTriggerAt = new Map();
let pendingExportPayload = null;
let isLicenseImportInFlight = false;
let pendingLicenseAgentId = "";
let latestRobotStatusSnapshot = null;
let licenseStatusState = {
  loaded: false,
  licensed: false,
  agent_access: {},
  entitlements: { agents: [] },
};

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
    ParagraphRobotSlotCount: "连接槽位数",
    BtnRobotSlotApply: "应用",
    BtnRobotSlotAdd: "添加槽位",
    RobotSlotCountHintFmt: "{cur}/6",
    ParallelOverviewTitle: "并行总览",
    ParallelOverviewNoDevice: "暂无已连接设备",
    ParallelOverviewReadyFmt: "已连接 {count} 台：{slots}",
    ParallelOverviewRunningFmt: "并行执行中：{slots}",
    ParallelHubTitle: "并行调度中心",
    ParallelHubCoreLabel: "调度",
    ParallelHubNoDevice: "暂无已连接设备",
    ParallelHubReadyFmt: "中心待命，已连接 {count} 台：{slots}",
    ParallelHubRunningFmt: "中心并行下发中：{slots}",
    ParallelHubPausedFmt: "并行已暂停：{slots}",
    ParallelHubErrorFmt: "部分分支异常：{slots}",
    BlocklyRobotConnectFirst: "请先连接设备",
    BlocklyRobotSlotDisconnected: "未连接",
    RobotSlotReduceBlocked: "请先断开末尾槽位上的设备，再减少槽位数量。",
    RobotSlotMaxReached: "已达到上限 6 个槽位。",
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
    MusicUploadOnlyMp3: "仅支持上传 MP3 格式文件",
    MusicUploadTooLarge: "MP3 文件大小不能超过 10MB",
    BtnDeleteMusic: "删除",
    BtnDeleteMusicConfirm: "确定",
    BtnExport: "导出",
    ExportNameDialogTitle: "导出文件命名",
    ExportNamePlaceholder: "请输入导出文件名",
    BtnExportNameCancel: "取消",
    BtnExportNameConfirm: "确定",
    ExportNameEmptyAlert: "请输入文件名",
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
    BleScanNoDevices: "未发现蓝牙设备，请确认设备已开机后重试。",
    BleScanFailed: "蓝牙扫描失败",
    LanguageList_hant: "繁体中文",
    LanguageList_hans: "简体中文",
    LanguageList_en: "英文",
    ThemeList_Dark: "深色",
    ThemeList_Light: "浅色",
    MusicInputPlaceholder: "|搜索音乐",
    BatteryDisconnected: "电量：--",
    BatteryLabel: "电量：",
    BatteryCfgTargetTitle: "目标设备",
    BatteryCfgTargetActive: "当前设备",
    BatteryCfgTargetSelected: "手动多选",
    BatteryCfgTargetAll: "全选已连接",
    BatteryCfgShow: "显示",
    BatteryCfgHide: "不显示",
    BatteryCfgRetryFailedFmt: "重试失败设备（{count}）",
    BatteryCfgApplyFmt: "（对 {count} 台设备生效）",
    BatteryCfgNoConnected: "暂无已连接设备",
    BatteryCfgSlotFmt: "槽位 {slot}",
    BatteryCfgSuccess: "设置成功",
    BatteryCfgFailed: "设置失败",
    BatteryCfgPartialFmt: "部分成功：成功 {success} 台，失败 {failed} 台",
    BatteryCfgResultSuccess: "成功",
    BatteryCfgResultFailed: "失败",
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
    ActionGroupNeedBle: "请先连接蓝牙设备",
    OtaNeedBle: "请先连接蓝牙设备",
    OtaSlotLabel: "更新机位",
    OtaSlotSelectPlaceholder: "请选择机位",
    OtaSlotHintNoConnected: "暂无已连接机位",
    OtaSlotHintSelectedFmt: "将更新机位 {slot}",
    OtaSlotRequired: "请先选择更新机位",
    ActionGroupLoadingPose: "正在读取当前姿态...",
    ActionGroupPoseFallbackCache: "未获取到实时姿态，已使用缓存值。",
    ActionGroupPreviewSendFailed: "实时预览发送失败，请检查连接。",
    ActionGroupPreviewNeedBle: "蓝牙已断开，请先重新连接蓝牙设备。",
    BtnActionGroupPanel: "管理动作组",
    ActionGroupTitle: "管理动作组",
    ActionGroupNameLabel: "命名",
    ActionGroupNamePlaceholder: "请输入动作组名称",
    BtnActionGroupConfirm: "确定",
    ActionGroupNameRequired: "请输入动作组名称",
    ActionGroupSaved: "动作组已保存",
    ActionGroupSaveFailed: "保存动作组失败",
    ActionGroupUserListTitle: "我添加的动作组",
    ActionGroupUserListLoading: "正在加载动作组...",
    ActionGroupUserListEmpty: "暂无可删除的用户动作组",
    ActionGroupDeleteButton: "删除",
    ActionGroupDeleteConfirm: "确认删除动作组“{name}”？",
    ActionGroupDeleteSuccess: "动作组已删除",
    ActionGroupDeleteFailed: "删除动作组失败",
    BtnShortcutMapping: "快捷键",
    ShortcutActionTitle: "快捷键动作组映射",
    ShortcutActionCaptureLabel: "按键映射",
    BtnShortcutCaptureKey: "开始录入",
    ShortcutActionCaptureIdle: "未设置",
    ShortcutActionCaptureListening: "监听中，请按下快捷键…",
    ShortcutActionNameLabel: "名称",
    ShortcutActionNamePlaceholder: "请输入快捷键动作组名称",
    ShortcutActionSummaryTitle: "动作摘要（当前Blockly脚本）",
    BtnShortcutActionConfirm: "保存快捷键动作组",
    ShortcutActionSavedTitle: "已保存快捷键动作组",
    ShortcutActionNeedName: "请输入快捷键动作组名称",
    ShortcutActionNeedKey: "请先录入快捷键",
    ShortcutActionNeedCode: "当前脚本为空，无法绑定快捷键",
    ShortcutActionSaved: "快捷键动作组已保存",
    ShortcutActionSaveFailed: "保存快捷键动作组失败",
    ShortcutActionDelete: "删除",
    ShortcutActionDeleteFailed: "删除快捷键动作组失败",
    ShortcutActionNoData: "暂无快捷键动作组",
    ShortcutConfirmTitle: "确认执行快捷键动作",
    ShortcutConfirmMessage: "是否执行动作：[动作名称]？",
    ShortcutConfirmYes: "确认",
    ShortcutConfirmNo: "取消",
    ShortcutBusy: "当前机器人正在执行任务，已拒绝快捷键触发。",
    ShortcutMacPermissionHint: "macOS 需开启辅助功能权限才能启用全局快捷键。",
    ShortcutSidebarTitle: "快捷键动作组",
    ParagraphAgentLicense: "许可证",
    LicenseStatusUnknown: "许可证状态：读取中",
    LicenseStatusUnlicensed: "未授权（0/4）",
    LicenseStatusLicensedFmt: "已授权（{count}/4）",
    BtnImportLicense: "导入许可证",
    LicenseNeedImport: "该智能体未授权，请先导入许可证。",
    LicenseImportTitle: "导入许可证",
    LicenseImportHint: "该智能体未授权，请导入许可证文件。",
    LicenseTargetFmt: "目标智能体：{name}",
    LicenseTargetGeneral: "目标智能体：通用导入",
    BtnLicenseImportCancel: "取消",
    BtnLicenseImportChoose: "选择许可证文件",
    LicenseImportNoFile: "请选择许可证文件",
    LicenseImportSuccess: "许可证导入成功",
    LicenseImportFailed: "许可证导入失败",
    LicenseInvalidFormat: "许可证文件格式错误",
    LicenseInvalidSignature: "许可证签名校验失败",
    LicenseExpired: "许可证已过期",
    LicenseAgentMismatch: "许可证不属于当前支持的智能体",
    LicenseRequired: "该智能体需要许可证",
    LicenseRuntimeUnavailable: "许可证模块不可用",
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
    ParagraphRobotSlotCount: "連接槽位數",
    BtnRobotSlotApply: "應用",
    BtnRobotSlotAdd: "添加槽位",
    RobotSlotCountHintFmt: "{cur}/6",
    ParallelOverviewTitle: "並行總覽",
    ParallelOverviewNoDevice: "暫無已連接設備",
    ParallelOverviewReadyFmt: "已連接 {count} 台：{slots}",
    ParallelOverviewRunningFmt: "並行執行中：{slots}",
    ParallelHubTitle: "並行調度中心",
    ParallelHubCoreLabel: "調度",
    ParallelHubNoDevice: "暫無已連接設備",
    ParallelHubReadyFmt: "中心待命，已連接 {count} 台：{slots}",
    ParallelHubRunningFmt: "中心並行下發中：{slots}",
    ParallelHubPausedFmt: "並行已暫停：{slots}",
    ParallelHubErrorFmt: "部分分支異常：{slots}",
    BlocklyRobotConnectFirst: "請先連接設備",
    BlocklyRobotSlotDisconnected: "未連接",
    RobotSlotReduceBlocked: "請先斷開末尾槽位上的設備，再減少槽位數量。",
    RobotSlotMaxReached: "已達上限 6 個槽位。",
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
    MusicUploadOnlyMp3: "僅支援上傳 MP3 格式檔案",
    MusicUploadTooLarge: "MP3 檔案大小不能超過 10MB",
    BtnDeleteMusic: "刪除",
    BtnDeleteMusicConfirm: "確定",
    BtnExport: "導出",
    ExportNameDialogTitle: "導出檔案命名",
    ExportNamePlaceholder: "請輸入導出檔案名",
    BtnExportNameCancel: "取消",
    BtnExportNameConfirm: "確定",
    ExportNameEmptyAlert: "請輸入檔案名",
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
    BleScanNoDevices: "未發現藍牙設備，請確認設備已開機後重試。",
    BleScanFailed: "藍牙掃描失敗",
    LanguageList_hant: "繁體中文",
    LanguageList_hans: "簡體中文",
    LanguageList_en: "英文",
    ThemeList_Dark: "深色",
    ThemeList_Light: "淺色",
    MusicInputPlaceholder: "|搜尋音樂",
    BatteryDisconnected: "電量：--",
    BatteryLabel: "電量：",
    BatteryCfgTargetTitle: "目標設備",
    BatteryCfgTargetActive: "當前設備",
    BatteryCfgTargetSelected: "手動多選",
    BatteryCfgTargetAll: "全選已連接",
    BatteryCfgShow: "顯示",
    BatteryCfgHide: "不顯示",
    BatteryCfgRetryFailedFmt: "重試失敗設備（{count}）",
    BatteryCfgApplyFmt: "（對 {count} 台設備生效）",
    BatteryCfgNoConnected: "暫無已連接設備",
    BatteryCfgSlotFmt: "槽位 {slot}",
    BatteryCfgSuccess: "設定成功",
    BatteryCfgFailed: "設定失敗",
    BatteryCfgPartialFmt: "部分成功：成功 {success} 台，失敗 {failed} 台",
    BatteryCfgResultSuccess: "成功",
    BatteryCfgResultFailed: "失敗",
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
    ActionGroupNeedBle: "請先連接藍牙設備",
    OtaNeedBle: "請先連接藍牙設備",
    OtaSlotLabel: "更新機位",
    OtaSlotSelectPlaceholder: "請選擇機位",
    OtaSlotHintNoConnected: "暫無已連接機位",
    OtaSlotHintSelectedFmt: "將更新機位 {slot}",
    OtaSlotRequired: "請先選擇更新機位",
    ActionGroupLoadingPose: "正在讀取當前姿態...",
    ActionGroupPoseFallbackCache: "未獲取到實時姿態，已使用緩存值。",
    ActionGroupPreviewSendFailed: "實時預覽發送失敗，請檢查連接。",
    ActionGroupPreviewNeedBle: "藍牙已斷開，請先重新連接藍牙設備。",
    BtnActionGroupPanel: "管理動作組",
    ActionGroupTitle: "管理動作組",
    ActionGroupNameLabel: "命名",
    ActionGroupNamePlaceholder: "請輸入動作組名稱",
    BtnActionGroupConfirm: "確定",
    ActionGroupNameRequired: "請輸入動作組名稱",
    ActionGroupSaved: "動作組已保存",
    ActionGroupSaveFailed: "保存動作組失敗",
    ActionGroupUserListTitle: "我新增的動作組",
    ActionGroupUserListLoading: "正在載入動作組...",
    ActionGroupUserListEmpty: "暫無可刪除的用戶動作組",
    ActionGroupDeleteButton: "刪除",
    ActionGroupDeleteConfirm: "確認刪除動作組「{name}」？",
    ActionGroupDeleteSuccess: "動作組已刪除",
    ActionGroupDeleteFailed: "刪除動作組失敗",
    BtnShortcutMapping: "快捷鍵",
    ShortcutActionTitle: "快捷鍵動作組映射",
    ShortcutActionCaptureLabel: "按鍵映射",
    BtnShortcutCaptureKey: "開始錄入",
    ShortcutActionCaptureIdle: "未設置",
    ShortcutActionCaptureListening: "監聽中，請按下快捷鍵…",
    ShortcutActionNameLabel: "名稱",
    ShortcutActionNamePlaceholder: "請輸入快捷鍵動作組名稱",
    ShortcutActionSummaryTitle: "動作摘要（當前Blockly腳本）",
    BtnShortcutActionConfirm: "保存快捷鍵動作組",
    ShortcutActionSavedTitle: "已保存快捷鍵動作組",
    ShortcutActionNeedName: "請輸入快捷鍵動作組名稱",
    ShortcutActionNeedKey: "請先錄入快捷鍵",
    ShortcutActionNeedCode: "當前腳本為空，無法綁定快捷鍵",
    ShortcutActionSaved: "快捷鍵動作組已保存",
    ShortcutActionSaveFailed: "保存快捷鍵動作組失敗",
    ShortcutActionDelete: "刪除",
    ShortcutActionDeleteFailed: "刪除快捷鍵動作組失敗",
    ShortcutActionNoData: "暫無快捷鍵動作組",
    ShortcutConfirmTitle: "確認執行快捷鍵動作",
    ShortcutConfirmMessage: "是否執行動作：[動作名稱]？",
    ShortcutConfirmYes: "確認",
    ShortcutConfirmNo: "取消",
    ShortcutBusy: "當前機器人正在執行任務，已拒絕快捷鍵觸發。",
    ShortcutMacPermissionHint: "macOS 需開啟輔助功能權限才能啟用全局快捷鍵。",
    ShortcutSidebarTitle: "快捷鍵動作組",
    ParagraphAgentLicense: "許可證",
    LicenseStatusUnknown: "許可證狀態：讀取中",
    LicenseStatusUnlicensed: "未授權（0/4）",
    LicenseStatusLicensedFmt: "已授權（{count}/4）",
    BtnImportLicense: "導入許可證",
    LicenseNeedImport: "該智能體未授權，請先導入許可證。",
    LicenseImportTitle: "導入許可證",
    LicenseImportHint: "該智能體未授權，請導入許可證檔案。",
    LicenseTargetFmt: "目標智能體：{name}",
    LicenseTargetGeneral: "目標智能體：通用導入",
    BtnLicenseImportCancel: "取消",
    BtnLicenseImportChoose: "選擇許可證檔案",
    LicenseImportNoFile: "請先選擇許可證檔案",
    LicenseImportSuccess: "許可證導入成功",
    LicenseImportFailed: "許可證導入失敗",
    LicenseInvalidFormat: "許可證檔案格式錯誤",
    LicenseInvalidSignature: "許可證簽名校驗失敗",
    LicenseExpired: "許可證已過期",
    LicenseAgentMismatch: "許可證不屬於當前支援的智能體",
    LicenseRequired: "該智能體需要許可證",
    LicenseRuntimeUnavailable: "許可證模組不可用",
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
    ParagraphRobotSlotCount: "Robot slots",
    BtnRobotSlotApply: "Apply",
    BtnRobotSlotAdd: "Add slot",
    RobotSlotCountHintFmt: "{cur}/6",
    ParallelOverviewTitle: "Parallel Overview",
    ParallelOverviewNoDevice: "No connected devices",
    ParallelOverviewReadyFmt: "{count} connected: {slots}",
    ParallelOverviewRunningFmt: "Parallel running: {slots}",
    ParallelHubTitle: "Parallel Dispatch Hub",
    ParallelHubCoreLabel: "Hub",
    ParallelHubNoDevice: "No connected devices",
    ParallelHubReadyFmt: "Hub ready, {count} connected: {slots}",
    ParallelHubRunningFmt: "Hub dispatching in parallel: {slots}",
    ParallelHubPausedFmt: "Parallel paused: {slots}",
    ParallelHubErrorFmt: "Some branches failed: {slots}",
    BlocklyRobotConnectFirst: "Connect a device first",
    BlocklyRobotSlotDisconnected: "Not connected",
    RobotSlotReduceBlocked: "Disconnect devices on removed slots before reducing the count.",
    RobotSlotMaxReached: "Maximum 6 slots reached.",
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
    MusicUploadOnlyMp3: "Only MP3 files are supported",
    MusicUploadTooLarge: "MP3 file size must be <= 10MB",
    ParagraphNetworkRestart: "Restart Network",
    BtnNetworkRestart: "Restart",
    NetworkRestartSuccess: "Network restarted successfully",
    NetworkRestartFailed: "Network restart failed",
    BtnDeleteMusic: "Delete",
    BtnDeleteMusicConfirm: "Confirm",
    BtnExport: "Export",
    ExportNameDialogTitle: "Export File Name",
    ExportNamePlaceholder: "Please input export file name",
    BtnExportNameCancel: "Cancel",
    BtnExportNameConfirm: "Confirm",
    ExportNameEmptyAlert: "Please input file name",
    BtnImport: "Confirm",
    BtnGetHelp: "Get Help",
    BtnConnect: "Confirm",
    BtnDisConnect: "Confirm",
    State_Scaning: "Scanning",
    StateBLE_Connected: "Connected",
    StateBLE_Connecting: "Connecting",
    StateBLE_Disconnected: "Disconnected",
    BleScanNoDevices: "No BLE devices found. Please power on the device and try again.",
    BleScanFailed: "BLE scan failed",
    LanguageList_hant: "Traditional Chinese",
    LanguageList_hans: "Simplified Chinese",
    LanguageList_en: "English",
    ThemeList_Dark: "Dark",
    ThemeList_Light: "Light",
    MusicInputPlaceholder: "|Search music",
    BatteryDisconnected: "Battery: --",
    BatteryLabel: "Battery: ",
    BatteryCfgTargetTitle: "Target devices",
    BatteryCfgTargetActive: "Current device",
    BatteryCfgTargetSelected: "Manual multi-select",
    BatteryCfgTargetAll: "Select all connected",
    BatteryCfgShow: "Show",
    BatteryCfgHide: "Hide",
    BatteryCfgRetryFailedFmt: "Retry failed devices ({count})",
    BatteryCfgApplyFmt: " (apply to {count} device(s))",
    BatteryCfgNoConnected: "No connected devices",
    BatteryCfgSlotFmt: "Slot {slot}",
    BatteryCfgSuccess: "Setting applied",
    BatteryCfgFailed: "Setting failed",
    BatteryCfgPartialFmt: "Partial success: {success} succeeded, {failed} failed",
    BatteryCfgResultSuccess: "Success",
    BatteryCfgResultFailed: "Failed",
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
    ActionGroupNeedBle: "Please connect BLE device first",
    OtaNeedBle: "Please connect BLE device first",
    OtaSlotLabel: "Update slot",
    OtaSlotSelectPlaceholder: "Please select a slot",
    OtaSlotHintNoConnected: "No connected slots",
    OtaSlotHintSelectedFmt: "Will update slot {slot}",
    OtaSlotRequired: "Please select an update slot first",
    ActionGroupLoadingPose: "Loading current pose...",
    ActionGroupPoseFallbackCache: "Live pose unavailable, using cached values.",
    ActionGroupPreviewSendFailed: "Realtime preview failed. Please check the connection.",
    ActionGroupPreviewNeedBle: "BLE disconnected. Please reconnect BLE device first.",
    BtnActionGroupPanel: "Manage Action Groups",
    ActionGroupTitle: "Manage Action Groups",
    ActionGroupNameLabel: "Name",
    ActionGroupNamePlaceholder: "Enter action group name",
    BtnActionGroupConfirm: "Confirm",
    ActionGroupNameRequired: "Please enter action group name",
    ActionGroupSaved: "Action group saved",
    ActionGroupSaveFailed: "Failed to save action group",
    ActionGroupUserListTitle: "My Added Action Groups",
    ActionGroupUserListLoading: "Loading action groups...",
    ActionGroupUserListEmpty: "No user action groups to delete",
    ActionGroupDeleteButton: "Delete",
    ActionGroupDeleteConfirm: "Delete action group \"{name}\"?",
    ActionGroupDeleteSuccess: "Action group deleted",
    ActionGroupDeleteFailed: "Failed to delete action group",
    BtnShortcutMapping: "Shortcut",
    ShortcutActionTitle: "Shortcut Action Mapping",
    ShortcutActionCaptureLabel: "Key Binding",
    BtnShortcutCaptureKey: "Start Capture",
    ShortcutActionCaptureIdle: "Not Set",
    ShortcutActionCaptureListening: "Listening, press a shortcut...",
    ShortcutActionNameLabel: "Name",
    ShortcutActionNamePlaceholder: "Enter shortcut action name",
    ShortcutActionSummaryTitle: "Action Summary (Current Blockly Script)",
    BtnShortcutActionConfirm: "Save Shortcut Action",
    ShortcutActionSavedTitle: "Saved Shortcut Actions",
    ShortcutActionNeedName: "Please input shortcut action name",
    ShortcutActionNeedKey: "Please capture a key binding first",
    ShortcutActionNeedCode: "Current script is empty",
    ShortcutActionSaved: "Shortcut action saved",
    ShortcutActionSaveFailed: "Failed to save shortcut action",
    ShortcutActionDelete: "Delete",
    ShortcutActionDeleteFailed: "Failed to delete shortcut action",
    ShortcutActionNoData: "No shortcut actions",
    ShortcutConfirmTitle: "Confirm Shortcut Action",
    ShortcutConfirmMessage: "Run action: [action name]?",
    ShortcutConfirmYes: "Confirm",
    ShortcutConfirmNo: "Cancel",
    ShortcutBusy: "Robot is busy. Shortcut execution is rejected.",
    ShortcutMacPermissionHint: "macOS Accessibility permission is required for global shortcuts.",
    ShortcutSidebarTitle: "Shortcut Actions",
    ParagraphAgentLicense: "License",
    LicenseStatusUnknown: "License status: loading",
    LicenseStatusUnlicensed: "Unlicensed (0/4)",
    LicenseStatusLicensedFmt: "Licensed ({count}/4)",
    BtnImportLicense: "Import License",
    LicenseNeedImport: "This agent is locked. Please import a license first.",
    LicenseImportTitle: "Import License",
    LicenseImportHint: "This AI agent is not licensed. Please import a .dat license file.",
    LicenseTargetFmt: "Target agent: {name}",
    LicenseTargetGeneral: "Target agent: general import",
    BtnLicenseImportCancel: "Cancel",
    BtnLicenseImportChoose: "Choose License File",
    LicenseImportNoFile: "Please choose a license file",
    LicenseImportSuccess: "License imported successfully",
    LicenseImportFailed: "License import failed",
    LicenseInvalidFormat: "License file format is invalid",
    LicenseInvalidSignature: "License signature verification failed",
    LicenseExpired: "License has expired",
    LicenseAgentMismatch: "License agent is not supported",
    LicenseRequired: "License required for this AI agent",
    LicenseRuntimeUnavailable: "License runtime is unavailable",
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
  },
  shortcut: {
    hant: "快捷鍵動作組",
    hans: "快捷键动作组",
    en: "Shortcut Actions"
  }
};
// ============================================

// 当前语言文本
const StateBLE = document.getElementById("StateBLE");
const MusicInput = document.getElementById("MusicInput");
const GamesTitle = document.getElementById("GamesTitle");
const ParagraphScan = document.getElementById("ParagraphScan");
const ParagraphRobotSlotCount = document.getElementById("ParagraphRobotSlotCount");
const RobotSlotCountInput = document.getElementById("RobotSlotCountInput");
const RobotSlotCountHint = document.getElementById("RobotSlotCountHint");
const BtnRobotSlotApply = document.getElementById("BtnRobotSlotApply");
const BtnRobotSlotAdd = document.getElementById("BtnRobotSlotAdd");
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
const MusicUploadProgress = document.getElementById("MusicUploadProgress");
const MusicUploadText = document.getElementById("MusicUploadText");
const MusicUploadBarFill = document.getElementById("MusicUploadBarFill");
const MusicUploadDetail = document.getElementById("MusicUploadDetail");

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
const PanelAbout = document.getElementById("PanelAbout");
const PanelAboutV2 = document.getElementById("PanelAboutV2");
const PanelAboutV2Sub = document.getElementById("PanelAboutV2Sub");
const PanelAboutV2Title = document.getElementById("PanelAboutV2Title");
const BtnAboutV2Back = document.getElementById("BtnAboutV2Back");
const AboutV2List = document.getElementById("AboutV2List");
const AboutV2ListEmpty = document.getElementById("AboutV2ListEmpty");
const AboutV2CardsConnected = document.getElementById("AboutV2CardsConnected");
const AboutV2CardsDisconnected = document.getElementById("AboutV2CardsDisconnected");
const AboutV2Disclosure = document.getElementById("AboutV2Disclosure");
const AboutV2Detail = document.getElementById("AboutV2Detail");
const AboutV2DetailTabs = document.getElementById("AboutV2DetailTabs");
const AboutV2DetailSlotLetter = document.getElementById("AboutV2DetailSlotLetter");
const AboutV2DetailDeviceName = document.getElementById("AboutV2DetailDeviceName");
const AboutV2DetailStatus = document.getElementById("AboutV2DetailStatus");
const AboutV2DetailBattery = document.getElementById("AboutV2DetailBattery");
const AboutV2DetailAddress = document.getElementById("AboutV2DetailAddress");
const AboutV2DetailFirmware = document.getElementById("AboutV2DetailFirmware");
const AboutV2DetailLink = document.getElementById("AboutV2DetailLink");
const AboutV2DetailAgent = document.getElementById("AboutV2DetailAgent");
const AboutV2DetailLicense = document.getElementById("AboutV2DetailLicense");
const AboutV2DetailAgentButtons = document.getElementById("AboutV2DetailAgentButtons");
const AboutV2DetailPreviewNotice = document.getElementById("AboutV2DetailPreviewNotice");
const AboutV2GlobalLicense = document.getElementById("AboutV2GlobalLicense");
const AboutV2LicenseSummary = document.getElementById("AboutV2LicenseSummary");
const AboutV2LicenseMeta = document.getElementById("AboutV2LicenseMeta");
const BtnAboutV2ImportLicense = document.getElementById("BtnAboutV2ImportLicense");

// Btn对象
const BtnPlay = document.getElementById("BtnPlay");
const BtnReset = document.getElementById("BtnReset");
const BtnClear = document.getElementById("BtnClear");
const BtnShortcutMapping = document.getElementById("BtnShortcutMapping");
const BtnReturn = document.getElementById("BtnReturn");
const BtnUndo = document.getElementById("BtnUndo");
const BtnMusic = document.getElementById("BtnMusic");
const BtnExport = document.getElementById("BtnExport");
const BtnImport = document.getElementById("BtnImport");
const ExportNameModal = document.getElementById("ExportNameModal");
const ExportNameMask = document.getElementById("ExportNameMask");
const ExportNameContent = document.getElementById("ExportNameContent");
const ExportNameTitle = document.getElementById("ExportNameTitle");
const ExportNameInput = document.getElementById("ExportNameInput");
const BtnExportNameCancel = document.getElementById("BtnExportNameCancel");
const BtnExportNameConfirm = document.getElementById("BtnExportNameConfirm");
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
const BtnAbout = document.getElementById("BtnAbout");
const BtnCloudUpdatePanel = document.getElementById("BtnCloudUpdatePanel");
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
const BtnAiCantonese = document.getElementById("BtnAiCantonese");
const BtnAiReadingCantonese = document.getElementById("BtnAiReadingCantonese");
const BtnAiReadingEnglish = document.getElementById("BtnAiReadingEnglish");
const BtnAiReadingMandarin = document.getElementById("BtnAiReadingMandarin");
const AiAgentButtons = document.getElementById("AiAgentButtons");
const ParagraphAgentLicense = document.getElementById("ParagraphAgentLicense");
const AgentLicenseStatus = document.getElementById("AgentLicenseStatus");
const BtnImportLicense = document.getElementById("BtnImportLicense");
const LicenseFileInput = document.getElementById("LicenseFileInput");
const LicenseImportModal = document.getElementById("LicenseImportModal");
const LicenseImportMask = document.getElementById("LicenseImportMask");
const LicenseImportTitle = document.getElementById("LicenseImportTitle");
const LicenseImportHint = document.getElementById("LicenseImportHint");
const LicenseImportTargetAgent = document.getElementById("LicenseImportTargetAgent");
const BtnLicenseImportCancel = document.getElementById("BtnLicenseImportCancel");
const BtnLicenseImportChoose = document.getElementById("BtnLicenseImportChoose");
const BtnActionGroupPanel = document.getElementById("BtnActionGroupPanel");
const ActionGroupModal = document.getElementById("ActionGroupModal");
const ActionGroupMask = document.getElementById("ActionGroupMask");
const ActionGroupTitle = document.getElementById("ActionGroupTitle");
const ActionGroupBody = document.getElementById("ActionGroupBody");
const BtnActionGroupClose = document.getElementById("BtnActionGroupClose");
const BtnActionGroupConfirm = document.getElementById("BtnActionGroupConfirm");
const ActionGroupNameLabel = document.getElementById("ActionGroupNameLabel");
const ActionGroupNameInput = document.getElementById("ActionGroupNameInput");
const ActionGroupUserListTitle = document.getElementById("ActionGroupUserListTitle");
const ActionGroupUserList = document.getElementById("ActionGroupUserList");
const ActionServoLeftShoulder = document.getElementById("ActionServoLeftShoulder");
const ActionServoLeftArm = document.getElementById("ActionServoLeftArm");
const ActionServoLeftHand = document.getElementById("ActionServoLeftHand");
const ActionServoRightShoulder = document.getElementById("ActionServoRightShoulder");
const ActionServoRightArm = document.getElementById("ActionServoRightArm");
const ActionServoRightHand = document.getElementById("ActionServoRightHand");
const ActionServoLeftShoulderValue = document.getElementById("ActionServoLeftShoulderValue");
const ActionServoLeftArmValue = document.getElementById("ActionServoLeftArmValue");
const ActionServoLeftHandValue = document.getElementById("ActionServoLeftHandValue");
const ActionServoRightShoulderValue = document.getElementById("ActionServoRightShoulderValue");
const ActionServoRightArmValue = document.getElementById("ActionServoRightArmValue");
const ActionServoRightHandValue = document.getElementById("ActionServoRightHandValue");
const ShortcutActionModal = document.getElementById("ShortcutActionModal");
const ShortcutActionMask = document.getElementById("ShortcutActionMask");
const ShortcutActionContent = document.getElementById("ShortcutActionContent");
const ShortcutActionTitle = document.getElementById("ShortcutActionTitle");
const BtnShortcutActionClose = document.getElementById("BtnShortcutActionClose");
const BtnShortcutCaptureKey = document.getElementById("BtnShortcutCaptureKey");
const ShortcutActionCaptureLabel = document.getElementById("ShortcutActionCaptureLabel");
const ShortcutActionCaptureDisplay = document.getElementById("ShortcutActionCaptureDisplay");
const ShortcutActionNameLabel = document.getElementById("ShortcutActionNameLabel");
const ShortcutActionNameInput = document.getElementById("ShortcutActionNameInput");
const ShortcutActionSummaryTitle = document.getElementById("ShortcutActionSummaryTitle");
const ShortcutActionSummaryList = document.getElementById("ShortcutActionSummaryList");
const BtnShortcutActionConfirm = document.getElementById("BtnShortcutActionConfirm");
const ShortcutActionSavedTitle = document.getElementById("ShortcutActionSavedTitle");
const ShortcutActionSavedList = document.getElementById("ShortcutActionSavedList");
const ShortcutConfirmModal = document.getElementById("ShortcutConfirmModal");
const ShortcutConfirmMask = document.getElementById("ShortcutConfirmMask");
const ShortcutConfirmTitle = document.getElementById("ShortcutConfirmTitle");
const ShortcutConfirmMessage = document.getElementById("ShortcutConfirmMessage");
const BtnShortcutConfirmYes = document.getElementById("BtnShortcutConfirmYes");
const BtnShortcutConfirmNo = document.getElementById("BtnShortcutConfirmNo");
const ShortcutSidebarModal = document.getElementById("ShortcutSidebarModal");
const ShortcutSidebarMask = document.getElementById("ShortcutSidebarMask");
const ShortcutSidebarTitle = document.getElementById("ShortcutSidebarTitle");
const BtnShortcutSidebarClose = document.getElementById("BtnShortcutSidebarClose");
const ShortcutSidebarList = document.getElementById("ShortcutSidebarList");
const ACTION_GROUP_SERVO_BINDINGS = [
  {
    key: "left_shoulder",
    inputEl: ActionServoLeftShoulder,
    valueEl: ActionServoLeftShoulderValue,
  },
  { key: "left_arm", inputEl: ActionServoLeftArm, valueEl: ActionServoLeftArmValue },
  {
    key: "left_hand",
    inputEl: ActionServoLeftHand,
    valueEl: ActionServoLeftHandValue,
  },
  {
    key: "right_shoulder",
    inputEl: ActionServoRightShoulder,
    valueEl: ActionServoRightShoulderValue,
  },
  { key: "right_arm", inputEl: ActionServoRightArm, valueEl: ActionServoRightArmValue },
  {
    key: "right_hand",
    inputEl: ActionServoRightHand,
    valueEl: ActionServoRightHandValue,
  },
];

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

// OTA related
const CloudUpdateModal = document.getElementById("CloudUpdateModal");
const BtnCloudUpdateClose = document.getElementById("BtnCloudUpdateClose");
const BtnStartCloudUpdate = document.getElementById("BtnStartCloudUpdate");
const BtnLocalUpdate = document.getElementById("BtnLocalUpdate");
const LocalUpdateInput = document.getElementById("LocalUpdateInput");
const OtaSlotSelectorLabel = document.getElementById("OtaSlotSelectorLabel");
const OtaSlotSelect = document.getElementById("OtaSlotSelect");
const OtaSlotSelectorHint = document.getElementById("OtaSlotSelectorHint");
const UpdateSelectionMode = document.getElementById("UpdateSelectionMode");
const UpdateProgressMode = document.getElementById("UpdateProgressMode");
const OtaProgressOverlay = document.getElementById("OtaProgressOverlay");
const OtaProgressTitle = document.getElementById("OtaProgressTitle");
const OtaProgressText = document.getElementById("OtaProgressText");
const OtaProgressBarFill = document.getElementById("OtaProgressBarFill");
const OtaProgressPercent = document.getElementById("OtaProgressPercent");
const BtnOtaDone = document.getElementById("BtnOtaDone");
const CloudUpdateStatus = document.getElementById("CloudUpdateStatus");
const CloudUpdateSpinner = document.getElementById("CloudUpdateSpinner");
let selectedOtaSlot = "A";

// Select对象
const ThemeList = document.getElementById("ThemeList");
const DeviceList = document.getElementById("DeviceList");
const LanguageList = document.getElementById("LanguageList");
const CodePanelList = document.getElementById("CodePanelList");
const MusicPanelList = document.getElementById("MusicPanelList");
const GamesPanelList = document.getElementById("GamesPanelList");

// 显示对象
const CodeText = document.getElementById("CodeText");
const AboutFirmwareVersion = document.getElementById("AboutFirmwareVersion");
const AboutAiAgentStatus = document.getElementById("AboutAiAgentStatus");
const aiAgentIdLabelMap = new Map();
// Blockly 可能在 inject 时拉取 robotId 下拉；先占位，连接面板初始化后会覆盖
if (typeof window !== "undefined") {
  window.__magosRobotBlockOptions = [["请先连接设备", "__none__"]];
}
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
        targetConnectDevice = null;
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

// ============ Multi-Robot Slot UI ============
(function initRobotSlotUI() {
  const container = document.getElementById("RobotSlotsContainer");
  if (!container) return;

  const statusLabels = {
    connect: { hant: "未連接", hans: "未连接", en: "Disconnected" },
    connecting: { hant: "連接中", hans: "连接中", en: "Connecting" },
    connected: { hant: "已連接", hans: "已连接", en: "Connected" },
    disconnecting: { hant: "斷開中", hans: "断开中", en: "Disconnecting" },
    error: { hant: "錯誤", hans: "错误", en: "Error" },
  };
  const btnConnectLabels = { hant: "連接", hans: "连接", en: "Connect" };
  const btnDisconnectLabels = { hant: "斷開", hans: "断开", en: "Disconnect" };
  const placeholderLabels = { hant: "選擇設備", hans: "选择设备", en: "Select Device" };
  const parallelOverviewTitleEl = document.getElementById("ParallelOverviewTitle");
  const parallelOverviewSummaryEl = document.getElementById("ParallelOverviewSummary");
  const parallelOverviewWrapEl = document.getElementById("ParallelOverview");
  const parallelHubCoreTextEl = document.getElementById("ParallelHubCoreText");
  const parallelHubSpokesEl = document.getElementById("ParallelHubSpokes");

  function getLang() {
    return currentLanguage || "hant";
  }

  function refreshWorkspaceRobotIdFields() {
    if (typeof ws === "undefined" || !ws || typeof ws.getAllBlocks !== "function") return;
    try {
      ws.getAllBlocks(false).forEach((block) => {
        if (!BLOCK_TYPES_WITH_ROBOT_ID.has(block.type)) return;
        const field = block.getField("robotId");
        if (!field || typeof field.getOptions !== "function") return;
        const opts = field.getOptions(false);
        const values = new Set(opts.map((o) => o[1]));
        const cur = block.getFieldValue("robotId");
        if (!values.has(cur) && opts.length > 0) {
          block.setFieldValue(opts[0][1], "robotId");
        }
        if (typeof field.markDirty === "function") field.markDirty();
      });
    } catch (e) {
      console.warn("refreshWorkspaceRobotIdFields", e);
    }
  }

  function getParallelRobotSlotIds() {
    return activeRobotSlotIds
      .map((id) => String(id || "").trim().toUpperCase())
      .filter((id) => id.length === 1 && id >= "A" && id <= "F");
  }

  function syncParallelBlocksBySlotCount() {
    if (typeof ws === "undefined" || !ws || typeof ws.getAllBlocks !== "function")
      return;
    const slotIds = getParallelRobotSlotIds();
    const targetCount = Math.max(1, slotIds.length);
    try {
      ws.getAllBlocks(false).forEach((block) => {
        if (block.type !== "parallel_wait_all") return;
        if (typeof block.syncBranchCount_ === "function") {
          block.syncBranchCount_(targetCount);
        }
      });
    } catch (e) {
      console.warn("syncParallelBlocksBySlotCount", e);
    }
  }

  function syncBlocklyRobotDropdownSource() {
    const langPack = language[currentLanguage] || language.hant;
    const fallbackLabel = langPack.BlocklyRobotConnectFirst || "请先连接设备";
    const discLabel = langPack.BlocklyRobotSlotDisconnected || "未连接";
    const options = [];
    activeRobotSlotIds.forEach((id) => {
      const s = robotSlots.get(id);
      if (s && s.status === "connected") {
        const name = s.connectedDevice || id;
        options.push([`${id} · ${name}`, id]);
      } else {
        options.push([`${id} · ${discLabel}`, id]);
      }
    });
    window.__magosRobotBlockOptions =
      options.length > 0 ? options : [[fallbackLabel, "__none__"]];
    window.__magosParallelRobotSlotIds = getParallelRobotSlotIds();
    refreshWorkspaceRobotIdFields();
    syncParallelBlocksBySlotCount();
  }

  window.syncBlocklyRobotDropdownSource = syncBlocklyRobotDropdownSource;
  window.syncParallelBlocksBySlotCount = syncParallelBlocksBySlotCount;

  function getConnectedSlotIds() {
    return activeRobotSlotIds.filter((id) => {
      const s = robotSlots.get(id);
      return !!s && s.status === "connected";
    });
  }

  function renderParallelHubSpokes(slotIds) {
    if (!parallelHubSpokesEl) return;
    parallelHubSpokesEl.innerHTML = "";
    if (!Array.isArray(slotIds) || slotIds.length <= 0) return;
    const count = slotIds.length;
    const radius = count <= 2 ? 48 : 54;
    slotIds.forEach((slotId, idx) => {
      const angleDeg = -90 + (360 / count) * idx;
      const spoke = document.createElement("div");
      spoke.className = "parallel-hub-spoke";
      spoke.style.setProperty("--angle", `${angleDeg}deg`);
      spoke.style.setProperty("--radius", `${radius}px`);
      const node = document.createElement("div");
      node.className = "parallel-hub-spoke-node";
      node.textContent = slotId;
      spoke.appendChild(node);
      parallelHubSpokesEl.appendChild(spoke);
    });
  }

  function updateParallelOverview() {
    if (!parallelOverviewSummaryEl || !parallelOverviewTitleEl || !parallelOverviewWrapEl)
      return;
    const langPack = language[currentLanguage] || language.hant;
    parallelOverviewTitleEl.textContent = langPack.ParallelHubTitle || "並行調度中心";
    if (parallelHubCoreTextEl) {
      parallelHubCoreTextEl.textContent = langPack.ParallelHubCoreLabel || "調度";
    }

    const connectedSlotIds = getConnectedSlotIds();
    const connectedCount = connectedSlotIds.length;
    const slotText = connectedSlotIds.join(" · ");
    const hasError = activeRobotSlotIds.some((id) => {
      const s = robotSlots.get(id);
      return !!s && s.status === "error";
    });

    if (connectedCount <= 0) {
      parallelOverviewSummaryEl.textContent =
        langPack.ParallelHubNoDevice || "暫無已連接設備";
      parallelOverviewWrapEl.dataset.state = "idle";
    } else if (currentRobotStatus === STATUS_RUNNING || isParallelExecutionActive) {
      const fmt = langPack.ParallelHubRunningFmt || "中心並行下發中：{slots}";
      parallelOverviewSummaryEl.textContent = fmt.replace("{slots}", slotText);
      parallelOverviewWrapEl.dataset.state = "running";
    } else if (hasError) {
      const fmt = langPack.ParallelHubErrorFmt || "部分分支異常：{slots}";
      parallelOverviewSummaryEl.textContent = fmt.replace("{slots}", slotText || "-");
      parallelOverviewWrapEl.dataset.state = "error";
    } else if (currentRobotStatus === STATUS_PAUSED) {
      const fmt = langPack.ParallelHubPausedFmt || "並行已暫停：{slots}";
      parallelOverviewSummaryEl.textContent = fmt.replace("{slots}", slotText);
      parallelOverviewWrapEl.dataset.state = "paused";
    } else {
      const fmt = langPack.ParallelHubReadyFmt || "中心待命，已連接 {count} 台：{slots}";
      parallelOverviewSummaryEl.textContent = fmt
        .replace("{count}", String(connectedCount))
        .replace("{slots}", slotText);
      parallelOverviewWrapEl.dataset.state = "ready";
    }
    renderParallelHubSpokes(connectedSlotIds);
  }

  window._setParallelExecutionVisual = function setParallelExecutionVisual(active) {
    isParallelExecutionActive = !!active;
    activeRobotSlotIds.forEach((id) => {
      if (typeof window._updateSlotUI === "function") window._updateSlotUI(id);
    });
    updateParallelOverview();
  };

  function expandActiveRobotSlotsForImportedWorkspace(workspace) {
    if (!workspace || typeof workspace.getAllBlocks !== "function") return;
    let maxIdx = activeRobotSlotIds.length - 1;
    workspace.getAllBlocks(false).forEach((block) => {
      if (!BLOCK_TYPES_WITH_ROBOT_ID.has(block.type)) return;
      const v = String(block.getFieldValue("robotId") || "")
        .trim()
        .toUpperCase();
      if (!v || v === "__NONE__") return;
      if (v.length === 1 && v >= "A" && v <= "F") {
        const idx = v.charCodeAt(0) - 65;
        if (idx >= 0 && idx < ROBOT_SLOT_MAX && idx > maxIdx) maxIdx = idx;
      }
    });
    const targetCount = Math.min(
      ROBOT_SLOT_MAX,
      Math.max(activeRobotSlotIds.length, maxIdx + 1)
    );
    while (activeRobotSlotIds.length < targetCount) {
      const next = String.fromCharCode(65 + activeRobotSlotIds.length);
      activeRobotSlotIds.push(next);
      ensureRobotSlotState(next);
    }
    saveActiveRobotSlotIds();
  }

  window.expandActiveRobotSlotsForImportedWorkspace =
    expandActiveRobotSlotsForImportedWorkspace;

  function syncRobotSlotCountInput() {
    if (RobotSlotCountInput) {
      RobotSlotCountInput.value = String(activeRobotSlotIds.length);
    }
    if (RobotSlotCountHint) {
      const langPack = language[currentLanguage] || language.hant;
      const fmt = langPack.RobotSlotCountHintFmt || "{cur}/6";
      RobotSlotCountHint.textContent = fmt.replace(
        "{cur}",
        String(activeRobotSlotIds.length)
      );
    }
  }

  function applyRobotSlotCountFromInput() {
    const raw = RobotSlotCountInput ? Number(RobotSlotCountInput.value) : NaN;
    let n = Number.isFinite(raw) ? Math.floor(raw) : activeRobotSlotIds.length;
    n = Math.max(1, Math.min(ROBOT_SLOT_MAX, n));
    const langPack = language[currentLanguage] || language.hant;
    if (n < activeRobotSlotIds.length) {
      const toRemove = activeRobotSlotIds.slice(n);
      for (const id of toRemove) {
        const s = robotSlots.get(id);
        if (s && s.status === "connected") {
          alert(langPack.RobotSlotReduceBlocked || "");
          return;
        }
      }
      toRemove.forEach((id) => robotSlots.delete(id));
      activeRobotSlotIds = activeRobotSlotIds.slice(0, n);
    } else if (n > activeRobotSlotIds.length) {
      while (
        activeRobotSlotIds.length < n &&
        activeRobotSlotIds.length < ROBOT_SLOT_MAX
      ) {
        const nextLetter = String.fromCharCode(65 + activeRobotSlotIds.length);
        activeRobotSlotIds.push(nextLetter);
        ensureRobotSlotState(nextLetter);
      }
    }
    saveActiveRobotSlotIds();
    rebuildRobotSlotUI();
    if (magosMusicSelectedSlot && !activeRobotSlotIds.includes(magosMusicSelectedSlot)) {
      const fallback = activeRobotSlotIds[0] || "A";
      setMagosMusicSelectedSlot(fallback, { reason: "force" });
    } else if (typeof renderMusicSlotTabs === "function") {
      renderMusicSlotTabs();
    }
  }

  function addRobotSlotOne() {
    const langPack = language[currentLanguage] || language.hant;
    if (activeRobotSlotIds.length >= ROBOT_SLOT_MAX) {
      alert(langPack.RobotSlotMaxReached || "");
      return;
    }
    const nextLetter = String.fromCharCode(65 + activeRobotSlotIds.length);
    activeRobotSlotIds.push(nextLetter);
    ensureRobotSlotState(nextLetter);
    saveActiveRobotSlotIds();
    rebuildRobotSlotUI();
    if (typeof renderMusicSlotTabs === "function") {
      renderMusicSlotTabs();
    }
  }

  function rebuildRobotSlotUI() {
    container.innerHTML = "";
    activeRobotSlotIds.forEach((slotId) => {
      ensureRobotSlotState(slotId);
      const slotData = robotSlots.get(slotId);
      const slot = document.createElement("div");
      slot.className = "robot-slot";
      slot.dataset.slot = slotId;
      slot.dataset.status = slotData ? slotData.status : "connect";

      slot.innerHTML = `
      <div class="robot-slot-header">
        <span class="robot-slot-label">🤖 ${slotId}</span>
        <span class="robot-slot-device-name"></span>
        <div class="robot-slot-status">
          <div class="robot-slot-status-icon"></div>
          <span class="robot-slot-status-text">${statusLabels.connect[getLang()]}</span>
        </div>
        <span class="robot-slot-battery"></span>
      </div>
      <div class="robot-slot-controls">
        <select class="robot-slot-device-select">
          <option value="" disabled selected>${placeholderLabels[getLang()]}</option>
        </select>
        <button type="button" class="robot-slot-btn-connect">${btnConnectLabels[getLang()]}</button>
        <button type="button" class="robot-slot-btn-disconnect" style="display:none;">${btnDisconnectLabels[getLang()]}</button>
      </div>
    `;
      container.appendChild(slot);

      const selectEl = slot.querySelector(".robot-slot-device-select");
      const btnConn = slot.querySelector(".robot-slot-btn-connect");
      const btnDisc = slot.querySelector(".robot-slot-btn-disconnect");

      btnConn.addEventListener("click", () => slotConnect(slotId));
      btnDisc.addEventListener("click", () => slotDisconnect(slotId));
      selectEl.addEventListener("change", () => {
        const val = selectEl.value;
        const data = robotSlots.get(slotId);
        if (!val || val === "__connected__") {
          data.targetDevice = null;
          return;
        }
        const device = bleDiscoveredDeviceMap.get(val);
        data.targetDevice = device
          ? {
              address: device.address || "",
              name: device.name || "",
              display_name: device.display_name || "",
            }
          : { address: val, name: val, display_name: val };
      });
    });

    if (typeof window._updateAllSlotDeviceLists === "function") {
      window._updateAllSlotDeviceLists();
    }
    activeRobotSlotIds.forEach((id) => window._updateSlotUI(id));
    syncBlocklyRobotDropdownSource();
    syncRobotSlotCountInput();
  }

  window._onRobotSlotLanguageChanged = function () {
    const langPack = language[currentLanguage] || language.hant;
    if (ParagraphRobotSlotCount) {
      ParagraphRobotSlotCount.textContent =
        langPack.ParagraphRobotSlotCount || "";
    }
    if (BtnRobotSlotApply) {
      BtnRobotSlotApply.textContent = langPack.BtnRobotSlotApply || "";
    }
    if (BtnRobotSlotAdd) {
      BtnRobotSlotAdd.textContent = langPack.BtnRobotSlotAdd || "";
    }
    syncRobotSlotCountInput();
    if (typeof window._updateAllSlotDeviceLists === "function") {
      window._updateAllSlotDeviceLists();
    }
    activeRobotSlotIds.forEach((id) => window._updateSlotUI(id));
    syncBlocklyRobotDropdownSource();
    updateParallelOverview();
  };

  if (BtnRobotSlotApply) {
    BtnRobotSlotApply.addEventListener("click", applyRobotSlotCountFromInput);
  }
  if (BtnRobotSlotAdd) {
    BtnRobotSlotAdd.addEventListener("click", addRobotSlotOne);
  }

  window._updateAllSlotDeviceLists = function updateAllSlotDeviceLists() {
    container.querySelectorAll(".robot-slot").forEach((slotEl) => {
      const slotId = slotEl.dataset.slot;
      const slotData = robotSlots.get(slotId);
      if (!slotData) return;
      const selectEl = slotEl.querySelector(".robot-slot-device-select");
      const prevVal = selectEl.value;
      selectEl.innerHTML = "";
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.disabled = true;
      placeholder.selected = true;
      placeholder.textContent = placeholderLabels[getLang()];
      selectEl.appendChild(placeholder);

      bleDiscoveredDeviceMap.forEach((device, key) => {
        const opt = document.createElement("option");
        opt.value = key;
        opt.textContent = device.display_name || device.name || key;
        selectEl.appendChild(opt);
      });

      if (slotData.status === "connected" && slotData.connectedDevice) {
        const connOpt = document.createElement("option");
        connOpt.value = "__connected__";
        connOpt.textContent = slotData.connectedDevice;
        connOpt.selected = true;
        selectEl.appendChild(connOpt);
      } else if (prevVal) {
        selectEl.value = prevVal;
        if (selectEl.selectedIndex < 0) selectEl.selectedIndex = 0;
      }
    });
  };

  window._updateSlotUI = function updateSlotUI(slotId) {
    const slotData = robotSlots.get(slotId);
    if (!slotData) return;
    const slotEl = container.querySelector(`.robot-slot[data-slot="${slotId}"]`);
    if (!slotEl) return;

    slotEl.dataset.status = slotData.status;
    slotEl.classList.toggle(
      "is-parallel-running",
      isParallelExecutionActive && slotData.status === "connected"
    );
    const statusText = slotEl.querySelector(".robot-slot-status-text");
    const deviceNameEl = slotEl.querySelector(".robot-slot-device-name");
    const btnConn = slotEl.querySelector(".robot-slot-btn-connect");
    const btnDisc = slotEl.querySelector(".robot-slot-btn-disconnect");

    const labels = statusLabels[slotData.status] || statusLabels.connect;
    statusText.textContent = labels[getLang()] || labels.en;

    const batteryEl = slotEl.querySelector(".robot-slot-battery");

    if (slotData.status === "connected") {
      deviceNameEl.textContent = slotData.connectedDevice || "";
      btnConn.style.display = "none";
      btnDisc.style.display = "";
      if (batteryEl) {
        const bat = slotData.battery;
        if (bat !== null && bat !== undefined) {
          batteryEl.textContent = `🔋 ${bat}%`;
          batteryEl.classList.toggle("is-low", bat <= BATTERY_LOW_THRESHOLD);
          batteryEl.style.display = "";
        } else {
          batteryEl.textContent = "";
          batteryEl.style.display = "none";
        }
      }
    } else {
      deviceNameEl.textContent = "";
      btnConn.style.display = "";
      btnDisc.style.display = "none";
      if (batteryEl) {
        batteryEl.textContent = "";
        batteryEl.style.display = "none";
        batteryEl.classList.remove("is-low");
      }
    }

    btnConn.textContent = btnConnectLabels[getLang()];
    btnDisc.textContent = btnDisconnectLabels[getLang()];
    updateParallelOverview();
    if (typeof renderMusicSlotTabs === "function") {
      try { renderMusicSlotTabs(); } catch (_err) { /* noop */ }
    }
  };

  function slotConnect(slotId) {
    const slotData = robotSlots.get(slotId);
    if (!slotData) return;
    if (!slotData.targetDevice || (!slotData.targetDevice.address && !slotData.targetDevice.name)) {
      alert("请选择想要连接的设备");
      return;
    }
    slotData.status = "connecting";
    window._updateSlotUI(slotId);

    fetch("/BLE_Connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        address: slotData.targetDevice.address || "",
        name: slotData.targetDevice.name || "",
        slot: slotId,
      }),
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          const reason = payload && typeof payload === "object"
            ? payload.error || payload.message || "" : "";
          throw new Error(reason || "BLE_Connect");
        }
        return payload;
      })
      .then((data) => {
        const isConnected =
          (Array.isArray(data) && data[0] === "True") ||
          (data && typeof data === "object" && (data.connected === true || data.status === "success"));
        if (isConnected) {
          slotData.status = "connected";
          slotData.connectedDevice = slotData.targetDevice.display_name || slotData.targetDevice.name || "Device";
          slotData.targetDevice = null;
          ConnectedDevice = slotData.connectedDevice;
          updateBLEState("connected");
          handleBleConnectionTransition(true);
        } else {
          slotData.status = "error";
        }
        window._updateSlotUI(slotId);
        window._updateAllSlotDeviceLists();
        syncBlocklyRobotDropdownSource();
      })
      .catch((error) => {
        slotData.status = "error";
        window._updateSlotUI(slotId);
        syncBlocklyRobotDropdownSource();
        if (error && error.message) alert(error.message);
      });
  }

  function slotDisconnect(slotId) {
    const slotData = robotSlots.get(slotId);
    if (!slotData || slotData.status !== "connected") return;
    slotData.status = "disconnecting";
    window._updateSlotUI(slotId);

    fetch(`/BLE_Disconnect?slot=${encodeURIComponent(slotId)}`, {
      method: "GET",
    })
      .then((response) => response.text())
      .then((data) => {
        if (data && (data === "True" || data.includes("True"))) {
          slotData.status = "connect";
          slotData.connectedDevice = "";
          const anyConnected = [...robotSlots.values()].some(s => s.status === "connected");
          if (!anyConnected) {
            ConnectedDevice = "";
            updateBLEState("connect");
            handleBleConnectionTransition(false);
          }
        } else {
          slotData.status = "error";
        }
        window._updateSlotUI(slotId);
        window._updateAllSlotDeviceLists();
        syncBlocklyRobotDropdownSource();
      })
      .catch(() => {
        slotData.status = "error";
        window._updateSlotUI(slotId);
        syncBlocklyRobotDropdownSource();
      });
  }

  window._rebuildRobotSlotUI = rebuildRobotSlotUI;

  rebuildRobotSlotUI();
  window._onRobotSlotLanguageChanged();
  updateParallelOverview();
})();
// ============ End Multi-Robot Slot UI ============

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
  if (
    t === "快捷鍵動作組" ||
    t === "快捷键动作组" ||
    t === "shortcutactions" ||
    t === "shortcutaction" ||
    t === "shortcuts"
  )
    return "shortcut";

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
  isParallelExecutionActive = status === STATUS_RUNNING;
  if (typeof window._setParallelExecutionVisual === "function") {
    window._setParallelExecutionVisual(isParallelExecutionActive);
  }
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

function getShortcutLang() {
  return language[currentLanguage] || language.en;
}

function normalizeShortcutPrimaryKey(keyText) {
  const raw = String(keyText || "").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  if (
    lower === "control" ||
    lower === "ctrl" ||
    lower === "shift" ||
    lower === "alt" ||
    lower === "meta" ||
    lower === "cmd" ||
    lower === "command" ||
    lower === "win" ||
    lower === "windows"
  ) {
    return "";
  }
  if (lower === "escape" || lower === "esc") return "esc";
  if (lower === "enter" || lower === "return") return "enter";
  if (lower === " " || lower === "spacebar" || lower === "space") return "space";
  if (lower === "tab") return "tab";
  if (lower === "backspace") return "backspace";
  if (lower === "delete" || lower === "del") return "delete";
  if (lower === "insert") return "insert";
  if (lower === "home") return "home";
  if (lower === "end") return "end";
  if (lower === "pageup") return "pageup";
  if (lower === "pagedown") return "pagedown";
  if (lower === "arrowup" || lower === "up") return "up";
  if (lower === "arrowdown" || lower === "down") return "down";
  if (lower === "arrowleft" || lower === "left") return "left";
  if (lower === "arrowright" || lower === "right") return "right";
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(raw)) return raw.toLowerCase();
  if (raw.length === 1) return raw.toLowerCase();
  return lower;
}

function shortcutDisplayToken(token) {
  if (token.length === 1 && /[a-z]/i.test(token)) return token.toUpperCase();
  const map = {
    esc: "Esc",
    enter: "Enter",
    space: "Space",
    tab: "Tab",
    backspace: "Backspace",
    delete: "Delete",
    insert: "Insert",
    home: "Home",
    end: "End",
    pageup: "PageUp",
    pagedown: "PageDown",
    up: "Up",
    down: "Down",
    left: "Left",
    right: "Right",
  };
  if (map[token]) return map[token];
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(token)) return token.toUpperCase();
  return token;
}

function buildShortcutBindingFromKeyboardEvent(event) {
  const modifiers = [];
  if (event.ctrlKey) modifiers.push("ctrl");
  if (event.shiftKey) modifiers.push("shift");
  if (event.altKey) modifiers.push("alt");
  if (event.metaKey) modifiers.push("cmd");
  const orderedMods = ["ctrl", "shift", "alt", "cmd"].filter((mod) =>
    modifiers.includes(mod)
  );

  const primaryKey = normalizeShortcutPrimaryKey(event.key);
  if (!primaryKey) return null;

  const normalized = [...orderedMods, primaryKey].join("+");
  const displayMods = orderedMods.map((mod) => {
    if (mod === "ctrl") return "Ctrl";
    if (mod === "shift") return "Shift";
    if (mod === "alt") return "Alt";
    return "Cmd";
  });
  const display = [...displayMods, shortcutDisplayToken(primaryKey)].join("+");
  return {
    normalized,
    display,
    modifiers: orderedMods,
    key: primaryKey,
  };
}

function setShortcutCaptureDisplayText(text) {
  if (!ShortcutActionCaptureDisplay) return;
  ShortcutActionCaptureDisplay.textContent = text || "";
}

function updateShortcutCaptureUI() {
  if (!BtnShortcutCaptureKey) return;
  const langData = getShortcutLang();
  BtnShortcutCaptureKey.classList.toggle("is-capturing", shortcutIsCapturing);
  setInnerTextIf(BtnShortcutCaptureKey, langData.BtnShortcutCaptureKey);
  if (shortcutIsCapturing) {
    setShortcutCaptureDisplayText(langData.ShortcutActionCaptureListening);
    return;
  }
  if (shortcutCapturedBinding && shortcutCapturedBinding.display) {
    setShortcutCaptureDisplayText(shortcutCapturedBinding.display);
  } else {
    setShortcutCaptureDisplayText(langData.ShortcutActionCaptureIdle);
  }
}

function startShortcutCapture() {
  shortcutIsCapturing = true;
  shortcutCapturedBinding = null;
  updateShortcutCaptureUI();
}

function stopShortcutCapture() {
  shortcutIsCapturing = false;
  updateShortcutCaptureUI();
}

function handleShortcutCaptureKeydown(event) {
  if (!shortcutIsCapturing) return;
  event.preventDefault();
  event.stopPropagation();
  const binding = buildShortcutBindingFromKeyboardEvent(event);
  if (!binding) return;
  shortcutCapturedBinding = binding;
  stopShortcutCapture();
}

function parseShortcutActionsFromCode(executionCode) {
  const code = String(executionCode || "");
  const lines = code.split(/\r?\n/);
  const actions = [];
  for (const rawLine of lines) {
    const line = String(rawLine || "").trim();
    if (!line || line.startsWith("#")) continue;
    let type = "python";
    let label = line;

    let m = line.match(/magos\.animations_start\(["'](.+?)["']\)/);
    if (m) {
      type = "motion";
      label = `动作组: ${m[1]}`;
    } else {
      m = line.match(/magos\.play_audio\(["'](.+?)["']\)/);
      if (m) {
        type = "audio";
        label = `语音: ${m[1]}`;
      } else {
        m = line.match(/magos\.play_background_audio\(["'](.+?)["']\)/);
        if (m) {
          type = "music";
          label = `背景音乐: ${m[1]}`;
        } else if (line.includes("magos.stop_background_audio(")) {
          type = "music";
          label = "停止背景音乐";
        } else {
          m = line.match(/magos\.change_emoji\((.+?)\)/);
          if (m) {
            type = "emoji";
            label = `表情: ${m[1]}`;
          } else {
            m = line.match(/magos\.magos_time\((.+?)\)/);
            if (m) {
              type = "wait";
              label = `暂停: ${m[1]}s`;
            } else {
              m = line.match(/shortcut_action_start\(["'](.+?)["']\)/);
              if (m) {
                type = "shortcut_ref";
                label = `快捷键动作: ${m[1]}`;
              }
            }
          }
        }
      }
    }
    actions.push({ type, label, raw: line });
    if (actions.length >= 200) break;
  }
  return actions;
}

function buildShortcutActionItem(item, options = {}) {
  const langData = getShortcutLang();
  const allowDelete = !!options.allowDelete;
  const onDelete = typeof options.onDelete === "function" ? options.onDelete : null;
  const detailsByDefault = !!options.detailsByDefault;
  const wrapper = document.createElement("div");
  wrapper.className = "shortcut-action-item";

  const topLine = document.createElement("div");
  topLine.className = "shortcut-action-topline";
  topLine.style.cursor = "pointer";

  const title = document.createElement("div");
  title.textContent = String(item?.name || "");
  title.style.fontWeight = "800";

  const right = document.createElement("div");
  right.style.display = "flex";
  right.style.alignItems = "center";
  right.style.gap = "8px";

  const toggle = document.createElement("span");
  toggle.textContent = detailsByDefault ? "▾" : "▸";
  toggle.style.color = "#5c6bc0";
  toggle.style.fontWeight = "900";

  right.appendChild(toggle);

  if (allowDelete) {
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "shortcut-action-delete";
    delBtn.textContent = langData.ShortcutActionDelete;
    delBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      if (onDelete) onDelete(item);
    });
    right.appendChild(delBtn);
  }

  topLine.appendChild(title);
  topLine.appendChild(right);

  const meta = document.createElement("div");
  meta.className = "shortcut-action-meta";
  const keyDisplay = String(item?.key_binding?.display || "");
  const actionCount = Array.isArray(item?.actions) ? item.actions.length : 0;
  meta.textContent = `${keyDisplay}${keyDisplay ? " | " : ""}${actionCount} actions`;

  const details = document.createElement("div");
  details.className = "shortcut-action-details";
  details.style.display = detailsByDefault ? "block" : "none";
  const detailActions = Array.isArray(item?.actions) ? item.actions : [];
  if (detailActions.length === 0) {
    const emptyLine = document.createElement("div");
    emptyLine.textContent = langData.ShortcutActionNoData;
    details.appendChild(emptyLine);
  } else {
    detailActions.forEach((action, index) => {
      const row = document.createElement("div");
      row.textContent = `${index + 1}. ${String(action?.label || action?.raw || "")}`;
      details.appendChild(row);
    });
  }

  topLine.addEventListener("click", () => {
    const open = details.style.display !== "none";
    details.style.display = open ? "none" : "block";
    toggle.textContent = open ? "▸" : "▾";
  });

  wrapper.appendChild(topLine);
  wrapper.appendChild(meta);
  wrapper.appendChild(details);
  return wrapper;
}

function renderShortcutActionsTo(container, items, options = {}) {
  if (!container) return;
  container.innerHTML = "";
  const list = Array.isArray(items) ? items : [];
  const langData = getShortcutLang();
  if (list.length === 0) {
    const empty = document.createElement("div");
    empty.textContent = langData.ShortcutActionNoData;
    empty.style.color = "#6b7280";
    empty.style.fontSize = "13px";
    container.appendChild(empty);
    return;
  }
  list.forEach((item) => {
    container.appendChild(buildShortcutActionItem(item, options));
  });
}

function getCurrentBlocklyCode() {
  try {
    return String(pythonGenerator.workspaceToCode(ws) || "");
  } catch (error) {
    console.warn("build current blockly code failed", error);
    return "";
  }
}

function renderCurrentShortcutSummary() {
  if (!ShortcutActionSummaryList) return [];
  const code = getCurrentBlocklyCode();
  const actions = parseShortcutActionsFromCode(code);
  renderShortcutActionsTo(
    ShortcutActionSummaryList,
    [
      {
        id: "__current__",
        name: "Current Script",
        key_binding: { display: shortcutCapturedBinding?.display || "" },
        actions,
      },
    ],
    { allowDelete: false, detailsByDefault: true }
  );
  return actions;
}

function syncShortcutActionBlocksOptions() {
  if (!ws || typeof ws.getAllBlocks !== "function") return;
  const blocks = ws.getAllBlocks(false);
  blocks.forEach((block) => {
    if (!block || block.type !== "shortcut_action_start") return;
    const field = block.getField("shortcut_action_id");
    if (!field) return;
    let options = [];
    try {
      options = typeof field.getOptions === "function" ? field.getOptions() : [];
    } catch (error) {
      options = [];
    }
    const validValues = new Set(
      options
        .filter((item) => Array.isArray(item) && item.length >= 2)
        .map((item) => String(item[1]))
    );
    const current = String(field.getValue() || "");
    if (current && validValues.has(current)) return;
    const fallback = options?.[0]?.[1];
    field.setValue(String(fallback || ""));
  });
}

async function loadShortcutActionsFromServer() {
  try {
    const response = await fetch("/api/shortcut_actions");
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.status !== "success") {
      throw new Error(payload.message || `HTTP ${response.status}`);
    }
    shortcutActions = Array.isArray(payload.items) ? payload.items : [];
    await refreshShortcutActionOptionsData();
    syncShortcutActionBlocksOptions();

    const listener = payload.listener || {};
    if (!listener.enabled) {
      const hint = String(listener.permissions_hint || "");
      const errorText = String(listener.error || "");
      if (!shortcutListenerWarningShown && (hint || errorText)) {
        shortcutListenerWarningShown = true;
        const langData = getShortcutLang();
        const msg = hint || errorText || langData.ShortcutMacPermissionHint;
        alert(msg);
      }
    }
    return shortcutActions;
  } catch (error) {
    console.warn("loadShortcutActionsFromServer failed", error);
    return shortcutActions;
  }
}

function refreshShortcutListsUI() {
  renderShortcutActionsTo(ShortcutActionSavedList, shortcutActions, {
    allowDelete: true,
    onDelete: async (item) => {
      await deleteShortcutAction(item);
    },
  });
  renderShortcutActionsTo(ShortcutSidebarList, shortcutActions, {
    allowDelete: false,
    detailsByDefault: true,
  });
}

async function refreshShortcutActionsUI() {
  await loadShortcutActionsFromServer();
  refreshShortcutListsUI();
}

async function deleteShortcutAction(item) {
  const id = String(item?.id || "");
  if (!id) return;
  const langData = getShortcutLang();
  try {
    const response = await fetch(`/api/shortcut_actions/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.status !== "success") {
      throw new Error(payload.message || `HTTP ${response.status}`);
    }
    await refreshShortcutActionsUI();
  } catch (error) {
    console.error("deleteShortcutAction failed", error);
    alert(langData.ShortcutActionDeleteFailed);
  }
}

async function saveShortcutAction() {
  if (!BtnShortcutActionConfirm) return;
  const langData = getShortcutLang();
  const name = String(ShortcutActionNameInput?.value || "").trim();
  if (!name) {
    alert(langData.ShortcutActionNeedName);
    return;
  }
  if (!shortcutCapturedBinding || !shortcutCapturedBinding.normalized) {
    alert(langData.ShortcutActionNeedKey);
    return;
  }
  const code = getCurrentBlocklyCode();
  if (!code.trim()) {
    alert(langData.ShortcutActionNeedCode);
    return;
  }
  const actions = parseShortcutActionsFromCode(code);
  BtnShortcutActionConfirm.disabled = true;
  try {
    const response = await fetch("/api/shortcut_actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        key_binding: shortcutCapturedBinding,
        execution_code: code,
        actions,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.status !== "success") {
      throw new Error(payload.message || `HTTP ${response.status}`);
    }
    shortcutCapturedBinding = null;
    if (ShortcutActionNameInput) ShortcutActionNameInput.value = "";
    updateShortcutCaptureUI();
    renderCurrentShortcutSummary();
    await refreshShortcutActionsUI();
    alert(langData.ShortcutActionSaved);
  } catch (error) {
    console.error("saveShortcutAction failed", error);
    alert(`${langData.ShortcutActionSaveFailed}${error?.message ? `: ${error.message}` : ""}`);
  } finally {
    BtnShortcutActionConfirm.disabled = false;
  }
}

function openShortcutActionModal() {
  if (!ShortcutActionModal) return;
  stopShortcutCapture();
  ShortcutActionModal.style.display = "block";
  renderCurrentShortcutSummary();
  refreshShortcutActionsUI();
}

function closeShortcutActionModal() {
  if (!ShortcutActionModal) return;
  stopShortcutCapture();
  ShortcutActionModal.style.display = "none";
}

function openShortcutSidebarModal() {
  if (!ShortcutSidebarModal) return;
  ShortcutSidebarModal.style.display = "block";
  refreshShortcutActionsUI();
}

function closeShortcutSidebarModal() {
  if (!ShortcutSidebarModal) return;
  ShortcutSidebarModal.style.display = "none";
}

function closeShortcutConfirmModal() {
  if (!ShortcutConfirmModal) return;
  ShortcutConfirmModal.style.display = "none";
}

function formatShortcutConfirmMessage(payload) {
  const langData = getShortcutLang();
  const name = String(payload?.shortcut_name || "");
  const keyDisplay = String(payload?.key_binding_display || "");
  let message = String(langData.ShortcutConfirmMessage || "");
  message = message
    .replace("[动作名称]", name)
    .replace("[動作名稱]", name)
    .replace("[action name]", name);
  if (keyDisplay) {
    message = `${message}\n${keyDisplay}`;
  }
  return message;
}

function showNextShortcutConfirm() {
  if (shortcutPendingConfirmEvent || shortcutConfirmQueue.length === 0) return;
  shortcutPendingConfirmEvent = shortcutConfirmQueue.shift();
  if (!shortcutPendingConfirmEvent) return;
  const langData = getShortcutLang();
  setInnerTextIf(ShortcutConfirmTitle, langData.ShortcutConfirmTitle);
  setInnerTextIf(
    ShortcutConfirmMessage,
    formatShortcutConfirmMessage(shortcutPendingConfirmEvent)
  );
  if (ShortcutConfirmModal) {
    ShortcutConfirmModal.style.display = "block";
  }
}

function enqueueShortcutConfirm(payload) {
  const eventId = String(payload?.event_id || "");
  if (!eventId) return;
  if (
    shortcutPendingConfirmEvent?.event_id === eventId ||
    shortcutConfirmQueue.some((item) => String(item?.event_id || "") === eventId)
  ) {
    return;
  }
  shortcutConfirmQueue.push(payload);
  showNextShortcutConfirm();
}

async function submitShortcutConfirm(confirm) {
  const current = shortcutPendingConfirmEvent;
  if (!current) {
    closeShortcutConfirmModal();
    return;
  }
  const eventId = String(current?.event_id || "");
  shortcutPendingConfirmEvent = null;
  closeShortcutConfirmModal();
  if (!eventId) {
    showNextShortcutConfirm();
    return;
  }
  try {
    const response = await fetch("/api/shortcut_actions/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event_id: eventId, confirm: !!confirm }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const langData = getShortcutLang();
      if (response.status === 409) {
        alert(langData.ShortcutBusy);
      } else {
        throw new Error(payload.message || `HTTP ${response.status}`);
      }
    }
  } catch (error) {
    console.error("submitShortcutConfirm failed", error);
  } finally {
    showNextShortcutConfirm();
  }
}

function handleShortcutStreamPayload(payload) {
  const eventType = String(payload?.event_type || "");
  const langData = getShortcutLang();
  if (eventType === "trigger") {
    enqueueShortcutConfirm(payload);
    return;
  }
  if (eventType === "rejected_busy") {
    alert(langData.ShortcutBusy);
    return;
  }
  if (eventType === "listener_status") {
    const enabled = !!payload?.enabled;
    if (enabled) return;
    const hint = String(payload?.permissions_hint || "");
    const errorText = String(payload?.error || "");
    if (!shortcutListenerWarningShown && (hint || errorText)) {
      shortcutListenerWarningShown = true;
      alert(hint || errorText || langData.ShortcutMacPermissionHint);
    }
  }
}

function shouldIgnoreLocalShortcutEventTarget(eventTarget) {
  const elem = eventTarget instanceof Element ? eventTarget : null;
  if (!elem) return false;
  const tagName = String(elem.tagName || "").toUpperCase();
  if (tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT") {
    return true;
  }
  if (elem.isContentEditable) {
    return true;
  }
  return false;
}

async function requestShortcutTriggerFromFrontend(normalizedBinding) {
  const normalized = String(normalizedBinding || "").trim().toLowerCase();
  if (!normalized) return;
  const nowMs = Date.now();
  const prev = Number(shortcutLocalTriggerAt.get(normalized) || 0);
  if (nowMs - prev < 400) {
    return;
  }
  shortcutLocalTriggerAt.set(normalized, nowMs);
  try {
    const response = await fetch("/api/shortcut_actions/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ normalized }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.status !== "success") {
      return;
    }
    if (payload.event) {
      handleShortcutStreamPayload(payload.event);
    }
  } catch (error) {
    console.warn("requestShortcutTriggerFromFrontend failed", error);
  }
}

function handleShortcutLocalKeydown(event) {
  if (shortcutIsCapturing) return;
  if (event?.repeat) return;
  if (shouldIgnoreLocalShortcutEventTarget(event?.target)) return;

  const binding = buildShortcutBindingFromKeyboardEvent(event);
  if (!binding || !binding.normalized) return;
  if (!Array.isArray(binding.modifiers) || binding.modifiers.length === 0) {
    return;
  }
  const normalized = String(binding.normalized || "").toLowerCase();
  const matched = shortcutActions.find((item) => {
    const key = String(item?.key_binding?.normalized || "").toLowerCase();
    return key && key === normalized;
  });
  if (!matched) return;

  event.preventDefault();
  event.stopPropagation();
  requestShortcutTriggerFromFrontend(normalized);
}

function stopShortcutEventStream() {
  if (!shortcutEventSource) return;
  try {
    shortcutEventSource.close();
  } catch (error) {
    console.warn("stopShortcutEventStream close failed", error);
  }
  shortcutEventSource = null;
}

function startShortcutEventStream() {
  stopShortcutEventStream();
  try {
    shortcutEventSource = new EventSource("/api/shortcut_actions/stream");
  } catch (error) {
    console.warn("startShortcutEventStream failed", error);
    return;
  }
  shortcutEventSource.onmessage = (event) => {
    if (!event?.data) return;
    try {
      const payload = JSON.parse(event.data);
      handleShortcutStreamPayload(payload);
    } catch (error) {
      console.warn("parse shortcut stream payload failed", error);
    }
  };
  shortcutEventSource.onerror = () => {
    console.warn("shortcut event stream disconnected");
  };
}

function onShortcutToolboxCategoryClick(event) {
  const row = event?.target?.closest?.(".blocklyTreeRow");
  if (!row) return;
  const labelText = row.querySelector(".blocklyTreeLabel")?.textContent;
  if (getCategoryIconKeyFromLabel(labelText) !== "shortcut") return;
  openShortcutSidebarModal();
}

async function initShortcutActionsFeature() {
  document.addEventListener("keydown", handleShortcutCaptureKeydown, true);
  document.addEventListener("keydown", handleShortcutLocalKeydown, true);
  document.addEventListener("click", onShortcutToolboxCategoryClick, true);
  updateShortcutCaptureUI();
  await refreshShortcutActionsUI();
  startShortcutEventStream();
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
  if (
    !targetConnectDevice ||
    (!targetConnectDevice.address && !targetConnectDevice.name)
  ) {
    return alert("请选择想要连接的Magos设备");
  }
  updateBLEState("connecting");
  fetch("/BLE_Connect", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      address: targetConnectDevice.address || "",
      name: targetConnectDevice.name || "",
    }),
  })
    .then(async (response) => {
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const reason =
          payload && typeof payload === "object"
            ? payload.error || payload.message || ""
            : "";
        const error = new Error(reason || "BLE_Connect");
        if (payload && typeof payload === "object" && payload.code) {
          error.bleCode = payload.code;
        }
        throw error;
      }
      return payload;
    })
    .then((data) => {
      const isConnected =
        (Array.isArray(data) && data[0] === "True") ||
        (data && typeof data === "object" && (data.connected === true || data.status === "success"));
      if (isConnected) {
        // 连接成功，立即同步后端真实状态与设备名
        console.log("蓝牙连接成功，正在同步设备信息...");
        syncBLEStatusWithBackend();
        targetConnectDevice = null;
      } else {
        updateBLEState("error");
        console.log("蓝牙连接失败");
      }
    })
    .catch((error) => {
      updateBLEState("error");
      console.log(error);
      if (error && error.message) {
        alert(error.message);
      }
    });
}

function getBleLangData() {
  return language[currentLanguage] || language.en;
}

function normalizeBleDeviceItem(item, index = 0) {
  if (item === null || item === undefined) return null;
  if (typeof item === "string") {
    const text = item.trim();
    if (!text) return null;
    return {
      address: text,
      name: text,
      display_name: text,
      rssi: null,
    };
  }
  if (typeof item !== "object") return null;

  const isMacAddressText = (text) =>
    /^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/i.test(String(text || "").trim());

  const address = String(item.address || "").trim().toUpperCase();
  const name = String(item.name || "").trim();
  let displayName = String(item.display_name || "").trim();

  // 兜底屏蔽纯地址型广播（无名称设备）。
  if (!name && (isMacAddressText(address) || isMacAddressText(displayName))) {
    return null;
  }
  if (isMacAddressText(name)) {
    return null;
  }

  const fallbackAddress = address || `UNKNOWN_${index}`;
  if (name) {
    // 统一只展示设备名称，不在下拉框展示地址。
    displayName = name;
  } else if (!displayName) {
    displayName = fallbackAddress;
  }
  let rssi = item.rssi;
  if (rssi !== null && rssi !== undefined) {
    const parsed = Number(rssi);
    rssi = Number.isFinite(parsed) ? parsed : null;
  } else {
    rssi = null;
  }

  return {
    address: fallbackAddress,
    name,
    display_name: displayName,
    rssi,
  };
}

function renderBleDeviceOptions(devices) {
  DeviceList.options.length = 1;
  bleDiscoveredDeviceMap.clear();

  devices.forEach((device) => {
    const value = device.address;
    bleDiscoveredDeviceMap.set(value, device);
    DeviceList.options.add(new Option(device.display_name, value));
  });

  if (typeof window._updateAllSlotDeviceLists === "function") {
    window._updateAllSlotDeviceLists();
  }
}

function getBleScanErrorHint(errorCode) {
  const code = String(errorCode || "").trim();
  if (!code) return "";

  const hintMap = {
    hans: {
      ble_unavailable: "请确认目标电脑已安装蓝牙驱动，并使用最新打包版本。",
      permission_denied: "请在系统设置中允许蓝牙访问权限，然后重试。",
      adapter_off: "请开启系统蓝牙开关，并确认蓝牙服务已启动。",
      scan_timeout: "请让机器人靠近电脑后重试，或检查蓝牙适配器状态。",
    },
    hant: {
      ble_unavailable: "請確認目標電腦已安裝藍牙驅動，並使用最新打包版本。",
      permission_denied: "請在系統設定中允許藍牙權限後再重試。",
      adapter_off: "請開啟系統藍牙開關，並確認藍牙服務已啟動。",
      scan_timeout: "請讓機器人靠近電腦後重試，或檢查藍牙配接器狀態。",
    },
    en: {
      ble_unavailable: "Ensure Bluetooth drivers are installed and use the latest packaged build.",
      permission_denied: "Allow Bluetooth access in system settings, then retry.",
      adapter_off: "Turn on Bluetooth and verify Bluetooth services are running.",
      scan_timeout: "Move the robot closer and retry, or check adapter health.",
    },
  };
  const langHints = hintMap[currentLanguage] || hintMap.en;
  return langHints[code] || "";
}

function isConnectPanelVisible() {
  return !!PanelConnect && PanelConnect.style.visibility !== "hidden";
}

function isBleConnectedNow() {
  return !!(ConnectedDevice && String(ConnectedDevice).trim() !== "");
}

function notifyBleScanError(error, source = "manual") {
  const langData = getBleLangData();
  const bleCode = error && error.bleCode ? String(error.bleCode) : "";
  const reason =
    error && error.message ? String(error.message) : String(error || "Unknown");
  const hint = getBleScanErrorHint(bleCode);
  const message = hint
    ? `${langData.BleScanFailed}: ${reason}\n${hint}`
    : `${langData.BleScanFailed}: ${reason}`;
  if (source === "manual") {
    alert(message);
    return;
  }
  const now = Date.now();
  if (now - bleLastAutoScanErrorAt >= BLE_AUTO_SCAN_ERROR_ALERT_INTERVAL_MS) {
    bleLastAutoScanErrorAt = now;
    alert(message);
  }
}

function stopBleAutoScan() {
  if (bleAutoScanTimer !== null) {
    clearInterval(bleAutoScanTimer);
    bleAutoScanTimer = null;
  }
}

function shouldEnableBleAutoScan() {
  return !isBleConnectedNow() && isConnectPanelVisible();
}

async function runBleScan(options = {}) {
  const {
    source = "manual",
    resetSelection = false,
    showNoDevicePrompt = source === "manual",
    silentError = false,
  } = options;

  if (isBleScanInFlight) {
    return { ok: false, skipped: true };
  }

  isBleScanInFlight = true;
  if (BtnDeviceScan) {
    BtnDeviceScan.disabled = true;
  }
  if (source === "manual" && !isBleConnectedNow() && StateBLE) {
    StateBLE.innerText = getBleLangData().State_Scaning || "Scanning";
  }

  try {
    const response = await fetch("/BLE_Refresh", { method: "GET" });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const reason = payload && typeof payload === "object"
        ? payload.error || payload.message || ""
        : "";
      const error = new Error(reason || `HTTP ${response.status}`);
      if (payload && typeof payload === "object" && payload.code) {
        error.bleCode = payload.code;
      }
      throw error;
    }
    if (!Array.isArray(payload)) {
      throw new Error("Invalid BLE scan response");
    }

    const normalizedDevices = payload
      .map((item, index) => normalizeBleDeviceItem(item, index))
      .filter((item) => item !== null);
    renderBleDeviceOptions(normalizedDevices);

    if (resetSelection) {
      resetDeviceListSelection();
    }

    if (normalizedDevices.length === 0 && showNoDevicePrompt) {
      alert(getBleLangData().BleScanNoDevices);
    }

    await syncBLEStatusWithBackend();
    return { ok: true, devices: normalizedDevices };
  } catch (error) {
    console.warn("BLE_Refresh failed:", error);
    if (!silentError) {
      notifyBleScanError(error, source);
    }
    return { ok: false, error };
  } finally {
    isBleScanInFlight = false;
    if (BtnDeviceScan) {
      BtnDeviceScan.disabled = false;
    }
    if (!isBleConnectedNow()) {
      updateBLEState("connect");
    }
    syncBleAutoScanState();
  }
}

function BLE_Refresh(resetSelection = false, options = {}) {
  return runBleScan({ ...options, resetSelection });
}

function startBleAutoScan(options = {}) {
  const { triggerImmediate = false } = options;
  if (bleAutoScanTimer !== null) return;

  bleAutoScanTimer = setInterval(() => {
    if (!shouldEnableBleAutoScan() || isBleScanInFlight) return;
    runBleScan({
      source: "auto",
      resetSelection: false,
      showNoDevicePrompt: false,
      silentError: false,
    });
  }, BLE_AUTO_SCAN_INTERVAL_MS);

  if (triggerImmediate && shouldEnableBleAutoScan() && !isBleScanInFlight) {
    runBleScan({
      source: "auto",
      resetSelection: false,
      showNoDevicePrompt: false,
      silentError: false,
    });
  }
}

function syncBleAutoScanState(options = {}) {
  const { triggerImmediate = false } = options;
  if (!shouldEnableBleAutoScan()) {
    stopBleAutoScan();
    return;
  }
  startBleAutoScan({ triggerImmediate });
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
        handleBleConnectionTransition(false);
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

    if (Array.isArray(data.slots) && data.slots.length > 0) {
      data.slots.forEach((row) => {
        const sid = String(row.slot || "").toUpperCase();
        if (!sid || !robotSlots.has(sid)) return;
        const slotData = robotSlots.get(sid);
        if (slotData.status === "connecting" || slotData.status === "disconnecting") {
          return;
        }
        const conn =
          row.is_connected === true ||
          row.is_connected === "True" ||
          row.is_connected === 1 ||
          row.connected === true ||
          row.connected === "True" ||
          row.connected === 1 ||
          row.isConnected === true ||
          row.isConnected === "True" ||
          row.isConnected === 1;
        if (conn) {
          slotData.status = "connected";
          const dn =
            row.device_name ||
            row.display_name ||
            row.name ||
            slotData.connectedDevice ||
            "";
          if (dn) slotData.connectedDevice = dn;
          const rawBat = row.battery;
          slotData.battery =
            rawBat !== null && rawBat !== undefined
              ? normalizeBatteryValue(rawBat)
              : null;
        } else {
          slotData.status = "connect";
          slotData.connectedDevice = "";
          slotData.battery = null;
        }
      });
      updateBatteryFromStatus(data);
      activeRobotSlotIds.forEach((id) => {
        if (typeof window._updateSlotUI === "function") window._updateSlotUI(id);
      });
      if (typeof window._updateAllSlotDeviceLists === "function") {
        window._updateAllSlotDeviceLists();
      }
      const anyConnectedSlots = [...robotSlots.values()].some(
        (s) => s.status === "connected"
      );
      const anyConnFlag =
        data.any_connected === true ||
        data.any_connected === "True" ||
        data.any_connected === 1;
      const isConnected = anyConnFlag || anyConnectedSlots;
      if (isConnected) {
        const first = [...robotSlots.values()].find((s) => s.status === "connected");
        ConnectedDevice = first ? first.connectedDevice || "Device" : "Unknown Device";
        updateBLEState("connected");
        updateConnectedDeviceUI();
      } else {
        ConnectedDevice = "";
        updateBLEState("connect");
        updateConnectedDeviceUI();
      }
      const firstConnRow = data.slots.find(
        (r) =>
          r.is_connected === true ||
          r.is_connected === "True" ||
          r.is_connected === 1 ||
          r.connected === true ||
          r.connected === "True" ||
          r.connected === 1
      );
      updateAboutFromStatus({
        is_connected: isConnected,
        firmware_version:
          (firstConnRow &&
            (firstConnRow.firmware_version ?? firstConnRow.firmwareVersion)) ??
          data.firmware_version ??
          data.firmwareVersion,
        agent_id:
          (firstConnRow && (firstConnRow.agent_id ?? firstConnRow.agentId)) ??
          data.agent_id ??
          data.agentId,
      });
      handleBleConnectionTransition(isConnected);
      if (typeof window.syncBlocklyRobotDropdownSource === "function") {
        window.syncBlocklyRobotDropdownSource();
      }
      return;
    }
    
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
    updateAboutFromStatus(data);
    handleBleConnectionTransition(isConnected);
    if (typeof window.syncBlocklyRobotDropdownSource === "function") {
      window.syncBlocklyRobotDropdownSource();
    }
  } catch (error) {
    console.warn("BLE Status sync failed:", error);
    setAboutDisconnected();
    handleBleConnectionTransition(false);
    if (typeof window.syncBlocklyRobotDropdownSource === "function") {
      window.syncBlocklyRobotDropdownSource();
    }
  }
}
// 兼容旧名
const checkBleStatusOnLoad = syncBLEStatusWithBackend;

async function playVoice() {
  const slot = getCurrentMusicSlotId();
  const songName = (ParagraphSongTitle && ParagraphSongTitle.innerText ? ParagraphSongTitle.innerText : "").trim();
  if (!songName) {
    alert("请选择想要播放的歌曲");
    return false;
  }
  try {
    const response = await fetch("/api/play_music", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: songName, slot }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || Number(payload.code) !== 200) {
      alert(payload.msg || `${songName} 播放失败`);
      return false;
    }
    console.log(`${songName} 已经开始播放`);
    return true;
  } catch (error) {
    console.log("play_music error:", error);
    return false;
  }
}

async function pauseVoice() {
  try {
    const response = await fetch("/api/pause_music", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot: getCurrentMusicSlotId() }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || Number(payload.code) !== 200) {
      console.log("歌曲停止失败", payload);
      return false;
    }
    console.log("歌曲停止成功");
    return true;
  } catch (error) {
    console.log("pause_music error:", error);
    return false;
  }
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

function applyMagosRobotSlotsHintFromFile(fileContent) {
  if (typeof activeRobotSlotIds === "undefined" || !fileContent) return;
  const m = fileContent.match(/^\#\s*MagosRobotSlots:\s*(.+)$/m);
  if (!m) return;
  const raw = String(m[1] || "").trim();
  if (!raw) return;
  let maxIdx = activeRobotSlotIds.length - 1;
  raw.split(/[\s,]+/).forEach((tok) => {
    const v = String(tok || "").trim().toUpperCase();
    if (v.length === 1 && v >= "A" && v <= "F") {
      const idx = v.charCodeAt(0) - 65;
      if (idx > maxIdx) maxIdx = idx;
    }
  });
  const targetCount = Math.min(
    ROBOT_SLOT_MAX,
    Math.max(activeRobotSlotIds.length, maxIdx + 1)
  );
  while (activeRobotSlotIds.length < targetCount) {
    const next = String.fromCharCode(65 + activeRobotSlotIds.length);
    activeRobotSlotIds.push(next);
    ensureRobotSlotState(next);
  }
  saveActiveRobotSlotIds();
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

    if (typeof window.expandActiveRobotSlotsForImportedWorkspace === "function") {
      window.expandActiveRobotSlotsForImportedWorkspace(ws);
    }
    if (typeof window._rebuildRobotSlotUI === "function") {
      window._rebuildRobotSlotUI();
    }
    if (typeof window.syncBlocklyRobotDropdownSource === "function") {
      window.syncBlocklyRobotDropdownSource();
    }

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

    applyMagosRobotSlotsHintFromFile(fileContent);

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
const MUSIC_SLOT_CACHE_KEY_PREFIX = "miniCachedSongs_v5_";
const MUSIC_SLOT_VERSION_KEY_PREFIX = "MusicListVersion_";

function normalizeRobotSlotId(value) {
  const slot = String(value || "").trim().toUpperCase();
  if (!slot) return "";
  return /^[A-F]$/.test(slot) ? slot : "";
}

// [MAGOS_DEMO_BEGIN __MAGOS_DEMO_PREVIEW__ feature=music_multi_slot]
function isMagosDemoMode() {
  try {
    return localStorage.getItem(MAGOS_DEMO_KEY) === "true";
  } catch {
    return false;
  }
}

function ensureMagosDemoDefaultEnabled() {
  try {
    if (localStorage.getItem(MAGOS_DEMO_KEY) == null) {
      localStorage.setItem(MAGOS_DEMO_KEY, "true");
    }
  } catch (_err) {
    // ignore localStorage failures
  }
}

function getMagosMusicDemoSlotIds() {
  if (Array.isArray(activeRobotSlotIds) && activeRobotSlotIds.length > 0) {
    return activeRobotSlotIds.slice();
  }
  return ["A", "B", "C", "D"];
}

function getMagosMusicDemoSlot() {
  const fallback = getMagosMusicDemoSlotIds()[0];
  try {
    const slot = normalizeRobotSlotId(localStorage.getItem(MAGOS_MUSIC_DEMO_SLOT_KEY));
    if (slot && getMagosMusicDemoSlotIds().includes(slot)) return slot;
  } catch (_err) {
    // ignore localStorage failures
  }
  return fallback;
}

function setMagosMusicDemoSlot(slotId) {
  const slot = normalizeRobotSlotId(slotId);
  if (!slot || !getMagosMusicDemoSlotIds().includes(slot)) return;
  try {
    localStorage.setItem(MAGOS_MUSIC_DEMO_SLOT_KEY, slot);
  } catch (_err) {
    // ignore localStorage failures
  }
}

function buildMagosMusicDemoSongs(slotId) {
  const slot = normalizeRobotSlotId(slotId) || "A";
  return [
    { id: `${slot}-1`, title: `机位${slot} - 早安律动`, artist: "Magos Demo" },
    { id: `${slot}-2`, title: `机位${slot} - 快乐节拍`, artist: "Magos Demo" },
    { id: `${slot}-3`, title: `机位${slot} - 晚安钢琴`, artist: "Magos Demo" },
    { id: `${slot}-4`, title: `机位${slot} - 儿歌互动`, artist: "Magos Demo" },
  ];
}

function ensureMusicDemoSlotSelector() {
  if (!isMagosDemoMode()) return;
  const panelTop = document.getElementById("PanelMusicTop");
  if (!panelTop) return;
  let select = document.getElementById("MusicDemoSlotSelect");
  if (!select) {
    select = document.createElement("select");
    select.id = "MusicDemoSlotSelect";
    select.style.marginLeft = "8px";
    select.style.padding = "4px 6px";
    select.style.borderRadius = "8px";
    select.style.border = "1px solid #d1d5db";
    select.style.fontSize = "12px";
    panelTop.appendChild(select);
    select.addEventListener("change", () => {
      setMagosMusicDemoSlot(select.value);
      songs = getAllSongs();
      displaySongs(searchSongs(MusicInput ? MusicInput.value : ""));
      void syncMusicList({ force: true });
    });
  }
  const slotIds = getMagosMusicDemoSlotIds();
  const current = getMagosMusicDemoSlot();
  const optionsHtml = slotIds
    .map((slotId) => `<option value="${slotId}">预览机位 ${slotId}</option>`)
    .join("");
  if (select.innerHTML !== optionsHtml) {
    select.innerHTML = optionsHtml;
  }
  select.value = current;
}
// [MAGOS_DEMO_END]

function setMagosMusicSelectedSlot(slot, options = {}) {
  const { reason = "user" } = options || {};
  const norm = normalizeRobotSlotId(slot);
  if (!norm || !activeRobotSlotIds.includes(norm)) return false;
  if (norm === magosMusicSelectedSlot && reason !== "force") {
    renderMusicSlotTabs();
    return false;
  }
  magosMusicSelectedSlot = norm;
  try {
    localStorage.setItem(MAGOS_MUSIC_SELECTED_SLOT_KEY, norm);
  } catch (_err) {
    // ignore localStorage failures
  }
  // [MAGOS_DEMO_BEGIN __MAGOS_DEMO_PREVIEW__ feature=music_multi_slot]
  if (isMagosDemoMode()) {
    setMagosMusicDemoSlot(norm);
  }
  // [MAGOS_DEMO_END]
  songs = getAllSongs();
  if (typeof MusicInput !== "undefined" && MusicInput) {
    displaySongs(searchSongs(MusicInput.value || ""));
  } else {
    displaySongs(searchSongs(""));
  }
  void syncMusicList({ force: true });
  if (typeof refreshBackgroundMusicDropdownBlocks === "function") {
    try { refreshBackgroundMusicDropdownBlocks(); } catch (_err) { /* noop */ }
  }
  if (typeof applyMusicUploadProgressSlotVisibility === "function") {
    try { applyMusicUploadProgressSlotVisibility(); } catch (_err) { /* noop */ }
  }
  renderMusicSlotTabs();
  return true;
}

function renderMusicSlotTabs() {
  const panelTop = document.getElementById("PanelMusicTop");
  if (!panelTop) return;
  let tabs = document.getElementById("MusicSlotTabs");
  if (!tabs) {
    tabs = document.createElement("div");
    tabs.id = "MusicSlotTabs";
    tabs.className = "music-slot-tabs";
    if (panelTop.firstChild) {
      panelTop.insertBefore(tabs, panelTop.firstChild);
    } else {
      panelTop.appendChild(tabs);
    }
  }
  const slotIds = Array.isArray(activeRobotSlotIds) && activeRobotSlotIds.length
    ? activeRobotSlotIds.slice()
    : ["A"];
  if (!magosMusicSelectedSlot || !slotIds.includes(magosMusicSelectedSlot)) {
    magosMusicSelectedSlot = slotIds[0];
    try {
      localStorage.setItem(MAGOS_MUSIC_SELECTED_SLOT_KEY, magosMusicSelectedSlot);
    } catch (_err) {
      // ignore
    }
  }
  const current = magosMusicSelectedSlot;
  const existingByValue = new Map();
  Array.from(tabs.querySelectorAll("button.music-slot-tab")).forEach((btn) => {
    existingByValue.set(btn.dataset.slot, btn);
  });
  const usedKeys = new Set();
  slotIds.forEach((slotId, idx) => {
    let btn = existingByValue.get(slotId);
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.className = "music-slot-tab";
      btn.dataset.slot = slotId;
      btn.addEventListener("click", () => {
        setMagosMusicSelectedSlot(btn.dataset.slot);
      });
    }
    btn.textContent = slotId;
    btn.dataset.active = slotId === current ? "true" : "false";
    const slotState = robotSlots.get(slotId);
    const isConnected = !!(slotState && slotState.status === "connected");
    btn.dataset.connected = isConnected ? "true" : "false";
    if (tabs.children[idx] !== btn) {
      tabs.appendChild(btn);
    }
    usedKeys.add(slotId);
  });
  Array.from(tabs.querySelectorAll("button.music-slot-tab")).forEach((btn) => {
    if (!usedKeys.has(btn.dataset.slot)) {
      btn.remove();
    }
  });
}

function loadMagosMusicSelectedSlot() {
  try {
    const raw = localStorage.getItem(MAGOS_MUSIC_SELECTED_SLOT_KEY);
    const norm = normalizeRobotSlotId(raw);
    if (norm && activeRobotSlotIds.includes(norm)) {
      magosMusicSelectedSlot = norm;
      return norm;
    }
  } catch (_err) {
    // ignore localStorage failures
  }
  magosMusicSelectedSlot = "";
  return "";
}

function getCurrentMusicSlotId() {
  if (magosMusicSelectedSlot && activeRobotSlotIds.includes(magosMusicSelectedSlot)) {
    return magosMusicSelectedSlot;
  }
  // [MAGOS_DEMO_BEGIN __MAGOS_DEMO_PREVIEW__ feature=music_multi_slot]
  if (isMagosDemoMode()) {
    const demoSlot = getMagosMusicDemoSlot();
    if (demoSlot && activeRobotSlotIds.includes(demoSlot)) return demoSlot;
  }
  // [MAGOS_DEMO_END]
  if (typeof aboutV2CurrentSlotId !== "undefined") {
    const preferred = normalizeRobotSlotId(aboutV2CurrentSlotId);
    if (preferred && activeRobotSlotIds.includes(preferred)) {
      return preferred;
    }
  }
  const connectedSlots = activeRobotSlotIds.filter((id) => {
    const slotState = robotSlots.get(id);
    return slotState && slotState.status === "connected";
  });
  if (connectedSlots.length > 0) return connectedSlots[0];
  if (activeRobotSlotIds.includes("A")) return "A";
  return activeRobotSlotIds[0] || "A";
}

function getMusicVersionKey(slotId = getCurrentMusicSlotId()) {
  const slot = normalizeRobotSlotId(slotId) || "A";
  return `${MUSIC_SLOT_VERSION_KEY_PREFIX}${slot}`;
}

function getMusicCacheKey(slotId = getCurrentMusicSlotId()) {
  const slot = normalizeRobotSlotId(slotId) || "A";
  return `${MUSIC_SLOT_CACHE_KEY_PREFIX}${slot}`;
}

// 初始化歌曲数据（模拟缓存）
function initializeSongs() {
  const slot = getCurrentMusicSlotId();
  const versionKey = getMusicVersionKey(slot);
  const cacheKey = getMusicCacheKey(slot);
  // 版本检测与缓存清理（按机位隔离）
  if (localStorage.getItem(versionKey) !== MUSIC_LIST_VERSION) {
    localStorage.removeItem(cacheKey);
    localStorage.setItem(versionKey, MUSIC_LIST_VERSION);
    localStorage.removeItem("miniCachedSongs_v5");
    localStorage.removeItem("MusicListVersion");
  }

  if (!localStorage.getItem(cacheKey)) {
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
    localStorage.setItem(cacheKey, JSON.stringify(defaultSongs));
  }
}

// 获取所有歌曲
function getAllSongs(slotId = getCurrentMusicSlotId()) {
  return JSON.parse(localStorage.getItem(getMusicCacheKey(slotId))) || [];
}

function normalizeSongName(name) {
  return String(name || "")
    .trim()
    .replace(/\.[^/.]+$/, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function normalizeAudioUrl(value) {
  if (typeof value !== "string") return "";
  const raw = value.trim();
  if (!raw) return "";
  if (raw.startsWith("http://") || raw.startsWith("https://") || raw.startsWith("blob:")) {
    return raw;
  }
  if (raw.startsWith("./")) {
    return `/${raw.slice(2)}`;
  }
  if (raw.startsWith("static/")) {
    return `/${raw}`;
  }
  if (raw.startsWith("/")) {
    return raw;
  }
  return "";
}

function isPlayableAudioUrl(value) {
  return normalizeAudioUrl(value) !== "";
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
    const normalized = normalizeAudioUrl(candidate);
    if (normalized) return normalized;
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
  MusicValue.dataset.songName = normalizeSongName(item.title);
  MusicValue.dataset.fileUrl = getSongFileUrl(item);
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "music-delete-checkbox";
  checkbox.value = MusicValue.dataset.songName;
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
  const slot = getCurrentMusicSlotId();
  const cachedSongs = getAllSongs(slot);
  const key = normalizeSongName(song.title);
  const idx = cachedSongs.findIndex((item) => normalizeSongName(item.title) === key);
  if (idx >= 0) {
    cachedSongs[idx] = { ...cachedSongs[idx], ...song };
  } else {
    cachedSongs.push(song);
  }
  localStorage.setItem(getMusicCacheKey(slot), JSON.stringify(cachedSongs));
  songs = cachedSongs;
}

function displaySongs(songs) {
  removeMusicSyncHint();
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

function refreshBackgroundMusicDropdownBlocks() {
  if (!ws || typeof ws.getAllBlocks !== "function") return;
  const blocks = ws.getAllBlocks(false);
  blocks.forEach((block) => {
    if (!block || block.type !== "play_background_audio") return;
    const field = block.getField("background_audio_index");
    if (!field || typeof field.getOptions !== "function") return;
    const options = field.getOptions(false) || [];
    if (!Array.isArray(options) || options.length === 0) return;
    const optionValues = new Set(options.map((item) => String(item && item[1] ? item[1] : "")));
    const currentValue = String(field.getValue() || "");
    if (optionValues.has(currentValue)) {
      field.setValue(currentValue);
      return;
    }
    const firstValue = String(options[0][1] || "");
    if (firstValue) {
      field.setValue(firstValue);
    }
  });
}

function removeMusicSyncHint() {
  if (!PanelMusicMid) return;
  const hintNode = document.getElementById(MUSIC_SYNC_HINT_ID);
  if (hintNode) {
    hintNode.remove();
  }
}

function showMusicSyncHint(text, mode = "info") {
  if (!PanelMusicMid) return;
  removeMusicSyncHint();
  const hintNode = document.createElement("div");
  hintNode.id = MUSIC_SYNC_HINT_ID;
  hintNode.textContent = String(text || "音乐列表同步中...");
  hintNode.style.padding = "12px 10px";
  hintNode.style.fontSize = "14px";
  hintNode.style.fontWeight = "600";
  hintNode.style.color = mode === "error" ? "#c62828" : "#1e88e5";
  PanelMusicMid.appendChild(hintNode);
}

function clearSongsForDeviceSync() {
  // Keep current list visible while syncing to avoid refresh-time flicker/loss.
  const cachedSongs = getAllSongs();
  songs = cachedSongs;
  displaySongs(searchSongs(MusicInput ? MusicInput.value : ""));
  showMusicSyncHint("音乐列表同步中...");
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

function getSelectedDeleteSongNames() {
  const checkboxes = PanelMusicMid.querySelectorAll(
    ".music-delete-checkbox:checked"
  );
  return Array.from(checkboxes)
    .map((checkbox) => checkbox.value)
    .filter((value) => value);
}

function removeSongsBySongNames(songNames) {
  const slot = getCurrentMusicSlotId();
  const removeSet = new Set(songNames);
  const cachedSongs = getAllSongs(slot);
  const nextSongs = cachedSongs.filter(
    (song) => !removeSet.has(normalizeSongName(song.title))
  );
  localStorage.setItem(getMusicCacheKey(slot), JSON.stringify(nextSongs));
  songs = nextSongs;
}

async function deleteSelectedMusic() {
  const slot = getCurrentMusicSlotId();
  const namesToDelete = getSelectedDeleteSongNames();
  if (namesToDelete.length === 0) {
    alert("Select at least one song to delete.");
    return;
  }
  DeleteMusic.disabled = true;
  try {
    const response = await fetch("/api/delete_music", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ names: namesToDelete, slot }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.code !== 200) {
      const failedNames = Array.isArray(payload.failed_device_names)
        ? payload.failed_device_names.filter((item) => item)
        : [];
      const failedSuffix = failedNames.length
        ? ` (${failedNames.join(", ")})`
        : "";
      throw new Error(
        `${payload.msg || `Delete failed with status ${response.status}`}${failedSuffix}`
      );
    }
    const removedNames = Array.isArray(payload.removed_names) && payload.removed_names.length > 0
      ? payload.removed_names.map((name) => normalizeSongName(name))
      : namesToDelete;
    removeSongsBySongNames(removedNames);
    const query = MusicInput.value;
    displaySongs(searchSongs(query));
    await syncMusicList({ force: true });
    setDeleteMode(false);
  } catch (error) {
    console.log("delete_music error:", error);
    alert(error && error.message ? error.message : "Delete failed");
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

function clampMusicProgress(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(100, num));
}

function calcMusicOverallProgress(localProgress, deviceProgress) {
  return clampMusicProgress((0.3 * localProgress) + (0.7 * deviceProgress));
}

function setMusicUploadBusy(isBusy) {
  if (UploadMusic) UploadMusic.disabled = isBusy;
}

function stopMusicUploadFallbackSync() {
  musicUploadFallbackActive = false;
  if (musicUploadFallbackTimer) {
    clearTimeout(musicUploadFallbackTimer);
    musicUploadFallbackTimer = null;
  }
}

function triggerMusicUploadFallbackSync(maxRetries = MUSIC_UPLOAD_FALLBACK_MAX_RETRIES) {
  if (musicUploadFallbackActive) return;
  musicUploadFallbackActive = true;
  let attempts = 0;

  const runSync = async () => {
    if (!musicUploadFallbackActive) return;
    attempts += 1;
    await syncMusicList();
    if (!musicUploadFallbackActive) return;
    if (attempts >= maxRetries) {
      stopMusicUploadFallbackSync();
      return;
    }
    musicUploadFallbackTimer = setTimeout(runSync, MUSIC_UPLOAD_FALLBACK_INTERVAL_MS);
  };

  runSync();
}

function stopMusicUploadStatusPolling() {
  musicUploadStatusPollActive = false;
  musicUploadStatusPollRetries = 0;
  if (musicUploadStatusPollTimer) {
    clearTimeout(musicUploadStatusPollTimer);
    musicUploadStatusPollTimer = null;
  }
}

function startMusicUploadStatusPolling(transferId) {
  const targetTransferId = String(transferId || "").trim();
  if (!targetTransferId || musicUploadStatusPollActive) return;
  musicUploadStatusPollActive = true;
  musicUploadStatusPollRetries = 0;

  const pollOnce = async () => {
    if (!musicUploadStatusPollActive) return;
    musicUploadStatusPollRetries += 1;

    try {
      const response = await fetch(`/api/music_upload/status/${encodeURIComponent(targetTransferId)}`, {
        method: "GET",
        cache: "no-store",
        headers: { "Cache-Control": "no-cache" },
      });
      const payload = await response.json().catch(() => ({}));
      if (response.ok && Number(payload.code) === 200) {
        const stageValue = String(payload.stage || "").toLowerCase();
        renderMusicUploadProgress({
          stage: stageValue || "queued",
          localProgress: payload.local_progress,
          deviceProgress: payload.device_progress,
          message: payload.message,
          error: payload.error,
        });

        if (stageValue === "done") {
          musicUploadTerminalStage = "done";
          stopMusicUploadStatusPolling();
          stopMusicUploadFallbackSync();
          closeMusicUploadStream();
          await syncMusicListOnDone("status_done");
          return;
        }
        if (stageValue === "error") {
          musicUploadTerminalStage = "error";
          stopMusicUploadStatusPolling();
          closeMusicUploadStream();
          triggerMusicUploadFallbackSync();
          return;
        }
      }
    } catch (error) {
      console.warn("music upload status poll failed:", error);
    }

    if (!musicUploadStatusPollActive) return;
    if (musicUploadStatusPollRetries >= MUSIC_UPLOAD_STATUS_POLL_MAX_RETRIES) {
      stopMusicUploadStatusPolling();
      triggerMusicUploadFallbackSync();
      return;
    }
    musicUploadStatusPollTimer = setTimeout(pollOnce, MUSIC_UPLOAD_STATUS_POLL_INTERVAL_MS);
  };

  pollOnce();
}

function closeMusicUploadStream() {
  if (musicUploadEventSource) {
    musicUploadEventSource.close();
    musicUploadEventSource = null;
  }
  stopMusicUploadStatusPolling();
  musicUploadTransferId = "";
}

function renderMusicUploadProgress({
  stage = "idle",
  localProgress = 0,
  deviceProgress = 0,
  message = "",
  error = "",
}) {
  if (!MusicUploadProgress || !MusicUploadText || !MusicUploadBarFill || !MusicUploadDetail) return;

  const normalizedStage = String(stage || "idle").trim().toLowerCase();
  const local = clampMusicProgress(localProgress);
  const device = clampMusicProgress(deviceProgress);
  const overall = Math.round(calcMusicOverallProgress(local, device));

  MusicUploadProgress.style.display = "flex";
  MusicUploadProgress.dataset.stage = normalizedStage;
  MusicUploadBarFill.style.width = `${overall}%`;
  MusicUploadText.textContent = `Uploading ${overall}% (Local ${Math.round(local)}% | Device ${Math.round(device)}%)`;

  let detail = message || "";
  if (!detail) {
    if (normalizedStage === "uploading_local") detail = "Status: uploading file to backend";
    else if (normalizedStage === "queued") detail = "Status: queued, waiting for BLE transfer";
    else if (normalizedStage === "transferring") detail = "Status: sending to device";
    else if (normalizedStage === "done") detail = "Status: upload completed";
    else if (normalizedStage === "error") detail = "Status: upload failed";
    else detail = "Status: waiting";
  }
  if (normalizedStage === "error" && error) {
    detail = `Status: failed - ${error}`;
  }
  MusicUploadDetail.textContent = detail;

  if (normalizedStage === "done") {
    setMusicUploadBusy(false);
  } else if (normalizedStage === "error") {
    setMusicUploadBusy(false);
  }
}

function stopMusicDeviceSyncPolling() {
  if (musicDeviceSyncPollTimer) {
    clearTimeout(musicDeviceSyncPollTimer);
    musicDeviceSyncPollTimer = null;
  }
  musicDeviceSyncPollCount = 0;
}

function startMusicDeviceSyncPolling(sessionId = "") {
  stopMusicDeviceSyncPolling();
  musicDeviceSyncSessionId = String(sessionId || "");

  const runPoll = async () => {
    const result = await syncMusicList({ force: true });
    const syncState = String((result && result.syncState) || "idle").toLowerCase();
    const responseSessionId = String((result && result.syncSessionId) || "");

    if (musicDeviceSyncSessionId && responseSessionId && responseSessionId !== musicDeviceSyncSessionId) {
      showMusicSyncHint("音乐列表同步中...");
    }

    if (syncState === "syncing") {
      musicDeviceSyncPollCount += 1;
      if (musicDeviceSyncPollCount >= MUSIC_DEVICE_SYNC_MAX_POLLS) {
        showMusicSyncHint("音乐列表同步超时，请稍后重试。", "error");
        stopMusicDeviceSyncPolling();
        return;
      }
      musicDeviceSyncPollTimer = setTimeout(runPoll, MUSIC_DEVICE_SYNC_POLL_INTERVAL_MS);
      return;
    }

    if (syncState === "error") {
      showMusicSyncHint("音乐列表同步失败，请重试连接。", "error");
      stopMusicDeviceSyncPolling();
      return;
    }

    removeMusicSyncHint();
    stopMusicDeviceSyncPolling();
  };

  runPoll();
}

async function requestDeviceMusicSync() {
  if (musicDeviceSyncRequestInFlight) return;
  musicDeviceSyncRequestInFlight = true;
  try {
    const slot = getCurrentMusicSlotId();
    clearSongsForDeviceSync();
    const response = await fetch("/api/music/sync_now", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "frontend_connect", slot }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || Number(payload.code) !== 200) {
      throw new Error(payload.msg || `HTTP ${response.status}`);
    }
    const sessionId = String(payload.sync_session_id || "");
    showMusicSyncHint("音乐列表同步中...");
    startMusicDeviceSyncPolling(sessionId);
  } catch (err) {
    console.warn("requestDeviceMusicSync failed:", err);
    showMusicSyncHint("音乐列表同步失败，请重试连接。", "error");
    stopMusicDeviceSyncPolling();
    await syncMusicList({ force: true });
  } finally {
    musicDeviceSyncRequestInFlight = false;
  }
}

function handleBleConnectionTransition(isConnected) {
  const nowConnected = !!isConnected;
  if (nowConnected && !wasBleConnected) {
    requestDeviceMusicSync();
  }
  if (!nowConnected && wasBleConnected) {
    stopMusicDeviceSyncPolling();
    removeMusicSyncHint();
  }
  wasBleConnected = nowConnected;
  syncBleAutoScanState({ triggerImmediate: !nowConnected });
}

function parseMusicVersion(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.floor(num);
}

async function syncMusicList(options = {}) {
  const { force = false } = options || {};
  const slot = getCurrentMusicSlotId();
  if (musicSyncInFlight && !force) {
    return musicSyncInFlight;
  }

  const runSync = async () => {
    // [MAGOS_DEMO_BEGIN __MAGOS_DEMO_PREVIEW__ feature=music_multi_slot]
    if (isMagosDemoMode()) {
      const nextSongs = buildMagosMusicDemoSongs(slot);
      localStorage.setItem(getMusicCacheKey(slot), JSON.stringify(nextSongs));
      songs = nextSongs;
      const query = MusicInput ? MusicInput.value : "";
      displaySongs(searchSongs(query || ""));
      refreshBackgroundMusicDropdownBlocks();
      return { syncState: "idle", syncSessionId: "" };
    }
    // [MAGOS_DEMO_END]
    try {
      const response = await fetch(`/api/music_data?_ts=${Date.now()}&slot=${encodeURIComponent(slot)}`, {
        method: "GET",
        cache: "no-store",
        headers: { "Cache-Control": "no-cache" },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.code !== 200 || !Array.isArray(payload.music)) {
        throw new Error(payload.msg || `HTTP ${response.status}`);
      }

      const syncState = String(payload.sync_state || "idle").toLowerCase();
      const syncSessionId = String(payload.sync_session_id || "");
      if (syncState === "syncing") {
        // Do not clear existing list while device sync is in progress.
        showMusicSyncHint("音乐列表同步中...");
        return { syncState, syncSessionId };
      }

      if (syncState === "error") {
        showMusicSyncHint("音乐列表同步失败，请重试连接。", "error");
      } else {
        removeMusicSyncHint();
      }

      const incomingVersion = parseMusicVersion(payload.music_version);
      const seenVersion = Number(musicListVersionSeenBySlot[slot] || 0);
      if (!force && incomingVersion > 0 && incomingVersion < seenVersion) {
        return { syncState, syncSessionId };
      }
      if (incomingVersion > 0) {
        musicListVersionSeenBySlot[slot] = Math.max(seenVersion, incomingVersion);
      }

      const nextSongs = payload.music
        .filter((item) => item && typeof item === "object")
        .map((item, index) => ({
          id: item.name || `song_${index + 1}`,
          title: item.name || `song_${index + 1}`,
          artist: item.artist || "Local Upload",
          fileUrl: normalizeAudioUrl(item.url || item.file_url || ""),
        }));

      localStorage.setItem(getMusicCacheKey(slot), JSON.stringify(nextSongs));
      songs = nextSongs;
      const query = MusicInput ? MusicInput.value : "";
      displaySongs(searchSongs(query || ""));
      refreshBackgroundMusicDropdownBlocks();
      return { syncState, syncSessionId };
    } catch (err) {
      console.error("syncMusicList failed:", err);
      return { syncState: "error", syncSessionId: "" };
    }
  };

  musicSyncInFlight = runSync().finally(() => {
    musicSyncInFlight = null;
  });
  return musicSyncInFlight;
}

async function syncMusicListOnDone(reason = "") {
  void reason;
  const now = Date.now();
  if (now - musicLastDoneSyncAt < MUSIC_SYNC_DONE_DEDUPE_MS) {
    return;
  }
  musicLastDoneSyncAt = now;
  await syncMusicList();
}

function applyMusicUploadProgressSlotVisibility() {
  const progressEl = document.getElementById("MusicUploadProgress");
  if (!progressEl) return;
  const ownerSlot = normalizeRobotSlotId(progressEl.dataset.slot || "");
  if (!ownerSlot) return;
  const currentSlot = getCurrentMusicSlotId();
  if (ownerSlot !== currentSlot) {
    progressEl.dataset.slotHidden = "true";
    progressEl.style.display = "none";
  } else {
    if (progressEl.dataset.slotHidden === "true") {
      progressEl.style.display = "";
    }
    progressEl.dataset.slotHidden = "false";
  }
}

function startMusicUploadStream(transferId, ownerSlot) {
  closeMusicUploadStream();
  musicUploadTransferId = String(transferId || "");
  if (!musicUploadTransferId) {
    return;
  }
  const slotForUpload = normalizeRobotSlotId(ownerSlot) || getCurrentMusicSlotId();
  const progressEl = document.getElementById("MusicUploadProgress");
  if (progressEl) {
    progressEl.dataset.slot = slotForUpload;
  }
  applyMusicUploadProgressSlotVisibility();

  const streamUrl = `/api/music_upload/stream?transfer_id=${encodeURIComponent(musicUploadTransferId)}`;
  musicUploadEventSource = new EventSource(streamUrl);

  musicUploadEventSource.onmessage = async (event) => {
    if (!event || !event.data) return;
    try {
      const payload = JSON.parse(event.data);
      if (slotForUpload && slotForUpload !== getCurrentMusicSlotId()) {
        // upload belongs to another slot; do not refresh visible progress UI
      } else {
        renderMusicUploadProgress({
          stage: payload.stage,
          localProgress: payload.local_progress,
          deviceProgress: payload.device_progress,
          message: payload.message,
          error: payload.error,
        });
      }

      const stageValue = String(payload.stage || "").toLowerCase();
      if (stageValue === "done") {
        musicUploadTerminalStage = "done";
        stopMusicUploadFallbackSync();
        closeMusicUploadStream();
        await syncMusicListOnDone("sse_done");
      } else if (stageValue === "error") {
        musicUploadTerminalStage = "error";
        triggerMusicUploadFallbackSync();
        closeMusicUploadStream();
      }
    } catch (err) {
      console.error("Invalid music upload SSE payload:", err);
    }
  };

  musicUploadEventSource.onerror = () => {
    if (musicUploadTerminalStage === "done" || musicUploadTerminalStage === "error") {
      return;
    }
    if (MusicUploadDetail) {
      MusicUploadDetail.textContent = "Status: stream disconnected, reconnecting...";
    }
    startMusicUploadStatusPolling(musicUploadTransferId);
    triggerMusicUploadFallbackSync();
  };
}

function uploadMusicFile(file, onLocalProgress) {
  const slot = getCurrentMusicSlotId();
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("slot", slot);
    const baseName = String(file.name || "").replace(/\.[^/.]+$/, "");
    formData.append("name", baseName);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload_music", true);

    xhr.upload.onprogress = (event) => {
      if (!event || !event.lengthComputable) return;
      const localProgress = clampMusicProgress((event.loaded / event.total) * 100);
      if (typeof onLocalProgress === "function") {
        onLocalProgress(localProgress);
      }
    };

    xhr.onload = () => {
      let payload = {};
      try {
        payload = JSON.parse(xhr.responseText || "{}");
      } catch (_err) {
        payload = {};
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(payload);
        return;
      }
      reject(new Error(payload.msg || `Upload failed with status ${xhr.status}`));
    };

    xhr.onerror = () => reject(new Error("Upload failed due to network error"));
    xhr.onabort = () => reject(new Error("Upload aborted"));
    xhr.send(formData);
  });
}

function isMp3UploadFile(file) {
  const fileName = String(file?.name || "").trim();
  return /\.mp3$/i.test(fileName);
}

function validateMusicUploadFile(file) {
  const langData = language[currentLanguage] || language.en;
  if (!isMp3UploadFile(file)) {
    return {
      ok: false,
      message: langData.MusicUploadOnlyMp3 || language.en.MusicUploadOnlyMp3,
    };
  }
  const fileSize = Number(file?.size || 0);
  if (!Number.isFinite(fileSize) || fileSize <= 0) {
    return {
      ok: false,
      message: langData.MusicUploadOnlyMp3 || language.en.MusicUploadOnlyMp3,
    };
  }
  if (fileSize > MAX_MUSIC_UPLOAD_BYTES) {
    return {
      ok: false,
      message: langData.MusicUploadTooLarge || language.en.MusicUploadTooLarge,
    };
  }
  return { ok: true, message: "" };
}

async function handleMusicUpload() {
  const file = UploadMusicInput.files && UploadMusicInput.files[0];
  if (!file || musicUploadRequestInFlight) {
    if (UploadMusicInput) UploadMusicInput.value = "";
    return;
  }

  const validation = validateMusicUploadFile(file);
  if (!validation.ok) {
    alert(validation.message);
    if (UploadMusicInput) UploadMusicInput.value = "";
    return;
  }

  musicUploadRequestInFlight = true;
  setMusicUploadBusy(true);
  closeMusicUploadStream();
  stopMusicUploadFallbackSync();
  musicUploadTerminalStage = "";

  try {
    renderMusicUploadProgress({
      stage: "uploading_local",
      localProgress: 0,
      deviceProgress: 0,
      message: "Status: uploading file to backend",
      error: "",
    });

    const result = await uploadMusicFile(file, (localProgress) => {
      renderMusicUploadProgress({
        stage: "uploading_local",
        localProgress,
        deviceProgress: 0,
        message: "Status: uploading file to backend",
        error: "",
      });
    });

    if (!result || result.code !== 200) {
      throw new Error((result && result.msg) || "Upload failed");
    }
    const uploadMusicVersion = parseMusicVersion(result.music_version);
    if (uploadMusicVersion > 0) {
      const slot = getCurrentMusicSlotId();
      const seenVersion = Number(musicListVersionSeenBySlot[slot] || 0);
      musicListVersionSeenBySlot[slot] = Math.max(seenVersion, uploadMusicVersion);
    }

    if (MusicInput) {
      MusicInput.value = "";
    }
    displaySongs(searchSongs(""));
    await syncMusicList({ force: true });

    const transferId = String(result.transfer_id || "");
    const stage = String(result.stage || "queued").toLowerCase();
    const deviceMessage = String(result.device_message || "queued");
    renderMusicUploadProgress({
      stage,
      localProgress: 100,
      deviceProgress: stage === "done" ? 100 : 0,
      message: `Status: ${deviceMessage}`,
      error: stage === "error" ? deviceMessage : "",
    });

    if (stage === "error" || !transferId) {
      musicUploadTerminalStage = "error";
      if (stage !== "done") {
        triggerMusicUploadFallbackSync();
      }
      setMusicUploadBusy(false);
      if (stage === "done") {
        stopMusicUploadFallbackSync();
        await syncMusicListOnDone("upload_result_done");
      }
    } else if (stage === "done") {
      musicUploadTerminalStage = "done";
      stopMusicUploadFallbackSync();
      setMusicUploadBusy(false);
      await syncMusicListOnDone("upload_result_done");
    } else {
      const ownerSlot = normalizeRobotSlotId(result && result.slot) || getCurrentMusicSlotId();
      startMusicUploadStream(transferId, ownerSlot);
    }
  } catch (error) {
    console.log("upload_music error:", error);
    musicUploadTerminalStage = "error";
    renderMusicUploadProgress({
      stage: "error",
      localProgress: 100,
      deviceProgress: 0,
      message: "Status: upload failed",
      error: error && error.message ? error.message : "Unknown error",
    });
    closeMusicUploadStream();
    triggerMusicUploadFallbackSync();
    alert(error && error.message ? error.message : "Upload failed");
    setMusicUploadBusy(false);
  } finally {
    musicUploadRequestInFlight = false;
    if (UploadMusicInput) UploadMusicInput.value = "";
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

function normalizeStatusText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function rebuildAiAgentIdLabelMap() {
  aiAgentIdLabelMap.clear();
  if (!AiAgentButtons) return;
  AiAgentButtons.querySelectorAll("button[data-id]").forEach((btn) => {
    const id = normalizeStatusText(btn.getAttribute("data-id"));
    if (!id) return;
    const label = normalizeStatusText(btn.textContent) || id;
    aiAgentIdLabelMap.set(id, label);
  });
}

function formatAgentDisplay(agentId) {
  const rawId = normalizeStatusText(agentId);
  if (!rawId) return "--";
  if (aiAgentIdLabelMap.size === 0) {
    rebuildAiAgentIdLabelMap();
  }
  const label = aiAgentIdLabelMap.get(rawId);
  if (label) return label;
  return `未知智能体（${rawId}）`;
}

function getLicenseLangData() {
  return language[currentLanguage] || language.en;
}

function getLicensedAgentCount() {
  const access = licenseStatusState?.agent_access || {};
  return Object.keys(access).filter((id) => !!access[id]).length;
}

function isAgentLicensed(agentId) {
  const id = String(agentId || "").trim();
  if (!id) return false;
  const access = licenseStatusState?.agent_access || {};
  return !!access[id];
}

function resolveLicenseErrorMessage(code, fallbackMessage = "") {
  const langData = getLicenseLangData();
  const key = String(code || "").trim();
  const map = {
    invalid_format: langData.LicenseInvalidFormat,
    invalid_signature: langData.LicenseInvalidSignature,
    expired: langData.LicenseExpired,
    agent_mismatch: langData.LicenseAgentMismatch,
    license_required: langData.LicenseRequired,
    license_runtime_unavailable: langData.LicenseRuntimeUnavailable,
  };
  return map[key] || fallbackMessage || langData.LicenseImportFailed;
}

function updateAiAgentLicenseUi() {
  if (!AiAgentButtons) return;
  AiAgentButtons.querySelectorAll("button[data-id]").forEach((btn) => {
    const id = String(btn.getAttribute("data-id") || "").trim();
    const granted = isAgentLicensed(id);
    btn.classList.toggle("is-locked", !granted);
    btn.setAttribute("data-licensed", granted ? "true" : "false");
  });
}

function updateLicenseStatusUi() {
  const langData = getLicenseLangData();
  if (ParagraphAgentLicense) {
    ParagraphAgentLicense.innerText = langData.ParagraphAgentLicense;
  }
  if (BtnImportLicense) {
    BtnImportLicense.innerText = langData.BtnImportLicense;
  }
  if (LicenseImportTitle) {
    LicenseImportTitle.innerText = langData.LicenseImportTitle;
  }
  if (LicenseImportHint) {
    LicenseImportHint.innerText = langData.LicenseImportHint;
  }
  if (BtnLicenseImportCancel) {
    BtnLicenseImportCancel.innerText = langData.BtnLicenseImportCancel;
  }
  if (BtnLicenseImportChoose) {
    BtnLicenseImportChoose.innerText = langData.BtnLicenseImportChoose;
  }
  if (AgentLicenseStatus) {
    if (!licenseStatusState.loaded) {
      AgentLicenseStatus.innerText = langData.LicenseStatusUnknown;
    } else {
      const count = getLicensedAgentCount();
      if (count <= 0) {
        AgentLicenseStatus.innerText = langData.LicenseStatusUnlicensed;
      } else {
        AgentLicenseStatus.innerText = String(
          langData.LicenseStatusLicensedFmt || "Licensed ({count}/4)"
        ).replace("{count}", String(count));
      }
    }
  }
  if (LicenseImportTargetAgent) {
    const targetName = pendingLicenseAgentId
      ? formatAgentDisplay(pendingLicenseAgentId)
      : "";
    if (targetName) {
      LicenseImportTargetAgent.innerText = String(
        langData.LicenseTargetFmt || "Target agent: {name}"
      ).replace("{name}", targetName);
    } else {
      LicenseImportTargetAgent.innerText =
        langData.LicenseTargetGeneral || "Target agent: general import";
    }
  }
  updateAiAgentLicenseUi();
  if (typeof refreshAboutV2IfVisible === "function") refreshAboutV2IfVisible();
}

async function refreshLicenseStatus(options = {}) {
  const { silent = false } = options || {};
  try {
    const response = await fetch("/api/license/status", { method: "GET" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = resolveLicenseErrorMessage(
        payload?.code,
        payload?.message || `HTTP ${response.status}`
      );
      throw new Error(message);
    }
    const nextAccess = payload?.agent_access || {};
    const normalizedAccess = {};
    if (AiAgentButtons) {
      AiAgentButtons.querySelectorAll("button[data-id]").forEach((btn) => {
        const id = String(btn.getAttribute("data-id") || "").trim();
        if (!id) return;
        normalizedAccess[id] = !!nextAccess[id];
      });
    }
    licenseStatusState = {
      loaded: true,
      licensed: !!payload?.licensed,
      agent_access: normalizedAccess,
      entitlements: payload?.entitlements || { agents: [] },
    };
    updateLicenseStatusUi();
    return payload;
  } catch (error) {
    licenseStatusState = {
      loaded: true,
      licensed: false,
      agent_access: {},
      entitlements: { agents: [] },
    };
    updateLicenseStatusUi();
    if (!silent) {
      alert(resolveLicenseErrorMessage("", error?.message || String(error)));
    }
    return null;
  }
}

function openLicenseImportModal(agentId = "") {
  pendingLicenseAgentId = String(agentId || "").trim();
  updateLicenseStatusUi();
  if (LicenseImportModal) {
    LicenseImportModal.style.display = "block";
  }
}

function closeLicenseImportModal() {
  if (LicenseImportModal) {
    LicenseImportModal.style.display = "none";
  }
  pendingLicenseAgentId = "";
  updateLicenseStatusUi();
}

async function uploadLicenseFile(file) {
  if (!file) {
    alert(getLicenseLangData().LicenseImportNoFile);
    return;
  }
  if (isLicenseImportInFlight) return;
  isLicenseImportInFlight = true;
  if (BtnLicenseImportChoose) {
    BtnLicenseImportChoose.disabled = true;
  }
  if (BtnImportLicense) {
    BtnImportLicense.disabled = true;
  }
  try {
    const formData = new FormData();
    formData.append("license_file", file);
    const response = await fetch("/api/license/import", {
      method: "POST",
      body: formData,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        resolveLicenseErrorMessage(
          payload?.code,
          payload?.message || `HTTP ${response.status}`
        )
      );
    }
    await refreshLicenseStatus({ silent: true });
    alert(getLicenseLangData().LicenseImportSuccess);
    const targetAgent = pendingLicenseAgentId;
    closeLicenseImportModal();
    if (targetAgent && isAgentLicensed(targetAgent)) {
      setAiAgentById(targetAgent);
    }
  } catch (error) {
    alert(
      `${getLicenseLangData().LicenseImportFailed}: ${
        error?.message || String(error)
      }`
    );
  } finally {
    isLicenseImportInFlight = false;
    if (BtnLicenseImportChoose) {
      BtnLicenseImportChoose.disabled = false;
    }
    if (BtnImportLicense) {
      BtnImportLicense.disabled = false;
    }
  }
}

function setAboutDisconnected() {
  if (AboutFirmwareVersion) AboutFirmwareVersion.textContent = "--";
  if (AboutAiAgentStatus) AboutAiAgentStatus.textContent = "--";
}

function updateAboutFromStatus(data) {
  if (!AboutFirmwareVersion || !AboutAiAgentStatus) return;
  if (!data || typeof data !== "object") {
    setAboutDisconnected();
    return;
  }

  const isConnected =
    coerceBoolean(data.is_connected) ||
    coerceBoolean(data.connected) ||
    coerceBoolean(data.isConnected);

  if (!isConnected) {
    setAboutDisconnected();
    return;
  }

  const firmwareVersion = normalizeStatusText(
    data.firmware_version ?? data.firmwareVersion
  );
  const agentId = normalizeStatusText(
    data.agent_id ?? data.agentId ?? data.ai_agent_id ?? data.aiAgentId
  );

  AboutFirmwareVersion.textContent = firmwareVersion || "--";
  AboutAiAgentStatus.textContent = formatAgentDisplay(agentId);
  updateAiAgentButtonState(agentId || "");
}

// ============ Panel About V2 (Multi-robot Master-Detail) ============
function isAboutV2Enabled() {
  return true;
}

const ABOUT_V2_I18N = {
  hant: {
    title: "關於",
    subListFmt: "已連接 {n} 台",
    subDetailFmt: "機位 {slot}",
    emptyTitle: "尚未連接任何機器人",
    emptyHint: "請先喺頂部選擇設備並按連接",
    discText: "未連接機位",
    licenseTitle: "許可證（全機共用一份）",
    licenseLoading: "許可證狀態：讀取中",
    licenseUnlicensed: "未授權（0/4）",
    licenseLicensedFmt: "已授權（{n}/4）",
    licenseCustomerFmt: "客戶：{name}",
    licenseExpiresFmt: "有效期至：{date}",
    licenseImport: "導入許可證",
    rowAddress: "藍牙地址",
    rowFirmware: "固件版本",
    rowLink: "連線品質",
    rowAgent: "當前智能體",
    rowLicense: "許可狀態",
    statusConnected: "已連接",
    statusDisconnected: "未連接",
    statusError: "錯誤",
    linkExcellent: "極佳（{ms} ms）",
    linkGood: "良好（{ms} ms）",
    linkFair: "一般（{ms} ms）",
    linkPoor: "較差（{ms} ms）",
    linkUnknown: "--",
    licAllowed: "✅ 此機位智能體已包含於許可名單",
    licDenied: "⛔ 此機位智能體未獲授權",
    licUnknown: "未知",
    cardSubFmt: "{deviceName}",
    cardOffline: "未連接",
    blockTitle: "修改此機位嘅智能體",
    notice: "⚠ 預覽中：當前操作仍只作用於 Slot A，後端聯通後將改為當前所選機位",
    backLabel: "←",
  },
  hans: {
    title: "关于",
    subListFmt: "已连接 {n} 台",
    subDetailFmt: "机位 {slot}",
    emptyTitle: "尚未连接任何机器人",
    emptyHint: "请先在顶部选择设备并按连接",
    discText: "未连接机位",
    licenseTitle: "许可证（全机共用一份）",
    licenseLoading: "许可证状态：读取中",
    licenseUnlicensed: "未授权（0/4）",
    licenseLicensedFmt: "已授权（{n}/4）",
    licenseCustomerFmt: "客户：{name}",
    licenseExpiresFmt: "有效期至：{date}",
    licenseImport: "导入许可证",
    rowAddress: "蓝牙地址",
    rowFirmware: "固件版本",
    rowLink: "连接质量",
    rowAgent: "当前智能体",
    rowLicense: "许可状态",
    statusConnected: "已连接",
    statusDisconnected: "未连接",
    statusError: "错误",
    linkExcellent: "极佳（{ms} ms）",
    linkGood: "良好（{ms} ms）",
    linkFair: "一般（{ms} ms）",
    linkPoor: "较差（{ms} ms）",
    linkUnknown: "--",
    licAllowed: "✅ 此机位智能体已包含于许可名单",
    licDenied: "⛔ 此机位智能体未获授权",
    licUnknown: "未知",
    cardSubFmt: "{deviceName}",
    cardOffline: "未连接",
    blockTitle: "修改此机位的智能体",
    notice: "⚠ 预览中：当前操作仍只作用于 Slot A，后端联通后将改为当前所选机位",
    backLabel: "←",
  },
  en: {
    title: "About",
    subListFmt: "Connected {n}",
    subDetailFmt: "Slot {slot}",
    emptyTitle: "No robot connected yet",
    emptyHint: "Pick a device at the top and press Connect first",
    discText: "Disconnected slots",
    licenseTitle: "License (shared across all robots)",
    licenseLoading: "License status: loading",
    licenseUnlicensed: "Unlicensed (0/4)",
    licenseLicensedFmt: "Licensed ({n}/4)",
    licenseCustomerFmt: "Customer: {name}",
    licenseExpiresFmt: "Expires: {date}",
    licenseImport: "Import License",
    rowAddress: "BLE address",
    rowFirmware: "Firmware",
    rowLink: "Link quality",
    rowAgent: "Current agent",
    rowLicense: "License",
    statusConnected: "Connected",
    statusDisconnected: "Disconnected",
    statusError: "Error",
    linkExcellent: "Excellent ({ms} ms)",
    linkGood: "Good ({ms} ms)",
    linkFair: "Fair ({ms} ms)",
    linkPoor: "Poor ({ms} ms)",
    linkUnknown: "--",
    licAllowed: "Allowed by current license",
    licDenied: "Not granted by current license",
    licUnknown: "Unknown",
    cardSubFmt: "{deviceName}",
    cardOffline: "Offline",
    blockTitle: "Switch agent for this slot",
    notice: "Preview only: this still affects Slot A only; per-slot will be wired up after backend update",
    backLabel: "←",
  },
};
function aboutV2T() {
  return ABOUT_V2_I18N[currentLanguage] || ABOUT_V2_I18N.hant;
}
function aboutV2Fmt(tpl, vars) {
  if (!tpl) return "";
  return String(tpl).replace(/\{(\w+)\}/g, (_, k) =>
    vars && vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : ""
  );
}

let aboutV2CurrentSlotId = "";
let aboutV2DisclosureExpanded = false;

function aboutV2GetSnapshotSlots() {
  const snap = latestRobotStatusSnapshot;
  if (!snap || !Array.isArray(snap.slots)) return [];
  return snap.slots.slice();
}

function aboutV2GetEffectiveLicenseState() {
  return licenseStatusState;
}

function aboutV2IsSlotConnected(row) {
  if (!row) return false;
  return (
    row.is_connected === true ||
    row.is_connected === "True" ||
    row.is_connected === 1 ||
    row.connected === true ||
    row.connected === "True" ||
    row.connected === 1 ||
    row.isConnected === true ||
    row.isConnected === "True" ||
    row.isConnected === 1
  );
}

function aboutV2DescribeLink(row) {
  const t = aboutV2T();
  const ms =
    row && (row.conn_interval_rx_ms ?? row.connIntervalRxMs ?? row.conn_interval_target_ms ?? row.connIntervalTargetMs);
  const num = typeof ms === "number" ? ms : Number(ms);
  if (!Number.isFinite(num) || num <= 0) return t.linkUnknown;
  const fmt = (k) => aboutV2Fmt(t[k], { ms: num.toFixed(num >= 10 ? 0 : 2) });
  if (num <= 15) return fmt("linkExcellent");
  if (num <= 30) return fmt("linkGood");
  if (num <= 60) return fmt("linkFair");
  return fmt("linkPoor");
}

function aboutV2BatteryText(row) {
  const raw = row && row.battery;
  const n = normalizeBatteryValue(raw);
  if (n === null) return "";
  return `🔋 ${n}%`;
}

function aboutV2GetLicenseAllowedForRow(row) {
  const t = aboutV2T();
  const lic = aboutV2GetEffectiveLicenseState();
  if (!lic || !lic.loaded) return { state: "off", text: t.licUnknown };
  const access = lic.agent_access || {};
  const aid = String((row && (row.agent_id ?? row.agentId)) || "").trim();
  if (!aid) return { state: "off", text: t.licUnknown };
  if (typeof row.license_agent_allowed === "boolean") {
    return row.license_agent_allowed
      ? { state: "ok", text: t.licAllowed }
      : { state: "bad", text: t.licDenied };
  }
  return access[aid]
    ? { state: "ok", text: t.licAllowed }
    : { state: "bad", text: t.licDenied };
}

function aboutV2BuildCard(row, isConnected) {
  const t = aboutV2T();
  const slot = String(row.slot || "").toUpperCase();
  const card = document.createElement("div");
  card.className = "about-v2-card";
  card.dataset.slot = slot;
  card.dataset.status = isConnected ? "connected" : "disconnected";

  const badge = document.createElement("div");
  badge.className = "about-v2-slot-badge";
  badge.textContent = slot || "?";
  card.appendChild(badge);

  const info = document.createElement("div");
  info.className = "about-v2-card-info";
  const name = document.createElement("div");
  name.className = "about-v2-card-name";
  name.textContent = isConnected
    ? row.device_name || row.name || `Slot ${slot}`
    : t.cardOffline;
  info.appendChild(name);

  const sub = document.createElement("div");
  sub.className = "about-v2-card-sub";
  if (isConnected) {
    const bat = aboutV2BatteryText(row);
    if (bat) {
      const span = document.createElement("span");
      span.textContent = bat;
      sub.appendChild(span);
    }
    const lic = aboutV2GetLicenseAllowedForRow(row);
    const dot = document.createElement("span");
    dot.className = "about-v2-license-dot";
    dot.dataset.state = lic.state;
    dot.title = lic.text;
    sub.appendChild(dot);
    const fwSpan = document.createElement("span");
    fwSpan.textContent = String(row.firmware_version || row.firmwareVersion || "");
    if (fwSpan.textContent) sub.appendChild(fwSpan);
  } else {
    const span = document.createElement("span");
    span.textContent = t.cardOffline;
    sub.appendChild(span);
  }
  info.appendChild(sub);
  card.appendChild(info);

  const arrow = document.createElement("div");
  arrow.className = "about-v2-card-arrow";
  arrow.textContent = "›";
  card.appendChild(arrow);

  if (isConnected) {
    card.addEventListener("click", () => setAboutV2View("detail", slot));
  }
  return card;
}

function renderAboutV2List() {
  if (!PanelAboutV2 || !AboutV2List) return;
  const t = aboutV2T();
  if (PanelAboutV2Title) PanelAboutV2Title.textContent = t.title;

  const slots = aboutV2GetSnapshotSlots();
  const connected = slots.filter((r) => aboutV2IsSlotConnected(r));
  const disconnected = slots.filter((r) => !aboutV2IsSlotConnected(r));

  if (PanelAboutV2Sub) {
    PanelAboutV2Sub.textContent = aboutV2Fmt(t.subListFmt, { n: connected.length });
  }

  if (AboutV2CardsConnected) {
    AboutV2CardsConnected.innerHTML = "";
    connected.forEach((row) => {
      AboutV2CardsConnected.appendChild(aboutV2BuildCard(row, true));
    });
  }

  if (AboutV2ListEmpty) {
    AboutV2ListEmpty.style.display = connected.length === 0 ? "" : "none";
    AboutV2ListEmpty.querySelector(".about-v2-empty-title").textContent = t.emptyTitle;
    AboutV2ListEmpty.querySelector(".about-v2-empty-hint").textContent = t.emptyHint;
  }

  if (AboutV2CardsDisconnected) {
    AboutV2CardsDisconnected.innerHTML = "";
    disconnected.forEach((row) => {
      AboutV2CardsDisconnected.appendChild(aboutV2BuildCard(row, false));
    });
    AboutV2CardsDisconnected.style.display = aboutV2DisclosureExpanded && disconnected.length > 0 ? "flex" : "none";
  }

  if (AboutV2Disclosure) {
    AboutV2Disclosure.style.display = disconnected.length > 0 ? "" : "none";
    AboutV2Disclosure.dataset.expanded = aboutV2DisclosureExpanded ? "true" : "false";
    AboutV2Disclosure.querySelector(".about-v2-disclosure-text").textContent = t.discText;
    AboutV2Disclosure.querySelector(".about-v2-disclosure-count").textContent = String(disconnected.length);
  }

  renderAboutV2GlobalLicense();
}

function renderAboutV2GlobalLicense() {
  if (!AboutV2GlobalLicense) return;
  const t = aboutV2T();
  AboutV2GlobalLicense.querySelector(".about-v2-section-title").textContent = t.licenseTitle;
  if (BtnAboutV2ImportLicense) BtnAboutV2ImportLicense.textContent = t.licenseImport;

  const lic = aboutV2GetEffectiveLicenseState();
  if (!lic || !lic.loaded) {
    if (AboutV2LicenseSummary) AboutV2LicenseSummary.textContent = t.licenseLoading;
    if (AboutV2LicenseMeta) AboutV2LicenseMeta.textContent = "";
    return;
  }
  const access = lic.agent_access || {};
  const count = Object.keys(access).filter((k) => !!access[k]).length;
  if (AboutV2LicenseSummary) {
    AboutV2LicenseSummary.textContent =
      count <= 0 ? t.licenseUnlicensed : aboutV2Fmt(t.licenseLicensedFmt, { n: count });
  }
  if (AboutV2LicenseMeta) {
    const lines = [];
    const cust = lic.customer_name || "";
    const exp = lic.expires_at || "";
    if (cust) lines.push(aboutV2Fmt(t.licenseCustomerFmt, { name: cust }));
    if (exp) lines.push(aboutV2Fmt(t.licenseExpiresFmt, { date: exp }));
    AboutV2LicenseMeta.textContent = lines.join("  ·  ");
  }
}

function renderAboutV2Detail(slotId) {
  if (!PanelAboutV2 || !AboutV2Detail) return;
  const sid = String(slotId || aboutV2CurrentSlotId || "").toUpperCase();
  const t = aboutV2T();
  if (PanelAboutV2Title) PanelAboutV2Title.textContent = t.title;

  const slots = aboutV2GetSnapshotSlots();
  const row = slots.find((r) => String(r.slot || "").toUpperCase() === sid);
  if (!row) {
    setAboutV2View("list");
    return;
  }
  aboutV2CurrentSlotId = sid;
  if (typeof setMagosMusicSelectedSlot === "function" && activeRobotSlotIds.includes(sid)) {
    setMagosMusicSelectedSlot(sid, { reason: "aboutv2" });
  }

  if (PanelAboutV2Sub) {
    PanelAboutV2Sub.textContent = aboutV2Fmt(t.subDetailFmt, { slot: sid });
  }

  if (AboutV2DetailTabs) {
    AboutV2DetailTabs.innerHTML = "";
    const connected = slots.filter((r) => aboutV2IsSlotConnected(r));
    if (connected.length > 1) {
      connected.forEach((r) => {
        const sLetter = String(r.slot || "").toUpperCase();
        const tab = document.createElement("button");
        tab.type = "button";
        tab.className = "about-v2-tab";
        tab.textContent = sLetter;
        tab.dataset.active = sLetter === sid ? "true" : "false";
        tab.addEventListener("click", () => renderAboutV2Detail(sLetter));
        AboutV2DetailTabs.appendChild(tab);
      });
    }
  }

  const isConn = aboutV2IsSlotConnected(row);
  if (AboutV2DetailSlotLetter) AboutV2DetailSlotLetter.textContent = sid;
  if (AboutV2DetailDeviceName) {
    AboutV2DetailDeviceName.textContent =
      row.device_name || row.name || `Slot ${sid}`;
  }
  if (AboutV2DetailStatus) {
    AboutV2DetailStatus.textContent = isConn ? t.statusConnected : t.statusDisconnected;
    AboutV2DetailStatus.dataset.state = isConn ? "ok" : "off";
  }
  if (AboutV2DetailBattery) {
    const bat = normalizeBatteryValue(row.battery);
    if (bat === null) {
      AboutV2DetailBattery.textContent = "--";
      AboutV2DetailBattery.dataset.low = "false";
    } else {
      AboutV2DetailBattery.textContent = `🔋 ${bat}%`;
      AboutV2DetailBattery.dataset.low = bat <= BATTERY_LOW_THRESHOLD ? "true" : "false";
    }
  }
  if (AboutV2DetailAddress) {
    AboutV2DetailAddress.textContent = String(row.address || "--").toUpperCase() || "--";
  }
  if (AboutV2DetailFirmware) {
    AboutV2DetailFirmware.textContent =
      String(row.firmware_version || row.firmwareVersion || "") || "--";
  }
  if (AboutV2DetailLink) {
    AboutV2DetailLink.textContent = aboutV2DescribeLink(row);
  }
  if (AboutV2DetailAgent) {
    AboutV2DetailAgent.textContent = formatAgentDisplay(row.agent_id || row.agentId || "");
  }
  if (AboutV2DetailLicense) {
    const lic = aboutV2GetLicenseAllowedForRow(row);
    AboutV2DetailLicense.textContent = lic.text;
  }
  if (AboutV2DetailPreviewNotice) {
    AboutV2DetailPreviewNotice.style.display = "none";
  }

  if (AboutV2DetailAgentButtons) {
    const curAgent = String(row.agent_id || row.agentId || "").trim();
    const lic = aboutV2GetEffectiveLicenseState();
    const access = lic && lic.agent_access ? lic.agent_access : {};
    AboutV2DetailAgentButtons.querySelectorAll("button[data-id]").forEach((btn) => {
      const id = String(btn.getAttribute("data-id") || "").trim();
      btn.dataset.active = id && id === curAgent ? "true" : "false";
      const granted = !!access[id];
      btn.classList.toggle("is-locked", lic && lic.loaded ? !granted : false);
    });
  }

  renderAboutV2GlobalLicense();
}

function setAboutV2View(view, slotId) {
  if (!PanelAboutV2) return;
  if (view === "detail") {
    PanelAboutV2.dataset.view = "detail";
    if (AboutV2List) AboutV2List.style.display = "none";
    if (AboutV2Detail) AboutV2Detail.style.display = "";
    renderAboutV2Detail(slotId || aboutV2CurrentSlotId);
  } else {
    PanelAboutV2.dataset.view = "list";
    if (AboutV2Detail) AboutV2Detail.style.display = "none";
    if (AboutV2List) AboutV2List.style.display = "";
    renderAboutV2List();
  }
}

function refreshAboutV2IfVisible() {
  if (!PanelAboutV2) return;
  if (PanelAboutV2.style.visibility !== "visible") return;
  const view = PanelAboutV2.dataset.view || "list";
  if (view === "detail") renderAboutV2Detail(aboutV2CurrentSlotId);
  else renderAboutV2List();
}

function showAboutV2Panel() {
  if (!PanelAboutV2) return;
  PanelAboutV2.style.visibility = "visible";
  if (PanelAbout) PanelAbout.style.visibility = "hidden";
  setAboutV2View("list");
  refreshLicenseStatus({ silent: true }).then(() => refreshAboutV2IfVisible()).catch(() => {});
}

function hideAboutV2Panel() {
  if (PanelAboutV2) PanelAboutV2.style.visibility = "hidden";
}

if (BtnAboutV2Back) {
  BtnAboutV2Back.addEventListener("click", () => setAboutV2View("list"));
}
if (AboutV2Disclosure) {
  AboutV2Disclosure.addEventListener("click", () => {
    aboutV2DisclosureExpanded = !aboutV2DisclosureExpanded;
    renderAboutV2List();
  });
}
if (BtnAboutV2ImportLicense) {
  BtnAboutV2ImportLicense.addEventListener("click", () => {
    if (typeof openLicenseImportModal === "function") {
      openLicenseImportModal();
    }
  });
}
if (AboutV2DetailAgentButtons) {
  AboutV2DetailAgentButtons.querySelectorAll("button[data-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-id");
      const slot = String(aboutV2CurrentSlotId || "").toUpperCase();
      if (typeof setAiAgentById === "function") setAiAgentById(id, btn, slot);
    });
  });
}
// ============ End Panel About V2 ============

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
  const batteryElement = document.getElementById("BtnBattery");
  if (!batteryElement) return;

  if (!data || typeof data !== "object") {
    setBatteryDisconnected();
    return;
  }

  const connectedBatteries = [];
  if (Array.isArray(data.slots) && data.slots.length > 0) {
    data.slots.forEach((row) => {
      const conn =
        row.is_connected === true ||
        row.is_connected === "True" ||
        row.is_connected === 1 ||
        row.connected === true ||
        row.connected === "True" ||
        row.connected === 1;
      if (!conn) return;
      const bat = normalizeBatteryValue(row.battery);
      if (isValidBatteryValue(bat)) {
        connectedBatteries.push({
          slot: String(row.slot || "").toUpperCase(),
          battery: bat,
        });
      }
    });
  }

  if (connectedBatteries.length === 0) {
    const isConnected = coerceBoolean(data.is_connected) ||
      coerceBoolean(data.connected) ||
      coerceBoolean(data.isConnected);
    if (!isConnected) {
      setBatteryDisconnected();
      return;
    }
    const rawBattery = data.battery;
    const batteryValue = normalizeBatteryValue(rawBattery);
    if (!isValidBatteryValue(batteryValue)) {
      setBatteryDisconnected();
      return;
    }
    setBatteryConnected(batteryValue);
    return;
  }

  if (connectedBatteries.length === 1) {
    setBatteryConnected(connectedBatteries[0].battery);
    return;
  }

  connectedBatteries.sort((a, b) => a.battery - b.battery);
  const lowest = connectedBatteries[0];
  const prefix = (language[currentLanguage] || {}).BatteryLabel || BATTERY_LABEL_PREFIX;
  batteryElement.textContent = `${prefix}${lowest.slot} ${lowest.battery}%`;
  batteryElement.classList.remove("is-muted");
  batteryElement.classList.toggle("is-low", lowest.battery <= BATTERY_LOW_THRESHOLD);
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
      latestRobotStatusSnapshot = data;
      updateAboutFromStatus(data);
      updateBatteryFromStatus(data);
      refreshAboutV2IfVisible();
    })
    .catch((error) => {
      if (error.name === 'AbortError') {
        console.warn("[Battery] Request timeout");
      } else {
        console.error("[Battery] API fetch failed:", error.message);
      }
      setAboutDisconnected();
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
    MAGOS_SERVO_CONTROL_TITLE: "Magos%2旋轉的角度%3",
    MAGOS_LEFT_HAND: "左手",
    MAGOS_LEFT_ARM: "左臂",
    MAGOS_LEFT_SHOULDER: "左肩",
    MAGOS_RIGHT_HAND: "右手",
    MAGOS_RIGHT_ARM: "右臂",
    MAGOS_RIGHT_SHOULDER: "右肩",
    MAGOS_HEADER: "頭部",
    MAGOS_BASE: "底座",
    MAGOS_BODY: "身體",
    MAGOS_ANIMATIONS_START_TITLE: "播放動畫組：%2",
    MAGOS_PLAY_BG_MUSIC_TITLE: "播放背景音樂：%2",
    MAGOS_MUSIC_THREE_PIGS_OPERA: "三隻小豬粵劇",
    MAGOS_STOP_BG_MUSIC_TITLE: "暫停背景音樂",
    MAGOS_CHANGE_EMOJI_TITLE: "變換表情：%2",
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
    MAGOS_SAY_TITLE: "Magos說：%2",
    MAGOS_TEST_TITLE: "Magos测试:%1",
    MAGOS_PAUSE_TITLE: "Magos暂停：%2 s",
    MAGOS_SHORTCUT_ACTION_START_TITLE: "執行快捷鍵動作：%2",
    MAGOS_ARM_TITLE: "%1 arm",
    MAGOS_ARM_LEFT: "left",
    MAGOS_ARM_RIGHT: "right"
  },
  hans: {
    MAGOS_ADD_TEXT: "Add text %1",
    MAGOS_SERVO_CONTROL_TITLE: "Magos%2旋转的角度%3",
    MAGOS_LEFT_HAND: "左手",
    MAGOS_LEFT_ARM: "左臂",
    MAGOS_LEFT_SHOULDER: "左肩",
    MAGOS_RIGHT_HAND: "右手",
    MAGOS_RIGHT_ARM: "右臂",
    MAGOS_RIGHT_SHOULDER: "右肩",
    MAGOS_HEADER: "头部",
    MAGOS_BASE: "底座",
    MAGOS_BODY: "身体",
    MAGOS_ANIMATIONS_START_TITLE: "播放动画组：%2",
    MAGOS_PLAY_BG_MUSIC_TITLE: "播放背景音乐：%2",
    MAGOS_MUSIC_THREE_PIGS_OPERA: "三只小猪粤剧",
    MAGOS_STOP_BG_MUSIC_TITLE: "暂停背景音乐",
    MAGOS_CHANGE_EMOJI_TITLE: "变换表情：%2",
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
    MAGOS_SAY_TITLE: "Magos说：%2",
    MAGOS_TEST_TITLE: "Magos测试:%1",
    MAGOS_PAUSE_TITLE: "Magos暂停：%2 s",
    MAGOS_SHORTCUT_ACTION_START_TITLE: "执行快捷键动作：%2",
    MAGOS_ARM_TITLE: "%1 arm",
    MAGOS_ARM_LEFT: "left",
    MAGOS_ARM_RIGHT: "right"
  },
  en: {
    MAGOS_ADD_TEXT: "Add text %1",
    MAGOS_SERVO_CONTROL_TITLE: "Magos %2 rotate angle %3",
    MAGOS_LEFT_HAND: "Left Hand",
    MAGOS_LEFT_ARM: "Left Arm",
    MAGOS_LEFT_SHOULDER: "Left Shoulder",
    MAGOS_RIGHT_HAND: "Right Hand",
    MAGOS_RIGHT_ARM: "Right Arm",
    MAGOS_RIGHT_SHOULDER: "Right Shoulder",
    MAGOS_HEADER: "Head",
    MAGOS_BASE: "Base",
    MAGOS_BODY: "Body",
    MAGOS_ANIMATIONS_START_TITLE: "Play Animation Group: %2",
    MAGOS_PLAY_BG_MUSIC_TITLE: "Play Background Music: %2",
    MAGOS_MUSIC_THREE_PIGS_OPERA: "Three Little Pigs Opera",
    MAGOS_STOP_BG_MUSIC_TITLE: "Stop Background Music",
    MAGOS_CHANGE_EMOJI_TITLE: "Change Emoji: %2",
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
    MAGOS_SAY_TITLE: "Magos Say: %2",
    MAGOS_TEST_TITLE: "Magos Test: %1",
    MAGOS_PAUSE_TITLE: "Magos Pause: %2 s",
    MAGOS_SHORTCUT_ACTION_START_TITLE: "Run Shortcut Action: %2",
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
  if (typeof window._onRobotSlotLanguageChanged === "function") {
    window._onRobotSlotLanguageChanged();
  }
  if (typeof window._onBatteryDisplayLanguageChanged === "function") {
    window._onBatteryDisplayLanguageChanged();
  }
  if (typeof refreshOtaSlotSelector === "function") {
    refreshOtaSlotSelector();
  }
  if (typeof refreshAboutV2IfVisible === "function") {
    refreshAboutV2IfVisible();
  }
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
  setInnerTextIf(ExportNameTitle, language[currentLanguage]["ExportNameDialogTitle"]);
  setInnerTextIf(BtnExportNameCancel, language[currentLanguage]["BtnExportNameCancel"]);
  setInnerTextIf(BtnExportNameConfirm, language[currentLanguage]["BtnExportNameConfirm"]);
  setAttributeIf(
    ExportNameInput,
    "placeholder",
    language[currentLanguage]["ExportNamePlaceholder"]
  );
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
  setActionGroupStaticTexts();
  renderActionGroupUserList();

  setAttributeIf(BtnShortcutMapping, "title", language[currentLanguage].BtnShortcutMapping);
  setAttributeIf(BtnShortcutMapping, "aria-label", language[currentLanguage].BtnShortcutMapping);
  setInnerTextIf(ShortcutActionTitle, language[currentLanguage].ShortcutActionTitle);
  setInnerTextIf(ShortcutActionCaptureLabel, language[currentLanguage].ShortcutActionCaptureLabel);
  setInnerTextIf(ShortcutActionNameLabel, language[currentLanguage].ShortcutActionNameLabel);
  setInnerTextIf(ShortcutActionSummaryTitle, language[currentLanguage].ShortcutActionSummaryTitle);
  setInnerTextIf(ShortcutActionSavedTitle, language[currentLanguage].ShortcutActionSavedTitle);
  setInnerTextIf(BtnShortcutActionConfirm, language[currentLanguage].BtnShortcutActionConfirm);
  setInnerTextIf(ShortcutConfirmTitle, language[currentLanguage].ShortcutConfirmTitle);
  setInnerTextIf(BtnShortcutConfirmYes, language[currentLanguage].ShortcutConfirmYes);
  setInnerTextIf(BtnShortcutConfirmNo, language[currentLanguage].ShortcutConfirmNo);
  setInnerTextIf(ShortcutSidebarTitle, language[currentLanguage].ShortcutSidebarTitle);
  setAttributeIf(
    ShortcutActionNameInput,
    "placeholder",
    language[currentLanguage].ShortcutActionNamePlaceholder
  );
  updateShortcutCaptureUI();
  if (shortcutPendingConfirmEvent) {
    setInnerTextIf(
      ShortcutConfirmMessage,
      formatShortcutConfirmMessage(shortcutPendingConfirmEvent)
    );
  }
  refreshShortcutListsUI();
  updateLicenseStatusUi();
  
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
    targetConnectDevice = null;
    return;
  }
  const selected = bleDiscoveredDeviceMap.get(targetdevice);
  if (selected) {
    targetConnectDevice = {
      address: selected.address || "",
      name: selected.name || "",
      display_name: selected.display_name || "",
    };
    return;
  }
  targetConnectDevice = {
    address: targetdevice,
    name: targetdevice,
    display_name: targetdevice,
  };
}

function resetDeviceListSelection() {
  if (DeviceList.options.length === 0) return;
  if (DeviceList.selectedIndex === 0) {
    targetConnectDevice = null;
    return;
  }
  while (DeviceList.selectedIndex !== 0) {
    BtnDeviceSelectLeft.click();
  }
  targetConnectDevice = null;
}


function animateDeviceScanButton(timeoutMs = 700) {
  if (!BtnDeviceScan) return Promise.resolve();
  if (isDeviceScanAnimating) return Promise.resolve();

  isDeviceScanAnimating = true;
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      isDeviceScanAnimating = false;
      BtnDeviceScan.classList.remove("BtnDeviceScan--rotating");
      BtnDeviceScan.removeEventListener("animationend", onAnimationEnd);
      clearTimeout(fallbackTimer);
      resolve();
    };
    const onAnimationEnd = () => {
      finish();
    };
    const fallbackTimer = setTimeout(finish, Math.max(300, Number(timeoutMs) || 700));

    BtnDeviceScan.classList.remove("BtnDeviceScan--rotating");
    void BtnDeviceScan.offsetWidth;
    BtnDeviceScan.addEventListener("animationend", onAnimationEnd, { once: true });
    BtnDeviceScan.classList.add("BtnDeviceScan--rotating");
  });
}

async function onDeviceScanClick() {
  animateDeviceScanButton();
  await runBleScan({
    source: "manual",
    resetSelection: true,
    showNoDevicePrompt: true,
    silentError: false,
  });
}

function initBleAutoScanVisibilityObserver() {
  if (!PanelConnect || typeof MutationObserver === "undefined") return;
  let lastVisible = isConnectPanelVisible();

  syncBleAutoScanState({ triggerImmediate: lastVisible });

  const observer = new MutationObserver(() => {
    const nowVisible = isConnectPanelVisible();
    if (nowVisible === lastVisible) return;
    lastVisible = nowVisible;
    syncBleAutoScanState({ triggerImmediate: nowVisible });
  });

  observer.observe(PanelConnect, {
    attributes: true,
    attributeFilter: ["style", "class"],
  });
}

//#endregion

// UI对象事件注册
ws.addChangeListener((e) => {
  if (e.isUiEvent) return;
  ShowCode(e);
  save(ws);
  if (ShortcutActionModal && ShortcutActionModal.style.display !== "none") {
    renderCurrentShortcutSummary();
  }
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
    PanelAbout.style.visibility = "hidden";
    hideAboutV2Panel();
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
    PanelAbout.style.visibility = "hidden";
    hideAboutV2Panel();
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
    PanelAbout.style.visibility = "hidden";
    hideAboutV2Panel();
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
    PanelAbout.style.visibility = "hidden";
    hideAboutV2Panel();
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
    PanelAbout.style.visibility = "hidden";
    hideAboutV2Panel();
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
    PanelAbout.style.visibility = "hidden";
    hideAboutV2Panel();
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
    PanelAbout.style.visibility = "hidden";
    hideAboutV2Panel();
    return;
  }
  PanelNetwork.style.visibility = "hidden";
});

BtnAbout.addEventListener("click", () => {
  if (isAboutV2Enabled() && PanelAboutV2) {
    if (PanelAboutV2.style.visibility === "hidden") {
      PanelNetwork.style.visibility = "hidden";
      PanelHelp.style.visibility = "hidden";
      PanelExport.style.visibility = "hidden";
      PanelImport.style.visibility = "hidden";
      PanelInterface.style.visibility = "hidden";
      PanelWindow.style.visibility = "hidden";
      PanelConnect.style.visibility = "hidden";
      PanelAbout.style.visibility = "hidden";
      showAboutV2Panel();
      return;
    }
    hideAboutV2Panel();
    return;
  }
  if (PanelAbout.style.visibility === "hidden") {
    PanelAbout.style.visibility = "visible";
    PanelNetwork.style.visibility = "hidden";
    PanelHelp.style.visibility = "hidden";
    PanelExport.style.visibility = "hidden";
    PanelImport.style.visibility = "hidden";
    PanelInterface.style.visibility = "hidden";
    PanelWindow.style.visibility = "hidden";
    PanelConnect.style.visibility = "hidden";
    hideAboutV2Panel();
    return;
  }
  PanelAbout.style.visibility = "hidden";
});

function clampServoUiValue(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 90;
  return Math.max(0, Math.min(180, Math.round(num)));
}

function getActionGroupLangData() {
  return language[currentLanguage] || language.en;
}

function setActionGroupStaticTexts() {
  const langData = getActionGroupLangData();
  setInnerTextIf(
    BtnActionGroupPanel,
    langData.BtnActionGroupPanel || language.en.BtnActionGroupPanel
  );
  setInnerTextIf(
    ActionGroupTitle,
    langData.ActionGroupTitle || language.en.ActionGroupTitle
  );
  setInnerTextIf(
    ActionGroupNameLabel,
    langData.ActionGroupNameLabel || language.en.ActionGroupNameLabel
  );
  setInnerTextIf(
    BtnActionGroupConfirm,
    langData.BtnActionGroupConfirm || language.en.BtnActionGroupConfirm
  );
  setInnerTextIf(
    ActionGroupUserListTitle,
    langData.ActionGroupUserListTitle || language.en.ActionGroupUserListTitle
  );
  setAttributeIf(
    ActionGroupNameInput,
    "placeholder",
    langData.ActionGroupNamePlaceholder || language.en.ActionGroupNamePlaceholder
  );
}

function renderActionGroupUserList() {
  if (!ActionGroupUserList) return;
  ActionGroupUserList.innerHTML = "";
  const langData = getActionGroupLangData();

  const createEmptyNode = (text) => {
    const emptyNode = document.createElement("div");
    emptyNode.className = "action-group-user-empty";
    emptyNode.textContent = String(text || "");
    return emptyNode;
  };

  if (actionGroupUserListLoading) {
    ActionGroupUserList.appendChild(
      createEmptyNode(
        langData.ActionGroupUserListLoading || language.en.ActionGroupUserListLoading
      )
    );
    return;
  }

  if (!Array.isArray(actionGroupUserItems) || actionGroupUserItems.length === 0) {
    ActionGroupUserList.appendChild(
      createEmptyNode(
        langData.ActionGroupUserListEmpty || language.en.ActionGroupUserListEmpty
      )
    );
    return;
  }

  actionGroupUserItems.forEach((item) => {
    const actionId = String(item?.id || "").trim();
    if (!actionId) return;
    const displayName = String(item?.name || actionId).trim() || actionId;

    const row = document.createElement("div");
    row.className = "action-group-user-item";

    const nameNode = document.createElement("div");
    nameNode.className = "action-group-user-name";
    nameNode.textContent = displayName;
    nameNode.title = actionId;

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "action-group-user-delete";
    delBtn.textContent =
      langData.ActionGroupDeleteButton || language.en.ActionGroupDeleteButton;
    delBtn.disabled = actionGroupDeleteRequestInFlightId === actionId;
    delBtn.addEventListener("click", () => {
      deleteUserActionGroup(actionId, displayName);
    });

    row.appendChild(nameNode);
    row.appendChild(delBtn);
    ActionGroupUserList.appendChild(row);
  });
}

async function loadUserActionGroups() {
  actionGroupUserListLoading = true;
  renderActionGroupUserList();

  try {
    const response = await fetch("/api/action_group/user_list", { method: "GET" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.status !== "success") {
      throw new Error(payload.message || `HTTP ${response.status}`);
    }
    const nextItems = Array.isArray(payload.items) ? payload.items : [];
    actionGroupUserItems = nextItems
      .map((item) => {
        const actionId = String(item?.id || "").trim();
        if (!actionId) return null;
        const displayName = String(item?.name || actionId).trim() || actionId;
        const createdAt = Number(item?.created_at || 0);
        return { id: actionId, name: displayName, created_at: createdAt };
      })
      .filter(Boolean);
  } catch (error) {
    console.warn("Load user action groups failed:", error);
    actionGroupUserItems = [];
  } finally {
    actionGroupUserListLoading = false;
    renderActionGroupUserList();
  }
}

async function deleteUserActionGroup(actionId, actionName) {
  const targetId = String(actionId || "").trim();
  if (!targetId || actionGroupDeleteRequestInFlightId) return;

  const langData = getActionGroupLangData();
  const displayName = String(actionName || targetId).trim() || targetId;
  const confirmTemplate =
    langData.ActionGroupDeleteConfirm || language.en.ActionGroupDeleteConfirm;
  const confirmText = String(confirmTemplate || "")
    .replace("{name}", displayName)
    .replace("[动作组名称]", displayName);
  if (!window.confirm(confirmText)) {
    return;
  }

  actionGroupDeleteRequestInFlightId = targetId;
  renderActionGroupUserList();

  try {
    const response = await fetch(
      `/api/action_group/${encodeURIComponent(targetId)}`,
      { method: "DELETE" }
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.status !== "success") {
      throw new Error(payload.message || `HTTP ${response.status}`);
    }
    try {
      await refreshActionOptionsData();
    } catch (refreshError) {
      console.warn("refreshActionOptionsData after delete failed:", refreshError);
    }
    await loadUserActionGroups();
    alert(langData.ActionGroupDeleteSuccess || language.en.ActionGroupDeleteSuccess);
  } catch (error) {
    console.error("Delete action group failed:", error);
    alert(
      `${langData.ActionGroupDeleteFailed || language.en.ActionGroupDeleteFailed}: ${
        error.message || error
      }`
    );
  } finally {
    if (actionGroupDeleteRequestInFlightId === targetId) {
      actionGroupDeleteRequestInFlightId = "";
      renderActionGroupUserList();
    }
  }
}

function ensureActionGroupHintNode() {
  if (!ActionGroupBody) return null;
  let hintNode = document.getElementById(ACTION_GROUP_HINT_ID);
  if (!hintNode) {
    hintNode = document.createElement("div");
    hintNode.id = ACTION_GROUP_HINT_ID;
    hintNode.style.padding = "8px 10px";
    hintNode.style.marginBottom = "8px";
    hintNode.style.fontSize = "13px";
    hintNode.style.fontWeight = "600";
    hintNode.style.borderRadius = "6px";
    hintNode.style.display = "none";
    ActionGroupBody.prepend(hintNode);
  }
  return hintNode;
}

function clearActionGroupHint() {
  const hintNode = document.getElementById(ACTION_GROUP_HINT_ID);
  if (!hintNode) return;
  hintNode.textContent = "";
  hintNode.style.display = "none";
}

function showActionGroupHint(text, mode = "info") {
  const hintNode = ensureActionGroupHintNode();
  if (!hintNode || !text) return;
  hintNode.textContent = String(text);
  if (mode === "error") {
    hintNode.style.background = "rgba(198, 40, 40, 0.12)";
    hintNode.style.color = "#b71c1c";
  } else if (mode === "warn") {
    hintNode.style.background = "rgba(245, 124, 0, 0.12)";
    hintNode.style.color = "#e65100";
  } else {
    hintNode.style.background = "rgba(30, 136, 229, 0.12)";
    hintNode.style.color = "#0d47a1";
  }
  hintNode.style.display = "block";
}

function setActionGroupInputsDisabled(disabled) {
  ACTION_GROUP_SERVO_BINDINGS.forEach(({ inputEl }) => {
    if (inputEl) inputEl.disabled = Boolean(disabled);
  });
}

function refreshActionGroupConfirmDisabled() {
  if (!BtnActionGroupConfirm) return;
  BtnActionGroupConfirm.disabled =
    isActionGroupSaveRequestInFlight ||
    isActionGroupPoseLoading ||
    !isActionGroupPreviewAllowed;
}

function resetActionGroupPreviewState() {
  isActionGroupPreviewAllowed = true;
  actionGroupPreviewNeedBleShown = false;
  actionGroupPreviewErrorShown = false;
  actionGroupPreviewSending = false;
  if (actionGroupPreviewFlushTimer) {
    clearTimeout(actionGroupPreviewFlushTimer);
    actionGroupPreviewFlushTimer = null;
  }
  actionGroupPreviewPendingByServo.clear();
  actionGroupLastPreviewAngleByServo.clear();
  refreshActionGroupConfirmDisabled();
}

function syncActionServoLabel(inputEl, valueEl) {
  if (!inputEl || !valueEl) return;
  valueEl.textContent = String(clampServoUiValue(inputEl.value));
}

function markActionGroupPreviewDisconnected() {
  const langData = getActionGroupLangData();
  isActionGroupPreviewAllowed = false;
  setActionGroupInputsDisabled(true);
  refreshActionGroupConfirmDisabled();
  showActionGroupHint(
    langData.ActionGroupPreviewNeedBle || language.en.ActionGroupPreviewNeedBle,
    "error"
  );
  if (!actionGroupPreviewNeedBleShown) {
    actionGroupPreviewNeedBleShown = true;
    alert(
      langData.ActionGroupPreviewNeedBle || language.en.ActionGroupPreviewNeedBle
    );
  }
}

function markActionGroupPreviewSendFailed() {
  const langData = getActionGroupLangData();
  showActionGroupHint(
    langData.ActionGroupPreviewSendFailed || language.en.ActionGroupPreviewSendFailed,
    "warn"
  );
  if (actionGroupPreviewErrorShown) return;
  actionGroupPreviewErrorShown = true;
  alert(
    langData.ActionGroupPreviewSendFailed || language.en.ActionGroupPreviewSendFailed
  );
}

async function flushActionGroupPreviewMoves() {
  actionGroupPreviewFlushTimer = null;
  if (!isActionGroupPreviewAllowed) return;
  if (actionGroupPreviewSending) {
    actionGroupPreviewFlushTimer = setTimeout(
      flushActionGroupPreviewMoves,
      ACTION_GROUP_PREVIEW_THROTTLE_MS
    );
    return;
  }

  const entries = Array.from(actionGroupPreviewPendingByServo.entries());
  if (!entries.length) return;

  const [servoKey, angle] = entries[entries.length - 1];
  actionGroupPreviewPendingByServo.delete(servoKey);

  actionGroupPreviewSending = true;
  try {
    const res = await fetch("/api/action_group/preview_servo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ servo: servoKey, angle }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.status !== "success") {
      const error = new Error(data.message || `HTTP ${res.status}`);
      error.status = res.status;
      throw error;
    }
    actionGroupLastPreviewAngleByServo.set(servoKey, angle);
    clearActionGroupHint();
  } catch (error) {
    console.warn("ActionGroup preview send failed:", error);
    if (Number(error?.status) === 409) {
      markActionGroupPreviewDisconnected();
    } else {
      markActionGroupPreviewSendFailed();
    }
  } finally {
    actionGroupPreviewSending = false;
    if (actionGroupPreviewPendingByServo.size > 0) {
      actionGroupPreviewFlushTimer = setTimeout(
        flushActionGroupPreviewMoves,
        ACTION_GROUP_PREVIEW_THROTTLE_MS
      );
    }
  }
}

function scheduleActionGroupPreviewMove(servoKey, angleValue) {
  if (!isActionGroupPreviewAllowed || isActionGroupPoseLoading) return;
  const angle = clampServoUiValue(angleValue);
  const lastAngle = actionGroupLastPreviewAngleByServo.get(servoKey);
  if (lastAngle === angle) return;
  if (actionGroupPreviewPendingByServo.get(servoKey) === angle) return;

  actionGroupPreviewPendingByServo.set(servoKey, angle);
  if (actionGroupPreviewFlushTimer) return;
  actionGroupPreviewFlushTimer = setTimeout(
    flushActionGroupPreviewMoves,
    ACTION_GROUP_PREVIEW_THROTTLE_MS
  );
}

function bindActionServoInput(servoKey, inputEl, valueEl) {
  if (!inputEl || !valueEl) return;
  syncActionServoLabel(inputEl, valueEl);
  inputEl.addEventListener("input", () => {
    syncActionServoLabel(inputEl, valueEl);
    scheduleActionGroupPreviewMove(servoKey, inputEl.value);
  });
}

function resetActionGroupForm() {
  ACTION_GROUP_SERVO_BINDINGS.forEach(({ key, inputEl, valueEl }) => {
    if (inputEl) inputEl.value = "90";
    if (valueEl) valueEl.textContent = "90";
    actionGroupLastPreviewAngleByServo.set(key, 90);
  });
  if (ActionGroupNameInput) ActionGroupNameInput.value = "";
  actionGroupPreviewPendingByServo.clear();
}

function applyActionGroupPoseToUi(servos) {
  ACTION_GROUP_SERVO_BINDINGS.forEach(({ key, inputEl, valueEl }) => {
    if (!inputEl) return;
    const poseValue = clampServoUiValue(servos?.[key]);
    inputEl.value = String(poseValue);
    syncActionServoLabel(inputEl, valueEl);
    actionGroupLastPreviewAngleByServo.set(key, poseValue);
  });
}

async function fetchActionGroupCurrentPose() {
  const response = await fetch("/api/action_group/current_pose", { method: "GET" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.status !== "success") {
    const error = new Error(payload.message || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  if (!payload.servos || typeof payload.servos !== "object") {
    throw new Error("Invalid current pose payload");
  }
  return payload;
}

async function openActionGroupModal() {
  if (!ActionGroupModal) return;
  const bleConnected = await ensureBleConnectedForActionGroup();
  if (!bleConnected) return;

  setActionGroupStaticTexts();
  resetActionGroupPreviewState();
  clearActionGroupHint();
  void loadUserActionGroups();

  if (PanelNetwork) PanelNetwork.style.visibility = "hidden";
  if (PanelHelp) PanelHelp.style.visibility = "hidden";
  if (PanelExport) PanelExport.style.visibility = "hidden";
  if (PanelImport) PanelImport.style.visibility = "hidden";
  if (PanelInterface) PanelInterface.style.visibility = "hidden";
  if (PanelWindow) PanelWindow.style.visibility = "hidden";
  if (PanelConnect) PanelConnect.style.visibility = "hidden";
  if (PanelAbout) PanelAbout.style.visibility = "hidden";
  hideAboutV2Panel();
  ActionGroupModal.style.display = "block";

  const langData = getActionGroupLangData();
  isActionGroupPoseLoading = true;
  setActionGroupInputsDisabled(true);
  refreshActionGroupConfirmDisabled();
  showActionGroupHint(
    langData.ActionGroupLoadingPose || language.en.ActionGroupLoadingPose,
    "info"
  );
  try {
    const posePayload = await fetchActionGroupCurrentPose();
    applyActionGroupPoseToUi(posePayload.servos || {});
    if (String(posePayload.source || "").toLowerCase() === "cache") {
      showActionGroupHint(
        langData.ActionGroupPoseFallbackCache ||
          language.en.ActionGroupPoseFallbackCache,
        "warn"
      );
    } else {
      clearActionGroupHint();
    }
  } catch (error) {
    console.warn("Load current pose failed:", error);
    if (Number(error?.status) === 409) {
      markActionGroupPreviewDisconnected();
    } else {
      showActionGroupHint(
        langData.ActionGroupPoseFallbackCache ||
          language.en.ActionGroupPoseFallbackCache,
        "warn"
      );
    }
    ACTION_GROUP_SERVO_BINDINGS.forEach(({ key, inputEl, valueEl }) => {
      if (!inputEl) return;
      syncActionServoLabel(inputEl, valueEl);
      actionGroupLastPreviewAngleByServo.set(key, clampServoUiValue(inputEl.value));
    });
  } finally {
    isActionGroupPoseLoading = false;
    setActionGroupInputsDisabled(!isActionGroupPreviewAllowed);
    refreshActionGroupConfirmDisabled();
  }
}

function closeActionGroupModal() {
  if (!ActionGroupModal || isActionGroupSaveRequestInFlight) return;
  ActionGroupModal.style.display = "none";
  clearActionGroupHint();
  if (actionGroupPreviewFlushTimer) {
    clearTimeout(actionGroupPreviewFlushTimer);
    actionGroupPreviewFlushTimer = null;
  }
  actionGroupPreviewPendingByServo.clear();
}

async function ensureBleConnectedForActionGroup() {
  const langData = getActionGroupLangData();
  try {
    const response = await fetch("/api/status", { method: "GET" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const json = await response.json().catch(() => ({}));
    const data =
      json && typeof json === "object" && "data" in json ? json.data : json;
    const isConnected =
      coerceBoolean(data?.is_connected) ||
      coerceBoolean(data?.connected) ||
      coerceBoolean(data?.isConnected);

    if (!isConnected) {
      alert(langData.ActionGroupNeedBle || language.en.ActionGroupNeedBle);
      return false;
    }
    return true;
  } catch (error) {
    console.warn("ActionGroup BLE precheck failed:", error);
    alert(langData.ActionGroupNeedBle || language.en.ActionGroupNeedBle);
    return false;
  }
}

function buildActionGroupPayload() {
  return {
    name: (ActionGroupNameInput?.value || "").trim(),
    duration: 1.0,
    servos: {
      left_shoulder: clampServoUiValue(ActionServoLeftShoulder?.value),
      left_arm: clampServoUiValue(ActionServoLeftArm?.value),
      left_hand: clampServoUiValue(ActionServoLeftHand?.value),
      right_shoulder: clampServoUiValue(ActionServoRightShoulder?.value),
      right_arm: clampServoUiValue(ActionServoRightArm?.value),
      right_hand: clampServoUiValue(ActionServoRightHand?.value),
    },
  };
}

async function saveActionGroup() {
  if (isActionGroupSaveRequestInFlight) return;
  if (isActionGroupPoseLoading) return;
  const langData = getActionGroupLangData();
  if (!isActionGroupPreviewAllowed) {
    alert(
      langData.ActionGroupPreviewNeedBle || language.en.ActionGroupPreviewNeedBle
    );
    return;
  }
  const bleConnected = await ensureBleConnectedForActionGroup();
  if (!bleConnected) return;

  const payload = buildActionGroupPayload();
  if (!payload.name) {
    alert(langData.ActionGroupNameRequired || language.en.ActionGroupNameRequired);
    return;
  }

  isActionGroupSaveRequestInFlight = true;
  refreshActionGroupConfirmDisabled();
  try {
    const res = await fetch("/api/action_group/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.status !== "success") {
      throw new Error(data.message || `HTTP ${res.status}`);
    }
    try {
      await refreshActionOptionsData();
    } catch (refreshError) {
      console.warn("refreshActionOptionsData failed:", refreshError);
    }
    await loadUserActionGroups();
    alert(langData.ActionGroupSaved || language.en.ActionGroupSaved);
    resetActionGroupForm();
    closeActionGroupModal();
  } catch (error) {
    console.error("Save action group failed:", error);
    alert(
      `${langData.ActionGroupSaveFailed || language.en.ActionGroupSaveFailed}: ${
        error.message || error
      }`
    );
  } finally {
    isActionGroupSaveRequestInFlight = false;
    refreshActionGroupConfirmDisabled();
  }
}

function updateAiAgentButtonState(agentId) {
  if (!AiAgentButtons) return;
  const activeId = String(agentId || "");
  AiAgentButtons.querySelectorAll("button").forEach((btn) => {
    const pressed = btn.getAttribute("data-id") === activeId;
    btn.setAttribute("aria-pressed", pressed ? "true" : "false");
    btn.classList.toggle("is-active", pressed);
  });
  updateAiAgentLicenseUi();
}

async function setAiAgentById(agentId, sourceButton = null, slotId = null) {
  if (!agentId || isSetAiAgentRequestInFlight) return;
  if (!isAgentLicensed(agentId)) {
    openLicenseImportModal(agentId);
    return;
  }
  isSetAiAgentRequestInFlight = true;
  if (sourceButton) sourceButton.disabled = true;

  try {
    const payload = { agent_id: String(agentId) };
    const slot = String(slotId || "").trim().toUpperCase();
    if (slot) payload.slot = slot;
    const res = await fetch("/api/agent/set", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.status !== "success") {
      const error = new Error(data.message || `HTTP ${res.status}`);
      error.code = data.code || "";
      throw error;
    }
    const resolvedAgentId = String(data.agent_id || data.agentId || agentId);
    if (AboutAiAgentStatus) {
      AboutAiAgentStatus.textContent = formatAgentDisplay(resolvedAgentId);
    }
    updateAiAgentButtonState(resolvedAgentId);
    syncBLEStatusWithBackend();
  } catch (error) {
    console.error("Set AI agent failed:", error);
    if (String(error?.code || "").trim() === "license_required") {
      await refreshLicenseStatus({ silent: true });
      openLicenseImportModal(agentId);
      return;
    }
    alert(`设置智能体失败: ${error.message || error}`);
  } finally {
    isSetAiAgentRequestInFlight = false;
    if (sourceButton) sourceButton.disabled = false;
  }
}

const aiAgentButtonList = [
  BtnAiCantonese,
  BtnAiReadingCantonese,
  BtnAiReadingEnglish,
  BtnAiReadingMandarin,
].filter(Boolean);
rebuildAiAgentIdLabelMap();
aiAgentButtonList.forEach((btn) => {
  btn.addEventListener("click", () => {
    const id = btn.getAttribute("data-id");
    setAiAgentById(id, btn);
  });
});
if (BtnImportLicense) {
  BtnImportLicense.addEventListener("click", () => {
    openLicenseImportModal();
  });
}
if (BtnLicenseImportCancel) {
  BtnLicenseImportCancel.addEventListener("click", () => {
    closeLicenseImportModal();
  });
}
if (LicenseImportMask) {
  LicenseImportMask.addEventListener("click", () => {
    closeLicenseImportModal();
  });
}
if (BtnLicenseImportChoose) {
  BtnLicenseImportChoose.addEventListener("click", () => {
    if (LicenseFileInput) {
      LicenseFileInput.click();
    } else {
      alert(getLicenseLangData().LicenseImportNoFile);
    }
  });
}
if (LicenseFileInput) {
  LicenseFileInput.addEventListener("change", (event) => {
    const file = event?.target?.files?.[0];
    if (event?.target) {
      event.target.value = "";
    }
    if (!file) return;
    uploadLicenseFile(file);
  });
}

if (BtnActionGroupPanel) {
  BtnActionGroupPanel.addEventListener("click", openActionGroupModal);
}
if (BtnActionGroupClose) {
  BtnActionGroupClose.addEventListener("click", closeActionGroupModal);
}
if (ActionGroupMask) {
  ActionGroupMask.addEventListener("click", closeActionGroupModal);
}
if (BtnActionGroupConfirm) {
  BtnActionGroupConfirm.addEventListener("click", saveActionGroup);
}
if (ActionGroupNameInput) {
  ActionGroupNameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      saveActionGroup();
    }
  });
}
ACTION_GROUP_SERVO_BINDINGS.forEach(({ key, inputEl, valueEl }) =>
  bindActionServoInput(key, inputEl, valueEl)
);

function normalizeOtaStatus(status) {
  const raw = String(status || "").trim().toLowerCase();
  if (raw === "success") return "done";
  if (raw === "failed") return "error";
  if (raw === "starting") return "starting";
  if (raw === "downloading") return "downloading";
  if (raw === "transferring" || raw === "uploading") return "transferring";
  if (raw === "done") return "done";
  if (raw === "error") return "error";
  return "starting";
}

function isOtaRunningStatus(status) {
  return ["starting", "downloading", "transferring"].includes(
    normalizeOtaStatus(status)
  );
}

function closeOtaEventStream() {
  if (otaEventSource) {
    otaEventSource.close();
    otaEventSource = null;
  }
  stopOtaStatusFallbackPoll();
}

function clearOtaSessionRef() {
  otaCurrentSessionId = "";
  closeOtaEventStream();
}

function resetOtaStateBeforeStart() {
  closeOtaEventStream();
  otaCurrentSessionId = "";
  resetOtaProgressUi();
  if (OtaProgressOverlay) OtaProgressOverlay.style.display = "none";
}

function resetOtaProgressUi() {
  if (OtaProgressTitle) OtaProgressTitle.textContent = "固件更新中";
  if (OtaProgressText) OtaProgressText.textContent = "正在傳輸固件，請勿關閉電源...";
  if (OtaProgressBarFill) {
    OtaProgressBarFill.style.width = "0%";
    OtaProgressBarFill.style.background = "#4CAF50";
  }
  if (OtaProgressPercent) OtaProgressPercent.textContent = "0%";
  if (BtnOtaDone) BtnOtaDone.style.display = "none";
  if (CloudUpdateStatus) {
    CloudUpdateStatus.textContent = "正在更新中，請勿關閉電源或斷開連接...";
  }
  if (CloudUpdateSpinner) CloudUpdateSpinner.style.display = "block";
}

function stopOtaStatusFallbackPoll() {
  if (otaStatusFallbackTimer) {
    clearInterval(otaStatusFallbackTimer);
    otaStatusFallbackTimer = null;
  }
  otaStatusFallbackSessionId = "";
  otaStatusFallbackFailCount = 0;
}

function finalizeOtaUiByTerminalStatus(status) {
  const normalizedStatus = normalizeOtaStatus(status);
  if (normalizedStatus === "done" || normalizedStatus === "error") {
    closeOtaEventStream();
  }
}

function closeOtaOverlay() {
  clearOtaSessionRef();
  resetOtaProgressUi();
  if (OtaProgressOverlay) OtaProgressOverlay.style.display = "none";
  if (CloudUpdateModal) CloudUpdateModal.style.display = "none";
  if (UpdateSelectionMode) UpdateSelectionMode.style.display = "block";
  if (UpdateProgressMode) UpdateProgressMode.style.display = "none";
}

function renderOtaProgressState(payload) {
  if (!payload || String(payload.session_id || "") !== otaCurrentSessionId) return;

  const status = normalizeOtaStatus(payload.status);
  let progress = Number(payload.progress);
  if (!Number.isFinite(progress)) progress = 0;
  progress = Math.max(0, Math.min(100, progress));
  if (status === "done") progress = 100;

  if (OtaProgressBarFill) OtaProgressBarFill.style.width = `${progress}%`;
  if (OtaProgressPercent) OtaProgressPercent.textContent = `${Math.round(progress)}%`;

  const msg = String(payload.message || payload.error || "");
  if (msg && OtaProgressText) OtaProgressText.textContent = msg;

  if (status === "starting" || status === "downloading" || status === "transferring") {
    if (OtaProgressTitle) OtaProgressTitle.textContent = "固件更新中";
    if (BtnOtaDone) BtnOtaDone.style.display = "none";
    if (CloudUpdateSpinner) CloudUpdateSpinner.style.display = "block";
    if (OtaProgressBarFill) OtaProgressBarFill.style.background = "#4CAF50";
    return;
  }

  if (status === "done") {
    if (OtaProgressTitle) OtaProgressTitle.textContent = "固件更新完成";
    if (OtaProgressText && !msg) OtaProgressText.textContent = "更新完成，請點擊完成返回。";
    if (BtnOtaDone) BtnOtaDone.style.display = "inline-block";
    if (CloudUpdateSpinner) CloudUpdateSpinner.style.display = "none";
    if (OtaProgressBarFill) OtaProgressBarFill.style.background = "#4CAF50";
    finalizeOtaUiByTerminalStatus(status);
    return;
  }

  if (status === "error") {
    if (OtaProgressTitle) OtaProgressTitle.textContent = "固件更新失敗";
    if (OtaProgressText && !msg) OtaProgressText.textContent = "更新失敗，請點擊完成返回。";
    if (BtnOtaDone) BtnOtaDone.style.display = "inline-block";
    if (CloudUpdateSpinner) CloudUpdateSpinner.style.display = "none";
    if (OtaProgressBarFill) OtaProgressBarFill.style.background = "#D32F2F";
    finalizeOtaUiByTerminalStatus(status);
  }
}

async function pollOtaStatusFallbackOnce(sessionId) {
  const activeSessionId = String(sessionId || "");
  if (!activeSessionId || otaCurrentSessionId !== activeSessionId) return;

  const snapshot = await fetchOtaStatusSnapshot();
  if (!snapshot) {
    otaStatusFallbackFailCount += 1;
    if (
      otaStatusFallbackFailCount >= OTA_STATUS_FALLBACK_MAX_FAIL_COUNT &&
      OtaProgressText
    ) {
      OtaProgressText.textContent = "狀態連接異常，請點擊完成後重試更新。";
      if (BtnOtaDone) BtnOtaDone.style.display = "inline-block";
      if (CloudUpdateSpinner) CloudUpdateSpinner.style.display = "none";
    }
    return;
  }

  otaStatusFallbackFailCount = 0;
  const snapshotSessionId = String(snapshot.session_id || "");
  if (snapshotSessionId && snapshotSessionId !== activeSessionId) {
    return;
  }
  if (!snapshotSessionId) {
    return;
  }
  renderOtaProgressState(snapshot);
}

function startOtaStatusFallbackPoll(sessionId) {
  const activeSessionId = String(sessionId || "");
  if (!activeSessionId) return;
  if (
    otaStatusFallbackTimer &&
    otaStatusFallbackSessionId === activeSessionId
  ) {
    return;
  }

  stopOtaStatusFallbackPoll();
  otaStatusFallbackSessionId = activeSessionId;
  otaStatusFallbackFailCount = 0;
  void pollOtaStatusFallbackOnce(activeSessionId);
  otaStatusFallbackTimer = setInterval(() => {
    void pollOtaStatusFallbackOnce(activeSessionId);
  }, OTA_STATUS_FALLBACK_INTERVAL_MS);
}

function startOtaProgressStream(sessionId) {
  closeOtaEventStream();
  otaCurrentSessionId = String(sessionId || "");
  if (!otaCurrentSessionId) return;

  const streamUrl = `/api/ota/stream?session_id=${encodeURIComponent(otaCurrentSessionId)}`;
  otaEventSource = new EventSource(streamUrl);
  otaEventSource.onopen = () => {
    stopOtaStatusFallbackPoll();
  };
  otaEventSource.onmessage = (event) => {
    if (!event || !event.data) return;
    try {
      const payload = JSON.parse(event.data);
      renderOtaProgressState(payload);
      stopOtaStatusFallbackPoll();
    } catch (err) {
      console.error("Invalid OTA SSE payload:", err);
    }
  };
  otaEventSource.onerror = () => {
    if (otaCurrentSessionId && OtaProgressText) {
      OtaProgressText.textContent = "狀態連接中斷，正在等待重連...";
    }
    if (otaCurrentSessionId) {
      startOtaStatusFallbackPoll(otaCurrentSessionId);
    }
  };
}

function beginOtaSession(sessionId) {
  if (!sessionId) return;
  resetOtaProgressUi();
  if (CloudUpdateModal) CloudUpdateModal.style.display = "none";
  if (UpdateSelectionMode) UpdateSelectionMode.style.display = "none";
  if (UpdateProgressMode) UpdateProgressMode.style.display = "block";
  if (OtaProgressOverlay) OtaProgressOverlay.style.display = "block";
  startOtaProgressStream(sessionId);
}

async function fetchOtaStatusSnapshot() {
  try {
    const response = await fetch(`/api/ota/status?_ts=${Date.now()}`, {
      method: "GET",
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json().catch(() => ({}));
    return {
      session_id: String(payload?.session_id || ""),
      status: normalizeOtaStatus(payload?.status),
      progress: Number(payload?.progress || 0),
      message: String(payload?.message || ""),
      error: payload?.error || null,
      started_at: Number(payload?.started_at || 0),
    };
  } catch (error) {
    console.warn("Fetch OTA status failed:", error);
    return null;
  }
}

async function syncOtaUiFromBackendStatus() {
  const snapshot = await fetchOtaStatusSnapshot();
  if (!snapshot) {
    clearOtaSessionRef();
    resetOtaProgressUi();
    if (OtaProgressOverlay) OtaProgressOverlay.style.display = "none";
    return false;
  }

  if (isOtaRunningStatus(snapshot.status) && snapshot.session_id) {
    if (CloudUpdateModal) CloudUpdateModal.style.display = "none";
    if (UpdateSelectionMode) UpdateSelectionMode.style.display = "none";
    if (UpdateProgressMode) UpdateProgressMode.style.display = "block";
    if (OtaProgressOverlay) OtaProgressOverlay.style.display = "block";
    startOtaProgressStream(snapshot.session_id);
    renderOtaProgressState(snapshot);
    return true;
  }

  clearOtaSessionRef();
  resetOtaProgressUi();
  if (OtaProgressOverlay) OtaProgressOverlay.style.display = "none";
  if (UpdateSelectionMode) UpdateSelectionMode.style.display = "block";
  if (UpdateProgressMode) UpdateProgressMode.style.display = "none";
  return false;
}

function getConnectedOtaSlots() {
  const rows = [];
  const seen = new Set();

  const appendSlot = (slotValue, deviceNameValue) => {
    const slot = String(slotValue || "").trim().toUpperCase();
    if (!slot || seen.has(slot)) return;
    seen.add(slot);
    rows.push({
      slot,
      deviceName: String(deviceNameValue || "").trim(),
    });
  };

  if (latestRobotStatusSnapshot && Array.isArray(latestRobotStatusSnapshot.slots)) {
    latestRobotStatusSnapshot.slots.forEach((row) => {
      const conn =
        coerceBoolean(row?.is_connected) ||
        coerceBoolean(row?.connected) ||
        coerceBoolean(row?.isConnected);
      if (!conn) return;
      appendSlot(row?.slot, row?.device_name || row?.connected_device || "");
    });
  }

  robotSlots.forEach((row, slotId) => {
    if (!row || row.status !== "connected") return;
    appendSlot(slotId, row.connectedDevice || "");
  });

  rows.sort((a, b) => String(a.slot).localeCompare(String(b.slot)));
  return rows;
}

function refreshOtaSlotSelector() {
  const langPack = language[currentLanguage] || language.hant || {};
  if (OtaSlotSelectorLabel) {
    OtaSlotSelectorLabel.textContent = langPack.OtaSlotLabel || "更新機位";
  }
  if (!OtaSlotSelect) return [];

  const rows = getConnectedOtaSlots();
  const currentChoice = String(OtaSlotSelect.value || selectedOtaSlot || "").toUpperCase();
  OtaSlotSelect.innerHTML = "";

  if (rows.length <= 0) {
    const emptyOption = document.createElement("option");
    emptyOption.value = "";
    emptyOption.disabled = true;
    emptyOption.selected = true;
    emptyOption.textContent = langPack.OtaSlotSelectPlaceholder || "請選擇機位";
    OtaSlotSelect.appendChild(emptyOption);
    OtaSlotSelect.disabled = true;
    selectedOtaSlot = "";
    if (OtaSlotSelectorHint) {
      OtaSlotSelectorHint.dataset.level = "error";
      OtaSlotSelectorHint.textContent =
        langPack.OtaSlotHintNoConnected || "暫無已連接機位";
    }
    if (BtnStartCloudUpdate) BtnStartCloudUpdate.disabled = true;
    if (BtnLocalUpdate) BtnLocalUpdate.disabled = true;
    return rows;
  }

  rows.forEach((row) => {
    const opt = document.createElement("option");
    opt.value = row.slot;
    const suffix = row.deviceName ? ` (${row.deviceName})` : "";
    opt.textContent = `${row.slot}${suffix}`;
    OtaSlotSelect.appendChild(opt);
  });

  const hasCurrent = rows.some((row) => row.slot === currentChoice);
  selectedOtaSlot = hasCurrent ? currentChoice : rows[0].slot;
  OtaSlotSelect.value = selectedOtaSlot;
  OtaSlotSelect.disabled = false;

  if (OtaSlotSelectorHint) {
    OtaSlotSelectorHint.dataset.level = "ok";
    OtaSlotSelectorHint.textContent = (
      langPack.OtaSlotHintSelectedFmt || "將更新機位 {slot}"
    ).replace("{slot}", selectedOtaSlot);
  }
  if (!otaStartRequestInFlight) {
    if (BtnStartCloudUpdate) BtnStartCloudUpdate.disabled = false;
    if (BtnLocalUpdate) BtnLocalUpdate.disabled = false;
  }
  return rows;
}

function getSelectedOtaSlot() {
  const slot = String(
    (OtaSlotSelect && OtaSlotSelect.value) || selectedOtaSlot || ""
  )
    .trim()
    .toUpperCase();
  return slot;
}

async function ensureBleConnectedForOta(slotId) {
  const notConnectedText =
    language[currentLanguage]?.OtaNeedBle || language.en.OtaNeedBle;
  const targetSlot = String(slotId || "").trim().toUpperCase();
  try {
    const response = await fetch("/api/status", { method: "GET" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const json = await response.json().catch(() => ({}));
    const data =
      json && typeof json === "object" && "data" in json ? json.data : json;
    let isConnected = false;
    const hasSlotsArray = Array.isArray(data?.slots);
    if (targetSlot && hasSlotsArray) {
      const slotRow = data.slots.find(
        (row) => String(row?.slot || "").trim().toUpperCase() === targetSlot
      );
      if (slotRow) {
        isConnected =
          coerceBoolean(slotRow?.is_connected) ||
          coerceBoolean(slotRow?.connected) ||
          coerceBoolean(slotRow?.isConnected);
      }
    }
    if (!isConnected && !hasSlotsArray) {
      isConnected =
        coerceBoolean(data?.is_connected) ||
        coerceBoolean(data?.connected) ||
        coerceBoolean(data?.isConnected);
    }

    if (!isConnected) {
      alert(notConnectedText);
      return false;
    }
    return true;
  } catch (error) {
    console.warn("OTA BLE precheck failed:", error);
    alert(notConnectedText);
    return false;
  }
}

async function startCloudOtaRequest() {
  if (otaStartRequestInFlight) return;
  const slot = getSelectedOtaSlot();
  const slotRequiredText =
    language[currentLanguage]?.OtaSlotRequired || language.en.OtaSlotRequired;
  if (!slot) {
    alert(slotRequiredText);
    return;
  }
  const bleConnected = await ensureBleConnectedForOta(slot);
  if (!bleConnected) return;
  resetOtaStateBeforeStart();
  otaStartRequestInFlight = true;
  if (BtnStartCloudUpdate) BtnStartCloudUpdate.disabled = true;
  if (BtnLocalUpdate) BtnLocalUpdate.disabled = true;
  if (OtaSlotSelect) OtaSlotSelect.disabled = true;

  try {
    const res = await fetch("/api/cloud_update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force_update: false, slot }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 409) {
      alert(data.message || "OTA 進行中");
      await syncOtaUiFromBackendStatus();
      return;
    }
    if (!res.ok || !data.session_id) {
      throw new Error(data.message || `HTTP ${res.status}`);
    }
    beginOtaSession(data.session_id);
  } catch (err) {
    console.error("Cloud OTA start failed:", err);
    alert(`啟動失敗: ${err.message || err}`);
  } finally {
    otaStartRequestInFlight = false;
    refreshOtaSlotSelector();
  }
}

async function startLocalOtaRequest(file) {
  if (!file || otaStartRequestInFlight) return;
  const slot = getSelectedOtaSlot();
  const slotRequiredText =
    language[currentLanguage]?.OtaSlotRequired || language.en.OtaSlotRequired;
  if (!slot) {
    alert(slotRequiredText);
    return;
  }
  const bleConnected = await ensureBleConnectedForOta(slot);
  if (!bleConnected) return;
  resetOtaStateBeforeStart();
  otaStartRequestInFlight = true;
  if (BtnStartCloudUpdate) BtnStartCloudUpdate.disabled = true;
  if (BtnLocalUpdate) BtnLocalUpdate.disabled = true;
  if (OtaSlotSelect) OtaSlotSelect.disabled = true;

  try {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("slot", slot);
    const res = await fetch("/ota/local_upload", {
      method: "POST",
      body: formData,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 409) {
      alert(data.message || "OTA 進行中");
      await syncOtaUiFromBackendStatus();
      return;
    }
    if (!res.ok || !data.session_id) {
      throw new Error(data.message || `HTTP ${res.status}`);
    }
    beginOtaSession(data.session_id);
  } catch (err) {
    console.error("Local OTA start failed:", err);
    alert(`啟動失敗: ${err.message || err}`);
  } finally {
    otaStartRequestInFlight = false;
    refreshOtaSlotSelector();
  }
}

async function openCloudUpdateModal() {
  if (!CloudUpdateModal) return;
  const resumedRunning = await syncOtaUiFromBackendStatus();
  if (resumedRunning) {
    return;
  }
  if (PanelNetwork) PanelNetwork.style.visibility = "hidden";
  if (PanelHelp) PanelHelp.style.visibility = "hidden";
  if (PanelExport) PanelExport.style.visibility = "hidden";
  if (PanelImport) PanelImport.style.visibility = "hidden";
  if (PanelInterface) PanelInterface.style.visibility = "hidden";
  if (PanelWindow) PanelWindow.style.visibility = "hidden";
  if (PanelConnect) PanelConnect.style.visibility = "hidden";
  if (PanelAbout) PanelAbout.style.visibility = "hidden";
  hideAboutV2Panel();
  refreshOtaSlotSelector();
  CloudUpdateModal.style.display = "block";
  if (UpdateSelectionMode) UpdateSelectionMode.style.display = "block";
  if (UpdateProgressMode) UpdateProgressMode.style.display = "none";
}

if (BtnCloudUpdatePanel) {
  BtnCloudUpdatePanel.addEventListener("click", openCloudUpdateModal);
}

if (BtnCloudUpdateClose) {
  BtnCloudUpdateClose.addEventListener("click", () => {
    if (otaCurrentSessionId) return;
    if (CloudUpdateModal) CloudUpdateModal.style.display = "none";
  });
}

if (BtnStartCloudUpdate) {
  BtnStartCloudUpdate.addEventListener("click", () => {
    startCloudOtaRequest();
  });
}

if (BtnLocalUpdate && LocalUpdateInput) {
  BtnLocalUpdate.addEventListener("click", async () => {
    const slot = getSelectedOtaSlot();
    const slotRequiredText =
      language[currentLanguage]?.OtaSlotRequired || language.en.OtaSlotRequired;
    if (!slot) {
      alert(slotRequiredText);
      return;
    }
    const bleConnected = await ensureBleConnectedForOta(slot);
    if (!bleConnected) return;
    LocalUpdateInput.click();
  });
  LocalUpdateInput.addEventListener("change", (event) => {
    const file = event?.target?.files?.[0];
    if (event?.target) event.target.value = "";
    if (!file) return;
    startLocalOtaRequest(file);
  });
}

if (OtaSlotSelect) {
  OtaSlotSelect.addEventListener("change", () => {
    selectedOtaSlot = getSelectedOtaSlot();
    refreshOtaSlotSelector();
  });
}

if (BtnOtaDone) {
  BtnOtaDone.addEventListener("click", () => {
    closeOtaOverlay();
  });
}

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
function buildDefaultExportBaseName() {
  const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
  return `blockly_code_${timestamp}`;
}

function sanitizeExportFileName(inputName) {
  let name = String(inputName || "").trim();
  name = name.replace(/[\\/:*?"<>|]/g, "_");
  name = name.replace(/[\r\n\t]+/g, " ").trim();
  if (!name) return "";
  if (!/\.py$/i.test(name)) {
    name = `${name}.py`;
  }
  return name;
}

function closeExportNameModal() {
  if (ExportNameModal) {
    ExportNameModal.style.display = "none";
  }
  pendingExportPayload = null;
}

function downloadExportPythonFile(filename, payload) {
  if (!payload) return;
  const code = String(payload.code || "");
  const serializedJson = String(payload.serializedJson || "");
  const slotMeta = (typeof activeRobotSlotIds !== "undefined" && Array.isArray(activeRobotSlotIds))
    ? activeRobotSlotIds.join(",")
    : "";
  const fileHeader = `# MagosMaster编程生成的代码
# 生成时间: ${new Date().toLocaleString("zh-CN")}
# 文件: ${filename}
#
# 此代码由Blockly编程环境自动生成
#
# MagosRobotSlots: ${slotMeta}
#
# === BLOCKLY_WORKSPACE_BEGIN ===
# ${serializedJson}
# === BLOCKLY_WORKSPACE_END ===
#
`;
  const fullCode = fileHeader + code;
  const blob = new Blob([fullCode], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const downloadLink = document.createElement("a");
  downloadLink.href = url;
  downloadLink.download = filename;
  downloadLink.style.display = "none";
  document.body.appendChild(downloadLink);
  downloadLink.click();
  setTimeout(() => {
    document.body.removeChild(downloadLink);
    URL.revokeObjectURL(url);
  }, 100);
}

function confirmExportWithCustomName() {
  if (!pendingExportPayload) return;
  const langData = language[currentLanguage] || language.en;
  const inputName = String(ExportNameInput?.value || "").trim();
  if (!inputName) {
    alert(langData.ExportNameEmptyAlert);
    return;
  }
  const fileName = sanitizeExportFileName(inputName);
  if (!fileName) {
    alert(langData.ExportNameEmptyAlert);
    return;
  }
  const payload = pendingExportPayload;
  closeExportNameModal();
  downloadExportPythonFile(fileName, payload);
}

function openExportNameModal(payload) {
  pendingExportPayload = payload;
  if (!ExportNameModal || !ExportNameInput) {
    const fallbackName = `${sanitizeExportFileName(payload?.defaultBaseName || "blockly_code") || "blockly_code.py"}`;
    downloadExportPythonFile(fallbackName, payload);
    pendingExportPayload = null;
    return;
  }
  ExportNameModal.style.display = "block";
  ExportNameInput.value = String(payload?.defaultBaseName || "");
  requestAnimationFrame(() => {
    ExportNameInput.focus();
    ExportNameInput.select();
  });
}

BtnExport.addEventListener("click", () => {
  const code = pythonGenerator.workspaceToCode(ws);
  if (code.trim() === "") {
    return;
  }
  const workspaceState = Blockly.serialization.workspaces.save(ws);
  const serializedJson = JSON.stringify(workspaceState);
  openExportNameModal({
    code,
    serializedJson,
    defaultBaseName: buildDefaultExportBaseName(),
  });
});
if (BtnExportNameCancel) {
  BtnExportNameCancel.addEventListener("click", closeExportNameModal);
}
if (BtnExportNameConfirm) {
  BtnExportNameConfirm.addEventListener("click", confirmExportWithCustomName);
}
if (ExportNameMask) {
  ExportNameMask.addEventListener("click", closeExportNameModal);
}
if (ExportNameInput) {
  ExportNameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      confirmExportWithCustomName();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeExportNameModal();
    }
  });
}
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (LicenseImportModal && LicenseImportModal.style.display !== "none") {
    closeLicenseImportModal();
    return;
  }
  if (ExportNameModal && ExportNameModal.style.display !== "none") {
    closeExportNameModal();
  }
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

BtnMusicPlay.addEventListener("click", async () => {
  if (!isPlay) {
    if (await playVoice()) {
      isPlay = true;
    }
  } else {
    if (await pauseVoice()) {
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
if (BtnShortcutMapping) {
  BtnShortcutMapping.addEventListener("click", openShortcutActionModal);
}
if (BtnShortcutActionClose) {
  BtnShortcutActionClose.addEventListener("click", closeShortcutActionModal);
}
if (ShortcutActionMask) {
  ShortcutActionMask.addEventListener("click", closeShortcutActionModal);
}
if (BtnShortcutCaptureKey) {
  BtnShortcutCaptureKey.addEventListener("click", () => {
    if (shortcutIsCapturing) {
      stopShortcutCapture();
    } else {
      startShortcutCapture();
    }
  });
}
if (BtnShortcutActionConfirm) {
  BtnShortcutActionConfirm.addEventListener("click", saveShortcutAction);
}
if (ShortcutActionNameInput) {
  ShortcutActionNameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      saveShortcutAction();
    }
  });
}
if (ShortcutConfirmMask) {
  ShortcutConfirmMask.addEventListener("click", () => {
    submitShortcutConfirm(false);
  });
}
if (BtnShortcutConfirmNo) {
  BtnShortcutConfirmNo.addEventListener("click", () => {
    submitShortcutConfirm(false);
  });
}
if (BtnShortcutConfirmYes) {
  BtnShortcutConfirmYes.addEventListener("click", () => {
    submitShortcutConfirm(true);
  });
}
if (ShortcutSidebarMask) {
  ShortcutSidebarMask.addEventListener("click", closeShortcutSidebarModal);
}
if (BtnShortcutSidebarClose) {
  BtnShortcutSidebarClose.addEventListener("click", closeShortcutSidebarModal);
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
BLE_Refresh(false, {
  source: "auto",
  showNoDevicePrompt: false,
  silentError: true,
});
initBleAutoScanVisibilityObserver();
initializeSongs();
loadMagosMusicSelectedSlot();
renderMusicSlotTabs();
// [MAGOS_DEMO_BEGIN __MAGOS_DEMO_PREVIEW__ feature=music_multi_slot]
ensureMagosDemoDefaultEnabled();
if (isMagosDemoMode()) {
  if (MusicPanelList) {
    MusicPanelList.value = "Yes";
  }
  changeMusicPanel();
}
// [MAGOS_DEMO_END]
displaySongs(searchSongs(""));
syncMusicList();
changeTheme();
// changeLang(); // Moved up
startBatteryStatusPolling();
songs = getAllSongs();
initShortcutActionsFeature();
refreshLicenseStatus({ silent: true });

// 初始化并绑定电量显示配置菜单
function initBatteryDisplayConfig() {
  const btn = document.getElementById('BtnBatteryDisplayPanel');
  const menu = document.getElementById('battery_config_menu');
  const items = menu ? Array.from(menu.querySelectorAll('.battery-config-item')) : [];
  const modeRadios = menu ? Array.from(menu.querySelectorAll('input[name="battery_target_mode"]')) : [];
  const targetSlotsWrap = menu ? menu.querySelector('#battery_target_slots') : null;
  const retryBtn = menu ? menu.querySelector('#battery_retry_failed') : null;
  const resultBox = menu ? menu.querySelector('#battery_config_result') : null;
  const targetTitle = menu ? menu.querySelector('#battery_target_title') : null;
  const targetModeActive = menu ? menu.querySelector('#battery_target_mode_active') : null;
  const targetModeSelected = menu ? menu.querySelector('#battery_target_mode_selected') : null;
  const targetModeAll = menu ? menu.querySelector('#battery_target_mode_all') : null;
  let isPosting = false;
  let targetMode = "active";
  let selectedSlots = new Set();
  let lastFailedSlots = [];
  let lastActionMode = 1;

  if (!btn || !menu) return;

  function getLangPack() {
    return language[currentLanguage] || language.hant || {};
  }

  function renderStaticLabels() {
    const langPack = getLangPack();
    if (targetTitle) targetTitle.textContent = langPack.BatteryCfgTargetTitle || "目標設備";
    if (targetModeActive) targetModeActive.textContent = langPack.BatteryCfgTargetActive || "當前設備";
    if (targetModeSelected) targetModeSelected.textContent = langPack.BatteryCfgTargetSelected || "手動多選";
    if (targetModeAll) targetModeAll.textContent = langPack.BatteryCfgTargetAll || "全選已連接";
    updateRetryButton();
    refreshSlotSelector();
  }

  function getConnectedSlotRows() {
    const slots = [];
    const slotSet = new Set();
    if (latestRobotStatusSnapshot && Array.isArray(latestRobotStatusSnapshot.slots)) {
      latestRobotStatusSnapshot.slots.forEach((row) => {
        const sid = String(row?.slot || "").trim().toUpperCase();
        const conn = !!(
          row?.is_connected === true ||
          row?.is_connected === "True" ||
          row?.is_connected === 1 ||
          row?.connected === true ||
          row?.connected === "True" ||
          row?.connected === 1
        );
        if (!sid || !conn || slotSet.has(sid)) return;
        slotSet.add(sid);
        slots.push({
          slot: sid,
          deviceName: String(row?.device_name || row?.connected_device || "").trim(),
        });
      });
    }

    if (slots.length > 0) return slots;
    activeRobotSlotIds.forEach((sid) => {
      const row = robotSlots.get(sid);
      if (!row || row.status !== "connected" || slotSet.has(sid)) return;
      slotSet.add(sid);
      slots.push({
        slot: sid,
        deviceName: String(row.connectedDevice || "").trim(),
      });
    });
    return slots;
  }

  function resolveActiveSlot(rows) {
    if (!Array.isArray(rows) || rows.length <= 0) return null;
    const slotA = rows.find((r) => r.slot === "A");
    return (slotA || rows[0]).slot;
  }

  function resetResultPanel() {
    if (!resultBox) return;
    resultBox.style.display = "none";
    resultBox.textContent = "";
    resultBox.dataset.level = "";
  }

  function renderResult(payload) {
    if (!resultBox) return;
    const langPack = getLangPack();
    const rows = Array.isArray(payload?.results) ? payload.results : [];
    const successCount = Number(payload?.success_count) || 0;
    const failedCount = Number(payload?.failed_count) || 0;
    const level =
      failedCount <= 0 ? "success" : (successCount > 0 ? "warning" : "error");
    const statusText = payload?.message || (level === "success"
      ? (langPack.BatteryCfgSuccess || "設定成功")
      : (langPack.BatteryCfgFailed || "設定失敗"));
    const detail = rows.map((r) => {
      const sid = String(r?.slot || "?").toUpperCase();
      const ok = String(r?.status || "").toLowerCase() === "success";
      const msg = String(r?.message || "").trim();
      const stateText = ok
        ? (langPack.BatteryCfgResultSuccess || "成功")
        : (langPack.BatteryCfgResultFailed || "失敗");
      return `${sid}：${stateText}${msg ? `（${msg}）` : ""}`;
    });
    resultBox.dataset.level = level;
    resultBox.textContent = [statusText].concat(detail).join("\n");
    resultBox.style.display = "block";
  }

  function updateRetryButton() {
    if (!retryBtn) return;
    const langPack = getLangPack();
    if (lastFailedSlots.length <= 0) {
      retryBtn.style.display = "none";
      retryBtn.disabled = true;
      return;
    }
    retryBtn.disabled = isPosting;
    retryBtn.style.display = "";
    retryBtn.textContent = (langPack.BatteryCfgRetryFailedFmt || "重試失敗設備（{count}）")
      .replace("{count}", String(lastFailedSlots.length));
  }

  function updateActionLabels(targetCount) {
    const langPack = getLangPack();
    const count = Math.max(0, Number(targetCount) || 0);
    items.forEach((it) => {
      const mode = Number(it.getAttribute("data-value")) || 0;
      const base = mode === 1
        ? (langPack.BatteryCfgShow || "顯示")
        : (langPack.BatteryCfgHide || "不顯示");
      if (count > 0) {
        const suffix = (langPack.BatteryCfgApplyFmt || "（對 {count} 台設備生效）")
          .replace("{count}", String(count));
        it.textContent = `${base}${suffix}`;
      } else {
        it.textContent = base;
      }
    });
  }

  function refreshSlotSelector() {
    if (!targetSlotsWrap) return;
    const rows = getConnectedSlotRows();
    const connectedSet = new Set(rows.map((r) => r.slot));
    selectedSlots = new Set(Array.from(selectedSlots).filter((sid) => connectedSet.has(sid)));

    if (selectedSlots.size <= 0) {
      const fallback = resolveActiveSlot(rows);
      if (fallback) selectedSlots.add(fallback);
    }

    targetSlotsWrap.innerHTML = "";
    if (rows.length <= 0) {
      const langPack = getLangPack();
      const empty = document.createElement("div");
      empty.className = "battery-target-empty";
      empty.textContent = langPack.BatteryCfgNoConnected || "暫無已連接設備";
      targetSlotsWrap.appendChild(empty);
    } else {
      rows.forEach((row) => {
        const langPack = getLangPack();
        const line = document.createElement("label");
        line.className = "battery-target-row";
        const left = document.createElement("span");
        left.className = "battery-target-label";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.value = row.slot;
        box.checked = selectedSlots.has(row.slot);
        box.disabled = targetMode !== "selected" || isPosting;
        box.addEventListener("change", () => {
          if (box.checked) selectedSlots.add(row.slot);
          else selectedSlots.delete(row.slot);
          const count = resolveTargetSlots().length;
          updateActionLabels(count);
        });
        const slotText = document.createElement("span");
        slotText.textContent = (langPack.BatteryCfgSlotFmt || "槽位 {slot}")
          .replace("{slot}", String(row.slot));
        left.appendChild(box);
        left.appendChild(slotText);
        line.appendChild(left);
        if (row.deviceName) {
          const right = document.createElement("span");
          right.className = "battery-target-device";
          right.textContent = row.deviceName;
          line.appendChild(right);
        }
        targetSlotsWrap.appendChild(line);
      });
    }

    const count = resolveTargetSlots().length;
    updateActionLabels(count);
  }

  function resolveTargetSlots() {
    const rows = getConnectedSlotRows();
    if (rows.length <= 0) return [];
    if (targetMode === "all") return rows.map((r) => r.slot);
    if (targetMode === "selected") {
      return rows
        .map((r) => r.slot)
        .filter((sid) => selectedSlots.has(sid));
    }
    const active = resolveActiveSlot(rows);
    return active ? [active] : [];
  }

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
    refreshSlotSelector();
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
    modeRadios.forEach((it) => {
      it.disabled = !!disabled;
    });
    if (retryBtn) retryBtn.disabled = !!disabled;
    refreshSlotSelector();
  }

  async function handleSelect(mode, forcedSlots) {
    if (isPosting) return;
    const langPack = getLangPack();
    const targetSlots = Array.isArray(forcedSlots) ? [...forcedSlots] : resolveTargetSlots();
    if (targetSlots.length <= 0) {
      alert(langPack.BlocklyRobotConnectFirst || "請先連接設備");
      return;
    }

    isPosting = true;
    setItemsDisabled(true);
    lastActionMode = Number(mode) || 0;
    resetResultPanel();
    try {
      const result = await postBatteryDisplayMode(mode, targetSlots);
      const failed = Array.isArray(result?.failed_slots)
        ? result.failed_slots.map((s) => String(s || "").trim().toUpperCase()).filter(Boolean)
        : [];
      lastFailedSlots = failed;
      updateRetryButton();
      renderResult(result);
      const okText = langPack.Rename_Success || "设置成功";
      const failText = langPack.BatteryCfgFailed || "設定失敗";
      if (String(result?.status || "").toLowerCase() === "success") {
        alert(langPack.BatteryCfgSuccess || okText || "設定成功");
      } else if (String(result?.status || "").toLowerCase() === "partial") {
        const partialText = (langPack.BatteryCfgPartialFmt || "部分成功：成功 {success} 台，失敗 {failed} 台")
          .replace("{success}", String(Number(result?.success_count) || 0))
          .replace("{failed}", String(Number(result?.failed_count) || 0));
        alert(partialText);
      } else {
        alert(failText);
      }
    } catch (err) {
      console.error('Failed to set battery display mode', err);
      lastFailedSlots = [];
      updateRetryButton();
      if (resultBox) {
        resultBox.dataset.level = "error";
        resultBox.textContent = String(err?.message || err || langPack.BatteryCfgFailed || "設定失敗");
        resultBox.style.display = "block";
      }
      alert(langPack.BatteryCfgFailed || "設定失敗");
    } finally {
      isPosting = false;
      setItemsDisabled(false);
    }
  }

  modeRadios.forEach((radio) => {
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      targetMode = String(radio.value || "active");
      refreshSlotSelector();
    });
  });

  if (retryBtn) {
    retryBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (lastFailedSlots.length <= 0) return;
      handleSelect(lastActionMode, lastFailedSlots);
    });
  }

  items.forEach((it) => {
    it.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const v = parseInt(it.getAttribute('data-value'));
      handleSelect(v);
    });
    // keyboard Enter/Space will trigger button click by default
  });

  window._onBatteryDisplayLanguageChanged = renderStaticLabels;
  renderStaticLabels();
}

async function postBatteryDisplayMode(mode) {
  const payload = { display_mode: Number(mode) };
  const slotsArg = arguments.length > 1 ? arguments[1] : null;
  if (Array.isArray(slotsArg) && slotsArg.length > 0) {
    payload.slots = slotsArg
      .map((s) => String(s || "").trim().toUpperCase())
      .filter(Boolean);
  }
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
  closeOtaEventStream();
  stopShortcutEventStream();
  stopBleAutoScan();
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
    'PanelHelp',
    'PanelAbout',
    'PanelAboutV2'
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
    BtnHelpPanel: 'PanelHelp',
    BtnAbout: 'PanelAbout'
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
    const allowSet = new Set([allowedPanelId]);
    if (allowedPanelId === 'PanelAbout' || allowedPanelId === 'PanelAboutV2') {
      allowSet.add('PanelAbout');
      allowSet.add('PanelAboutV2');
    }
    panels.forEach(({ id, el }) => {
      if (allowSet.has(id)) return; // 保留允许的面板（由原逻辑决定打开/关闭）
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
    const btn = ev.target.closest('#BtnConnectPanel, #BtnInterfacePanel, #BtnWindowPanel, #BtnExportPanel, #BtnImportPanel, #BtnBatteryDisplayPanel, #BtnNetworkPanel, #BtnHelpPanel, #BtnAbout');
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




