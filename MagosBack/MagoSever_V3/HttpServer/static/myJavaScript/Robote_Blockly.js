// ==========================================
// Robote_Blockly.js - Custom Block Definitions
// ==========================================

console.log("[Magos] Robote_Blockly.js 已加载");

// 确保在 Blockly 加载后执行
let retryCount = 0;
function initCustomBlocks() {
    if (typeof Blockly === 'undefined' || !Blockly.Blocks) {
        if (retryCount < 5) { // 只在前5次打印警告，避免刷屏
            console.warn("[Magos] Blockly 未就绪，延迟初始化... (Attempt " + (retryCount + 1) + ")");
        }
        retryCount++;
        setTimeout(initCustomBlocks, 100);
        return;
    }

    // 定义 play_background_audio 积木
    Blockly.Blocks['play_background_audio'] = {
        init: function() {
            this.jsonInit({
                "type": "play_background_audio",
                "message0": "%{BKY_MAGOS_PLAY_BG_MUSIC_TITLE}",
                "args0": [
                    {
                        "type": "field_dropdown",
                        "name": "background_audio_index",
                        "options": function() {
                            // 动态获取下拉菜单选项
                            // 优先使用 custom_logic.js 维护的全局列表
                            if (window.magosMusicList && window.magosMusicList.length > 0) {
                                return window.magosMusicList;
                            }
                            // 默认显示等待
                            return [['正在等待蓝牙更新...', 'WAITING']];
                        }
                    }
                ],
                "colour": 80,
                "previousStatement": null,
                "nextStatement": null,
                "tooltip": "播放背景音乐",
                "helpUrl": ""
            });
        }
    };

    console.log("[Magos] 积木 play_background_audio 定义已更新");
}

// 尝试初始化
initCustomBlocks();
