/**
 * 角色提取功能模块
 * 从聊天历史中提取出场角色列表并保存到世界书
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
        id: 'character-extract',
        name: '角色提取',
        description: '从聊天历史中提取出场角色列表',
        icon: '👥'
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
 * 构建角色提取的消息
 * @param {object} vars - 变量对象
 * @returns {Array}
 */
function buildExtractCharactersMessages(vars) {
    const { getSettings, defaultSettings } = dependencies;
    const settings = getSettings();
    const charExtract = settings.characterExtract || defaultSettings.characterExtract;
    const prompts = {
        u1: charExtract.promptU1,
        a1: charExtract.promptA1,
        u2: charExtract.promptU2,
        a2: charExtract.promptA2
    };
    
    const replaceVars = (template) => {
        return template
            .replace(/\{\{user\}\}/g, vars.userName || '{{user}}')
            .replace(/\{\{char\}\}/g, vars.charName || '{{char}}')
            .replace(/\{\{description\}\}/g, vars.description || '')
            .replace(/\{\{persona\}\}/g, vars.persona || '')
            .replace(/\{\{worldInfo\}\}/g, vars.worldInfo || '')
            .replace(/\{\{chatHistory\}\}/g, vars.chatHistory || '')
            .replace(/\{\{existingCharacters\}\}/g, vars.existingCharacters || '');
    };
    
    return [
        { role: 'user', content: replaceVars(prompts.u1) },
        { role: 'assistant', content: replaceVars(prompts.a1) },
        { role: 'user', content: replaceVars(prompts.u2) },
        { role: 'assistant', content: replaceVars(prompts.a2) }
    ];
}

/**
 * 获取当前世界书条目信息
 * @returns {Promise<{entry: object|null, worldbook: string|null}>}
 */
async function getCurrentWorldbookEntry() {
    const { getSettings, getCharacterWorldbook, loadWorldInfo, world_names, defaultSettings } = dependencies;
    const settings = getSettings();
    const charExtract = settings.characterExtract || defaultSettings.characterExtract;
    const entryName = charExtract.characterListName || '出场角色列表';
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
        console.error(`[角色提取] 获取世界书条目失败:`, e);
        return { entry: null, worldbook: targetBook };
    }
}

/**
 * 获取已存在的角色列表（从世界书）
 * @returns {Promise<Array>}
 */
async function getExistingCharacters() {
    const { entry } = await getCurrentWorldbookEntry();
    
    if (!entry?.content) return [];
    
    // 尝试解析已有内容中的角色
    const existingNames = [];
    const lines = entry.content.split('\n');
    for (const line of lines) {
        const match = line.match(/^-?\s*name:\s*(.+)$/i) || line.match(/^\s*-\s*(.+?)[:：]/);
        if (match) {
            existingNames.push(match[1].trim());
        }
    }
    
    return existingNames;
}

/**
 * 解析条目内容中的角色数据块
 * @param {string} content - 条目内容
 * @returns {Array<{name: string, startIndex: number, endIndex: number, content: string}>}
 */
function parseCharacterBlocks(content) {
    if (!content) return [];
    
    const blocks = [];
    const lines = content.split('\n');
    let currentBlock = null;
    let currentStartLine = 0;
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const nameMatch = line.match(/^name:\s*(.+)$/i);
        
        if (nameMatch) {
            // 保存上一个块
            if (currentBlock) {
                currentBlock.endLine = i - 1;
                // 找到最后一个非空行
                while (currentBlock.endLine > currentBlock.startLine && 
                       !lines[currentBlock.endLine].trim()) {
                    currentBlock.endLine--;
                }
                currentBlock.content = lines.slice(currentBlock.startLine, currentBlock.endLine + 1).join('\n');
                blocks.push(currentBlock);
            }
            
            // 开始新块
            currentBlock = {
                name: nameMatch[1].trim(),
                startLine: i,
                endLine: i,
                content: ''
            };
            currentStartLine = i;
        }
    }
    
    // 保存最后一个块
    if (currentBlock) {
        currentBlock.endLine = lines.length - 1;
        // 找到最后一个非空行
        while (currentBlock.endLine > currentBlock.startLine && 
               !lines[currentBlock.endLine].trim()) {
            currentBlock.endLine--;
        }
        currentBlock.content = lines.slice(currentBlock.startLine, currentBlock.endLine + 1).join('\n');
        blocks.push(currentBlock);
    }
    
    return blocks;
}

/**
 * 更新条目中的角色数据
 * @param {string} targetName - 要更新的角色名称
 * @param {object} updateData - 更新的数据
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function updateCharacterInEntry(targetName, updateData) {
    const { jsonToYaml } = dependencies;
    const { entry } = await getCurrentWorldbookEntry();
    
    if (!entry?.content) {
        return { success: false, error: `未找到角色「${targetName}」的条目` };
    }
    
    const blocks = parseCharacterBlocks(entry.content);
    const targetBlock = blocks.find(b => 
        b.name.toLowerCase() === targetName.toLowerCase()
    );
    
    if (!targetBlock) {
        return { success: false, error: `未找到角色「${targetName}」` };
    }
    
    // 解析现有角色数据为对象
    const existingData = parseYamlBlock(targetBlock.content);
    
    // 合并更新数据（深度合并）
    const mergedData = deepMerge(existingData, updateData);
    
    // 移除 update_for 字段
    delete mergedData.update_for;
    
    // 转换回 YAML
    const newBlockContent = jsonToYaml(mergedData, 0);
    
    // 重建条目内容
    const lines = entry.content.split('\n');
    const beforeLines = lines.slice(0, targetBlock.startLine);
    const afterLines = lines.slice(targetBlock.endLine + 1);
    
    // 去除前后多余空行
    while (beforeLines.length > 0 && !beforeLines[beforeLines.length - 1].trim()) {
        beforeLines.pop();
    }
    while (afterLines.length > 0 && !afterLines[0].trim()) {
        afterLines.shift();
    }
    
    const newContent = [
        ...beforeLines,
        beforeLines.length > 0 ? '' : null,  // 添加分隔空行
        newBlockContent,
        afterLines.length > 0 ? '' : null,   // 添加分隔空行
        ...afterLines
    ].filter(line => line !== null).join('\n') + '\n\n';
    
    // 保存更新后的内容
    return saveEntryToWorldbook(newContent);
}

/**
 * 解析 YAML 块为对象（简化版本，支持常见格式）
 * @param {string} yamlContent - YAML 内容
 * @returns {object}
 */
function parseYamlBlock(yamlContent) {
    const result = {};
    const lines = yamlContent.split('\n');
    
    let currentKey = null;
    let nestedKey = null;
    let nestedObj = null;
    let arrayKey = null;
    let arrayItems = [];
    let lastIndent = 0;
    
    const finishArray = () => {
        if (arrayKey && arrayItems.length > 0) {
            if (nestedObj && nestedKey) {
                nestedObj[arrayKey] = [...arrayItems];
            } else {
                result[arrayKey] = [...arrayItems];
            }
        }
        arrayKey = null;
        arrayItems = [];
    };
    
    const finishNested = () => {
        if (nestedKey && nestedObj && Object.keys(nestedObj).length > 0) {
            result[nestedKey] = { ...nestedObj };
        }
        nestedKey = null;
        nestedObj = null;
    };
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        
        const indent = line.search(/\S/);
        const content = line.trim();
        
        // 检查是否是数组项
        if (content.startsWith('- ')) {
            const itemContent = content.slice(2).trim();
            if (arrayKey) {
                // 已经在收集数组项
                arrayItems.push(itemContent);
            } else if (nestedKey && nestedObj && Object.keys(nestedObj).length === 0) {
                // 顶级键后直接跟数组项（如 代表性台词:\n  - 台词1）
                // 之前被误识别为嵌套对象，实际上是顶级数组
                arrayKey = nestedKey;
                nestedKey = null;
                nestedObj = null;
                arrayItems.push(itemContent);
            }
            continue;
        }
        
        // 检查缩进变化，判断是否需要结束当前块
        if (indent === 0 && lastIndent > 0) {
            finishArray();
            finishNested();
        }
        
        // 解析键值对
        const colonIndex = content.indexOf(':');
        if (colonIndex === -1) continue;
        
        const key = content.slice(0, colonIndex).trim();
        const value = content.slice(colonIndex + 1).trim();
        
        if (indent === 0) {
            // 顶级键
            finishArray();
            finishNested();
            
            if (value === '' || value === '{}') {
                // 开始嵌套对象
                nestedKey = key;
                nestedObj = {};
            } else if (value === '[]') {
                // 空数组
                result[key] = [];
            } else {
                // 普通值
                result[key] = value;
            }
            currentKey = key;
        } else if (indent > 0) {
            // 缩进的键
            finishArray();
            
            if (nestedObj) {
                if (value === '' || value === '[]') {
                    // 开始数组
                    arrayKey = key;
                    arrayItems = [];
                } else {
                    nestedObj[key] = value;
                }
            } else {
                // 可能是前一个顶级键的嵌套内容，创建嵌套对象
                if (currentKey && !result[currentKey]) {
                    nestedKey = currentKey;
                    nestedObj = {};
                }
                if (nestedObj) {
                    if (value === '' || value === '[]') {
                        arrayKey = key;
                        arrayItems = [];
                    } else {
                        nestedObj[key] = value;
                    }
                }
            }
        }
        
        lastIndent = indent;
    }
    
    // 处理最后的数组和嵌套对象
    finishArray();
    finishNested();
    
    return result;
}

/**
 * 深度合并对象
 * @param {object} target - 目标对象
 * @param {object} source - 源对象
 * @returns {object}
 */
function deepMerge(target, source) {
    const result = { ...target };
    
    for (const key of Object.keys(source)) {
        if (source[key] === null || source[key] === undefined) {
            continue;
        }
        
        if (typeof source[key] === 'object' && !Array.isArray(source[key])) {
            if (typeof result[key] === 'object' && !Array.isArray(result[key])) {
                result[key] = deepMerge(result[key], source[key]);
            } else {
                result[key] = { ...source[key] };
            }
        } else {
            result[key] = source[key];
        }
    }
    
    return result;
}

/**
 * 保存条目内容到世界书
 * @param {string} content - 条目内容
 * @param {object} options - 条目属性选项
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function saveEntryToWorldbook(content, options = {}) {
    const { 
        getSettings, 
        getCharacterWorldbook, 
        loadWorldInfo, 
        saveWorldInfo,
        world_names
    } = dependencies;
    
    try {
        const settings = getSettings();
        const charExtract = settings.characterExtract || dependencies.defaultSettings.characterExtract;
        const entryName = charExtract.characterListName || '出场角色列表';
        let targetBook = settings.targetWorldbook || getCharacterWorldbook();
        
        if (!targetBook || !world_names?.includes(targetBook)) {
            return { success: false, error: "未找到有效的世界书，请先绑定或选择世界书" };
        }

        const worldData = await loadWorldInfo(targetBook);
        if (!worldData) {
            return { success: false, error: `无法加载世界书: ${targetBook}` };
        }

        // 查找或创建条目
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

        // 设置条目属性
        const position = options.position ?? charExtract.characterListPosition ?? 0;
        Object.assign(entry, {
            comment: entryName,
            content: content,
            constant: true,
            selective: true,
            disable: false,
            position: position,
            depth: position === 4 ? (options.depth ?? charExtract.characterListDepth ?? 4) : undefined,
            order: options.order ?? charExtract.characterListOrder ?? 100,
        });

        await saveWorldInfo(targetBook, worldData, true);
        
        return { success: true, uid: String(entry.uid), worldbook: targetBook };
    } catch (e) {
        console.error(`[角色提取] 保存条目失败:`, e);
        return { success: false, error: e.message };
    }
}

/**
 * 追加角色到世界书
 * @param {Array} characters - 角色列表
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function appendCharactersToWorldbook(characters) {
    const { jsonToYaml } = dependencies;
    const { entry } = await getCurrentWorldbookEntry();
    
    const existingContent = entry?.content || '';
    const newContent = characters.map(char => jsonToYaml(char, 0)).join('\n\n');
    const finalContent = existingContent 
        ? `${existingContent.trim()}\n\n${newContent}\n\n`
        : `${newContent}\n\n`;
    
    return saveEntryToWorldbook(finalContent);
}

/**
 * 获取完整提示词预览数据
 * @returns {Promise<{messages: Array, vars: object}>}
 */
async function getPromptPreviewData() {
    const { getSettings, getContext, getChatHistory, getWorldInfoContent, power_user, defaultSettings } = dependencies;
    const settings = getSettings();
    const charExtract = settings.characterExtract || defaultSettings.characterExtract;
    const ctx = getContext();
    
    const char = ctx.characters?.[ctx.characterId];
    const description = char?.description || char?.data?.description || '';
    const persona = power_user?.persona_description || '';
    const userName = ctx.name1 || '{{user}}';
    const charName = char?.name || ctx.name2 || '{{char}}';
    const chatHistory = getChatHistory(charExtract.historyCount || 50);
    
    // 计算世界书检查的层数范围（使用角色提取的历史消息数量）
    const chat = ctx.chat || [];
    const totalMessages = chat.length;
    const historyCount = charExtract.historyCount || settings.historyCount || 50;
    const startLayer = Math.max(1, totalMessages - historyCount + 1);
    const endLayer = totalMessages;
    
    const worldInfo = await getWorldInfoContent({ 
        activatedOnly: true,
        startLayer: startLayer,
        endLayer: endLayer
    });
    const existingNames = await getExistingCharacters();
    const existingCharacters = existingNames.length > 0 
        ? `\n\n**已存在角色（不要重复）：** ${existingNames.join('、')}`
        : '';
    
    const vars = {
        userName,
        charName,
        description,
        persona,
        worldInfo,
        chatHistory,
        existingCharacters
    };
    
    const messages = buildExtractCharactersMessages(vars);
    
    return { messages, vars };
}

/**
 * 执行角色列表提取（返回解析结果，不直接保存）
 * @param {function} showStatus - 状态显示回调
 * @returns {Promise<{success: boolean, newCharacters?: Array, updateCharacters?: Array, error?: string}>}
 */
async function runExtraction(showStatus) {
    const { callLLMJson } = dependencies;
    
    showStatus("正在提取角色列表...");
    
    try {
        const { messages } = await getPromptPreviewData();
        const existingNames = await getExistingCharacters();
        
        console.log(`[角色提取] 开始提取角色...`);
        
        const result = await callLLMJson(messages, true);
        
        if (!result || !Array.isArray(result)) {
            showStatus("未能提取到角色数据", true);
            return { success: false, error: "未能提取到角色数据" };
        }
        
        if (result.length === 0) {
            showStatus("没有发现角色数据");
            return { success: true, newCharacters: [], updateCharacters: [] };
        }
        
        // 分离新增角色和更新角色
        const newCharacters = [];
        const updateCharacters = [];
        const updateNotFound = [];
        
        for (const char of result) {
            if (!char.name && !char.update_for) continue;
            
            // 检查是否为更新操作
            if (char.update_for) {
                const targetName = char.update_for;
                const exists = existingNames.some(en => 
                    en.toLowerCase() === targetName.toLowerCase()
                );
                
                if (exists) {
                    updateCharacters.push(char);
                    console.log(`[角色提取] 发现更新角色: ${targetName}`, char);
                } else {
                    updateNotFound.push(targetName);
                    console.log(`[角色提取] 更新目标不存在: ${targetName}`);
                }
            } else {
                // 新增角色，检查是否已存在
                const alreadyExists = existingNames.some(en => 
                    en.toLowerCase() === char.name.toLowerCase()
                );
                
                if (!alreadyExists) {
                    newCharacters.push(char);
                }
            }
        }
        
        const totalNew = newCharacters.length;
        const totalUpdate = updateCharacters.length;
        const totalNotFound = updateNotFound.length;
        
        if (totalNew === 0 && totalUpdate === 0) {
            let msg = "没有发现需要处理的角色";
            if (totalNotFound > 0) {
                msg += `（${totalNotFound} 个更新目标不存在：${updateNotFound.join('、')}）`;
            }
            showStatus(msg);
            return { 
                success: true, 
                newCharacters: [], 
                updateCharacters: [], 
                updateNotFound,
                message: msg 
            };
        }
        
        let statusMsg = [];
        if (totalNew > 0) statusMsg.push(`${totalNew} 个新角色`);
        if (totalUpdate > 0) statusMsg.push(`${totalUpdate} 个更新`);
        if (totalNotFound > 0) statusMsg.push(`${totalNotFound} 个更新目标不存在`);
        
        console.log(`[角色提取] 结果: 新增 ${totalNew}, 更新 ${totalUpdate}, 未找到 ${totalNotFound}`);
        showStatus(`发现: ${statusMsg.join('，')}`);
        
        return { 
            success: true, 
            newCharacters, 
            updateCharacters,
            updateNotFound
        };
        
    } catch (e) {
        console.error(`[角色提取] 提取角色失败:`, e);
        showStatus(`提取失败: ${e.message}`, true);
        return { success: false, error: e.message };
    }
}

/**
 * 显示主弹窗
 */
export function showModal() {
    // 如果 DOM 不存在，先创建
    ensureModalExists();
    
    $('#jtw-character-extract-modal').fadeIn(200);
    // 默认显示第一个标签页
    switchTab('entry');
    // 加载条目内容
    loadEntryContent();
}

/**
 * 隐藏主弹窗
 */
function hideModal() {
    $('#jtw-character-extract-modal').fadeOut(200);
}

/**
 * 切换标签页
 */
function switchTab(tabName) {
    $('.jtw-ce-tab').removeClass('active');
    $(`.jtw-ce-tab[data-tab="${tabName}"]`).addClass('active');
    $('.jtw-ce-tab-content').removeClass('active');
    $(`#jtw-ce-tab-${tabName}`).addClass('active');
}

/**
 * 加载条目内容到编辑区
 */
async function loadEntryContent() {
    const { getSettings, defaultSettings } = dependencies;
    const settings = getSettings();
    const charExtract = settings.characterExtract || defaultSettings.characterExtract;
    const { entry, worldbook } = await getCurrentWorldbookEntry();
    
    const $emptyHint = $('#jtw-ce-entry-empty');
    const $editor = $('#jtw-ce-entry-editor');
    const $content = $('#jtw-ce-entry-content');
    const $info = $('#jtw-ce-entry-info');
    
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
        <span><strong>条目名称:</strong> ${escapeHtml(charExtract.characterListName || '出场角色列表')}</span>
        <span><strong>位置:</strong> ${positionText}</span>
        <span><strong>排序:</strong> ${entry.order || 100}</span>
    `);
}

/**
 * 保存条目编辑
 */
async function saveEntryEdit() {
    const content = $('#jtw-ce-entry-content').val();
    const $saveBtn = $('#jtw-ce-save-entry');
    const $status = $('#jtw-ce-entry-status');
    
    $saveBtn.prop('disabled', true).text('保存中...');
    
    const result = await saveEntryToWorldbook(content);
    
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
async function loadPromptPreview() {
    const $container = $('#jtw-ce-prompt-preview');
    $container.html('<div class="jtw-ce-loading">加载中...</div>');
    
    try {
        const { messages } = await getPromptPreviewData();
        
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
        
        $container.html(htmlContent || '<div class="jtw-ce-empty">没有提示词内容</div>');
    } catch (e) {
        $container.html(`<div class="jtw-ce-error">加载失败: ${escapeHtml(e.message)}</div>`);
    }
}

/**
 * 显示提取结果弹窗
 * @param {Array} newCharacters - 新增的角色列表
 * @param {Array} updateCharacters - 需要更新的角色列表
 * @param {Array} updateNotFound - 更新目标不存在的角色名
 */
function showResultModal(newCharacters = [], updateCharacters = [], updateNotFound = []) {
    const { jsonToYaml } = dependencies;
    
    let contentParts = [];
    let countText = [];
    
    // 新增角色部分
    if (newCharacters.length > 0) {
        const newContent = newCharacters.map(char => jsonToYaml(char, 0)).join('\n\n');
        contentParts.push(`# ===== 新增角色 (${newCharacters.length}) =====\n\n${newContent}`);
        countText.push(`${newCharacters.length} 个新角色`);
    }
    
    // 更新角色部分
    if (updateCharacters.length > 0) {
        const updateContent = updateCharacters.map(char => {
            const yaml = jsonToYaml(char, 0);
            return `# 更新目标: ${char.update_for}\n${yaml}`;
        }).join('\n\n');
        contentParts.push(`# ===== 更新角色 (${updateCharacters.length}) =====\n\n${updateContent}`);
        countText.push(`${updateCharacters.length} 个更新`);
    }
    
    // 更新目标不存在提示
    if (updateNotFound.length > 0) {
        contentParts.push(`# ===== 更新目标不存在 (${updateNotFound.length}) =====\n# ${updateNotFound.join('、')}`);
        countText.push(`${updateNotFound.length} 个更新目标不存在`);
    }
    
    const content = contentParts.join('\n\n');
    $('#jtw-ce-result-content').val(content);
    $('#jtw-ce-result-count').text(`提取结果: ${countText.join('，') || '无数据'}`);
    
    // 存储数据供保存时使用
    $('#jtw-ce-result-modal').data('newCharacters', newCharacters);
    $('#jtw-ce-result-modal').data('updateCharacters', updateCharacters);
    
    $('#jtw-ce-result-modal').fadeIn(200);
}

/**
 * 隐藏提取结果弹窗
 */
function hideResultModal() {
    $('#jtw-ce-result-modal').fadeOut(200);
}

/**
 * 显示提示词预览弹窗
 */
async function showPromptModal() {
    $('#jtw-ce-prompt-modal').fadeIn(200);
    await loadPromptPreview();
}

/**
 * 隐藏提示词预览弹窗
 */
function hidePromptModal() {
    $('#jtw-ce-prompt-modal').fadeOut(200);
}

/**
 * 保存提取结果（支持新增和更新）
 */
async function saveExtractionResult() {
    const $modal = $('#jtw-ce-result-modal');
    const newCharacters = $modal.data('newCharacters') || [];
    const updateCharacters = $modal.data('updateCharacters') || [];
    const $saveBtn = $('#jtw-ce-result-save');
    const $status = $('#jtw-ce-result-status');
    
    if (newCharacters.length === 0 && updateCharacters.length === 0) {
        $status.text('没有需要保存的内容').removeClass('success').addClass('error').show();
        setTimeout(() => $status.fadeOut(), 3000);
        return;
    }
    
    $saveBtn.prop('disabled', true).text('保存中...');
    
    const results = [];
    let hasError = false;
    
    // 1. 先处理更新操作
    if (updateCharacters.length > 0) {
        $status.text(`正在更新 ${updateCharacters.length} 个角色...`).show();
        
        for (const char of updateCharacters) {
            const targetName = char.update_for;
            const updateData = { ...char };
            // 如果 AI 没有提供新的 name，则使用 update_for 的值
            if (!updateData.name) {
                updateData.name = targetName;
            }
            
            const result = await updateCharacterInEntry(targetName, updateData);
            
            if (result.success) {
                results.push({ type: 'update', name: targetName, success: true });
                console.log(`[角色提取] 成功更新角色: ${targetName}`);
            } else {
                results.push({ type: 'update', name: targetName, success: false, error: result.error });
                console.error(`[角色提取] 更新角色失败: ${targetName}`, result.error);
                hasError = true;
            }
        }
    }
    
    // 2. 处理新增操作
    if (newCharacters.length > 0) {
        $status.text(`正在添加 ${newCharacters.length} 个新角色...`).show();
        
        const appendResult = await appendCharactersToWorldbook(newCharacters);
        
        if (appendResult.success) {
            results.push({ type: 'add', count: newCharacters.length, success: true });
            console.log(`[角色提取] 成功添加 ${newCharacters.length} 个新角色`);
        } else {
            results.push({ type: 'add', count: newCharacters.length, success: false, error: appendResult.error });
            console.error(`[角色提取] 添加新角色失败:`, appendResult.error);
            hasError = true;
        }
    }
    
    // 构建结果消息
    const successUpdates = results.filter(r => r.type === 'update' && r.success).length;
    const failedUpdates = results.filter(r => r.type === 'update' && !r.success);
    const addResult = results.find(r => r.type === 'add');
    
    let statusMessages = [];
    if (successUpdates > 0) statusMessages.push(`更新 ${successUpdates} 个成功`);
    if (failedUpdates.length > 0) statusMessages.push(`更新 ${failedUpdates.length} 个失败`);
    if (addResult?.success) statusMessages.push(`新增 ${addResult.count} 个成功`);
    if (addResult && !addResult.success) statusMessages.push(`新增失败: ${addResult.error}`);
    
    const statusText = statusMessages.join('，') || '操作完成';
    
    if (hasError) {
        $status.text(statusText).removeClass('success').addClass('error').show();
        $saveBtn.prop('disabled', false).text('保存到世界书');
    } else {
        $status.text(statusText).removeClass('error').addClass('success').show();
        setTimeout(() => {
            hideResultModal();
            loadEntryContent(); // 刷新条目内容
        }, 1500);
        $saveBtn.prop('disabled', false).text('保存到世界书');
    }
    
    setTimeout(() => $status.fadeOut(), 5000);
}

/**
 * 运行提取并显示结果
 */
async function runAndShowResult() {
    const $btn = $('#jtw-ce-run-extract');
    const $status = $('#jtw-ce-settings-status');
    
    $btn.prop('disabled', true).text('提取中...');
    
    const result = await runExtraction((msg, isError) => {
        $status.text(msg)
            .removeClass('success error')
            .addClass(isError ? 'error' : 'success')
            .show();
    });
    
    $btn.prop('disabled', false).text('运行提取');
    
    if (result.success) {
        const hasNew = result.newCharacters && result.newCharacters.length > 0;
        const hasUpdate = result.updateCharacters && result.updateCharacters.length > 0;
        const hasNotFound = result.updateNotFound && result.updateNotFound.length > 0;
        
        if (hasNew || hasUpdate || hasNotFound) {
            showResultModal(
                result.newCharacters || [],
                result.updateCharacters || [],
                result.updateNotFound || []
            );
        }
    }
    
    setTimeout(() => $status.fadeOut(), 5000);
}

// 标记事件是否已绑定
let eventsInitialized = false;

/**
 * 获取模态框 HTML
 */
function getModalHtml() {
    return `
        <!-- 角色提取主弹窗 -->
        <div id="jtw-character-extract-modal" class="jtw-modal" style="display: none;">
            <div class="jtw-modal-content jtw-ce-modal-content">
                <div class="jtw-modal-header">
                    <h3>👥 角色提取</h3>
                    <button class="jtw-modal-close jtw-ce-close-modal">✕</button>
                </div>
                
                <!-- 标签页导航 -->
                <div class="jtw-ce-tabs">
                    <button class="jtw-ce-tab active" data-tab="entry">条目内容</button>
                    <button class="jtw-ce-tab" data-tab="settings">设置</button>
                </div>
                
                <div class="jtw-modal-body">
                    <!-- 条目内容页 -->
                    <div class="jtw-ce-tab-content active" id="jtw-ce-tab-entry">
                        <div id="jtw-ce-entry-empty" class="jtw-ce-empty-hint" style="display: none;">
                            <div class="jtw-ce-empty-icon">📋</div>
                            <div class="jtw-ce-empty-text">尚未生成角色列表条目</div>
                            <div class="jtw-ce-empty-hint-text">请前往「设置」页面配置并运行提取</div>
                            <button class="jtw-btn primary jtw-ce-goto-settings">前往设置</button>
                        </div>
                        <div id="jtw-ce-entry-editor" style="display: none;">
                            <div id="jtw-ce-entry-info" class="jtw-ce-entry-info"></div>
                            <textarea id="jtw-ce-entry-content" class="jtw-ce-textarea" rows="25" placeholder="条目内容..."></textarea>
                            <div class="jtw-ce-actions">
                                <div id="jtw-ce-entry-status" class="jtw-status" style="display: none;"></div>
                                <button id="jtw-ce-save-entry" class="jtw-btn primary">保存修改</button>
                            </div>
                        </div>
                    </div>
                    
                    <!-- 设置页 -->
                    <div class="jtw-ce-tab-content" id="jtw-ce-tab-settings">
                        <div class="jtw-ce-settings-grid">
                            <!-- 左侧：基本设置和世界书设置 -->
                            <div class="jtw-ce-settings-left">
                                <div class="jtw-section">
                                    <h4>基本设置</h4>
                                    <div style="margin-bottom: 10px;">
                                        <label>条目名称</label>
                                        <input type="text" id="jtw-ce-entry-name" class="jtw-input" placeholder="出场角色列表" />
                                    </div>
                                    <div style="margin-bottom: 10px;">
                                        <label>历史消息数量</label>
                                        <input type="number" id="jtw-ce-history-count" class="jtw-input" value="50" min="10" max="200" />
                                        <div class="jtw-hint">角色提取时使用的历史消息数量</div>
                                    </div>
                                </div>
                                
                                <div class="jtw-section">
                                    <h4>世界书设置</h4>
                                    <div style="margin-bottom: 10px;">
                                        <label>条目位置</label>
                                        <select id="jtw-ce-position" class="jtw-select">
                                            <option value="0">角色定义之前</option>
                                            <option value="1">角色定义之后</option>
                                            <option value="2">作者注释之前</option>
                                            <option value="3">作者注释之后</option>
                                            <option value="4">@ Depth</option>
                                        </select>
                                    </div>
                                    <div id="jtw-ce-depth-container" style="margin-bottom: 10px; display: none;">
                                        <label>深度值 (Depth)</label>
                                        <input type="number" id="jtw-ce-depth" class="jtw-input" value="4" min="0" max="999" />
                                    </div>
                                    <div style="margin-bottom: 10px;">
                                        <label>排序优先级</label>
                                        <input type="number" id="jtw-ce-order" class="jtw-input" value="100" min="0" />
                                    </div>
                                </div>
                                
                                <div class="jtw-ce-run-section">
                                    <button id="jtw-ce-run-extract" class="jtw-btn primary">运行提取</button>
                                    <button id="jtw-ce-preview-prompt" class="jtw-btn" style="margin-top: 8px;">📋 预览完整提示词</button>
                                    <div id="jtw-ce-settings-status" class="jtw-status" style="display: none;"></div>
                                </div>
                            </div>
                            
                            <!-- 右侧：提示词设置 -->
                            <div class="jtw-ce-settings-right">
                                <div class="jtw-section jtw-ce-prompts-section">
                                    <h4>提示词设置</h4>
                                    <div style="margin-bottom: 8px;">
                                        <label>User 消息 1</label>
                                        <textarea id="jtw-ce-prompt-u1" class="jtw-input" rows="2"></textarea>
                                    </div>
                                    <div style="margin-bottom: 8px;">
                                        <label>Assistant 消息 1</label>
                                        <textarea id="jtw-ce-prompt-a1" class="jtw-input" rows="2"></textarea>
                                    </div>
                                    <div style="margin-bottom: 8px;">
                                        <label>User 消息 2</label>
                                        <textarea id="jtw-ce-prompt-u2" class="jtw-input" rows="10"></textarea>
                                    </div>
                                    <div style="margin-bottom: 8px;">
                                        <label>Assistant 消息 2</label>
                                        <textarea id="jtw-ce-prompt-a2" class="jtw-input" rows="1"></textarea>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- 提取结果弹窗 -->
        <div id="jtw-ce-result-modal" class="jtw-modal" style="display: none;">
            <div class="jtw-modal-content jtw-ce-result-modal-content">
                <div class="jtw-modal-header">
                    <h3>📝 提取结果</h3>
                    <button class="jtw-modal-close jtw-ce-close-result">✕</button>
                </div>
                <div class="jtw-modal-body">
                    <div id="jtw-ce-result-count" class="jtw-ce-result-count"></div>
                    <textarea id="jtw-ce-result-content" class="jtw-ce-textarea" rows="16" placeholder="提取到的角色数据..."></textarea>
                    <div class="jtw-ce-result-hint">您可以在保存前修改上述内容</div>
                    <div class="jtw-ce-actions">
                        <div id="jtw-ce-result-status" class="jtw-status" style="display: none;"></div>
                        <button class="jtw-btn jtw-ce-close-result">取消</button>
                        <button id="jtw-ce-result-save" class="jtw-btn primary">保存到世界书</button>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- 提示词预览弹窗 -->
        <div id="jtw-ce-prompt-modal" class="jtw-modal" style="display: none;">
            <div class="jtw-modal-content jtw-ce-prompt-modal-content">
                <div class="jtw-modal-header">
                    <h3>📋 完整提示词预览</h3>
                    <button class="jtw-modal-close jtw-ce-close-prompt">✕</button>
                </div>
                <div class="jtw-modal-body">
                    <div id="jtw-ce-prompt-preview" class="jtw-ce-prompt-preview">
                        <div class="jtw-ce-loading">加载中...</div>
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
    if ($('#jtw-character-extract-modal').length === 0) {
        $('body').append(getModalHtml());
        // 绑定事件
        if (!eventsInitialized) {
            bindModalEvents();
        }
    }
}

/**
 * 绑定模态框事件
 */
function bindModalEvents() {
    const { getSettings, defaultSettings } = dependencies;
    const settings = getSettings();
    
    // 确保 characterExtract 对象存在
    if (!settings.characterExtract) {
        settings.characterExtract = { ...defaultSettings.characterExtract };
    }
    const charExtract = settings.characterExtract;
    const defaultCharExtract = defaultSettings.characterExtract;
    
    // 关闭主弹窗 - 只能通过 X 按钮关闭
    $('#jtw-character-extract-modal .jtw-ce-close-modal').off('click').on('click', function(e) {
        e.stopPropagation();
        hideModal();
    });
    // 在整个弹窗（包括遮罩层）上阻止所有事件冒泡
    $('#jtw-character-extract-modal').off('click mousedown pointerdown touchstart touchend').on('click mousedown pointerdown touchstart touchend', function(e) {
        e.stopPropagation();
    });
    
    // 关闭结果弹窗
    $('#jtw-ce-result-modal .jtw-ce-close-result').off('click').on('click', function(e) {
        e.stopPropagation();
        hideResultModal();
    });
    $('#jtw-ce-result-modal').off('click mousedown pointerdown touchstart touchend').on('click mousedown pointerdown touchstart touchend', function(e) {
        e.stopPropagation();
    });
    
    // 关闭提示词预览弹窗
    $('#jtw-ce-prompt-modal .jtw-ce-close-prompt').off('click').on('click', function(e) {
        e.stopPropagation();
        hidePromptModal();
    });
    $('#jtw-ce-prompt-modal').off('click mousedown pointerdown touchstart touchend').on('click mousedown pointerdown touchstart touchend', function(e) {
        e.stopPropagation();
    });
    
    // 标签页切换 - 直接绑定
    $('#jtw-character-extract-modal .jtw-ce-tab').off('click').on('click', function(e) {
        e.stopPropagation();
        const tab = $(this).data('tab');
        switchTab(tab);
    });
    
    // 前往设置按钮 - 直接绑定
    $('#jtw-character-extract-modal .jtw-ce-goto-settings').off('click').on('click', function(e) {
        e.stopPropagation();
        switchTab('settings');
    });
    
    // 保存条目编辑
    $('#jtw-ce-save-entry').off('click').on('click', saveEntryEdit);
    
    // 预览提示词弹窗
    $('#jtw-ce-preview-prompt').off('click').on('click', showPromptModal);
    
    // 运行提取
    $('#jtw-ce-run-extract').off('click').on('click', runAndShowResult);
    
    // 保存提取结果
    $('#jtw-ce-result-save').off('click').on('click', saveExtractionResult);
    
    // 条目名称
    $('#jtw-ce-entry-name').val(charExtract.characterListName || '出场角色列表').off('change').on('change', function() {
        charExtract.characterListName = $(this).val();
        if (saveSettingsCallback) saveSettingsCallback();
    });
    
    // 历史消息数量
    $('#jtw-ce-history-count').val(charExtract.historyCount || 50).off('change').on('change', function() {
        charExtract.historyCount = parseInt($(this).val()) || 50;
        if (saveSettingsCallback) saveSettingsCallback();
    });
    
    // 提示词设置
    $('#jtw-ce-prompt-u1').val(charExtract.promptU1 || defaultCharExtract.promptU1).off('change').on('change', function() {
        charExtract.promptU1 = $(this).val();
        if (saveSettingsCallback) saveSettingsCallback();
    });
    
    $('#jtw-ce-prompt-a1').val(charExtract.promptA1 || defaultCharExtract.promptA1).off('change').on('change', function() {
        charExtract.promptA1 = $(this).val();
        if (saveSettingsCallback) saveSettingsCallback();
    });
    
    $('#jtw-ce-prompt-u2').val(charExtract.promptU2 || defaultCharExtract.promptU2).off('change').on('change', function() {
        charExtract.promptU2 = $(this).val();
        if (saveSettingsCallback) saveSettingsCallback();
    });
    
    $('#jtw-ce-prompt-a2').val(charExtract.promptA2 || defaultCharExtract.promptA2).off('change').on('change', function() {
        charExtract.promptA2 = $(this).val();
        if (saveSettingsCallback) saveSettingsCallback();
    });
    
    // 条目位置
    $('#jtw-ce-position').val(charExtract.characterListPosition || 0).off('change').on('change', function() {
        charExtract.characterListPosition = parseInt($(this).val());
        if (charExtract.characterListPosition === 4) {
            $('#jtw-ce-depth-container').show();
        } else {
            $('#jtw-ce-depth-container').hide();
        }
        if (saveSettingsCallback) saveSettingsCallback();
    });
    
    if (charExtract.characterListPosition === 4) {
        $('#jtw-ce-depth-container').show();
    }
    
    $('#jtw-ce-depth').val(charExtract.characterListDepth || 4).off('change').on('change', function() {
        charExtract.characterListDepth = parseInt($(this).val()) || 4;
        if (saveSettingsCallback) saveSettingsCallback();
    });
    
    $('#jtw-ce-order').val(charExtract.characterListOrder || 100).off('change').on('change', function() {
        charExtract.characterListOrder = parseInt($(this).val()) || 100;
        if (saveSettingsCallback) saveSettingsCallback();
    });
    
    eventsInitialized = true;
}

/**
 * 渲染设置面板 HTML（简化版，模态框在 showModal 时动态创建）
 * @returns {string}
 */
export function renderSettingsPanel() {
    return `
        <div class="jtw-assistant-feature-content" id="jtw-character-extract-settings" style="display: none;">
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
