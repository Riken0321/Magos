const definitions = Blockly.common.createBlockDefinitionsFromJsonArray([
  {
    type: "add_number",
    message0: "数字是：%1",
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
    message0: "添加滑轮：%1",
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
    message0: "添加滑动条：%1",
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
    message0: "添加颜色：%1",
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
    message0: "舵机%1旋转的度数%2",
    args0: [
      {
        type: "field_dropdown",
        name: "servoIndex",
        options: [
          ["舵机1", "1"],
          ["舵机2", "2"],
          ["舵机3", "3"],
          ["舵机4", "4"],
          ["舵机5", "5"],
          ["舵机6", "6"],
          ["舵机7", "7"],
          ["舵机8", "8"],
          ["舵机9", "9"],
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
    message0: "动画组名称:%1 动作组：%2",
    args0: [
      {
        type: "input_value",
        name: "name",
      },
      {
        type: "input_value",
        name: "action",
      },
    ],
    previousStatement: null,
    nextStatement: null,
    colour: 80,
  },
  {
    type: "test002",
    message0: "动画%1舵机值：%2执行时长：%3附加语音：%4",
    args0: [
      {
        type: "input_value",
        name: "name",
      },
      {
        type: "input_value",
        name: "servers",
      },
      {
        // type: "field_slider",
        type: "input_value",
        name: "times",
      },
      {
        type: "input_value",
        name: "voice",
      },
    ],
    colour: 80,
    output: "string",
    // previousStatement: null,
    // nextStatement: null,
  },
  {
    type: "animations_start",
    message0: "播放动画：%1",
    args0: [
      {
        type: "field_dropdown",
        name: "actions_name",
        options: [
            ["三个动作组","三个动作组"],
            ["双手伸展运动","双手伸展运动"],
            ["拍肩膀","拍肩膀"],
            ["挥手示意","挥手示意"],
            ["右下水，手舞足動", "右下水，手舞足動"],
            ["雙手抬前", "雙手抬前"],
            ["雙手胸前（大）", "雙手胸前（大）"],
        ]
      },
    ],
    colour: 80,
    previousStatement: null,
    nextStatement: null,
  },
  {
    type:"magos_arm",
    message0: "%1 arm",
    name:"arm",
    args0: [
      {
        type: "field_dropdown",
        name: "arm",
        options:[
          ["left","left"],
          ["right","right"],
        ]
      },
    ],
    colour: 80,
    previousStatement: null,
    nextStatement: null,
  }
]);

Blockly.common.defineBlocks(definitions);
