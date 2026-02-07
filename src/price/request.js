import { headersForUrl } from '../net/httpHeaders.js';

export async function fetchJson(url, { timeoutMs = 4000, headers = {} } = {}) {
  let baseFetch = globalThis.fetch;
  if (typeof baseFetch !== 'function') {
    // Pear/Bare runtime does not always provide a global fetch implementation.
    // Prefer bare-fetch when available (works in Bare).
    try {
      const mod = await import('bare-fetch');
      baseFetch = mod?.default || mod;
    } catch (_e) {
      throw new Error('fetch is not available');
    }
  }

  const injected = headersForUrl(url);
  const mergedHeaders = { ...injected, ...(headers && typeof headers === 'object' ? headers : {}) };

  const ms = Math.max(1, Number.isFinite(timeoutMs) ? Math.trunc(timeoutMs) : 4000);
  const Controller = globalThis.AbortController;

  const doFetch = async (signal) => {
    const init = {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...mergedHeaders,
      },
      ...(signal ? { signal } : {}),
    };
    const res = await baseFetch(url, init);
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      err.body = text.slice(0, 200);
      throw err;
    }
    try {
      return JSON.parse(text);
    } catch (_e) {
      const err = new Error('Invalid JSON');
      err.body = text.slice(0, 200);
      throw err;
    }
  };

  // Pear/Bare runtimes may not provide AbortController. Fall back to a
  // Promise.race timeout in that case (cannot abort the underlying fetch).
  if (typeof Controller !== 'function') {
    const timeout = new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    });
    return Promise.race([doFetch(null), timeout]);
  }

  const controller = new Controller();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await doFetch(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
