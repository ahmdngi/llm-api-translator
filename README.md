# LLM API Translator

A multi-format LLM API proxy that accepts **Anthropic Messages API** and **OpenAI Chat API** formats, translates them to a canonical internal representation, and forwards to any OpenAI-compatible backend (DeepSeek, Groq, Together, etc.). Responses are returned in the original input format.

```
┌─ Input Formats ─────────────────┐     ┌─ Forwarder ───────────┐
│                                 │     │                       │
│  Anthropic Messages API         │     │  Normalize → IR       │
│  POST /v1/messages              │────▶│  → OpenAI Chat format │
│                                 │     │  → DeepSeek/Groq/etc  │
│  OpenAI Chat API                │     │  → Denormalize back   │
│  POST /v1/chat/completions      │────▶│  to input format       │
│                                 │     │                       │
│  (Future: Gemini, etc.)         │     │                       │
└─────────────────────────────────┘     └───────────────────────┘
```

## Why?

Tools use different API formats — **Claude Code CLI** and **Cursor** speak Anthropic Messages API, while most SDKs and cost-effective providers (DeepSeek, Groq, Together) speak OpenAI Chat API. This proxy lets any client talk to any backend, no SDK changes needed.

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

### Anthropic format (Claude Code CLI, Cursor, etc.)

```bash
# Point Claude Code at the proxy
ANTHROPIC_BASE_URL=http://localhost:3800 claude -p "Hello from DeepSeek!"

# Or set the env var globally
export ANTHROPIC_BASE_URL=http://localhost:3800
```

### OpenAI format (any OpenAI-compatible SDK)

```bash
curl http://localhost:3800/v1/chat/completions \
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
| `/v1/messages` | POST | Anthropic Messages API → translated to OpenAI, forwarded, result translated back to Anthropic |
| `/v1/chat/completions` | POST | OpenAI Chat API → forwarded to DeepSeek (passthrough), result returned as OpenAI |
| `/v1/models` | GET | Returns format-appropriate model list |
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
| Streaming (SSE) | Anthropic event stream ↔ OpenAI SSE |
| `max_tokens`, `temperature` | Passed through |

To send Anthropic format but get OpenAI format back (or vice versa), set:
```bash
DEEPSEEK_RESPONSE_FORMAT=openai  # or 'anthropic'
```

## Roadmap

- [x] Anthropic Messages API ↔ OpenAI Chat API
- [x] OpenAI Chat API → DeepSeek (passthrough)
- [ ] Google Gemini API format
- [ ] Configurable model list via env
- [ ] Docker image
- [ ] Rate limiting / auth on inbound
- [ ] Streaming passthrough for OpenAI endpoint

## License

MIT
