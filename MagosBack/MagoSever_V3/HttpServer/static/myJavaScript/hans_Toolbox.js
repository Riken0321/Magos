const toolbox = {
  kind: "categoryToolbox",
  contents: [
    {
      //#region逻辑类块
      kind: "category",
      name: "逻辑",
      colour: 210,
      contents: [
        {
          kind: "block",
          type: "controls_if",
        },
        {
          kind: "block",
          type: "logic_compare",
        },
        {
          kind: "block",
          type: "logic_operation",
        },
        {
          kind: "block",
          type: "logic_boolean",
        },
        {
          kind: "block",
          type: "logic_negate",
        },
        {
          kind: "block",
          type: "logic_null",
        },
        {
          kind: "block",
          type: "logic_ternary",
        },
      ],
      //#endregion
    },
    {
      //#region 循环类块
      kind: "category",
      name: "循环",
      colour: 120,
      contents: [
        {
          kind: "block",
          type: "controls_repeat_ext",
        },
        {
          kind: "block",
          type: "controls_whileUntil",
        },
        {
          kind: "block",
          type: "controls_for",
        },
        {
          kind: "block",
          type: "controls_forEach",
        },
        {
          kind: "block",
          type: "controls_flow_statements",
        },
      ],
      //#endregion
    },
    {
      //#region 数学类
      kind: "category",
      name: "数学",
      colour: 230,
      contents: [
        {
          kind: "block",
          type: "math_number",
        },
        {
          kind: "block",
          type: "math_arithmetic",
        },
        {
          kind: "block",
          type: "math_single",
        },
        {
          kind: "block",
          type: "math_trig",
        },
        {
          kind: "block",
          type: "math_constant",
        },
        {
          kind: "block",
          type: "math_number_property",
        },
        {
          kind: "block",
          type: "math_on_list",
        },
        {
          kind: "block",
          type: "math_modulo",
        },
        {
          kind: "block",
          type: "math_constrain",
        },
        {
          kind: "block",
          type: "math_random_int",
        },
        {
          kind: "block",
          type: "math_random_float",
        },
        {
          kind: "block",
          type: "math_atan2",
        },
      ],
      //#endregion
    },
    {
      //#region 文本类
      kind: "category",
      name: "文本",
      colour: 160,
      contents: [
        {
          kind: "block",
          type: "text",
        },
        {
          kind: "block",
          type: "text_join",
        },
        {
          kind: "block",
          type: "text_append",
        },
        {
          kind: "block",
          type: "text_length",
        },
        {
          kind: "block",
          type: "text_isEmpty",
        },
        {
          kind: "block",
          type: "text_indexOf",
        },
        {
          kind: "block",
          type: "text_charAt",
        },
        {
          kind: "block",
          type: "text_getSubstring",
        },
        {
          kind: "block",
          type: "text_changeCase",
        },
        {
          kind: "block",
          type: "text_trim",
        },
        {
          kind: "block",
          type: "text_print",
        },
        {
          kind: "block",
          type: "text_prompt_ext",
        },
      ],
      //#endregion
    },
    {
      //#region 数组类
      kind: "category",
      name: "列表",
      colour: 260,
      contents: [
        {
          kind: "block",
          type: "lists_create_with",
        },
        {
          kind: "block",
          type: "lists_create_empty",
        },
        {
          kind: "block",
          type: "lists_repeat",
        },
        {
          kind: "block",
          type: "lists_length",
        },
        {
          kind: "block",
          type: "lists_isEmpty",
        },
        {
          kind: "block",
          type: "lists_indexOf",
        },
        {
          kind: "block",
          type: "lists_getIndex",
        },
        {
          kind: "block",
          type: "lists_setIndex",
        },
        {
          kind: "block",
          type: "lists_getSublist",
        },
        {
          kind: "block",
          type: "lists_split",
        },
        {
          kind: "block",
          type: "lists_sort",
        },
        {
          kind: "block",
          type: "lists_reverse",
        },
      ],
      //#endregion
    },
    {
      kind: "category",
      name: "变量",
      colour: 330,
      custom: "VARIABLE",
    },
    {
      kind: "category",
      name: "Variables",
      colour: 210,
      custom: "VARIABLE_DYNAMIC",
    },
    {
      kind: "category",
      name: "函数",
      colour: 290,
      custom: "PROCEDURE",
    },
    // {
    //   kind: "category",
    //   name: "Magos控制",
    //   colour: 100,
    //   contents: [
    //     {
    //       kind: "block",
    //       type: "add_angle",
    //     },
    //     {
    //       kind: "block",
    //       type: "add_string",
    //     },
    //     {
    //       kind: "block",
    //       type: "add_colour",
    //     },
    //     {
    //       kind: "block",
    //       type: "add_slider",
    //     },
    //     {
    //       kind: "block",
    //       type: "add_number",
    //     },
    //   ],
    // },
    // {
    //   kind: "category",
    //   name: "Magos动作",
    //   colour: 100,
    //   contents: [
    //     {
    //       kind: "block",
    //       type: "left_hand_up",
    //     },
    //     {
    //       kind: "block",
    //       type: "left_hand_down",
    //     },
    //     {
    //       kind: "block",
    //       type: "right_hand_up",
    //     },
    //     {
    //       kind: "block",
    //       type: "right_hand_down",
    //     },
    //     {
    //       kind: "block",
    //       type: "embrace",
    //     },
    //   ],
    // },
    {
      kind: "category",
      name: "Magos动作组",
      colour: 100,
      contents: [
        {
          kind: "block",
          type: "ServoControl",
        },
        {
          kind: "block",
          type: "test001",
        },
        {
          kind: "block",
          type: "test002",
        },
        {
          kind:"block",
          type: "animations_start",
        },
        {
          kind:"block",
          type:"magos_arm"
        }
      ],
    },
  ],
};

Blockly.Python.forBlock["magos_arm"] = function (block, generator) {
  const _arm = block.getFieldValue("arm");
  return `magos.arm(magos.${_arm})\n`;
};
Blockly.Python.forBlock["ServoControl"] = function (block, generator) {
  const _servoIndex = block.getFieldValue("servoIndex");
  const _angle = block.getFieldValue("angle");
  return `magos.set_robot_server(${_servoIndex},${_angle})\n`;
};
Blockly.Python.forBlock["animations_start"] = function (block, generator) {
  const _name = block.getFieldValue("actions_name");
  return `magos.animations_start("${_name}")\n`;
}

Blockly.Python.forBlock["test001"] = function (block, generator) {
  return `print("动画组")`;
};
Blockly.Python.forBlock["test002"] = function (block, generator) {
  return `print("动画")`;
};

Blockly.Python.forBlock["add_angle"] = function (block, generator) {
  const _single = block.getFieldValue("single");
  return "single = " + _single;
};
Blockly.Python.forBlock["add_slider"] = function (block, generator) {
  const _slider = block.getFieldValue("slider");
  return "slider = " + _slider;
};
Blockly.Python.forBlock["add_colour"] = function (block, generator) {
  const _colour = block.getFieldValue("colour");
  return "colour = " + _colour;
};
Blockly.Python.forBlock["left_hand_up"] = function (block, generator) {
  return "magos.left_hand_up()\n";
};
Blockly.Python.forBlock["left_hand_down"] = function (block, generator) {
  return "magos.left_hand_down()\n";
};

Blockly.Python.forBlock["right_hand_up"] = function (block, generator) {
  return "magos.right_hand_up()\n";
};

Blockly.Python.forBlock["right_hand_down"] = function (block, generator) {
  return "magos.right_hand_down()\n";
};

Blockly.Python.forBlock["embrace"] = function (block, generator) {
  return "Test()\n";
};
