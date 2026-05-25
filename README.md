# LLM API Translator

A lightweight proxy that translates between LLM API formats. Currently supports **Anthropic Messages API → OpenAI Chat API** translation, letting you route Anthropic-format clients through any OpenAI-compatible backend.

```
Claude Code / Cursor / etc.        Your provider
     (Anthropic format)               (OpenAI format)
           │                              ▲
           ▼                              │
    ┌──────────────┐        ┌──────────────────────┐
    │  POST /v1/   │ ──────▶│  POST /v1/chat/      │
    │  messages    │        │  completions          │
    └──────────────┘        └──────────────────────┘
                                   │
                          ┌────────┴────────┐
                          │ DeepSeek / Groq │
                          │ Together / etc. │
                          └─────────────────┘
```

## Why?

The Anthropic Messages API is used by tools like **Claude Code CLI**, **Cursor**, and various AI agents. But many cost-effective providers (DeepSeek, Groq, Together, etc.) only support the OpenAI Chat API format. This proxy bridges the gap — no SDK changes needed.

## Quick Start

```bash
# Clone and install
git clone https://github.com/ahmdngi/llm-api-translator.git
cd llm-api-translator

# Set your API key
export DEEPSEEK_API_KEY="sk-..."

# Start the proxy
node translator-proxy.mjs
```

The proxy starts on `http://localhost:3800`.

## Usage

### With Claude Code CLI

```bash
# Point Claude Code at the proxy
ANTHROPIC_BASE_URL=http://localhost:3800 claude -p "Hello from DeepSeek!"
```

### With any Anthropic-format client

```bash
# Just set ANTHROPIC_BASE_URL to the proxy address
export ANTHROPIC_BASE_URL=http://localhost:3800
```

### Direct API call

```bash
curl http://localhost:3800/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: sk-your-key" \
  -d '{
    "model": "deepseek-chat",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

## Configuration

All settings via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `DEEPSEEK_API_KEY` or `ANTHROPIC_API_KEY` | — | Your API key for the upstream provider |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | Upstream OpenAI-compatible API base URL |
| `OPENAI_MODEL` | `deepseek-chat` | Model name to forward to upstream |
| `PROXY_PORT` | `3800` | Port the proxy listens on |
| `PROXY_DEBUG` | — | Set to anything to enable debug logging to stderr |

### Example: Route to Groq

```bash
export DEEPSEEK_BASE_URL=https://api.groq.com/openai
export DEEPSEEK_API_KEY="gsk-..."
export OPENAI_MODEL="llama-3.3-70b-versatile"
node translator-proxy.mjs
```

### Example: Route to Together

```bash
export DEEPSEEK_BASE_URL=https://api.together.xyz/v1
export DEEPSEEK_API_KEY="..."
export OPENAI_MODEL="mistralai/Mixtral-8x22B-Instruct-v0.1"
node translator-proxy.mjs
```

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/messages` | POST | Anthropic Messages API → translated to OpenAI, forwarded, result translated back |
| `/v1/models` | GET | Returns a list of available models (configurable in code) |
| `/health` | GET | Health check showing upstream and current model config |

## What's translated

| Anthropic (inbound) | OpenAI (outbound) |
|---------------------|-------------------|
| `system` → `messages[0].role="system"` | System message |
| `messages[]` (user/assistant) | Role mapping + content extraction |
| `tools[]` (name, description, input_schema) | `functions[]` style |
| `tool_choice` (auto/any/tool) | `tool_choice` mapping |
| `tool_use` in assistant response | `tool_calls` in response |
| `tool_result` in user messages | `tool` role messages |
| Streaming (SSE) | Anthropic event stream → OpenAI SSE and back |
| `max_tokens`, `temperature` | Passed through |

## Roadmap

- [ ] Bidirectional (OpenAI → Anthropic)
- [ ] Google Gemini API format
- [ ] Configurable model list via env
- [ ] Docker image
- [ ] Rate limiting / auth on inbound

## License

MIT
