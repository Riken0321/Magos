
# 注入代码：引入多选插件并初始化
# 我们使用 unpkg CDN 来加载插件，因为本地 node_modules 可能未被打包
INJECT_CODE = r"""
;(function() {
    console.log("正在尝试加载 Blockly 多选插件...");

    // 动态加载插件脚本
    var script = document.createElement('script');
    script.src = "https://unpkg.com/@mit-app-inventor/blockly-plugin-workspace-multiselect@latest/dist/index.js";
    script.onload = function() {
        console.log("多选插件脚本加载成功！");
        
        // 等待 Blockly 初始化
        var checkBlockly = setInterval(function() {
            if (typeof Blockly !== 'undefined' && Blockly.getMainWorkspace()) {
                clearInterval(checkBlockly);
                var workspace = Blockly.getMainWorkspace();
                
                // 检查插件是否已挂载到全局对象 (通常插件会挂载到 window.Blockly.WorkspaceMultiselect 或类似位置)
                // @mit-app-inventor/blockly-plugin-workspace-multiselect 导出的全局变量通常是 Multiselect
                
                if (typeof Multiselect !== 'undefined') {
                    initPlugin(workspace, Multiselect);
                } else if (window.Blockly && window.Blockly.Multiselect) {
                    initPlugin(workspace, window.Blockly.Multiselect);
                } else {
                    console.warn("未找到 Multiselect 全局对象，尝试通过 window 查找...");
                    // 遍历 window 查找可能的插件对象
                    console.log(window);
                }
            }
        }, 500);
    };
    script.onerror = function() {
        console.error("多选插件脚本加载失败！请检查网络连接。");
    };
    document.head.appendChild(script);

    function initPlugin(workspace, PluginClass) {
        try {
            console.log("开始初始化多选功能 (Ctrl + Click)...");
            var multiselectPlugin = new PluginClass(workspace);
            multiselectPlugin.init({
                multiSelectKeys: ['Control'],
                multiselectIcon: {
                    hideIcon: false,
                    weight: 3,
                    enabledIcon: 'https://github.com/mit-cml/workspace-multiselect/raw/main/test/media/select.svg',
                    disabledIcon: 'https://github.com/mit-cml/workspace-multiselect/raw/main/test/media/unselect.svg',
                }
            });
            console.log("多选功能已就绪！按住 Ctrl 键点击积木即可多选。");
        } catch (e) {
            console.error("插件初始化出错:", e);
        }
    }
})();
"""

file_path = r'D:\MagoMaster\MagoSever_V3\HttpServer\static\bundle.js'

try:
    with open(file_path, 'a', encoding='utf-8') as f:
        f.write(INJECT_CODE)
    print("成功将多选插件逻辑注入到 bundle.js 中！")
except Exception as e:
    print(f"注入失败: {e}")
