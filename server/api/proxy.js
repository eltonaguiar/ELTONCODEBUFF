/**
 * ═══════════════════════════════════════════════════════════
 * OpenAI-Compatible Proxy API
 * ═══════════════════════════════════════════════════════════
 * 
 * This module exposes an OpenAI-compatible API at /v1/*
 * so that ANY tool expecting an OpenAI base URL can use it.
 * 
 * Point tools like Roo Code, Codebuff, Continue, Cody, etc. to:
 *   Base URL:  http://localhost:3777/v1
 *   API Key:   anything (or leave blank)
 * 
 * The proxy will forward requests to your configured provider
 * (OpenRouter, Ollama, or custom endpoint).
 */

import { getConfig } from '../config.js';

export function setupProxyRoutes(app) {

    // ── GET /v1/models ────────────────────────────────────────
    // Lists available models (OpenAI-compatible format)
    app.get('/v1/models', async (req, res) => {
        const config = getConfig();

        try {
            if (config.provider === 'openrouter') {
                const resp = await fetch('https://openrouter.ai/api/v1/models', {
                    headers: { 'Authorization': `Bearer ${config.openrouter_api_key}` },
                });
                const data = await resp.json();
                res.json(data);

            } else if (config.provider === 'ollama') {
                const base = config.ollama_base_url || 'http://localhost:11434';
                const resp = await fetch(`${base}/api/tags`);
                const data = await resp.json();
                // Convert Ollama format to OpenAI format
                const models = (data.models || []).map(m => ({
                    id: m.name,
                    object: 'model',
                    created: Math.floor(Date.now() / 1000),
                    owned_by: 'ollama',
                }));
                res.json({ object: 'list', data: models });

            } else if (config.provider === 'custom') {
                const base = config.custom_base_url;
                const headers = { 'Content-Type': 'application/json' };
                if (config.custom_api_key) headers['Authorization'] = `Bearer ${config.custom_api_key}`;
                const resp = await fetch(`${base}/models`, { headers });
                const data = await resp.json();
                res.json(data);

            } else {
                res.json({ object: 'list', data: [] });
            }
        } catch (err) {
            console.error('Proxy /v1/models error:', err.message);
            res.status(500).json({ error: { message: err.message, type: 'proxy_error' } });
        }
    });

    // ── POST /v1/chat/completions ─────────────────────────────
    // The main endpoint — proxies chat completions
    app.post('/v1/chat/completions', async (req, res) => {
        const config = getConfig();
        const body = req.body;
        const isStream = body.stream === true;
        const modelId = body.model || '';

        // Smart routing: detect if model is an Ollama model vs OpenRouter
        // Ollama models typically don't have a "/" or use patterns like "qwen2.5-coder:32b"
        // OpenRouter models always have "org/model" format
        const isOllamaModel = modelId && (
            !modelId.includes('/') ||  // No slash = likely Ollama (e.g. "codellama", "qwen2.5-coder:32b")
            modelId.startsWith('ollama/')  // Explicit ollama/ prefix
        );

        const routeTo = isOllamaModel ? 'ollama' : config.provider;

        console.log(`  🔀 Proxy: ${modelId || 'default'} | stream=${isStream} | msgs=${body.messages?.length || 0} | route=${routeTo}`);

        try {
            if (routeTo === 'ollama' || config.provider === 'ollama') {
                // Strip "ollama/" prefix if present
                if (body.model?.startsWith('ollama/')) {
                    body.model = body.model.replace('ollama/', '');
                }
                await proxyToOllama(req, res, config, body, isStream);
            } else if (routeTo === 'openrouter') {
                await proxyToOpenRouter(req, res, config, body, isStream);
            } else if (routeTo === 'custom') {
                await proxyToCustom(req, res, config, body, isStream);
            } else {
                res.status(503).json({
                    error: {
                        message: 'No provider configured. Visit http://localhost:3777 to set up.',
                        type: 'configuration_error',
                    },
                });
            }
        } catch (err) {
            console.error('Proxy /v1/chat/completions error:', err.message);
            if (!res.headersSent) {
                res.status(500).json({ error: { message: err.message, type: 'proxy_error' } });
            }
        }
    });

    // ── POST /v1/completions ──────────────────────────────────
    // Legacy completions endpoint (some tools still use this)
    app.post('/v1/completions', async (req, res) => {
        // Convert to chat format and forward
        const body = req.body;
        const chatBody = {
            ...body,
            messages: [{ role: 'user', content: body.prompt || '' }],
        };
        delete chatBody.prompt;
        req.body = chatBody;

        // Reuse the chat/completions handler
        const config = getConfig();
        const isStream = chatBody.stream === true;
        try {
            if (config.provider === 'openrouter') {
                await proxyToOpenRouter(req, res, config, chatBody, isStream);
            } else if (config.provider === 'ollama') {
                await proxyToOllama(req, res, config, chatBody, isStream);
            } else if (config.provider === 'custom') {
                await proxyToCustom(req, res, config, chatBody, isStream);
            } else {
                res.status(503).json({ error: { message: 'No provider configured.', type: 'configuration_error' } });
            }
        } catch (err) {
            if (!res.headersSent) {
                res.status(500).json({ error: { message: err.message, type: 'proxy_error' } });
            }
        }
    });

    // ── POST /v1/embeddings ───────────────────────────────────
    // Some tools request embeddings
    app.post('/v1/embeddings', async (req, res) => {
        const config = getConfig();
        try {
            if (config.provider === 'openrouter') {
                const resp = await fetch('https://openrouter.ai/api/v1/embeddings', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${config.openrouter_api_key}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(req.body),
                });
                const data = await resp.json();
                res.json(data);
            } else {
                res.status(501).json({ error: { message: 'Embeddings not supported for this provider', type: 'not_supported' } });
            }
        } catch (err) {
            res.status(500).json({ error: { message: err.message, type: 'proxy_error' } });
        }
    });

    console.log('  🔀 OpenAI-compatible proxy active at /v1/*');
}


// ═══════════════════════════════════════════════════════════
// PROVIDER PROXIES
// ═══════════════════════════════════════════════════════════

async function proxyToOpenRouter(req, res, config, body, isStream) {
    // Use model from request, fall back to configured default
    const model = body.model || config.openrouter_model || 'google/gemma-3n-e2b-it:free';

    const upstreamBody = {
        ...body,
        model,
    };

    const upstreamResp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${config.openrouter_api_key}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://github.com/eltonaguiar/ELTONCODEBUFF',
            'X-Title': 'EltonCodeBuff Proxy',
        },
        body: JSON.stringify(upstreamBody),
    });

    if (isStream) {
        // Stream SSE directly to client
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');

        const reader = upstreamResp.body.getReader();
        const decoder = new TextDecoder();

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value, { stream: true });
                res.write(chunk);
            }
        } catch (err) {
            console.error('Stream error:', err.message);
        } finally {
            res.end();
        }
    } else {
        // Non-streaming: return JSON directly
        const data = await upstreamResp.json();

        // Fix: Some models return empty content but have reasoning/thinking
        // Ensure there's always an assistant message with content
        if (data.choices && data.choices.length > 0) {
            const choice = data.choices[0];
            const msg = choice.message;
            if (msg && (!msg.content || msg.content.trim() === '')) {
                // Try to extract content from alternative fields
                msg.content = msg.reasoning || msg.thinking || msg.text || '(Model returned empty response. Try a different model.)';
                msg.role = msg.role || 'assistant';
            }
            if (!msg) {
                choice.message = { role: 'assistant', content: '(Model returned no message. Try a different model.)' };
            }
        }

        res.status(upstreamResp.status).json(data);
    }
}

async function proxyToOllama(req, res, config, body, isStream) {
    const base = config.ollama_base_url || 'http://localhost:11434';
    const model = body.model || config.ollama_model || 'codellama';

    // Build Ollama request — pass tools if provided
    const ollamaBody = {
        model,
        messages: body.messages,
        stream: isStream,
        options: {
            temperature: body.temperature ?? 0.3,
            num_predict: body.max_tokens ?? 4096,
            top_p: body.top_p,
        },
    };

    // Pass tools for function calling (Roo Code needs this)
    if (body.tools && body.tools.length > 0) {
        ollamaBody.tools = body.tools;
    }

    if (isStream) {
        const ollamaResp = await fetch(`${base}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(ollamaBody),
        });

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const reader = ollamaResp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const completionId = 'chatcmpl-' + Date.now();
        let sentRole = false;

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    try {
                        const ollamaMsg = JSON.parse(trimmed);

                        if (ollamaMsg.done) {
                            // Check if there are tool calls in the final message
                            if (ollamaMsg.message?.tool_calls && ollamaMsg.message.tool_calls.length > 0) {
                                const toolCalls = ollamaMsg.message.tool_calls.map((tc, i) => ({
                                    id: `call_${Date.now()}_${i}`,
                                    type: 'function',
                                    function: {
                                        name: tc.function.name,
                                        arguments: typeof tc.function.arguments === 'string'
                                            ? tc.function.arguments
                                            : JSON.stringify(tc.function.arguments),
                                    },
                                }));
                                const tcChunk = {
                                    id: completionId,
                                    object: 'chat.completion.chunk',
                                    created: Math.floor(Date.now() / 1000),
                                    model,
                                    choices: [{
                                        index: 0,
                                        delta: { role: 'assistant', tool_calls: toolCalls },
                                        finish_reason: null,
                                    }],
                                };
                                res.write(`data: ${JSON.stringify(tcChunk)}\n\n`);
                            }

                            const finalChunk = {
                                id: completionId,
                                object: 'chat.completion.chunk',
                                created: Math.floor(Date.now() / 1000),
                                model,
                                choices: [{
                                    index: 0,
                                    delta: {},
                                    finish_reason: ollamaMsg.message?.tool_calls ? 'tool_calls' : 'stop',
                                }],
                            };
                            res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
                            res.write('data: [DONE]\n\n');
                        } else if (ollamaMsg.message?.content) {
                            const delta = { content: ollamaMsg.message.content };
                            if (!sentRole) {
                                delta.role = 'assistant';
                                sentRole = true;
                            }
                            const chunk = {
                                id: completionId,
                                object: 'chat.completion.chunk',
                                created: Math.floor(Date.now() / 1000),
                                model,
                                choices: [{
                                    index: 0,
                                    delta,
                                    finish_reason: null,
                                }],
                            };
                            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                        } else if (ollamaMsg.message?.tool_calls) {
                            // Tool call mid-stream
                            const toolCalls = ollamaMsg.message.tool_calls.map((tc, i) => ({
                                id: `call_${Date.now()}_${i}`,
                                type: 'function',
                                function: {
                                    name: tc.function.name,
                                    arguments: typeof tc.function.arguments === 'string'
                                        ? tc.function.arguments
                                        : JSON.stringify(tc.function.arguments),
                                },
                            }));
                            const chunk = {
                                id: completionId,
                                object: 'chat.completion.chunk',
                                created: Math.floor(Date.now() / 1000),
                                model,
                                choices: [{
                                    index: 0,
                                    delta: { role: 'assistant', tool_calls: toolCalls },
                                    finish_reason: null,
                                }],
                            };
                            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                        }
                    } catch (e) {
                        // Skip malformed lines
                    }
                }
            }
        } catch (err) {
            console.error('Ollama stream error:', err.message);
        } finally {
            res.end();
        }
    } else {
        // Non-streaming
        const ollamaResp = await fetch(`${base}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(ollamaBody),
        });

        const ollamaData = await ollamaResp.json();

        // Build OpenAI-format message
        const message = {
            role: 'assistant',
            content: ollamaData.message?.content || null,
        };

        // Convert tool calls from Ollama format to OpenAI format
        if (ollamaData.message?.tool_calls && ollamaData.message.tool_calls.length > 0) {
            message.tool_calls = ollamaData.message.tool_calls.map((tc, i) => ({
                id: `call_${Date.now()}_${i}`,
                type: 'function',
                function: {
                    name: tc.function.name,
                    arguments: typeof tc.function.arguments === 'string'
                        ? tc.function.arguments
                        : JSON.stringify(tc.function.arguments),
                },
            }));
            if (!message.content) message.content = '';
        }

        // Ensure there's always content for Roo Code
        if (!message.content && !message.tool_calls) {
            message.content = '(Model returned empty response)';
        }

        const openaiResp = {
            id: 'chatcmpl-' + Date.now(),
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
                index: 0,
                message,
                finish_reason: message.tool_calls ? 'tool_calls' : 'stop',
            }],
            usage: {
                prompt_tokens: ollamaData.prompt_eval_count || 0,
                completion_tokens: ollamaData.eval_count || 0,
                total_tokens: (ollamaData.prompt_eval_count || 0) + (ollamaData.eval_count || 0),
            },
        };

        res.json(openaiResp);
    }
}

async function proxyToCustom(req, res, config, body, isStream) {
    const base = config.custom_base_url;
    const model = body.model || config.custom_model || 'default';

    const headers = { 'Content-Type': 'application/json' };
    if (config.custom_api_key) {
        headers['Authorization'] = `Bearer ${config.custom_api_key}`;
    }

    const upstreamResp = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...body, model }),
    });

    if (isStream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const reader = upstreamResp.body.getReader();
        const decoder = new TextDecoder();

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                res.write(decoder.decode(value, { stream: true }));
            }
        } catch (err) {
            console.error('Custom stream error:', err.message);
        } finally {
            res.end();
        }
    } else {
        const data = await upstreamResp.json();
        res.status(upstreamResp.status).json(data);
    }
}
