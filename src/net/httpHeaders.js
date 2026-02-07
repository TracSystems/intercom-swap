import fs from 'fs';
import path from 'path';

// Simple, URL-prefix based HTTP header injection for authenticated API endpoints.
//
// Why this exists:
// - Operators often use RPC/API providers that require an Authorization/Bearer token.
// - We want to keep endpoints user-configurable without baking secrets into code.
//
// Inputs (first hit wins):
// - env `HTTP_HEADERS_JSON`: JSON string, either:
//   - { "<urlPrefix>": { "Header": "Value" }, ... }
//   - { "rules": [ { "match": "<urlPrefix|*>", "headers": { ... } }, ... ] }
//   - [ { "match": "<urlPrefix|*>", "headers": { ... } }, ... ]
// - env `HTTP_HEADERS_FILE`: path to a JSON file in one of the formats above.
// - default file `onchain/http/headers.json` (relative to process cwd) if it exists.

let _cache = null;
let _cacheKey = null;

function defaultHeadersFile() {
  return path.join(process.cwd(), 'onchain', 'http', 'headers.json');
}

function tryReadText(filePath) {
  try {
    if (!filePath) return null;
    if (!fs.existsSync(filePath)) return null;
    const text = fs.readFileSync(filePath, 'utf8');
    return typeof text === 'string' ? text : String(text || '');
  } catch (_e) {
    return null;
  }
}

function normalizeHeaders(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = String(k || '').trim();
    if (!key) continue;
    if (v === undefined || v === null) continue;
    out[key] = String(v);
  }
  return out;
}

function normalizeRules(value) {
  // Supported formats:
  // - { "<prefix>": { ...headers }, ... }
  // - { rules: [ { match, headers }, ... ] }
  // - [ { match, headers }, ... ]
  const rules = [];

  const pushRule = (match, headers) => {
    const m = String(match || '').trim();
    if (!m) return;
    rules.push({ match: m, headers: normalizeHeaders(headers) });
  };

  if (Array.isArray(value)) {
    for (const r of value) pushRule(r?.match, r?.headers);
    return rules;
  }

  if (value && typeof value === 'object') {
    if (Array.isArray(value.rules)) {
      for (const r of value.rules) pushRule(r?.match, r?.headers);
      return rules;
    }
    // Map format.
    for (const [match, headers] of Object.entries(value)) {
      if (match === 'rules') continue;
      pushRule(match, headers);
    }
  }

  return rules;
}

function loadRules() {
  const envJson = process.env.HTTP_HEADERS_JSON ? String(process.env.HTTP_HEADERS_JSON) : '';
  const envFile = process.env.HTTP_HEADERS_FILE ? String(process.env.HTTP_HEADERS_FILE).trim() : '';
  const fallbackFile = defaultHeadersFile();

  const cacheKey = JSON.stringify({
    envJson: envJson ? 'set' : '',
    envFile: envFile || '',
    cwd: process.cwd(),
  });
  if (_cache && _cacheKey === cacheKey) return _cache;

  let rawText = null;
  if (envJson) rawText = envJson;
  else rawText = tryReadText(envFile) ?? tryReadText(fallbackFile);

  let parsed = null;
  if (rawText) {
    try {
      parsed = JSON.parse(rawText);
    } catch (_e) {
      // Intentionally ignore invalid JSON to avoid crashing peers due to local config typos.
      parsed = null;
    }
  }

  const rules = normalizeRules(parsed);
  // Prefer more specific prefixes (longer match) when multiple rules match.
  rules.sort((a, b) => a.match.length - b.match.length);

  _cache = rules;
  _cacheKey = cacheKey;
  return rules;
}

export function resetHttpHeadersCache() {
  _cache = null;
  _cacheKey = null;
}

export function headersForUrl(url) {
  const u = String(url || '').trim();
  if (!u) return {};
  const rules = loadRules();
  if (rules.length === 0) return {};

  const out = {};
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue;
    const match = String(rule.match || '').trim();
    if (!match) continue;
    const ok = match === '*' ? true : u.startsWith(match);
    if (!ok) continue;
    Object.assign(out, normalizeHeaders(rule.headers));
  }
  return out;
}

