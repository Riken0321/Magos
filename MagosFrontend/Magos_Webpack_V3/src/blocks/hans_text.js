import * as Blockly from "blockly/core";

// import * as dataLoader from './dataLoader';
// import { registerFieldAngle } from '@blockly/field-angle';
// import { registerFieldAngle } from '@blockly/field-angle';
// import '@blockly/field-dependent-dropdown';
// registerFieldAngle();
//目前colour为默认颜色，已被覆盖
let actions = null;
let shortcutActions = [];
let currentActionLanguage = "hant";

export function getRobotOptions() {
  if (
    typeof window !== "undefined" &&
    Array.isArray(window.__magosRobotBlockOptions) &&
    window.__magosRobotBlockOptions.length > 0
  ) {
    return window.__magosRobotBlockOptions;
  }
  return [["请先连接设备", "__none__"]];
}

async function loadActionsData() {
  try {
    const response = await fetch("/static/data.json");
    if (!response.ok) {
      throw new Error(`加载数据失败: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    const response = await fetch("./data.json");
    if (!response.ok) {
      throw new Error(`加载数据失败: ${response.status}`);
    }
    return await response.json();
  }
}

actions = await loadActionsData();
shortcutActions = await loadShortcutActionsData();

export function setActionsLanguage(lang) {
  currentActionLanguage = lang;
}

export async function refreshActionOptionsData() {
  actions = await loadActionsData();
  return actions;
}

async function loadShortcutActionsData() {
  try {
    const response = await fetch("/api/shortcut_actions");
    if (!response.ok) {
      throw new Error(`Load shortcut actions failed: ${response.status}`);
    }
    const payload = await response.json();
    if (payload && Array.isArray(payload.items)) {
      return payload.items;
    }
  } catch (error) {
    console.warn("Blockly: Failed to load shortcut actions", error);
  }
  return [];
}

export async function refreshShortcutActionOptionsData() {
  shortcutActions = await loadShortcutActionsData();
  return shortcutActions;
}

export function setActionOptionsData(nextActions) {
  if (!actions || typeof actions !== "object") {
    actions = {};
  }
  if (!Array.isArray(nextActions)) {
    actions.actions = [];
    return actions;
  }
  actions.actions = nextActions
    .filter((item) => Array.isArray(item) && item.length >= 2)
    .map((item) => [String(item[0]), String(item[1])]);
  return actions;
}

function getActionOptions() {
  if (!actions || !actions.actions) return [["None", "None"]];
  const list = actions.actions;
  const map = actions.action_map;
  if (!map) return list;
  
  return list.map(item => {
    // legacy format: [label, value], we want value
    const val = item[1];
    let label = item[0];
    
    // Check map
    if (map[val]) {
      // Priority: currentLanguage -> hans -> orignal
      if (map[val][currentActionLanguage]) {
        label = map[val][currentActionLanguage];
      } else if (map[val]["hans"]) {
        label = map[val]["hans"];
      }
    }
    return [label, val];
  });
}

function getShortcutActionOptions() {
  if (!Array.isArray(shortcutActions) || shortcutActions.length === 0) {
    return [["No Shortcut", ""]];
  }

  const next = shortcutActions
    .map((item) => {
      const sid = String(item?.id || "").trim();
      const name = String(item?.name || "").trim();
      if (!sid || !name) return null;
      return [name, sid];
    })
    .filter(Boolean);
  return next.length > 0 ? next : [["No Shortcut", ""]];
}

// console.log(actions)
const addText = {
  type: "add_text",
  message0: "%{BKY_MAGOS_ADD_TEXT}",
  args0: [
    {
      type: "input_value",
      name: "TEXT",
      check: "String",
    },
  ],
  previousStatement: null,
  nextStatement: null,
  colour: 160,
  tooltip: "",
  helpUrl: "",
};

const ServoControl = {
  type: "ServoControl",
  message0: "🤖%1 %{BKY_MAGOS_SERVO_CONTROL_TITLE}",
  args0: [
    {
      type: "field_dropdown",
      name: "robotId",
      options: getRobotOptions,
    },
    {
      type: "field_dropdown",
      name: "servoIndex",
      options: [
        ["%{BKY_MAGOS_LEFT_HAND}", "magos.LeftHand"],
        ["%{BKY_MAGOS_LEFT_ARM}", "magos.LeftArm"],
        ["%{BKY_MAGOS_LEFT_SHOULDER}", "magos.LeftShoulder"],
        ["%{BKY_MAGOS_RIGHT_HAND}", "magos.RightHand"],
        ["%{BKY_MAGOS_RIGHT_ARM}", "magos.RightArm"],
        ["%{BKY_MAGOS_RIGHT_SHOULDER}", "magos.RightShoulder"],
        ["%{BKY_MAGOS_HEADER}", "magos.Header"],
        ["%{BKY_MAGOS_BASE}", "magos.Base"],
        ["%{BKY_MAGOS_BODY}", "magos.Body"],
      ],
    },
    {
      type: "field_signed_angle",
      name: "angle",
      min: 0,
      max: 180,
      precision: 1,
      value: 90,
    },
  ],
  previousStatement: null,
  nextStatement: null,
  colour: 210,
};

const animations_start = {
  type: "animations_start",
  message0: "🤖%1 %{BKY_MAGOS_ANIMATIONS_START_TITLE}",
  args0: [
    {
      type: "field_dropdown",
      name: "robotId",
      options: getRobotOptions,
    },
    {
      type: "field_dropdown",
      name: "actions_name",
      options: getActionOptions,
    },
  ],
  colour: 80,
  previousStatement: null,
  nextStatement: null,
};

const shortcut_action_start = {
  type: "shortcut_action_start",
  message0: "🤖%1 %{BKY_MAGOS_SHORTCUT_ACTION_START_TITLE}",
  args0: [
    {
      type: "field_dropdown",
      name: "robotId",
      options: getRobotOptions,
    },
    {
      type: "field_dropdown",
      name: "shortcut_action_id",
      options: getShortcutActionOptions,
    },
  ],
  colour: 80,
  previousStatement: null,
  nextStatement: null,
};

function getBackgroundAudioOptions() {
  const cachedSongsStr = typeof localStorage !== 'undefined' ? localStorage.getItem("miniCachedSongs_v5") : null;
  if (cachedSongsStr) {
    try {
      const songs = JSON.parse(cachedSongsStr);
      if (Array.isArray(songs) && songs.length > 0) {
        return songs.map((song) => {
          const title = String(song.title || ("Song " + song.id));
          // Keep field name for backward compatibility, but switch value semantics to song name.
          return [title, title];
        });
      }
    } catch (e) {
      console.warn("Blockly: Failed to parse cached songs", e);
    }
  }
  // Default options if no cache found (value uses song name, not numeric index)
  return [
    ["%{BKY_MAGOS_MUSIC_THREE_PIGS_OPERA}", "三隻小豬粵劇"],
    ["YMCA Dance", "YMCA Dance"],
    ["ABBA DanceQueen", "ABBA DanceQueen"],
    ["Song 4", "Song 4"],
    ["Song 5", "Song 5"],
    ["Song 6", "Song 6"],
    ["Song 7", "Song 7"],
    ["Song 8", "Song 8"],
  ];
}

const play_background_audio = {
  type: "play_background_audio",
  message0: "🤖%1 %{BKY_MAGOS_PLAY_BG_MUSIC_TITLE}",
  args0: [
    {
      type: "field_dropdown",
      name: "robotId",
      options: getRobotOptions,
    },
    {
      type: "field_dropdown",
      name: "background_audio_index",
      options: getBackgroundAudioOptions,
    },
  ],
  colour: 80,
  previousStatement: null,
  nextStatement: null,
};

const stop_background_audio = {
  type: "stop_background_audio",
  message0: "🤖%1 %{BKY_MAGOS_STOP_BG_MUSIC_TITLE}",
  args0: [
    {
      type: "field_dropdown",
      name: "robotId",
      options: getRobotOptions,
    },
  ],
  colour: 80,
  previousStatement: null,
  nextStatement: null,
};

const change_emoji = {
  type: "change_emoji",
  message0: "🤖%1 %{BKY_MAGOS_CHANGE_EMOJI_TITLE}",
  args0: [
    {
      type: "field_dropdown",
      name: "robotId",
      options: getRobotOptions,
    },
    {
      type: "field_dropdown",
      name: "emoji_index",
      options: [
        ["%{BKY_MAGOS_EMOJI_EXCITED}", "0"],
        ["%{BKY_MAGOS_EMOJI_ANGRY}", "1"],
        ["%{BKY_MAGOS_EMOJI_DISDAIN}", "2"],
        ["%{BKY_MAGOS_EMOJI_PANIC}", "3"],
        ["%{BKY_MAGOS_EMOJI_SAD}", "4"],
        ["%{BKY_MAGOS_EMOJI_LOOK_UP_RIGHT}", "5"],
        ["%{BKY_MAGOS_EMOJI_LOOK_UP_LEFT}", "6"],
        ["%{BKY_MAGOS_EMOJI_BLINK}", "7"],
        ["%{BKY_MAGOS_EMOJI_PIG_DAD}", "8"],
        ["%{BKY_MAGOS_EMOJI_PIG_MOM}", "9"],
        ["%{BKY_MAGOS_EMOJI_PIG_SON}", "10"],
      ],
    },
  ],
  colour: 80,
  previousStatement: null,
  nextStatement: null,
};

const play_audio = {
  type: "play_audio",
  message0: "🤖%1 %{BKY_MAGOS_SAY_TITLE}",
  args0: [
    {
      type: "field_dropdown",
      name: "robotId",
      options: getRobotOptions,
    },
    {
      type: "field_input",
      name: "audio",
      value: "你好",
    },
  ],
  colour: 80,
  previousStatement: null,
  nextStatement: null,
};

const test001 = {
  type: "test001",
  message0: "%{BKY_MAGOS_TEST_TITLE}",
  args0: [
    {
      type: "field_dropdown",
      name: "servoIndex",
      options: [
        ["%{BKY_MAGOS_LEFT_HAND}", "magos.LeftHand"],
        ["%{BKY_MAGOS_LEFT_ARM}", "magos.LeftArm"],
        ["%{BKY_MAGOS_LEFT_SHOULDER}", "magos.LeftShoulder"],
        ["%{BKY_MAGOS_RIGHT_HAND}", "magos.RightHand"],
        ["%{BKY_MAGOS_RIGHT_ARM}", "magos.RightArm"],
        ["%{BKY_MAGOS_RIGHT_SHOULDER}", "magos.RightShoulder"],
        ["%{BKY_MAGOS_HEADER}", "magos.Header"],
        ["%{BKY_MAGOS_BASE}", "magos.Base"],
        ["%{BKY_MAGOS_BODY}", "magos.Body"],
      ],
    },
  ],
  previousStatement: null,
  nextStatement: null,
  colour: 80,
};

const magos_time = {
  type: "magos_time",
  message0: "🤖%1 %{BKY_MAGOS_PAUSE_TITLE}",
  args0: [
    {
      type: "field_dropdown",
      name: "robotId",
      options: getRobotOptions,
    },
    {
      type: "field_number",
      name: "_time",
      value: 1,
    },
  ],
  colour: 80,
  previousStatement: null,
  nextStatement: null,
};

function getParallelRobotSlotIds() {
  if (
    typeof window !== "undefined" &&
    Array.isArray(window.__magosParallelRobotSlotIds)
  ) {
    return window.__magosParallelRobotSlotIds
      .map((id) => String(id || "").trim().toUpperCase())
      .filter((id) => id.length === 1 && id >= "A" && id <= "F");
  }
  return [];
}

function branchLabelByIndex(index) {
  const slots = getParallelRobotSlotIds();
  const slot = slots[index];
  if (slot) return `分支 ${slot}`;
  return `分支 ${String.fromCharCode(65 + index)}`;
}

Blockly.Blocks.parallel_wait_all = {
  buildConnectedHint_() {
    const slots = getParallelRobotSlotIds();
    if (!slots.length) return "｜当前并行槽位：无";
    return `｜当前并行槽位：${slots.join("/")}`;
  },
  init() {
    this.branchCount_ = 0;
    this.appendDummyInput("TITLE")
      .appendField("並行執行（全部完成後繼續）")
      .appendField(this.buildConnectedHint_(), "CONNECTED_HINT");
    this.setPreviousStatement(true, null);
    this.setNextStatement(true, null);
    this.setColour(20);
    this.setTooltip("按当前槽位数量自动分支；空分支自动跳过；所有分支完成后再继续。");
    this.syncBranchCount_(Math.max(1, getParallelRobotSlotIds().length));
  },
  getBranchCount() {
    return Number.isFinite(this.branchCount_) ? Math.max(0, this.branchCount_) : 0;
  },
  getLastNonEmptyBranchIndex_() {
    const count = this.getBranchCount();
    let last = -1;
    for (let i = 0; i < count; i++) {
      if (this.getInputTargetBlock(`BRANCH_${i}`)) last = i;
    }
    return last;
  },
  syncBranchCount_(targetCount) {
    let safeTarget = Number.isFinite(targetCount) ? Math.floor(targetCount) : 1;
    safeTarget = Math.max(1, Math.min(6, safeTarget));

    // 软收敛：如果高位分支已有内容，不强制删除，避免断连时丢块。
    const keepByContent = this.getLastNonEmptyBranchIndex_() + 1;
    safeTarget = Math.max(safeTarget, keepByContent, 1);

    const prevCount = this.getBranchCount();
    const connectedHintField = this.getField("CONNECTED_HINT");
    if (connectedHintField && typeof connectedHintField.setValue === "function") {
      connectedHintField.setValue(this.buildConnectedHint_());
    }
    for (let i = prevCount; i < safeTarget; i++) {
      this.appendStatementInput(`BRANCH_${i}`).appendField(branchLabelByIndex(i));
    }
    for (let i = prevCount - 1; i >= safeTarget; i--) {
      if (this.getInput(`BRANCH_${i}`)) {
        this.removeInput(`BRANCH_${i}`, true);
      }
    }
    for (let i = 0; i < safeTarget; i++) {
      const input = this.getInput(`BRANCH_${i}`);
      if (!input || !input.fieldRow || input.fieldRow.length === 0) continue;
      const first = input.fieldRow[0];
      if (first && typeof first.setValue === "function") {
        first.setValue(branchLabelByIndex(i));
      }
    }
    this.branchCount_ = safeTarget;
  },
  saveExtraState() {
    return { branchCount: this.getBranchCount() };
  },
  loadExtraState(state) {
    const count = Number(state?.branchCount);
    this.syncBranchCount_(Number.isFinite(count) ? count : this.getBranchCount());
  },
  mutationToDom() {
    const mutation = Blockly.utils.xml.createElement("mutation");
    mutation.setAttribute("branch_count", String(this.getBranchCount()));
    return mutation;
  },
  domToMutation(xmlElement) {
    const raw = Number(xmlElement?.getAttribute("branch_count"));
    this.syncBranchCount_(Number.isFinite(raw) ? raw : this.getBranchCount());
  },
};

const magos_arm = {
  type: "magos_arm",
  message0: "%{BKY_MAGOS_ARM_TITLE}",
  name: "arm",
  args0: [
    {
      type: "field_dropdown",
      name: "arm",
      options: [
        ["%{BKY_MAGOS_ARM_LEFT}", "left"],
        ["%{BKY_MAGOS_ARM_RIGHT}", "right"],
      ],
    },
  ],
  colour: 80,
  previousStatement: null,
  nextStatement: null,
};

export const hans_blocks = Blockly.common.createBlockDefinitionsFromJsonArray([
  addText,
  magos_arm,
  ServoControl,
  animations_start,
  shortcut_action_start,
  play_background_audio,
  magos_time,
  play_audio,
  stop_background_audio,
  change_emoji,
  test001,
]);
