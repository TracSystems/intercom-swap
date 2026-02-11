function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function clampInt(n, { min, max }) {
  if (!Number.isInteger(n)) throw new Error('must be an integer');
  if (typeof min === 'number' && n < min) throw new Error(`must be >= ${min}`);
  if (typeof max === 'number' && n > max) throw new Error(`must be <= ${max}`);
  return n;
}

function safeCloneArgs(args) {
  if (!isObject(args)) return {};
  try {
    return JSON.parse(JSON.stringify(args));
  } catch (_e) {
    // As a fallback, do a shallow clone. Tool executor will re-validate anyway.
    return { ...args };
  }
}

function shouldStopForInsufficientFundsError(msg) {
  const s = String(msg || '').toLowerCase();
  if (!s) return false;
  return (
    s.includes('insufficient ln') ||
    s.includes('insufficient lightning') ||
    s.includes('insufficient usdt') ||
    s.includes('insufficient sol') ||
    s.includes('insufficient funds') ||
    s.includes('no active lightning channels')
  );
}

// Simple in-process scheduler for periodic postings (offer/rfq).
// Intentionally *not* a general job runner: it only supports a small allowlist
// of tools and strictly controlled argument shaping.
export class AutopostManager {
  constructor({ runTool, getTrade = null, listTrades = null }) {
    if (typeof runTool !== 'function') throw new Error('AutopostManager: runTool function required');
    this.runTool = runTool;
    this.getTrade = typeof getTrade === 'function' ? getTrade : null;
    this.listTrades = typeof listTrades === 'function' ? listTrades : null;
    this.jobs = new Map(); // name -> job
  }

  status({ name = '' } = {}) {
    const filter = String(name || '').trim();
    const out = [];
    for (const j of this.jobs.values()) {
      if (filter && j.name !== filter) continue;
      out.push({
        name: j.name,
        tool: j.tool,
        interval_sec: j.intervalSec,
        ttl_sec: j.ttlSec ?? null,
        valid_until_unix: j.validUntilUnix ?? null,
        args: j.args,
        runs: j.runs,
        started_at: j.startedAt,
        last_run_at: j.lastRunAt,
        last_ok: j.lastOk,
        last_error: j.lastError,
      });
    }
    // newest first
    out.sort((a, b) => (b.started_at || 0) - (a.started_at || 0));
    return { type: 'autopost_status', jobs: out };
  }

  async start({ name, tool, interval_sec, ttl_sec, valid_until_unix, args }) {
    const n = String(name || '').trim();
    if (!n) throw new Error('autopost_start: name is required');
    if (this.jobs.has(n)) throw new Error(`autopost_start: name already exists (${n})`);

    const t = String(tool || '').trim();
    const allowed = new Set(['intercomswap_offer_post', 'intercomswap_rfq_post']);
    if (!allowed.has(t)) throw new Error('autopost_start: tool not allowed');

    const intervalSec = clampInt(interval_sec, { min: 1, max: 24 * 3600 });
    const ttlSec = ttl_sec === null || ttl_sec === undefined ? null : clampInt(ttl_sec, { min: 10, max: 7 * 24 * 3600 });
    if (!ttlSec) throw new Error('autopost_start: ttl_sec is required');

    const baseArgs = safeCloneArgs(args);
    if (!isObject(baseArgs)) throw new Error('autopost_start: args must be an object');

    const nowSec = Math.floor(Date.now() / 1000);
    // Autopost MUST NOT extend validity. It runs until an absolute expiry and then stops.
    const validUntilUnixRaw = valid_until_unix === null || valid_until_unix === undefined ? null : clampInt(valid_until_unix, { min: 1 });
    const validUntilUnix = validUntilUnixRaw ?? nowSec + ttlSec;
    if (validUntilUnix <= nowSec) throw new Error('autopost_start: valid_until_unix must be in the future');
    // Keep job lifetimes bounded to reduce operator footguns.
    const horizon = validUntilUnix - nowSec;
    if (horizon < 10) throw new Error('autopost_start: validity horizon too short');
    if (horizon > 7 * 24 * 3600) throw new Error('autopost_start: validity horizon too long (max 7 days)');

    const job = {
      name: n,
      tool: t,
      intervalSec,
      ttlSec,
      validUntilUnix,
      args: baseArgs,
      tradeId: t === 'intercomswap_rfq_post' && typeof baseArgs?.trade_id === 'string' ? String(baseArgs.trade_id).trim() : null,
      peerSignerHex: null,
      runs: 0,
      startedAt: Date.now(),
      lastRunAt: null,
      lastOk: null,
      lastError: null,
      _timer: null,
      _queue: Promise.resolve(),
    };

    const stopJob = (reason) => {
      try {
        if (job._timer) clearInterval(job._timer);
      } catch (_e) {}
      this.jobs.delete(job.name);
      job.lastOk = true;
      job.lastError = reason ? String(reason) : null;
    };

    const runOnce = async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      if (nowSec >= job.validUntilUnix) {
        // Stop the job when it is no longer valid (do not repost/extend indefinitely).
        stopJob('expired');
        return { type: 'autopost_stopped', name: job.name, ok: true, reason: 'expired' };
      }

      // For Offer bots: prune filled offer lines so we don't keep advertising inventory that already traded.
      // This relies on local receipts (claimed trades) and is best-effort.
      if (job.tool === 'intercomswap_offer_post' && job.peerSignerHex && this.listTrades) {
        try {
          const offers = Array.isArray(job.args?.offers) ? job.args.offers : [];
          if (offers.length > 0) {
            const trades = await this.listTrades({ limit: 250 });
            const removeCounts = new Map(); // key -> count
            const startMs = Number(job.startedAt || 0);
            for (const tr of Array.isArray(trades) ? trades : []) {
              if (!isObject(tr)) continue;
              if (String(tr.state || '').trim() !== 'claimed') continue;
              const maker = String(tr.maker_peer || '').trim().toLowerCase();
              if (!maker || maker !== job.peerSignerHex) continue;
              const updatedAt = typeof tr.updated_at === 'number' ? tr.updated_at : null;
              if (startMs && typeof updatedAt === 'number' && updatedAt > 0 && updatedAt < startMs) continue;
              const btcSats = Number(tr.btc_sats);
              const usdtAmount = String(tr.usdt_amount || '').trim();
              if (!Number.isInteger(btcSats) || btcSats < 1) continue;
              if (!/^[0-9]+$/.test(usdtAmount)) continue;
              const key = `${btcSats}:${usdtAmount}`;
              removeCounts.set(key, (removeCounts.get(key) || 0) + 1);
            }
            if (removeCounts.size > 0) {
              const nextOffers = [];
              for (const o of offers) {
                if (!isObject(o)) continue;
                const btcSats = Number(o.btc_sats);
                const usdtAmount = String(o.usdt_amount || '').trim();
                const key = `${btcSats}:${usdtAmount}`;
                const n = removeCounts.get(key) || 0;
                if (n > 0) {
                  removeCounts.set(key, n - 1);
                  continue; // drop filled line
                }
                nextOffers.push(o);
              }
              job.args.offers = nextOffers;
            }
            if (Array.isArray(job.args?.offers) && job.args.offers.length === 0) {
              stopJob('filled');
              return { type: 'autopost_stopped', name: job.name, ok: true, reason: 'filled' };
            }
          }
        } catch (_e) {
          // ignore
        }
      }

      // For RFQ bots: once the trade is in-progress (or finished), stop reposting so the operator
      // doesn’t accidentally invite multiple counterparties for the same trade_id.
      if (job.tool === 'intercomswap_rfq_post' && job.tradeId && this.getTrade) {
        try {
          const tr = await this.getTrade(job.tradeId);
          const st = tr ? String(tr.state || '').trim() : '';
          if (st && st !== 'rfq' && st !== 'rfq_posted') {
            stopJob(`filled:${st}`);
            return { type: 'autopost_stopped', name: job.name, ok: true, reason: 'filled', state: st };
          }
        } catch (_e) {
          // Ignore store read errors; the scheduler should remain resilient and continue.
        }
      }

      const runArgs = safeCloneArgs(job.args);
      if (t === 'intercomswap_offer_post') {
        // Keep discoverability via periodic repost, but do NOT extend expiry.
        delete runArgs.ttl_sec;
        runArgs.valid_until_unix = job.validUntilUnix;
      } else if (t === 'intercomswap_rfq_post') {
        runArgs.valid_until_unix = job.validUntilUnix;
      }
      job.lastRunAt = Date.now();
      try {
        const res = await this.runTool({ tool: t, args: runArgs });
        job.runs += 1;
        job.lastOk = true;
        job.lastError = null;
        if (job.tool === 'intercomswap_offer_post' && !job.peerSignerHex) {
          try {
            const signer = res && typeof res === 'object' ? res?.envelope?.signer : null;
            const hex = typeof signer === 'string' ? signer.trim().toLowerCase() : '';
            if (hex) job.peerSignerHex = hex;
          } catch (_e) {}
        }
        return res;
      } catch (err) {
        job.runs += 1;
        job.lastOk = false;
        const msg = err?.message ?? String(err);
        job.lastError = msg;
        if (shouldStopForInsufficientFundsError(msg)) {
          stopJob('insufficient_funds');
          return { type: 'autopost_stopped', name: job.name, ok: true, reason: 'insufficient_funds', error: msg };
        }
        throw err;
      }
    };

    // Run once immediately to validate + publish right away.
    let first = null;
    try {
      first = await runOnce();
    } catch (_e) {
      // Keep the job running even if the first attempt failed, so operators can fix the stack
      // and the scheduler will recover. The error is surfaced via job.last_error and UI toasts.
    }
    if (first && typeof first === 'object' && String(first.type || '') === 'autopost_stopped') {
      return first;
    }

    job._timer = setInterval(() => {
      // Stop naturally once the offer/RFQ expires.
      const nowSec = Math.floor(Date.now() / 1000);
      if (nowSec >= job.validUntilUnix) {
        stopJob('expired');
        return;
      }
      job._queue = job._queue.then(runOnce).catch(() => {});
    }, Math.max(1000, intervalSec * 1000));

    this.jobs.set(n, job);

    return {
      type: 'autopost_started',
      name: n,
      tool: t,
      interval_sec: intervalSec,
      ttl_sec: job.ttlSec,
      valid_until_unix: job.validUntilUnix,
      first: first,
    };
  }

  async stop({ name }) {
    const n = String(name || '').trim();
    if (!n) throw new Error('autopost_stop: name is required');
    const job = this.jobs.get(n);
    if (!job) return { type: 'autopost_stopped', name: n, ok: true, reason: 'not_found' };
    try {
      if (job._timer) clearInterval(job._timer);
    } catch (_e) {}
    this.jobs.delete(n);
    return { type: 'autopost_stopped', name: n, ok: true };
  }
}
