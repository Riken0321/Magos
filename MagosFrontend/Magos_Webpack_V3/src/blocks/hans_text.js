import * as Blockly from "blockly/core";

// import * as dataLoader from './dataLoader';
// import { registerFieldAngle } from '@blockly/field-angle';
// import { registerFieldAngle } from '@blockly/field-angle';
// import '@blockly/field-dependent-dropdown';
// registerFieldAngle();
//目前colour为默认颜色，已被覆盖
let actions = null;
let currentActionLanguage = "hant";
try {
  const response = await fetch("/static/data.json");
  if (!response.ok) {
    throw new Error(`加载数据失败: ${response.status}`);
  }
  actions = await response.json();
} catch (error) {
  const response = await fetch("./data.json");
  if (!response.ok) {
    throw new Error(`加载数据失败: ${response.status}`);
  }
  actions = await response.json();
}

export function setActionsLanguage(lang) {
  currentActionLanguage = lang;
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
  message0: "%{BKY_MAGOS_SERVO_CONTROL_TITLE}",
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
    {
      // type: "field_number",
      type: "field_angle",
      name: "angle",
      displayMax: 180,
      value: 90,
    },
  ],
  // output: "String",
  previousStatement: null,
  nextStatement: null,
  colour: 210,
};

const animations_start = {
  type: "animations_start",
  message0: "%{BKY_MAGOS_ANIMATIONS_START_TITLE}",
  args0: [
    {
      type: "field_dropdown",
      name: "actions_name",
      options: getActionOptions,
      // options: [
      //   ["包青天作揖", "包青天作揖"],
      //   ["武松準備打虎", "武松准备打虎"],
      //   ["武松打虎", "武松打虎"],
      //   ["初始動作", "初始动作"],
      //   ["揮手示意", "挥手示意"],
      //   ["揮舞", "挥舞"],
      //   ["摸頭", "摸头"],
      //   ["拍肩膀", "拍肩膀"],
      //   ["三個動作組", "三个动作组"],
      //   ["雙手伸展運動", "双手伸展运动"],
      //   ["雙手上下運動", "双手上下运动"],
      // ],
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
        return songs.map((song) => [song.title || ("Song " + song.id), String(song.id)]);
      }
    } catch (e) {
      console.warn("Blockly: Failed to parse cached songs", e);
    }
  }
  // Default legacy options if no cache found
  return [
    ["%{BKY_MAGOS_MUSIC_THREE_PIGS_OPERA}", "1"],
    ["YMCA Dance", "2"],
    ["ABBA DanceQueen", "3"],
    ["4", "4"],
    ["5", "5"],
    ["6", "6"],
    ["7", "7"],
    ["8", "8"],
  ];
}

const play_background_audio = {
  type: "play_background_audio",
  message0: "%{BKY_MAGOS_PLAY_BG_MUSIC_TITLE}",
  args0: [
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
  message0: "%{BKY_MAGOS_STOP_BG_MUSIC_TITLE}",
  colour: 80,
  previousStatement: null,
  nextStatement: null,
};

const change_emoji = {
  type: "change_emoji",
  message0: "%{BKY_MAGOS_CHANGE_EMOJI_TITLE}",
  args0: [
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
  message0: "%{BKY_MAGOS_SAY_TITLE}",
  args0: [
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
  message0: "%{BKY_MAGOS_PAUSE_TITLE}",
  args0: [
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
  play_background_audio,
  magos_time,
  play_audio,
  stop_background_audio,
  change_emoji,
  test001,
]);
