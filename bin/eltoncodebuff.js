#!/usr/bin/env node

/**
 * ⚡ EltonCodeBuff CLI — Free AI Coding Assistant
 * 
 * Usage:
 *   eltoncodebuff                    → Interactive coding chat (default)
 *   eltoncodebuff "fix the login"    → Start with an initial prompt
 *   eltoncodebuff --web              → Open the web UI instead
 *   eltoncodebuff --continue [id]    → Resume a previous session
 *   eltoncodebuff --cwd ./myproject  → Set working directory
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const SERVER_URL = 'http://localhost:3777';
const SESSIONS_DIR = path.join(ROOT, '.sessions');

// ── Parse Args ──
const args = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--web') flags.web = true;
    else if (args[i] === '--continue') { flags.continue = args[i + 1] || 'latest'; i++; }
    else if (args[i] === '--cwd') { flags.cwd = args[i + 1]; i++; }
    else if (args[i] === '--free') flags.mode = 'free';
    else if (args[i] === '--max') flags.mode = 'max';
    else if (args[i] === '-h' || args[i] === '--help') { showHelp(); process.exit(0); }
    else if (args[i] === '-v' || args[i] === '--version') { console.log('eltoncodebuff v1.0.0'); process.exit(0); }
    else if (!args[i].startsWith('--')) positional.push(args[i]);
}

const projectPath = flags.cwd || process.cwd();
const initialPrompt = positional.join(' ');

// ── Colors (disabled for Windows compat) ──
const c = {
    reset: '', bold: '', dim: '', italic: '',
    cyan: '', green: '', yellow: '',
    magenta: '', red: '', gray: '',
    blue: '', white: '', bgCyan: '',
};

function showHelp() {
    console.log(`
  ${c.cyan}${c.bold}⚡ EltonCodeBuff${c.reset} — Free AI Coding Assistant

  ${c.bold}Usage:${c.reset}
    eltoncodebuff [options] [prompt...]

  ${c.bold}Arguments:${c.reset}
    prompt                        Initial prompt to send to the AI

  ${c.bold}Options:${c.reset}
    -v, --version                 Print version
    --web                         Open the web UI in browser
    --continue [session-id]       Resume a previous session
    --cwd <directory>             Set working directory
    --free                        Use free OpenRouter models
    --max                         Use best available model
    -h, --help                    Show this help

  ${c.bold}Commands (in chat):${c.reset}
    /files                        List project files
    /read <path>                  Read a file into context
    /clear                        Clear chat history
    /save                         Save session for later
    /quit                         Exit

  ${c.bold}Examples:${c.reset}
    ${c.dim}$ eltoncodebuff "explain the auth flow"${c.reset}
    ${c.dim}$ eltoncodebuff --cwd ./myapp "fix the login bug"${c.reset}
    ${c.dim}$ eltoncodebuff --continue${c.reset}
`);
}

// ── Project Scanner ──
function scanProject(dir) {
    const info = { files: 0, dirs: 0, languages: new Set(), keyFiles: [] };
    const keyFileNames = ['package.json', 'requirements.txt', 'Cargo.toml', 'go.mod',
        'pyproject.toml', 'Makefile', 'Dockerfile', 'docker-compose.yml',
        '.env', 'README.md', 'tsconfig.json', '.gitignore'];
    const extMap = {
        '.js': 'JavaScript', '.ts': 'TypeScript', '.py': 'Python', '.go': 'Go',
        '.rs': 'Rust', '.java': 'Java', '.rb': 'Ruby', '.php': 'PHP',
        '.cpp': 'C++', '.c': 'C', '.cs': 'C#', '.swift': 'Swift',
        '.html': 'HTML', '.css': 'CSS', '.sql': 'SQL',
    };

    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
            if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '__pycache__'
                || e.name === 'venv' || e.name === '.venv' || e.name === 'dist' || e.name === 'build') continue;
            if (e.isDirectory()) {
                info.dirs++;
            } else {
                info.files++;
                const ext = path.extname(e.name);
                if (extMap[ext]) info.languages.add(extMap[ext]);
                if (keyFileNames.includes(e.name)) info.keyFiles.push(e.name);
            }
        }
    } catch { }
    return info;
}

// ── Session Management ──
function generateSessionId() {
    return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function saveSession(sessionId, messages) {
    if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    const file = path.join(SESSIONS_DIR, `${sessionId}.json`);
    fs.writeFileSync(file, JSON.stringify({ id: sessionId, project: projectPath, messages, savedAt: new Date().toISOString() }, null, 2));
    return file;
}

function loadSession(sessionId) {
    if (sessionId === 'latest') {
        if (!fs.existsSync(SESSIONS_DIR)) return null;
        const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json')).sort().reverse();
        if (files.length === 0) return null;
        sessionId = files[0].replace('.json', '');
    }
    const file = path.join(SESSIONS_DIR, `${sessionId}.json`);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

// ── Server Management ──
async function isServerRunning() {
    try {
        const r = await fetch(`${SERVER_URL}/api/config`, { signal: AbortSignal.timeout(2000) });
        return r.ok;
    } catch { return false; }
}

async function ensureServer() {
    if (await isServerRunning()) return;

    process.stdout.write(`  ${c.yellow}🚀 Starting server...${c.reset}`);
    const server = spawn('node', [path.join(ROOT, 'server', 'index.js')], {
        cwd: ROOT, stdio: 'ignore', detached: true, env: { ...process.env },
    });
    server.unref();

    for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1000));
        process.stdout.write('.');
        if (await isServerRunning()) {
            console.log(` ${c.green}ready!${c.reset}`);
            return;
        }
    }
    console.log(` ${c.red}failed${c.reset}`);
    process.exit(1);
}

// ── Get Config ──
async function getConfig() {
    try {
        const r = await fetch(`${SERVER_URL}/api/config`);
        const d = await r.json();
        return d.config || {};
    } catch { return {}; }
}

// ── Chat API ──
async function streamChat(messages, onChunk) {
    const config = await getConfig();
    const model = config.provider === 'custom'
        ? (config.custom_model || 'deepseek-chat')
        : config.provider === 'openrouter'
            ? (config.openrouter_model || 'google/gemma-3n-e2b-it:free')
            : (config.ollama_model || 'codellama');

    const resp = await fetch(`${SERVER_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: true, max_tokens: 4096 }),
    });

    if (!resp.ok) {
        const err = await resp.text();
        throw new Error(err);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let full = '';
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
            const t = line.trim();
            if (!t || !t.startsWith('data: ')) continue;
            const data = t.slice(6);
            if (data === '[DONE]') continue;
            try {
                const p = JSON.parse(data);
                const content = p.choices?.[0]?.delta?.content;
                if (content) { onChunk(content); full += content; }
            } catch { }
        }
    }
    return full;
}

// ── File Operations ──
async function readProjectFile(filePath) {
    const full = path.resolve(projectPath, filePath);
    try {
        return fs.readFileSync(full, 'utf-8');
    } catch (e) {
        return `Error reading ${filePath}: ${e.message}`;
    }
}

function listProjectFiles() {
    try {
        const items = fs.readdirSync(projectPath, { withFileTypes: true });
        const dirs = items.filter(i => i.isDirectory() && !i.name.startsWith('.') && i.name !== 'node_modules').map(i => `📁 ${i.name}/`);
        const files = items.filter(i => i.isFile()).map(i => `📄 ${i.name}`);
        return [...dirs, ...files].join('\n');
    } catch (e) {
        return `Error: ${e.message}`;
    }
}

// ── Banner ──
function showBanner(projectInfo, config, sessionId) {
    const provider = config.provider === 'custom' ? 'DeepSeek'
        : config.provider === 'openrouter' ? 'OpenRouter'
            : config.provider === 'ollama' ? 'Ollama' : 'Unknown';
    const model = config.custom_model || config.openrouter_model || config.ollama_model || 'default';
    const langs = [...projectInfo.languages].slice(0, 4).join(', ') || 'Unknown';

    console.log('');
    console.log('  +----------------------------------------------+');
    console.log('  |  EltonCodeBuff - Free AI Coding Assistant     |');
    console.log('  +----------------------------------------------+');
    console.log('');
    console.log(`  Provider:  ${provider} (${model})`);
    console.log(`  Project:   ${path.basename(projectPath)}`);
    console.log(`  Files:     ${projectInfo.files} files, ${projectInfo.dirs} dirs`);
    console.log(`  Languages: ${langs}`);
    if (projectInfo.keyFiles.length > 0) {
        console.log(`  Key files: ${projectInfo.keyFiles.join(', ')}`);
    }
    console.log(`  Session:   ${sessionId}`);
    console.log('');
    console.log('  Type a message to chat. Use /help for commands.');
    console.log('  The AI has context about your project structure.');
    console.log('');
}

// ── Interactive Chat ──
async function interactiveChat() {
    const config = await getConfig();
    const projectInfo = scanProject(projectPath);

    // Load or create session
    let messages = [];
    let sessionId;

    if (flags.continue) {
        const session = loadSession(flags.continue);
        if (session) {
            messages = session.messages;
            sessionId = session.id;
            console.log(`  ${c.green}📂 Resumed session ${sessionId} (${messages.length} messages)${c.reset}`);
        } else {
            console.log(`  ${c.yellow}⚠️  No session found, starting fresh${c.reset}`);
            sessionId = generateSessionId();
        }
    } else {
        sessionId = generateSessionId();
    }

    showBanner(projectInfo, config, sessionId);

    // Build system prompt with project context
    const systemPrompt = {
        role: 'system',
        content: `You are EltonCodeBuff, an expert AI coding assistant. You are helping the user with their project.

Project: ${path.basename(projectPath)}
Path: ${projectPath}
Languages: ${[...projectInfo.languages].join(', ') || 'Unknown'}
Key files: ${projectInfo.keyFiles.join(', ') || 'None detected'}
Files: ${projectInfo.files} files in ${projectInfo.dirs} directories

You can read files when asked. Be concise but thorough. Format code with markdown code blocks.
When suggesting code changes, show the exact file and the code to change.
Be proactive — suggest improvements and catch potential issues.`
    };

    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: '  > ',
    });

    rl.prompt();

    const handleLine = async (line) => {
        const input = line.trim();
        if (!input) { rl.prompt(); return; }

        // Commands
        if (input === '/help') {
            console.log(`
  ${c.bold}Commands:${c.reset}
    ${c.cyan}/files${c.reset}          List project files
    ${c.cyan}/read <path>${c.reset}    Read a file into context
    ${c.cyan}/clear${c.reset}          Clear chat history
    ${c.cyan}/save${c.reset}           Save session for later
    ${c.cyan}/session${c.reset}        Show session info
    ${c.cyan}/quit${c.reset}           Exit
`);
            rl.prompt(); return;
        }

        if (input === '/quit' || input === '/exit') {
            saveSession(sessionId, messages);
            console.log(`\n  ${c.cyan}💾 Session saved. Resume with:${c.reset}`);
            console.log(`  ${c.dim}eltoncodebuff --continue ${sessionId}${c.reset}\n`);
            process.exit(0);
        }

        if (input === '/clear') {
            messages = [];
            console.log(`  ${c.yellow}🗑️  Chat cleared${c.reset}\n`);
            rl.prompt(); return;
        }

        if (input === '/files') {
            console.log(`\n${listProjectFiles()}\n`);
            rl.prompt(); return;
        }

        if (input.startsWith('/read ')) {
            const filePath = input.slice(6).trim();
            const content = await readProjectFile(filePath);
            const preview = content.length > 500 ? content.slice(0, 500) + '...' : content;
            console.log(`\n  ${c.dim}── ${filePath} ──${c.reset}`);
            console.log(`  ${c.gray}${preview.split('\n').join('\n  ')}${c.reset}`);
            console.log(`  ${c.dim}── (${content.length} chars, added to context) ──${c.reset}\n`);
            messages.push({ role: 'user', content: `Here is the content of ${filePath}:\n\`\`\`\n${content}\n\`\`\`` });
            messages.push({ role: 'assistant', content: `I've read ${filePath} (${content.length} chars). What would you like me to do with it?` });
            rl.prompt(); return;
        }

        if (input === '/save') {
            const file = saveSession(sessionId, messages);
            console.log(`  ${c.green}💾 Saved! Resume with:${c.reset}`);
            console.log(`  ${c.dim}eltoncodebuff --continue ${sessionId}${c.reset}\n`);
            rl.prompt(); return;
        }

        if (input === '/session') {
            console.log(`\n  Session: ${sessionId}`);
            console.log(`  Messages: ${messages.length}`);
            console.log(`  Project: ${projectPath}\n`);
            rl.prompt(); return;
        }

        // Regular chat message
        messages.push({ role: 'user', content: input });

        try {
            const allMessages = [systemPrompt, ...messages];
            process.stdout.write('\n  [EltonCodeBuff] ');

            const reply = await streamChat(allMessages, (chunk) => {
                process.stdout.write(chunk);
            });

            console.log('\n');

            if (reply) {
                messages.push({ role: 'assistant', content: reply });
                // Auto-save every 5 messages
                if (messages.length % 10 === 0) {
                    saveSession(sessionId, messages);
                }
            }
        } catch (err) {
            console.log(`\n  ${c.red}❌ ${err.message}${c.reset}\n`);
        }

        rl.prompt();
    };

    rl.on('line', handleLine);

    rl.on('close', () => {
        if (messages.length > 0) {
            saveSession(sessionId, messages);
            console.log(`\n  ${c.cyan}💾 Session saved. Resume with:${c.reset}`);
            console.log(`  ${c.dim}eltoncodebuff --continue ${sessionId}${c.reset}\n`);
        }
        process.exit(0);
    });

    // Handle initial prompt
    if (initialPrompt) {
        handleLine(initialPrompt);
    }
}

function openBrowser(url) {
    const cmd = process.platform === 'win32' ? 'start'
        : process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(cmd, [url], { shell: true, detached: true, stdio: 'ignore' });
}

// ── Main ──
async function main() {
    await ensureServer();

    if (flags.web) {
        console.log(`  ${c.cyan}🌐 Opening browser...${c.reset}`);
        openBrowser(SERVER_URL);
    } else {
        await interactiveChat();
    }
}

main();
