# LLM API Translator

![llm-api-translator](translator-icon.png)

> **Multi-format LLM API proxy: accept Anthropic Messages API and OpenAI Chat API, forward to any OpenAI-compatible backend (DeepSeek, Groq, Together, etc.), return responses in the original format.**

- Version: **1.0.0**, published 25 May 2026.
- License: MIT
- Runtime: Node.js 18+

## Why

LLM tools speak different API formats. Claude Code and Cursor use Anthropic Messages API. Most cost-effective providers (DeepSeek, Groq, Together) use OpenAI Chat API. Instead of modifying SDKs or maintaining vendor-specific adapters, run this proxy — it translates between formats transparently.

Use cases:
- Run Claude Code against DeepSeek instead of Anthropic's API ($0 vs $100/mo)
- Point any OpenAI SDK at a cheaper backend without code changes
- Bridge Anthropic-format agents to OpenAI-compatible infrastructure
- Experiment with multiple backends by swapping a single environment variable

## Quick Start

```bash
git clone https://github.com/ahmdngi/llm-api-translator.git
cd llm-api-translator

# Set your API key
export DEEPSEEK_API_KEY="sk-..."

# Start the proxy
node translator-proxy.mjs
```

The proxy listens on `http://localhost:3800`.

## Usage

### Anthropic format (Claude Code, Cursor, etc.)

```bash
# One-shot
ANTHROPIC_BASE_URL=http://localhost:3800 claude -p "Hello from DeepSeek!"

# Or set globally
export ANTHROPIC_BASE_URL=http://localhost:3800
```

### OpenAI format (any OpenAI SDK)

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

### Force a different response format

By default, responses match the input format. Override with `DEEPSEEK_RESPONSE_FORMAT`:

```bash
# Send Anthropic format, get OpenAI format back
DEEPSEEK_RESPONSE_FORMAT=openai node translator-proxy.mjs
```

## Architecture

```
  ┌─ Input ─────────────┐    ┌─ Normalizer ─┐
  │ POST /v1/messages   │───▶│  Anthropic   │──┐
  │ (Anthropic format)  │    └──────────────┘  │
  └─────────────────────┘                      │
                                               │
  ┌─ Input ─────────────┐    ┌─ Normalizer ─┐  │
  │ POST /v1/chat/      │───▶│  OpenAI      │──┤
  │   completions       │    └──────────────┘  │
  │ (OpenAI format)     │                      │
  └─────────────────────┘                      │
                                               ▼
                                    ┌──────────────────┐
                                    │  Canonical IR    │
                                    │  (format-agnostic│
                                    │   message shape) │
                                    └────────┬─────────┘
                                             │
                                             ▼
                                    ┌──────────────────┐
                                    │  DeepSeek / Groq │
                                    │  Together / etc. │
                                    └────────┬─────────┘
                                             │
                                    ┌────────┴─────────┐
                                    │  Denormalizer    │
                                    │  (back to input  │
                                    │   format)        │
                                    └──────────────────┘
```

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/messages` | POST | Accept Anthropic Messages API, return Anthropic format |
| `/v1/chat/completions` | POST | Accept OpenAI Chat API, return OpenAI format |
| `/v1/models` | GET | List models (format-appropriate names) |
| `/health` | GET | Upstream status and config |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DEEPSEEK_API_KEY` or `ANTHROPIC_API_KEY` | — | API key for the upstream provider |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | OpenAI-compatible API base URL |
| `OPENAI_MODEL` | `deepseek-chat` | Model name sent to upstream |
| `PROXY_PORT` | `3800` | Listen port |
| `DEEPSEEK_RESPONSE_FORMAT` | *(auto)* | Override: `openai` or `anthropic` |
| `PROXY_DEBUG` | — | Enable debug logging to stderr |

### Provider examples

**Route to Groq:**
```bash
DEEPSEEK_BASE_URL=https://api.groq.com/openai \
DEEPSEEK_API_KEY="gsk-..." \
OPENAI_MODEL="llama-3.3-70b-versatile" \
node translator-proxy.mjs
```

**Route to Together:**
```bash
DEEPSEEK_BASE_URL=https://api.together.xyz/v1 \
DEEPSEEK_API_KEY="..." \
OPENAI_MODEL="mistralai/Mixtral-8x22B-Instruct-v0.1" \
node translator-proxy.mjs
```

## Translation Reference

| Anthropic (inbound) | OpenAI (outbound) |
|---------------------|-------------------|
| `system` string or block | `messages[0].role="system"` |
| `messages[].content` blocks | Flat string or tool role |
| `tools[].input_schema` | `function.parameters` |
| `tool_choice` auto/any/tool | `tool_choice` auto/required/function |
| `tool_use` response block | `tool_calls` in choice |
| `tool_result` in user message | `role: "tool"` message |
| SSE stream | Anthropic events ↔ OpenAI SSE |

## Roadmap

- [x] Anthropic Messages API ↔ OpenAI Chat API
- [x] Bidirectional (any input → any output format)
- [ ] Google Gemini API format
- [ ] Configurable model list via env
- [ ] Docker image
- [ ] Rate limiting / auth on inbound

## License

MIT
