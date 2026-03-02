import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import open from 'open';
import { handleChatMessage } from './api/chat.js';
import { setupFileRoutes } from './api/files.js';
import { setupProxyRoutes } from './api/proxy.js';
import { loadConfig, saveConfig, getConfig } from './config.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(ROOT, 'public')));

// ── Config API ──────────────────────────────────────────────
app.get('/api/config', (req, res) => {
    const config = getConfig();
    // Don't leak full API key to frontend
    if (config.openrouter_api_key) {
        config.openrouter_api_key_masked =
            config.openrouter_api_key.slice(0, 8) + '...' + config.openrouter_api_key.slice(-4);
    }
    const safeConfig = { ...config };
    delete safeConfig.openrouter_api_key;
    res.json({ configured: !!config.provider, config: safeConfig });
});

app.post('/api/config', (req, res) => {
    try {
        saveConfig(req.body);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Models API ──────────────────────────────────────────────
app.get('/api/models', async (req, res) => {
    const config = getConfig();
    try {
        if (config.provider === 'openrouter') {
            const resp = await fetch('https://openrouter.ai/api/v1/models', {
                headers: {
                    'Authorization': `Bearer ${config.openrouter_api_key}`,
                },
            });
            const data = await resp.json();
            // Filter and sort: free models first, then by name
            const models = (data.data || []).map(m => ({
                id: m.id,
                name: m.name || m.id,
                context_length: m.context_length,
                pricing: m.pricing,
                isFree: m.pricing?.prompt === '0' && m.pricing?.completion === '0',
            })).sort((a, b) => {
                if (a.isFree && !b.isFree) return -1;
                if (!a.isFree && b.isFree) return 1;
                return a.name.localeCompare(b.name);
            });
            res.json({ models });
        } else if (config.provider === 'ollama') {
            const base = config.ollama_base_url || 'http://localhost:11434';
            const resp = await fetch(`${base}/api/tags`);
            const data = await resp.json();
            const models = (data.models || []).map(m => ({
                id: m.name,
                name: m.name,
                context_length: null,
                isFree: true,
            }));
            res.json({ models });
        } else {
            res.json({ models: [] });
        }
    } catch (err) {
        res.status(500).json({ error: err.message, models: [] });
    }
});

// ── File System API ─────────────────────────────────────────
setupFileRoutes(app);

// ── OpenAI-Compatible Proxy ─────────────────────────────────
// Tools like Roo Code, Codebuff, Continue, etc. can use:
//   Base URL: http://localhost:PORT/v1
//   API Key:  anything (not validated locally)
setupProxyRoutes(app);

// ── WebSocket for streaming chat ────────────────────────────
wss.on('connection', (ws) => {
    console.log('🔌 Client connected');

    ws.on('message', async (raw) => {
        try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === 'chat') {
                await handleChatMessage(ws, msg);
            }
        } catch (err) {
            ws.send(JSON.stringify({ type: 'error', content: err.message }));
        }
    });

    ws.on('close', () => {
        console.log('🔌 Client disconnected');
    });
});

// ── Fallback to index.html ──────────────────────────────────
app.get('*', (req, res) => {
    res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

// ── Start ───────────────────────────────────────────────────
const PORT = process.env.PORT || 3777;

loadConfig();

server.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    const proxyUrl = `${url}/v1`;
    console.log('');
    console.log('  ====================================================');
    console.log('  ||                                                  ||');
    console.log('  ||   [!] E L T O N C O D E B U F F [!]             ||');
    console.log('  ||                                                  ||');
    console.log('  ||   Free AI Coding Assistant                       ||');
    console.log('  ||   OpenRouter + Ollama + No Credits Needed        ||');
    console.log('  ||                                                  ||');
    console.log(`  ||   Web UI:  ${url.padEnd(37)}||`);
    console.log(`  ||   Proxy:   ${proxyUrl.padEnd(37)}||`);
    console.log('  ||                                                  ||');
    console.log('  ||   Use the Proxy URL as your OpenAI Base URL      ||');
    console.log('  ||   in Roo Code, Codebuff, Continue, Cody, etc.    ||');
    console.log('  ||                                                  ||');
    console.log('  ====================================================');
    console.log('');

    // Auto-open browser
    open(url).catch(() => { });
});
