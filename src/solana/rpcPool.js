import { Connection } from '@solana/web3.js';
import { headersForUrl } from '../net/httpHeaders.js';

function splitCsv(raw) {
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) return raw.map((v) => String(v).trim()).filter(Boolean);
  const s = String(raw).trim();
  if (!s) return [];
  return s
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function fetchWithTimeout(timeoutMs) {
  const baseFetch = globalThis.fetch;
  if (typeof baseFetch !== 'function') return undefined;
  const Controller = globalThis.AbortController;
  if (typeof Controller !== 'function') return baseFetch;
  const ms = Number.isFinite(timeoutMs) ? Math.max(250, Math.trunc(timeoutMs)) : 8000;

  return async (input, init = {}) => {
    const controller = new Controller();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      const mergedInit = { ...init, signal: controller.signal };
      return await baseFetch(input, mergedInit);
    } finally {
      clearTimeout(timer);
    }
  };
}

// We retry RPC endpoints on *any* error by default. The operations we run against
// Solana are either read-only or involve re-sending the same signed transaction
// (idempotent by signature). If we later add non-idempotent operations, revisit this.
export class SolanaRpcPool {
  constructor({
    rpcUrls,
    commitment = 'confirmed',
    timeoutMs = 8000,
  } = {}) {
    const urls = splitCsv(rpcUrls);
    if (urls.length === 0) throw new Error('SolanaRpcPool requires at least one rpc url');
    this.urls = urls;
    this.commitment = commitment;
    this.timeoutMs = timeoutMs;

    this._connections = new Map(); // url -> Connection
    this._preferredIndex = 0;
  }

  connection(url) {
    const u = String(url).trim();
    if (!u) throw new Error('rpc url is required');
    const existing = this._connections.get(u);
    if (existing) return existing;
    const httpHeaders = headersForUrl(u);
    const conn = new Connection(u, {
      commitment: this.commitment,
      fetch: fetchWithTimeout(this.timeoutMs),
      ...(Object.keys(httpHeaders).length > 0 ? { httpHeaders } : {}),
    });
    this._connections.set(u, conn);
    return conn;
  }

  // Attempts the operation against each RPC endpoint in order, starting with the
  // last-known-good endpoint (preferred index).
  async call(fn, { label = 'solana_rpc_call' } = {}) {
    const n = this.urls.length;
    let lastErr = null;
    for (let i = 0; i < n; i += 1) {
      const idx = (this._preferredIndex + i) % n;
      const url = this.urls[idx];
      const conn = this.connection(url);
      try {
        const res = await fn(conn, url);
        this._preferredIndex = idx; // pin to last-known-good
        return res;
      } catch (err) {
        lastErr = err;
        // Try the next endpoint.
        // Keep error context small; callers can log the url they used if needed.
        const msg = err?.message ?? String(err);
        if (i === n - 1) throw new Error(`${label} failed (rpc=${url}): ${msg}`);
      }
    }
    throw lastErr || new Error(`${label} failed`);
  }
}
