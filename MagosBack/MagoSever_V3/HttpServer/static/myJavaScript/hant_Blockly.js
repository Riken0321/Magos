const definitions = Blockly.common.createBlockDefinitionsFromJsonArray([
  {
    type: "add_number",
    message0: "數字是：%1",
    args0: [
      {
        type: "field_number",
        name: "VALUE",
        value: 10,
      },
    ],
    output: "Number",
    colour: 16,
  },
  {
    type: "add_angle",
    message0: "添加滑輪：%1",
    args0: [
      {
        type: "field_angle",
        name: "single",
        value: 50,
      },
    ],
    output: "Number",
  },
  {
    type: "add_string",
    message0: "添加字符串：%1",
    args0: [
      {
        type: "input_value",
        name: "raw_index",
      },
    ],
  },
  {
    type: "add_slider",
    message0: "添加滑動條：%1",
    args0: [
      {
        type: "field_slider",
        name: "slider",
        value: 50,
      },
    ],
  },
  {
    type: "add_colour",
    message0: "添加顔色：%1",
    args0: [
      {
        type: "field_colour",
        name: "colour",
        value: 1,
      },
    ],
  },
  {
    type: "left_hand_up",
    message0: "举左手使用时长：%1s",
    args0: [
      {
        type: "field_number",
        name: "VALUE",
        value: 1,
      },
    ],
    output: "Number",
    // previousStatement: null,
    // nextStatement: null,
    colour: 10,
  },
  {
    type: "left_hand_down",
    message0: "放左手使用时长：%1s",
    args0: [
      {
        type: "field_number",
        name: "VALUE",
        value: 1,
      },
    ],
    output: "Number",
    // previousStatement: null,
    // nextStatement: null,
    colour: 20,
  },
  {
    type: "right_hand_up",
    message0: "举右手使用时长：%1s",
    args0: [
      {
        type: "field_number",
        name: "VALUE",
        value: 1,
      },
    ],
    output: "Number",
    // previousStatement: null,
    // nextStatement: null,
    colour: 40,
  },
  {
    type: "right_hand_down",
    message0: "放右手使用时长：%1s",
    args0: [
      {
        type: "field_number",
        name: "VALUE",
        value: 1,
      },
    ],
    output: "Number",
    // previousStatement: null,
    // nextStatement: null,
    colour: 60,
  },
  {
    type: "embrace",
    message0: "拥抱使用时长：%1s",
    args0: [
      {
        type: "field_number",
        name: "VALUE",
        value: 1,
      },
    ],
    output: "Number",
    // previousStatement: null,
    // nextStatement: null,
    colour: 80,
  },
  {
    type: "ServoControl",
    message0: "Magos%1旋轉的角度%2",
    args0: [
      {
        type: "field_dropdown",
        name: "servoIndex",
        options: [
          ["左手", "magos.LeftHand"],
          ["左臂", "magos.LeftArm"],
          ["左肩", "magos.LeftShoulder"],
          ["右手", "magos.RightHand"],
          ["右臂", "magos.RightArm"],
          ["右肩", "magos.RightShoulder"],
          ["頭部", "magos.Header"],
          ["底座", "magos.Base"],
          ["身體", "magos.Body"],
        ],
      },
      {
        type: "field_angle",
        name: "angle",
      },
    ],
    // output: "String",
    previousStatement: null,
    nextStatement: null,
    colour: 80,
  },
  {
    type: "test001",
    message0: "Magos测试:%1",
    args0: [
      {
        type: "field_dropdown",
        name: "servoIndex",
        options: [
          ["左手", "magos.LeftHand"],
          ["左臂", "magos.LeftArm"],
          ["左肩", "magos.LeftShoulder"],
          ["右手", "magos.RightHand"],
          ["右臂", "magos.RightArm"],
          ["右肩", "magos.RightShoulder"],
          ["頭部", "magos.Header"],
          ["底座", "magos.Base"],
          ["身體", "magos.Body"],
        ]
      },
    ],
    previousStatement: null,
    nextStatement: null,
    colour: 80,
  },
  {
    type: "animations_start",
    message0: "播放動畫組：%1",
    args0: [
      {
        type: "field_dropdown",
        name: "actions_name",
        options: [
          ["包青天作揖", "包青天作揖"],
          ["武松準備打虎", "武松准备打虎"],
          ["武松打虎", "武松打虎"],
          ["初始動作", "初始动作"],
          ["揮手示意", "挥手示意"],
          ["揮舞", "挥舞"],
          ["摸頭", "摸头"],
          ["拍肩膀", "拍肩膀"],
          ["三個動作組", "三个动作组"],
          ["雙手伸展運動", "双手伸展运动"],
          ["雙手上下運動", "双手上下运动"],
          ["右下水，手舞足動", "右下水，手舞足動"],
          ["雙手抬前", "雙手抬前"],
          ["雙手胸前（大）", "雙手胸前（大）"],
        ],
      },
    ],
    colour: 80,
    previousStatement: null,
    nextStatement: null,
  },
  {
    type: "play_background_audio",
    message0: "播放背景音樂：%1",
    args0: [
      {
        type: "field_dropdown",
        name: "background_audio_index",
        options: [
          ["月亮代表我的心", "1"],
          ["YMCA Dance", "2"],
          ["ABBA DanceQueen", "3"],
          ["4", "4"],
          ["5", "5"],
          ["6", "6"],
          ["7", "7"],
          ["8", "8"],
        ],
      },
    ],
    colour: 80,
    previousStatement: null,
    nextStatement: null,
  },
  {
    type: "stop_background_audio",
    message0: "暫停背景音樂",
    colour: 80,
    previousStatement: null,
    nextStatement: null,
  },
  {
    type: "change_emoji",
    message0: "變換表情：%1",
    args0: [
      {
        type: "field_dropdown",
        name: "emoji_index",
        options: [
          ["表情1", "1"],
          ["表情2", "2"],
          ["表情3", "3"],
          ["猪爸爸", "8"],
          ["猪妈妈", "9"],
          ["猪儿子", "10"],
        ],
      },
    ],
    colour: 80,
    previousStatement: null,
    nextStatement: null,
  },
  {
    type: "play_audio",
    message0: "Magos說：%1",
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
  },
  {
    type: "magos_time",
    message0: "Magos暂停：%1 s",
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
  },
  {
    type: "magos_arm",
    message0: "%1 arm",
    name: "arm",
    args0: [
      {
        type: "field_dropdown",
        name: "arm",
        options: [
          ["left", "left"],
          ["right", "right"],
        ],
      },
    ],
    colour: 80,
    previousStatement: null,
    nextStatement: null,
  },
]);

Blockly.common.defineBlocks(definitions);
