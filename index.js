/**
 * Project Amber Extension
 * 从 AI 输出中提取 JSON 数据并保存到世界书
 */

import { extension_settings, getContext } from "../../../extensions.js";
import { eventSource, event_types, saveSettingsDebounced } from "../../../../script.js";
import { 
    loadWorldInfo, 
    saveWorldInfo, 
    world_names, 
    world_info,
    METADATA_KEY,
    createWorldInfoEntry,
    checkWorldInfo
} from "../../../world-info.js";
import { oai_settings, getChatCompletionModel, chat_completion_sources } from "../../../openai.js";
import { ChatCompletionService } from "../../../custom-request.js";
import { power_user } from "../../../power-user.js";

// 故事助手模块
import * as StoryAssistant from "./modules/story-assistant/index.js";
import * as AskAmber from "./modules/story-assistant/ask-amber.js";
import * as CharacterExtract from "./modules/story-assistant/character-extract.js";
import * as StorySummary from "./modules/story-assistant/story-summary.js";
// 自定义任务模块
import * as CustomTasks from "./modules/custom-tasks/index.js";

const EXT_NAME = "Project Amber";
const EXT_ID = "JsonToWorldbook";

// 默认设置
const defaultSettings = {
    enabled: true,
    autoExtract: false,        // 是否自动从每条消息中提取
    targetWorldbook: "",       // 目标世界书名称（空则使用角色卡绑定的）
    entryPosition: 0,          // 条目插入位置
    entryOrder: 100,           // 条目排序
    depth: 4,                  // @ Depth 的深度值
    lastExtractedJson: null,   // 上次提取的 JSON
    // 快捷图标设置
    showQuickAccess: true,     // 是否显示聊天界面快捷图标
    // 自定义任务列表
    customTasks: [],           // 自定义任务条目数组
    // 提取设置
    historyCount: 50,          // 发送的历史消息数量
    extractModel: "",          // 自定义模型名称（留空使用当前模型）
    includeTags: "",           // 仅包括的标签列表（留空则不限制）
    applyExcludeAfterInclude: false,  // 提取包括标签后是否再执行排除处理
    excludeTags: "summary,safety",  // 要排除的标签列表
    thoughtTags: "think,thinking,thought",  // 思维链标签（会处理孤立闭合标签）
    aggressiveThoughtRemoval: false,  // 激进删除思维链：直接删除最后一个闭合标签前的所有内容
    // 角色提取设置
    characterExtract: {
        historyCount: 50,  // 角色提取使用的历史消息数量
        characterListPosition: 0,  // 角色列表条目位置
        characterListOrder: 100,   // 角色列表条目排序
        characterListDepth: 4,     // 角色列表 @ Depth 的深度值
        characterListName: "出场角色列表",  // 角色列表世界书条目名称
        // 角色提取提示词
        promptU1: "你是TRPG数据整理助手。从剧情文本中提取{{user}}遇到的所有角色/NPC，整理为JSON数组。",
        promptA1: "明白。请提供【世界观】和【剧情经历】，我将提取角色并以JSON数组输出。",
        promptU2: `**1. 世界观：**
<world_info>
{{description}}
{{worldInfo}}
玩家角色：{{user}}
{{persona}}
</world_info>

**2. {{user}}经历：**
<chat_history>
{{chatHistory}}
</chat_history>

## 输出要求
1. 返回一个合法 JSON 数组，使用标准 JSON 语法（键名和字符串都用半角双引号 "）
2. 文本内容中如需使用引号，请使用单引号或中文引号「」或“”，不要使用半角双引号 "
3. 如果没有新角色，以及无需更新时，返回 []

### 新增角色：
1. 提取有具体称呼的新角色，不包括{{user}}自己和<world_info>中已经存在设定信息的角色。

模板: [{
  "name": "角色名",
  "intro": "外貌特征、身材与身份的详细描述",
  "background": "角色生平与背景。解释由于什么过去导致了现在的性格。",
  "persona": "详细的性格描述",
  "speaking_style": "说话的语气、语速、口癖（如喜欢用'嗯'、'那个'）等。对待主角的态度（尊敬、喜爱、蔑视、恐惧等）。"
}]

### 更新角色：
1. 如果需要对已经存在的角色更新，请根据新的剧情经历更新其角色基本设定信息，不必记录剧情中发生的事情。
2. 并非所有条例都需要更新，只需填写有变化的部分，其他可省略。
3. 更新的方式为覆盖。若旧内容无变化，需在输出时，同时输出完整的旧内容，避免丢失。

举例: （假设intro与其他等无需更新）
[{
  "update_for": "需要更新的角色完整name",
  "name": "角色名更新",
  "background": "原有角色生平与背景 + 更新内容",
}]
`,
        promptA2: "了解，开始生成JSON:"
    },
    // 故事总结设置
    storySummary: {
        entryName: "故事总结",
        entryPosition: 0,
        entryDepth: 4,
        entryOrder: 100,
        summarizedFloors: {},  // { chatKey: lastSummarizedFloor }
        promptU1: "你是角色扮演游戏剧情总结器。你的任务是根据聊天历史，为玩家进行专业的剧情总结。",
        promptA1: "明白。我将根据聊天历史，生成故事总结。",
        promptU2: `【故事设定】
{{worldInfo}}

【历史记录】
<chat_history>
{{chatHistory}}
</chat_history>

【输出要求】
1. 使用第三人称，按时间顺序对到目前为止的游戏故事进行整理，记录所有的剧情事件。
2. 必须记录所有重点与关键信息，例如：具体设定或重要背景，特殊环境与物品描述，人物关系，故事伏笔等。
3. 任何事件都需要全面阐述前因后果，不可模糊与笼统。

模版：
name: 事件名
time: 事件发生的日期与时间，确保准确记录事件的时间点。
summary: 该事件的详细概述，描述事件的背景、经过和结果，提供足够的信息以理解事件的全貌。
nodes: 事件的细节节点（复数）。
- 节点名称: 该节点的详细描述，提供具体的信息和背景。`,
        promptA2: "了解，开始生成:"
    }

};

// ==================== JSON 解析工具 ==================== 

/**
 * 修复常见的 JSON 语法问题
 */
function fixJson(s) {
    if (!s || typeof s !== 'string') return s;

    let r = s.trim()
        .replace(/[""]/g, '"').replace(/['']/g, "'")
        .replace(/"([^"']+)'[\s]*:/g, '"$1":')
        .replace(/'([^"']+)"[\s]*:/g, '"$1":')
        .replace(/:[\s]*'([^']*)'[\s]*([,}\]])/g, ':"$1"$2')
        .replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":')
        .replace(/,[\s\n]*([}\]])/g, '$1')
        .replace(/:\s*undefined\b/g, ': null')
        .replace(/:\s*NaN\b/g, ': null');

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
 * 从文本中提取 JSON
 * @param {string|object} input - 输入文本或对象
 * @param {boolean} isArray - 是否期望返回数组
 * @returns {object|array|null}
 */
function extractJson(input, isArray = false) {
    if (!input) return null;

    // 处理已经是对象的输入
    if (typeof input === 'object' && input !== null) {
        if (isArray && Array.isArray(input)) return input;
        if (!isArray && !Array.isArray(input)) {
            const content = input.choices?.[0]?.message?.content
                ?? input.content ?? input.reasoning_content;
            if (content != null) return extractJson(String(content).trim(), isArray);
            if (!input.choices) return input;
        }
        return null;
    }

    const str = String(input).trim()
        .replace(/^\uFEFF/, '')
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
        .replace(/\r\n?/g, '\n');
    if (!str) return null;

    const tryParse = s => { try { return JSON.parse(s); } catch { return null; } };
    const ok = (o, arr) => o != null && (arr ? Array.isArray(o) : typeof o === 'object' && !Array.isArray(o));

    // 直接尝试解析
    let r = tryParse(str);
    if (ok(r, isArray)) return r;

    // 扫描所有 {...} 或 [...] 结构
    const open = isArray ? '[' : '{';
    const candidates = [];

    for (let i = 0; i < str.length; i++) {
        if (str[i] !== open) continue;

        let depth = 0, inString = false, esc = false;
        for (let j = i; j < str.length; j++) {
            const c = str[j];
            if (esc) { esc = false; continue; }
            if (c === '\\' && inString) { esc = true; continue; }
            if (c === '"') { inString = !inString; continue; }
            if (inString) continue;
            if (c === '{' || c === '[') depth++;
            else if (c === '}' || c === ']') depth--;
            if (depth === 0) {
                candidates.push({ start: i, end: j, text: str.slice(i, j + 1) });
                i = j;
                break;
            }
        }
    }

    // 按长度排序（大的优先）
    candidates.sort((a, b) => b.text.length - a.text.length);

    // 尝试解析每个候选
    for (const { text } of candidates) {
        r = tryParse(text);
        if (ok(r, isArray)) return r;

        const fixed = fixJson(text);
        r = tryParse(fixed);
        if (ok(r, isArray)) return r;
    }

    // 最后尝试：取第一个 { 到最后一个 } 之间的内容
    if (!isArray) {
        const firstBrace = str.indexOf('{');
        const lastBrace = str.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace > firstBrace) {
            const chunk = str.slice(firstBrace, lastBrace + 1);
            r = tryParse(chunk) || tryParse(fixJson(chunk));
            if (ok(r, isArray)) return r;
        }
    }

    return null;
}
/**
 * 仅提取指定标签内的内容，删除其他所有内容
 * @param {string} text - 输入文本
 * @param {string} tagsString - 逗号分隔的标签列表
 * @returns {string}
 */
function extractIncludeTags(text, tagsString) {
    if (!text || !tagsString) return text;
    
    const tags = tagsString.split(',').map(t => t.trim()).filter(t => t);
    if (tags.length === 0) return text;
    
    let extractedContent = [];
    
    for (const tag of tags) {
        // 查找最后一个开始标签的位置
        const openTagRegex = new RegExp(`<${tag}[^>]*>`, 'gi');
        let lastOpenMatch = null;
        let lastOpenIndex = -1;
        let match;
        
        // 找到所有开始标签，记录最后一个
        while ((match = openTagRegex.exec(text)) !== null) {
            lastOpenMatch = match;
            lastOpenIndex = match.index;
        }
        
        if (lastOpenIndex === -1) continue; // 没有找到开始标签
        
        // 从最后一个开始标签位置开始，查找最后一个结束标签
        const afterLastOpen = text.substring(lastOpenIndex);
        const closeTagRegex = new RegExp(`<\\/${tag}>`, 'gi');
        let lastCloseMatch = null;
        let lastCloseIndex = -1;
        
        while ((match = closeTagRegex.exec(afterLastOpen)) !== null) {
            lastCloseMatch = match;
            lastCloseIndex = match.index;
        }
        
        if (lastCloseIndex === -1) continue; // 没有找到结束标签
        
        // 提取从最后一个开始标签到最后一个结束标签之间的内容
        const startPos = lastOpenIndex + lastOpenMatch[0].length;
        const endPos = lastOpenIndex + lastCloseIndex;
        const content = text.substring(startPos, endPos).trim();
        
        if (content) {
            extractedContent.push(content);
        }
    }
    
    // 如果没有找到任何匹配，返回空字符串
    if (extractedContent.length === 0) return '';
    
    return extractedContent.join('\n\n');
}

/**
 * 根据设置中的标签列表，从文本中移除指定标签的内容
 * @param {string} text - 输入文本
 * @param {string} tagsString - 逗号分隔的标签列表
 * @returns {string}
 */
function removeTaggedContent(text, tagsString) {
    if (!text) return text;
    
    let result = text;
    const settings = getSettings();
        
    // 1. 独立处理思维链标签（处理孤立闭合标签）
    const thoughtTagsStr = settings.thoughtTags || 'think,thinking,thought';
    const thoughtTags = thoughtTagsStr.split(',').map(t => t.trim()).filter(t => t);
    
    for (const tag of thoughtTags) {
        if (settings.aggressiveThoughtRemoval) {
            // 激进模式：找到最后一个闭合标签，删除它之前的所有内容
            const lastCloseRegex = new RegExp(`^[\\s\\S]*<\\/${tag}>`, 'i');
            if (lastCloseRegex.test(result)) {
                result = result.replace(lastCloseRegex, '');
            }
        } else {
            // 标准模式：先删除完整配对的思维链标签
            const pairRegex = new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
            result = result.replace(pairRegex, '');
            
            // 然后处理孤立闭合标签
            const closeTagRegex = new RegExp(`<\\/${tag}>`, 'i');
            const openTagRegex = new RegExp(`<${tag}[^>]*>`, 'i');
            
            // 如果存在闭合标签但不存在开启标签，说明是跨消息的思维链
            if (closeTagRegex.test(result) && !openTagRegex.test(result)) {
                // 删除从开头到闭合标签（包括闭合标签）的所有内容
                const deleteRegex = new RegExp(`^[\\s\\S]*?<\\/${tag}>`, 'i');
                result = result.replace(deleteRegex, '');
            }
        }
    }
    
    // 2. 处理排除标签列表（删除完整配对的标签内容）
    if (tagsString) {
        const tags = tagsString.split(',').map(t => t.trim()).filter(t => t);
        for (const tag of tags) {
            const pairRegex = new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
            result = result.replace(pairRegex, '');
        }
    }
    
    return result.trim();
}

/**
 * 获取角色卡的世界书内容
 * @param {object} options - 选项
 * @param {boolean} options.activatedOnly - 是否仅获取被激活的条目（基于关键词匹配），默认为 true
 * @returns {Promise<string>}
 */
async function getWorldInfoContent(options = {}) {
    const { activatedOnly = true } = options;
    
    try {
        const targetBook = getCharacterWorldbook();
        if (!targetBook) return '';
        
        const worldData = await loadWorldInfo(targetBook);
        if (!worldData?.entries) return '';
        
        let activeEntries;
        
        if (activatedOnly) {
            // 主动执行世界书检查来获取激活的条目
            const activatedEntries = await refreshActivatedWorldInfoEntries({
                startLayer: options.startLayer,
                endLayer: options.endLayer
            });
            
            // 筛选出属于目标世界书的条目
            const activatedUids = new Set(
                activatedEntries
                    .filter(e => e.world === targetBook)
                    .map(e => e.uid)
            );
            
            if (activatedUids.size === 0) {
                // 如果没有匹配的激活条目，回退到 constant 条目
                console.log(`[${EXT_NAME}] 没有匹配的激活条目，仅返回 constant 条目`);
                const entriesArray = Object.values(worldData.entries);
                activeEntries = entriesArray.filter(e => 
                    e && !e.disable && e.content && e.constant
                );
            } else {
                // 从世界书数据中获取这些条目
                const entriesArray = Object.values(worldData.entries);
                activeEntries = entriesArray.filter(e => 
                    e && !e.disable && e.content && activatedUids.has(e.uid)
                );
            }
        } else {
            // 获取所有启用的条目（原有逻辑）
            const entriesArray = Object.values(worldData.entries);
            activeEntries = entriesArray.filter(e => 
                e && !e.disable && e.content
            );
        }
        
        if (activeEntries.length === 0) return '';
        
        // 按 order 升序排序（order 越小越靠前，在提示词顶部）
        activeEntries.sort((a, b) => (a.order || 0) - (b.order || 0));
        
        // 格式化为文本
        const lines = activeEntries.map(e => {
            const keys = Array.isArray(e.key) ? e.key.join(', ') : e.key;
            const title = e.comment || keys || '未命名条目';
            return `[${title}]\n${e.content}`;
        });
        
        return '\n\n' + lines.join('\n\n');
    } catch (e) {
        console.error(`[${EXT_NAME}] 获取世界书内容失败:`, e);
        return '';
    }
}

/**
 * 主动刷新激活的世界书条目
 * @param {object} options - 选项
 * @param {number} options.startLayer - 开始层数（1-based，可选）
 * @param {number} options.endLayer - 结束层数（1-based，可选）
 * @returns {Promise<Array>} 激活的条目数组
 */
async function refreshActivatedWorldInfoEntries(options = {}) {
    try {
        const settings = getSettings();
        const ctx = getContext();
        const chat = ctx.chat || [];
        const totalMessages = chat.length;
        
        let messagesToScan = chat;
        
        // 如果指定了层数范围，只获取该范围的消息
        if (options.startLayer || options.endLayer) {
            const startLayer = options.startLayer ? Math.max(1, parseInt(options.startLayer)) : 1;
            const endLayer = options.endLayer ? Math.min(totalMessages, parseInt(options.endLayer)) : totalMessages;
            
            // 转换为数组索引（层数从1开始，数组索引从0开始）
            const startIndex = startLayer - 1;
            const endIndex = endLayer;
            
            messagesToScan = chat.slice(startIndex, endIndex);
            console.log(`[${EXT_NAME}] 检查世界书激活条目，层数范围: ${startLayer}-${endLayer} (共 ${messagesToScan.length} 条消息)`);
        } else {
            // 没有指定层数范围，使用通用设置的历史消息数量
            const historyCount = settings.historyCount || 50;
            const actualCount = Math.min(historyCount, totalMessages);
            messagesToScan = chat.slice(-actualCount);
            console.log(`[${EXT_NAME}] 检查世界书激活条目，使用通用设置: 最近 ${actualCount} 条消息`);
        }
        
        // 构建聊天消息数组（checkWorldInfo 需要的格式是反向的消息数组）
        const chatMessages = messagesToScan.map(msg => msg.mes || '').reverse();
        
        // 使用一个较大的 maxContext 值，确保能扫描足够的内容
        const maxContext = 200000;
        
        // 调用 checkWorldInfo，isDryRun=true 表示不触发事件和副作用
        const result = await checkWorldInfo(chatMessages, maxContext, true);
        
        if (result?.allActivatedEntries) {
            const entries = Array.from(result.allActivatedEntries.values());
            console.log(`[${EXT_NAME}] 刷新了 ${entries.length} 个激活的世界书条目`);
            return entries;
        }
        
        return [];
    } catch (e) {
        console.error(`[${EXT_NAME}] 刷新激活世界书条目失败:`, e);
        return [];
    }
}

/**
 * 获取聊天历史并进行预处理
 * @param {number} count - 获取的消息数量
 * @returns {string}
 */
function getChatHistory(count) {
    const ctx = getContext();
    const chat = ctx.chat || [];
    const settings = getSettings();
    
    const recentMessages = chat.slice(-count);
    const lines = recentMessages.map(msg => {
        const name = msg.is_user ? (ctx.name1 || '{{user}}') : (msg.name || ctx.name2 || '{{char}}');
        let content = msg.mes || '';
        
        // 1. 先处理仅包括标签（如果设置了）
        if (settings.includeTags && settings.includeTags.trim()) {
            content = extractIncludeTags(content, settings.includeTags);
            
            // 如果开启了额外排除处理，则继续处理
            if (settings.applyExcludeAfterInclude && content) {
                content = removeTaggedContent(content, settings.excludeTags);
            }
        } else {
            // 2. 没有仅包括标签时，直接移除排除标签内容
            content = removeTaggedContent(content, settings.excludeTags);
        }
        
        return `${name}: ${content}`;
    });
    
    return lines.join('\n\n');
}

/**
 * 获取指定楼层范围的聊天历史并进行预处理
 * @param {number} startFloor - 起始楼层（1-based）
 * @param {number} endFloor - 结束楼层（1-based）
 * @returns {string}
 */
function getChatHistoryRange(startFloor, endFloor) {
    const ctx = getContext();
    const chat = ctx.chat || [];
    const settings = getSettings();

    // 楼层从1开始，数组索引从0开始
    const startIdx = Math.max(0, startFloor - 1);
    const endIdx = Math.min(chat.length, endFloor);

    const messages = chat.slice(startIdx, endIdx);
    const lines = messages.map(msg => {
        const name = msg.is_user ? (ctx.name1 || '{{user}}') : (msg.name || ctx.name2 || '{{char}}');
        let content = msg.mes || '';

        // 1. 先处理仅包括标签（如果设置了）
        if (settings.includeTags && settings.includeTags.trim()) {
            content = extractIncludeTags(content, settings.includeTags);

            // 如果开启了额外排除处理，则继续处理
            if (settings.applyExcludeAfterInclude && content) {
                content = removeTaggedContent(content, settings.excludeTags);
            }
        } else {
            // 2. 没有仅包括标签时，直接移除排除标签内容
            content = removeTaggedContent(content, settings.excludeTags);
        }

        return `${name}: ${content}`;
    });

    return lines.join('\n\n');
}

/**
 * 调用 LLM API
 * @param {Array} messages - 消息数组
 * @returns {Promise<string>}
 */
async function callLLM(messages) {
    const settings = getSettings();
    
    // 获取当前 API 源
    const source = oai_settings?.chat_completion_source;
    if (!source) {
        throw new Error('未配置 API，请先在酒馆中配置 API');
    }
    
    // 获取模型
    const model = settings.extractModel?.trim() || getChatCompletionModel();
    if (!model) {
        throw new Error('未检测到模型，请在设置中指定模型或在酒馆中选择模型');
    }
    
    console.log(`[${EXT_NAME}] 调用 LLM: source=${source}, model=${model}`);
    
    // 构建请求体
    const body = {
        stream: false,
        messages,
        model,
        chat_completion_source: source,
        max_tokens: oai_settings?.openai_max_tokens || 4096,
        temperature: oai_settings?.temp_openai ?? 0.7,
    };
    
    // 处理代理设置
    const PROXY_SUPPORTED = new Set([
        chat_completion_sources.OPENAI,
        chat_completion_sources.CLAUDE,
        chat_completion_sources.MAKERSUITE,
        chat_completion_sources.DEEPSEEK,
    ]);
    
    if (PROXY_SUPPORTED.has(source) && oai_settings?.reverse_proxy) {
        body.reverse_proxy = String(oai_settings.reverse_proxy).replace(/\/?$/, '');
        if (oai_settings?.proxy_password) {
            body.proxy_password = String(oai_settings.proxy_password);
        }
    }
    
    if (source === chat_completion_sources.CUSTOM) {
        if (oai_settings?.custom_url) {
            body.custom_url = String(oai_settings.custom_url);
        }
        if (oai_settings?.custom_include_headers) {
            body.custom_include_headers = oai_settings.custom_include_headers;
        }
        if (oai_settings?.custom_include_body) {
            body.custom_include_body = oai_settings.custom_include_body;
        }
        if (oai_settings?.custom_exclude_body) {
            body.custom_exclude_body = oai_settings.custom_exclude_body;
        }
    }
    
    // 发送请求
    const payload = ChatCompletionService.createRequestData(body);
    const response = await ChatCompletionService.sendRequest(payload, false);
    
    // 解析响应
    let result = '';
    if (response && typeof response === 'object') {
        const msg = response?.choices?.[0]?.message;
        result = String(
            msg?.content ??
            msg?.reasoning_content ??
            response?.choices?.[0]?.text ??
            response?.content ??
            response?.reasoning_content ??
            ''
        );
    } else {
        result = String(response ?? '');
    }
    
    return result;
}

/**
 * 调用 LLM 并解析 JSON 结果
 * @param {Array} messages - 消息数组
 * @param {boolean} isArray - 是否期望返回数组
 * @returns {Promise<object|array|null>}
 */
async function callLLMJson(messages, isArray = false) {
    try {
        const result = await callLLM(messages);
        console.log(`[${EXT_NAME}] LLM 返回:`, result.slice(0, 500));
        
        const parsed = extractJson(result, isArray);
        if (parsed) {
            console.log(`[${EXT_NAME}] 解析成功:`, parsed);
            return parsed;
        }
        
        console.warn(`[${EXT_NAME}] JSON 解析失败`);
        return null;
    } catch (e) {
        console.error(`[${EXT_NAME}] LLM 调用失败:`, e);
        throw e;
    }
}

// ==================== 世界书操作 ====================

/**
 * 获取角色卡绑定的主世界书
 */
function getCharacterWorldbook() {
    const ctx = getContext();
    const char = ctx.characters?.[ctx.characterId];
    if (!char) return null;
    
    const primary = char.data?.extensions?.world;
    if (primary && world_names?.includes(primary)) {
        return primary;
    }
    return null;
}

/**
 * 获取可用的世界书列表
 */
function getAvailableWorldbooks() {
    return Array.isArray(world_names) ? world_names.slice() : [];
}

/**
 * 将 JSON 对象转换为 YAML 格式字符串
 */
function jsonToYaml(data, indent = 0) {
    const sp = ' '.repeat(indent);
    if (data === null || data === undefined) return '';
    if (typeof data !== 'object') return String(data);
    if (Array.isArray(data)) {
        return data.map(item => typeof item === 'object' && item !== null
            ? `${sp}- ${jsonToYaml(item, indent + 2).trimStart()}`
            : `${sp}- ${item}`
        ).join('\n');
    }
    return Object.entries(data).map(([key, value]) => {
        if (typeof value === 'object' && value !== null) {
            if (Array.isArray(value) && !value.length) return `${sp}${key}: []`;
            if (!Array.isArray(value) && !Object.keys(value).length) return `${sp}${key}: {}`;
            return `${sp}${key}:\n${jsonToYaml(value, indent + 2)}`;
        }
        return `${sp}${key}: ${value}`;
    }).join('\n');
}

/**
 * 保存 JSON 数据到世界书
 * @param {object} jsonData - 要保存的 JSON 数据
 * @param {object} options - 选项
 * @returns {Promise<{success: boolean, uid?: string, error?: string}>}
 */
async function saveJsonToWorldbook(jsonData, options = {}) {
    try {
        const settings = getSettings();
        
        // 确定目标世界书
        let targetBook = options.worldbook || settings.targetWorldbook;
        if (!targetBook) {
            targetBook = getCharacterWorldbook();
        }
        
        if (!targetBook || !world_names?.includes(targetBook)) {
            return { success: false, error: "未找到有效的世界书，请先绑定或选择世界书" };
        }

        // 加载世界书
        const worldData = await loadWorldInfo(targetBook);
        if (!worldData) {
            return { success: false, error: `无法加载世界书: ${targetBook}` };
        }

        // 确定条目名称和关键词
        const entryName = options.name || jsonData.name || jsonData.title || `JSON Entry ${Date.now()}`;
        const keys = options.keys || jsonData.aliases || jsonData.keys || [entryName];

        // 检查是否存在同名条目
        let entry = null;
        let isUpdate = false;
        
        if (worldData.entries && typeof worldData.entries === 'object') {
            const entriesArray = Object.values(worldData.entries);
            const existingEntry = entriesArray.find(e => e && e.comment === entryName);
            if (existingEntry) {
                entry = existingEntry;
                isUpdate = true;
                console.log(`[${EXT_NAME}] 找到同名条目，将进行更新: ${entryName} (UID: ${entry.uid})`);
            }
        }

        // 如果不存在，创建新条目
        if (!entry) {
            const { createWorldInfoEntry } = await import("../../../world-info.js");
            entry = createWorldInfoEntry(targetBook, worldData);
            if (!entry) {
                return { success: false, error: "创建世界书条目失败" };
            }
        }

        // 准备内容数据（删除 keys、aliases 和世界书设置字段，避免在内容中重复）
        const contentData = { ...jsonData };
        delete contentData.keys;
        delete contentData.aliases;
        delete contentData.constant;
        delete contentData.selective;
        delete contentData.position;
        delete contentData.depth;
        delete contentData.order;
        delete contentData.excludeRecursion;
        delete contentData.preventRecursion;
        delete contentData.keysecondary;

        // 设置条目属性（优先级：jsonData > options > settings > 默认值）
        const position = jsonData.position ?? options.position ?? settings.entryPosition ?? 0;
        const entryConfig = {
            key: Array.isArray(keys) ? keys : [keys],
            comment: entryName,
            content: (options.asJson ? JSON.stringify(contentData, null, 2) : jsonToYaml(contentData)) + '\n\n',
            constant: jsonData.constant ?? options.constant ?? false,
            selective: jsonData.selective ?? options.selective ?? true,
            disable: options.disable ?? false,
            position: position,
            order: jsonData.order ?? options.order ?? settings.entryOrder ?? 100,
        };
        
        // depth 只在 position=4 时设置
        if (position === 4) {
            entryConfig.depth = jsonData.depth ?? options.depth ?? settings.depth ?? 4;
        }
        
        // 设置递归相关属性（如果 JSON 中有定义）
        if (jsonData.excludeRecursion !== undefined) {
            entryConfig.excludeRecursion = jsonData.excludeRecursion;
        }
        if (jsonData.preventRecursion !== undefined) {
            entryConfig.preventRecursion = jsonData.preventRecursion;
        } else {
            entryConfig.preventRecursion = true; // 默认启用
        }
        
        // 次要关键词（SillyTavern 使用 keysecondary 字段）
        if (jsonData.keysecondary !== undefined) {
            entryConfig.keysecondary = Array.isArray(jsonData.keysecondary) 
                ? jsonData.keysecondary 
                : [jsonData.keysecondary];
        }
        
        Object.assign(entry, entryConfig);

        // 保存世界书
        await saveWorldInfo(targetBook, worldData, true);

        console.log(`[${EXT_NAME}] 条目已${isUpdate ? '更新' : '保存'}到 ${targetBook}, UID: ${entry.uid}`);
        
        return { success: true, uid: String(entry.uid), worldbook: targetBook, isUpdate };
    } catch (e) {
        console.error(`[${EXT_NAME}] 保存失败:`, e);
        return { success: false, error: e.message };
    }
}

// ==================== 设置管理 ====================

function getSettings() {
    if (!extension_settings[EXT_ID]) {
        extension_settings[EXT_ID] = { ...defaultSettings };
    }
    return extension_settings[EXT_ID];
}

function saveSettings() {
    saveSettingsDebounced();
}

// ==================== UI ====================

function createSettingsUI() {
    const settingsHtml = `
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>Project琥珀</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content" id="json-to-worldbook-panel">
            <!-- 标签页导航 -->
            <div class="jtw-tabs">
                <button class="jtw-tab active" data-tab="json-extract">JSON提取</button>
                <button class="jtw-tab" data-tab="story-assistant">故事助手</button>
                <button class="jtw-tab" data-tab="custom-tasks">自定义任务</button>
                <button class="jtw-tab" data-tab="common-settings">⚙️</button>
            </div>
            
            <!-- JSON提取页面 -->
            <div class="jtw-tab-content active" id="json-extract">
                <div class="jtw-section">
                    <h4>基本设置</h4>
                    <div class="jtw-checkbox-row">
                        <input type="checkbox" id="jtw-enabled" />
                        <label for="jtw-enabled">启用扩展</label>
                    </div>
                    <div class="jtw-checkbox-row">
                        <input type="checkbox" id="jtw-auto-extract" />
                        <label for="jtw-auto-extract">自动提取（每条AI消息）</label>
                    </div>
                </div>
                
                <div class="jtw-section">
                    <h4>世界书设置</h4>
                    <div class="jtw-hint" style="margin-bottom: 10px;">💡 若JSON中已包含世界书属性（如keys、position、depth等），将优先使用JSON中的设置</div>
                    <label>目标世界书（留空使用角色卡绑定的）</label>
                    <select id="jtw-target-worldbook" class="jtw-select">
                        <option value="">-- 使用角色卡世界书 --</option>
                    </select>
                    <div style="margin-top: 10px;">
                        <label>条目位置</label>
                        <select id="jtw-entry-position" class="jtw-select">
                            <option value="0">角色定义之前</option>
                            <option value="1">角色定义之后</option>
                            <option value="2">作者注释之前</option>
                            <option value="3">作者注释之后</option>
                            <option value="4">@ Depth</option>
                        </select>
                    </div>
                    <div id="jtw-depth-container" style="margin-top: 10px; display: none;">
                        <label>深度值 (Depth)</label>
                        <input type="number" id="jtw-depth" class="jtw-input" value="4" min="0" max="999" />
                    </div>
                    <div style="margin-top: 10px;">
                        <label>排序优先级</label>
                        <input type="number" id="jtw-entry-order" class="jtw-input" value="100" min="0" />
                    </div>
                </div>
                
                <div class="jtw-section">
                    <h4>手动操作</h4>
                    <button id="jtw-extract-last" class="jtw-btn">从最后一条消息提取</button>
                    <button id="jtw-save-to-wb" class="jtw-btn primary" disabled>保存到世界书</button>
                    <div id="jtw-status" class="jtw-status" style="display: none;"></div>
                    <div id="jtw-json-preview" class="jtw-json-preview" style="display: none;"></div>
                </div>
            </div>
            
            <!-- 故事助手页面 -->
            <div class="jtw-tab-content" id="story-assistant">
                <!-- 故事助手内容由模块动态生成 -->
            </div>
            
            <!-- 自定义任务页面 -->
            <div class="jtw-tab-content" id="custom-tasks">
                <!-- 自定义任务内容由模块动态生成 -->
            </div>
            
            <!-- 通用设置页面 -->
            <div class="jtw-tab-content" id="common-settings">
                <div class="jtw-section">
                    <h4>模型设置</h4>
                    <div style="margin-bottom: 10px;">
                        <label>使用模型（留空使用当前模型）</label>
                        <input type="text" id="jtw-extract-model" class="jtw-input" placeholder="留空使用当前模型" />
                    </div>
                </div>
                
                <div class="jtw-section">
                    <h4>提取设置</h4>
                    <div style="margin-bottom: 10px;">
                        <label>历史消息数量</label>
                        <input type="number" id="jtw-history-count" class="jtw-input" value="50" min="10" max="200" />
                    </div>
                    
                    <h4 style="margin-top: 15px;">界面设置</h4>
                    <div class="jtw-checkbox-row" style="margin-bottom: 10px;">
                        <input type="checkbox" id="jtw-show-quick-access" />
                        <label for="jtw-show-quick-access">显示聊天界面快捷图标</label>
                        <div class="jtw-hint" style="margin-left: 24px;">在聊天界面右侧显示快捷图标，快速打开问问琥珀、角色提取和自定义任务</div>
                    </div>
                    
                    <h4 style="margin-top: 15px;">标签处理</h4>
                    <div style="margin-bottom: 10px;">
                        <label>仅包括标签（逗号分隔）</label>
                        <input type="text" id="jtw-include-tags" class="jtw-input" placeholder="main_plot" />
                        <div class="jtw-hint">只提取这些标签内的内容，留空则不限制</div>
                    </div>
                    <div class="jtw-checkbox-row" style="margin-bottom: 10px;">
                        <input type="checkbox" id="jtw-apply-exclude-after-include" />
                        <label for="jtw-apply-exclude-after-include">提取包括标签后再执行排除处理</label>
                    </div>
                    <div style="margin-bottom: 10px;">
                        <label>排除的标签（逗号分隔）</label>
                        <input type="text" id="jtw-exclude-tags" class="jtw-input" placeholder="think,summary,safety" />
                        <div class="jtw-hint">这些标签内的文本会在发送前被移除</div>
                    </div>
                    <div style="margin-bottom: 10px;">
                        <label>思维链标签（逗号分隔）</label>
                        <input type="text" id="jtw-thought-tags" class="jtw-input" placeholder="think,thinking,thought" />
                        <div class="jtw-hint">思维链标签会特殊处理：如果只存在闭合标签（如&lt;/think&gt;），会删除从开头到闭合标签的所有内容</div>
                    </div>
                    <div class="jtw-checkbox-row" style="margin-bottom: 10px;">
                        <input type="checkbox" id="jtw-aggressive-thought-removal" />
                        <label for="jtw-aggressive-thought-removal">激进删除思维链</label>
                        <div class="jtw-hint" style="margin-left: 24px;">勾选后，直接删除最后一个思维链闭合标签之前的所有内容，不检查是否有对应的开启标签</div>
                    </div>
                </div>
            </div>
        </div>
    </div>`;

    $('#extensions_settings2').append(settingsHtml);
    
    // 初始化自定义任务模块
    CustomTasks.init({
        getSettings,
        getContext,
        getChatHistory,
        getWorldInfoContent,
        callLLMJson,
        saveJsonToWorldbook: (jsonData, options) => saveJsonToWorldbook(jsonData, options),
        updateWorldbookSelect,
        getCharacterWorldbook,
        getAvailableWorldbooks,
        jsonToYaml,
        loadWorldInfo,
        saveWorldInfo,
        createWorldInfoEntry,
        extractIncludeTags,
        removeTaggedContent,
        power_user,
        EXT_NAME
    });
    
    // 先渲染自定义任务面板内容（必须在事件绑定之前）
    $('#custom-tasks').html(CustomTasks.renderCustomTasksPanel());
    
    // 再绑定事件和渲染任务列表
    CustomTasks.initTaskEvents(saveSettings);
    CustomTasks.renderTaskList();

    // 标签页切换
    $('.jtw-tab').on('click', function() {
        const tab = $(this).data('tab');
        $('.jtw-tab').removeClass('active');
        $('.jtw-tab-content').removeClass('active');
        $(this).addClass('active');
        $(`#${tab}`).addClass('active');
    });

    // 绑定事件
    const settings = getSettings();

    $('#jtw-enabled').prop('checked', settings.enabled).on('change', function() {
        settings.enabled = $(this).prop('checked');
        saveSettings();
    });

    $('#jtw-auto-extract').prop('checked', settings.autoExtract).on('change', function() {
        settings.autoExtract = $(this).prop('checked');
        saveSettings();
    });

    // 填充世界书下拉列表
    updateWorldbookSelect();

    $('#jtw-target-worldbook').val(settings.targetWorldbook).on('change', function() {
        settings.targetWorldbook = $(this).val();
        saveSettings();
    });

    $('#jtw-entry-position').val(settings.entryPosition).on('change', function() {
        settings.entryPosition = parseInt($(this).val());
        // 显示/隐藏深度输入框
        if (settings.entryPosition === 4) {
            $('#jtw-depth-container').show();
        } else {
            $('#jtw-depth-container').hide();
        }
        saveSettings();
    });
    
    // 初始化深度输入框显示状态
    if (settings.entryPosition === 4) {
        $('#jtw-depth-container').show();
    }
    
    $('#jtw-depth').val(settings.depth || 4).on('change', function() {
        settings.depth = parseInt($(this).val()) || 4;
        saveSettings();
    });

    $('#jtw-entry-order').val(settings.entryOrder).on('change', function() {
        settings.entryOrder = parseInt($(this).val()) || 100;
        saveSettings();
    });

    // 手动提取按钮
    $('#jtw-extract-last').on('click', extractFromLastMessage);
    
    // 保存按钮
    $('#jtw-save-to-wb').on('click', saveExtractedJson);
    
    // 高级设置面板折叠
    $('.jtw-advanced-toggle').on('click', function() {
        const $content = $(this).next('.jtw-advanced-content');
        const $icon = $(this).find('i');
        $content.slideToggle(200);
        $icon.toggleClass('fa-chevron-down fa-chevron-up');
    });
    
    // 思维链清洗设置绑定
    $('#jtw-clean-cot-enabled').prop('checked', settings.cleanCotEnabled ?? false).on('change', function() {
        settings.cleanCotEnabled = $(this).prop('checked');
        saveSettings();
    });
    
    $('#jtw-cot-close-tag').val(settings.cotCloseTag || '</think>').on('change', function() {
        settings.cotCloseTag = $(this).val();
        saveSettings();
    });
    
    $('#jtw-cot-open-tag').val(settings.cotOpenTag || '<think>').on('change', function() {
        settings.cotOpenTag = $(this).val();
        saveSettings();
    });
    
    $('#jtw-force-remove-cot').prop('checked', settings.forceRemoveCot ?? false).on('change', function() {
        settings.forceRemoveCot = $(this).prop('checked');
        saveSettings();
    });
    
    // 通用设置 - 模型设置
    $('#jtw-extract-model').val(settings.extractModel || '').on('change', function() {
        settings.extractModel = $(this).val();
        saveSettings();
    });
    
    $('#jtw-history-count').val(settings.historyCount || 50).on('change', function() {
        settings.historyCount = parseInt($(this).val()) || 50;
        saveSettings();
    });
    
    $('#jtw-include-tags').val(settings.includeTags || '').on('change', function() {
        settings.includeTags = $(this).val();
        saveSettings();
    });
    
    $('#jtw-apply-exclude-after-include').prop('checked', settings.applyExcludeAfterInclude || false).on('change', function() {
        settings.applyExcludeAfterInclude = $(this).prop('checked');
        saveSettings();
    });
    
    $('#jtw-exclude-tags').val(settings.excludeTags || '').on('change', function() {
        settings.excludeTags = $(this).val();
        saveSettings();
    });
    
    $('#jtw-thought-tags').val(settings.thoughtTags || 'think,thinking,thought').on('change', function() {
        settings.thoughtTags = $(this).val();
        saveSettings();
    });
    
    $('#jtw-aggressive-thought-removal').prop('checked', settings.aggressiveThoughtRemoval || false).on('change', function() {
        settings.aggressiveThoughtRemoval = $(this).prop('checked');
        saveSettings();
    });
    
    // 快捷图标开关
    $('#jtw-show-quick-access').prop('checked', settings.showQuickAccess ?? true).on('change', function() {
        settings.showQuickAccess = $(this).prop('checked');
        saveSettings();
        toggleQuickAccessPanel(settings.showQuickAccess);
    });
    
    // 初始化故事助手
    initStoryAssistantModule();
}

/**
 * 初始化故事助手模块
 */
function initStoryAssistantModule() {
    // 创建依赖对象供模块使用
    const moduleDependencies = {
        getSettings,
        defaultSettings,
        getContext,
        getCharacterWorldbook,
        loadWorldInfo,
        saveWorldInfo,
        createWorldInfoEntry,
        jsonToYaml,
        world_names,
        getChatHistory,
        getChatHistoryRange,
        getWorldInfoContent,
        extractIncludeTags,
        removeTaggedContent,
        callLLM,
        callLLMJson,
        power_user
    };
    
    // 初始化故事助手管理器
    StoryAssistant.initStoryAssistant(moduleDependencies);
    
    // 注册问问琥珀模块（放在第一位）
    StoryAssistant.registerModule(AskAmber);
    
    // 注册角色提取模块
    StoryAssistant.registerModule(CharacterExtract);
    
    // 注册故事总结模块
    StoryAssistant.registerModule(StorySummary);
    
    // 渲染故事助手页面
    const storyAssistantHtml = StoryAssistant.renderStoryAssistantPanel();
    $('#story-assistant').html(storyAssistantHtml);
    
    // 初始化故事助手事件
    StoryAssistant.initStoryAssistantEvents(saveSettings);
}

function updateWorldbookSelect() {
    const $select = $('#jtw-target-worldbook');
    const currentVal = $select.val();
    $select.find('option:not(:first)').remove();
    
    getAvailableWorldbooks().forEach(name => {
        $select.append(`<option value="${name}">${name}</option>`);
    });
    
    if (currentVal) {
        $select.val(currentVal);
    }
}

function showStatus(message, isError = false) {
    const $status = $('#jtw-status');
    $status.text(message)
        .removeClass('success error')
        .addClass(isError ? 'error' : 'success')
        .show();
    
    setTimeout(() => $status.fadeOut(), 5000);
}

function showJsonPreview(json) {
    const $preview = $('#jtw-json-preview');
    if (json) {
        // 转换为YAML格式
        const yamlContent = jsonToYaml(json, 0);
        $preview.text(yamlContent).show();
        $('#jtw-save-to-wb').prop('disabled', false);
    } else {
        $preview.hide();
        $('#jtw-save-to-wb').prop('disabled', true);
    }
}

// ==================== 核心功能 ====================

/**
 * 从最后一条 AI 消息中提取 JSON
 */
function extractFromLastMessage() {
    const ctx = getContext();
    const chat = ctx.chat;
    
    if (!chat || chat.length === 0) {
        showStatus("没有聊天记录", true);
        return null;
    }

    // 找到最后一条 AI 消息
    for (let i = chat.length - 1; i >= 0; i--) {
        const msg = chat[i];
        if (!msg.is_user && msg.mes) {
            const json = extractJson(msg.mes);
            if (json) {
                const settings = getSettings();
                settings.lastExtractedJson = json;
                saveSettings();
                
                showStatus("成功提取 JSON 数据");
                showJsonPreview(json);
                return json;
            }
        }
    }

    showStatus("未能从消息中提取到有效的 JSON", true);
    showJsonPreview(null);
    return null;
}

/**
 * 保存已提取的 JSON 到世界书
 */
async function saveExtractedJson() {
    const settings = getSettings();
    const json = settings.lastExtractedJson;
    
    if (!json) {
        showStatus("没有可保存的 JSON 数据", true);
        return;
    }

    const result = await saveJsonToWorldbook(json);
    
    if (result.success) {
        showStatus(`已${result.isUpdate ? '更新' : '保存'}到 ${result.worldbook} (UID: ${result.uid})`);
        settings.lastExtractedJson = null;
        showJsonPreview(null);
        saveSettings();
    } else {
        showStatus(result.error, true);
    }
}

/**
 * 处理新消息（自动提取模式）
 */
async function onMessageReceived(mesId) {
    const settings = getSettings();
    if (!settings.enabled || !settings.autoExtract) return;

    const ctx = getContext();
    const msg = ctx.chat?.[mesId];
    
    if (!msg || msg.is_user) return;

    const json = extractJson(msg.mes);
    if (json) {
        console.log(`[${EXT_NAME}] 自动提取到 JSON:`, json);
        
        // 直接保存到世界书
        const result = await saveJsonToWorldbook(json);
        
        if (result.success) {
            console.log(`[${EXT_NAME}] 自动保存成功: ${result.worldbook} (UID: ${result.uid})`);
            // 成功时不显示提示，保持界面简洁
        } else {
            // 只在失败时显示提示
            showStatus(`自动保存失败: ${result.error}`, true);
        }
    }
}

// ==================== 快捷图标面板 ====================

/**
 * 创建快捷图标面板
 */
function createQuickAccessPanel() {
    // 移除已存在的面板
    $('#jtw-quick-access-panel').remove();
    
    const quickAccessHtml = `
        <div id="jtw-quick-access-panel" class="jtw-quick-access">
            <div class="jtw-quick-access-toggle" title="Project Amber 快捷菜单">
            </div>
            <div class="jtw-quick-access-menu">
                <div class="jtw-quick-access-item" data-action="ask-amber" title="问问琥珀">
                    <i class="fa-regular fa-comments"></i>
                    <span>问问琥珀</span>
                </div>
                <div class="jtw-quick-access-item" data-action="character-extract" title="角色提取">
                    <i class="fa-solid fa-users"></i>
                    <span>角色提取</span>
                </div>
                <div class="jtw-quick-access-item" data-action="story-summary" title="故事总结">
                    <i class="fa-solid fa-book"></i>
                    <span>故事总结</span>
                </div>
                <div class="jtw-quick-access-item" data-action="custom-tasks" title="自定义任务">
                    <i class="fa-solid fa-list-check"></i>
                    <span>自定义任务</span>
                </div>
            </div>
        </div>
    `;
    
    // 添加到聊天区域容器（sheld），如果不存在则添加到 body
    const $chatContainer = $('#sheld');
    if ($chatContainer.length) {
        $chatContainer.append(quickAccessHtml);
    } else {
        $('body').append(quickAccessHtml);
    }
    
    // 绑定事件
    bindQuickAccessEvents();
    
    // 根据设置决定是否显示
    const settings = getSettings();
    toggleQuickAccessPanel(settings.showQuickAccess ?? true);
}

/**
 * 绑定快捷面板事件
 */
function bindQuickAccessEvents() {
    const $panel = $('#jtw-quick-access-panel');
    const $toggle = $panel.find('.jtw-quick-access-toggle');
    const $menu = $panel.find('.jtw-quick-access-menu');
    
    // 拖拽相关变量
    let isDragging = false;
    let hasMoved = false;
    let startY = 0;
    let startTop = 0;
    let dragStartTime = 0;
    
    // 获取可视区域的边界（使用窗口高度而不是容器高度）
    const getVisibleBounds = () => {
        const $parent = $panel.parent();
        const parentOffset = $parent.offset();
        const parentScrollTop = $parent.scrollTop() || 0;
        const windowHeight = $(window).height();
        const windowWidth = $(window).width();
        
        // 计算父容器在屏幕中的可见部分
        const parentTop = parentOffset ? parentOffset.top : 0;
        const visibleTop = Math.max(0, -parentTop + parentScrollTop);
        const visibleBottom = Math.min($parent.height(), windowHeight - parentTop + parentScrollTop);
        
        return {
            minTop: visibleTop + 10,
            maxTop: visibleBottom - ($panel.outerHeight() || 40) - 10
        };
    };

    // 根据图标位置更新菜单显示方向
    const updateMenuPosition = () => {
        const $parent = $panel.parent();
        const containerHeight = $parent.height();
        const currentTop = $panel[0].offsetTop;
        const panelCenter = currentTop + ($panel.outerHeight() || 40) / 2;
        
        // 如果图标在容器上半部分，菜单显示在下方；否则显示在上方
        if (panelCenter < containerHeight / 2) {
            $panel.addClass('menu-below');
        } else {
            $panel.removeClass('menu-below');
        }
    };

    // 限制位置在可视范围内
    const clampPosition = () => {
        const bounds = getVisibleBounds();
        let currentTop = $panel[0].offsetTop;
        
        let newTop = currentTop;
        if (newTop < bounds.minTop) newTop = bounds.minTop;
        if (newTop > bounds.maxTop) newTop = bounds.maxTop;
        
        if (newTop !== currentTop) {
            $panel.css({
                top: newTop + 'px',
                bottom: 'auto'
            });
        }
        
        // 更新菜单位置
        updateMenuPosition();
    };
    
    // 加载保存的位置
    const settings = getSettings();
    if (settings.quickAccessPosition) {
        const pos = settings.quickAccessPosition;
        $panel.css({
            top: pos.top !== undefined ? pos.top + 'px' : '',
            bottom: pos.top !== undefined ? 'auto' : (pos.bottom + 'px'),
            left: pos.side === 'left' ? '15px' : 'auto',
            right: pos.side === 'right' ? '15px' : 'auto',
            transform: 'none'
        });
        if (pos.side === 'left') {
            $panel.addClass('on-left');
        }
        
        // 加载后立即检查位置是否越界（例如从 PC 切换到手机预览）
        // 使用 setTimeout 确保 DOM 渲染完成
        setTimeout(() => {
            clampPosition();
            updateMenuPosition();
        }, 100);
    }

    // 监听窗口大小变化
    $(window).on('resize', () => {
        // 使用防抖或简单的 requestAnimationFrame 优化
        requestAnimationFrame(() => {
            clampPosition();
            updateMenuPosition();
        });
    });
    
    // 开始拖拽
    const startDrag = (e) => {
        // 如果菜单已展开，不允许拖拽
        if ($panel.hasClass('expanded')) return;
        
        isDragging = true;
        hasMoved = false;
        dragStartTime = Date.now();
        
        const clientY = e.type.includes('touch') ? e.originalEvent.touches[0].clientY : e.clientY;
        startY = clientY;
        
        // 获取当前位置 - 使用offsetTop以确保相对定位准确
        startTop = $panel[0].offsetTop;
        
        $panel.addClass('dragging');
        e.preventDefault();
    };
    
    // 拖拽中
    const onDrag = (e) => {
        if (!isDragging) return;
        
        const clientY = e.type.includes('touch') ? e.originalEvent.touches[0].clientY : e.clientY;
        const clientX = e.type.includes('touch') ? e.originalEvent.touches[0].clientX : e.clientX;
        const deltaY = clientY - startY;
        
        // 检测是否移动了足够距离
        if (Math.abs(deltaY) > 5) {
            hasMoved = true;
        }
        
        // 使用新的边界计算方法
        const bounds = getVisibleBounds();
        
        // 计算新位置，限制在可视范围内
        let newTop = startTop + deltaY;
        newTop = Math.max(bounds.minTop, Math.min(newTop, bounds.maxTop));
        
        // 检测左右侧
        const $parent = $panel.parent();
        const parentRect = $parent[0].getBoundingClientRect();
        const isOnLeft = clientX < parentRect.left + parentRect.width / 2;
        
        $panel.css({
            top: newTop + 'px',
            bottom: 'auto',
            transform: 'none',
            left: isOnLeft ? '15px' : 'auto',
            right: isOnLeft ? 'auto' : '15px'
        });
        
        $panel.toggleClass('on-left', isOnLeft);
        
        // 实时更新菜单方向
        updateMenuPosition();
        
        e.preventDefault();
    };
    
    // 结束拖拽
    const endDrag = (e) => {
        if (!isDragging) return;
        isDragging = false;
        $panel.removeClass('dragging');
        
        // 再次检查边界，确保最终位置合法
        clampPosition();
        
        // 更新菜单方向
        updateMenuPosition();

        // 保存位置
        const settings = getSettings();
        settings.quickAccessPosition = {
            top: $panel[0].offsetTop,
            side: $panel.hasClass('on-left') ? 'left' : 'right'
        };
        saveSettings();
        
        // 如果是短暂点击而不是拖拽，切换菜单
        const dragDuration = Date.now() - dragStartTime;
        if (!hasMoved && dragDuration < 200) {
            $panel.toggleClass('expanded');
        }
    };
    
    // 绑定鼠标事件
    $toggle.on('mousedown', startDrag);
    $(document).on('mousemove', onDrag);
    $(document).on('mouseup', endDrag);
    
    // 绑定触摸事件
    $toggle.on('touchstart', startDrag);
    $(document).on('touchmove', onDrag);
    $(document).on('touchend touchcancel', endDrag);
    
    // 点击菜单项
    $panel.find('.jtw-quick-access-item').on('click', function(e) {
        e.stopPropagation();
        const action = $(this).data('action');
        handleQuickAccessAction(action);
        // 点击后收起菜单
        $panel.removeClass('expanded');
    });
    
    // 点击其他地方收起菜单
    $(document).on('click', function(e) {
        if (!$(e.target).closest('#jtw-quick-access-panel').length) {
            $panel.removeClass('expanded');
        }
    });
}

/**
 * 处理快捷操作
 */
function handleQuickAccessAction(action) {
    switch (action) {
        case 'ask-amber':
            // 打开问问琥珀
            AskAmber.showModal();
            break;
        case 'character-extract':
            // 打开角色提取
            CharacterExtract.showModal();
            break;
        case 'story-summary':
            // 打开故事总结
            StorySummary.showModal();
            break;
        case 'custom-tasks':
            // 切换到自定义任务标签页并打开扩展面板
            openExtensionPanel('custom-tasks');
            break;
    }
}

/**
 * 打开扩展设置面板并切换到指定标签
 */
function openExtensionPanel(tabId) {
    // 1. 首先展开顶层的扩展列表drawer
    const $extensionsDrawer = $('#extensions-settings-button');
    const $drawerContent = $extensionsDrawer.find('.drawer-content');
    const $drawerIcon = $extensionsDrawer.find('.drawer-icon');
    
    // 检查扩展列表是否已展开（通过检查drawer-content是否有openDrawer class）
    if (!$drawerContent.hasClass('openDrawer')) {
        // 切换class来展开
        $drawerIcon.removeClass('closedIcon').addClass('openIcon');
        $drawerContent.removeClass('closedDrawer').addClass('openDrawer');
    }
    
    // 2. 延迟后展开Project Amber的inline-drawer
    setTimeout(() => {
        // 找到 Project Amber 的设置面板
        const $amberPanel = $('#json-to-worldbook-panel');
        const $drawer = $amberPanel.closest('.inline-drawer');
        
        // 如果抽屉未展开，展开它
        if ($drawer.length) {
            const $inlineDrawerIcon = $drawer.find('.inline-drawer-icon');
            
            // 检查是否已展开（通过检查icon是否有down class）
            if ($inlineDrawerIcon.hasClass('down')) {
                // 未展开，点击展开
                $drawer.find('.inline-drawer-toggle').trigger('click');
            }
        }
        
        // 3. 切换到指定标签页
        setTimeout(() => {
            $(`.jtw-tab[data-tab="${tabId}"]`).trigger('click');
        }, 150);
    }, 200);
}

/**
 * 切换快捷面板显示状态
 */
function toggleQuickAccessPanel(show) {
    const $panel = $('#jtw-quick-access-panel');
    if (show) {
        $panel.show();
    } else {
        $panel.hide();
    }
}

// ==================== 导出 API ====================

// 供其他扩展或脚本使用
window.JsonToWorldbook = {
    extractJson,
    saveJsonToWorldbook,
    getAvailableWorldbooks,
    getCharacterWorldbook,
};

// ==================== 初始化 ====================

jQuery(async () => {
    console.log(`[${EXT_NAME}] 初始化...`);
    
    // 创建设置界面（包含自定义任务模块初始化）
    createSettingsUI();
    
    // 创建快捷图标面板
    createQuickAccessPanel();
    
    // 监听消息事件
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    
    // 监听角色切换，更新世界书列表
    eventSource.on(event_types.CHAT_CHANGED, () => {
        setTimeout(updateWorldbookSelect, 500);
    });
    
    // 监听提示词准备事件，用于并行任务注入
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, CustomTasks.onChatCompletionPromptReady);

    console.log(`[${EXT_NAME}] 初始化完成`);
});
