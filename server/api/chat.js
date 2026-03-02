import { getConfig } from '../config.js';

const SYSTEM_PROMPT = `You are EltonCodeBuff, a powerful AI coding assistant. You help developers write, debug, refactor, and understand code.

Your capabilities:
- Read and understand entire codebases
- Write new code and modify existing files
- Debug issues and suggest fixes
- Explain complex code patterns
- Suggest architectural improvements

When the user provides file contents or asks about files, analyze them carefully and provide precise, actionable responses.

When suggesting code changes, use clear markdown code blocks with the language identifier. If suggesting edits to an existing file, show the complete modified section, not just snippets.

Be concise but thorough. Prefer practical, working solutions over theoretical discussions.

You are powered by open-source AI models through OpenRouter or Ollama — completely free, no credits needed.`;

/**
 * Stream a chat response via WebSocket
 */
export async function handleChatMessage(ws, msg) {
    const config = getConfig();
    const { messages, projectPath } = msg;

    if (!config.provider) {
        ws.send(JSON.stringify({ type: 'error', content: 'Not configured. Please set up your provider in Settings.' }));
        return;
    }

    // Build the full messages array with system prompt
    const fullMessages = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...messages,
    ];

    try {
        if (config.provider === 'openrouter') {
            await streamOpenRouter(ws, fullMessages, config);
        } else if (config.provider === 'ollama') {
            await streamOllama(ws, fullMessages, config);
        } else if (config.provider === 'custom') {
            await streamCustom(ws, fullMessages, config);
        }
    } catch (err) {
        console.error('Chat error:', err);
        ws.send(JSON.stringify({ type: 'error', content: `API Error: ${err.message}` }));
    }
}

async function streamOpenRouter(ws, messages, config) {
    const model = config.openrouter_model || 'meta-llama/llama-4-maverick:free';
    const apiKey = config.openrouter_api_key;

    if (!apiKey) {
        ws.send(JSON.stringify({ type: 'error', content: 'OpenRouter API key not set. Go to Settings.' }));
        return;
    }

    ws.send(JSON.stringify({ type: 'start', model }));

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://github.com/eltonaguiar/ELTONCODEBUFF',
            'X-Title': 'EltonCodeBuff',
        },
        body: JSON.stringify({
            model,
            messages,
            stream: true,
            temperature: 0.3,
            max_tokens: 8192,
        }),
    });

    if (!response.ok) {
        const errorData = await response.text();
        throw new Error(`OpenRouter ${response.status}: ${errorData}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) continue;
            const data = trimmed.slice(6);
            if (data === '[DONE]') {
                ws.send(JSON.stringify({ type: 'done' }));
                return;
            }
            try {
                const parsed = JSON.parse(data);
                const content = parsed.choices?.[0]?.delta?.content;
                if (content) {
                    ws.send(JSON.stringify({ type: 'chunk', content }));
                }
            } catch (e) {
                // Skip malformed JSON
            }
        }
    }

    ws.send(JSON.stringify({ type: 'done' }));
}

async function streamOllama(ws, messages, config) {
    const model = config.ollama_model || 'codellama';
    const baseUrl = config.ollama_base_url || 'http://localhost:11434';

    ws.send(JSON.stringify({ type: 'start', model }));

    const response = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model,
            messages,
            stream: true,
        }),
    });

    if (!response.ok) {
        const errorData = await response.text();
        throw new Error(`Ollama ${response.status}: ${errorData}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

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
                const parsed = JSON.parse(trimmed);
                if (parsed.done) {
                    ws.send(JSON.stringify({ type: 'done' }));
                    return;
                }
                const content = parsed.message?.content;
                if (content) {
                    ws.send(JSON.stringify({ type: 'chunk', content }));
                }
            } catch (e) {
                // Skip malformed lines
            }
        }
    }

    ws.send(JSON.stringify({ type: 'done' }));
}

async function streamCustom(ws, messages, config) {
    const model = config.custom_model || 'default';
    const baseUrl = config.custom_base_url;
    const apiKey = config.custom_api_key;

    if (!baseUrl) {
        ws.send(JSON.stringify({ type: 'error', content: 'Custom API base URL not set.' }));
        return;
    }

    ws.send(JSON.stringify({ type: 'start', model }));

    const headers = {
        'Content-Type': 'application/json',
    };
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            model,
            messages,
            stream: true,
            temperature: 0.3,
        }),
    });

    if (!response.ok) {
        const errorData = await response.text();
        throw new Error(`Custom API ${response.status}: ${errorData}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) continue;
            const data = trimmed.slice(6);
            if (data === '[DONE]') {
                ws.send(JSON.stringify({ type: 'done' }));
                return;
            }
            try {
                const parsed = JSON.parse(data);
                const content = parsed.choices?.[0]?.delta?.content;
                if (content) {
                    ws.send(JSON.stringify({ type: 'chunk', content }));
                }
            } catch (e) {
                // Skip malformed JSON
            }
        }
    }

    ws.send(JSON.stringify({ type: 'done' }));
}
