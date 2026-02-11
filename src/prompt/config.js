import fs from 'node:fs';
import path from 'node:path';

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  try {
    return JSON.parse(String(raw || '').trim() || '{}');
  } catch (_e) {
    throw new Error(`Invalid JSON: ${filePath}`);
  }
}

function normalizeString(value, { allowEmpty = false } = {}) {
  const s = String(value ?? '').trim();
  if (!s && !allowEmpty) return '';
  return s;
}

function normalizeApiKey(value) {
  const s = normalizeString(value, { allowEmpty: true });
  if (!s) return '';
  const lowered = s.toLowerCase();
  if (['not-required', 'none', 'null', 'undefined'].includes(lowered)) return '';
  return s;
}

function normalizeOptionalToken(value) {
  return normalizeApiKey(value);
}

function parseIntLike(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  const n = Number.parseInt(String(value).trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseFloatLike(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const n = Number.parseFloat(String(value).trim());
  return Number.isFinite(n) ? n : fallback;
}

function resolvePath(baseDir, maybePath) {
  const p = normalizeString(maybePath, { allowEmpty: true });
  if (!p) return '';
  return path.isAbsolute(p) ? p : path.resolve(baseDir, p);
}

function readTokenMaybe({ token, tokenFile }, baseDir) {
  const inline = normalizeString(token, { allowEmpty: true });
  if (inline) return inline;
  const filePath = resolvePath(baseDir, tokenFile);
  if (!filePath) return '';
  try {
    return normalizeString(fs.readFileSync(filePath, 'utf8'), { allowEmpty: true });
  } catch (_e) {
    return '';
  }
}

export const DEFAULT_PROMPT_SETUP_PATH = 'onchain/prompt/setup.json';

// Loads the local promptd setup. The setup file MUST be gitignored (recommended under onchain/).
//
  // Expected JSON structure (high-level):
  // {
  //   "peer": { "keypair": "stores/<store>/db/keypair.json" },
  //   "llm": { "base_url": "...", "api_key": "...", "model": "...", ... },
  //   "server": { "host": "127.0.0.1", "port": 9333, "audit_dir": "onchain/prompt/audit", "auto_approve_default": false },
  //   "sc_bridge": { "url": "ws://127.0.0.1:49222", "token": "...", "token_file": "onchain/sc-bridge/peer.token" },
  //   "receipts": { "db": "onchain/receipts/maker.sqlite" },
  //   "ln": { ... },
  //   "solana": { ... }
  // }
  export function loadPromptSetupFromFile({ configPath = DEFAULT_PROMPT_SETUP_PATH, cwd = process.cwd() } = {}) {
  const baseDir = path.resolve(cwd);
  const resolved = resolvePath(baseDir, configPath);
  const raw = readJsonFile(resolved);
  if (!isObject(raw)) throw new Error(`Prompt setup must be a JSON object: ${resolved}`);

  const agentRaw = isObject(raw.agent) ? raw.agent : {};
  const agent = {
    role: normalizeString(agentRaw.role, { allowEmpty: true }) || '',
  };

  const peerRaw = isObject(raw.peer) ? raw.peer : {};
  const peer = {
    keypairPath: resolvePath(baseDir, peerRaw.keypair || ''),
  };

  const llmRaw = isObject(raw.llm) ? raw.llm : {};
  const llmResponseFormat = isObject(llmRaw.response_format) ? llmRaw.response_format : null;
  const llmExtraBody = isObject(llmRaw.extra_body) ? llmRaw.extra_body : null;
  const llm = {
    baseUrl: normalizeString(llmRaw.base_url),
    apiKey: normalizeApiKey(llmRaw.api_key),
    model: normalizeString(llmRaw.model),
    maxTokens: parseIntLike(llmRaw.max_tokens, 0) ?? 0,
    temperature: parseFloatLike(llmRaw.temperature, null),
    topP: parseFloatLike(llmRaw.top_p, null),
    topK: parseIntLike(llmRaw.top_k, null),
    minP: parseFloatLike(llmRaw.min_p, null),
    repetitionPenalty: parseFloatLike(llmRaw.repetition_penalty, null),
    toolFormat: normalizeString(llmRaw.tool_format, { allowEmpty: true }) || 'tools', // tools|functions
    timeoutMs: parseIntLike(llmRaw.timeout_ms, 120_000) ?? 120_000,
    responseFormat: llmResponseFormat,
    extraBody: llmExtraBody,
  };
  if (!llm.baseUrl) throw new Error(`Missing llm.base_url in ${resolved}`);
  if (!llm.model) throw new Error(`Missing llm.model in ${resolved}`);

  const serverRaw = isObject(raw.server) ? raw.server : {};
  const tlsRaw = isObject(serverRaw.tls) ? serverRaw.tls : null;
  const server = {
    host: normalizeString(serverRaw.host, { allowEmpty: true }) || '127.0.0.1',
    port: parseIntLike(serverRaw.port, 9333) ?? 9333,
    auditDir: resolvePath(baseDir, serverRaw.audit_dir || 'onchain/prompt/audit'),
    authToken: normalizeOptionalToken(serverRaw.auth_token),
    autoApproveDefault: Boolean(serverRaw.auto_approve_default),
    maxSteps: parseIntLike(serverRaw.max_steps, 12) ?? 12,
    maxRepairs: parseIntLike(serverRaw.max_repairs, 2) ?? 2,
    tls: tlsRaw
      ? {
          keyPath: resolvePath(baseDir, tlsRaw.key || ''),
          certPath: resolvePath(baseDir, tlsRaw.cert || ''),
          caPath: resolvePath(baseDir, tlsRaw.ca || ''),
          passphrase: normalizeString(tlsRaw.passphrase, { allowEmpty: true }) || '',
        }
      : null,
  };
  if (!Number.isFinite(server.port) || server.port <= 0) throw new Error(`Invalid server.port in ${resolved}`);
  if (server.tls) {
    if (!server.tls.keyPath || !server.tls.certPath) {
      throw new Error(`server.tls requires both tls.key and tls.cert in ${resolved}`);
    }
  }

  const scRaw = isObject(raw.sc_bridge) ? raw.sc_bridge : {};
  const scBridge = {
    url: normalizeString(scRaw.url, { allowEmpty: true }) || 'ws://127.0.0.1:49222',
    token: readTokenMaybe({ token: scRaw.token, tokenFile: scRaw.token_file }, baseDir),
  };
  if (!scBridge.token) {
    throw new Error(`Missing sc_bridge.token (or sc_bridge.token_file) in ${resolved}`);
  }

  const receiptsRaw = isObject(raw.receipts) ? raw.receipts : {};
  const receipts = {
    dbPath: resolvePath(baseDir, receiptsRaw.db || ''),
  };

  const lnRaw = isObject(raw.ln) ? raw.ln : {};
  const ln = {
    impl: normalizeString(lnRaw.impl, { allowEmpty: true }) || 'cln',
    backend: normalizeString(lnRaw.backend, { allowEmpty: true }) || 'cli',
    network: normalizeString(lnRaw.network, { allowEmpty: true }) || 'regtest',
    composeFile: resolvePath(baseDir, lnRaw.compose_file || path.join('dev', 'ln-regtest', 'docker-compose.yml')),
    service: normalizeString(lnRaw.service, { allowEmpty: true }) || '',
    cliBin: normalizeString(lnRaw.cli_bin, { allowEmpty: true }) || '',
    cwd: baseDir,
    lnd: {
      rpcserver: normalizeString(lnRaw?.lnd?.rpcserver, { allowEmpty: true }) || '',
      tlscertpath: resolvePath(baseDir, lnRaw?.lnd?.tlscert || ''),
      macaroonpath: resolvePath(baseDir, lnRaw?.lnd?.macaroon || ''),
      lnddir: resolvePath(baseDir, lnRaw?.lnd?.dir || ''),
    },
  };

  const solRaw = isObject(raw.solana) ? raw.solana : {};
  const solana = {
    rpcUrls: normalizeString(solRaw.rpc_url, { allowEmpty: true }) || 'http://127.0.0.1:8899',
    commitment: normalizeString(solRaw.commitment, { allowEmpty: true }) || 'confirmed',
    programId: normalizeString(solRaw.program_id, { allowEmpty: true }) || '',
    usdtMint: normalizeString(solRaw.usdt_mint, { allowEmpty: true }) || '',
    keypairPath: resolvePath(baseDir, solRaw.keypair || ''),
    computeUnitLimit: parseIntLike(solRaw.cu_limit, null),
    computeUnitPriceMicroLamports: parseIntLike(solRaw.cu_price, null),
  };

  return {
    configPath: resolved,
    agent,
    peer,
    llm,
    server,
    scBridge,
    receipts,
    ln,
    solana,
  };
}
