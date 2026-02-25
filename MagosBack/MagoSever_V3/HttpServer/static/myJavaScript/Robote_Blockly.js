const definitions = Blockly.common.createBlockDefinitionsFromJsonArray([
  {
    // The type is like the "class name" for your block. It is used to construct
    // new instances. E.g. in the toolbox.
    type: "my_custom_block",
    // The message defines the basic text of your block, and where inputs or
    // fields will be inserted.
    message0: "move forward %1 _manbo %2",
    args0: [
      // Each arg is associated with a %# in the message.
      // This one gets substituted for %1.
      {
        // The type specifies the kind of input or field to be inserted.
        type: "field_number",
        // The name allows you to reference the field and get its value.
        name: "FIELD_NAME",
      },
      {
        type: "field_number",
        name: "man",
      },
    ],
    // Adds an untyped previous connection to the top of the block.
    previousStatement: null,
    // Adds an untyped next connection to the bottom of the block.
    nextStatement: null,
  },
  {
    type: "my_forward",
    message0: "forward %1",
    args0: [
      {
        type: "input_value",
        name: "VALUE",
        check: "String",
      },
    ],
    output: "Number",
    colour: 16,
    tooltip: "Returns number of letters in the provided text.",
    helpUrl: "http://www.w3schools.com/jsref/jsref_length_string.asp",
  },
  {
    type: "robot_single",
    message0: "舵机%1 旋转%2 度数",
    args0: [
      {
        type: "input_value",
        name: "raw_index",
        // check: "Number",
      },
      {
        type: "field_angle",
        name: "single",
        value: 50,
        // check: "Number",
      },
    ],
    output: "Number",
  },
  {
    type: "add_voice",
    message0: "给机器人添加语音：%1",
    args0: [
      {
        type: "input_value",
        name: "raw_index",
        check: "String",
      },
    ],
  },
]);
// Register the definition.
Blockly.common.defineBlocks(definitions);

// 导入多选插件 (假设环境支持 ES Module 或已经在 global 中加载)
// 注意：由于这是一个独立文件，我们可能需要在 bundle.js 构建流程中引入插件
// 这里我们尝试通过全局对象访问，如果插件未被挂载到 window，这部分代码需要移到入口文件

document.addEventListener('DOMContentLoaded', function() {
    // 等待 Blockly 工作区初始化
    // 通常 workspace 是全局变量或者可以通过 Blockly.getMainWorkspace() 获取
    
    // 设置定时器以确保工作区已完全加载
    setTimeout(() => {
        const workspace = Blockly.getMainWorkspace();
        if (workspace) {
            console.log("初始化多选插件...");
            
            // 尝试初始化多选插件
            try {
                // 检查 Multiselect 是否可用 (取决于它是如何被打包的)
                // 如果使用的是 @mit-app-inventor/blockly-plugin-workspace-multiselect
                if (typeof Multiselect !== 'undefined') {
                    const multiselectPlugin = new Multiselect(workspace);
                    multiselectPlugin.init({
                        multiSelectKeys: ['Control'], // 使用 Ctrl 键进行多选
                        multiselectIcon: {
                            hideIcon: false,
                            weight: 3,
                            enabledIcon: 'https://github.com/mit-cml/workspace-multiselect/raw/main/test/media/select.svg',
                            disabledIcon: 'https://github.com/mit-cml/workspace-multiselect/raw/main/test/media/unselect.svg',
                        }
                    });
                    console.log("多选插件初始化成功！按住 Ctrl 点击积木即可多选。");
                } else {
                    console.warn("未找到 Multiselect 插件定义。请确保已在 bundle.js 中正确导入并暴露该插件。");
                    // 提示用户可能需要重新打包
                    console.log("提示：需要在入口文件中添加: import { Multiselect } from '@mit-app-inventor/blockly-plugin-workspace-multiselect'; 并将其挂载到 window.Multiselect");
                }
            } catch (e) {
                console.error("多选插件初始化失败:", e);
            }
        }
    }, 1000); // 延迟 1 秒
});
