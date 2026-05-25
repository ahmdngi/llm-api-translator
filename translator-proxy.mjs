#!/usr/bin/env node
/**
 * LLM API Translator — Multi-Format LLM API proxy
 *
 * Accepts multiple input formats (Anthropic Messages API, OpenAI Chat API),
 * normalizes to a canonical internal representation, forwards to any
 * OpenAI-compatible backend (DeepSeek, Groq, Together, etc.), and returns
 * the response in the original input format.
 *
 * Usage:
 *   # Anthropic format client (Claude Code, Cursor, etc.)
 *   ANTHROPIC_BASE_URL=http://localhost:3800 claude -p "Hello"
 *
 *   # OpenAI format client (any OpenAI-compatible SDK)
 *   curl http://localhost:3800/v1/chat/completions \
 *     -H "Content-Type: application/json" \
 *     -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"Hi"}]}'
 *
 * Configuration via environment variables:
 *   DEEPSEEK_API_KEY (or ANTHROPIC_API_KEY) — API key for upstream provider
 *   DEEPSEEK_BASE_URL  — Upstream base URL (default: https://api.deepseek.com)
 *   OPENAI_MODEL       — Model name to forward (default: deepseek-chat)
 *   PROXY_PORT         — Listen port (default: 3800)
 *   PROXY_DEBUG        — Enable debug logging to stderr
 *   DEEPSEEK_RESPONSE_FORMAT — Override response format (anthropic|openai)
 */
import http from 'node:http';
import https from 'node:https';

const PORT = parseInt(process.env.PROXY_PORT || '3800', 10);
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'deepseek-chat';
const API_KEY = process.env.ANTHROPIC_API_KEY || process.env.DEEPSEEK_API_KEY || '';
const RESPONSE_FORMAT = (process.env.DEEPSEEK_RESPONSE_FORMAT || '').toLowerCase();

function log(...args) {
  if (process.env.PROXY_DEBUG) console.error('[proxy]', ...args);
}

// ──────────────────────────────────────────────
// HTTP helpers
// ──────────────────────────────────────────────

function apiReq(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(DEEPSEEK_BASE_URL);
    const port = u.protocol === 'https:' ? 443 : 80;
    const opts = {
      hostname: u.hostname,
      port: u.port || port,
      path,
      method,
      headers,
      rejectUnauthorized: true,
    };
    const mod = u.protocol === 'https:' ? https : http;
    const r = mod.request(opts, resolve);
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

function collectStream(stream) {
  return new Promise((resolve) => {
    const chunks = [];
    stream.on('data', (d) => chunks.push(d));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

// ──────────────────────────────────────────────
// Canonical Internal Representation (IR)
//
// All input formats normalize to this shape:
// {
//   model: string,           // upstream model name
//   system: string,          // system prompt (optional)
//   messages: [{             // conversation history
//     role: 'user'|'assistant'|'tool',
//     content: string,
//     tool_call_id?: string  // for tool role
//   }],
//   tools: [{                // tool definitions (optional)
//     type: 'function',
//     function: { name, description, parameters }
//   }],
//   tool_choice: 'auto'|'required'|{type:'function',function:{name}},
//   max_tokens: number,
//   temperature: number,
//   stream: boolean,
//   _inputFormat: 'anthropic'|'openai'  // tracks original format for response
// }
// ──────────────────────────────────────────────

// ── Anthropic Messages API → IR ──

function normalizeAnthropic(body) {
  const ir = {
    model: body.model?.startsWith('claude-') ? DEFAULT_MODEL : (body.model || DEFAULT_MODEL),
    system: '',
    messages: [],
    tools: [],
    tool_choice: undefined,
    max_tokens: body.max_tokens,
    temperature: body.temperature ?? 0,
    stream: body.stream === true,
    _inputFormat: 'anthropic',
  };

  // System prompt
  if (body.system) {
    ir.system = typeof body.system === 'string'
      ? body.system
      : body.system.map((b) => b.text).join('');
  }

  // Messages
  for (const m of body.messages || []) {
    if (m.role === 'user') {
      const content = Array.isArray(m.content) ? m.content : [m.content];
      const toolResults = content.filter((b) => b.type === 'tool_result');
      const textBlocks = content.filter((b) => b.type === 'text');

      if (toolResults.length > 0) {
        for (const b of toolResults) {
          const txt = typeof b.content === 'string'
            ? b.content
            : b.content?.filter((x) => x.type === 'text').map((x) => x.text).join('') || '';
          ir.messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: txt });
        }
      } else {
        ir.messages.push({
          role: 'user',
          content: textBlocks.map((b) => b.text).join('') || (typeof m.content === 'string' ? m.content : ''),
        });
      }
    } else if (m.role === 'assistant') {
      const content = Array.isArray(m.content) ? m.content : [];
      const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const toolUses = content.filter((b) => b.type === 'tool_use');

      if (toolUses.length > 0) {
        ir.messages.push({
          role: 'assistant',
          content: text || null,
          tool_calls: toolUses.map((b) => ({
            id: b.id,
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input) },
          })),
        });
      } else {
        ir.messages.push({ role: 'assistant', content: text });
      }
    }
  }

  // Tools
  if (body.tools) {
    ir.tools = body.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  }

  // Tool choice
  if (body.tool_choice) {
    ir.tool_choice =
      body.tool_choice.type === 'auto' ? 'auto'
        : body.tool_choice.type === 'any' ? 'required'
          : body.tool_choice.type === 'tool'
            ? { type: 'function', function: { name: body.tool_choice.name } }
            : undefined;
  }

  return ir;
}

// ── OpenAI Chat API → IR ──

function normalizeOpenAI(body) {
  const ir = {
    model: body.model || DEFAULT_MODEL,
    system: '',
    messages: [],
    tools: body.tools || [],
    tool_choice: body.tool_choice,
    max_tokens: body.max_tokens,
    temperature: body.temperature ?? 0,
    stream: body.stream === true,
    _inputFormat: 'openai',
  };

  for (const m of body.messages || []) {
    if (m.role === 'system') {
      ir.system = m.content;
    } else if (m.role === 'user' || m.role === 'assistant' || m.role === 'tool') {
      const entry = { role: m.role, content: m.content };
      if (m.tool_call_id) entry.tool_call_id = m.tool_call_id;
      if (m.tool_calls) entry.tool_calls = m.tool_calls;
      ir.messages.push(entry);
    }
  }

  return ir;
}

// ── Router: detect input format and normalize ──

function normalizeRequest(data, pathname) {
  if (pathname === '/v1/messages') {
    return normalizeAnthropic(data);
  }
  // Default to OpenAI for /v1/chat/completions or any unknown path
  return normalizeOpenAI(data);
}

// ── IR → DeepSeek (OpenAI Chat format) ──

function irToOpenAIRequest(ir) {
  const msgs = [];

  if (ir.system) {
    msgs.push({ role: 'system', content: ir.system });
  }

  for (const m of ir.messages) {
    if (m.role === 'tool') {
      msgs.push({ role: 'tool', tool_call_id: m.tool_call_id, content: m.content });
    } else {
      const entry = { role: m.role };
      if (m.tool_calls) {
        entry.content = m.content;
        entry.tool_calls = m.tool_calls;
      } else {
        entry.content = m.content || '';
      }
      msgs.push(entry);
    }
  }

  const out = {
    model: ir.model,
    messages: msgs,
    max_tokens: ir.max_tokens,
    stream: ir.stream,
    temperature: ir.temperature,
  };

  if (ir.tools && ir.tools.length > 0) out.tools = ir.tools;
  if (ir.tool_choice) out.tool_choice = ir.tool_choice;

  Object.keys(out).forEach((k) => out[k] === undefined && delete out[k]);
  return out;
}

// ──────────────────────────────────────────────
// Response denormalizers: DeepSeek response → input format
// ──────────────────────────────────────────────

// DeepSeek response → Anthropic Messages API (non-streaming)

function denormalizeToAnthropic(chatResp, origModel) {
  const c = chatResp.choices?.[0];
  const content = [];
  if (c?.message?.content) content.push({ type: 'text', text: c.message.content });
  for (const tc of c?.message?.tool_calls || []) {
    content.push({
      type: 'tool_use',
      id: tc.id,
      name: tc.function.name,
      input: JSON.parse(tc.function.arguments || '{}'),
    });
  }
  return {
    id: `msg_${chatResp.id || Date.now().toString(36)}`,
    type: 'message',
    role: 'assistant',
    content,
    model: origModel || DEFAULT_MODEL,
    stop_reason:
      c?.finish_reason === 'stop' ? 'end_turn'
        : c?.finish_reason === 'tool_calls' ? 'tool_use'
          : c?.finish_reason === 'length' ? 'max_tokens'
            : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: chatResp.usage?.prompt_tokens || 0,
      output_tokens: chatResp.usage?.completion_tokens || 0,
    },
  };
}

// DeepSeek response → OpenAI Chat API (non-streaming)

function denormalizeToOpenAI(chatResp, origModel) {
  return chatResp; // Already OpenAI format — passthrough
}

// ── Router: denormalize based on input format ──

function denormalizeResponse(chatResp, origModel, inputFormat) {
  const fmt = RESPONSE_FORMAT || inputFormat;
  if (fmt === 'anthropic') return denormalizeToAnthropic(chatResp, origModel);
  return denormalizeToOpenAI(chatResp, origModel);
}

// ──────────────────────────────────────────────
// SSE streaming: OpenAI SSE → format-specific event stream
// ──────────────────────────────────────────────

async function* parseSSE(res) {
  let buf = '';
  for await (const chunk of res) {
    buf += chunk.toString();
    const parts = buf.split('\n');
    buf = parts.pop() || '';
    for (const line of parts) {
      const t = line.trim();
      if (!t || t === 'data: [DONE]') continue;
      if (t.startsWith('data: ')) {
        try { yield JSON.parse(t.slice(6)); } catch { /* skip malformed */ }
      }
    }
  }
}

async function* streamAnthropicEvents(res, origModel) {
  const model = origModel || DEFAULT_MODEL;
  const id = `msg_${Date.now().toString(36)}`;
  let started = false, finished = false, inText = false;
  const toolArgs = new Map();
  let blockIdx = 0;

  function emitBlock(type, data) { return { type, index: blockIdx, ...data }; }
  function stopBlock() { const ev = { type: 'content_block_stop', index: blockIdx }; blockIdx++; inText = false; return ev; }

  for await (const chunk of parseSSE(res)) {
    if (!chunk.choices?.[0]) continue;
    const d = chunk.choices[0].delta;
    const fr = chunk.choices[0].finish_reason;

    if (!started) {
      started = true;
      yield { type: 'message_start', message: { id, type: 'message', role: 'assistant', content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } };
    }

    if (d?.content) {
      if (!inText) { yield emitBlock('content_block_start', { content_block: { type: 'text', text: '' } }); inText = true; }
      yield { type: 'content_block_delta', index: blockIdx, delta: { type: 'text_delta', text: d.content } };
    }

    if (d?.tool_calls) {
      if (inText) yield stopBlock();
      for (const tc of d.tool_calls) {
        if (!toolArgs.has(tc.index)) {
          toolArgs.set(tc.index, '');
          yield emitBlock('content_block_start', { content_block: { type: 'tool_use', id: tc.id || `toolu_${Date.now()}_${tc.index}`, name: tc.function?.name || '', input: {} } });
        }
        if (tc.function?.arguments) {
          toolArgs.set(tc.index, toolArgs.get(tc.index) + tc.function.arguments);
          yield { type: 'content_block_delta', index: blockIdx, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } };
        }
      }
    }

    if (fr) {
      const blockCount = (inText ? 1 : 0) + toolArgs.size;
      for (let i = 0; i < blockCount; i++) yield stopBlock();
      yield { type: 'message_delta', delta: { stop_reason: fr === 'stop' ? 'end_turn' : fr === 'tool_calls' ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: chunk.usage?.completion_tokens || 0 } };
      yield { type: 'message_stop' };
      finished = true;
    }
  }

  if (started && !finished) {
    const blockCount = (inText ? 1 : 0) + toolArgs.size;
    for (let i = 0; i < blockCount; i++) yield stopBlock();
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } };
    yield { type: 'message_stop' };
  }
}

async function* streamOpenAIEvents(res) {
  // Passthrough — forward OpenAI SSE as-is
  let buf = '';
  for await (const chunk of res) {
    buf += chunk.toString();
    const parts = buf.split('\n');
    buf = parts.pop() || '';
    for (const line of parts) {
      yield line;
    }
  }
  // Flush remaining
  if (buf.trim()) yield buf;
}

// ── Stream router ──

function streamResponse(res, upstreamRes, origModel, inputFormat) {
  const fmt = RESPONSE_FORMAT || inputFormat;
  if (fmt === 'anthropic') return streamAnthropicEvents(upstreamRes, origModel);
  return streamOpenAIEvents(upstreamRes);
}

// ──────────────────────────────────────────────
// HTTP Server
// ──────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const key = req.headers['x-api-key'] || API_KEY;

  // GET /health
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, upstream: DEEPSEEK_BASE_URL, model: DEFAULT_MODEL }));
    return;
  }

  // GET /v1/models
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    const isAnthropicReq = req.headers['accept']?.includes('anthropic') || false;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (isAnthropicReq || RESPONSE_FORMAT === 'anthropic') {
      res.end(JSON.stringify({ data: [
        { id: 'claude-sonnet-4-6', object: 'model' },
        { id: 'claude-opus-4-6', object: 'model' },
        { id: 'claude-haiku-4-5-20251001', object: 'model' },
      ] }));
    } else {
      res.end(JSON.stringify({ data: [
        { id: DEFAULT_MODEL, object: 'model' },
        { id: 'deepseek-chat', object: 'model' },
        { id: 'deepseek-reasoner', object: 'model' },
      ] }));
    }
    return;
  }

  // Route: POST /v1/messages or POST /v1/chat/completions
  if (req.method !== 'POST' || (url.pathname !== '/v1/messages' && url.pathname !== '/v1/chat/completions')) {
    res.writeHead(404); res.end();
    return;
  }

  // Read body
  const rawBody = await collectStream(req);
  let data;
  try { data = JSON.parse(rawBody.toString()); } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON body' } }));
    return;
  }

  // Normalize to IR
  const ir = normalizeRequest(data, url.pathname);
  log(`[${ir._inputFormat}] ${DEEPSEEK_BASE_URL} (${ir.messages.length} msgs, stream=${ir.stream})`);

  // Forward to DeepSeek
  try {
    const openaiReq = irToOpenAIRequest(ir);
    const bodyStr = JSON.stringify(openaiReq);

    const upstreamRes = await apiReq('POST', '/v1/chat/completions', {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      'Content-Length': Buffer.byteLength(bodyStr),
      Accept: ir.stream ? 'text/event-stream' : 'application/json',
    }, bodyStr);

    if (upstreamRes.statusCode >= 400) {
      const errBody = await collectStream(upstreamRes);
      let errJson;
      try { errJson = JSON.parse(errBody.toString()); } catch { errJson = { message: errBody.toString() }; }
      throw { status: upstreamRes.statusCode, body: errJson };
    }

    if (ir.stream) {
      const fmt = RESPONSE_FORMAT || ir._inputFormat;
      if (fmt === 'anthropic') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        for await (const ev of streamAnthropicEvents(upstreamRes, data.model)) {
          res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
        }
        res.end();
      } else {
        // OpenAI passthrough streaming
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        let buf = '';
        for await (const chunk of upstreamRes) {
          res.write(chunk.toString());
        }
        res.end();
      }
    } else {
      const raw = await collectStream(upstreamRes);
      const parsed = JSON.parse(raw.toString());
      const resp = denormalizeResponse(parsed, data.model, ir._inputFormat);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(resp));
    }
  } catch (e) {
    const status = e.status || 502;
    const message = e.body?.error?.message || e.body?.message || e.message || 'Upstream error';
    log('Error:', status, message);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message } }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`LLM API Translator running on :${PORT}`);
  console.log(`  Upstream:    ${DEEPSEEK_BASE_URL}`);
  console.log(`  Model:       ${DEFAULT_MODEL}`);
  console.log(`  Endpoints:`);
  console.log(`    POST /v1/messages          → Anthropic Messages API`);
  console.log(`    POST /v1/chat/completions   → OpenAI Chat API`);
  console.log(`    GET  /v1/models             → List models`);
  console.log(`    GET  /health                → Health check`);
  console.log(`Usage: ANTHROPIC_BASE_URL=http://localhost:${PORT} claude -p "..."`);
  console.log(`       curl http://localhost:${PORT}/v1/chat/completions -d '...'`);
  if (!API_KEY) console.error('WARNING: No API key set! Set DEEPSEEK_API_KEY or ANTHROPIC_API_KEY.');
});
