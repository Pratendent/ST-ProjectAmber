/**
 * Story Memory
 * Parse amber-memory code blocks from AI replies and edit managed worldbook YAML entries.
 */

let dependencies = null;
let saveSettingsCallback = null;
let modalEventsInitialized = false;
let currentBookId = '';

const MAX_HISTORY = 10;
const DEFAULT_ENTRY_NAME = '记忆库';
const DEFAULT_KEY = '记忆库';
const DEFAULT_INSTRUCTION_WORLDBOOK = 'Amber Memory 指令提示词';
const DEFAULT_INSTRUCTION_ENTRY = 'Amber Memory 指令提示词';

const POSITION_MAP = {
    before_character: 0,
    after_character: 1,
    before_author: 2,
    after_author: 3,
    depth: 4,
};

const POSITION_LABELS = {
    0: '角色定义之前',
    1: '角色定义之后',
    2: '作者注释之前',
    3: '作者注释之后',
    4: '@ Depth',
};

const SELECTIVE_LOGIC_LABELS = ['AND_ANY', 'NOT_ALL', 'NOT_ANY', 'AND_ALL'];

const DEFAULT_INSTRUCTION_PROMPT = String.raw`在正常剧情回复结束后，可以额外附加一个 \`\`\`amber-memory 代码块，用它向 Amber Memory 发出记忆库指令。

规则：
1. 只有在确实需要创建记忆条目、配置记忆条目、写入记忆、修改记忆或删除记忆时，才输出这个代码块。
2. 所有记忆库指令都集中写在由<memory_edit>包裹的 \`\`\`amber-memory 代码块内。
3. actions 会按顺序执行；如果后一步依赖前一步，请确保顺序正确。
4. merge 用于增量补充，仅变更字段；replace 用于整段替换；delete 用于删除路径及其全部子内容。
5. path 可以写成 YAML 数组，也可以写成点路径字符串，但推荐数组写法。
6. 新建条目使用position: after_character, order则从301开始，顺序增加。
7. 重要记忆与设定建议使用 constant: true 固定注入，可不填写关键词。
8. 次要记忆与设定建议使用 constant: false 非固定注入，并添加触发关键词。

示例：
<memory_edit>
\`\`\`amber-memory
actions:
  - action: create_book
    book: 角色
  - action: configure_book
    book: 角色
    entry:
      keys: [小明, 好朋友]
      constant: false
      position: after_character
      order: 301
  - action: merge
    book: 角色
    path: [小明]
    value:
      年龄: 18岁
      性格: 男
      外貌:
        发色: 黑
        瞳色: 黑
  - action: replace
    book: 角色
    path: [小明]
    value:
      年龄: 18岁
      性格: 男
      身高: 175cm
  - action: delete
    book: 角色
    path: [小明]
\`\`\`
</memory_edit>`;

export function init(deps) {
    dependencies = deps;
}

export function getModuleInfo() {
    return {
        id: 'story-memory',
        name: '记忆库',
        description: '解析 AI 指令并批量编辑受管世界书条目的 YAML 记忆',
        icon: '🧠',
    };
}

export function renderSettingsPanel() {
    return `
        <div class="jtw-assistant-feature-content" id="jtw-story-memory-settings" style="display: none;">
            <!-- 功能界面在弹窗中 -->
        </div>
    `;
}

export function initSettingsEvents(saveSettings) {
    saveSettingsCallback = saveSettings;
}

export function onModuleClick() {
    showModal();
    return false;
}

export function showModal() {
    ensureModalExists();
    refreshModal();
    switchTab('entry');
    $('#jtw-story-memory-modal').fadeIn(200);
}

export async function handleMessage(msg, mesId) {
    const storyMemory = getStoryMemorySettings();
    if (!storyMemory.enabled || !storyMemory.autoApply || !msg?.mes || msg.is_user) {
        return;
    }

    try {
        const compiled = parseMessageCommands(msg.mes);
        if (!compiled.actions.length) {
            return;
        }

        await applyCompiledActions(compiled, {
            messageId: mesId,
            messageText: msg.mes,
            recordHistory: true,
        });

        if (isModalOpen()) {
            showStatus('#jtw-sm-config-status', `已自动应用：${compiled.summary}`, false);
            refreshModal();
        }
    } catch (error) {
        console.error('[记忆库] 自动应用失败:', error);
        if (typeof toastr !== 'undefined' && toastr?.error) {
            toastr.error(`记忆库自动提取失败：${error.message}`, '记忆库');
        }
        if (isModalOpen()) {
            showStatus('#jtw-sm-config-status', `自动应用失败：${error.message}`, true);
        }
    }
}

function getStoryMemorySettings() {
    const { getSettings, defaultSettings } = dependencies;
    const settings = getSettings();
    if (!settings.storyMemory) {
        settings.storyMemory = structuredClone(defaultSettings.storyMemory);
    }

    settings.storyMemory.enabled = settings.storyMemory.enabled ?? true;
    settings.storyMemory.autoApply = settings.storyMemory.autoApply ?? true;
    settings.storyMemory.allowAiCreateBook = settings.storyMemory.allowAiCreateBook ?? true;
    settings.storyMemory.allowAiConfigureBook = settings.storyMemory.allowAiConfigureBook ?? true;
    settings.storyMemory.instructionPrompt = String(settings.storyMemory.instructionPrompt || '').trim() || DEFAULT_INSTRUCTION_PROMPT;
    settings.storyMemory.instructionWorldbook = String(settings.storyMemory.instructionWorldbook || DEFAULT_INSTRUCTION_WORLDBOOK).trim() || DEFAULT_INSTRUCTION_WORLDBOOK;
    settings.storyMemory.instructionEntryName = String(settings.storyMemory.instructionEntryName || DEFAULT_INSTRUCTION_ENTRY).trim() || DEFAULT_INSTRUCTION_ENTRY;
    settings.storyMemory.books = Array.isArray(settings.storyMemory.books) ? settings.storyMemory.books : [];
    settings.storyMemory.history = Array.isArray(settings.storyMemory.history) ? settings.storyMemory.history : [];
    settings.storyMemory.books = settings.storyMemory.books.map(normalizeManagedBook);
    return settings.storyMemory;
}

function createDefaultManagedBook(worldbook = '') {
    return normalizeManagedBook({
        id: `sm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        enabled: true,
        amberCreated: false,
        worldbook,
        entryName: DEFAULT_ENTRY_NAME,
        keys: [DEFAULT_KEY],
        keysecondary: [],
        selective: true,
        selectiveLogic: 'AND_ANY',
        constant: false,
        position: 4,
        depth: 4,
        order: 100,
    });
}

function normalizeManagedBook(book) {
    const logicLabel = normalizeSelectiveLogicLabel(book?.selectiveLogic);
    const position = normalizePosition(book?.position);
    return {
        id: String(book?.id || `sm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
        enabled: book?.enabled ?? true,
        amberCreated: Boolean(book?.amberCreated),
        worldbook: String(book?.worldbook || '').trim(),
        entryName: String(book?.entryName || book?.name || DEFAULT_ENTRY_NAME).trim() || DEFAULT_ENTRY_NAME,
        keys: normalizeStringArray(book?.keys, [DEFAULT_KEY]),
        keysecondary: normalizeStringArray(book?.keysecondary, []),
        selective: book?.selective ?? true,
        selectiveLogic: logicLabel,
        constant: book?.constant ?? false,
        position,
        depth: position === 4 ? normalizeNumber(book?.depth, 4) : 4,
        order: normalizeNumber(book?.order, 100),
    };
}

function normalizeStringArray(value, fallback = []) {
    if (Array.isArray(value)) {
        return value.map(item => String(item).trim()).filter(Boolean);
    }
    if (typeof value === 'string') {
        return value.split(',').map(item => item.trim()).filter(Boolean);
    }
    if (value == null) {
        return [...fallback];
    }
    return [String(value).trim()].filter(Boolean);
}

function normalizeNumber(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizePosition(value) {
    if (typeof value === 'number') {
        return POSITION_LABELS[value] ? value : 4;
    }
    if (typeof value === 'string') {
        const trimmed = value.trim().toLowerCase();
        if (!trimmed) return 4;
        if (trimmed in POSITION_MAP) return POSITION_MAP[trimmed];
        const numeric = Number.parseInt(trimmed, 10);
        if (Number.isFinite(numeric) && POSITION_LABELS[numeric]) {
            return numeric;
        }
    }
    return 4;
}

function normalizeSelectiveLogicLabel(value) {
    if (typeof value === 'number') {
        return SELECTIVE_LOGIC_LABELS[value] || 'AND_ANY';
    }
    if (typeof value === 'string') {
        const trimmed = value.trim().toUpperCase();
        if (SELECTIVE_LOGIC_LABELS.includes(trimmed)) {
            return trimmed;
        }
    }
    return 'AND_ANY';
}

function getSelectiveLogicValue(label) {
    const logicLabel = normalizeSelectiveLogicLabel(label);
    const index = SELECTIVE_LOGIC_LABELS.indexOf(logicLabel);
    return index >= 0 ? index : dependencies.world_info_logic?.AND_ANY ?? 0;
}

function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone(value) {
    return structuredClone(value);
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function isModalOpen() {
    return $('#jtw-story-memory-modal').is(':visible');
}

function hideModal() {
    $('#jtw-story-memory-modal').fadeOut(200);
}

function switchTab(tabName) {
    $('.jtw-sm-tab').removeClass('active');
    $(`.jtw-sm-tab[data-tab="${tabName}"]`).addClass('active');
    $('.jtw-sm-tab-content').removeClass('active');
    $(`#jtw-sm-tab-${tabName}`).addClass('active');
}

function ensureCurrentBookId() {
    const books = getScopedBooks();
    if (!books.length) {
        currentBookId = '';
        return;
    }
    if (!books.some(book => book.id === currentBookId)) {
        currentBookId = books[0].id;
    }
}

function getCurrentBook() {
    ensureCurrentBookId();
    return getScopedBooks().find(book => book.id === currentBookId) || null;
}

function getActiveWorldbookName(required = true) {
    const settings = dependencies.getSettings?.();
    const targetBook = settings?.targetWorldbook || dependencies.getCharacterWorldbook?.();
    const validNames = dependencies.world_names || [];
    if (targetBook && validNames.includes(targetBook)) {
        return targetBook;
    }
    if (required) {
        throw new Error('当前聊天未绑定有效世界书');
    }
    return '';
}

function getScopedBooks() {
    const activeWorldbook = getActiveWorldbookName(false);
    const books = getStoryMemorySettings().books;
    if (!activeWorldbook) {
        return [];
    }
    return books.filter(book => book.worldbook === activeWorldbook);
}

function setCurrentBookId(bookId) {
    currentBookId = String(bookId || '');
    refreshBookSelects();
    void loadEntryEditor();
    loadConfigForm();
}

function showStatus(selector, message, isError = false) {
    const $status = $(selector);
    if (!$status.length) return;
    $status.text(message).removeClass('success error').addClass(isError ? 'error' : 'success').show();
}

function clearStatus(selector) {
    $(selector).hide().text('').removeClass('success error');
}
function getModalHtml() {
    return `
        <div id="jtw-story-memory-modal" class="jtw-modal" style="display: none;">
            <div class="jtw-modal-content jtw-sm-modal-content">
                <div class="jtw-modal-header">
                    <h3>🧠 记忆库</h3>
                    <button class="jtw-modal-close jtw-sm-close-modal">✕</button>
                </div>
                <div class="jtw-sm-tabs">
                    <button class="jtw-sm-tab active" data-tab="entry">记忆内容</button>
                    <button class="jtw-sm-tab" data-tab="settings">配置</button>
                    <button class="jtw-sm-tab" data-tab="history">历史版本</button>
                </div>
                <div class="jtw-modal-body">
                    <div class="jtw-sm-tab-content active" id="jtw-sm-tab-entry">
                        <div class="jtw-sm-toolbar">
                            <label class="jtw-sm-toolbar-label">受管记忆库</label>
                            <select id="jtw-sm-entry-book-select" class="jtw-select"></select>
                            <button id="jtw-sm-entry-refresh" class="jtw-btn">刷新</button>
                            <button id="jtw-sm-read-latest" class="jtw-btn">读取最新消息指令</button>
                        </div>
                        <div id="jtw-sm-entry-empty" class="jtw-sm-empty-hint" style="display: none;">
                            <div class="jtw-sm-empty-icon">🧠</div>
                            <div class="jtw-sm-empty-text">尚未配置受管记忆库</div>
                            <div class="jtw-sm-empty-hint-text">请先在“配置”标签页中创建并保存一个记忆库配置</div>
                        </div>
                        <div id="jtw-sm-entry-editor" style="display: none;">
                            <div id="jtw-sm-entry-info" class="jtw-sm-entry-info"></div>
                            <textarea id="jtw-sm-entry-content" class="jtw-sm-textarea" rows="24" placeholder="记忆库 YAML 内容..."></textarea>
                            <div class="jtw-sm-actions">
                                <div id="jtw-sm-entry-status" class="jtw-status" style="display: none;"></div>
                                <button id="jtw-sm-save-entry" class="jtw-btn primary">保存修改</button>
                            </div>
                        </div>
                    </div>

                    <div class="jtw-sm-tab-content" id="jtw-sm-tab-settings">
                        <div class="jtw-section">
                            <h4>基础设置</h4>
                            <div class="jtw-checkbox-row">
                                <input type="checkbox" id="jtw-sm-enabled" />
                                <label for="jtw-sm-enabled">启用记忆库模块</label>
                            </div>
                            <div class="jtw-checkbox-row">
                                <input type="checkbox" id="jtw-sm-auto-apply" />
                                <label for="jtw-sm-auto-apply">自动应用 AI 指令</label>
                            </div>
                            <div class="jtw-checkbox-row">
                                <input type="checkbox" id="jtw-sm-allow-create-book" />
                                <label for="jtw-sm-allow-create-book">允许 AI 创建受管条目</label>
                            </div>
                            <div class="jtw-checkbox-row">
                                <input type="checkbox" id="jtw-sm-allow-config-book" />
                                <label for="jtw-sm-allow-config-book">允许 AI 配置受管条目</label>
                            </div>
                            <div class="jtw-hint">这里的配置始终作用于当前聊天所属的世界书，不会新建独立世界书。</div>
                        </div>

                        <div class="jtw-section">
                            <details class="jtw-sm-collapse">
                                <summary class="jtw-sm-section-header jtw-sm-collapse-summary">
                                    <h4>受管记忆库列表</h4>
                                    <div class="jtw-sm-section-actions">
                                        <button id="jtw-sm-add-book" class="jtw-btn" type="button">新增</button>
                                        <button id="jtw-sm-delete-book" class="jtw-btn" type="button">删除</button>
                                    </div>
                                </summary>
                                <div class="jtw-sm-collapse-body">
                            <div class="jtw-sm-config-grid">
                                <div>
                                    <label>当前配置</label>
                                    <select id="jtw-sm-config-book-select" class="jtw-select"></select>
                                </div>
                                <div>
                                    <label>启用该配置</label>
                                    <div class="jtw-checkbox-row">
                                        <input type="checkbox" id="jtw-sm-config-enabled" />
                                        <label for="jtw-sm-config-enabled">允许该世界书接收 AI 记忆指令</label>
                                    </div>
                                </div>
                                <div>
                                    <label>条目名称</label>
                                    <input type="text" id="jtw-sm-config-entry-name" class="jtw-input" placeholder="记忆库" />
                                </div>
                                <div>
                                    <label>主关键词</label>
                                    <input type="text" id="jtw-sm-config-keys" class="jtw-input" placeholder="记忆库, 小明" />
                                </div>
                                <div>
                                    <label>次关键词</label>
                                    <input type="text" id="jtw-sm-config-keysecondary" class="jtw-input" placeholder="小红, 张三" />
                                </div>
                                <div>
                                    <label>Selective</label>
                                    <div class="jtw-checkbox-row">
                                        <input type="checkbox" id="jtw-sm-config-selective" />
                                        <label for="jtw-sm-config-selective">启用关键词选择逻辑</label>
                                    </div>
                                </div>
                                <div>
                                    <label>Selective Logic</label>
                                    <select id="jtw-sm-config-selective-logic" class="jtw-select">
                                        <option value="AND_ANY">AND_ANY</option>
                                        <option value="AND_ALL">AND_ALL</option>
                                        <option value="NOT_ANY">NOT_ANY</option>
                                        <option value="NOT_ALL">NOT_ALL</option>
                                    </select>
                                </div>
                                <div>
                                    <label>Constant</label>
                                    <div class="jtw-checkbox-row">
                                        <input type="checkbox" id="jtw-sm-config-constant" />
                                        <label for="jtw-sm-config-constant">固定注入</label>
                                    </div>
                                </div>
                                <div>
                                    <label>位置</label>
                                    <select id="jtw-sm-config-position" class="jtw-select">
                                        <option value="0">角色定义之前</option>
                                        <option value="1">角色定义之后</option>
                                        <option value="2">作者注释之前</option>
                                        <option value="3">作者注释之后</option>
                                        <option value="4">@ Depth</option>
                                    </select>
                                </div>
                                <div id="jtw-sm-config-depth-container">
                                    <label>Depth</label>
                                    <input type="number" id="jtw-sm-config-depth" class="jtw-input" value="4" min="0" max="999" />
                                </div>
                                <div>
                                    <label>Order</label>
                                    <input type="number" id="jtw-sm-config-order" class="jtw-input" value="100" min="0" />
                                </div>
                            </div>
                            <div class="jtw-hint">create_book / configure_book 都是在当前聊天世界书里新增或修改受管条目，不会创建新的世界书。</div>
                            <div class="jtw-sm-actions">
                                <div id="jtw-sm-config-status" class="jtw-status" style="display: none;"></div>
                                <button id="jtw-sm-save-config" class="jtw-btn primary">保存配置</button>
                            </div>
                                </div>
                            </details>
                        </div>

                        <div class="jtw-section">
                            <div class="jtw-sm-section-header">
                                <h4>指令提示词</h4>
                                <div class="jtw-sm-section-actions">
                                    <button id="jtw-sm-reset-prompt" class="jtw-btn">恢复默认</button>
                                    <button id="jtw-sm-publish-prompt" class="jtw-btn">添加进世界书</button>
                                </div>
                            </div>
                            <div class="jtw-hint">这里编写教 AI 如何输出 amber-memory 指令的说明。点击按钮会在当前聊天世界书中新增或更新一个单独条目，固定为深度 D0、顺序 999，并用 &lt;amber_memory&gt; 标签包裹内容。</div>
                            <div class="jtw-sm-config-grid jtw-sm-config-grid-single">
                                <div>
                                    <label>条目名称</label>
                                    <input type="text" id="jtw-sm-instruction-entry-name" class="jtw-input" placeholder="${escapeHtml(DEFAULT_INSTRUCTION_ENTRY)}" />
                                </div>
                            </div>
                            <textarea id="jtw-sm-instruction-prompt" class="jtw-sm-textarea jtw-sm-prompt-textarea" rows="16" placeholder="在这里编写给 AI 的指令提示词..."></textarea>
                            <div class="jtw-sm-actions">
                                <div id="jtw-sm-prompt-status" class="jtw-status" style="display: none;"></div>
                            </div>
                        </div>
                    </div>

                    <div class="jtw-sm-tab-content" id="jtw-sm-tab-history">
                        <div class="jtw-section">
                            <h4>历史版本</h4>
                            <div class="jtw-hint">这里只记录 AI 自动应用的批次。回退某个版本时，会同时撤销该版本及其之后的所有自动历史。</div>
                            <div id="jtw-sm-history-status" class="jtw-status" style="display: none;"></div>
                            <div id="jtw-sm-history-list" class="jtw-sm-history-list"></div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function ensureModalExists() {
    if ($('#jtw-story-memory-modal').length === 0) {
        $('body').append(getModalHtml());
    }
    if (!modalEventsInitialized) {
        bindModalEvents();
        modalEventsInitialized = true;
    }
}

function bindModalEvents() {
    $('#jtw-story-memory-modal .jtw-sm-close-modal').off('click').on('click', function (e) {
        e.stopPropagation();
        hideModal();
    });
    $('#jtw-story-memory-modal').off('click mousedown pointerdown touchstart touchend').on('click mousedown pointerdown touchstart touchend', function (e) {
        e.stopPropagation();
    });
    $('#jtw-story-memory-modal .jtw-sm-tab').off('click').on('click', function (e) {
        e.stopPropagation();
        switchTab($(this).data('tab'));
    });
    $('#jtw-sm-entry-book-select').off('change').on('change', function () {
        setCurrentBookId($(this).val());
    });
    $('#jtw-sm-config-book-select').off('change').on('change', function () {
        setCurrentBookId($(this).val());
    });
    $('#jtw-sm-entry-refresh').off('click').on('click', function () {
        void loadEntryEditor();
    });
    $('#jtw-sm-read-latest').off('click').on('click', function () {
        void applyLatestMessageInstructions();
    });
    $('#jtw-sm-save-entry').off('click').on('click', function () {
        void saveEntryEdit();
    });
    $('#jtw-sm-add-book').off('click').on('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        void addManagedBook();
    });
    $('#jtw-sm-delete-book').off('click').on('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        void deleteCurrentManagedBook();
    });
    $('#jtw-sm-save-config').off('click').on('click', function () {
        void saveCurrentManagedBookConfig();
    });
    $('#jtw-sm-enabled').off('change').on('change', function () {
        const storyMemory = getStoryMemorySettings();
        storyMemory.enabled = $(this).prop('checked');
        persistSettings();
    });
    $('#jtw-sm-auto-apply').off('change').on('change', function () {
        const storyMemory = getStoryMemorySettings();
        storyMemory.autoApply = $(this).prop('checked');
        persistSettings();
    });
    $('#jtw-sm-allow-create-book').off('change').on('change', function () {
        const storyMemory = getStoryMemorySettings();
        storyMemory.allowAiCreateBook = $(this).prop('checked');
        persistSettings();
    });
    $('#jtw-sm-allow-config-book').off('change').on('change', function () {
        const storyMemory = getStoryMemorySettings();
        storyMemory.allowAiConfigureBook = $(this).prop('checked');
        persistSettings();
    });
    $('#jtw-sm-config-position').off('change').on('change', function () {
        $('#jtw-sm-config-depth-container').toggle(Number.parseInt($(this).val(), 10) === 4);
    });
    $('#jtw-sm-instruction-entry-name, #jtw-sm-instruction-prompt').off('input change').on('input change', function () {
        syncInstructionSettingsFromInputs();
    });
    $('#jtw-sm-reset-prompt').off('click').on('click', function () {
        resetInstructionPrompt();
    });
    $('#jtw-sm-publish-prompt').off('click').on('click', function () {
        void publishInstructionPromptWorldbook();
    });
    $('#jtw-sm-history-list').off('click', '.jtw-sm-history-rollback').on('click', '.jtw-sm-history-rollback', async function () {
        const index = Number.parseInt($(this).data('history-index'), 10);
        await rollbackHistory(index);
    });
}
function refreshModal() {
    clearStatus('#jtw-sm-entry-status');
    clearStatus('#jtw-sm-config-status');
    clearStatus('#jtw-sm-prompt-status');
    clearStatus('#jtw-sm-history-status');
    loadBaseSettings();
    refreshBookSelects();
    void loadEntryEditor();
    loadConfigForm();
    loadInstructionPromptForm();
    renderHistoryList();
}

function loadBaseSettings() {
    const storyMemory = getStoryMemorySettings();
    $('#jtw-sm-enabled').prop('checked', storyMemory.enabled);
    $('#jtw-sm-auto-apply').prop('checked', storyMemory.autoApply);
    $('#jtw-sm-allow-create-book').prop('checked', storyMemory.allowAiCreateBook);
    $('#jtw-sm-allow-config-book').prop('checked', storyMemory.allowAiConfigureBook);
}

function loadInstructionPromptForm() {
    const storyMemory = getStoryMemorySettings();
    $('#jtw-sm-instruction-entry-name').val(storyMemory.instructionEntryName || DEFAULT_INSTRUCTION_ENTRY);
    $('#jtw-sm-instruction-prompt').val(storyMemory.instructionPrompt || DEFAULT_INSTRUCTION_PROMPT);
}

function syncInstructionSettingsFromInputs() {
    const storyMemory = getStoryMemorySettings();
    storyMemory.instructionWorldbook = getActiveWorldbookName(false) || DEFAULT_INSTRUCTION_WORLDBOOK;
    storyMemory.instructionEntryName = String($('#jtw-sm-instruction-entry-name').val() || DEFAULT_INSTRUCTION_ENTRY).trim() || DEFAULT_INSTRUCTION_ENTRY;
    storyMemory.instructionPrompt = String($('#jtw-sm-instruction-prompt').val() || DEFAULT_INSTRUCTION_PROMPT).trim() || DEFAULT_INSTRUCTION_PROMPT;
    persistSettings();
}

function resetInstructionPrompt() {
    const storyMemory = getStoryMemorySettings();
    storyMemory.instructionPrompt = DEFAULT_INSTRUCTION_PROMPT;
    persistSettings();
    $('#jtw-sm-instruction-prompt').val(DEFAULT_INSTRUCTION_PROMPT);
    showStatus('#jtw-sm-prompt-status', '已恢复默认提示词', false);
}

function refreshBookSelects() {
    const activeWorldbook = getActiveWorldbookName(false);
    const scopedBooks = getScopedBooks();
    ensureCurrentBookId();

    const bookOptions = scopedBooks.map(book => {
        const bookLabel = book.worldbook || activeWorldbook || '未命名世界书';
        const tag = book.amberCreated ? 'Amber' : '手动';
        return `<option value="${escapeHtml(book.id)}">${escapeHtml(bookLabel)} · ${escapeHtml(book.entryName)} · ${escapeHtml(tag)}</option>`;
    }).join('');
    const placeholder = '<option value="">-- 请选择 --</option>';

    $('#jtw-sm-entry-book-select').html(scopedBooks.length ? bookOptions : placeholder).val(currentBookId || '');
    $('#jtw-sm-config-book-select').html(scopedBooks.length ? bookOptions : placeholder).val(currentBookId || '');

    const currentBook = getCurrentBook();
}

async function loadEntryEditor() {
    clearStatus('#jtw-sm-entry-status');
    const currentBook = getCurrentBook();
    const $empty = $('#jtw-sm-entry-empty');
    const $editor = $('#jtw-sm-entry-editor');

    if (!currentBook) {
        $empty.show();
        $editor.hide();
        return;
    }

    try {
        const { entry } = await loadManagedEntryState(currentBook);
        const content = entry?.content?.trim()
            ? dependencies.yaml.stringify(parseYamlRoot(entry.content, currentBook), { indent: 2 }).trimEnd() || '{}'
            : '{}';
        $('#jtw-sm-entry-content').val(`${content}\n`);
        $('#jtw-sm-entry-info').html(`
            <span><strong>世界书:</strong> ${escapeHtml(currentBook.worldbook || '未设置')}</span>
            <span><strong>条目名称:</strong> ${escapeHtml(currentBook.entryName)}</span>
            <span><strong>位置:</strong> ${escapeHtml(getPositionText(currentBook.position, currentBook.depth))}</span>
            <span><strong>关键词:</strong> ${escapeHtml(currentBook.keys.join(', ') || '无')}</span>
        `);
        $empty.hide();
        $editor.show();
    } catch (error) {
        $empty.hide();
        $editor.show();
        $('#jtw-sm-entry-content').val('');
        showStatus('#jtw-sm-entry-status', `加载失败：${error.message}`, true);
    }
}

function loadConfigForm() {
    const currentBook = getCurrentBook();
    const hasBook = Boolean(currentBook);

    $('#jtw-sm-config-enabled').prop('checked', currentBook?.enabled ?? true);
    $('#jtw-sm-config-entry-name').val(currentBook?.entryName || DEFAULT_ENTRY_NAME);
    $('#jtw-sm-config-keys').val((currentBook?.keys || []).join(', '));
    $('#jtw-sm-config-keysecondary').val((currentBook?.keysecondary || []).join(', '));
    $('#jtw-sm-config-selective').prop('checked', currentBook?.selective ?? true);
    $('#jtw-sm-config-selective-logic').val(currentBook?.selectiveLogic || 'AND_ANY');
    $('#jtw-sm-config-constant').prop('checked', currentBook?.constant ?? false);
    $('#jtw-sm-config-position').val(String(currentBook?.position ?? 4));
    $('#jtw-sm-config-depth').val(currentBook?.depth ?? 4);
    $('#jtw-sm-config-order').val(currentBook?.order ?? 100);
    $('#jtw-sm-config-depth-container').toggle((currentBook?.position ?? 4) === 4);
    $('#jtw-sm-save-config').prop('disabled', !hasBook);
    $('#jtw-sm-delete-book').prop('disabled', !hasBook);
}

function renderHistoryList() {
    const history = getStoryMemorySettings().history || [];
    const $list = $('#jtw-sm-history-list');

    if (!history.length) {
        $list.html('<div class="jtw-sm-history-empty">暂无自动应用历史</div>');
        return;
    }

    const items = history.map((item, index) => ({ item, index })).reverse().map(({ item, index }) => {
        const originalIndex = history.length - 1 - index;
        const affectedEntries = (item.changes || []).map(change => `${change.worldbook} · ${change.entryName}`).join('，');
        const changeDetails = (item.changes || []).map(change => `
            <div class="jtw-sm-history-change">
                <div class="jtw-sm-history-change-title">${escapeHtml(change.worldbook)} · ${escapeHtml(change.entryName)}</div>
                <div class="jtw-sm-history-change-grid">
                    <div>
                        <div class="jtw-sm-history-change-label">变更前</div>
                        <pre class="jtw-sm-history-code">${escapeHtml(change.beforeContent || '(空)')}</pre>
                    </div>
                    <div>
                        <div class="jtw-sm-history-change-label">变更后</div>
                        <pre class="jtw-sm-history-code">${escapeHtml(change.afterContent || '(已删除)')}</pre>
                    </div>
                </div>
            </div>
        `).join('');
        return `
            <div class="jtw-sm-history-item">
                <div class="jtw-sm-history-main">
                    <div class="jtw-sm-history-title">${escapeHtml(item.actionSummary || '未命名操作')}</div>
                    <div class="jtw-sm-history-meta">
                        <span>${escapeHtml(formatTimestamp(item.createdAt))}</span>
                        <span>${escapeHtml(affectedEntries || '无变更条目')}</span>
                    </div>
                    <pre class="jtw-sm-history-preview">${escapeHtml(item.commandText || '无指令预览')}</pre>
                    <details class="jtw-sm-history-details">
                        <summary>查看变更内容</summary>
                        ${changeDetails || '<div class="jtw-sm-history-empty">没有记录到条目变化</div>'}
                    </details>
                </div>
                <button class="jtw-btn jtw-sm-history-rollback" data-history-index="${originalIndex}">回退到此处</button>
            </div>
        `;
    }).join('');

    $list.html(items);
}

function formatTimestamp(timestamp) {
    try {
        return new Date(timestamp).toLocaleString();
    } catch {
        return String(timestamp || '');
    }
}

async function addManagedBook() {
    const storyMemory = getStoryMemorySettings();
    let activeWorldbook = '';
    try {
        activeWorldbook = getActiveWorldbookName(true);
    } catch (error) {
        showStatus('#jtw-sm-config-status', error.message, true);
        return;
    }
    const newBook = createDefaultManagedBook(activeWorldbook);
    storyMemory.books.push(newBook);
    currentBookId = newBook.id;
    persistSettings();
    refreshModal();
    showStatus('#jtw-sm-config-status', '已新增记忆库配置，请保存后生效', false);
}

async function deleteCurrentManagedBook() {
    const storyMemory = getStoryMemorySettings();
    const currentBook = getCurrentBook();
    if (!currentBook) return;

    if (!confirm(`确定要移除配置“${currentBook.worldbook || currentBook.entryName}”吗？此操作不会删除世界书内容。`)) {
        return;
    }

    storyMemory.books = storyMemory.books.filter(book => book.id !== currentBook.id);
    currentBookId = storyMemory.books[0]?.id || '';
    persistSettings();
    refreshModal();
    showStatus('#jtw-sm-config-status', '已移除记忆库配置', false);
}

async function saveCurrentManagedBookConfig() {
    clearStatus('#jtw-sm-config-status');
    const storyMemory = getStoryMemorySettings();
    const currentBook = getCurrentBook();

    if (!currentBook) {
        showStatus('#jtw-sm-config-status', '请先新增一个记忆库配置', true);
        return;
    }

    let nextWorldbook = '';
    try {
        nextWorldbook = getActiveWorldbookName(true);
    } catch (error) {
        showStatus('#jtw-sm-config-status', error.message, true);
        return;
    }
    const nextBook = normalizeManagedBook({
        ...currentBook,
        enabled: $('#jtw-sm-config-enabled').prop('checked'),
        amberCreated: currentBook.amberCreated && nextWorldbook === currentBook.worldbook,
        worldbook: nextWorldbook,
        entryName: $('#jtw-sm-config-entry-name').val(),
        keys: $('#jtw-sm-config-keys').val(),
        keysecondary: $('#jtw-sm-config-keysecondary').val(),
        selective: $('#jtw-sm-config-selective').prop('checked'),
        selectiveLogic: $('#jtw-sm-config-selective-logic').val(),
        constant: $('#jtw-sm-config-constant').prop('checked'),
        position: Number.parseInt($('#jtw-sm-config-position').val(), 10),
        depth: $('#jtw-sm-config-depth').val(),
        order: $('#jtw-sm-config-order').val(),
    });

    if (!nextBook.worldbook) {
        showStatus('#jtw-sm-config-status', '请选择目标世界书', true);
        return;
    }
    try {
        const index = storyMemory.books.findIndex(book => book.id === currentBook.id);
        if (index >= 0) {
            storyMemory.books[index] = nextBook;
        } else {
            storyMemory.books.push(nextBook);
        }
        currentBookId = nextBook.id;

        const preferredNames = [currentBook.entryName, nextBook.entryName].filter(Boolean);
        const { worldData, entry } = await loadManagedEntryState(nextBook, {
            createIfMissing: true,
            preferredNames,
        });
        syncEntryWithConfig(entry, nextBook);
        const existingRoot = entry.content?.trim() ? parseYamlRoot(entry.content, currentBook) : {};
        entry.content = stringifyYamlObject(existingRoot, nextBook);

        await dependencies.saveWorldInfo(nextBook.worldbook, worldData, true);
        persistSettings();
        await refreshWorldbookViews([nextBook.worldbook]);
        refreshModal();
        showStatus('#jtw-sm-config-status', '配置已保存', false);
    } catch (error) {
        console.error('[记忆库] 保存配置失败:', error);
        showStatus('#jtw-sm-config-status', `保存失败：${error.message}`, true);
    }
}

async function saveEntryEdit() {
    clearStatus('#jtw-sm-entry-status');
    const currentBook = getCurrentBook();
    if (!currentBook) {
        showStatus('#jtw-sm-entry-status', '请先配置记忆库', true);
        return;
    }

    const $saveBtn = $('#jtw-sm-save-entry');
    $saveBtn.prop('disabled', true).text('保存中...');

    try {
        const root = parseYamlRoot($('#jtw-sm-entry-content').val());
        const { worldData, entry } = await loadManagedEntryState(currentBook, { createIfMissing: true });
        syncEntryWithConfig(entry, currentBook);
        entry.content = stringifyYamlObject(root, currentBook);
        await dependencies.saveWorldInfo(currentBook.worldbook, worldData, true);
        await refreshWorldbookViews([currentBook.worldbook]);
        showStatus('#jtw-sm-entry-status', '记忆内容已保存', false);
        await loadEntryEditor();
    } catch (error) {
        console.error('[记忆库] 保存记忆内容失败:', error);
        showStatus('#jtw-sm-entry-status', `保存失败：${error.message}`, true);
    } finally {
        $saveBtn.prop('disabled', false).text('保存修改');
    }
}

async function applyLatestMessageInstructions() {
    clearStatus('#jtw-sm-entry-status');
    const latest = getLatestAssistantMessage();
    if (!latest) {
        showStatus('#jtw-sm-entry-status', '当前聊天中没有可读取的 AI 消息', true);
        return;
    }

    const $button = $('#jtw-sm-read-latest');
    $button.prop('disabled', true).text('读取中...');

    try {
        const compiled = parseMessageCommands(latest.message.mes);
        if (!compiled.actions.length) {
            showStatus('#jtw-sm-entry-status', '最新 AI 消息中没有 amber-memory 指令', true);
            return;
        }

        await applyCompiledActions(compiled, {
            messageId: latest.index,
            messageText: latest.message.mes,
            recordHistory: false,
        });

        refreshModal();
        showStatus('#jtw-sm-entry-status', `已手动应用最新消息指令：${compiled.summary}`, false);
    } catch (error) {
        console.error('[记忆库] 手动读取最新消息指令失败:', error);
        showStatus('#jtw-sm-entry-status', `读取失败：${error.message}`, true);
    } finally {
        $button.prop('disabled', false).text('读取最新消息指令');
    }
}

function getLatestAssistantMessage() {
    const ctx = dependencies.getContext?.();
    const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
    for (let index = chat.length - 1; index >= 0; index--) {
        const message = chat[index];
        if (message && !message.is_user && String(message.mes || '').trim()) {
            return { message, index };
        }
    }
    return null;
}

async function publishInstructionPromptWorldbook() {
    clearStatus('#jtw-sm-prompt-status');
    syncInstructionSettingsFromInputs();
    const storyMemory = getStoryMemorySettings();

    let worldbook = '';
    try {
        worldbook = getActiveWorldbookName(true);
    } catch (error) {
        showStatus('#jtw-sm-prompt-status', error.message, true);
        return;
    }
    const entryName = String(storyMemory.instructionEntryName || DEFAULT_INSTRUCTION_ENTRY).trim();
    const prompt = String(storyMemory.instructionPrompt || DEFAULT_INSTRUCTION_PROMPT).trim();

    if (!entryName) {
        showStatus('#jtw-sm-prompt-status', '条目名称不能为空', true);
        return;
    }
    if (!prompt) {
        showStatus('#jtw-sm-prompt-status', '指令提示词不能为空', true);
        return;
    }

    const $button = $('#jtw-sm-publish-prompt');
    $button.prop('disabled', true).text('写入中...');

    try {
        const worldData = await dependencies.loadWorldInfo(worldbook);
        if (!worldData) {
            throw new Error(`无法加载世界书：${worldbook}`);
        }

        let entry = findEntryByComments(worldData, [entryName]);
        if (!entry) {
            entry = dependencies.createWorldInfoEntry(worldbook, worldData);
            if (!entry) {
                throw new Error(`创建提示词条目失败：${worldbook}`);
            }
        }

        entry.comment = entryName;
        entry.key = [];
        entry.keysecondary = [];
        entry.constant = true;
        entry.selective = false;
        entry.selectiveLogic = dependencies.world_info_logic?.AND_ANY ?? 0;
        entry.disable = false;
        entry.position = 4;
        entry.depth = 0;
        entry.order = 999;
        entry.content = wrapInstructionPrompt(prompt);

        await dependencies.saveWorldInfo(worldbook, worldData, true);
        await refreshWorldbookViews([worldbook]);
        showStatus('#jtw-sm-prompt-status', `已写入当前聊天世界书：${worldbook}`, false);
    } catch (error) {
        console.error('[记忆库] 写入提示词世界书失败:', error);
        showStatus('#jtw-sm-prompt-status', `写入失败：${error.message}`, true);
    } finally {
        $button.prop('disabled', false).text('添加进世界书');
    }
}

function wrapInstructionPrompt(prompt) {
    const body = String(prompt || '').trim();
    return `<amber_memory>\n${body}\n</amber_memory>\n`;
}
async function rollbackHistory(index) {
    const storyMemory = getStoryMemorySettings();
    const history = storyMemory.history || [];

    if (index < 0 || index >= history.length) {
        showStatus('#jtw-sm-history-status', '历史记录不存在', true);
        return;
    }
    if (!confirm('回退后将撤销该版本及其之后的所有自动历史，是否继续？')) {
        return;
    }

    showStatus('#jtw-sm-history-status', '正在回退历史版本...', false);

    try {
        let workingBooks = storyMemory.books.map(normalizeManagedBook);
        const affectedWorldbooks = new Set();

        for (let i = history.length - 1; i >= index; i--) {
            const result = await restoreSnapshots(history[i].snapshots || [], workingBooks);
            workingBooks = result.books;
            result.affectedWorldbooks.forEach(name => affectedWorldbooks.add(name));
        }

        storyMemory.books = workingBooks.map(normalizeManagedBook);
        storyMemory.history = history.slice(0, index);
        persistSettings();
        await refreshWorldbookViews([...affectedWorldbooks]);
        refreshModal();
        showStatus('#jtw-sm-history-status', '历史已回退', false);
    } catch (error) {
        console.error('[记忆库] 回退历史失败:', error);
        showStatus('#jtw-sm-history-status', `回退失败：${error.message}`, true);
    }
}

function persistSettings() {
    saveSettingsCallback?.();
}

async function refreshWorldbookViews(worldbooks = []) {
    const unique = [...new Set(worldbooks.filter(Boolean))];
    if (dependencies.updateWorldInfoList) {
        await dependencies.updateWorldInfoList();
    }
    for (const worldbook of unique) {
        dependencies.reloadEditor?.(worldbook, true);
    }
    refreshBookSelects();
}

function parseMessageCommands(message) {
    const storyMemory = getStoryMemorySettings();
    const blocks = extractAmberMemoryBlocks(message);
    if (!blocks.length) {
        return { actions: [], summary: '', commandText: '' };
    }

    const activeWorldbook = getActiveWorldbookName(true);
    const workingBooks = storyMemory.books.map(normalizeManagedBook);
    const actions = [];

    for (const block of blocks) {
        let parsed;
        try {
            parsed = dependencies.yaml.parse(block);
        } catch (error) {
            throw new Error(`amber-memory 代码块解析失败：${error.message}`);
        }

        if (!isPlainObject(parsed)) {
            throw new Error('amber-memory 代码块必须是对象');
        }
        if (!Array.isArray(parsed.actions)) {
            throw new Error('amber-memory 缺少 actions 数组');
        }

        for (const rawAction of parsed.actions) {
            actions.push(normalizeAction(rawAction, {
                storyMemory,
                workingBooks,
                activeWorldbook,
            }));
        }
    }

    return {
        actions,
        summary: summarizeActions(actions),
        commandText: blocks.map(block => `\`\`\`amber-memory\n${block}\n\`\`\``).join('\n\n'),
    };
}

function extractAmberMemoryBlocks(text) {
    const blocks = [];
    const regex = /```amber-memory\s*([\s\S]*?)```/gi;
    let match = null;
    while ((match = regex.exec(String(text || '')))) {
        const body = String(match[1] || '').trim();
        if (body) {
            blocks.push(body);
        }
    }
    return blocks;
}

function normalizeAction(rawAction, context) {
    if (!isPlainObject(rawAction)) {
        throw new Error('actions 中的每一项都必须是对象');
    }

    const action = String(rawAction.action || '').trim().toLowerCase();
    const book = String(rawAction.book || '').trim();

    if (!action) {
        throw new Error('存在缺少 action 的记忆指令');
    }
    if (!book) {
        throw new Error(`记忆指令 ${action} 缺少 book`);
    }

    switch (action) {
        case 'create_book':
            if (!context.storyMemory.allowAiCreateBook) {
                throw new Error(`AI 无权创建记忆条目：${book}`);
            }
            {
                const config = normalizeManagedBook({
                    ...(findManagedBook(context.workingBooks, context.activeWorldbook, book) || createDefaultManagedBook(context.activeWorldbook)),
                    amberCreated: true,
                    worldbook: context.activeWorldbook,
                    entryName: book,
                });
                upsertBook(context.workingBooks, config);
                return { action, book, worldbook: context.activeWorldbook, config: clone(config) };
            }

        case 'configure_book': {
            if (!context.storyMemory.allowAiConfigureBook) {
                throw new Error(`AI 无权配置记忆条目：${book}`);
            }

            const existing = findManagedBook(context.workingBooks, context.activeWorldbook, book);
            if (!existing || !existing.amberCreated || existing.entryName !== book) {
                throw new Error(`configure_book 只能配置当前聊天世界书中由 Amber Memory 创建的条目：${book}`);
            }
            const config = normalizeConfiguredBook(existing, rawAction.entry, context.activeWorldbook);
            config.amberCreated = true;
            upsertBook(context.workingBooks, config);
            return { action, book, worldbook: context.activeWorldbook, config: clone(config) };
        }

        case 'merge':
        case 'replace':
        case 'delete': {
            const config = findManagedBook(context.workingBooks, context.activeWorldbook, book);
            if (!config || !config.enabled) {
                throw new Error(`记忆操作前，当前聊天世界书未配置受管记忆条目：${book}`);
            }
            if (config.entryName !== book) {
                throw new Error(`当前聊天世界书中未找到名为 ${book} 的受管记忆条目`);
            }
            const normalized = {
                action,
                book,
                worldbook: context.activeWorldbook,
                path: normalizePath(rawAction.path),
            };
            if (action !== 'delete' && rawAction.value === undefined) {
                throw new Error(`${action} 指令缺少 value`);
            }
            if (action !== 'delete') {
                normalized.value = clone(rawAction.value);
            }
            return normalized;
        }

        default:
            throw new Error(`不支持的记忆指令：${action}`);
    }
}

function normalizeConfiguredBook(baseBook, entry, worldbook) {
    const book = normalizeManagedBook(baseBook);
    const nextEntry = isPlainObject(entry) ? entry : {};
    const position = normalizePosition(nextEntry.position ?? book.position);

    return normalizeManagedBook({
        ...book,
        worldbook,
        entryName: book.entryName,
        keys: nextEntry.keys ?? book.keys,
        keysecondary: nextEntry.keysecondary ?? book.keysecondary,
        selective: nextEntry.selective ?? book.selective,
        selectiveLogic: nextEntry.selectiveLogic ?? book.selectiveLogic,
        constant: nextEntry.constant ?? book.constant,
        position,
        depth: position === 4 ? (nextEntry.depth ?? book.depth) : book.depth,
        order: nextEntry.order ?? book.order,
    });
}

function normalizePath(path) {
    if (path == null || path === '') return [];
    if (Array.isArray(path)) {
        return path.map(item => String(item).trim()).filter(Boolean);
    }
    if (typeof path === 'string') {
        return path.split('.').map(item => item.trim()).filter(Boolean);
    }
    return [String(path).trim()].filter(Boolean);
}

function summarizeActions(actions) {
    const counts = new Map();
    for (const action of actions) {
        counts.set(action.action, (counts.get(action.action) || 0) + 1);
    }
    return [...counts.entries()].map(([action, count]) => `${action} × ${count}`).join('，');
}

function findManagedBook(books, worldbook, entryName = null) {
    return books.find(book =>
        book.worldbook === worldbook
        && (entryName == null || book.entryName === entryName)
    ) || null;
}

function upsertBook(books, nextBook) {
    const byId = books.findIndex(book => book.id === nextBook.id);
    if (byId >= 0) {
        books[byId] = normalizeManagedBook(nextBook);
        return;
    }

    const byWorldbook = books.findIndex(book =>
        book.worldbook === nextBook.worldbook
        && book.entryName === nextBook.entryName
    );
    if (byWorldbook >= 0) {
        books[byWorldbook] = normalizeManagedBook(nextBook);
        return;
    }

    books.push(normalizeManagedBook(nextBook));
}

async function applyCompiledActions(compiled, metadata = {}) {
    const storyMemory = getStoryMemorySettings();
    const workingBooks = storyMemory.books.map(normalizeManagedBook);
    const stateMap = new Map();
    const snapshots = new Map();

    try {
        for (const action of compiled.actions) {
            const state = await getWorldState(action.worldbook, workingBooks, stateMap);

            switch (action.action) {
                case 'create_book':
                    captureSnapshot(state, snapshots, workingBooks, action.book);
                    {
                        const previousConfig = findManagedBook(workingBooks, action.worldbook, action.book);
                        state.currentConfig = clone(action.config);
                        upsertBook(workingBooks, state.currentConfig);
                        const entry = ensureManagedEntry(state, [action.config.entryName]);
                        syncEntryWithConfig(entry, state.currentConfig);
                        const root = entry.content?.trim() ? parseYamlRoot(entry.content, previousConfig || state.currentConfig) : {};
                        entry.content = stringifyYamlObject(root, state.currentConfig);
                        state.dirty = true;
                    }
                    break;

                case 'configure_book': {
                    captureSnapshot(state, snapshots, workingBooks, action.book);
                    const previousConfig = findManagedBook(workingBooks, action.worldbook, action.book);
                    state.currentConfig = clone(action.config);
                    upsertBook(workingBooks, state.currentConfig);

                    const entry = ensureManagedEntry(state, [action.config.entryName]);
                    syncEntryWithConfig(entry, state.currentConfig);
                    const root = entry.content?.trim() ? parseYamlRoot(entry.content, previousConfig || state.currentConfig) : {};
                    entry.content = stringifyYamlObject(root, state.currentConfig);
                    state.dirty = true;
                    break;
                }

                case 'merge':
                case 'replace':
                case 'delete': {
                    captureSnapshot(state, snapshots, workingBooks, action.book);
                    const targetConfig = findManagedBook(workingBooks, action.worldbook, action.book);
                    if (!targetConfig || !targetConfig.enabled) {
                        throw new Error(`当前聊天世界书未启用受管记忆条目：${action.book}`);
                    }

                    const entry = ensureManagedEntry(state, [targetConfig.entryName]);
                    syncEntryWithConfig(entry, targetConfig);
                    const root = parseYamlRoot(entry.content, targetConfig);
                    applyMemoryAction(root, action);
                    entry.content = stringifyYamlObject(root, targetConfig);
                    state.dirty = true;
                    break;
                }

                default:
                    throw new Error(`未知指令：${action.action}`);
            }
        }

        for (const state of stateMap.values()) {
            if (state.dirty) {
                await dependencies.saveWorldInfo(state.worldbook, state.worldData, true);
            }
        }

        storyMemory.books = workingBooks.map(normalizeManagedBook);

        const historyChanges = buildHistoryChanges([...snapshots.values()], workingBooks, stateMap);
        const changedSnapshotKeys = new Set(historyChanges.map(item => item.snapshotKey));
        const filteredSnapshots = [...snapshots.values()]
            .filter(item => changedSnapshotKeys.has(getSnapshotKey(item.worldbook, item.entryName)))
            .map(item => clone(item));

        if (metadata.recordHistory && historyChanges.length > 0) {
            storyMemory.history.push({
                id: `history_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                createdAt: Date.now(),
                messageId: metadata.messageId ?? null,
                commandText: compiled.commandText || '',
                actionSummary: compiled.summary,
                snapshots: filteredSnapshots,
                changes: historyChanges,
            });
            storyMemory.history = storyMemory.history.slice(-MAX_HISTORY);
        }

        persistSettings();
        await refreshWorldbookViews([...stateMap.keys()]);
        return { success: true };
    } catch (error) {
        console.error('[记忆库] 应用指令失败，开始回滚:', error);
        const rollback = await restoreSnapshots([...snapshots.values()], workingBooks);
        storyMemory.books = rollback.books.map(normalizeManagedBook);
        persistSettings();
        await refreshWorldbookViews(rollback.affectedWorldbooks);
        throw error;
    }
}

function serializeForCompare(value) {
    return JSON.stringify(value ?? null);
}

function buildHistoryChanges(snapshots, workingBooks, stateMap) {
    return snapshots.map(snapshot => {
        const state = stateMap.get(snapshot.worldbook);
        const currentConfig = findManagedBook(workingBooks, snapshot.worldbook, snapshot.entryName);
        const currentEntry = findEntryRecord(state?.worldData, [snapshot.entryName], snapshot.entryUid)?.entry || null;
        const changed = (
            serializeForCompare(snapshot.config) !== serializeForCompare(currentConfig)
            || serializeForCompare(snapshot.entryData) !== serializeForCompare(currentEntry)
        );

        return changed ? {
            snapshotKey: getSnapshotKey(snapshot.worldbook, snapshot.entryName),
            worldbook: snapshot.worldbook,
            entryName: snapshot.entryName,
            beforeContent: snapshot.entryData?.content || '',
            afterContent: currentEntry?.content || '',
        } : null;
    }).filter(Boolean);
}

async function getWorldState(worldbook, workingBooks, stateMap) {
    if (stateMap.has(worldbook)) {
        return stateMap.get(worldbook);
    }

    const state = {
        worldbook,
        worldExists: (dependencies.world_names || []).includes(worldbook),
        worldData: null,
        currentConfig: null,
        dirty: false,
    };

    if (state.worldExists) {
        state.worldData = await dependencies.loadWorldInfo(worldbook);
        if (!state.worldData) {
            throw new Error(`无法加载世界书：${worldbook}`);
        }
    }

    stateMap.set(worldbook, state);
    return state;
}

function getSnapshotKey(worldbook, entryName) {
    return `${worldbook}::${entryName}`;
}

function findEntryRecord(worldData, names = [], preferredUid = null) {
    const entries = worldData?.entries || {};
    const normalizedNames = [...new Set(names.map(name => String(name || '').trim()).filter(Boolean))];

    if (preferredUid != null && entries[String(preferredUid)]) {
        return { key: String(preferredUid), entry: entries[String(preferredUid)] };
    }

    for (const [key, entry] of Object.entries(entries)) {
        if (!entry) continue;
        if (preferredUid != null && String(entry.uid) === String(preferredUid)) {
            return { key, entry };
        }
        if (normalizedNames.includes(String(entry.comment || '').trim())) {
            return { key, entry };
        }
    }

    return null;
}

function setEntryRecord(worldData, entryData) {
    worldData.entries = worldData.entries || {};
    const key = String(entryData.uid);
    worldData.entries[key] = clone(entryData);
}

function removeEntryRecord(worldData, names = [], preferredUid = null) {
    const record = findEntryRecord(worldData, names, preferredUid);
    if (!record) return false;
    delete worldData.entries[record.key];
    return true;
}

function captureSnapshot(state, snapshots, workingBooks, entryName) {
    const snapshotKey = getSnapshotKey(state.worldbook, entryName);
    const existing = snapshots.get(snapshotKey);
    if (existing) {
        return existing;
    }

    const existingConfig = findManagedBook(workingBooks, state.worldbook, entryName);
    const entryRecord = findEntryRecord(state.worldData, [entryName], existingConfig?.uid);

    const snapshot = {
        worldbook: state.worldbook,
        entryName,
        configExisted: Boolean(existingConfig),
        configId: existingConfig?.id || null,
        config: existingConfig ? clone(existingConfig) : null,
        entryExisted: Boolean(entryRecord?.entry),
        entryUid: entryRecord?.entry?.uid ?? null,
        entryData: entryRecord?.entry ? clone(entryRecord.entry) : null,
    };

    snapshots.set(snapshotKey, snapshot);
    return snapshot;
}

function findEntryByComments(worldData, names = []) {
    return findEntryRecord(worldData, names)?.entry || null;
}

function ensureManagedEntry(state, preferredNames = []) {
    if (!state.worldData?.entries) {
        state.worldData = state.worldData || { entries: {} };
        state.worldData.entries = state.worldData.entries || {};
    }

    const names = [...new Set(preferredNames.map(name => String(name || '').trim()).filter(Boolean))];
    let entry = findEntryByComments(state.worldData, names);

    if (!entry) {
        entry = dependencies.createWorldInfoEntry(state.worldbook, state.worldData);
        if (!entry) {
            throw new Error(`创建世界书条目失败：${state.worldbook}`);
        }
    }

    return entry;
}

function syncEntryWithConfig(entry, config) {
    entry.comment = config.entryName;
    entry.key = [...config.keys];
    entry.keysecondary = [...config.keysecondary];
    entry.constant = config.constant;
    entry.selective = config.selective;
    entry.selectiveLogic = getSelectiveLogicValue(config.selectiveLogic);
    entry.disable = false;
    entry.position = config.position;
    entry.order = config.order;
    if (config.position === 4) {
        entry.depth = config.depth;
    } else {
        delete entry.depth;
    }
}

function escapeRegExp(text) {
    return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getPositionValueForHeader(position) {
    return Object.entries(POSITION_MAP).find(([, value]) => value === position)?.[0] || 'depth';
}

function buildManagedHeader(config) {
    const lines = [`# [Book: ${config.entryName}]`];
    if (config.keys?.length) {
        lines.push(`# keys: ${config.keys.join(', ')}`);
    }
    if (config.keysecondary?.length) {
        lines.push(`# keysecondary: ${config.keysecondary.join(', ')}`);
    }
    // 目前不需要push constant, position, selective 和 selectiveLogic 字段
    // if (config.constant) {
    //     lines.push('# constant: true');
    // }
    // if (config.selective === false) {
    //     lines.push('# selective: false');
    // }
    // if (config.keysecondary?.length || (config.selectiveLogic && config.selectiveLogic !== 'AND_ANY')) {
    //     lines.push(`# selectiveLogic: ${config.selectiveLogic}`);
    // }
    // if (config.position != null) {
    //     lines.push(`# position: ${getPositionValueForHeader(config.position)}`);
    // }
    // if (config.position === 4 && Number.isFinite(Number(config.depth))) {
    //     lines.push(`# depth: ${Number(config.depth)}`);
    // }
    if (Number.isFinite(Number(config.order))) {
        lines.push(`# order: ${Number(config.order)}`);
    }
    return `${lines.join('\n')}\n\n`;
}

function stripManagedHeader(content, configOrName) {
    const text = String(content || '');
    const entryName = typeof configOrName === 'string' ? configOrName : configOrName?.entryName;
    const specificPattern = entryName
        ? new RegExp(`^# \\[Book: ${escapeRegExp(entryName)}\\]\\r?\\n(?:# .*\\r?\\n)*(?:\\r?\\n)?`)
        : null;
    const genericPattern = /^# \[Book: .+?\]\r?\n(?:# .*\r?\n)*(?:\r?\n)?/;
    const pattern = specificPattern || genericPattern;
    return text.replace(pattern, '').trim();
}

async function loadManagedEntryState(config, options = {}) {
    const worldData = await dependencies.loadWorldInfo(config.worldbook);
    if (!worldData) {
        throw new Error(`无法加载世界书：${config.worldbook}`);
    }

    const preferredNames = options.preferredNames || [config.entryName];
    let entry = findEntryByComments(worldData, preferredNames);

    if (!entry && options.createIfMissing) {
        entry = dependencies.createWorldInfoEntry(config.worldbook, worldData);
        if (!entry) {
            throw new Error('创建世界书条目失败');
        }
        syncEntryWithConfig(entry, config);
        entry.content = stringifyYamlObject({}, config);
    }

    return { worldData, entry };
}

function parseYamlRoot(content, configOrName = null) {
    const text = stripManagedHeader(content, configOrName).trim();
    if (!text) {
        return {};
    }

    let parsed;
    try {
        parsed = dependencies.yaml.parse(text);
    } catch (error) {
        throw new Error(`YAML 解析失败：${error.message}`);
    }

    if (parsed == null) {
        return {};
    }
    if (!isPlainObject(parsed)) {
        throw new Error('记忆库 YAML 根节点必须是对象');
    }
    return parsed;
}

function stringifyYamlObject(value, config = null) {
    if (!isPlainObject(value)) {
        throw new Error('记忆库根节点必须是对象');
    }
    const rendered = dependencies.yaml.stringify(value, { indent: 2 }).trimEnd();
    const body = rendered ? `${rendered}\n` : '{}\n';
    return config ? `${buildManagedHeader(config)}${body}` : body;
}

function applyMemoryAction(root, action) {
    switch (action.action) {
        case 'merge':
            applyMerge(root, action.path, action.value);
            break;
        case 'replace':
            applyReplace(root, action.path, action.value);
            break;
        case 'delete':
            applyDelete(root, action.path);
            break;
        default:
            throw new Error(`无法应用未知指令：${action.action}`);
    }
}

function applyMerge(root, path, value) {
    if (path.length === 0) {
        if (!isPlainObject(value)) {
            throw new Error('merge 根路径的 value 必须是对象');
        }
        const merged = deepMergeObjects(root, value);
        Object.keys(root).forEach(key => delete root[key]);
        Object.assign(root, merged);
        return;
    }

    const parent = ensureParentPath(root, path);
    const key = path[path.length - 1];
    const existing = parent[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
        parent[key] = deepMergeObjects(existing, value);
    } else {
        parent[key] = clone(value);
    }
}

function applyReplace(root, path, value) {
    if (path.length === 0) {
        if (!isPlainObject(value)) {
            throw new Error('replace 根路径的 value 必须是对象');
        }
        Object.keys(root).forEach(key => delete root[key]);
        Object.assign(root, clone(value));
        return;
    }

    const parent = ensureParentPath(root, path);
    parent[path[path.length - 1]] = clone(value);
}

function applyDelete(root, path) {
    if (path.length === 0) {
        Object.keys(root).forEach(key => delete root[key]);
        return;
    }

    const parent = getParentPath(root, path);
    if (!parent) return;
    delete parent[path[path.length - 1]];
}

function deepMergeObjects(target, source) {
    const result = clone(target);
    for (const [key, value] of Object.entries(source)) {
        if (isPlainObject(value) && isPlainObject(result[key])) {
            result[key] = deepMergeObjects(result[key], value);
        } else {
            result[key] = clone(value);
        }
    }
    return result;
}

function ensureParentPath(root, path) {
    let current = root;
    for (let i = 0; i < path.length - 1; i++) {
        const segment = path[i];
        if (!isPlainObject(current[segment])) {
            current[segment] = {};
        }
        current = current[segment];
    }
    return current;
}

function getParentPath(root, path) {
    let current = root;
    for (let i = 0; i < path.length - 1; i++) {
        const segment = path[i];
        if (!isPlainObject(current[segment])) {
            return null;
        }
        current = current[segment];
    }
    return current;
}

async function restoreSnapshots(snapshots, workingBooks) {
    let books = (workingBooks || []).map(normalizeManagedBook);
    const affectedWorldbooks = new Set();
    const worldDataCache = new Map();

    for (const snapshot of [...snapshots].reverse()) {
        affectedWorldbooks.add(snapshot.worldbook);

        if (snapshot.configExisted && snapshot.config) {
            upsertBook(books, snapshot.config);
        } else if (snapshot.configId) {
            books = books.filter(book => book.id !== snapshot.configId);
        } else {
            books = books.filter(book =>
                !(book.worldbook === snapshot.worldbook && book.entryName === snapshot.entryName)
            );
        }

        let worldData = worldDataCache.get(snapshot.worldbook);
        if (!worldData) {
            worldData = await dependencies.loadWorldInfo(snapshot.worldbook);
            if (!worldData) {
                continue;
            }
            worldDataCache.set(snapshot.worldbook, worldData);
        }

        if (snapshot.entryExisted && snapshot.entryData) {
            setEntryRecord(worldData, snapshot.entryData);
        } else {
            removeEntryRecord(worldData, [snapshot.entryName], snapshot.entryUid);
        }
    }

    for (const [worldbook, worldData] of worldDataCache.entries()) {
        await dependencies.saveWorldInfo(worldbook, worldData, true);
    }

    return {
        books: books.map(normalizeManagedBook),
        affectedWorldbooks: [...affectedWorldbooks],
    };
}

function getPositionText(position, depth) {
    return position === 4 ? `@ Depth ${depth ?? 4}` : (POSITION_LABELS[position] || POSITION_LABELS[4]);
}
