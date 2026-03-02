/**
 * ═══════════════════════════════════════════════════════════
 * Model Health Check / Auto-Detection
 * ═══════════════════════════════════════════════════════════
 * 
 * Tests free models with a quick "hi" message to detect
 * which ones are actually responding vs rate-limited/broken.
 */

import { getConfig } from '../config.js';
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RESULTS_PATH = path.resolve(__dirname, '..', '..', 'eltoncodebuff-models.json');

// Cache results
let cachedResults = null;
let cacheTimestamp = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// Load previous results from disk on startup
try {
    if (fs.existsSync(RESULTS_PATH)) {
        const saved = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf-8'));
        cachedResults = saved.models;
        cacheTimestamp = saved.testedAt || 0;
        const working = cachedResults.filter(m => m.status === 'working').length;
        console.log(`  🧪 Loaded ${working} working models from previous scan`);
    }
} catch { }

export function setupHealthRoutes(app) {

    // GET /api/health/models — returns cached results or triggers fresh test
    app.get('/api/health/models', async (req, res) => {
        const forceRefresh = req.query.refresh === 'true';
        const now = Date.now();

        if (!forceRefresh && cachedResults && (now - cacheTimestamp) < CACHE_TTL) {
            return res.json({ models: cachedResults, cached: true, testedAt: cacheTimestamp });
        }

        const config = getConfig();
        if (config.provider !== 'openrouter') {
            // For Ollama/custom, just check if the endpoint is reachable
            try {
                const base = config.provider === 'ollama'
                    ? (config.ollama_base_url || 'http://localhost:11434')
                    : config.custom_base_url;
                const resp = await fetch(config.provider === 'ollama' ? `${base}/api/tags` : `${base}/models`);
                if (resp.ok) {
                    return res.json({ models: [{ id: config.ollama_model || 'default', status: 'working', latency: 0 }], cached: false });
                }
            } catch (err) {
                return res.json({ models: [{ id: 'endpoint', status: 'error', error: err.message }], cached: false });
            }
        }

        // OpenRouter — fetch free models and test them
        res.json({ models: [], testing: true, message: 'Test started. Poll /api/health/models for results.' });

        // Run tests in background (don't block the response)
        testFreeModels(config).then(results => {
            cachedResults = results;
            cacheTimestamp = Date.now();
        });
    });

    // POST /api/health/test — run tests now, wait for results
    app.post('/api/health/test', async (req, res) => {
        const config = getConfig();

        if (config.provider !== 'openrouter') {
            return res.json({ models: [{ id: config.ollama_model || config.custom_model || 'default', status: 'working' }] });
        }

        try {
            console.log('  🧪 Starting model health check...');
            const results = await testFreeModels(config);
            cachedResults = results;
            cacheTimestamp = Date.now();
            // Persist to disk
            try { fs.writeFileSync(RESULTS_PATH, JSON.stringify({ models: results, testedAt: cacheTimestamp }, null, 2)); } catch { }
            console.log(`  🧪 Health check complete: ${results.filter(r => r.status === 'working').length}/${results.length} models working`);
            res.json({ models: results, cached: false, testedAt: cacheTimestamp });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // GET /api/health/working — plain text list of working model IDs (easy copy-paste)
    app.get('/api/health/working', (req, res) => {
        if (!cachedResults) {
            return res.type('text').send('No scan results yet. Run a test first via POST /api/health/test');
        }
        const working = cachedResults.filter(m => m.status === 'working');
        const lines = working.map(m => m.id);
        const timestamp = new Date(cacheTimestamp).toLocaleString();
        res.type('text').send(`# Working Free Models (scanned: ${timestamp})\n# ${working.length} models available\n\n${lines.join('\n')}\n`);
    });

    console.log('  🧪 Model health check active at /api/health/*');
}

async function testFreeModels(config) {
    // First get the list of free models
    let freeModels = [];
    try {
        const resp = await fetch('https://openrouter.ai/api/v1/models', {
            headers: { 'Authorization': `Bearer ${config.openrouter_api_key}` },
        });
        const data = await resp.json();
        freeModels = (data.data || [])
            .filter(m => m.pricing?.prompt === '0' && m.pricing?.completion === '0')
            .map(m => ({ id: m.id, name: m.name || m.id }));
    } catch (err) {
        return [{ id: 'error', status: 'error', error: 'Failed to fetch models: ' + err.message }];
    }

    if (freeModels.length === 0) {
        return [{ id: 'none', status: 'error', error: 'No free models found' }];
    }

    console.log(`  🧪 Testing ${freeModels.length} free models...`);

    // Test models in batches of 5 to avoid overwhelming
    const BATCH_SIZE = 5;
    const results = [];

    for (let i = 0; i < freeModels.length; i += BATCH_SIZE) {
        const batch = freeModels.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(
            batch.map(model => testSingleModel(model, config))
        );
        results.push(...batchResults);

        // Brief pause between batches
        if (i + BATCH_SIZE < freeModels.length) {
            await new Promise(r => setTimeout(r, 500));
        }
    }

    // Sort: working first (fastest first), then errors
    results.sort((a, b) => {
        if (a.status === 'working' && b.status !== 'working') return -1;
        if (a.status !== 'working' && b.status === 'working') return 1;
        if (a.status === 'working' && b.status === 'working') return a.latency - b.latency;
        return 0;
    });

    return results;
}

async function testSingleModel(model, config) {
    const start = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000); // 15s timeout

    try {
        const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${config.openrouter_api_key}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://github.com/eltonaguiar/ELTONCODEBUFF',
                'X-Title': 'EltonCodeBuff HealthCheck',
            },
            body: JSON.stringify({
                model: model.id,
                messages: [{ role: 'user', content: 'Reply with only the word: pong' }],
                max_tokens: 10,
                temperature: 0,
                stream: false,
            }),
            signal: controller.signal,
        });

        clearTimeout(timeout);
        const latency = Date.now() - start;

        if (!resp.ok) {
            const errBody = await resp.text();
            let errorMsg = `HTTP ${resp.status}`;
            try {
                const parsed = JSON.parse(errBody);
                errorMsg = parsed.error?.message || errorMsg;
            } catch { }
            return { id: model.id, name: model.name, status: 'error', error: errorMsg, latency };
        }

        const data = await resp.json();
        const content = data.choices?.[0]?.message?.content || '';

        if (content.length > 0) {
            return { id: model.id, name: model.name, status: 'working', latency, preview: content.substring(0, 50) };
        } else {
            return { id: model.id, name: model.name, status: 'error', error: 'Empty response', latency };
        }
    } catch (err) {
        clearTimeout(timeout);
        const latency = Date.now() - start;
        const errorMsg = err.name === 'AbortError' ? 'Timeout (15s)' : err.message;
        return { id: model.id, name: model.name, status: 'error', error: errorMsg, latency };
    }
}
