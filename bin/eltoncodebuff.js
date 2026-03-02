#!/usr/bin/env node

/**
 * EltonCodeBuff CLI - Free AI Coding Assistant
 * 
 * Usage:
 *   eltoncodebuff                    - Interactive coding chat (default)
 *   eltoncodebuff "fix the login"    - Start with an initial prompt
 *   eltoncodebuff --web              - Open the web UI instead
 *   eltoncodebuff --continue [id]    - Resume a previous session
 *   eltoncodebuff --cwd ./myproject  - Set working directory
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

// Disable mouse tracking in VSCode terminal (prevents garbled escape codes)
process.stdout.write('\x1b[?1000l\x1b[?1003l\x1b[?1006l\x1b[?1015l');

// Parse Args
const args = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--web') flags.web = true;
    else if (args[i] === '--continue') { flags.cont = args[i + 1] || 'latest'; i++; }
    else if (args[i] === '--cwd') { flags.cwd = args[i + 1]; i++; }
    else if (args[i] === '--free') flags.mode = 'free';
    else if (args[i] === '--max') flags.mode = 'max';
    else if (args[i] === '-h' || args[i] === '--help') { showHelp(); process.exit(0); }
    else if (args[i] === '-v' || args[i] === '--version') { console.log('eltoncodebuff v1.0.0'); process.exit(0); }
    else if (!args[i].startsWith('--')) positional.push(args[i]);
}

const projectPath = flags.cwd || process.cwd();
const initialPrompt = positional.join(' ');

function showHelp() {
    console.log(`
  EltonCodeBuff - Free AI Coding Assistant

  Usage:
    eltoncodebuff [options] [prompt...]

  Arguments:
    prompt                        Initial prompt to send to the AI

  Options:
    -v, --version                 Print version
    --web                         Open the web UI in browser
    --continue [session-id]       Resume a previous session
    --cwd <directory>             Set working directory
    --free                        Use free OpenRouter models
    --max                         Use best available model
    -h, --help                    Show this help

  Commands (in chat):
    /files                        List project files
    /read <path>                  Read a file into context
    /clear                        Clear chat history
    /save                         Save session for later
    /quit                         Exit

  Examples:
    $ eltoncodebuff "explain the auth flow"
    $ eltoncodebuff --cwd ./myapp "fix the login bug"
    $ eltoncodebuff --continue
`);
}

// Project Scanner
function scanProject(dir) {
    const info = { files: 0, dirs: 0, languages: new Set(), keyFiles: [] };
    const keyFileNames = ['package.json', 'requirements.txt', 'Cargo.toml', 'go.mod',
        'pyproject.toml', 'Makefile', 'Dockerfile', 'docker-compose.yml',
        '.env', 'README.md', 'tsconfig.json', '.gitignore'];
    const extMap = {
        '.js': 'JavaScript', '.ts': 'TypeScript', '.py': 'Python', '.go': 'Go',
        '.rs': 'Rust', '.java': 'Java', '.rb': 'Ruby', '.php': 'PHP',
        '.html': 'HTML', '.css': 'CSS', '.sql': 'SQL',
    };
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
            if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '__pycache__'
                || e.name === 'venv' || e.name === '.venv' || e.name === 'dist') continue;
            if (e.isDirectory()) { info.dirs++; }
            else {
                info.files++;
                const ext = path.extname(e.name);
                if (extMap[ext]) info.languages.add(extMap[ext]);
                if (keyFileNames.includes(e.name)) info.keyFiles.push(e.name);
            }
        }
    } catch { }
    return info;
}

// Session Management
function genSessionId() {
    return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function saveSession(id, messages) {
    if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    fs.writeFileSync(path.join(SESSIONS_DIR, `${id}.json`),
        JSON.stringify({ id, project: projectPath, messages, savedAt: new Date().toISOString() }, null, 2));
}

function loadSession(id) {
    if (id === 'latest') {
        if (!fs.existsSync(SESSIONS_DIR)) return null;
        const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json')).sort().reverse();
        if (!files.length) return null;
        id = files[0].replace('.json', '');
    }
    const file = path.join(SESSIONS_DIR, `${id}.json`);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

// Server
async function isServerUp() {
    try {
        const r = await fetch(`${SERVER_URL}/api/config`, { signal: AbortSignal.timeout(2000) });
        return r.ok;
    } catch { return false; }
}

async function ensureServer() {
    if (await isServerUp()) return;
    process.stdout.write('  Starting server...');
    const s = spawn('node', [path.join(ROOT, 'server', 'index.js')], {
        cwd: ROOT, stdio: 'ignore', detached: true,
    });
    s.unref();
    for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1000));
        process.stdout.write('.');
        if (await isServerUp()) { console.log(' ready!'); return; }
    }
    console.log(' failed!');
    process.exit(1);
}

async function getConfig() {
    try {
        const r = await fetch(`${SERVER_URL}/api/config`);
        const d = await r.json();
        return d.config || {};
    } catch { return {}; }
}

// Chat streaming
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

    if (!resp.ok) throw new Error(await resp.text());

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
                if (content) {
                    // Strip any escape sequences from the content
                    const clean = content.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
                    if (clean) { onChunk(clean); full += clean; }
                }
            } catch { }
        }
    }
    return full;
}

// File ops
function readFile(fp) {
    try { return fs.readFileSync(path.resolve(projectPath, fp), 'utf-8'); }
    catch (e) { return `Error: ${e.message}`; }
}

function listFiles() {
    try {
        const items = fs.readdirSync(projectPath, { withFileTypes: true });
        const dirs = items.filter(i => i.isDirectory() && !i.name.startsWith('.') && i.name !== 'node_modules');
        const files = items.filter(i => i.isFile());
        return [...dirs.map(i => `  [dir]  ${i.name}/`), ...files.map(i => `  [file] ${i.name}`)].join('\n');
    } catch (e) { return `Error: ${e.message}`; }
}

// Banner
function showBanner(info, config, sessionId) {
    const provider = config.provider === 'custom' ? 'DeepSeek'
        : config.provider === 'openrouter' ? 'OpenRouter' : config.provider || 'Unknown';
    const model = config.custom_model || config.openrouter_model || config.ollama_model || 'default';
    const langs = [...info.languages].slice(0, 4).join(', ') || 'Unknown';

    console.log('');
    console.log('  +----------------------------------------------+');
    console.log('  |  EltonCodeBuff - Free AI Coding Assistant     |');
    console.log('  +----------------------------------------------+');
    console.log('');
    console.log(`  Provider:  ${provider} (${model})`);
    console.log(`  Project:   ${path.basename(projectPath)}`);
    console.log(`  Files:     ${info.files} files, ${info.dirs} dirs`);
    console.log(`  Languages: ${langs}`);
    if (info.keyFiles.length) console.log(`  Key files: ${info.keyFiles.join(', ')}`);
    console.log(`  Session:   ${sessionId}`);
    console.log('');
    console.log('  Type a message to chat. Use /help for commands.');
    console.log('');
}

// Main interactive chat
async function interactiveChat() {
    const config = await getConfig();
    const info = scanProject(projectPath);
    let messages = [];
    let sessionId;

    if (flags.cont) {
        const s = loadSession(flags.cont);
        if (s) { messages = s.messages; sessionId = s.id; console.log(`  Resumed session ${sessionId}`); }
        else { sessionId = genSessionId(); }
    } else {
        sessionId = genSessionId();
    }

    showBanner(info, config, sessionId);

    const systemPrompt = {
        role: 'system',
        content: `You are EltonCodeBuff, an expert AI coding assistant.
Project: ${path.basename(projectPath)} (${projectPath})
Languages: ${[...info.languages].join(', ') || 'Unknown'}
Key files: ${info.keyFiles.join(', ') || 'None'}
${info.files} files in ${info.dirs} directories.
Be concise. Format code with markdown code blocks. Show exact file paths for changes.`
    };

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const prompt = () => { process.stdout.write('  > '); };
    prompt();

    rl.on('line', async (line) => {
        const input = line.trim();
        if (!input) { prompt(); return; }

        if (input === '/help') {
            console.log('\n  Commands:');
            console.log('    /files        - List project files');
            console.log('    /read <path>  - Read a file into context');
            console.log('    /clear        - Clear chat history');
            console.log('    /save         - Save session');
            console.log('    /session      - Show session info');
            console.log('    /quit         - Exit\n');
            prompt(); return;
        }
        if (input === '/quit' || input === '/exit') {
            saveSession(sessionId, messages);
            console.log(`\n  Session saved. Resume: eltoncodebuff --continue ${sessionId}\n`);
            process.exit(0);
        }
        if (input === '/clear') { messages = []; console.log('  Chat cleared.\n'); prompt(); return; }
        if (input === '/files') { console.log('\n' + listFiles() + '\n'); prompt(); return; }
        if (input.startsWith('/read ')) {
            const fp = input.slice(6).trim();
            const content = readFile(fp);
            console.log(`  Read ${fp} (${content.length} chars)\n`);
            messages.push({ role: 'user', content: `File ${fp}:\n\`\`\`\n${content}\n\`\`\`` });
            messages.push({ role: 'assistant', content: `Read ${fp}. What next?` });
            prompt(); return;
        }
        if (input === '/save') {
            saveSession(sessionId, messages);
            console.log(`  Saved. Resume: eltoncodebuff --continue ${sessionId}\n`);
            prompt(); return;
        }
        if (input === '/session') {
            console.log(`\n  Session: ${sessionId}\n  Messages: ${messages.length}\n  Project: ${projectPath}\n`);
            prompt(); return;
        }

        messages.push({ role: 'user', content: input });

        try {
            process.stdout.write('\n  [EltonCodeBuff] ');
            const reply = await streamChat([systemPrompt, ...messages], (chunk) => {
                process.stdout.write(chunk);
            });
            console.log('\n');
            if (reply) {
                messages.push({ role: 'assistant', content: reply });
                if (messages.length % 10 === 0) saveSession(sessionId, messages);
            }
        } catch (err) {
            console.log(`\n  Error: ${err.message}\n`);
        }
        prompt();
    });

    rl.on('close', () => {
        if (messages.length) {
            saveSession(sessionId, messages);
            console.log(`\n  Session saved. Resume: eltoncodebuff --continue ${sessionId}\n`);
        }
        process.exit(0);
    });

    if (initialPrompt) {
        rl.emit('line', initialPrompt);
    }
}

function openBrowser(url) {
    spawn(process.platform === 'win32' ? 'start' : 'open', [url],
        { shell: true, detached: true, stdio: 'ignore' });
}

async function main() {
    await ensureServer();
    if (flags.web) { openBrowser(SERVER_URL); }
    else { await interactiveChat(); }
}

main();
