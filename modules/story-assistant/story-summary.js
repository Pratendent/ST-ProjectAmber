/**
 * 故事总结功能模块
 * 让AI对聊天历史进行故事总结并保存到世界书
 */

// 依赖从主模块获取
let dependencies = null;
// 保存设置的回调
let saveSettingsCallback = null;

/**
 * 初始化模块依赖
 * @param {object} deps - 依赖对象
 */
export function init(deps) {
    dependencies = deps;
}

/**
 * 获取模块元信息
 */
export function getModuleInfo() {
    return {
        id: 'story-summary',
        name: '故事总结',
        description: '让AI对聊天历史进行故事总结',
        icon: '📖'
    };
}

/**
 * HTML 转义
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * 获取位置显示文本
 */
function getPositionText(position, depth) {
    const positionMap = {
        0: '角色定义之前',
        1: '角色定义之后',
        2: '作者注释之前',
        3: '作者注释之后',
        4: `@ Depth ${depth || 4}`
    };
    return positionMap[position] || '角色定义之前';
}

/**
 * 获取当前聊天的唯一标识（用于按聊天记录已总结楼层）
 */
function getChatKey() {
    const { getContext } = dependencies;
    const ctx = getContext();
    const charName = ctx.name2 || 'unknown';
    return charName;
}

/**
 * 获取当前聊天已总结的最后楼层数
 */
function getLastSummarizedFloor() {
    const { getSettings, defaultSettings } = dependencies;
    const settings = getSettings();
    const storySummary = settings.storySummary || defaultSettings.storySummary;
    const floors = storySummary.summarizedFloors || {};
    const key = getChatKey();
    return floors[key] || 0;
}

/**
 * 设置当前聊天已总结的最后楼层数
 */
function setLastSummarizedFloor(floor) {
    const { getSettings, defaultSettings } = dependencies;
    const settings = getSettings();
    if (!settings.storySummary) {
        settings.storySummary = { ...defaultSettings.storySummary };
    }
    if (!settings.storySummary.summarizedFloors) {
        settings.storySummary.summarizedFloors = {};
    }
    const key = getChatKey();
    settings.storySummary.summarizedFloors[key] = floor;
    if (saveSettingsCallback) saveSettingsCallback();
}

/**
 * 获取当前聊天总楼层数
 */
function getTotalFloors() {
    const { getContext } = dependencies;
    const ctx = getContext();
    return (ctx.chat || []).length;
}

// ==================== 提示词构建 ====================

/**
 * 构建故事总结的消息
 * @param {object} vars - 变量对象
 * @returns {Array}
 */
function buildSummaryMessages(vars) {
    const { getSettings, defaultSettings } = dependencies;
    const settings = getSettings();
    const storySummary = settings.storySummary || defaultSettings.storySummary;

    const prompts = {
        u1: storySummary.promptU1,
        a1: storySummary.promptA1,
        u2: storySummary.promptU2,
        a2: storySummary.promptA2
    };

    const replaceVars = (template) => {
        return template
            .replace(/\{\{user\}\}/g, vars.userName || '{{user}}')
            .replace(/\{\{char\}\}/g, vars.charName || '{{char}}')
            .replace(/\{\{description\}\}/g, vars.description || '')
            .replace(/\{\{persona\}\}/g, vars.persona || '')
            .replace(/\{\{worldInfo\}\}/g, vars.worldInfo || '')
            .replace(/\{\{chatHistory\}\}/g, vars.chatHistory || '');
    };

    return [
        { role: 'user', content: replaceVars(prompts.u1) },
        { role: 'assistant', content: replaceVars(prompts.a1) },
        { role: 'user', content: replaceVars(prompts.u2) },
        { role: 'assistant', content: replaceVars(prompts.a2) }
    ];
}

// ==================== 世界书操作 ====================

/**
 * 获取当前世界书条目信息
 * @returns {Promise<{entry: object|null, worldbook: string|null}>}
 */
async function getCurrentWorldbookEntry() {
    const { getSettings, getCharacterWorldbook, loadWorldInfo, world_names, defaultSettings } = dependencies;
    const settings = getSettings();
    const storySummary = settings.storySummary || defaultSettings.storySummary;
    const entryName = storySummary.entryName || '故事总结';
    let targetBook = settings.targetWorldbook || getCharacterWorldbook();

    if (!targetBook || !world_names?.includes(targetBook)) {
        return { entry: null, worldbook: null };
    }

    try {
        const worldData = await loadWorldInfo(targetBook);
        if (!worldData?.entries) {
            return { entry: null, worldbook: targetBook, worldData };
        }

        const entriesArray = Object.values(worldData.entries);
        const entry = entriesArray.find(e => e && e.comment === entryName);

        return { entry: entry || null, worldbook: targetBook, worldData };
    } catch (e) {
        console.error(`[故事总结] 获取世界书条目失败:`, e);
        return { entry: null, worldbook: targetBook };
    }
}

/**
 * 保存内容到世界书（追加模式）
 * @param {string} content - 要保存的内容
 * @param {object} options - 条目属性选项
 * @returns {Promise<{success: boolean, isAppend?: boolean, error?: string}>}
 */
async function saveToWorldbook(content, options = {}) {
    const {
        getSettings,
        getCharacterWorldbook,
        loadWorldInfo,
        saveWorldInfo,
        world_names
    } = dependencies;

    try {
        const settings = getSettings();
        const storySummary = settings.storySummary || dependencies.defaultSettings.storySummary;
        const entryName = storySummary.entryName || '故事总结';
        let targetBook = settings.targetWorldbook || getCharacterWorldbook();

        if (!targetBook || !world_names?.includes(targetBook)) {
            return { success: false, error: "未找到有效的世界书，请先绑定或选择世界书" };
        }

        const worldData = await loadWorldInfo(targetBook);
        if (!worldData) {
            return { success: false, error: `无法加载世界书: ${targetBook}` };
        }

        let entry = null;
        let isAppend = false;

        if (worldData.entries && typeof worldData.entries === 'object') {
            const entriesArray = Object.values(worldData.entries);
            entry = entriesArray.find(e => e && e.comment === entryName);
        }

        if (!entry) {
            const { createWorldInfoEntry } = await import("../../../../world-info.js");
            entry = createWorldInfoEntry(targetBook, worldData);
            if (!entry) {
                return { success: false, error: "创建世界书条目失败" };
            }
        } else {
            isAppend = true;
        }

        // 如果条目已存在，在下方追加新内容
        let finalContent;
        if (isAppend && entry.content) {
            finalContent = `${entry.content.trim()}\n\n${content.trim()}\n\n`;
        } else {
            finalContent = content.trim() + '\n\n';
        }

        const position = options.position ?? storySummary.entryPosition ?? 0;
        Object.assign(entry, {
            comment: entryName,
            content: finalContent,
            constant: true,
            selective: true,
            disable: false,
            position: position,
            depth: position === 4 ? (options.depth ?? storySummary.entryDepth ?? 4) : undefined,
            order: options.order ?? storySummary.entryOrder ?? 100,
        });

        await saveWorldInfo(targetBook, worldData, true);

        return { success: true, uid: String(entry.uid), worldbook: targetBook, isAppend };
    } catch (e) {
        console.error(`[故事总结] 保存条目失败:`, e);
        return { success: false, error: e.message };
    }
}

/**
 * 覆盖保存条目内容（用于手动编辑保存）
 * @param {string} content - 条目内容
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function saveEntryOverwrite(content) {
    const {
        getSettings,
        getCharacterWorldbook,
        loadWorldInfo,
        saveWorldInfo,
        world_names
    } = dependencies;

    try {
        const settings = getSettings();
        const storySummary = settings.storySummary || dependencies.defaultSettings.storySummary;
        const entryName = storySummary.entryName || '故事总结';
        let targetBook = settings.targetWorldbook || getCharacterWorldbook();

        if (!targetBook || !world_names?.includes(targetBook)) {
            return { success: false, error: "未找到有效的世界书，请先绑定或选择世界书" };
        }

        const worldData = await loadWorldInfo(targetBook);
        if (!worldData) {
            return { success: false, error: `无法加载世界书: ${targetBook}` };
        }

        let entry = null;

        if (worldData.entries && typeof worldData.entries === 'object') {
            const entriesArray = Object.values(worldData.entries);
            entry = entriesArray.find(e => e && e.comment === entryName);
        }

        if (!entry) {
            const { createWorldInfoEntry } = await import("../../../../world-info.js");
            entry = createWorldInfoEntry(targetBook, worldData);
            if (!entry) {
                return { success: false, error: "创建世界书条目失败" };
            }
        }

        const position = storySummary.entryPosition ?? 0;
        Object.assign(entry, {
            comment: entryName,
            content: content,
            constant: true,
            selective: true,
            disable: false,
            position: position,
            depth: position === 4 ? (storySummary.entryDepth ?? 4) : undefined,
            order: storySummary.entryOrder ?? 100,
        });

        await saveWorldInfo(targetBook, worldData, true);

        return { success: true };
    } catch (e) {
        console.error(`[故事总结] 保存条目失败:`, e);
        return { success: false, error: e.message };
    }
}

// ==================== JSON 转 YAML ====================

/**
 * 简单修复常见 JSON 语法问题
 */
function fixSimpleJson(s) {
    if (!s) return s;
    let r = s.trim()
        .replace(/[""]/g, '"').replace(/['']/g, "'")
        .replace(/,[\s\n]*([}\]])/g, '$1');

    // 补全未闭合的括号
    let braces = 0, brackets = 0, inStr = false, esc = false;
    for (const c of r) {
        if (esc) { esc = false; continue; }
        if (c === '\\' && inStr) { esc = true; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (!inStr) {
            if (c === '{') braces++; else if (c === '}') braces--;
            if (c === '[') brackets++; else if (c === ']') brackets--;
        }
    }
    while (braces-- > 0) r += '}';
    while (brackets-- > 0) r += ']';
    return r;
}

/**
 * 在文本中查找 JSON 候选块
 */
function findJsonCandidates(text) {
    const candidates = [];

    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c !== '{' && c !== '[') continue;

        let depth = 0, inString = false, esc = false;
        for (let j = i; j < text.length; j++) {
            const ch = text[j];
            if (esc) { esc = false; continue; }
            if (ch === '\\' && inString) { esc = true; continue; }
            if (ch === '"') { inString = !inString; continue; }
            if (inString) continue;
            if (ch === '{' || ch === '[') depth++;
            else if (ch === '}' || ch === ']') depth--;
            if (depth === 0) {
                candidates.push({ start: i, end: j + 1, text: text.slice(i, j + 1) });
                break;
            }
        }
    }

    // 按长度降序排列（优先处理最大的块）
    candidates.sort((a, b) => (b.end - b.start) - (a.end - a.start));
    return candidates;
}

/**
 * 处理文本中的 JSON，将其转换为 YAML
 * @param {string} text - 原始文本
 * @returns {string} 处理后的文本
 */
function processJsonToYaml(text) {
    if (!text) return text;
    const { jsonToYaml } = dependencies;

    let result = text;

    // 1. 先尝试处理 ```json ... ``` 代码块
    const codeBlockRegex = /```(?:json)?\s*\n?([\s\S]*?)\n?```/g;
    let hasCodeBlocks = false;

    result = result.replace(codeBlockRegex, (match, content) => {
        const trimmed = content.trim();
        if ((trimmed.startsWith('{') || trimmed.startsWith('[')) &&
            (trimmed.endsWith('}') || trimmed.endsWith(']'))) {
            try {
                const parsed = JSON.parse(trimmed);
                hasCodeBlocks = true;
                return jsonToYaml(parsed, 0);
            } catch {
                try {
                    const fixed = fixSimpleJson(trimmed);
                    const parsed = JSON.parse(fixed);
                    hasCodeBlocks = true;
                    return jsonToYaml(parsed, 0);
                } catch {
                    return match;
                }
            }
        }
        return match;
    });

    if (hasCodeBlocks) return result;

    // 2. 如果没有代码块，尝试查找内联 JSON
    const jsonCandidates = findJsonCandidates(result);

    for (const candidate of jsonCandidates) {
        try {
            const parsed = JSON.parse(candidate.text);
            const yaml = jsonToYaml(parsed, 0);
            result = result.slice(0, candidate.start) + yaml + result.slice(candidate.end);
            break; // 替换后索引变化，只处理一个最大的
        } catch {
            try {
                const fixed = fixSimpleJson(candidate.text);
                const parsed = JSON.parse(fixed);
                const yaml = jsonToYaml(parsed, 0);
                result = result.slice(0, candidate.start) + yaml + result.slice(candidate.end);
                break;
            } catch {
                continue;
            }
        }
    }

    return result;
}

// ==================== 核心逻辑 ====================

/**
 * 获取完整提示词预览数据
 * @param {number} startFloor - 起始楼层
 * @param {number} endFloor - 结束楼层
 * @returns {Promise<{messages: Array, vars: object}>}
 */
async function getPromptPreviewData(startFloor, endFloor) {
    const { getSettings, getContext, getChatHistoryRange, getWorldInfoContent, power_user, defaultSettings } = dependencies;
    const settings = getSettings();
    const ctx = getContext();

    const char = ctx.characters?.[ctx.characterId];
    const description = char?.description || char?.data?.description || '';
    const persona = power_user?.persona_description || '';
    const userName = ctx.name1 || '{{user}}';
    const charName = char?.name || ctx.name2 || '{{char}}';

    const chatHistory = getChatHistoryRange(startFloor, endFloor);
    const worldInfo = await getWorldInfoContent({
        activatedOnly: true,
        startLayer: startFloor,
        endLayer: endFloor
    });

    const vars = {
        userName,
        charName,
        description,
        persona,
        worldInfo,
        chatHistory
    };

    const messages = buildSummaryMessages(vars);

    return { messages, vars };
}

/**
 * 运行故事总结
 * @param {function} showStatus - 状态显示回调
 * @param {number} startFloor - 起始楼层
 * @param {number} endFloor - 结束楼层
 * @returns {Promise<{success: boolean, content?: string, error?: string}>}
 */
async function runSummary(showStatus, startFloor, endFloor) {
    const { callLLM } = dependencies;

    showStatus("正在生成故事总结...");

    try {
        const { messages } = await getPromptPreviewData(startFloor, endFloor);

        console.log(`[故事总结] 开始总结 (楼层 ${startFloor}~${endFloor})...`);

        const result = await callLLM(messages);

        if (!result || !result.trim()) {
            showStatus("未能生成总结内容", true);
            return { success: false, error: "未能生成总结内容" };
        }

        // 处理 JSON 转 YAML
        const processedResult = processJsonToYaml(result);

        console.log(`[故事总结] 总结生成成功`);
        showStatus("总结生成成功");

        return { success: true, content: processedResult };

    } catch (e) {
        console.error(`[故事总结] 总结失败:`, e);
        showStatus(`总结失败: ${e.message}`, true);
        return { success: false, error: e.message };
    }
}

// ==================== UI ====================

/**
 * 显示主弹窗
 */
export function showModal() {
    ensureModalExists();
    $('#jtw-story-summary-modal').fadeIn(200);
    switchTab('entry');
    loadEntryContent();
}

/**
 * 隐藏主弹窗
 */
function hideModal() {
    $('#jtw-story-summary-modal').fadeOut(200);
}

/**
 * 切换标签页
 */
function switchTab(tabName) {
    $('.jtw-ss-tab').removeClass('active');
    $(`.jtw-ss-tab[data-tab="${tabName}"]`).addClass('active');
    $('.jtw-ss-tab-content').removeClass('active');
    $(`#jtw-ss-tab-${tabName}`).addClass('active');
}

/**
 * 加载条目内容到编辑区
 */
async function loadEntryContent() {
    const { getSettings, defaultSettings } = dependencies;
    const settings = getSettings();
    const storySummary = settings.storySummary || defaultSettings.storySummary;
    const { entry, worldbook } = await getCurrentWorldbookEntry();

    // 更新已总结楼层显示
    const lastFloor = getLastSummarizedFloor();
    if (lastFloor > 0) {
        $('#jtw-ss-summarized-info').text(`已总结${lastFloor}层楼`).show();
    } else {
        $('#jtw-ss-summarized-info').text('尚未进行过总结').show();
    }

    const $emptyHint = $('#jtw-ss-entry-empty');
    const $editor = $('#jtw-ss-entry-editor');
    const $content = $('#jtw-ss-entry-content');
    const $info = $('#jtw-ss-entry-info');

    if (!entry || !entry.content) {
        $emptyHint.show();
        $editor.hide();
        return;
    }

    $emptyHint.hide();
    $editor.show();
    $content.val(entry.content);

    // 显示条目信息
    const positionText = getPositionText(entry.position, entry.depth);
    $info.html(`
        <span><strong>世界书:</strong> ${escapeHtml(worldbook || '未知')}</span>
        <span><strong>条目名称:</strong> ${escapeHtml(storySummary.entryName || '故事总结')}</span>
        <span><strong>位置:</strong> ${positionText}</span>
        <span><strong>排序:</strong> ${entry.order || 100}</span>
    `);
}

/**
 * 保存条目编辑（覆盖方式，用于手动编辑）
 */
async function saveEntryEdit() {
    const content = $('#jtw-ss-entry-content').val();
    const $saveBtn = $('#jtw-ss-save-entry');
    const $status = $('#jtw-ss-entry-status');

    $saveBtn.prop('disabled', true).text('保存中...');

    const result = await saveEntryOverwrite(content);

    if (result.success) {
        $status.text('保存成功').removeClass('error').addClass('success').show();
    } else {
        $status.text(result.error).removeClass('success').addClass('error').show();
    }

    $saveBtn.prop('disabled', false).text('保存修改');
    setTimeout(() => $status.fadeOut(), 3000);
}

/**
 * 加载提示词预览
 */
async function loadPromptPreview(startFloor, endFloor) {
    const $container = $('#jtw-ss-prompt-preview');
    $container.html('<div class="jtw-ss-loading">加载中...</div>');

    try {
        const { messages } = await getPromptPreviewData(startFloor, endFloor);

        const htmlContent = messages
            .filter(m => m.content)
            .map((msg, idx) => {
                const roleLabel = msg.role === 'user' ? 'User' : 'Assistant';
                const roleClass = msg.role === 'user' ? 'user' : 'assistant';
                return `
                    <div class="jtw-prompt-message jtw-prompt-${roleClass}">
                        <div class="jtw-prompt-role">${roleLabel} 消息 ${Math.floor(idx / 2) + 1}</div>
                        <div class="jtw-prompt-content">${escapeHtml(msg.content)}</div>
                    </div>
                `;
            }).join('');

        $container.html(htmlContent || '<div class="jtw-ss-empty">没有提示词内容</div>');
    } catch (e) {
        $container.html(`<div class="jtw-ss-error">加载失败: ${escapeHtml(e.message)}</div>`);
    }
}

/**
 * 显示总结结果弹窗
 */
function showResultModal(content) {
    $('#jtw-ss-result-content').val(content);
    $('#jtw-ss-result-modal').data('content', content);
    $('#jtw-ss-result-modal').fadeIn(200);
}

/**
 * 隐藏总结结果弹窗
 */
function hideResultModal() {
    $('#jtw-ss-result-modal').fadeOut(200);
}

/**
 * 显示提示词预览弹窗
 */
async function showPromptModal() {
    const startFloor = parseInt($('#jtw-ss-start-floor').val()) || 1;
    const endFloor = parseInt($('#jtw-ss-end-floor').val()) || getTotalFloors();
    $('#jtw-ss-prompt-modal').fadeIn(200);
    await loadPromptPreview(startFloor, endFloor);
}

/**
 * 隐藏提示词预览弹窗
 */
function hidePromptModal() {
    $('#jtw-ss-prompt-modal').fadeOut(200);
}

/**
 * 保存总结结果到世界书（追加模式）
 */
async function saveResultToWorldbook() {
    const content = $('#jtw-ss-result-content').val();
    const $saveBtn = $('#jtw-ss-result-save');
    const $status = $('#jtw-ss-result-status');

    if (!content || !content.trim()) {
        $status.text('没有需要保存的内容').removeClass('success').addClass('error').show();
        setTimeout(() => $status.fadeOut(), 3000);
        return;
    }

    $saveBtn.prop('disabled', true).text('保存中...');

    const result = await saveToWorldbook(content);

    if (result.success) {
        const appendText = result.isAppend ? '（已追加）' : '';
        $status.text(`保存成功${appendText}`).removeClass('error').addClass('success').show();

        // 更新已总结楼层记录
        const endFloor = parseInt($('#jtw-ss-end-floor').val()) || getTotalFloors();
        setLastSummarizedFloor(endFloor);

        setTimeout(() => {
            hideResultModal();
            loadEntryContent(); // 刷新条目内容
        }, 1500);
    } else {
        $status.text(result.error).removeClass('success').addClass('error').show();
    }

    $saveBtn.prop('disabled', false).text('保存到世界书');
    setTimeout(() => $status.fadeOut(), 5000);
}

/**
 * 运行总结并显示结果
 */
async function runAndShowResult() {
    const $btn = $('#jtw-ss-run-summary');
    const $status = $('#jtw-ss-settings-status');

    const startFloor = parseInt($('#jtw-ss-start-floor').val()) || 1;
    const endFloor = parseInt($('#jtw-ss-end-floor').val()) || getTotalFloors();

    if (startFloor > endFloor) {
        $status.text('起始楼层不能大于结束楼层').removeClass('success').addClass('error').show();
        setTimeout(() => $status.fadeOut(), 3000);
        return;
    }

    $btn.prop('disabled', true).text('总结中...');

    const result = await runSummary((msg, isError) => {
        $status.text(msg)
            .removeClass('success error')
            .addClass(isError ? 'error' : 'success')
            .show();
    }, startFloor, endFloor);

    $btn.prop('disabled', false).text('运行总结');

    if (result.success) {
        showResultModal(result.content);
    }

    setTimeout(() => $status.fadeOut(), 5000);
}

// ==================== 弹窗 HTML 和事件 ====================

// 标记事件是否已绑定
let eventsInitialized = false;

/**
 * 获取模态框 HTML
 */
function getModalHtml() {
    const totalFloors = getTotalFloors();
    const lastSummarized = getLastSummarizedFloor();
    const defaultStart = lastSummarized > 0 ? lastSummarized : 1;
    const defaultEnd = totalFloors;

    return `
        <!-- 故事总结主弹窗 -->
        <div id="jtw-story-summary-modal" class="jtw-modal" style="display: none;">
            <div class="jtw-modal-content jtw-ss-modal-content">
                <div class="jtw-modal-header">
                    <h3>📖 故事总结</h3>
                    <button class="jtw-modal-close jtw-ss-close-modal">✕</button>
                </div>
                
                <!-- 标签页导航 -->
                <div class="jtw-ss-tabs">
                    <button class="jtw-ss-tab active" data-tab="entry">条目内容</button>
                    <button class="jtw-ss-tab" data-tab="settings">设置</button>
                </div>
                
                <div class="jtw-modal-body">
                    <!-- 条目内容页 -->
                    <div class="jtw-ss-tab-content active" id="jtw-ss-tab-entry">
                        <div id="jtw-ss-summarized-info" class="jtw-ss-summarized-info" style="display: none;">
                            尚未进行过总结
                        </div>
                        <div id="jtw-ss-entry-empty" class="jtw-ss-empty-hint" style="display: none;">
                            <div class="jtw-ss-empty-icon">📖</div>
                            <div class="jtw-ss-empty-text">尚未生成故事总结条目</div>
                            <div class="jtw-ss-empty-hint-text">请前往「设置」页面配置并运行总结</div>
                            <button class="jtw-btn primary jtw-ss-goto-settings">前往设置</button>
                        </div>
                        <div id="jtw-ss-entry-editor" style="display: none;">
                            <div id="jtw-ss-entry-info" class="jtw-ss-entry-info"></div>
                            <textarea id="jtw-ss-entry-content" class="jtw-ss-textarea" rows="25" placeholder="条目内容..."></textarea>
                            <div class="jtw-ss-actions">
                                <div id="jtw-ss-entry-status" class="jtw-status" style="display: none;"></div>
                                <button id="jtw-ss-save-entry" class="jtw-btn primary">保存修改</button>
                            </div>
                        </div>
                    </div>
                    
                    <!-- 设置页 -->
                    <div class="jtw-ss-tab-content" id="jtw-ss-tab-settings">
                        <div class="jtw-ss-settings-grid">
                            <!-- 左侧：基本设置和世界书设置 -->
                            <div class="jtw-ss-settings-left">
                                <div class="jtw-section">
                                    <h4>基本设置</h4>
                                    <div style="margin-bottom: 10px;">
                                        <label>条目名称</label>
                                        <input type="text" id="jtw-ss-entry-name" class="jtw-input" placeholder="故事总结" />
                                    </div>
                                    <div style="margin-bottom: 10px;">
                                        <label>历史消息（楼层范围）</label>
                                        <div style="display: flex; gap: 8px; align-items: center;">
                                            <input type="number" id="jtw-ss-start-floor" class="jtw-input" value="${defaultStart}" min="1" style="width: 80px;" />
                                            <span>~</span>
                                            <input type="number" id="jtw-ss-end-floor" class="jtw-input" value="${defaultEnd}" min="1" style="width: 80px;" />
                                            <span class="jtw-ss-total-floors" style="font-size: 12px; color: #888;">共 ${totalFloors} 层</span>
                                        </div>
                                        <div class="jtw-hint">设定要总结的聊天楼层范围</div>
                                    </div>
                                </div>
                                
                                <div class="jtw-section">
                                    <h4>世界书设置</h4>
                                    <div style="margin-bottom: 10px;">
                                        <label>条目位置</label>
                                        <select id="jtw-ss-position" class="jtw-select">
                                            <option value="0">角色定义之前</option>
                                            <option value="1">角色定义之后</option>
                                            <option value="2">作者注释之前</option>
                                            <option value="3">作者注释之后</option>
                                            <option value="4">@ Depth</option>
                                        </select>
                                    </div>
                                    <div id="jtw-ss-depth-container" style="margin-bottom: 10px; display: none;">
                                        <label>深度值 (Depth)</label>
                                        <input type="number" id="jtw-ss-depth" class="jtw-input" value="4" min="0" max="999" />
                                    </div>
                                    <div style="margin-bottom: 10px;">
                                        <label>排序优先级</label>
                                        <input type="number" id="jtw-ss-order" class="jtw-input" value="100" min="0" />
                                    </div>
                                </div>
                                
                                <div class="jtw-ss-run-section">
                                    <button id="jtw-ss-run-summary" class="jtw-btn primary">运行总结</button>
                                    <button id="jtw-ss-preview-prompt" class="jtw-btn" style="margin-top: 8px;">📋 预览完整提示词</button>
                                    <div id="jtw-ss-settings-status" class="jtw-status" style="display: none;"></div>
                                </div>
                            </div>
                            
                            <!-- 右侧：提示词设置 -->
                            <div class="jtw-ss-settings-right">
                                <div class="jtw-section jtw-ss-prompts-section">
                                    <h4>提示词设置</h4>
                                    <div style="margin-bottom: 8px;">
                                        <label>User 消息 1</label>
                                        <textarea id="jtw-ss-prompt-u1" class="jtw-input" rows="2"></textarea>
                                    </div>
                                    <div style="margin-bottom: 8px;">
                                        <label>Assistant 消息 1</label>
                                        <textarea id="jtw-ss-prompt-a1" class="jtw-input" rows="2"></textarea>
                                    </div>
                                    <div style="margin-bottom: 8px;">
                                        <label>User 消息 2</label>
                                        <textarea id="jtw-ss-prompt-u2" class="jtw-input" rows="10"></textarea>
                                    </div>
                                    <div style="margin-bottom: 8px;">
                                        <label>Assistant 消息 2</label>
                                        <textarea id="jtw-ss-prompt-a2" class="jtw-input" rows="1"></textarea>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- 总结结果弹窗 -->
        <div id="jtw-ss-result-modal" class="jtw-modal" style="display: none;">
            <div class="jtw-modal-content jtw-ss-result-modal-content">
                <div class="jtw-modal-header">
                    <h3>📝 总结结果</h3>
                    <button class="jtw-modal-close jtw-ss-close-result">✕</button>
                </div>
                <div class="jtw-modal-body">
                    <div id="jtw-ss-result-count" class="jtw-ss-result-count">总结结果预览</div>
                    <textarea id="jtw-ss-result-content" class="jtw-ss-textarea" rows="16" placeholder="生成的总结内容..."></textarea>
                    <div class="jtw-ss-result-hint">您可以在保存前修改上述内容（已存在的条目将自动追加）</div>
                    <div class="jtw-ss-actions">
                        <div id="jtw-ss-result-status" class="jtw-status" style="display: none;"></div>
                        <button class="jtw-btn jtw-ss-close-result">取消</button>
                        <button id="jtw-ss-result-save" class="jtw-btn primary">保存到世界书</button>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- 提示词预览弹窗 -->
        <div id="jtw-ss-prompt-modal" class="jtw-modal" style="display: none;">
            <div class="jtw-modal-content jtw-ss-prompt-modal-content">
                <div class="jtw-modal-header">
                    <h3>📋 完整提示词预览</h3>
                    <button class="jtw-modal-close jtw-ss-close-prompt">✕</button>
                </div>
                <div class="jtw-modal-body">
                    <div id="jtw-ss-prompt-preview" class="jtw-ss-prompt-preview">
                        <div class="jtw-ss-loading">加载中...</div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

/**
 * 确保模态框 DOM 存在
 */
function ensureModalExists() {
    if ($('#jtw-story-summary-modal').length === 0) {
        $('body').append(getModalHtml());
        if (!eventsInitialized) {
            bindModalEvents();
        }
    } else {
        // 弹窗已存在时更新楼层默认值
        updateFloorDefaults();
    }
}

/**
 * 每次打开弹窗时更新楼层默认值
 */
function updateFloorDefaults() {
    const totalFloors = getTotalFloors();
    const lastSummarized = getLastSummarizedFloor();
    const defaultStart = lastSummarized > 0 ? lastSummarized : 1;

    $('#jtw-ss-start-floor').val(defaultStart);
    $('#jtw-ss-end-floor').val(totalFloors);
    $('.jtw-ss-total-floors').text(`共 ${totalFloors} 层`);
}

/**
 * 绑定模态框事件
 */
function bindModalEvents() {
    const { getSettings, defaultSettings } = dependencies;
    const settings = getSettings();

    // 确保 storySummary 对象存在
    if (!settings.storySummary) {
        settings.storySummary = { ...defaultSettings.storySummary };
    }
    const storySummary = settings.storySummary;
    const defaultStorySummary = defaultSettings.storySummary;

    // 关闭主弹窗
    $('#jtw-story-summary-modal .jtw-ss-close-modal').off('click').on('click', function(e) {
        e.stopPropagation();
        hideModal();
    });
    $('#jtw-story-summary-modal').off('click mousedown pointerdown touchstart touchend').on('click mousedown pointerdown touchstart touchend', function(e) {
        e.stopPropagation();
    });

    // 关闭结果弹窗
    $('#jtw-ss-result-modal .jtw-ss-close-result').off('click').on('click', function(e) {
        e.stopPropagation();
        hideResultModal();
    });
    $('#jtw-ss-result-modal').off('click mousedown pointerdown touchstart touchend').on('click mousedown pointerdown touchstart touchend', function(e) {
        e.stopPropagation();
    });

    // 关闭提示词预览弹窗
    $('#jtw-ss-prompt-modal .jtw-ss-close-prompt').off('click').on('click', function(e) {
        e.stopPropagation();
        hidePromptModal();
    });
    $('#jtw-ss-prompt-modal').off('click mousedown pointerdown touchstart touchend').on('click mousedown pointerdown touchstart touchend', function(e) {
        e.stopPropagation();
    });

    // 标签页切换
    $('#jtw-story-summary-modal .jtw-ss-tab').off('click').on('click', function(e) {
        e.stopPropagation();
        const tab = $(this).data('tab');
        switchTab(tab);
    });

    // 前往设置按钮
    $('#jtw-story-summary-modal .jtw-ss-goto-settings').off('click').on('click', function(e) {
        e.stopPropagation();
        switchTab('settings');
    });

    // 保存条目编辑
    $('#jtw-ss-save-entry').off('click').on('click', saveEntryEdit);

    // 预览提示词弹窗
    $('#jtw-ss-preview-prompt').off('click').on('click', showPromptModal);

    // 运行总结
    $('#jtw-ss-run-summary').off('click').on('click', runAndShowResult);

    // 保存总结结果
    $('#jtw-ss-result-save').off('click').on('click', saveResultToWorldbook);

    // 条目名称
    $('#jtw-ss-entry-name').val(storySummary.entryName || '故事总结').off('change').on('change', function() {
        storySummary.entryName = $(this).val();
        if (saveSettingsCallback) saveSettingsCallback();
    });

    // 提示词设置
    $('#jtw-ss-prompt-u1').val(storySummary.promptU1 || defaultStorySummary.promptU1).off('change').on('change', function() {
        storySummary.promptU1 = $(this).val();
        if (saveSettingsCallback) saveSettingsCallback();
    });

    $('#jtw-ss-prompt-a1').val(storySummary.promptA1 || defaultStorySummary.promptA1).off('change').on('change', function() {
        storySummary.promptA1 = $(this).val();
        if (saveSettingsCallback) saveSettingsCallback();
    });

    $('#jtw-ss-prompt-u2').val(storySummary.promptU2 || defaultStorySummary.promptU2).off('change').on('change', function() {
        storySummary.promptU2 = $(this).val();
        if (saveSettingsCallback) saveSettingsCallback();
    });

    $('#jtw-ss-prompt-a2').val(storySummary.promptA2 || defaultStorySummary.promptA2).off('change').on('change', function() {
        storySummary.promptA2 = $(this).val();
        if (saveSettingsCallback) saveSettingsCallback();
    });

    // 条目位置
    $('#jtw-ss-position').val(storySummary.entryPosition || 0).off('change').on('change', function() {
        storySummary.entryPosition = parseInt($(this).val());
        if (storySummary.entryPosition === 4) {
            $('#jtw-ss-depth-container').show();
        } else {
            $('#jtw-ss-depth-container').hide();
        }
        if (saveSettingsCallback) saveSettingsCallback();
    });

    if (storySummary.entryPosition === 4) {
        $('#jtw-ss-depth-container').show();
    }

    // 深度值
    $('#jtw-ss-depth').val(storySummary.entryDepth || 4).off('change').on('change', function() {
        storySummary.entryDepth = parseInt($(this).val()) || 4;
        if (saveSettingsCallback) saveSettingsCallback();
    });

    // 排序优先级
    $('#jtw-ss-order').val(storySummary.entryOrder || 100).off('change').on('change', function() {
        storySummary.entryOrder = parseInt($(this).val()) || 100;
        if (saveSettingsCallback) saveSettingsCallback();
    });

    eventsInitialized = true;
}

/**
 * 渲染设置面板 HTML（占位，实际功能在弹窗中）
 * @returns {string}
 */
export function renderSettingsPanel() {
    return `
        <div class="jtw-assistant-feature-content" id="jtw-story-summary-settings" style="display: none;">
            <!-- 占位，实际功能在弹窗中 -->
        </div>
    `;
}

/**
 * 初始化设置面板事件绑定（设置保存回调）
 * @param {function} saveSettings - 保存设置回调
 */
export function initSettingsEvents(saveSettings) {
    saveSettingsCallback = saveSettings;
}

/**
 * 模块被点击时的处理（覆盖默认行为）
 */
export function onModuleClick() {
    showModal();
    return false; // 返回 false 阻止默认的面板切换行为
}
