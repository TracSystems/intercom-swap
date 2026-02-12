import { hashUnsignedEnvelope } from '../swap/hash.js';

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function toIntOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number.parseInt(String(v).trim(), 10);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function clampInt(n, { min, max, fallback }) {
  const v = Number.isFinite(n) ? Math.trunc(n) : fallback;
  return Math.max(min, Math.min(max, v));
}

function envelopeKind(evt) {
  return String(evt?.kind || evt?.message?.kind || '').trim();
}

function envelopeTradeId(evt) {
  return String(evt?.trade_id || evt?.message?.trade_id || '').trim();
}

function envelopeSigner(evt) {
  const s = String(evt?.message?.signer || evt?.signer || '').trim().toLowerCase();
  return /^[0-9a-f]{64}$/i.test(s) ? s : '';
}

function envelopeSig(evt) {
  const s = String(evt?.message?.sig || '').trim().toLowerCase();
  return /^[0-9a-f]{128}$/i.test(s) ? s : '';
}

function normalizePeerHex(value) {
  const s = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{64}$/i.test(s) ? s : '';
}

function localPeerFromScInfo(raw) {
  if (!raw || typeof raw !== 'object') return '';
  const direct =
    normalizePeerHex(raw?.peer) ||
    normalizePeerHex(raw?.peerPubkey) ||
    normalizePeerHex(raw?.peer_pubkey) ||
    '';
  if (direct) return direct;
  const info = isObject(raw?.info) ? raw.info : null;
  if (!info) return '';
  return normalizePeerHex(info?.peer) || normalizePeerHex(info?.peerPubkey) || normalizePeerHex(info?.peer_pubkey) || '';
}

function eventDedupKey(evt) {
  if (!evt || typeof evt !== 'object') return '';
  const channel = String(evt?.channel || '').trim();
  const kind = envelopeKind(evt);
  const tradeId = envelopeTradeId(evt);
  const sig = envelopeSig(evt);
  if (sig) {
    const signer = envelopeSigner(evt);
    return `sig:${channel}:${kind}:${tradeId}:${signer}:${sig}`;
  }
  const seq = typeof evt?.seq === 'number' && Number.isFinite(evt.seq) ? Math.trunc(evt.seq) : 0;
  if (seq > 0) return `seq:${seq}`;
  if (!channel && !kind && !tradeId) return '';
  const ts = typeof evt?.ts === 'number' && Number.isFinite(evt.ts) ? Math.trunc(evt.ts) : 0;
  return `evt:${channel}:${kind}:${tradeId}:${ts}`;
}

function eventTs(evt) {
  const ts = typeof evt?.ts === 'number' ? evt.ts : 0;
  return Number.isFinite(ts) && ts > 0 ? ts : Date.now();
}

function isLocalEvent(evt) {
  return Boolean(evt?.local) || String(evt?.dir || '').trim().toLowerCase() === 'out' || String(evt?.origin || '').trim().toLowerCase() === 'local';
}

function stripSignature(envelope) {
  const { sig: _sig, signer: _signer, ...unsigned } = envelope || {};
  return unsigned;
}

function sanitizeChannels(raw) {
  if (!Array.isArray(raw)) return [];
  return Array.from(
    new Set(
      raw
        .map((c) => String(c || '').trim())
        .filter((c) => c.length > 0 && c.length <= 128 && !/\s/.test(c))
        .slice(0, 64)
    )
  );
}

function isEventStale(evt, maxAgeMs) {
  const ts = eventTs(evt);
  return Date.now() - ts > maxAgeMs;
}

function epochToMs(value) {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 1e12 ? Math.trunc(n) : Math.trunc(n * 1000);
}

function envelopeValidUntilUnix(evt) {
  const body = isObject(evt?.message?.body) ? evt.message.body : {};
  const n = toIntOrNull(body?.valid_until_unix);
  return n !== null && n > 0 ? n : null;
}

function isEnvelopeExpired(evt, nowSec = Math.floor(Date.now() / 1000)) {
  const validUntil = envelopeValidUntilUnix(evt);
  return validUntil !== null && validUntil <= nowSec;
}

function isPermanentNegotiationError(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return false;
  if (s.includes(' expired')) return true;
  if (s.includes('terminal')) return true;
  if (s.includes('already joined')) return true;
  if (s.includes('already accepted')) return true;
  if (s.includes('already active')) return true;
  if (s.includes('already in progress')) return true;
  if (s.includes('already open')) return true;
  if (s.includes('swap_invite_exists')) return true;
  if (s.includes('listing_in_progress')) return true;
  if (s.includes('listing_filled')) return true;
  if (s.includes('quote_accept already exists')) return true;
  return false;
}

function pruneSetByLimit(set, limit) {
  const max = Math.max(1, Math.trunc(Number(limit) || 1));
  while (set.size > max) {
    const first = set.values().next().value;
    if (first === undefined) break;
    set.delete(first);
  }
}

function pruneMapByLimit(map, limit) {
  const max = Math.max(1, Math.trunc(Number(limit) || 1));
  while (map.size > max) {
    const first = map.keys().next().value;
    if (first === undefined) break;
    map.delete(first);
  }
}

function matchOfferForRfq({ rfqEvt, myOfferEvents }) {
  const rfqMsg = rfqEvt?.message;
  const rfqBody = rfqMsg?.body && typeof rfqMsg.body === 'object' ? rfqMsg.body : null;
  if (!rfqBody) return null;

  const rfqBtc = toIntOrNull(rfqBody.btc_sats);
  const rfqUsdt = String(rfqBody.usdt_amount || '').trim();
  if (rfqBtc === null || rfqBtc < 1 || !/^[0-9]+$/.test(rfqUsdt)) return null;

  const rfqMaxPlatform = Math.max(0, Math.min(500, toIntOrNull(rfqBody.max_platform_fee_bps) ?? 500));
  const rfqMaxTrade = Math.max(0, Math.min(1000, toIntOrNull(rfqBody.max_trade_fee_bps) ?? 1000));
  const rfqMaxTotal = Math.max(0, Math.min(1500, toIntOrNull(rfqBody.max_total_fee_bps) ?? 1500));
  const rfqMinWin = Math.max(3600, Math.min(7 * 24 * 3600, toIntOrNull(rfqBody.min_sol_refund_window_sec) ?? 3600));
  const rfqMaxWin = Math.max(3600, Math.min(7 * 24 * 3600, toIntOrNull(rfqBody.max_sol_refund_window_sec) ?? 7 * 24 * 3600));
  if (rfqMinWin > rfqMaxWin) return null;

  const rfqChannel = String(rfqEvt?.channel || '').trim();
  const nowSec = Math.floor(Date.now() / 1000);
  for (const offerEvt of myOfferEvents) {
    const msg = offerEvt?.message;
    const body = msg?.body && typeof msg.body === 'object' ? msg.body : null;
    if (!body) continue;

    const validUntil = toIntOrNull(body.valid_until_unix);
    if (validUntil !== null && validUntil <= nowSec) continue;

    const rfqChannels = Array.isArray(body.rfq_channels)
      ? body.rfq_channels.map((c) => String(c || '').trim()).filter(Boolean)
      : [];
    if (rfqChannels.length > 0 && rfqChannel && !rfqChannels.includes(rfqChannel)) continue;

    const offers = Array.isArray(body.offers) ? body.offers : [];
    for (const lineRaw of offers) {
      const line = isObject(lineRaw) ? lineRaw : null;
      if (!line) continue;
      const lineBtc = toIntOrNull(line.btc_sats);
      const lineUsdt = String(line.usdt_amount || '').trim();
      if (lineBtc === null || lineBtc < 1 || !/^[0-9]+$/.test(lineUsdt)) continue;
      if (lineBtc !== rfqBtc || lineUsdt !== rfqUsdt) continue;

      const lineMaxPlatform = Math.max(0, Math.min(500, toIntOrNull(line.max_platform_fee_bps) ?? 500));
      const lineMaxTrade = Math.max(0, Math.min(1000, toIntOrNull(line.max_trade_fee_bps) ?? 1000));
      const lineMaxTotal = Math.max(0, Math.min(1500, toIntOrNull(line.max_total_fee_bps) ?? 1500));
      if (lineMaxPlatform > rfqMaxPlatform || lineMaxTrade > rfqMaxTrade || lineMaxTotal > rfqMaxTotal) continue;

      const lineMinWin = Math.max(3600, Math.min(7 * 24 * 3600, toIntOrNull(line.min_sol_refund_window_sec) ?? 3600));
      const lineMaxWin = Math.max(3600, Math.min(7 * 24 * 3600, toIntOrNull(line.max_sol_refund_window_sec) ?? 7 * 24 * 3600));
      const overlapMin = Math.max(rfqMinWin, lineMinWin);
      const overlapMax = Math.min(rfqMaxWin, lineMaxWin);
      if (overlapMin > overlapMax) continue;

      let solRefundWindowSec = 72 * 3600;
      if (solRefundWindowSec < overlapMin) solRefundWindowSec = overlapMin;
      if (solRefundWindowSec > overlapMax) solRefundWindowSec = overlapMax;
      return { solRefundWindowSec };
    }
  }
  return null;
}

function normalizeTraceText(value, maxLen = 320) {
  const s = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  const max = Number.isFinite(maxLen) ? Math.max(1, Math.trunc(maxLen)) : 320;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function parseLnRoutePrecheckStatus(statusRows, { payerPeer = '' } = {}) {
  const wantSigner = normalizePeerHex(payerPeer);
  const out = {
    ok_ts: 0,
    ok_note: '',
    ok_signer: '',
    fail_ts: 0,
    fail_note: '',
    fail_signer: '',
  };
  const rows = Array.isArray(statusRows) ? statusRows : [];
  for (const row of rows) {
    const msg = isObject(row?.message) ? row.message : null;
    if (!msg) continue;
    const signer = normalizePeerHex(row?.signer || msg?.signer || '');
    if (wantSigner && signer && signer !== wantSigner) continue;
    const body = isObject(msg?.body) ? msg.body : {};
    const state = String(body?.state || '').trim().toLowerCase();
    if (state !== 'accepted') continue;
    const note = String(body?.note || '').trim();
    if (!note) continue;
    const ts = Number(row?.ts || msg?.ts || 0);
    const at = Number.isFinite(ts) && ts > 0 ? Math.trunc(ts) : Date.now();
    if (/^ln_route_precheck_ok(?:\b|[:; ])?/i.test(note)) {
      if (at >= Number(out.ok_ts || 0)) {
        out.ok_ts = at;
        out.ok_note = note;
        out.ok_signer = signer || '';
      }
      continue;
    }
    if (/^ln_route_precheck_fail(?:\b|[:; ])?/i.test(note)) {
      if (at >= Number(out.fail_ts || 0)) {
        out.fail_ts = at;
        out.fail_note = note;
        out.fail_signer = signer || '';
      }
    }
  }
  return out;
}

export class TradeAutoManager {
  constructor({
    runTool,
    scLogInfo,
    scLogRead,
    logger = null,
  }) {
    if (typeof runTool !== 'function') throw new Error('TradeAutoManager: runTool is required');
    if (typeof scLogInfo !== 'function') throw new Error('TradeAutoManager: scLogInfo is required');
    if (typeof scLogRead !== 'function') throw new Error('TradeAutoManager: scLogRead is required');

    this.runTool = runTool;
    this.scLogInfo = scLogInfo;
    this.scLogRead = scLogRead;
    this.logger = typeof logger === 'function' ? logger : null;

    this.running = false;
    this.opts = null;
    this._timer = null;
    this._tickInFlight = false;
    this._traceEnabled = false;

    this._lastSeq = 0;
    this._events = [];
    this._eventsMax = 2000;
    this._dedupeMax = 6000;
    this._stageMax = 6000;
    this._preimageMax = 2000;
    this._lockMaxAgeMs = 20 * 60 * 1000;
    this._doneMaxAgeMs = 40 * 60 * 1000;
    this._debugMax = 500;
    this._debugEvents = [];
    this._toolTimeoutMs = 25_000;
    this._scEnsureIntervalMs = 5_000;
    this._nextScEnsureAt = 0;
    this._hygieneIntervalMs = 10_000;
    this._nextHygieneAt = 0;

    this._autoQuotedRfqSig = new Set();
    this._autoAcceptedQuoteSig = new Set();
    this._autoAcceptedTradeLock = new Map(); // trade_id -> locked_at_ms
    this._autoInvitedAcceptSig = new Set();
    this._autoJoinedInviteSig = new Set();
    this._stageDone = new Map(); // stage_key -> done_at_ms
    this._stageInFlight = new Set();
    this._stageRetryAfter = new Map();
    this._tradePreimage = new Map();
    this._notOwnerTraceAt = new Map(); // trade_id -> ts
    this._termsReplayByTrade = new Map(); // trade_id -> { count, nextAtMs, lastTs }
    this._swapAutoLeaveByTrade = new Map(); // trade_id -> { attempts, nextAtMs, lastTs }
    this._eventSeenAt = new Map(); // dedupe key -> seen_at_ms
    this._cachedLocalPeer = '';
    this._cachedLocalSolSigner = '';
    this._waitingTermsState = new Map(); // trade_id -> { firstSeenAt,lastTs,lastTraceAt,lastPingAt,nextPingAt,pings,timedOutAt }
    this._lnPayFailByTrade = new Map(); // trade_id -> { channel, failures, firstFailAt, lastFailAt, abortedAt, abortReason, lastAbortTraceAt }

    this._stats = {
      ticks: 0,
      actions: 0,
      last_tick_at: null,
      last_error: null,
      started_at: null,
    };
  }

  _log(msg) {
    if (this.logger) {
      try {
        this.logger(msg);
      } catch (_e) {}
    }
  }

  _trace(type, details = {}) {
    if (!this._traceEnabled) return;
    try {
      const evt = {
        ts: Date.now(),
        type: String(type || 'trace'),
        ...(details && typeof details === 'object' ? details : {}),
      };
      this._debugEvents.push(evt);
      if (this._debugEvents.length > this._debugMax) {
        this._debugEvents.splice(0, this._debugEvents.length - this._debugMax);
      }
    } catch (_e) {}
  }

  async _runToolWithTimeout({ tool, args }, { timeoutMs = null, label = '' } = {}) {
    const ms = Number.isFinite(timeoutMs) ? Math.max(250, Math.trunc(timeoutMs)) : this._toolTimeoutMs;
    let timer = null;
    try {
      return await Promise.race([
        this.runTool({ tool, args }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label || tool}: timeout after ${ms}ms`)), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  status() {
    return {
      type: 'tradeauto_status',
      running: this.running,
      options: this.opts || null,
      stats: { ...this._stats },
      trace_enabled: Boolean(this._traceEnabled),
      memory: {
        events: this._events.length,
        auto_quoted_rfq_sig: this._autoQuotedRfqSig.size,
        auto_accepted_quote_sig: this._autoAcceptedQuoteSig.size,
        auto_accepted_trade_lock: this._autoAcceptedTradeLock.size,
        auto_invited_accept_sig: this._autoInvitedAcceptSig.size,
        auto_joined_invite_sig: this._autoJoinedInviteSig.size,
        stage_done: this._stageDone.size,
        stage_in_flight: this._stageInFlight.size,
        stage_retry_after: this._stageRetryAfter.size,
        trade_preimage: this._tradePreimage.size,
        not_owner_trace_at: this._notOwnerTraceAt.size,
        terms_replay_by_trade: this._termsReplayByTrade.size,
        swap_auto_leave_by_trade: this._swapAutoLeaveByTrade.size,
        event_seen: this._eventSeenAt.size,
        waiting_terms_state: this._waitingTermsState.size,
        ln_pay_fail_by_trade: this._lnPayFailByTrade.size,
        debug_events: this._debugEvents.length,
      },
      recent_events: this._debugEvents.slice(-Math.min(200, this._debugMax)),
    };
  }

  setTraceEnabled(enabled) {
    this._traceEnabled = enabled === true;
    return {
      type: 'tradeauto_trace_set',
      running: this.running,
      trace_enabled: this._traceEnabled,
    };
  }

  async start(opts = {}) {
    if (this.running) {
      // Allow idempotent "start" calls to reconfigure trace mode while running.
      if (Object.prototype.hasOwnProperty.call(opts, 'trace_enabled')) {
        const prev = this._traceEnabled === true;
        const next = opts.trace_enabled === true;
        this._traceEnabled = next;
        if (this.opts && typeof this.opts === 'object') this.opts.trace_enabled = next;
        if (!prev && next) {
          this._trace('trace_enabled_runtime', { running: true });
        }
      }
      return { ...this.status(), type: 'tradeauto_already_running' };
    }

    const channels = sanitizeChannels(opts.channels || []);
    if (channels.length < 1) throw new Error('tradeauto_start: channels must be a non-empty array');

    const intervalMs = clampInt(toIntOrNull(opts.interval_ms), { min: 250, max: 10000, fallback: 1000 });
    const maxEvents = clampInt(toIntOrNull(opts.max_events), { min: 200, max: 4000, fallback: 1500 });
    const maxTrades = clampInt(toIntOrNull(opts.max_trades), { min: 10, max: 500, fallback: 120 });
    const eventMaxAgeMs = clampInt(toIntOrNull(opts.event_max_age_ms), { min: 30_000, max: 60 * 60 * 1000, fallback: 10 * 60 * 1000 });
    const dedupeMax = clampInt(toIntOrNull(opts.dedupe_max), {
      min: 500,
      max: 50_000,
      fallback: Math.max(2_000, maxEvents * 3),
    });
    const stageMax = clampInt(toIntOrNull(opts.stage_max), {
      min: 500,
      max: 50_000,
      fallback: Math.max(2_000, maxTrades * 25),
    });
    const preimageMax = clampInt(toIntOrNull(opts.preimage_max), {
      min: 100,
      max: 20_000,
      fallback: Math.max(500, maxTrades * 8),
    });
    const lockMaxAgeMs = clampInt(toIntOrNull(opts.lock_max_age_ms), {
      min: 30_000,
      max: 24 * 60 * 60 * 1000,
      fallback: Math.max(eventMaxAgeMs * 2, 5 * 60 * 1000),
    });
    const doneMaxAgeMs = clampInt(toIntOrNull(opts.done_max_age_ms), {
      min: 60_000,
      max: 24 * 60 * 60 * 1000,
      fallback: Math.max(eventMaxAgeMs * 4, 20 * 60 * 1000),
    });
    const debugMax = clampInt(toIntOrNull(opts.debug_max_events), {
      min: 50,
      max: 10_000,
      fallback: 600,
    });
    const toolTimeoutMs = clampInt(toIntOrNull(opts.tool_timeout_ms), {
      min: 250,
      max: 120_000,
      fallback: 25_000,
    });
    const scEnsureIntervalMs = clampInt(toIntOrNull(opts.sc_ensure_interval_ms), {
      min: 500,
      max: 60_000,
      fallback: 5_000,
    });
    const hygieneIntervalMs = clampInt(toIntOrNull(opts.hygiene_interval_ms), {
      min: 1_000,
      max: 60_000,
      fallback: 10_000,
    });
    const defaultSolRefundWindowSec = clampInt(toIntOrNull(opts.default_sol_refund_window_sec), {
      min: 3600,
      max: 7 * 24 * 3600,
      fallback: 72 * 3600,
    });
    const welcomeTtlSec = clampInt(toIntOrNull(opts.welcome_ttl_sec), { min: 30, max: 7 * 24 * 3600, fallback: 3600 });
    const termsReplayCooldownMs = clampInt(toIntOrNull(opts.terms_replay_cooldown_ms), {
      min: 1_000,
      max: 120_000,
      fallback: 6_000,
    });
    const termsReplayMax = clampInt(toIntOrNull(opts.terms_replay_max), {
      min: 1,
      max: 500,
      fallback: 40,
    });
    const swapAutoLeaveCooldownMs = clampInt(toIntOrNull(opts.swap_auto_leave_cooldown_ms), {
      min: 1_000,
      max: 120_000,
      fallback: 10_000,
    });
    const swapAutoLeaveMaxAttempts = clampInt(toIntOrNull(opts.swap_auto_leave_max_attempts), {
      min: 1,
      max: 50,
      fallback: 10,
    });
    const waitingTermsTraceCooldownMs = clampInt(toIntOrNull(opts.waiting_terms_trace_cooldown_ms), {
      min: 1_000,
      max: 120_000,
      fallback: 15_000,
    });
    const waitingTermsPingCooldownMs = clampInt(toIntOrNull(opts.waiting_terms_ping_cooldown_ms), {
      min: 1_000,
      max: 120_000,
      fallback: 15_000,
    });
    const waitingTermsMaxPings = clampInt(toIntOrNull(opts.waiting_terms_max_pings), {
      min: 0,
      max: 500,
      fallback: 20,
    });
    const waitingTermsMaxWaitMs = clampInt(toIntOrNull(opts.waiting_terms_max_wait_ms), {
      min: 5_000,
      max: 60 * 60 * 1000,
      fallback: 3 * 60 * 1000,
    });
    const waitingTermsLeaveOnTimeout = opts.waiting_terms_leave_on_timeout !== false;
    const lnPayFailLeaveAttempts = clampInt(toIntOrNull(opts.ln_pay_fail_leave_attempts), {
      min: 2,
      max: 50,
      fallback: 3,
    });
    const lnPayFailLeaveMinWaitMs = clampInt(toIntOrNull(opts.ln_pay_fail_leave_min_wait_ms), {
      min: 1_000,
      max: 60 * 60 * 1000,
      fallback: 20_000,
    });
    const lnPayRetryCooldownMs = clampInt(toIntOrNull(opts.ln_pay_retry_cooldown_ms), {
      min: 250,
      max: 120_000,
      fallback: 10_000,
    });
    const lnRoutePrecheckRetryCooldownMs = clampInt(toIntOrNull(opts.ln_route_precheck_retry_cooldown_ms), {
      min: 250,
      max: 120_000,
      fallback: 10_000,
    });
    const lnRoutePrecheckWaitCooldownMs = clampInt(toIntOrNull(opts.ln_route_precheck_wait_cooldown_ms), {
      min: 250,
      max: 120_000,
      fallback: 4_000,
    });
    const traceEnabled = opts.trace_enabled === true;

    const lnLiquidityModeRaw = String(opts.ln_liquidity_mode || 'aggregate').trim().toLowerCase();
    const lnLiquidityMode = lnLiquidityModeRaw === 'single_channel' ? 'single_channel' : 'aggregate';
    const usdtMint = String(opts.usdt_mint || '').trim();

    this.opts = {
      channels,
      interval_ms: intervalMs,
      max_events: maxEvents,
      max_trades: maxTrades,
      event_max_age_ms: eventMaxAgeMs,
      dedupe_max: dedupeMax,
      stage_max: stageMax,
      preimage_max: preimageMax,
      lock_max_age_ms: lockMaxAgeMs,
      done_max_age_ms: doneMaxAgeMs,
      debug_max_events: debugMax,
      tool_timeout_ms: toolTimeoutMs,
      sc_ensure_interval_ms: scEnsureIntervalMs,
      hygiene_interval_ms: hygieneIntervalMs,
      default_sol_refund_window_sec: defaultSolRefundWindowSec,
      welcome_ttl_sec: welcomeTtlSec,
      terms_replay_cooldown_ms: termsReplayCooldownMs,
      terms_replay_max: termsReplayMax,
      swap_auto_leave_cooldown_ms: swapAutoLeaveCooldownMs,
      swap_auto_leave_max_attempts: swapAutoLeaveMaxAttempts,
      waiting_terms_trace_cooldown_ms: waitingTermsTraceCooldownMs,
      waiting_terms_ping_cooldown_ms: waitingTermsPingCooldownMs,
      waiting_terms_max_pings: waitingTermsMaxPings,
      waiting_terms_max_wait_ms: waitingTermsMaxWaitMs,
      waiting_terms_leave_on_timeout: waitingTermsLeaveOnTimeout,
      ln_pay_fail_leave_attempts: lnPayFailLeaveAttempts,
      ln_pay_fail_leave_min_wait_ms: lnPayFailLeaveMinWaitMs,
      ln_pay_retry_cooldown_ms: lnPayRetryCooldownMs,
      ln_route_precheck_retry_cooldown_ms: lnRoutePrecheckRetryCooldownMs,
      ln_route_precheck_wait_cooldown_ms: lnRoutePrecheckWaitCooldownMs,
      trace_enabled: traceEnabled,
      ln_liquidity_mode: lnLiquidityMode,
      usdt_mint: usdtMint || null,
      enable_quote_from_offers: opts.enable_quote_from_offers !== false,
      enable_quote_from_rfqs: opts.enable_quote_from_rfqs === true,
      enable_accept_quotes: opts.enable_accept_quotes !== false,
      enable_invite_from_accepts: opts.enable_invite_from_accepts !== false,
      enable_join_invites: opts.enable_join_invites !== false,
      enable_settlement: opts.enable_settlement !== false,
      sol_cu_limit: toIntOrNull(opts.sol_cu_limit),
      sol_cu_price: toIntOrNull(opts.sol_cu_price),
    };

    this._lastSeq = 0;
    this._events = [];
    this._eventsMax = maxEvents;
    this._dedupeMax = dedupeMax;
    this._stageMax = stageMax;
    this._preimageMax = preimageMax;
    this._lockMaxAgeMs = lockMaxAgeMs;
    this._doneMaxAgeMs = doneMaxAgeMs;
    this._debugMax = debugMax;
    this._debugEvents = [];
    this._toolTimeoutMs = toolTimeoutMs;
    this._traceEnabled = traceEnabled;
    this._scEnsureIntervalMs = scEnsureIntervalMs;
    this._nextScEnsureAt = 0;
    this._hygieneIntervalMs = hygieneIntervalMs;
    this._nextHygieneAt = 0;
    this._autoQuotedRfqSig.clear();
    this._autoAcceptedQuoteSig.clear();
    this._autoAcceptedTradeLock.clear();
    this._autoInvitedAcceptSig.clear();
    this._autoJoinedInviteSig.clear();
    this._stageDone.clear();
    this._stageInFlight.clear();
    this._stageRetryAfter.clear();
    this._tradePreimage.clear();
    this._notOwnerTraceAt.clear();
    this._termsReplayByTrade.clear();
    this._swapAutoLeaveByTrade.clear();
    this._eventSeenAt.clear();
    this._cachedLocalPeer = '';
    this._cachedLocalSolSigner = '';
    this._waitingTermsState.clear();
    this._lnPayFailByTrade.clear();

    this._stats = {
      ticks: 0,
      actions: 0,
      last_tick_at: Date.now(),
      last_error: null,
      started_at: Date.now(),
    };
    this._trace('tradeauto_start', {
      channels,
      interval_ms: intervalMs,
      max_events: maxEvents,
      max_trades: maxTrades,
      ln_liquidity_mode: lnLiquidityMode,
      hygiene_interval_ms: hygieneIntervalMs,
      terms_replay_cooldown_ms: termsReplayCooldownMs,
      terms_replay_max: termsReplayMax,
      swap_auto_leave_cooldown_ms: swapAutoLeaveCooldownMs,
      swap_auto_leave_max_attempts: swapAutoLeaveMaxAttempts,
      waiting_terms_trace_cooldown_ms: waitingTermsTraceCooldownMs,
      waiting_terms_ping_cooldown_ms: waitingTermsPingCooldownMs,
      waiting_terms_max_pings: waitingTermsMaxPings,
      waiting_terms_max_wait_ms: waitingTermsMaxWaitMs,
      waiting_terms_leave_on_timeout: waitingTermsLeaveOnTimeout,
      ln_pay_fail_leave_attempts: lnPayFailLeaveAttempts,
      ln_pay_fail_leave_min_wait_ms: lnPayFailLeaveMinWaitMs,
      ln_pay_retry_cooldown_ms: lnPayRetryCooldownMs,
      ln_route_precheck_retry_cooldown_ms: lnRoutePrecheckRetryCooldownMs,
      ln_route_precheck_wait_cooldown_ms: lnRoutePrecheckWaitCooldownMs,
      trace_enabled: traceEnabled,
      enable_quote_from_rfqs: opts.enable_quote_from_rfqs === true,
    });

    await this._runToolWithTimeout(
      { tool: 'intercomswap_sc_subscribe', args: { channels } },
      { timeoutMs: Math.min(this._toolTimeoutMs, 10_000), label: 'tradeauto_start_subscribe' }
    );
    this._nextScEnsureAt = Date.now() + this._scEnsureIntervalMs;

    this.running = true;
    this._timer = setInterval(() => {
      void this._tick().catch((err) => {
        this._stats.last_error = err?.message || String(err);
      });
    }, intervalMs);
    await this._tick();

    return { type: 'tradeauto_started', ...this.status() };
  }

  async stop({ reason = 'stopped' } = {}) {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this.running = false;
    this._tickInFlight = false;
    this._stats.last_error = reason ? String(reason) : null;
    this._lastSeq = 0;
    this._events = [];
    this._autoQuotedRfqSig.clear();
    this._autoAcceptedQuoteSig.clear();
    this._autoAcceptedTradeLock.clear();
    this._autoInvitedAcceptSig.clear();
    this._autoJoinedInviteSig.clear();
    this._stageDone.clear();
    this._stageInFlight.clear();
    this._stageRetryAfter.clear();
    this._tradePreimage.clear();
    this._notOwnerTraceAt.clear();
    this._termsReplayByTrade.clear();
    this._swapAutoLeaveByTrade.clear();
    this._eventSeenAt.clear();
    this._cachedLocalPeer = '';
    this._cachedLocalSolSigner = '';
    this._waitingTermsState.clear();
    this._lnPayFailByTrade.clear();
    this._traceEnabled = false;
    this._trace('tradeauto_stop', { reason: String(reason || 'stopped') });
    return { type: 'tradeauto_stopped', reason: String(reason || 'stopped'), ...this.status() };
  }

  _canRunStage(stageKey) {
    if (!stageKey) return false;
    if (this._stageDone.has(stageKey)) return false;
    if (this._stageInFlight.has(stageKey)) return false;
    const retryAfter = this._stageRetryAfter.get(stageKey) || 0;
    return Date.now() >= retryAfter;
  }

  _markStageInFlight(stageKey) {
    if (!stageKey) return;
    this._stageInFlight.add(stageKey);
  }

  _markStageSuccess(stageKey) {
    if (!stageKey) return;
    this._stageInFlight.delete(stageKey);
    this._stageRetryAfter.delete(stageKey);
    this._stageDone.set(stageKey, Date.now());
    this._trace('stage_ok', { stage: String(stageKey) });
  }

  _markStageRetry(stageKey, cooldownMs) {
    if (!stageKey) return;
    this._stageInFlight.delete(stageKey);
    const ms = Math.max(250, Math.trunc(cooldownMs || 250));
    this._stageRetryAfter.set(stageKey, Date.now() + ms);
    this._trace('stage_retry', { stage: String(stageKey), cooldown_ms: ms });
  }

  _recordLnPayFailure({ tradeId, channel, error, forceAbort = false }) {
    if (!tradeId || !channel) return { state: null, shouldAbort: false, elapsedMs: 0 };
    const now = Date.now();
    const normalizedChannel = String(channel || '').trim();
    const prev = this._lnPayFailByTrade.get(tradeId);
    let state;
    if (!prev || String(prev.channel || '').trim() !== normalizedChannel) {
      state = {
        channel: normalizedChannel,
        failures: 0,
        firstFailAt: now,
        lastFailAt: 0,
        abortedAt: 0,
        abortReason: '',
        lastAbortTraceAt: 0,
      };
    } else {
      state = { ...prev };
    }

    state.failures = Number(state.failures || 0) + 1;
    state.lastFailAt = now;
    if (!Number.isFinite(Number(state.firstFailAt)) || Number(state.firstFailAt) <= 0) state.firstFailAt = now;

    const threshold = Math.max(2, Number(this.opts?.ln_pay_fail_leave_attempts || 3));
    const minWaitMs = Math.max(1_000, Number(this.opts?.ln_pay_fail_leave_min_wait_ms || 20_000));
    if (forceAbort) {
      state.failures = Math.max(Number(state.failures || 0), threshold);
      const forcedFirstFailAt = now - minWaitMs;
      if (!Number.isFinite(Number(state.firstFailAt)) || Number(state.firstFailAt) > forcedFirstFailAt) {
        state.firstFailAt = forcedFirstFailAt;
      }
    }
    const elapsedMs = Math.max(0, now - Number(state.firstFailAt || now));

    const shouldAbort = Number(state.failures || 0) >= threshold && elapsedMs >= minWaitMs;
    if (shouldAbort && !Number(state.abortedAt || 0)) {
      state.abortedAt = now;
      state.abortReason = String(error || '').trim().slice(0, 1000);
    }
    this._lnPayFailByTrade.set(tradeId, state);
    return { state, shouldAbort, elapsedMs };
  }

  _eventRetryKey(flow, sig) {
    return `evt:${String(flow || '')}:${String(sig || '')}`;
  }

  _canRunEvent(flow, sig) {
    if (!sig) return false;
    const key = this._eventRetryKey(flow, sig);
    const retryAfter = this._stageRetryAfter.get(key) || 0;
    return Date.now() >= retryAfter;
  }

  _markEventRetry(flow, sig, cooldownMs = 5000) {
    if (!sig) return;
    const key = this._eventRetryKey(flow, sig);
    this._stageRetryAfter.set(key, Date.now() + Math.max(1000, Math.trunc(cooldownMs || 1000)));
  }

  _clearEventRetry(flow, sig) {
    if (!sig) return;
    this._stageRetryAfter.delete(this._eventRetryKey(flow, sig));
  }

  _pruneTradeCachesById(tradeId) {
    if (!tradeId) return;
    this._autoAcceptedTradeLock.delete(tradeId);
    this._tradePreimage.delete(tradeId);
    this._termsReplayByTrade.delete(tradeId);
    this._swapAutoLeaveByTrade.delete(tradeId);
    this._waitingTermsState.delete(tradeId);
    this._lnPayFailByTrade.delete(tradeId);
    const prefix = `${tradeId}:`;
    for (const key of Array.from(this._stageDone.keys())) {
      if (String(key).startsWith(prefix)) this._stageDone.delete(key);
    }
    for (const key of Array.from(this._stageInFlight.values())) {
      if (String(key).startsWith(prefix)) this._stageInFlight.delete(key);
    }
    for (const key of Array.from(this._stageRetryAfter.keys())) {
      if (String(key).startsWith(prefix)) this._stageRetryAfter.delete(key);
    }
  }

  _pruneCaches({ terminalTradeIds = null } = {}) {
    if (terminalTradeIds && typeof terminalTradeIds[Symbol.iterator] === 'function') {
      for (const tradeId of terminalTradeIds) this._pruneTradeCachesById(String(tradeId || '').trim());
    }

    const now = Date.now();
    for (const [tradeId, lockedAt] of Array.from(this._autoAcceptedTradeLock.entries())) {
      if (!tradeId) {
        this._autoAcceptedTradeLock.delete(tradeId);
        continue;
      }
      if (!Number.isFinite(lockedAt) || now - Number(lockedAt) > this._lockMaxAgeMs) {
        this._autoAcceptedTradeLock.delete(tradeId);
      }
    }

    for (const [stageKey, doneAt] of Array.from(this._stageDone.entries())) {
      if (!Number.isFinite(doneAt)) {
        this._stageDone.delete(stageKey);
        continue;
      }
      if (now - Number(doneAt) > this._doneMaxAgeMs) this._stageDone.delete(stageKey);
    }

    for (const [stageKey, retryAfter] of Array.from(this._stageRetryAfter.entries())) {
      if (!Number.isFinite(retryAfter)) {
        this._stageRetryAfter.delete(stageKey);
        continue;
      }
      if (now - Number(retryAfter) > this._doneMaxAgeMs) this._stageRetryAfter.delete(stageKey);
    }

    pruneSetByLimit(this._autoQuotedRfqSig, this._dedupeMax);
    pruneSetByLimit(this._autoAcceptedQuoteSig, this._dedupeMax);
    pruneMapByLimit(this._autoAcceptedTradeLock, Math.max(this.opts?.max_trades || 120, this._preimageMax));
    pruneSetByLimit(this._autoInvitedAcceptSig, this._dedupeMax);
    pruneSetByLimit(this._autoJoinedInviteSig, this._dedupeMax);
    pruneMapByLimit(this._stageDone, this._stageMax);
    pruneSetByLimit(this._stageInFlight, this._stageMax);
    pruneMapByLimit(this._stageRetryAfter, this._stageMax);
    pruneMapByLimit(this._tradePreimage, this._preimageMax);
    for (const [tradeId, ts] of Array.from(this._notOwnerTraceAt.entries())) {
      if (!Number.isFinite(ts) || now - Number(ts) > this._doneMaxAgeMs) this._notOwnerTraceAt.delete(tradeId);
    }
    pruneMapByLimit(this._notOwnerTraceAt, Math.max(this.opts?.max_trades || 120, this._preimageMax));
    for (const [tradeId, state] of Array.from(this._termsReplayByTrade.entries())) {
      const lastTs = Number(state?.lastTs || 0);
      if (!tradeId || !Number.isFinite(lastTs) || now - lastTs > this._doneMaxAgeMs) this._termsReplayByTrade.delete(tradeId);
    }
    pruneMapByLimit(this._termsReplayByTrade, Math.max(this.opts?.max_trades || 120, this._preimageMax));
    for (const [tradeId, state] of Array.from(this._swapAutoLeaveByTrade.entries())) {
      const lastTs = Number(state?.lastTs || 0);
      if (!tradeId || !Number.isFinite(lastTs) || now - lastTs > this._doneMaxAgeMs) this._swapAutoLeaveByTrade.delete(tradeId);
    }
    pruneMapByLimit(this._swapAutoLeaveByTrade, Math.max(this.opts?.max_trades || 120, this._preimageMax));
    for (const [tradeId, state] of Array.from(this._waitingTermsState.entries())) {
      const lastTs = Number(state?.lastTs || state?.firstSeenAt || state?.timedOutAt || 0);
      if (!tradeId || !Number.isFinite(lastTs) || now - lastTs > this._doneMaxAgeMs) this._waitingTermsState.delete(tradeId);
    }
    pruneMapByLimit(this._waitingTermsState, Math.max(this.opts?.max_trades || 120, this._preimageMax));
    for (const [tradeId, state] of Array.from(this._lnPayFailByTrade.entries())) {
      const lastTs = Number(state?.lastFailAt || state?.firstFailAt || state?.abortedAt || 0);
      if (!tradeId || !Number.isFinite(lastTs) || now - lastTs > this._doneMaxAgeMs) this._lnPayFailByTrade.delete(tradeId);
    }
    pruneMapByLimit(this._lnPayFailByTrade, Math.max(this.opts?.max_trades || 120, this._preimageMax));

    for (const [k, seenAt] of Array.from(this._eventSeenAt.entries())) {
      if (!k || !Number.isFinite(seenAt) || now - Number(seenAt) > this._doneMaxAgeMs) this._eventSeenAt.delete(k);
    }
    pruneMapByLimit(this._eventSeenAt, Math.max(this._dedupeMax * 4, this._eventsMax * 2));
  }

  _appendEvents(events) {
    if (!Array.isArray(events) || events.length < 1) return;
    const now = Date.now();
    for (const e of events) {
      const key = eventDedupKey(e);
      if (key) {
        const seenAt = Number(this._eventSeenAt.get(key) || 0);
        if (seenAt > 0 && now - seenAt <= this._doneMaxAgeMs) continue;
        this._eventSeenAt.set(key, now);
      }
      this._events.push(e);
    }
    if (this._events.length > this._eventsMax) {
      this._events.splice(0, this._events.length - this._eventsMax);
    }
  }

  _buildContexts({ events, localPeer }) {
    const myRfqTradeIds = new Set();
    const myQuoteById = new Map();
    const myQuoteTradeIds = new Set();
    const myOfferEvents = [];
    const quoteEvents = [];
    const acceptEvents = [];
    const inviteEvents = [];
    const terminalTradeIds = new Set();

    const swapNegotiationByTrade = new Map();
    const swapTradeContextsByTrade = new Map();

    for (const e of events) {
      const kind = envelopeKind(e);
      if (!kind.startsWith('swap.')) continue;
      const msg = e?.message && typeof e.message === 'object' ? e.message : null;
      if (!msg) continue;
      const tradeId = envelopeTradeId(e);
      const signer = envelopeSigner(e);
      const local = isLocalEvent(e) || (localPeer && signer === localPeer);

      if (kind === 'swap.rfq' && local && tradeId) myRfqTradeIds.add(tradeId);

      if (kind === 'swap.quote') {
        const quoteId = (() => {
          try {
            const unsigned = stripSignature(msg);
            const id = hashUnsignedEnvelope(unsigned);
            return String(id || '').trim().toLowerCase();
          } catch (_e) {
            const s = String(msg?.body?.rfq_id || '').trim();
            const t = String(msg?.trade_id || '').trim();
            return `${t}:${s}:${eventTs(e)}`;
          }
        })();
        if (local) {
          myQuoteById.set(quoteId, { event: e, envelope: msg, channel: String(e?.channel || '').trim() });
          if (tradeId) myQuoteTradeIds.add(tradeId);
        }
        else quoteEvents.push(e);
      }

      if (kind === 'swap.svc_announce' && local) myOfferEvents.push(e);
      if (kind === 'swap.quote_accept' && !local) acceptEvents.push(e);
      if (kind === 'swap.swap_invite' && !local) inviteEvents.push(e);

      if (tradeId) {
        let neg = swapNegotiationByTrade.get(tradeId);
        if (!neg) {
          neg = {
            trade_id: tradeId,
            rfq: null,
            quote: null,
            quote_accept: null,
            swap_invite: null,
            swap_channel: '',
            rfq_channel: '',
            quote_channel: '',
            quote_accept_channel: '',
            swap_invite_channel: '',
            rfq_ts: 0,
            quote_ts: 0,
            quote_accept_ts: 0,
            swap_invite_ts: 0,
          };
          swapNegotiationByTrade.set(tradeId, neg);
        }
        const ts = eventTs(e);
        const evtChannel = String(e?.channel || '').trim();
        if (kind === 'swap.rfq') {
          if (!neg.rfq || ts >= Number(neg.rfq_ts || 0)) {
            neg.rfq = msg;
            neg.rfq_ts = ts;
            if (evtChannel) neg.rfq_channel = evtChannel;
          }
        } else if (kind === 'swap.quote') {
          if (!neg.quote || ts >= Number(neg.quote_ts || 0)) {
            neg.quote = msg;
            neg.quote_ts = ts;
            if (evtChannel) neg.quote_channel = evtChannel;
          }
        } else if (kind === 'swap.quote_accept') {
          if (!neg.quote_accept || ts >= Number(neg.quote_accept_ts || 0)) {
            neg.quote_accept = msg;
            neg.quote_accept_ts = ts;
            if (evtChannel) neg.quote_accept_channel = evtChannel;
          }
        } else if (kind === 'swap.swap_invite') {
          if (!neg.swap_invite || ts >= Number(neg.swap_invite_ts || 0)) {
            neg.swap_invite = msg;
            neg.swap_invite_ts = ts;
            if (evtChannel) neg.swap_invite_channel = evtChannel;
            const ch = String(msg?.body?.swap_channel || '').trim();
            if (ch) neg.swap_channel = ch;
          }
        }
      }

      const ch = String(e?.channel || '').trim();
      if (tradeId && ch.startsWith('swap:')) {
        let ctx = swapTradeContextsByTrade.get(tradeId);
        if (!ctx) {
          ctx = {
            trade_id: tradeId,
            channel: ch,
            last_ts: 0,
            terms: null,
            accept: null,
            invoice: null,
            escrow: null,
            ln_paid: null,
            statuses: [],
            claimed: null,
            refunded: null,
            canceled: null,
          };
          swapTradeContextsByTrade.set(tradeId, ctx);
        }
        const ts = eventTs(e);
        if (ts > Number(ctx.last_ts || 0)) ctx.last_ts = ts;
        if (ch) ctx.channel = ch;
        if (kind === 'swap.terms') ctx.terms = msg;
        else if (kind === 'swap.accept') ctx.accept = msg;
        else if (kind === 'swap.ln_invoice') ctx.invoice = msg;
        else if (kind === 'swap.sol_escrow_created') ctx.escrow = msg;
        else if (kind === 'swap.ln_paid') ctx.ln_paid = msg;
        else if (kind === 'swap.status') {
          if (!Array.isArray(ctx.statuses)) ctx.statuses = [];
          ctx.statuses.push({ message: msg, signer, ts });
          if (ctx.statuses.length > 40) {
            ctx.statuses.splice(0, ctx.statuses.length - 40);
          }
        }
        else if (kind === 'swap.sol_claimed') {
          ctx.claimed = msg;
          terminalTradeIds.add(tradeId);
        } else if (kind === 'swap.sol_refunded') {
          ctx.refunded = msg;
          terminalTradeIds.add(tradeId);
        } else if (kind === 'swap.cancel') {
          ctx.canceled = msg;
          terminalTradeIds.add(tradeId);
        }
      }
    }

    // Synthesize provisional swap contexts from negotiation events so settlement can proceed
    // even before the first swap:* message arrives (prevents invite/join stalls).
    for (const [tradeId, neg] of swapNegotiationByTrade.entries()) {
      if (!tradeId) continue;
      const swapCh = String(neg?.swap_channel || '').trim();
      if (!swapCh || !swapCh.startsWith('swap:')) continue;
      let ctx = swapTradeContextsByTrade.get(tradeId);
      if (!ctx) {
        const lastTs = Math.max(
          Number(neg?.swap_invite_ts || 0),
          Number(neg?.quote_accept_ts || 0),
          Number(neg?.quote_ts || 0),
          Number(neg?.rfq_ts || 0)
        );
        ctx = {
          trade_id: tradeId,
          channel: swapCh,
          last_ts: Number.isFinite(lastTs) ? lastTs : 0,
          terms: null,
          accept: null,
          invoice: null,
          escrow: null,
          ln_paid: null,
          statuses: [],
          claimed: null,
          refunded: null,
          canceled: null,
        };
        swapTradeContextsByTrade.set(tradeId, ctx);
      } else if (!String(ctx.channel || '').trim()) {
        ctx.channel = swapCh;
      }
    }

    const swapTradeContexts = Array.from(swapTradeContextsByTrade.values()).sort((a, b) => Number(b.last_ts || 0) - Number(a.last_ts || 0));

    return {
      myRfqTradeIds,
      myQuoteById,
      myQuoteTradeIds,
      myOfferEvents,
      quoteEvents,
      acceptEvents,
      inviteEvents,
      swapNegotiationByTrade,
      swapTradeContexts,
      swapTradeContextsByTrade,
      terminalTradeIds,
    };
  }

  async _autoLeaveStaleSwapChannels({ ctx, joinedChannels }) {
    if (!ctx || !Array.isArray(joinedChannels) || joinedChannels.length < 1) return;
    const joinedSet = new Set(joinedChannels.map((c) => String(c || '').trim()).filter(Boolean));
    const now = Date.now();
    const maxAttempts = Number(this.opts?.swap_auto_leave_max_attempts || 10);
    const baseCooldownMs = Number(this.opts?.swap_auto_leave_cooldown_ms || 10_000);

    const candidateByTrade = new Map();
    for (const tradeCtx of Array.isArray(ctx.swapTradeContexts) ? ctx.swapTradeContexts : []) {
      const tradeId = String(tradeCtx?.trade_id || '').trim();
      const swapChannel = String(tradeCtx?.channel || '').trim();
      if (!tradeId || !swapChannel || !swapChannel.startsWith('swap:')) continue;
      candidateByTrade.set(tradeId, {
        tradeId,
        swapChannel,
        done: Boolean(tradeCtx?.claimed || tradeCtx?.refunded || tradeCtx?.canceled || ctx.terminalTradeIds.has(tradeId)),
        expiresAtMs: 0,
      });
    }
    for (const [tradeId, neg] of ctx.swapNegotiationByTrade.entries()) {
      const swapChannel = String(neg?.swap_channel || '').trim();
      if (!tradeId || !swapChannel || !swapChannel.startsWith('swap:')) continue;
      const row = candidateByTrade.get(tradeId) || { tradeId, swapChannel, done: false, expiresAtMs: 0 };
      row.swapChannel = row.swapChannel || swapChannel;
      row.done = row.done || ctx.terminalTradeIds.has(tradeId);
      row.expiresAtMs = Math.max(Number(row.expiresAtMs || 0), epochToMs(neg?.swap_invite?.body?.invite?.payload?.expiresAt));
      candidateByTrade.set(tradeId, row);
    }

    for (const [tradeId, row] of candidateByTrade.entries()) {
      if (!tradeId) continue;
      const swapChannel = String(row?.swapChannel || '').trim();
      if (!swapChannel || !swapChannel.startsWith('swap:')) continue;
      if (!joinedSet.has(swapChannel)) continue;

      const expiresAtMs = Number(row?.expiresAtMs || 0);
      const expired = expiresAtMs > 0 && now > expiresAtMs;
      const done = Boolean(row?.done || ctx.terminalTradeIds.has(tradeId));
      if (!expired && !done) continue;

      const state = this._swapAutoLeaveByTrade.get(tradeId) || { attempts: 0, nextAtMs: 0, lastTs: 0 };
      if (state.attempts >= maxAttempts) continue;
      if (Number(state.nextAtMs || 0) > now) continue;

      try {
        await this._runToolWithTimeout(
          { tool: 'intercomswap_sc_leave', args: { channel: swapChannel } },
          { timeoutMs: Math.min(this._toolTimeoutMs, 10_000), label: 'tradeauto_sc_leave' }
        );
        this._swapAutoLeaveByTrade.delete(tradeId);
        this._trace('swap_auto_leave_ok', {
          trade_id: tradeId,
          channel: swapChannel,
          reason: done ? 'terminal' : 'expired',
        });
      } catch (err) {
        const attempts = Number(state.attempts || 0) + 1;
        const cooldownMs = Math.min(120_000, baseCooldownMs * Math.max(1, attempts));
        this._swapAutoLeaveByTrade.set(tradeId, {
          attempts,
          nextAtMs: now + cooldownMs,
          lastTs: now,
        });
        this._trace('swap_auto_leave_fail', {
          trade_id: tradeId,
          channel: swapChannel,
          attempts,
          error: err?.message || String(err),
        });
      }
    }
  }

  async _tick() {
    if (!this.running) return;
    if (this._tickInFlight) return;
    this._tickInFlight = true;
    try {
      const logInfo = this.scLogInfo() || {};
      if (Date.now() >= this._nextScEnsureAt) {
        try {
          await this._runToolWithTimeout(
            { tool: 'intercomswap_sc_subscribe', args: { channels: this.opts.channels } },
            { timeoutMs: Math.min(this._toolTimeoutMs, 10_000), label: 'tradeauto_sc_keepalive' }
          );
        } catch (err) {
          this._trace('sc_keepalive_fail', { error: err?.message || String(err) });
        } finally {
          this._nextScEnsureAt = Date.now() + this._scEnsureIntervalMs;
        }
      }
      const latestSeq = Number.isFinite(logInfo.latest_seq) ? Math.max(0, Math.trunc(logInfo.latest_seq)) : 0;
      const sinceSeq = this._lastSeq > 0 ? this._lastSeq : Math.max(0, latestSeq - this.opts.max_events);
      const read = this.scLogRead({ sinceSeq, limit: this.opts.max_events }) || {};
      const events = Array.isArray(read.events) ? read.events : [];
      if (events.length > 0) {
        this._appendEvents(events);
      }
      this._lastSeq = Number.isFinite(read.latest_seq) ? Math.max(this._lastSeq, Math.trunc(read.latest_seq)) : this._lastSeq;

      let localPeer = '';
      try {
        const scInfo = await this._runToolWithTimeout(
          { tool: 'intercomswap_sc_info', args: {} },
          { timeoutMs: Math.min(this._toolTimeoutMs, 8_000), label: 'tradeauto_sc_info' }
        );
        localPeer = localPeerFromScInfo(scInfo);
        if (localPeer) this._cachedLocalPeer = localPeer;
      } catch (err) {
        localPeer = String(this._cachedLocalPeer || '').trim().toLowerCase();
        this._trace('sc_info_warn', {
          fallback_cached: Boolean(localPeer),
          error: err?.message || String(err),
        });
      }
      let localSolSigner = '';
      try {
        localSolSigner = String(
          (
            await this._runToolWithTimeout(
              { tool: 'intercomswap_sol_signer_pubkey', args: {} },
              { timeoutMs: Math.min(this._toolTimeoutMs, 8_000), label: 'tradeauto_sol_signer' }
            )
          )?.pubkey || ''
        ).trim();
        if (localSolSigner) this._cachedLocalSolSigner = localSolSigner;
      } catch (err) {
        localSolSigner = String(this._cachedLocalSolSigner || '').trim();
        this._trace('sol_signer_warn', {
          fallback_cached: Boolean(localSolSigner),
          error: err?.message || String(err),
        });
      }

      const activeEvents = this._events.filter((e) => !isEventStale(e, this.opts.event_max_age_ms));
      const ctx = this._buildContexts({ events: activeEvents, localPeer });

      for (const tid of Array.from(this._autoAcceptedTradeLock.keys())) {
        if (ctx.terminalTradeIds.has(tid)) this._autoAcceptedTradeLock.delete(tid);
      }
      this._pruneCaches({ terminalTradeIds: ctx.terminalTradeIds });

      if (Date.now() >= this._nextHygieneAt) {
        try {
          const scStats = await this._runToolWithTimeout(
            { tool: 'intercomswap_sc_stats', args: {} },
            { timeoutMs: Math.min(this._toolTimeoutMs, 8_000), label: 'tradeauto_sc_stats' }
          );
          const joinedChannels = Array.isArray(scStats?.channels) ? scStats.channels.map((c) => String(c || '').trim()).filter(Boolean) : [];
          await this._autoLeaveStaleSwapChannels({ ctx, joinedChannels });
        } catch (err) {
          this._trace('swap_auto_leave_scan_fail', { error: err?.message || String(err) });
        } finally {
          this._nextHygieneAt = Date.now() + this._hygieneIntervalMs;
        }
      }

      let actionsLeft = 12;

      if ((this.opts.enable_quote_from_offers || this.opts.enable_quote_from_rfqs) && actionsLeft > 0) {
        const nowSec = Math.floor(Date.now() / 1000);
        const rfqQueue = [...activeEvents]
          .filter((e) => envelopeKind(e) === 'swap.rfq')
          .reverse();
        for (const rfqEvt of rfqQueue) {
          if (actionsLeft <= 0) break;
          if (isLocalEvent(rfqEvt)) continue;
          const sig = envelopeSig(rfqEvt);
          if (!sig || this._autoQuotedRfqSig.has(sig)) continue;
          if (!this._canRunEvent('quote_from_offer', sig)) continue;
          if (isEnvelopeExpired(rfqEvt, nowSec)) {
            this._autoQuotedRfqSig.add(sig);
            this._clearEventRetry('quote_from_offer', sig);
            this._trace('auto_quote_skip_expired_rfq', {
              trade_id: envelopeTradeId(rfqEvt),
              channel: String(rfqEvt?.channel || '').trim(),
              sig: sig.slice(0, 16),
            });
            continue;
          }
          const tradeId = envelopeTradeId(rfqEvt);
          const tradeBusy = (() => {
            if (!tradeId) return false;
            if (ctx.terminalTradeIds && typeof ctx.terminalTradeIds.has === 'function' && ctx.terminalTradeIds.has(tradeId)) return true;
            if (this._autoAcceptedTradeLock.has(tradeId)) return true;
            const neg = ctx.swapNegotiationByTrade && typeof ctx.swapNegotiationByTrade.get === 'function'
              ? ctx.swapNegotiationByTrade.get(tradeId)
              : null;
            if (isObject(neg?.quote_accept) || isObject(neg?.swap_invite)) return true;
            const swapCtx = ctx.swapTradeContextsByTrade && typeof ctx.swapTradeContextsByTrade.get === 'function'
              ? ctx.swapTradeContextsByTrade.get(tradeId)
              : null;
            if (!swapCtx) return false;
            return Boolean(
              swapCtx.terms ||
                swapCtx.accept ||
                swapCtx.invoice ||
                swapCtx.escrow ||
                swapCtx.ln_paid ||
                swapCtx.claimed ||
                swapCtx.refunded ||
                swapCtx.canceled
            );
          })();
          if (tradeBusy) {
            continue;
          }
          const match = matchOfferForRfq({ rfqEvt, myOfferEvents: ctx.myOfferEvents });
          if (!match && this.opts.enable_quote_from_rfqs !== true) continue;
          const refundWindowSec =
            match && Number.isFinite(Number(match.solRefundWindowSec))
              ? Number(match.solRefundWindowSec)
              : Number(this.opts.default_sol_refund_window_sec || 72 * 3600);
          try {
            const ch = String(rfqEvt?.channel || '').trim();
            if (!ch) continue;
            await this._runToolWithTimeout({
              tool: 'intercomswap_quote_post_from_rfq',
              args: {
                channel: ch,
                rfq_envelope: rfqEvt.message,
                trade_fee_collector: localSolSigner,
                sol_refund_window_sec: refundWindowSec,
                valid_for_sec: 180,
              },
            });
            this._trace('auto_quote_ok', {
              trade_id: envelopeTradeId(rfqEvt),
              channel: ch,
              sig: sig.slice(0, 16),
              source: match ? 'offer_match' : 'rfq_auto',
            });
            this._autoQuotedRfqSig.add(sig);
            this._clearEventRetry('quote_from_offer', sig);
            this._pruneCaches();
            actionsLeft -= 1;
            this._stats.actions += 1;
          } catch (err) {
            const errMsg = err?.message || String(err);
            this._trace('auto_quote_fail', {
              trade_id: envelopeTradeId(rfqEvt),
              channel: String(rfqEvt?.channel || '').trim(),
              sig: sig.slice(0, 16),
              error: errMsg,
            });
            if (isPermanentNegotiationError(errMsg)) {
              this._autoQuotedRfqSig.add(sig);
              this._clearEventRetry('quote_from_offer', sig);
              this._trace('auto_quote_drop_permanent', {
                trade_id: envelopeTradeId(rfqEvt),
                channel: String(rfqEvt?.channel || '').trim(),
                sig: sig.slice(0, 16),
                error: errMsg,
              });
            } else {
              this._markEventRetry('quote_from_offer', sig, 5000);
            }
            this._log(`[tradeauto] auto-quote failed: ${err?.message || String(err)}`);
          }
        }
      }

      if (this.opts.enable_accept_quotes && actionsLeft > 0) {
        const nowSec = Math.floor(Date.now() / 1000);
        const quoteQueue = [...ctx.quoteEvents].reverse();
        for (const quoteEvt of quoteQueue) {
          if (actionsLeft <= 0) break;
          if (isEventStale(quoteEvt, this.opts.event_max_age_ms)) continue;
          const sig = envelopeSig(quoteEvt);
          if (!sig || this._autoAcceptedQuoteSig.has(sig)) continue;
          if (!this._canRunEvent('accept_quote', sig)) continue;
          if (isEnvelopeExpired(quoteEvt, nowSec)) {
            this._autoAcceptedQuoteSig.add(sig);
            this._clearEventRetry('accept_quote', sig);
            this._trace('auto_accept_skip_expired_quote', {
              trade_id: envelopeTradeId(quoteEvt),
              channel: String(quoteEvt?.channel || '').trim(),
              quote_sig: sig.slice(0, 16),
            });
            continue;
          }
          const tradeId = envelopeTradeId(quoteEvt);
          if (!tradeId || !ctx.myRfqTradeIds.has(tradeId)) continue;
          if (ctx.terminalTradeIds.has(tradeId)) continue;
          if (this._autoAcceptedTradeLock.has(tradeId)) continue;
          try {
            await this._runToolWithTimeout({
              tool: 'intercomswap_quote_accept',
              args: {
                channel: String(quoteEvt?.channel || '').trim(),
                quote_envelope: quoteEvt.message,
                ln_liquidity_mode: this.opts.ln_liquidity_mode,
              },
            });
            this._trace('auto_accept_ok', {
              trade_id: tradeId,
              channel: String(quoteEvt?.channel || '').trim(),
              quote_sig: sig.slice(0, 16),
            });
            this._autoAcceptedQuoteSig.add(sig);
            this._clearEventRetry('accept_quote', sig);
            this._autoAcceptedTradeLock.set(tradeId, Date.now());
            this._pruneCaches();
            actionsLeft -= 1;
            this._stats.actions += 1;
          } catch (err) {
            const errMsg = err?.message || String(err);
            this._trace('auto_accept_fail', {
              trade_id: tradeId,
              channel: String(quoteEvt?.channel || '').trim(),
              quote_sig: sig.slice(0, 16),
              error: errMsg,
            });
            if (isPermanentNegotiationError(errMsg)) {
              this._autoAcceptedQuoteSig.add(sig);
              this._clearEventRetry('accept_quote', sig);
              this._trace('auto_accept_drop_permanent', {
                trade_id: tradeId,
                channel: String(quoteEvt?.channel || '').trim(),
                quote_sig: sig.slice(0, 16),
                error: errMsg,
              });
            } else {
              this._markEventRetry('accept_quote', sig, 5000);
            }
            this._log(`[tradeauto] auto-accept failed: ${err?.message || String(err)}`);
          }
        }
      }

      if (this.opts.enable_invite_from_accepts && actionsLeft > 0) {
        const accepts = [...ctx.acceptEvents].reverse();
        for (const e of accepts) {
          if (actionsLeft <= 0) break;
          if (isEventStale(e, this.opts.event_max_age_ms)) continue;
          const sig = envelopeSig(e);
          if (!sig || this._autoInvitedAcceptSig.has(sig)) continue;
          if (!this._canRunEvent('invite_from_accept', sig)) continue;
          const quoteId = String(e?.message?.body?.quote_id || '').trim().toLowerCase();
          const myQuote = ctx.myQuoteById.get(quoteId);
          if (!myQuote) continue;
          try {
            const tradeId = envelopeTradeId(e);
            const out = await this._runToolWithTimeout({
              tool: 'intercomswap_swap_invite_from_accept',
              args: {
                channel: String(e?.channel || myQuote.channel || '').trim(),
                accept_envelope: e.message,
                quote_envelope: myQuote.envelope,
                welcome_text: tradeId ? `Welcome to ${tradeId}` : 'Welcome to swap',
                ttl_sec: this.opts.welcome_ttl_sec,
              },
            });
            this._trace('auto_invite_ok', {
              trade_id: tradeId,
              channel: String(e?.channel || myQuote.channel || '').trim(),
              accept_sig: sig.slice(0, 16),
            });
            this._autoInvitedAcceptSig.add(sig);
            this._clearEventRetry('invite_from_accept', sig);
            this._pruneCaches();
            const swapCh = String(out?.swap_channel || '').trim();
            if (swapCh) {
              await this._runToolWithTimeout(
                { tool: 'intercomswap_sc_subscribe', args: { channels: [swapCh] } },
                { timeoutMs: Math.min(this._toolTimeoutMs, 10_000), label: 'tradeauto_swap_subscribe' }
              );
            }
            actionsLeft -= 1;
            this._stats.actions += 1;
          } catch (err) {
            const errMsg = err?.message || String(err);
            this._trace('auto_invite_fail', {
              trade_id: envelopeTradeId(e),
              channel: String(e?.channel || myQuote.channel || '').trim(),
              accept_sig: sig.slice(0, 16),
              error: errMsg,
            });
            if (isPermanentNegotiationError(errMsg)) {
              this._autoInvitedAcceptSig.add(sig);
              this._clearEventRetry('invite_from_accept', sig);
              this._trace('auto_invite_drop_permanent', {
                trade_id: envelopeTradeId(e),
                channel: String(e?.channel || myQuote.channel || '').trim(),
                accept_sig: sig.slice(0, 16),
                error: errMsg,
              });
            } else {
              this._markEventRetry('invite_from_accept', sig, 5000);
            }
            this._log(`[tradeauto] auto-invite failed: ${err?.message || String(err)}`);
          }
        }
      }

      if (this.opts.enable_join_invites && actionsLeft > 0) {
        const invites = [...ctx.inviteEvents].reverse();
        for (const e of invites) {
          if (actionsLeft <= 0) break;
          if (isEventStale(e, this.opts.event_max_age_ms)) continue;
          const sig = envelopeSig(e);
          if (!sig || this._autoJoinedInviteSig.has(sig)) continue;
          if (!this._canRunEvent('join_invite', sig)) continue;
          const tradeId = envelopeTradeId(e);
          if (tradeId && ctx.terminalTradeIds.has(tradeId)) continue;
          const invitee = String(e?.message?.body?.invite?.payload?.inviteePubKey || '').trim().toLowerCase();
          if (invitee && localPeer && invitee !== localPeer) {
            this._trace('auto_join_skip_invitee_mismatch', {
              trade_id: tradeId,
              channel: String(e?.channel || '').trim(),
              invite_sig: sig.slice(0, 16),
              invitee,
              local_peer: localPeer,
            });
            continue;
          }
          try {
            const out = await this._runToolWithTimeout({
              tool: 'intercomswap_join_from_swap_invite',
              args: { swap_invite_envelope: e.message },
            });
            this._trace('auto_join_ok', {
              trade_id: tradeId,
              channel: String(e?.channel || '').trim(),
              invite_sig: sig.slice(0, 16),
            });
            this._autoJoinedInviteSig.add(sig);
            this._clearEventRetry('join_invite', sig);
            this._pruneCaches();
            const swapCh = String(out?.swap_channel || e?.message?.body?.swap_channel || '').trim();
            if (swapCh) {
              await this._runToolWithTimeout(
                { tool: 'intercomswap_sc_subscribe', args: { channels: [swapCh] } },
                { timeoutMs: Math.min(this._toolTimeoutMs, 10_000), label: 'tradeauto_swap_subscribe' }
              );
            }
            actionsLeft -= 1;
            this._stats.actions += 1;
          } catch (err) {
            const errMsg = err?.message || String(err);
            this._trace('auto_join_fail', {
              trade_id: tradeId,
              channel: String(e?.channel || '').trim(),
              invite_sig: sig.slice(0, 16),
              error: errMsg,
            });
            if (isPermanentNegotiationError(errMsg)) {
              this._autoJoinedInviteSig.add(sig);
              this._clearEventRetry('join_invite', sig);
              this._trace('auto_join_drop_permanent', {
                trade_id: tradeId,
                channel: String(e?.channel || '').trim(),
                invite_sig: sig.slice(0, 16),
                error: errMsg,
              });
            } else {
              this._markEventRetry('join_invite', sig, 5000);
            }
            this._log(`[tradeauto] auto-join failed: ${err?.message || String(err)}`);
          }
        }
      }

      if (this.opts.enable_settlement && actionsLeft > 0) {
        for (const tradeCtx of ctx.swapTradeContexts.slice(0, this.opts.max_trades)) {
          if (actionsLeft <= 0) break;
          const tradeId = String(tradeCtx?.trade_id || '').trim();
          if (!tradeId) continue;
          if (tradeCtx.claimed || tradeCtx.refunded || tradeCtx.canceled) continue;

          const neg = ctx.swapNegotiationByTrade.get(tradeId) || {};
          const rfqEnv = isObject(neg?.rfq) ? neg.rfq : null;
          const quoteEnv = isObject(neg?.quote) ? neg.quote : null;
          const quoteAcceptEnv = isObject(neg?.quote_accept) ? neg.quote_accept : null;

          const termsEnv = isObject(tradeCtx?.terms) ? tradeCtx.terms : null;
          const acceptEnv = isObject(tradeCtx?.accept) ? tradeCtx.accept : null;
          const invoiceEnv = isObject(tradeCtx?.invoice) ? tradeCtx.invoice : null;
          const escrowEnv = isObject(tradeCtx?.escrow) ? tradeCtx.escrow : null;
          const lnPaidEnv = isObject(tradeCtx?.ln_paid) ? tradeCtx.ln_paid : null;

          if (termsEnv || acceptEnv || invoiceEnv || escrowEnv || lnPaidEnv) {
            this._waitingTermsState.delete(tradeId);
          }

          if (acceptEnv && this._termsReplayByTrade.has(tradeId)) {
            this._termsReplayByTrade.delete(tradeId);
          }

          const termsBody = isObject(termsEnv?.body) ? termsEnv.body : {};
          const termsLnPayerPeer = String(termsBody?.ln_payer_peer || '').trim().toLowerCase();
          const termsSolRecipient = String(termsBody?.sol_recipient || '').trim();

          const makerSigner = String(termsEnv?.signer || quoteEnv?.signer || '').trim().toLowerCase();
          const takerSigner = String(acceptEnv?.signer || quoteAcceptEnv?.signer || rfqEnv?.signer || '').trim().toLowerCase();
          const inviteePeer = String(neg?.swap_invite?.body?.invite?.payload?.inviteePubKey || '').trim().toLowerCase();
          const iAmInvitedTaker = Boolean(localPeer && /^[0-9a-f]{64}$/i.test(inviteePeer) && inviteePeer === localPeer);
          const iAmMaker = Boolean(
            (localPeer && makerSigner && makerSigner === localPeer) ||
              (ctx.myQuoteTradeIds && typeof ctx.myQuoteTradeIds.has === 'function' && ctx.myQuoteTradeIds.has(tradeId))
          );
          const iAmTaker = Boolean(
            (localPeer && takerSigner && takerSigner === localPeer) ||
              iAmInvitedTaker ||
              ctx.myRfqTradeIds.has(tradeId) ||
              (localPeer && /^[0-9a-f]{64}$/i.test(termsLnPayerPeer) && termsLnPayerPeer === localPeer) ||
              (localSolSigner && termsSolRecipient && termsSolRecipient === localSolSigner)
          );
          if (!iAmMaker && !iAmTaker) {
            const lastTrace = Number(this._notOwnerTraceAt.get(tradeId) || 0);
            if (Date.now() - lastTrace > 15_000) {
              this._trace('trade_skip_not_owner', {
                trade_id: tradeId,
                channel: String(tradeCtx?.channel || neg?.swap_channel || '').trim() || null,
                local_peer: localPeer || null,
                local_sol_signer: localSolSigner || null,
                maker_signer: makerSigner || null,
                taker_signer: takerSigner || null,
                invitee_peer: inviteePeer || null,
                terms_ln_payer_peer: termsLnPayerPeer || null,
                terms_sol_recipient: termsSolRecipient || null,
              });
              this._notOwnerTraceAt.set(tradeId, Date.now());
            }
            continue;
          }

          const swapChannel = String(tradeCtx?.channel || neg?.swap_channel || `swap:${tradeId}`).trim();
          if (!swapChannel.startsWith('swap:')) continue;
          const routePrecheckStatus = parseLnRoutePrecheckStatus(tradeCtx?.statuses, { payerPeer: termsLnPayerPeer });

          const termsBoundToLocalIdentity = (() => {
            if (!termsEnv) return true;
            if (!localPeer) return false;
            if (!/^[0-9a-f]{64}$/i.test(termsLnPayerPeer)) return false;
            return termsLnPayerPeer === localPeer;
          })();
          const termsBoundToLocalSolRecipient = (() => {
            if (!termsEnv) return true;
            if (!localSolSigner) return false;
            return Boolean(termsSolRecipient && termsSolRecipient === localSolSigner);
          })();

          if (iAmMaker && !termsEnv && quoteEnv && rfqEnv && quoteAcceptEnv) {
            const stageKey = `${tradeId}:terms_post`;
            if (this._canRunStage(stageKey)) {
              this._markStageInFlight(stageKey);
              try {
                const quoteBody = isObject(quoteEnv?.body) ? quoteEnv.body : {};
                const rfqBody = isObject(rfqEnv?.body) ? rfqEnv.body : {};
                const btcSats = toIntOrNull(quoteBody?.btc_sats ?? rfqBody?.btc_sats);
                const usdtAmount = String(quoteBody?.usdt_amount ?? rfqBody?.usdt_amount ?? '').trim();
                const solRecipient = String(rfqBody?.sol_recipient || '').trim();
                const solRefund = localSolSigner;
                const tradeFeeCollector = String(quoteBody?.trade_fee_collector || '').trim();
                const lnPayerPeer = String(quoteAcceptEnv?.signer || rfqEnv?.signer || '').trim().toLowerCase();
                const solMint = String(this.opts.usdt_mint || rfqBody?.sol_mint || quoteBody?.sol_mint || '').trim();
                if (btcSats === null || btcSats < 1) throw new Error('terms_post: missing btc_sats');
                if (!/^[0-9]+$/.test(usdtAmount)) throw new Error('terms_post: missing usdt_amount');
                if (!solMint) throw new Error('terms_post: missing usdt_mint');
                if (!solRecipient) throw new Error('terms_post: missing sol_recipient');
                if (!solRefund) throw new Error('terms_post: missing sol_refund');
                if (!tradeFeeCollector) throw new Error('terms_post: missing trade_fee_collector');
                if (!lnPayerPeer) throw new Error('terms_post: missing ln_payer_peer');
                const quoteRefundWindowSec = clampInt(toIntOrNull(quoteBody?.sol_refund_window_sec), {
                  min: 3600,
                  max: 7 * 24 * 3600,
                  fallback: this.opts.default_sol_refund_window_sec,
                });
                const refundAfterUnix = Math.floor(Date.now() / 1000) + quoteRefundWindowSec;
                const termsValidUntilUnix = toIntOrNull(quoteBody?.valid_until_unix);
                await this._runToolWithTimeout({
                  tool: 'intercomswap_terms_post',
                  args: {
                    channel: swapChannel,
                    trade_id: tradeId,
                    btc_sats: btcSats,
                    usdt_amount: usdtAmount,
                    sol_mint: solMint,
                    sol_recipient: solRecipient,
                    sol_refund: solRefund,
                    sol_refund_after_unix: refundAfterUnix,
                    ln_receiver_peer: localPeer,
                    ln_payer_peer: lnPayerPeer,
                    trade_fee_collector: tradeFeeCollector,
                    ...(termsValidUntilUnix && termsValidUntilUnix > 0 ? { terms_valid_until_unix: termsValidUntilUnix } : {}),
                  },
                });
                this._markStageSuccess(stageKey);
                actionsLeft -= 1;
                this._stats.actions += 1;
              } catch (err) {
                this._trace('stage_fail', { stage: stageKey, trade_id: tradeId, error: err?.message || String(err) });
                this._markStageRetry(stageKey, 10_000);
                this._log(`[tradeauto] ${stageKey} failed: ${err?.message || String(err)}`);
              }
            }
            continue;
          }

          if (iAmMaker && termsEnv && !acceptEnv) {
            const nowMs = Date.now();
            const nowSec = Math.floor(nowMs / 1000);
            const replayMax = Number(this.opts?.terms_replay_max || 40);
            const replayCooldownMs = Number(this.opts?.terms_replay_cooldown_ms || 6000);
            const termsValidUntil = toIntOrNull(termsBody?.terms_valid_until_unix);
            const replay = this._termsReplayByTrade.get(tradeId) || { count: 0, nextAtMs: 0, lastTs: 0 };
            if (termsValidUntil !== null && termsValidUntil > 0 && nowSec > termsValidUntil) {
              this._termsReplayByTrade.delete(tradeId);
              this._trace('terms_replay_stop_expired', { trade_id: tradeId, channel: swapChannel });
              continue;
            }
            if (replay.count >= replayMax) continue;
            if (Number(replay.nextAtMs || 0) > nowMs) continue;
            try {
              await this._runToolWithTimeout(
                { tool: 'intercomswap_sc_send_json', args: { channel: swapChannel, json: termsEnv } },
                { timeoutMs: Math.min(this._toolTimeoutMs, 10_000), label: 'tradeauto_terms_replay' }
              );
              const next = { count: Number(replay.count || 0) + 1, nextAtMs: nowMs + replayCooldownMs, lastTs: nowMs };
              this._termsReplayByTrade.set(tradeId, next);
              if (next.count <= 3 || next.count % 5 === 0) {
                this._trace('terms_replay_ok', {
                  trade_id: tradeId,
                  channel: swapChannel,
                  attempt: next.count,
                });
              }
              actionsLeft -= 1;
              this._stats.actions += 1;
            } catch (err) {
              const attempts = Number(replay.count || 0) + 1;
              this._termsReplayByTrade.set(tradeId, {
                count: attempts,
                nextAtMs: nowMs + replayCooldownMs,
                lastTs: nowMs,
              });
              this._trace('terms_replay_fail', {
                trade_id: tradeId,
                channel: swapChannel,
                attempt: attempts,
                error: err?.message || String(err),
              });
            }
            continue;
          }

          if (iAmTaker && !termsEnv) {
            const nowMs = Date.now();
            const traceCooldownMs = Number(this.opts?.waiting_terms_trace_cooldown_ms ?? 15_000);
            const pingCooldownMs = Number(this.opts?.waiting_terms_ping_cooldown_ms ?? 6_000);
            const maxPings = Number(this.opts?.waiting_terms_max_pings ?? 40);
            const maxWaitMs = Number(this.opts?.waiting_terms_max_wait_ms ?? 3 * 60 * 1000);
            const leaveOnTimeout = this.opts?.waiting_terms_leave_on_timeout !== false;
            const state = isObject(this._waitingTermsState.get(tradeId))
              ? { ...this._waitingTermsState.get(tradeId) }
              : {
                  firstSeenAt: nowMs,
                  lastTs: nowMs,
                  lastTraceAt: 0,
                  lastPingAt: 0,
                  nextPingAt: nowMs,
                  pings: 0,
                  timedOutAt: 0,
                  lastRejoinAt: 0,
                  rejoins: 0,
                };
            state.lastTs = nowMs;
            if (!Number.isFinite(Number(state.firstSeenAt)) || Number(state.firstSeenAt) <= 0) state.firstSeenAt = nowMs;
            if (!Number.isFinite(Number(state.nextPingAt)) || Number(state.nextPingAt) <= 0) state.nextPingAt = nowMs;
            if (!Number.isFinite(Number(state.pings)) || Number(state.pings) < 0) state.pings = 0;
            if (!Number.isFinite(Number(state.lastRejoinAt)) || Number(state.lastRejoinAt) < 0) state.lastRejoinAt = 0;
            if (!Number.isFinite(Number(state.rejoins)) || Number(state.rejoins) < 0) state.rejoins = 0;
            const waitMs = Math.max(0, nowMs - Number(state.firstSeenAt || nowMs));

            if (nowMs - Number(state.lastTraceAt || 0) > traceCooldownMs) {
              this._trace('waiting_terms', {
                trade_id: tradeId,
                channel: swapChannel,
                wait_ms: waitMs,
                pings: Number(state.pings || 0),
                has_invite: Boolean(isObject(neg?.swap_invite)),
                has_quote_accept: Boolean(isObject(quoteAcceptEnv)),
                has_rfq: Boolean(isObject(rfqEnv)),
              });
              state.lastTraceAt = nowMs;
            }

            const timedOut = waitMs >= maxWaitMs;
            if (timedOut && !Number(state.timedOutAt || 0)) {
              state.timedOutAt = nowMs;
              this._autoAcceptedTradeLock.delete(tradeId);
              this._trace('waiting_terms_timeout', {
                trade_id: tradeId,
                channel: swapChannel,
                wait_ms: waitMs,
                max_wait_ms: maxWaitMs,
              });
            }

            if (!timedOut && isObject(neg?.swap_invite) && Number(state.rejoins || 0) < 2 && nowMs - Number(state.lastRejoinAt || 0) >= 20_000) {
              try {
                await this._runToolWithTimeout(
                  { tool: 'intercomswap_join_from_swap_invite', args: { swap_invite_envelope: neg.swap_invite } },
                  { timeoutMs: Math.min(this._toolTimeoutMs, 12_000), label: 'tradeauto_waiting_terms_rejoin' }
                );
                state.rejoins = Number(state.rejoins || 0) + 1;
                state.lastRejoinAt = nowMs;
                this._trace('waiting_terms_rejoin_ok', {
                  trade_id: tradeId,
                  channel: swapChannel,
                  attempt: Number(state.rejoins || 0),
                });
              } catch (err) {
                state.rejoins = Number(state.rejoins || 0) + 1;
                state.lastRejoinAt = nowMs;
                this._trace('waiting_terms_rejoin_fail', {
                  trade_id: tradeId,
                  channel: swapChannel,
                  attempt: Number(state.rejoins || 0),
                  error: err?.message || String(err),
                });
              }
            }

            if (!timedOut && Number(state.pings || 0) < maxPings && nowMs >= Number(state.nextPingAt || 0)) {
              let pingOk = 0;
              const pingErrors = [];
              try {
                const inviteForAuth =
                  isObject(neg?.swap_invite?.body?.invite)
                    ? neg.swap_invite.body.invite
                    : null;
                if (inviteForAuth) {
                  try {
                    await this._runToolWithTimeout(
                      { tool: 'intercomswap_sc_send_json', args: { channel: swapChannel, json: { control: 'auth', invite: inviteForAuth } } },
                      { timeoutMs: Math.min(this._toolTimeoutMs, 10_000), label: 'tradeauto_waiting_terms_auth_ping' }
                    );
                    pingOk += 1;
                    this._trace('waiting_terms_auth_ping_ok', {
                      trade_id: tradeId,
                      channel: swapChannel,
                      attempt: Number(state.pings || 0) + 1,
                    });
                  } catch (err) {
                    pingErrors.push(`auth:${err?.message || String(err)}`);
                  }
                }
                if (isObject(quoteAcceptEnv)) {
                  const replayChannel =
                    String(neg?.quote_accept_channel || '').trim() ||
                    String(neg?.quote_channel || '').trim() ||
                    String(neg?.rfq_channel || '').trim() ||
                    String(neg?.swap_invite_channel || '').trim() ||
                    swapChannel;
                  await this._runToolWithTimeout(
                    { tool: 'intercomswap_sc_send_json', args: { channel: replayChannel, json: quoteAcceptEnv } },
                    { timeoutMs: Math.min(this._toolTimeoutMs, 10_000), label: 'tradeauto_waiting_terms_replay_accept' }
                  );
                  pingOk += 1;
                  this._trace('waiting_terms_replay_accept_ok', {
                    trade_id: tradeId,
                    channel: swapChannel,
                    attempt: Number(state.pings || 0) + 1,
                    replay_channel: replayChannel,
                    sent_ok: pingOk,
                  });
                }
                try {
                  await this._runToolWithTimeout(
                    {
                      tool: 'intercomswap_swap_status_post',
                      args: { channel: swapChannel, trade_id: tradeId, state: 'init', note: 'waiting_terms' },
                    },
                    { timeoutMs: Math.min(this._toolTimeoutMs, 10_000), label: 'tradeauto_waiting_terms_status_ping' }
                  );
                  pingOk += 1;
                  this._trace('waiting_terms_status_ping_ok', {
                    trade_id: tradeId,
                    channel: swapChannel,
                    attempt: Number(state.pings || 0) + 1,
                  });
                } catch (err) {
                  pingErrors.push(`status:${err?.message || String(err)}`);
                }
                if (pingOk < 1 && pingErrors.length > 0) {
                  throw new Error(pingErrors.join(' | '));
                }
                state.pings = Number(state.pings || 0) + 1;
                state.lastPingAt = nowMs;
                state.nextPingAt = nowMs + pingCooldownMs;
                actionsLeft -= 1;
                this._stats.actions += 1;
              } catch (err) {
                state.pings = Number(state.pings || 0) + 1;
                state.lastPingAt = nowMs;
                state.nextPingAt = nowMs + pingCooldownMs;
                this._trace('waiting_terms_ping_fail', {
                  trade_id: tradeId,
                  channel: swapChannel,
                  attempt: Number(state.pings || 0),
                  error: err?.message || String(err),
                });
              }
            }

            if (timedOut && leaveOnTimeout) {
              const stageKey = `${tradeId}:waiting_terms_timeout_leave`;
              if (this._canRunStage(stageKey)) {
                this._markStageInFlight(stageKey);
                try {
                  await this._runToolWithTimeout(
                    { tool: 'intercomswap_sc_leave', args: { channel: swapChannel } },
                    { timeoutMs: Math.min(this._toolTimeoutMs, 10_000), label: 'tradeauto_waiting_terms_leave' }
                  );
                  this._markStageSuccess(stageKey);
                  this._trace('waiting_terms_leave_ok', { trade_id: tradeId, channel: swapChannel });
                } catch (err) {
                  this._markStageRetry(stageKey, Math.max(1_000, Number(this.opts?.swap_auto_leave_cooldown_ms || 10_000)));
                  this._trace('waiting_terms_leave_fail', {
                    trade_id: tradeId,
                    channel: swapChannel,
                    error: err?.message || String(err),
                  });
                }
              }
            }
            this._waitingTermsState.set(tradeId, state);
            continue;
          }

          if (iAmTaker && termsEnv && !acceptEnv) {
            const stageKey = `${tradeId}:terms_accept`;
            if (this._canRunStage(stageKey)) {
              this._markStageInFlight(stageKey);
              try {
                if (!termsBoundToLocalIdentity) throw new Error('terms_accept: terms.ln_payer_peer mismatch');
                if (!termsBoundToLocalSolRecipient) throw new Error('terms_accept: terms.sol_recipient mismatch');
                await this._runToolWithTimeout({
                  tool: 'intercomswap_terms_accept_from_terms',
                  args: { channel: swapChannel, terms_envelope: termsEnv },
                });
                this._markStageSuccess(stageKey);
                actionsLeft -= 1;
                this._stats.actions += 1;
              } catch (err) {
                this._trace('stage_fail', { stage: stageKey, trade_id: tradeId, error: err?.message || String(err) });
                this._markStageRetry(stageKey, 10_000);
                this._log(`[tradeauto] ${stageKey} failed: ${err?.message || String(err)}`);
              }
            }
            continue;
          }

          if (iAmMaker && termsEnv && acceptEnv && !invoiceEnv) {
            const stageKey = `${tradeId}:ln_invoice`;
            if (this._canRunStage(stageKey)) {
              this._markStageInFlight(stageKey);
              try {
                const btcSats = toIntOrNull(termsBody?.btc_sats);
                if (btcSats === null || btcSats < 1) throw new Error('ln_invoice: missing btc_sats');
                await this._runToolWithTimeout({
                  tool: 'intercomswap_swap_ln_invoice_create_and_post',
                  args: {
                    channel: swapChannel,
                    trade_id: tradeId,
                    btc_sats: btcSats,
                    label: `swap-${tradeId}-${Date.now()}`.slice(0, 120),
                    description: `intercomswap ${tradeId}`.slice(0, 500),
                  },
                });
                this._markStageSuccess(stageKey);
                actionsLeft -= 1;
                this._stats.actions += 1;
              } catch (err) {
                this._trace('stage_fail', { stage: stageKey, trade_id: tradeId, error: err?.message || String(err) });
                this._markStageRetry(stageKey, 10_000);
                this._log(`[tradeauto] ${stageKey} failed: ${err?.message || String(err)}`);
              }
            }
            continue;
          }

          if (iAmTaker && termsEnv && invoiceEnv && !escrowEnv) {
            const stageKey = `${tradeId}:ln_route_precheck`;
            if (this._canRunStage(stageKey)) {
              this._markStageInFlight(stageKey);
              try {
                if (!termsBoundToLocalIdentity) throw new Error('ln_route_precheck: terms.ln_payer_peer mismatch');
                if (!termsBoundToLocalSolRecipient) throw new Error('ln_route_precheck: terms.sol_recipient mismatch');

                const out = await this._runToolWithTimeout({
                  tool: 'intercomswap_swap_ln_route_precheck_from_terms_invoice',
                  args: {
                    channel: swapChannel,
                    terms_envelope: termsEnv,
                    invoice_envelope: invoiceEnv,
                  },
                });

                const liq = isObject(out?.ln_liquidity) ? out.ln_liquidity : {};
                const note = normalizeTraceText(
                  [
                    'ln_route_precheck_ok',
                    `invoice_sats=${String(out?.invoice_sats ?? '')}`,
                    `invoice_route_hints=${String(out?.invoice_route_hints ?? '')}`,
                    `active_channels=${String(liq?.channels_active ?? '')}`,
                    `max_outbound_sats=${String(liq?.max_outbound_sats ?? '')}`,
                    `total_outbound_sats=${String(liq?.total_outbound_sats ?? '')}`,
                  ]
                    .filter((v) => String(v || '').trim().length > 0)
                    .join(' '),
                  480
                );
                await this._runToolWithTimeout({
                  tool: 'intercomswap_swap_status_post',
                  args: { channel: swapChannel, trade_id: tradeId, state: 'accepted', note },
                });
                this._trace('ln_route_precheck_ok', {
                  trade_id: tradeId,
                  channel: swapChannel,
                  invoice_sats: out?.invoice_sats ?? null,
                  invoice_route_hints: out?.invoice_route_hints ?? null,
                  active_channels: liq?.channels_active ?? null,
                  max_outbound_sats: liq?.max_outbound_sats ?? null,
                  total_outbound_sats: liq?.total_outbound_sats ?? null,
                });

                this._markStageSuccess(stageKey);
                actionsLeft -= 1;
                this._stats.actions += 1;
              } catch (err) {
                const errMsg = err?.message || String(err);
                const failNote = normalizeTraceText(`ln_route_precheck_fail reason=${errMsg}`, 480);
                try {
                  await this._runToolWithTimeout({
                    tool: 'intercomswap_swap_status_post',
                    args: { channel: swapChannel, trade_id: tradeId, state: 'accepted', note: failNote },
                  });
                } catch (statusErr) {
                  this._trace('ln_route_precheck_status_post_fail', {
                    trade_id: tradeId,
                    channel: swapChannel,
                    error: statusErr?.message || String(statusErr),
                  });
                }
                this._trace('ln_route_precheck_fail', {
                  trade_id: tradeId,
                  channel: swapChannel,
                  error: normalizeTraceText(errMsg, 500),
                });
                this._markStageRetry(stageKey, Math.max(250, Number(this.opts?.ln_route_precheck_retry_cooldown_ms || 10_000)));
                this._log(`[tradeauto] ${stageKey} failed: ${errMsg}`);
              }
            }
            continue;
          }

          if (iAmMaker && termsEnv && invoiceEnv && !escrowEnv) {
            const stageKey = `${tradeId}:sol_escrow`;
            if (this._canRunStage(stageKey)) {
              const okTs = Number(routePrecheckStatus?.ok_ts || 0);
              const failTs = Number(routePrecheckStatus?.fail_ts || 0);
              if (okTs < 1 || failTs > okTs) {
                this._trace('ln_route_precheck_gate_block', {
                  trade_id: tradeId,
                  channel: swapChannel,
                  reason: failTs > okTs ? 'payer_reported_fail' : 'waiting_for_payer_precheck',
                  precheck_ok_ts: okTs > 0 ? okTs : null,
                  precheck_fail_ts: failTs > 0 ? failTs : null,
                  precheck_fail_note: failTs > okTs ? normalizeTraceText(routePrecheckStatus?.fail_note || '', 320) : null,
                });
                this._markStageRetry(stageKey, Math.max(250, Number(this.opts?.ln_route_precheck_wait_cooldown_ms || 4_000)));
                continue;
              }
              this._trace('ln_route_precheck_gate_pass', {
                trade_id: tradeId,
                channel: swapChannel,
                precheck_ok_ts: okTs,
                precheck_ok_note: normalizeTraceText(routePrecheckStatus?.ok_note || '', 320) || null,
              });
              this._markStageInFlight(stageKey);
              try {
                const invBody = isObject(invoiceEnv?.body) ? invoiceEnv.body : {};
                const paymentHashHex = String(invBody?.payment_hash_hex || '').trim().toLowerCase();
                const mint = String(termsBody?.sol_mint || this.opts.usdt_mint || '').trim();
                const amount = String(termsBody?.usdt_amount || '').trim();
                const recipient = String(termsBody?.sol_recipient || '').trim();
                const refund = String(termsBody?.sol_refund || '').trim();
                const refundAfterUnix = toIntOrNull(termsBody?.sol_refund_after_unix);
                const tradeFeeCollector = String(termsBody?.trade_fee_collector || '').trim();
                if (!/^[0-9a-f]{64}$/i.test(paymentHashHex)) throw new Error('sol_escrow: missing payment_hash_hex');
                if (!mint) throw new Error('sol_escrow: missing mint');
                if (!/^[0-9]+$/.test(amount)) throw new Error('sol_escrow: missing amount');
                if (!recipient) throw new Error('sol_escrow: missing recipient');
                if (!refund) throw new Error('sol_escrow: missing refund');
                if (refundAfterUnix === null || refundAfterUnix < 1) throw new Error('sol_escrow: missing refund_after_unix');
                if (!tradeFeeCollector) throw new Error('sol_escrow: missing trade_fee_collector');

                await this._runToolWithTimeout({
                  tool: 'intercomswap_swap_sol_escrow_init_and_post',
                  args: {
                    channel: swapChannel,
                    trade_id: tradeId,
                    payment_hash_hex: paymentHashHex,
                    mint,
                    amount,
                    recipient,
                    refund,
                    refund_after_unix: refundAfterUnix,
                    trade_fee_collector: tradeFeeCollector,
                    ...(this.opts.sol_cu_limit && this.opts.sol_cu_limit > 0 ? { cu_limit: this.opts.sol_cu_limit } : {}),
                    ...(this.opts.sol_cu_price && this.opts.sol_cu_price > 0 ? { cu_price: this.opts.sol_cu_price } : {}),
                  },
                });
                this._markStageSuccess(stageKey);
                actionsLeft -= 1;
                this._stats.actions += 1;
              } catch (err) {
                this._trace('stage_fail', { stage: stageKey, trade_id: tradeId, error: err?.message || String(err) });
                this._markStageRetry(stageKey, 10_000);
                this._log(`[tradeauto] ${stageKey} failed: ${err?.message || String(err)}`);
              }
            }
            continue;
          }

          if (iAmTaker && termsEnv && invoiceEnv && escrowEnv && !lnPaidEnv) {
            const stageKey = `${tradeId}:ln_pay`;
            const lnPayFailState = this._lnPayFailByTrade.get(tradeId) || null;
            if (lnPayFailState && Number(lnPayFailState.abortedAt || 0) > 0) {
              if (!Number(lnPayFailState.lastAbortTraceAt || 0)) {
                lnPayFailState.lastAbortTraceAt = Date.now();
                this._lnPayFailByTrade.set(tradeId, lnPayFailState);
                this._trace('ln_pay_aborted', {
                  trade_id: tradeId,
                  channel: swapChannel,
                  failures: Number(lnPayFailState.failures || 0),
                  aborted_at: Number(lnPayFailState.abortedAt || 0),
                  reason: String(lnPayFailState.abortReason || '').slice(0, 1000),
                });
              }
              continue;
            }
            if (this._canRunStage(stageKey)) {
              this._markStageInFlight(stageKey);
              try {
                if (!termsBoundToLocalIdentity) throw new Error('ln_pay: terms.ln_payer_peer mismatch');
                if (!termsBoundToLocalSolRecipient) throw new Error('ln_pay: terms.sol_recipient mismatch');
                const out = await this._runToolWithTimeout({
                  tool: 'intercomswap_swap_ln_pay_and_post_verified',
                  args: {
                    channel: swapChannel,
                    terms_envelope: termsEnv,
                    invoice_envelope: invoiceEnv,
                    escrow_envelope: escrowEnv,
                  },
                });
                const preimageHex = String(out?.preimage_hex || '').trim().toLowerCase();
                if (/^[0-9a-f]{64}$/i.test(preimageHex)) this._tradePreimage.set(tradeId, preimageHex);
                this._lnPayFailByTrade.delete(tradeId);
                this._pruneCaches();
                this._markStageSuccess(stageKey);
                actionsLeft -= 1;
                this._stats.actions += 1;
              } catch (err) {
                const errMsg = err?.message || String(err);
                this._trace('stage_fail', { stage: stageKey, trade_id: tradeId, error: errMsg });
                const forceAbort = /unroutable invoice precheck/i.test(errMsg);
                const failRec = this._recordLnPayFailure({
                  tradeId,
                  channel: swapChannel,
                  error: errMsg,
                  forceAbort,
                });
                const failState = failRec?.state || null;
                const elapsedMs = Math.max(0, Math.trunc(Number(failRec?.elapsedMs || 0)));
                if (failRec?.shouldAbort && failState) {
                  const leaveStageKey = `${tradeId}:ln_pay_fail_leave`;
                  this._markStageSuccess(stageKey);
                  this._trace('ln_pay_fail_threshold_reached', {
                    trade_id: tradeId,
                    channel: swapChannel,
                    failures: Number(failState.failures || 0),
                    elapsed_ms: elapsedMs,
                    min_wait_ms: Math.max(1_000, Number(this.opts?.ln_pay_fail_leave_min_wait_ms || 20_000)),
                    threshold_attempts: Math.max(2, Number(this.opts?.ln_pay_fail_leave_attempts || 3)),
                  });
                  if (this._canRunStage(leaveStageKey)) {
                    this._markStageInFlight(leaveStageKey);
                    try {
                      await this._runToolWithTimeout(
                        { tool: 'intercomswap_sc_leave', args: { channel: swapChannel } },
                        { timeoutMs: Math.min(this._toolTimeoutMs, 10_000), label: 'ln_pay_fail_leave' }
                      );
                      this._markStageSuccess(leaveStageKey);
                      this._trace('ln_pay_fail_leave_ok', {
                        trade_id: tradeId,
                        channel: swapChannel,
                        failures: Number(failState.failures || 0),
                        elapsed_ms: elapsedMs,
                      });
                    } catch (leaveErr) {
                      this._markStageRetry(leaveStageKey, Math.max(1_000, Number(this.opts?.swap_auto_leave_cooldown_ms || 10_000)));
                      this._trace('ln_pay_fail_leave_error', {
                        trade_id: tradeId,
                        channel: swapChannel,
                        error: leaveErr?.message || String(leaveErr),
                      });
                    }
                  }
                } else {
                  const retryMs = Math.max(250, Number(this.opts?.ln_pay_retry_cooldown_ms || 10_000));
                  this._markStageRetry(stageKey, retryMs);
                }
                this._log(`[tradeauto] ${stageKey} failed: ${err?.message || String(err)}`);
              }
            }
            continue;
          }

          if (iAmTaker && termsEnv && lnPaidEnv && !tradeCtx?.claimed) {
            const stageKey = `${tradeId}:sol_claim`;
            if (this._canRunStage(stageKey)) {
              this._markStageInFlight(stageKey);
              try {
                if (!termsBoundToLocalSolRecipient) throw new Error('sol_claim: terms.sol_recipient mismatch');
                const mint = String(termsBody?.sol_mint || this.opts.usdt_mint || '').trim();
                if (!mint) throw new Error('sol_claim: missing mint');
                let preimageHex = String(this._tradePreimage.get(tradeId) || '').trim().toLowerCase();
                if (!/^[0-9a-f]{64}$/i.test(preimageHex)) {
                  const rec = await this._runToolWithTimeout({
                    tool: 'intercomswap_receipts_show',
                    args: { trade_id: tradeId },
                  });
                  preimageHex = String(rec?.ln_preimage_hex || '').trim().toLowerCase();
                  if (/^[0-9a-f]{64}$/i.test(preimageHex)) this._tradePreimage.set(tradeId, preimageHex);
                  this._pruneCaches();
                }
                if (!/^[0-9a-f]{64}$/i.test(preimageHex)) throw new Error('sol_claim: missing LN preimage');
                await this._runToolWithTimeout({
                  tool: 'intercomswap_swap_sol_claim_and_post',
                  args: { channel: swapChannel, trade_id: tradeId, preimage_hex: preimageHex, mint },
                });
                this._markStageSuccess(stageKey);
                actionsLeft -= 1;
                this._stats.actions += 1;
              } catch (err) {
                this._trace('stage_fail', { stage: stageKey, trade_id: tradeId, error: err?.message || String(err) });
                this._markStageRetry(stageKey, 15_000);
                this._log(`[tradeauto] ${stageKey} failed: ${err?.message || String(err)}`);
              }
            }
          }
        }
      }

      this._stats.ticks += 1;
      this._stats.last_tick_at = Date.now();
      this._stats.last_error = null;
    } catch (err) {
      this._stats.last_error = err?.message || String(err);
      this._log(`[tradeauto] tick failed: ${this._stats.last_error}`);
      throw err;
    } finally {
      this._tickInFlight = false;
    }
  }
}
