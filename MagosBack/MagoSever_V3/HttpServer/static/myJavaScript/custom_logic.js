// ==========================================
// Magos Custom Logic - Real-time Music Sync & UI Fixes
// ==========================================

console.log("[Magos] custom_logic.js 已成功加载！");

// 全局音乐列表缓存
window.magosMusicList = [];

// ============ 1. 核心轮询逻辑 ============
async function syncMusicList() {
    console.log("[Magos] 正在同步音乐列表...");
    try {
        // 1. 获取后端数据
        const response = await fetch('/api/music_data');
        if (!response.ok) throw new Error("Network response was not ok");
        
        const data = await response.json();
        
        // 2. 解析数据 (兼容 data.json 的多种格式)
        let rawList = [];
        if (Array.isArray(data)) {
            rawList = data;
        } else if (data.music && Array.isArray(data.music)) {
            rawList = data.music;
        } else if (data.actions && Array.isArray(data.actions)) {
            rawList = data.actions;
        }

        // 3. 格式化数据
        // A. 格式化为 Blockly 下拉菜单格式 [[Name, Name], ...]
        const newList = rawList.map((item, index) => {
            let name = "Unknown";
            let id = String(index + 1);

            if (Array.isArray(item) && item.length >= 2) {
                name = item[0];
                id = String(item[1]);
            } else if (typeof item === 'object' && item.name) {
                name = item.name;
                // 尝试从文件名提取数字 ID
                const nameMatch = item.name.match(/^(\d+)/);
                if (nameMatch) id = nameMatch[1];
                else id = String(index + 1);
            }
            return [name, name];
        });

        // B. 格式化为 bundle.js 原生 localStorage 格式 [{id, title, artist}, ...]
        // 这样即使不覆盖积木定义，bundle.js 原生逻辑也能读到新数据
        const nativeStorageList = newList.map((item, index) => ({
            id: String(index + 1),
            title: item[0],
            artist: ""
        }));

        // 4. 检查更新与写入
        const oldStr = JSON.stringify(window.magosMusicList);
        const newStr = JSON.stringify(newList);
        
        // 无论是否有变化，都强制写入 localStorage，防止被 bundle.js 重置
        // 写入 localStorage "miniCachedSongs_v5" 以兼容 bundle.js 原生逻辑
        localStorage.setItem("miniCachedSongs_v5", JSON.stringify(nativeStorageList));

        if (oldStr !== newStr) {
            console.log("[Magos] 状态改变！旧:", window.magosMusicList.length, "新:", newList.length);
            window.magosMusicList = newList;
            
            // 更新 UI 状态条
            updateStatusDisplay(newList.length);

            // 5. 触发 UI 刷新
            updateBlocklyUI();
        } else {
             // 即使列表没变，也要定期更新状态条，证明我们还在工作
             updateStatusDisplay(newList.length);
        }

    } catch (error) {
        console.error("[Magos] Polling error:", error);
        updateStatusDisplay("Error");
    }
}

// ============ 新增：UI 状态显示条 (类似 Battery) ============
function createStatusDisplay() {
    let el = document.getElementById('MagosMusicStatus');
    if (!el) {
        el = document.createElement('div');
        el.id = 'MagosMusicStatus';
        el.style.position = 'fixed';
        el.style.bottom = '10px';
        el.style.right = '10px'; // 放在右下角
        el.style.padding = '8px 12px';
        el.style.background = 'rgba(0, 0, 0, 0.7)';
        el.style.color = '#00ff00';
        el.style.borderRadius = '5px';
        el.style.fontFamily = 'monospace';
        el.style.fontSize = '14px';
        el.style.zIndex = '9999';
        el.style.pointerEvents = 'none'; // 不阻挡点击
        el.innerHTML = 'Music: Init...';
        document.body.appendChild(el);
    }
    return el;
}

function updateStatusDisplay(countOrError) {
    const el = document.getElementById('MagosMusicStatus');
    if (el) {
        if (countOrError === "Error") {
             el.style.color = '#ff0000';
             el.innerText = 'Music: Connection Failed';
        } else {
             el.style.color = '#00ff00';
             el.innerText = `Music List: ${countOrError} Songs (Synced)`;
        }
    }
}

// ============ 2. Blockly 强制刷新逻辑 ============
function updateBlocklyUI() {
    try {
        // 尝试获取工作区 (兼容不同版本)
        let workspace = null;
        if (typeof Blockly !== 'undefined') {
            if (Blockly.getMainWorkspace) workspace = Blockly.getMainWorkspace();
            else if (Blockly.common && Blockly.common.getMainWorkspace) workspace = Blockly.common.getMainWorkspace();
            else if (Blockly.mainWorkspace) workspace = Blockly.mainWorkspace;
        }

        if (!workspace) {
            console.warn("[Magos] 未找到 Blockly 工作区，跳过刷新");
            return;
        }

        // A. 强制刷新工具箱 (Toolbox)
        if (workspace.refreshToolbox) {
            workspace.refreshToolbox(); // 刷新左侧菜单
        } else if (workspace.getToolbox && workspace.getToolbox().refreshSelection) {
            workspace.getToolbox().refreshSelection();
        }

        // A2. 再次强制覆盖积木定义 (防止 bundle.js 后加载覆盖了我们的定义)
        if (Blockly.Blocks['play_background_audio']) {
             Blockly.Blocks['play_background_audio'].init = function() {
                this.jsonInit({
                    "type": "play_background_audio",
                    "message0": "%{BKY_MAGOS_PLAY_BG_MUSIC_TITLE}",
                    "args0": [
                        {
                            "type": "field_dropdown",
                            "name": "background_audio_index",
                            "options": getDynamicMusicOptions
                        }
                    ],
                    "colour": 80,
                    "previousStatement": null,
                    "nextStatement": null,
                    "tooltip": "播放背景音乐 (实时更新)",
                    "helpUrl": ""
                });
            };
        }

        // B. "热修补" 现有的积木实例
        // 这一步至关重要！它会强制当前画布上已经拖出来的积木更新其下拉菜单
        const blocks = workspace.getAllBlocks();
        let patchCount = 0;
        
        blocks.forEach(block => {
            if (block.type === 'play_background_audio') {
                const field = block.getField('background_audio_index');
                if (field) {
                    // 1. 强制替换菜单生成器函数
                    field.menuGenerator_ = getDynamicMusicOptions;
                    // 2. 清除缓存，强制下次点击时重新计算
                    field.generatedOptions_ = null; 
                    
                    // 3. 尝试强制刷新显示 (通过 setValue 触发)
                    // 获取当前值，重新设置一遍，触发 Text 更新
                    const currentValue = field.getValue();
                    field.setValue(currentValue);
                    // 也可以尝试强制渲染
                    if (block.render) block.render();
                    
                    patchCount++;
                }
            }
        });

        if (patchCount > 0) {
            console.log(`[Magos] 已热修补 ${patchCount} 个积木实例`);
        }

        console.log("[Magos] 列表已更新，UI 已刷新！");

    } catch (e) {
        console.error("[Magos] UI Update Failed:", e);
    }
}

// ============ 3. 动态下拉菜单回调 ============
function getDynamicMusicOptions() {
    if (window.magosMusicList && window.magosMusicList.length > 0) {
        return window.magosMusicList;
    }
    return [['正在等待蓝牙更新...', 'WAITING']];
}

// ============ 4. 劫持/修复按钮逻辑 ============
function hijackButtons() {
    // 修复 "播放" 按钮 (BtnPlay) - 解决 404 问题
    // 注意：index.html 中 ID 为 "BtnPlay"，之前误写为 "BtnMusicPlay"
    const btnMusicPlay = document.getElementById('BtnPlay');
    if (btnMusicPlay) {
        // 克隆节点以移除所有旧的事件监听器 (bundle.js 绑定的)
        const newBtn = btnMusicPlay.cloneNode(true);
        btnMusicPlay.parentNode.replaceChild(newBtn, btnMusicPlay);
        
        console.log("[Magos] 已劫持 BtnPlay 按钮");

        // 绑定新逻辑
        newBtn.addEventListener('click', async () => {
            console.log("[Magos] 点击播放 (新逻辑)");
            // 获取当前选中的音乐 (这里简化为播放第一首，或者你可以从 UI 获取选中的索引)
            // 由于 UI 比较复杂，我们先假设播放列表的第一首，或者弹窗询问
            // 为了简单，我们调用一个新的接口播放指定 ID
            
            // 这里我们做一个假设：用户在积木里选什么，这里就播什么？
            // 不，MusicPanel 有自己的选择逻辑。我们尝试获取 ParagraphSongTitle 的内容
            const songTitleEl = document.getElementById('ParagraphSongTitle');
            let songName = "";
            
            // 统一按歌曲名发送，不再按 ID/index 发送
            if (songTitleEl && typeof songTitleEl.innerText === "string") {
                songName = songTitleEl.innerText.trim();
            }
            if (!songName && window.magosMusicList.length > 0) {
                songName = String(window.magosMusicList[0][0] || "").trim();
            }
            if (!songName) {
                alert("未选择歌曲");
                return;
            }

            try {
                const res = await fetch('/api/play_music', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ name: songName })
                });
                const resData = await res.json();
                console.log("[Magos] 播放结果:", resData);
                if (!res.ok || Number(resData.code) !== 200) {
                    alert("播放失败: " + (resData.msg || resData.message || "Unknown error"));
                }
            } catch (e) {
                console.error("播放请求失败", e);
            }
        });
    }
}

// ============ 5. 初始化与覆盖定义 ============
window.addEventListener('load', function() {
    console.log("[Magos] Window Loaded. Initializing fixes...");

    // 1. 启动轮询 (每 2 秒)
    createStatusDisplay(); // 创建状态条
    setInterval(syncMusicList, 2000);
    syncMusicList(); // 立即执行一次

    // 2. 劫持按钮
    hijackButtons();

    // 3. 覆盖 Blockly 定义 (防止新拖出来的积木是旧的)
    if (typeof Blockly !== 'undefined' && Blockly.Blocks) {
        // 确保 Blocks 对象存在
        if (!Blockly.Blocks['play_background_audio']) {
            Blockly.Blocks['play_background_audio'] = {};
        }

        // 保存原始 init (如果有)
        const originalInit = Blockly.Blocks['play_background_audio'].init;

        Blockly.Blocks['play_background_audio'].init = function() {
            // 定义积木结构
            this.jsonInit({
                "type": "play_background_audio",
                "message0": "%{BKY_MAGOS_PLAY_BG_MUSIC_TITLE}", // 使用多语言 Key
                "args0": [
                    {
                        "type": "field_dropdown",
                        "name": "background_audio_index",
                        "options": getDynamicMusicOptions // 绑定动态函数
                    }
                ],
                "colour": 80,
                "previousStatement": null,
                "nextStatement": null,
                "tooltip": "播放背景音乐 (实时更新)",
                "helpUrl": ""
            });
        };
        
        console.log("[Magos] 成功覆盖 'play_background_audio' 积木定义！");
    } else {
        console.error("[Magos] Blockly 未定义，无法覆盖积木！");
    }
};
