// ═══════════════════════════════════════════════════════════
// EltonCodeBuff — Main Application
// ═══════════════════════════════════════════════════════════

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ── State ──
let ws = null;
let isStreaming = false;
let chatHistory = [];
let attachedFiles = [];
let currentProjectPath = '';
let selectedProvider = '';

// ── Initialize ──
document.addEventListener('DOMContentLoaded', async () => {
    await checkConfig();
    setupWizard();
    setupChat();
    setupFileTree();
    setupSettings();
    setupCodeViewer();
});

// ═══════════════════════════════════════════════════════════
// CONFIG CHECK
// ═══════════════════════════════════════════════════════════

async function checkConfig() {
    try {
        const res = await fetch('/api/config');
        const data = await res.json();
        if (data.configured) {
            showApp(data.config);
        } else {
            showWizard();
        }
    } catch (err) {
        console.error('Config check failed:', err);
        showWizard();
    }
}

function showWizard() {
    $('#setup-wizard').classList.remove('hidden');
    $('#app').classList.add('hidden');
}

function showApp(config) {
    $('#setup-wizard').classList.add('hidden');
    $('#app').classList.remove('hidden');

    // Update provider badge
    const badge = $('#provider-badge');
    if (config?.provider === 'openrouter') badge.textContent = 'OpenRouter';
    else if (config?.provider === 'ollama') badge.textContent = 'Ollama';
    else if (config?.provider === 'custom') badge.textContent = 'Custom API';

    connectWebSocket();
    loadModels();
}

// ═══════════════════════════════════════════════════════════
// SETUP WIZARD
// ═══════════════════════════════════════════════════════════

function setupWizard() {
    // Provider selection
    $$('.provider-card').forEach(card => {
        card.addEventListener('click', () => {
            selectedProvider = card.dataset.provider;
            $('#wizard-step-1').classList.add('hidden');
            $('#wizard-step-2').classList.remove('hidden');

            // Show correct config panel
            $('#config-openrouter').classList.add('hidden');
            $('#config-ollama').classList.add('hidden');
            $('#config-custom').classList.add('hidden');

            if (selectedProvider === 'openrouter') {
                $('#config-title').textContent = 'Configure OpenRouter';
                $('#config-openrouter').classList.remove('hidden');
            } else if (selectedProvider === 'ollama') {
                $('#config-title').textContent = 'Configure Ollama';
                $('#config-ollama').classList.remove('hidden');
            } else {
                $('#config-title').textContent = 'Configure Custom API';
                $('#config-custom').classList.remove('hidden');
            }
        });
    });

    // Back button
    $('#wizard-back').addEventListener('click', () => {
        $('#wizard-step-2').classList.add('hidden');
        $('#wizard-step-1').classList.remove('hidden');
    });

    // Save button
    $('#wizard-save').addEventListener('click', async () => {
        const config = { provider: selectedProvider };

        if (selectedProvider === 'openrouter') {
            config.openrouter_api_key = $('#or-api-key').value.trim();
            config.openrouter_model = $('#or-model').value;
            if (!config.openrouter_api_key) {
                alert('Please enter your OpenRouter API key');
                return;
            }
        } else if (selectedProvider === 'ollama') {
            config.ollama_base_url = $('#ol-url').value.trim() || 'http://localhost:11434';
            config.ollama_model = $('#ol-model').value.trim() || 'codellama';
        } else if (selectedProvider === 'custom') {
            config.custom_base_url = $('#cu-url').value.trim();
            config.custom_api_key = $('#cu-key').value.trim();
            config.custom_model = $('#cu-model').value.trim();
            if (!config.custom_base_url) {
                alert('Please enter the API base URL');
                return;
            }
        }

        try {
            const res = await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config),
            });
            const data = await res.json();
            if (data.success) {
                showApp(config);
            }
        } catch (err) {
            alert('Failed to save config: ' + err.message);
        }
    });
}

// ═══════════════════════════════════════════════════════════
// WEBSOCKET
// ═══════════════════════════════════════════════════════════

function connectWebSocket() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);

    ws.onopen = () => {
        updateStatus('Connected');
    };

    ws.onclose = () => {
        updateStatus('Disconnected — reconnecting...');
        setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = () => {
        updateStatus('Connection error');
    };

    let currentAssistantEl = null;
    let currentContent = '';

    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);

        switch (msg.type) {
            case 'start':
                isStreaming = true;
                updateStatus(`Using ${msg.model}...`);
                currentContent = '';
                currentAssistantEl = addMessage('assistant', '');
                removeThinking();
                break;

            case 'chunk':
                currentContent += msg.content;
                if (currentAssistantEl) {
                    const contentEl = currentAssistantEl.querySelector('.message-content');
                    contentEl.innerHTML = renderMarkdown(currentContent);
                    addCopyButtons(contentEl);
                    scrollToBottom();
                }
                break;

            case 'done':
                isStreaming = false;
                updateStatus('Ready');
                if (currentContent) {
                    chatHistory.push({ role: 'assistant', content: currentContent });
                }
                currentAssistantEl = null;
                currentContent = '';
                enableInput();
                break;

            case 'error':
                isStreaming = false;
                removeThinking();
                addErrorMessage(msg.content);
                updateStatus('Error occurred');
                enableInput();
                break;
        }
    };
}

// ═══════════════════════════════════════════════════════════
// CHAT
// ═══════════════════════════════════════════════════════════

function setupChat() {
    const input = $('#chat-input');
    const sendBtn = $('#btn-send');
    const attachBtn = $('#btn-attach');

    // Auto-resize textarea
    input.addEventListener('input', () => {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 200) + 'px';
    });

    // Send on Enter (Shift+Enter for newline)
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    sendBtn.addEventListener('click', sendMessage);

    // Attach file button
    attachBtn.addEventListener('click', () => {
        if (!currentProjectPath) {
            alert('Load a project first to attach files');
            return;
        }
        const filePath = prompt('Enter file path to attach:');
        if (filePath) attachFile(filePath);
    });

    // Suggestion chips
    $$('.suggestion-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            input.value = chip.dataset.prompt;
            input.focus();
        });
    });
}

async function sendMessage() {
    const input = $('#chat-input');
    const text = input.value.trim();
    if (!text || isStreaming) return;

    // Build user message with any attached file contents
    let fullContent = text;
    if (attachedFiles.length > 0) {
        fullContent += '\n\n--- Attached Files ---\n';
        for (const f of attachedFiles) {
            fullContent += `\n📄 **${f.name}**:\n\`\`\`${f.extension?.replace('.', '') || ''}\n${f.content}\n\`\`\`\n`;
        }
    }

    // Clear input
    input.value = '';
    input.style.height = 'auto';
    clearAttachments();

    // Remove welcome message
    const welcome = $('.welcome-message');
    if (welcome) welcome.remove();

    // Add user message to UI
    addMessage('user', text);
    chatHistory.push({ role: 'user', content: fullContent });

    // Show thinking indicator
    addThinking();
    disableInput();

    // Send via WebSocket
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'chat',
            messages: chatHistory,
            projectPath: currentProjectPath,
        }));
    } else {
        addErrorMessage('Not connected to server. Reconnecting...');
        enableInput();
    }
}

function addMessage(role, content) {
    const container = $('#chat-messages');
    const el = document.createElement('div');
    el.className = `message ${role}`;

    const avatar = role === 'user' ? '👤' : '⚡';
    const author = role === 'user' ? 'You' : 'EltonCodeBuff';

    el.innerHTML = `
    <div class="message-avatar">${avatar}</div>
    <div class="message-body">
      <div class="message-author">${author}</div>
      <div class="message-content">${role === 'user' ? escapeHtml(content) : renderMarkdown(content)}</div>
    </div>
  `;

    container.appendChild(el);
    if (role !== 'user') addCopyButtons(el.querySelector('.message-content'));
    scrollToBottom();
    return el;
}

function addErrorMessage(text) {
    const container = $('#chat-messages');
    const el = document.createElement('div');
    el.className = 'error-msg';
    el.innerHTML = `⚠️ ${escapeHtml(text)}`;
    container.appendChild(el);
    scrollToBottom();
}

function addThinking() {
    const container = $('#chat-messages');
    const el = document.createElement('div');
    el.className = 'thinking';
    el.id = 'thinking-indicator';
    el.innerHTML = `
    <div class="thinking-dots">
      <span class="thinking-dot"></span>
      <span class="thinking-dot"></span>
      <span class="thinking-dot"></span>
    </div>
    <span>Thinking...</span>
  `;
    container.appendChild(el);
    scrollToBottom();
}

function removeThinking() {
    const el = $('#thinking-indicator');
    if (el) el.remove();
}

function scrollToBottom() {
    const container = $('#chat-messages');
    container.scrollTop = container.scrollHeight;
}

function disableInput() {
    $('#chat-input').disabled = true;
    $('#btn-send').disabled = true;
}

function enableInput() {
    $('#chat-input').disabled = false;
    $('#btn-send').disabled = false;
    $('#chat-input').focus();
}

function updateStatus(text) {
    $('#chat-status').textContent = text;
}

// ═══════════════════════════════════════════════════════════
// FILE TREE
// ═══════════════════════════════════════════════════════════

function setupFileTree() {
    $('#btn-load-project').addEventListener('click', loadProject);
    $('#project-path').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') loadProject();
    });

    $('#btn-toggle-sidebar').addEventListener('click', () => {
        $('#sidebar').classList.toggle('collapsed');
    });

    // File search
    let searchTimeout;
    $('#file-search').addEventListener('input', (e) => {
        clearTimeout(searchTimeout);
        const query = e.target.value.trim();
        if (query.length < 2) return;
        searchTimeout = setTimeout(() => searchInFiles(query), 500);
    });
}

async function loadProject() {
    const pathInput = $('#project-path');
    const dirPath = pathInput.value.trim();
    if (!dirPath) return;

    currentProjectPath = dirPath;

    try {
        const res = await fetch('/api/files/tree', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dirPath }),
        });
        const data = await res.json();
        if (data.error) {
            alert('Error: ' + data.error);
            return;
        }
        renderFileTree(data.tree);
    } catch (err) {
        alert('Failed to load project: ' + err.message);
    }
}

function renderFileTree(tree, container = null, depth = 0) {
    if (!container) {
        const treeEl = $('#file-tree');
        treeEl.innerHTML = '';
        container = treeEl;
    }

    for (const item of tree) {
        const el = document.createElement('div');
        el.className = 'tree-item';
        el.setAttribute('data-depth', depth);

        if (item.type === 'directory') {
            let isExpanded = depth < 1;
            const icon = isExpanded ? '📂' : '📁';
            el.innerHTML = `<span class="tree-icon">${icon}</span><span class="tree-name">${item.name}</span>`;

            const childContainer = document.createElement('div');
            childContainer.style.display = isExpanded ? 'block' : 'none';

            el.addEventListener('click', (e) => {
                e.stopPropagation();
                isExpanded = !isExpanded;
                childContainer.style.display = isExpanded ? 'block' : 'none';
                el.querySelector('.tree-icon').textContent = isExpanded ? '📂' : '📁';
            });

            container.appendChild(el);
            container.appendChild(childContainer);

            if (item.children && item.children.length > 0) {
                renderFileTree(item.children, childContainer, depth + 1);
            }
        } else {
            const icon = getFileIcon(item.extension);
            el.innerHTML = `<span class="tree-icon">${icon}</span><span class="tree-name">${item.name}</span>`;
            el.addEventListener('click', () => openFile(item.path, item.name));
            container.appendChild(el);
        }
    }
}

function getFileIcon(ext) {
    const icons = {
        '.js': '📜', '.jsx': '⚛️', '.ts': '📘', '.tsx': '⚛️',
        '.py': '🐍', '.html': '🌐', '.css': '🎨', '.scss': '🎨',
        '.json': '📋', '.md': '📝', '.txt': '📄',
        '.yml': '⚙️', '.yaml': '⚙️', '.toml': '⚙️',
        '.sql': '🗃️', '.sh': '🖥️', '.bat': '🖥️',
        '.go': '🔵', '.rs': '🦀', '.java': '☕', '.rb': '💎',
        '.php': '🐘', '.swift': '🍎', '.c': '🔧', '.cpp': '🔧',
        '.env': '🔐', '.lock': '🔒', '.gitignore': '👁️',
    };
    return icons[ext] || '📄';
}

async function openFile(filePath, fileName) {
    try {
        const res = await fetch('/api/files/read', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filePath }),
        });
        const data = await res.json();
        if (data.error) {
            alert('Error: ' + data.error);
            return;
        }

        // Show code viewer
        const viewer = $('#code-viewer');
        viewer.classList.remove('hidden');
        $('#code-viewer-filename').textContent = fileName;
        $('#code-viewer-content').textContent = data.content;
    } catch (err) {
        alert('Failed to open file: ' + err.message);
    }
}

async function attachFile(filePath) {
    try {
        const res = await fetch('/api/files/read', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filePath }),
        });
        const data = await res.json();
        if (data.error) {
            alert('Error: ' + data.error);
            return;
        }

        attachedFiles.push(data);
        renderAttachments();
    } catch (err) {
        alert('Failed to attach file: ' + err.message);
    }
}

function renderAttachments() {
    const container = $('#attached-files');
    container.innerHTML = '';
    attachedFiles.forEach((f, i) => {
        const el = document.createElement('div');
        el.className = 'attached-file';
        el.innerHTML = `
      📄 ${f.fileName}
      <span class="attached-file-remove" data-index="${i}">✕</span>
    `;
        el.querySelector('.attached-file-remove').addEventListener('click', () => {
            attachedFiles.splice(i, 1);
            renderAttachments();
        });
        container.appendChild(el);
    });
}

function clearAttachments() {
    attachedFiles = [];
    $('#attached-files').innerHTML = '';
}

async function searchInFiles(query) {
    if (!currentProjectPath) return;
    try {
        const res = await fetch('/api/files/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dirPath: currentProjectPath, query }),
        });
        const data = await res.json();
        // Show results in file tree area
        const treeEl = $('#file-tree');
        if (!data.results || data.results.length === 0) {
            treeEl.innerHTML = '<div class="file-tree-empty"><p>No results found</p></div>';
            return;
        }
        treeEl.innerHTML = '';
        data.results.forEach(r => {
            const el = document.createElement('div');
            el.className = 'tree-item';
            el.setAttribute('data-depth', '0');
            const fileName = r.file.split(/[/\\]/).pop();
            el.innerHTML = `<span class="tree-icon">🔍</span><span class="tree-name">${fileName}:${r.line}</span>`;
            el.title = r.content;
            el.addEventListener('click', () => openFile(r.file, fileName));
            treeEl.appendChild(el);
        });
    } catch (err) {
        console.error('Search failed:', err);
    }
}

// ═══════════════════════════════════════════════════════════
// CODE VIEWER
// ═══════════════════════════════════════════════════════════

function setupCodeViewer() {
    $('#btn-close-viewer').addEventListener('click', () => {
        $('#code-viewer').classList.add('hidden');
    });
}

// ═══════════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════════

function setupSettings() {
    $('#btn-settings').addEventListener('click', () => {
        $('#settings-modal').classList.remove('hidden');
    });

    $('#btn-close-settings').addEventListener('click', () => {
        $('#settings-modal').classList.add('hidden');
    });

    // Close on backdrop click
    $('#settings-modal .modal-backdrop').addEventListener('click', () => {
        $('#settings-modal').classList.add('hidden');
    });

    // Show/hide provider fields
    $('#settings-provider').addEventListener('change', (e) => {
        const val = e.target.value;
        $('#settings-openrouter-fields').classList.toggle('hidden', val !== 'openrouter');
        $('#settings-ollama-fields').classList.toggle('hidden', val !== 'ollama');
        $('#settings-custom-fields').classList.toggle('hidden', val !== 'custom');
    });

    // Save settings
    $('#btn-save-settings').addEventListener('click', async () => {
        const provider = $('#settings-provider').value;
        const config = { provider };

        if (provider === 'openrouter') {
            const key = $('#settings-or-key').value.trim();
            if (key) config.openrouter_api_key = key;
        } else if (provider === 'ollama') {
            config.ollama_base_url = $('#settings-ol-url').value.trim() || 'http://localhost:11434';
            config.ollama_model = $('#settings-ol-model').value.trim() || 'codellama';
        } else if (provider === 'custom') {
            config.custom_base_url = $('#settings-cu-url').value.trim();
            config.custom_api_key = $('#settings-cu-key').value.trim();
            config.custom_model = $('#settings-cu-model').value.trim();
        }

        try {
            await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config),
            });
            $('#settings-modal').classList.add('hidden');
            loadModels();
            // Update badge
            const badge = $('#provider-badge');
            if (provider === 'openrouter') badge.textContent = 'OpenRouter';
            else if (provider === 'ollama') badge.textContent = 'Ollama';
            else badge.textContent = 'Custom API';
        } catch (err) {
            alert('Failed to save: ' + err.message);
        }
    });
}

// ═══════════════════════════════════════════════════════════
// MODELS
// ═══════════════════════════════════════════════════════════

async function loadModels() {
    const select = $('#model-selector');
    select.innerHTML = '<option>Loading models...</option>';

    try {
        const res = await fetch('/api/models');
        const data = await res.json();

        if (data.models && data.models.length > 0) {
            select.innerHTML = '';
            data.models.forEach(m => {
                const opt = document.createElement('option');
                opt.value = m.id;
                const freeTag = m.isFree ? '✨ ' : '';
                opt.textContent = `${freeTag}${m.name}`;
                select.appendChild(opt);
            });
        } else {
            select.innerHTML = '<option>No models available</option>';
        }
    } catch (err) {
        select.innerHTML = '<option>Failed to load models</option>';
    }

    // Update model on change
    select.addEventListener('change', async (e) => {
        const model = e.target.value;
        try {
            const configRes = await fetch('/api/config');
            const configData = await configRes.json();
            const config = configData.config || {};

            if (config.provider === 'openrouter') {
                await fetch('/api/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ openrouter_model: model }),
                });
            } else if (config.provider === 'ollama') {
                await fetch('/api/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ollama_model: model }),
                });
            } else if (config.provider === 'custom') {
                await fetch('/api/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ custom_model: model }),
                });
            }
        } catch (err) {
            console.error('Failed to update model:', err);
        }
    });
}

// ═══════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function renderMarkdown(text) {
    if (!text) return '';
    try {
        return marked.parse(text, { breaks: true, gfm: true });
    } catch {
        return escapeHtml(text);
    }
}

function addCopyButtons(container) {
    if (!container) return;
    container.querySelectorAll('pre').forEach(pre => {
        if (pre.querySelector('.copy-btn')) return;
        const btn = document.createElement('button');
        btn.className = 'copy-btn';
        btn.textContent = 'Copy';
        btn.addEventListener('click', () => {
            const code = pre.querySelector('code');
            navigator.clipboard.writeText(code?.textContent || pre.textContent);
            btn.textContent = 'Copied!';
            btn.classList.add('copied');
            setTimeout(() => {
                btn.textContent = 'Copy';
                btn.classList.remove('copied');
            }, 2000);
        });
        pre.style.position = 'relative';
        pre.appendChild(btn);
    });
}
