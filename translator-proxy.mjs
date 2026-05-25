#!/usr/bin/env node
/**
 * LLM API Translator — Anthropic Messages API ↔ OpenAI Chat API proxy
 *
 * Translates Anthropic-format requests (POST /v1/messages) into OpenAI-format
 * requests (POST /v1/chat/completions) and routes them to any OpenAI-compatible
 * backend (DeepSeek, Groq, Together, etc.).
 *
 * Usage:
 *   DEEPSEEK_API_KEY=sk-... node translator-proxy.mjs
 *   ANTHROPIC_BASE_URL=http://localhost:3800 claude -p "Hello"
 *
 * Configuration via environment variables:
 *   DEEPSEEK_API_KEY (or ANTHROPIC_API_KEY) — API key for upstream provider
 *   DEEPSEEK_BASE_URL  — Upstream base URL (default: https://api.deepseek.com)
 *   OPENAI_MODEL       — Model name to forward (default: deepseek-chat)
 *   PROXY_PORT         — Listen port (default: 3800)
 *   PROXY_DEBUG        — Enable debug logging to stderr
 */
import http from 'node:http';
import https from 'node:https';

const PORT = parseInt(process.env.PROXY_PORT || '3800', 10);
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'deepseek-chat';
const API_KEY = process.env.ANTHROPIC_API_KEY || process.env.DEEPSEEK_API_KEY || '';

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
// Format translation: Anthropic → OpenAI
// ──────────────────────────────────────────────

function toOpenAI(body) {
  const msgs = [];

  // System prompt
  if (body.system) {
    msgs.push({
      role: 'system',
      content: typeof body.system === 'string'
        ? body.system
        : body.system.map((b) => b.text).join(''),
    });
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
          msgs.push({ role: 'tool', tool_call_id: b.tool_use_id, content: txt });
        }
      } else {
        msgs.push({
          role: 'user',
          content: textBlocks.map((b) => b.text).join('') || (typeof m.content === 'string' ? m.content : ''),
        });
      }
    } else if (m.role === 'assistant') {
      const content = Array.isArray(m.content) ? m.content : [];
      const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const tools = content
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input) },
        }));
      const entry = { role: 'assistant', content: text || null };
      if (tools.length) entry.tool_calls = tools;
      msgs.push(entry);
    }
  }

  const out = {
    model: body.model?.startsWith('claude-') ? DEFAULT_MODEL : body.model,
    messages: msgs,
    max_tokens: body.max_tokens,
    stream: body.stream === true,
    tools: (body.tools || []).map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    })),
    tool_choice:
      body.tool_choice?.type === 'auto'
        ? 'auto'
        : body.tool_choice?.type === 'any'
          ? 'required'
          : body.tool_choice?.type === 'tool'
            ? { type: 'function', function: { name: body.tool_choice.name } }
            : undefined,
    temperature: body.temperature ?? 0,
  };

  // Strip undefined keys
  Object.keys(out).forEach((k) => out[k] === undefined && delete out[k]);
  return out;
}

// ──────────────────────────────────────────────
// Format translation: OpenAI → Anthropic (non-streaming)
// ──────────────────────────────────────────────

function toAnthropic(chatResp, origModel) {
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
      c?.finish_reason === 'stop'
        ? 'end_turn'
        : c?.finish_reason === 'tool_calls'
          ? 'tool_use'
          : c?.finish_reason === 'length'
            ? 'max_tokens'
            : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: chatResp.usage?.prompt_tokens || 0,
      output_tokens: chatResp.usage?.completion_tokens || 0,
    },
  };
}

// ──────────────────────────────────────────────
// SSE streaming: OpenAI SSE → Anthropic event stream
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
        try {
          yield JSON.parse(t.slice(6));
        } catch { /* skip malformed */ }
      }
    }
  }
}

async function* streamEvents(res, origModel) {
  const model = origModel || DEFAULT_MODEL;
  const id = `msg_${Date.now().toString(36)}`;
  let started = false;
  let finished = false;
  let inText = false;
  const toolArgs = new Map();
  let blockIdx = 0;

  function emitBlock(type, data) {
    return { type, index: blockIdx, ...data };
  }
  function stopBlock() {
    const ev = { type: 'content_block_stop', index: blockIdx };
    blockIdx++;
    inText = false;
    return ev;
  }

  for await (const chunk of parseSSE(res)) {
    if (!chunk.choices?.[0]) continue;
    const d = chunk.choices[0].delta;
    const fr = chunk.choices[0].finish_reason;

    if (!started) {
      started = true;
      yield {
        type: 'message_start',
        message: {
          id,
          type: 'message',
          role: 'assistant',
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      };
    }

    // Text delta
    if (d?.content) {
      if (!inText) {
        yield emitBlock('content_block_start', {
          content_block: { type: 'text', text: '' },
        });
        inText = true;
      }
      yield {
        type: 'content_block_delta',
        index: blockIdx,
        delta: { type: 'text_delta', text: d.content },
      };
    }

    // Tool call deltas
    if (d?.tool_calls) {
      if (inText) yield stopBlock();
      for (const tc of d.tool_calls) {
        if (!toolArgs.has(tc.index)) {
          toolArgs.set(tc.index, '');
          yield emitBlock('content_block_start', {
            content_block: {
              type: 'tool_use',
              id: tc.id || `toolu_${Date.now()}_${tc.index}`,
              name: tc.function?.name || '',
              input: {},
            },
          });
        }
        if (tc.function?.arguments) {
          toolArgs.set(tc.index, toolArgs.get(tc.index) + tc.function.arguments);
          yield {
            type: 'content_block_delta',
            index: blockIdx,
            delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
          };
        }
      }
    }

    // Finish
    if (fr) {
      const blockCount = (inText ? 1 : 0) + toolArgs.size;
      for (let i = 0; i < blockCount; i++) yield stopBlock();
      yield {
        type: 'message_delta',
        delta: {
          stop_reason:
            fr === 'stop' ? 'end_turn' : fr === 'tool_calls' ? 'tool_use' : 'end_turn',
          stop_sequence: null,
        },
        usage: { output_tokens: chunk.usage?.completion_tokens || 0 },
      };
      yield { type: 'message_stop' };
      finished = true;
    }
  }

  // Truncated stream cleanup
  if (started && !finished) {
    const blockCount = (inText ? 1 : 0) + toolArgs.size;
    for (let i = 0; i < blockCount; i++) yield stopBlock();
    yield {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 0 },
    };
    yield { type: 'message_stop' };
  }
}

// ──────────────────────────────────────────────
// HTTP Server
// ──────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const key = req.headers['x-api-key'] || API_KEY;

  // GET /health
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      upstream: DEEPSEEK_BASE_URL,
      model: DEFAULT_MODEL,
    }));
    return;
  }

  // GET /v1/models
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      data: [
        { id: 'claude-sonnet-4-6', object: 'model' },
        { id: 'claude-opus-4-6', object: 'model' },
        { id: 'claude-haiku-4-5-20251001', object: 'model' },
      ],
    }));
    return;
  }

  // Only POST /v1/messages
  if (req.method !== 'POST' || url.pathname !== '/v1/messages') {
    res.writeHead(404);
    res.end();
    return;
  }

  // Read body
  const rawBody = await collectStream(req);
  let data;
  try {
    data = JSON.parse(rawBody.toString());
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'Invalid JSON body' },
    }));
    return;
  }

  // Translate and forward
  try {
    const openaiReq = toOpenAI(data);
    const bodyStr = JSON.stringify(openaiReq);
    log(`→ ${DEEPSEEK_BASE_URL} (${openaiReq.messages.length} msgs, stream=${!!openaiReq.stream})`);

    const upstreamRes = await apiReq(
      'POST',
      '/v1/chat/completions',
      {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        'Content-Length': Buffer.byteLength(bodyStr),
        Accept: openaiReq.stream ? 'text/event-stream' : 'application/json',
      },
      bodyStr,
    );

    // Upstream error
    if (upstreamRes.statusCode >= 400) {
      const errBody = await collectStream(upstreamRes);
      let errJson;
      try {
        errJson = JSON.parse(errBody.toString());
      } catch {
        errJson = { message: errBody.toString() };
      }
      throw { status: upstreamRes.statusCode, body: errJson };
    }

    // Streaming response
    if (openaiReq.stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      for await (const ev of streamEvents(upstreamRes, data.model)) {
        res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
      }
      res.end();
    } else {
      // Non-streaming response
      const raw = await collectStream(upstreamRes);
      const parsed = JSON.parse(raw.toString());
      const anthropicResp = toAnthropic(parsed, data.model);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(anthropicResp));
    }
  } catch (e) {
    const status = e.status || 502;
    const message = e.body?.error?.message || e.body?.message || e.message || 'Upstream error';
    log('Error:', status, message);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      type: 'error',
      error: { type: 'proxy_error', message },
    }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`LLM API Translator running on :${PORT}`);
  console.log(`  Upstream: ${DEEPSEEK_BASE_URL}`);
  console.log(`  Model:    ${DEFAULT_MODEL}`);
  console.log(`Usage: ANTHROPIC_BASE_URL=http://localhost:${PORT} claude -p "..."`);
  if (!API_KEY) console.error('WARNING: No API key set! Set DEEPSEEK_API_KEY or ANTHROPIC_API_KEY.');
});
