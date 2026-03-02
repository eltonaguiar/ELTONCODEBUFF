# ⚡ EltonCodeBuff

A **free, open-source AI coding assistant** with a beautiful web GUI and an **OpenAI-compatible proxy server**. Use it with OpenRouter (100+ free models), local Ollama, or any OpenAI-compatible endpoint — **no credits needed**.

Inspired by [Codebuff](https://github.com/CodebuffAI/codebuff) (Apache-2.0), but with direct provider access so you never pay for credits.

---

## 🚀 Quick Start

```bash
# 1. Clone
git clone https://github.com/eltonaguiar/ELTONCODEBUFF.git
cd ELTONCODEBUFF

# 2. Install
npm install

# 3. Run
npm start
```

Your browser will open automatically. Follow the setup wizard to configure your provider.

---

## 🎯 Two Ways to Use

### 1. Web Chat Interface
Open **http://localhost:3777** in your browser for a premium chat-based coding assistant with:
- 💬 Streaming chat interface with markdown rendering
- 📁 Built-in file explorer & code viewer
- 🔍 File content search
- 📎 File attachment for context
- ⚙️ Visual settings panel
- 🎨 Beautiful dark theme

### 2. OpenAI-Compatible Proxy (for Roo Code, Codebuff, etc.)
Point **any tool** that accepts an OpenAI base URL to:

```
Base URL:  http://localhost:3777/v1
API Key:   anything (e.g., "sk-placeholder")
```

This works with:
- **Roo Code** (VS Code extension)
- **Codebuff** CLI
- **Continue** (VS Code/JetBrains)
- **Cody** by Sourcegraph
- **Cursor** (custom API)
- **LM Studio** clients
- Any OpenAI-compatible tool

The proxy translates requests to your configured provider (OpenRouter/Ollama/Custom) and streams responses back in OpenAI format.

---

## 🔧 Supported Providers

### OpenRouter (Recommended)
Access 100+ AI models. Many are completely free:

| Model | Free? | Quality |
|-------|-------|---------|
| Google Gemini 2.0 Flash | ✅ Free | Excellent |
| Google Gemma 3 27B | ✅ Free | Great |
| DeepSeek V3 | ✅ Free | Excellent |
| Llama 3.3 70B | ✅ Free | Great |
| Qwen 2.5 Coder 32B | ✅ Free | Best for code |
| Mistral Small 3.1 | ✅ Free | Good |

Get your free API key at: https://openrouter.ai/keys

### Ollama (Local/Private)
Run models on your own machine. No internet needed.

```bash
# Install Ollama: https://ollama.ai
ollama pull codellama
ollama pull deepseek-coder:6.7b
```

### Custom Endpoints
Any OpenAI-compatible API: LM Studio, vLLM, text-generation-webui, etc.

---

## 🔀 Proxy Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/models` | GET | List available models |
| `/v1/chat/completions` | POST | Chat completions (streaming + non-streaming) |
| `/v1/completions` | POST | Legacy completions |
| `/v1/embeddings` | POST | Embeddings (OpenRouter only) |

### Example: Using with Roo Code

1. Start EltonCodeBuff: `npm start`
2. In VS Code, install Roo Code
3. Go to Roo Code settings → API Provider → "OpenAI Compatible"
4. Set Base URL: `http://localhost:3777/v1`
5. Set API Key: `anything` (it's not validated locally)
6. Set Model: any model ID from your provider (e.g., `google/gemini-2.0-flash-exp:free`)

### Example: Using with curl

```bash
# Non-streaming
curl http://localhost:3777/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "google/gemini-2.0-flash-exp:free",
    "messages": [{"role": "user", "content": "Write a hello world in Python"}]
  }'

# Streaming
curl http://localhost:3777/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "google/gemini-2.0-flash-exp:free",
    "messages": [{"role": "user", "content": "Explain async/await"}],
    "stream": true
  }'
```

---

## 📁 Project Structure

```
ELTONCODEBUFF/
├── package.json
├── server/
│   ├── index.js              # Express + WebSocket server
│   ├── config.js             # Configuration management
│   └── api/
│       ├── chat.js           # Chat handler (WebSocket streaming)
│       ├── files.js          # File system operations
│       └── proxy.js          # OpenAI-compatible proxy (/v1/*)
├── public/
│   ├── index.html            # Main app (wizard + chat + explorer)
│   ├── css/style.css         # Premium dark theme
│   └── js/
│       ├── app.js            # Frontend logic
│       └── marked.min.js     # Markdown renderer
├── .env.example
├── .gitignore
├── LICENSE
└── README.md
```

---

## ⚙️ Configuration

Configuration is stored in `eltoncodebuff-config.json` (auto-created). You can also use `.env`:

```env
PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-v1-xxxxxxxxxxxx
OPENROUTER_MODEL=google/gemini-2.0-flash-exp:free
PORT=3777
```

---

## 📜 License

MIT — see [LICENSE](LICENSE).

Original Codebuff project: [CodebuffAI/codebuff](https://github.com/CodebuffAI/codebuff) (Apache-2.0). This is an independent implementation, not a fork.

---

## 🙏 Credits

- [Codebuff](https://github.com/CodebuffAI/codebuff) — inspiration and concepts
- [OpenRouter](https://openrouter.ai) — unified access to AI models
- [Ollama](https://ollama.ai) — local model hosting
- Built with ❤️ by Elton Aguiar
