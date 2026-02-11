#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { URL } from 'node:url';

import { PromptRouter } from '../src/prompt/router.js';
import { ToolExecutor } from '../src/prompt/executor.js';
import { DEFAULT_PROMPT_SETUP_PATH, loadPromptSetupFromFile } from '../src/prompt/config.js';
import { INTERCOMSWAP_TOOLS } from '../src/prompt/tools.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

function die(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function usage() {
  return `
promptd (local prompting router + tool executor)

Starts a local HTTP server that:
- calls an OpenAI-compatible LLM API
- executes tool calls via deterministic tooling / SC-Bridge safe RPCs
- writes an audit trail (jsonl) under onchain/

Setup JSON (gitignored):
  --config <path>   (default: ${DEFAULT_PROMPT_SETUP_PATH})

  promptd reads all model + tool wiring from a local JSON file (recommended under onchain/ so it never gets committed).

  Print a template:
    promptd --print-template

HTTP API:
  GET  /healthz
  GET  /v1/tools
  POST /v1/run   { prompt, session_id?, auto_approve?, dry_run?, max_steps? }

`.trim();
}

function parseArgs(argv) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) flags.set(k, true);
    else {
      flags.set(k, next);
      i += 1;
    }
  }
  return flags;
}

function json(res, status, body) {
  // Guard against double responses from multiple error paths.
  // Node can throw ERR_HTTP_HEADERS_SENT if two code paths race to write headers.
  if (res.__intercomswapResponded) {
    try {
      res.end();
    } catch (_e) {}
    return;
  }
  res.__intercomswapResponded = true;
  if (res.headersSent || res.writableEnded) {
    try {
      res.end();
    } catch (_e) {}
    return;
  }
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function parseUrl(req) {
  // req.url may include query string. Use a fixed base.
  return new URL(String(req.url || '/'), 'http://127.0.0.1');
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (_e) {
    throw new Error('Invalid JSON body');
  }
}

function requireAuth(req, setup) {
  const token = String(setup?.server?.authToken || '').trim();
  if (!token) return true;
  const auth = req.headers?.authorization;
  if (typeof auth !== 'string') return false;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  return String(m[1] || '').trim() === token;
}

function ndjsonHeaders(res, status = 200) {
  res.writeHead(status, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
}

function staticHeaders(res, status, { contentType, contentLength }) {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': contentLength,
    'cache-control': 'no-cache',
  });
}

function contentTypeForFile(p) {
  const ext = String(path.extname(p) || '').toLowerCase();
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.map':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.ico':
      return 'image/x-icon';
    case '.txt':
      return 'text/plain; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

function safeJoin(root, requestPath) {
  const rel = String(requestPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  // Prevent path traversal by resolving and verifying prefix.
  const abs = path.resolve(root, rel);
  const ok = abs === root || abs.startsWith(root + path.sep);
  return ok ? abs : null;
}

async function writeNdjson(res, obj) {
  const line = `${JSON.stringify(obj)}\n`;
  const ok = res.write(line);
  if (ok) return;
  await new Promise((resolve) => res.once('drain', resolve));
}

function parseCsvParam(value) {
  const s = String(value || '').trim();
  if (!s) return [];
  return s
    .split(',')
    .map((v) => String(v || '').trim())
    .filter(Boolean);
}

function parseIntParam(value, fallback = 0) {
  if (value === null || value === undefined) return fallback;
  const n = Number.parseInt(String(value).trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = parseArgs(argv);
  if (argv.includes('--help') || argv.includes('help') || flags.get('help')) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (flags.get('print-template')) {
    process.stdout.write(
      `${JSON.stringify(
        {
          agent: {
            // "maker" or "taker" (used only for system prompt guidance; does not grant permissions).
            role: 'maker',
          },
          peer: {
            // Peer wallet keypair file used to sign sidechannel envelopes locally.
            // Must match the running peer behind SC-Bridge (stores/<store>/db/keypair.json).
            keypair: 'stores/<store>/db/keypair.json',
          },
          llm: {
            base_url: 'http://127.0.0.1:8000/v1',
            api_key: '',
            model: 'your-model-id',
            max_tokens: 8000,
            temperature: 0.4,
            top_p: 0.95,
            top_k: 40,
            min_p: 0.05,
            repetition_penalty: 1.1,
            tool_format: 'tools',
            timeout_ms: 120000,
            // Optional: OpenAI-style structured output enforcement:
            // { "type": "json_object" } or { "type": "json_schema", "json_schema": { ... } }
            response_format: { type: 'json_object' },
            // Optional: extra, provider-specific body fields (pass-through).
            extra_body: {},
          },
          server: {
            host: '127.0.0.1',
            port: 9333,
            audit_dir: 'onchain/prompt/audit',
            // Optional HTTP auth for running promptd behind ngrok / on a LAN.
            // If set, all /v1/* endpoints require: Authorization: Bearer <token>
            auth_token: '',
            auto_approve_default: false,
            max_steps: 12,
            // If the model returns invalid structured output (eg, plans instead of tool calls),
            // promptd will ask it to re-emit valid JSON up to this many times.
            max_repairs: 2,
            // Optional TLS (HTTPS). If set, promptd serves https:// instead of http://.
            // tls: { key: 'onchain/prompt/server.key', cert: 'onchain/prompt/server.crt' }
            tls: null,
          },
          sc_bridge: {
            url: 'ws://127.0.0.1:49222',
            token: '',
            token_file: 'onchain/sc-bridge/<store>.token',
          },
          receipts: {
            db: 'onchain/receipts/<store>.sqlite',
          },
          ln: {
            impl: 'cln',
            backend: 'cli',
            network: 'regtest',
            compose_file: 'dev/ln-regtest/docker-compose.yml',
            service: '',
            cli_bin: '',
            lnd: { rpcserver: '', tlscert: '', macaroon: '', dir: '' },
          },
          solana: {
            rpc_url: 'http://127.0.0.1:8899',
            commitment: 'confirmed',
            program_id: '',
            usdt_mint: '',
            keypair: '',
            cu_limit: null,
            cu_price: null,
          },
        },
        null,
        2
      )}\n`
    );
    return;
  }

  const configPath = flags.get('config') ? String(flags.get('config')).trim() : DEFAULT_PROMPT_SETUP_PATH;
  const setup = loadPromptSetupFromFile({ configPath, cwd: repoRoot });

  // Collin UI (built assets). Optional: if dist is missing, promptd still runs as an API server.
  const uiDir = path.resolve(repoRoot, 'ui', 'collin', 'dist');
  const uiIndex = path.join(uiDir, 'index.html');
  const uiEnabled = fs.existsSync(uiIndex);

  const executor = new ToolExecutor({
    scBridge: setup.scBridge,
    peer: setup.peer,
    ln: setup.ln,
    solana: setup.solana,
    receipts: setup.receipts,
  });

  const router = new PromptRouter({
    llmConfig: setup.llm,
    toolExecutor: executor,
    auditDir: setup.server.auditDir,
    maxSteps: setup.server.maxSteps,
    maxRepairs: setup.server.maxRepairs,
    agentRole: setup.agent?.role || '',
  });

  const handler = async (req, res) => {
    try {
      const method = req.method || 'GET';
      const u = parseUrl(req);
      const url = u.pathname;

      if (url.startsWith('/v1/') && !requireAuth(req, setup)) {
        res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'www-authenticate': 'Bearer' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      if (method === 'GET' && url === '/healthz') {
        json(res, 200, { ok: true });
        return;
      }

      if (method === 'GET' && url === '/v1/tools') {
        json(res, 200, { tools: INTERCOMSWAP_TOOLS });
        return;
      }

      if (method === 'POST' && url === '/v1/run') {
        const body = await readJsonBody(req);
        const prompt = String(body.prompt ?? '').trim();
        const sessionId = body.session_id ? String(body.session_id).trim() : null;
        const autoApprove =
          body.auto_approve === undefined || body.auto_approve === null
            ? setup.server.autoApproveDefault
            : Boolean(body.auto_approve);
        const dryRun = Boolean(body.dry_run);
        const maxSteps = body.max_steps !== undefined && body.max_steps !== null ? Number(body.max_steps) : null;

        const out = await router.run({ prompt, sessionId, autoApprove, dryRun, maxSteps });
        json(res, 200, out);
        return;
      }

      if (method === 'POST' && url === '/v1/run/stream') {
        const body = await readJsonBody(req);
        const prompt = String(body.prompt ?? '').trim();
        const sessionId = body.session_id ? String(body.session_id).trim() : null;
        const autoApprove =
          body.auto_approve === undefined || body.auto_approve === null
            ? setup.server.autoApproveDefault
            : Boolean(body.auto_approve);
        const dryRun = Boolean(body.dry_run);
        const maxSteps = body.max_steps !== undefined && body.max_steps !== null ? Number(body.max_steps) : null;

        ndjsonHeaders(res, 200);
        const ac = new AbortController();
        req.on('close', () => ac.abort(new Error('client_closed')));

        try {
          const out = await router.run({
            prompt,
            sessionId,
            autoApprove,
            dryRun,
            maxSteps,
            signal: ac.signal,
            emit: async (evt) => writeNdjson(res, evt),
          });
          await writeNdjson(res, { type: 'done', session_id: out.session_id });
        } catch (err) {
          await writeNdjson(res, { type: 'error', error: err?.message ?? String(err) });
        } finally {
          res.end();
        }
        return;
      }

      if (method === 'GET' && url === '/v1/sc/stream') {
        // NDJSON stream of sidechannel events received via SC-Bridge.
        // Query params:
        //   channels=<csv>   optional filter + auto-subscribe
        //   since=<seq>      optional cursor (default 0)
        //   backlog=<n>      max backlog events to send on connect (default 250)
        const channels = parseCsvParam(u.searchParams.get('channels'));
        const since = Math.max(0, parseIntParam(u.searchParams.get('since'), 0));
        const backlog = Math.max(1, Math.min(2000, parseIntParam(u.searchParams.get('backlog'), 250)));

        ndjsonHeaders(res, 200);
        const ac = new AbortController();
        req.on('close', () => ac.abort(new Error('client_closed')));

        try {
          // Ensure SC-Bridge is connected and subscribed.
          await executor.scEnsureConnected({ timeoutMs: 10_000 });
          if (channels.length > 0) {
            await executor.execute('intercomswap_sc_subscribe', { channels }, { autoApprove: false, dryRun: false });
          }

          const info = executor.scLogInfo();
          // Avoid clobbering `type` from the info object.
          await writeNdjson(res, { type: 'sc_stream_open', info });

          let cursor = since;
          // Backlog read (bounded).
          const first = executor.scLogRead({
            sinceSeq: cursor,
            limit: backlog,
            channels: channels.length > 0 ? channels : null,
          });
          if (first.oldest_seq !== null && cursor < first.oldest_seq - 1) {
            await writeNdjson(res, {
              type: 'sc_gap',
              requested_since: cursor,
              oldest_seq: first.oldest_seq,
              latest_seq: first.latest_seq,
            });
          }
          for (const e of first.events) {
            // Avoid clobbering `type` from the event object (`sidechannel_message`).
            const { type: _t, ...rest } = e || {};
            await writeNdjson(res, { type: 'sc_event', ...rest });
            cursor = Math.max(cursor, e.seq);
          }

          // Tail live events.
          while (!res.writableEnded && !ac.signal.aborted) {
            const woke = await executor.scLogWait({ sinceSeq: cursor, timeoutMs: 15_000 });
            if (!woke) {
              await writeNdjson(res, { type: 'heartbeat', ts: Date.now() });
              continue;
            }
            const slice = executor.scLogRead({
              sinceSeq: cursor,
              limit: 500,
              channels: channels.length > 0 ? channels : null,
            });
            for (const e of slice.events) {
              const { type: _t, ...rest } = e || {};
              await writeNdjson(res, { type: 'sc_event', ...rest });
              cursor = Math.max(cursor, e.seq);
            }
          }
        } catch (err) {
          try {
            await writeNdjson(res, { type: 'error', error: err?.message ?? String(err) });
          } catch (_e) {}
        } finally {
          try {
            res.end();
          } catch (_e) {}
        }
        return;
      }

      // Collin UI (single-page app). Serve only for GET requests outside /v1.
      if (uiEnabled && method === 'GET' && !url.startsWith('/v1/') && url !== '/healthz') {
        // If request is for an asset that exists, serve it. Otherwise fall back to index.html.
        const want = safeJoin(uiDir, url);
        const candidate = want && fs.existsSync(want) && fs.statSync(want).isFile() ? want : uiIndex;
        const data = fs.readFileSync(candidate);
        staticHeaders(res, 200, { contentType: contentTypeForFile(candidate), contentLength: data.length });
        res.end(data);
        return;
      }

      json(res, 404, { error: 'not_found' });
    } catch (err) {
      // If headers are already sent (e.g. NDJSON endpoints), never try to write a second response.
      // Best-effort close only.
      if (res.headersSent) {
        try {
          res.end();
        } catch (_e) {}
        return;
      }
      json(res, 400, { error: err?.message ?? String(err) });
    }
  };

  const tls = setup.server.tls;
  const server = tls
    ? https.createServer(
        {
          key: fs.readFileSync(tls.keyPath),
          cert: fs.readFileSync(tls.certPath),
          ...(tls.caPath ? { ca: fs.readFileSync(tls.caPath) } : {}),
          ...(tls.passphrase ? { passphrase: tls.passphrase } : {}),
        },
        handler
      )
    : http.createServer(handler);

  server.listen(setup.server.port, setup.server.host, () => {
    process.stdout.write(
      JSON.stringify(
        {
          type: 'promptd_listening',
          config: setup.configPath,
          host: setup.server.host,
          port: setup.server.port,
          tls: Boolean(tls),
          audit_dir: setup.server.auditDir,
          llm: { base_url: setup.llm.baseUrl, model: setup.llm.model, tool_format: setup.llm.toolFormat },
        },
        null,
        2
      ) + '\n'
    );
  });
}

main().catch((err) => die(err?.message ?? String(err)));
