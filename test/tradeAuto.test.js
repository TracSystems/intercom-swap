import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { TradeAutoManager } from '../src/prompt/tradeAuto.js';

const MAKER = 'a'.repeat(64);
const TAKER = 'b'.repeat(64);
const SOL_RECIPIENT = '4gRG1QE1YofRgCtTuwEDftYx9aEr9N1z5bFTJTbPNqmg';

function env(kind, tradeId, signer, body = {}) {
  const nonce = `${kind}-${tradeId}`.slice(0, 20);
  const sig = createHash('sha512')
    .update(JSON.stringify({ kind, tradeId, signer, nonce, body }))
    .digest('hex');
  return {
    v: 1,
    kind,
    trade_id: tradeId,
    ts: Date.now(),
    nonce,
    body,
    signer,
    sig,
  };
}

test('tradeauto: settlement can start from synthetic swap context (no prior swap:* terms event)', async () => {
  const tradeId = 'swap_test_1';
  const sent = [];
  const now = Date.now();
  const events = [
    {
      seq: 1,
      ts: now,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.rfq',
      message: env('swap.rfq', tradeId, TAKER, {
        btc_sats: 10000,
        usdt_amount: '1000000',
        sol_recipient: SOL_RECIPIENT,
      }),
    },
    {
      seq: 2,
      ts: now + 1,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.quote',
      message: env('swap.quote', tradeId, MAKER, {
        rfq_id: 'd'.repeat(64),
        btc_sats: 10000,
        usdt_amount: '1000000',
        trade_fee_collector: SOL_RECIPIENT,
      }),
    },
    {
      seq: 3,
      ts: now + 2,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.quote_accept',
      message: env('swap.quote_accept', tradeId, TAKER, {
        rfq_id: 'd'.repeat(64),
        quote_id: 'e'.repeat(64),
      }),
    },
    {
      seq: 4,
      ts: now + 3,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.swap_invite',
      message: env('swap.swap_invite', tradeId, MAKER, {
        swap_channel: `swap:${tradeId}`,
        invite: { payload: { inviteePubKey: TAKER, inviterPubKey: MAKER, expiresAt: now + 60_000 }, sig: 'f'.repeat(128) },
      }),
    },
  ];

  let readOnce = false;
  const mgr = new TradeAutoManager({
    scLogInfo: () => ({ latest_seq: 4 }),
    scLogRead: () => {
      if (readOnce) return { latest_seq: 4, events: [] };
      readOnce = true;
      return { latest_seq: 4, events };
    },
    runTool: async ({ tool, args }) => {
      if (tool === 'intercomswap_sc_subscribe') return { type: 'subscribed' };
      if (tool === 'intercomswap_sc_info') return { peer: MAKER };
      if (tool === 'intercomswap_sol_signer_pubkey') return { pubkey: SOL_RECIPIENT };
      if (tool === 'intercomswap_sc_stats') return { channels: [] };
      if (tool === 'intercomswap_terms_post') {
        sent.push({ tool, args });
        return { type: 'terms_posted' };
      }
      throw new Error(`unexpected tool: ${tool}`);
    },
  });

  try {
    await mgr.start({
      channels: ['0000intercomswapbtcusdt'],
      usdt_mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      enable_quote_from_offers: false,
      enable_accept_quotes: false,
      enable_invite_from_accepts: false,
      enable_join_invites: false,
      enable_settlement: true,
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].args.trade_id, tradeId);
    assert.equal(sent[0].args.channel, `swap:${tradeId}`);
  } finally {
    await mgr.stop({ reason: 'test_done' });
  }
});

test('tradeauto: start while running can enable trace immediately', async () => {
  const mgr = new TradeAutoManager({
    scLogInfo: () => ({ latest_seq: 0 }),
    scLogRead: () => ({ latest_seq: 0, events: [] }),
    runTool: async ({ tool }) => {
      if (tool === 'intercomswap_sc_subscribe') return { type: 'subscribed' };
      if (tool === 'intercomswap_sc_info') return { peer: MAKER };
      if (tool === 'intercomswap_sol_signer_pubkey') return { pubkey: SOL_RECIPIENT };
      if (tool === 'intercomswap_sc_stats') return { channels: [] };
      throw new Error(`unexpected tool: ${tool}`);
    },
  });

  try {
    const started = await mgr.start({
      channels: ['0000intercomswapbtcusdt'],
      trace_enabled: false,
      enable_quote_from_offers: false,
      enable_quote_from_rfqs: false,
      enable_accept_quotes: false,
      enable_invite_from_accepts: false,
      enable_join_invites: false,
      enable_settlement: false,
    });
    assert.equal(Boolean(started.running), true);
    assert.equal(Boolean(started.trace_enabled), false);

    const rerun = await mgr.start({ trace_enabled: true });
    assert.equal(rerun.type, 'tradeauto_already_running');
    assert.equal(Boolean(rerun.trace_enabled), true);

    const recent = Array.isArray(rerun?.recent_events) ? rerun.recent_events : [];
    assert.equal(recent.some((e) => String(e?.type || '') === 'trace_enabled_runtime'), true);
  } finally {
    await mgr.stop({ reason: 'test_done' });
  }
});

test('tradeauto: settlement resolves local peer from sc_info.info.peerPubkey', async () => {
  const tradeId = 'swap_test_local_peer_info_shape';
  const sent = [];
  const now = Date.now();
  const events = [
    {
      seq: 1,
      ts: now,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.rfq',
      message: env('swap.rfq', tradeId, TAKER, {
        btc_sats: 10000,
        usdt_amount: '1000000',
        sol_recipient: SOL_RECIPIENT,
      }),
    },
    {
      seq: 2,
      ts: now + 1,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.quote',
      message: env('swap.quote', tradeId, MAKER, {
        rfq_id: 'd'.repeat(64),
        btc_sats: 10000,
        usdt_amount: '1000000',
        trade_fee_collector: SOL_RECIPIENT,
      }),
    },
    {
      seq: 3,
      ts: now + 2,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.quote_accept',
      message: env('swap.quote_accept', tradeId, TAKER, {
        rfq_id: 'd'.repeat(64),
        quote_id: 'e'.repeat(64),
      }),
    },
    {
      seq: 4,
      ts: now + 3,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.swap_invite',
      message: env('swap.swap_invite', tradeId, MAKER, {
        swap_channel: `swap:${tradeId}`,
        invite: { payload: { inviteePubKey: TAKER, inviterPubKey: MAKER, expiresAt: now + 60_000 }, sig: 'f'.repeat(128) },
      }),
    },
  ];

  let readOnce = false;
  const mgr = new TradeAutoManager({
    scLogInfo: () => ({ latest_seq: 4 }),
    scLogRead: () => {
      if (readOnce) return { latest_seq: 4, events: [] };
      readOnce = true;
      return { latest_seq: 4, events };
    },
    runTool: async ({ tool, args }) => {
      if (tool === 'intercomswap_sc_subscribe') return { type: 'subscribed' };
      if (tool === 'intercomswap_sc_info') return { type: 'info', info: { peerPubkey: MAKER } };
      if (tool === 'intercomswap_sol_signer_pubkey') return { pubkey: SOL_RECIPIENT };
      if (tool === 'intercomswap_sc_stats') return { channels: [] };
      if (tool === 'intercomswap_terms_post') {
        sent.push({ tool, args });
        return { type: 'terms_posted' };
      }
      throw new Error(`unexpected tool: ${tool}`);
    },
  });

  try {
    await mgr.start({
      channels: ['0000intercomswapbtcusdt'],
      usdt_mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      enable_quote_from_offers: false,
      enable_accept_quotes: false,
      enable_invite_from_accepts: false,
      enable_join_invites: false,
      enable_settlement: true,
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].args.trade_id, tradeId);
  } finally {
    await mgr.stop({ reason: 'test_done' });
  }
});

test('tradeauto: offer-sourced quote path remains active (service announce -> quote from RFQ)', async () => {
  const tradeId = 'swap_test_offer_1';
  const now = Date.now();
  const posted = [];
  const events = [
    {
      seq: 1,
      ts: now,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.svc_announce',
      local: true,
      dir: 'out',
      origin: 'local',
      message: env('swap.svc_announce', 'svc:maker:test', MAKER, {
        name: 'maker:test',
        pairs: ['BTC_LN/USDT_SOL'],
        rfq_channels: ['0000intercomswapbtcusdt'],
        offers: [
          {
            pair: 'BTC_LN/USDT_SOL',
            have: 'USDT_SOL',
            want: 'BTC_LN',
            btc_sats: 10000,
            usdt_amount: '1000000',
            max_platform_fee_bps: 50,
            max_trade_fee_bps: 50,
            max_total_fee_bps: 100,
            min_sol_refund_window_sec: 259200,
            max_sol_refund_window_sec: 604800,
          },
        ],
      }),
    },
    {
      seq: 2,
      ts: now + 1,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.rfq',
      message: env('swap.rfq', tradeId, TAKER, {
        pair: 'BTC_LN/USDT_SOL',
        direction: 'BTC_LN->USDT_SOL',
        btc_sats: 10000,
        usdt_amount: '1000000',
        max_platform_fee_bps: 50,
        max_trade_fee_bps: 50,
        max_total_fee_bps: 100,
        min_sol_refund_window_sec: 259200,
        max_sol_refund_window_sec: 604800,
        valid_until_unix: Math.floor((now + 120_000) / 1000),
      }),
    },
  ];

  let readOnce = false;
  const mgr = new TradeAutoManager({
    scLogInfo: () => ({ latest_seq: 2 }),
    scLogRead: () => {
      if (readOnce) return { latest_seq: 2, events: [] };
      readOnce = true;
      return { latest_seq: 2, events };
    },
    runTool: async ({ tool, args }) => {
      if (tool === 'intercomswap_sc_subscribe') return { type: 'subscribed' };
      if (tool === 'intercomswap_sc_info') return { peer: MAKER };
      if (tool === 'intercomswap_sol_signer_pubkey') return { pubkey: SOL_RECIPIENT };
      if (tool === 'intercomswap_sc_stats') return { channels: [] };
      if (tool === 'intercomswap_quote_post_from_rfq') {
        posted.push({ tool, args });
        return { type: 'quote_posted' };
      }
      throw new Error(`unexpected tool: ${tool}`);
    },
  });

  try {
    await mgr.start({
      channels: ['0000intercomswapbtcusdt'],
      usdt_mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      enable_quote_from_offers: true,
      enable_accept_quotes: false,
      enable_invite_from_accepts: false,
      enable_join_invites: false,
      enable_settlement: false,
    });
    assert.equal(posted.length, 1);
    assert.equal(String(posted[0]?.args?.channel || ''), '0000intercomswapbtcusdt');
  } finally {
    await mgr.stop({ reason: 'test_done' });
  }
});

test('tradeauto: RFQ auto-quote can run without offer match when enabled', async () => {
  const tradeId = 'swap_test_rfq_auto_1';
  const now = Date.now();
  const posted = [];
  const events = [
    {
      seq: 1,
      ts: now,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.rfq',
      message: env('swap.rfq', tradeId, TAKER, {
        pair: 'BTC_LN/USDT_SOL',
        direction: 'BTC_LN->USDT_SOL',
        btc_sats: 12000,
        usdt_amount: '1200000',
        max_platform_fee_bps: 50,
        max_trade_fee_bps: 50,
        max_total_fee_bps: 100,
        min_sol_refund_window_sec: 259200,
        max_sol_refund_window_sec: 604800,
        valid_until_unix: Math.floor((now + 120_000) / 1000),
      }),
    },
  ];

  let readCount = 0;
  const mgr = new TradeAutoManager({
    scLogInfo: () => ({ latest_seq: 1 }),
    scLogRead: () => {
      readCount += 1;
      if (readCount > 1) return { latest_seq: 1, events: [] };
      return { latest_seq: 1, events };
    },
    runTool: async ({ tool, args }) => {
      if (tool === 'intercomswap_sc_subscribe') return { type: 'subscribed' };
      if (tool === 'intercomswap_sc_info') return { peer: MAKER };
      if (tool === 'intercomswap_sol_signer_pubkey') return { pubkey: SOL_RECIPIENT };
      if (tool === 'intercomswap_sc_stats') return { channels: [] };
      if (tool === 'intercomswap_quote_post_from_rfq') {
        posted.push({ tool, args });
        return { type: 'quote_posted' };
      }
      throw new Error(`unexpected tool: ${tool}`);
    },
  });

  try {
    await mgr.start({
      channels: ['0000intercomswapbtcusdt'],
      usdt_mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      enable_quote_from_offers: false,
      enable_quote_from_rfqs: true,
      enable_accept_quotes: false,
      enable_invite_from_accepts: false,
      enable_join_invites: false,
      enable_settlement: false,
    });
    assert.equal(posted.length, 1);
    assert.equal(String(posted[0]?.args?.channel || ''), '0000intercomswapbtcusdt');
    assert.equal(String(posted[0]?.args?.rfq_envelope?.trade_id || ''), tradeId);
  } finally {
    await mgr.stop({ reason: 'test_done' });
  }
});

test('tradeauto: RFQ auto-quote is suppressed when trade already has quote_accept/invite context', async () => {
  const tradeId = 'swap_test_rfq_busy_1';
  const now = Date.now();
  const posted = [];
  const events = [
    {
      seq: 1,
      ts: now,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.rfq',
      message: env('swap.rfq', tradeId, TAKER, {
        pair: 'BTC_LN/USDT_SOL',
        direction: 'BTC_LN->USDT_SOL',
        btc_sats: 12000,
        usdt_amount: '1200000',
        max_platform_fee_bps: 50,
        max_trade_fee_bps: 50,
        max_total_fee_bps: 100,
        min_sol_refund_window_sec: 259200,
        max_sol_refund_window_sec: 604800,
        valid_until_unix: Math.floor((now + 120_000) / 1000),
      }),
    },
    {
      seq: 2,
      ts: now + 1,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.quote_accept',
      message: env('swap.quote_accept', tradeId, TAKER, {
        rfq_id: 'd'.repeat(64),
        quote_id: 'e'.repeat(64),
      }),
    },
  ];

  let readCount = 0;
  const mgr = new TradeAutoManager({
    scLogInfo: () => ({ latest_seq: 2 }),
    scLogRead: () => {
      readCount += 1;
      if (readCount > 1) return { latest_seq: 2, events: [] };
      return { latest_seq: 2, events };
    },
    runTool: async ({ tool, args }) => {
      if (tool === 'intercomswap_sc_subscribe') return { type: 'subscribed' };
      if (tool === 'intercomswap_sc_info') return { peer: MAKER };
      if (tool === 'intercomswap_sol_signer_pubkey') return { pubkey: SOL_RECIPIENT };
      if (tool === 'intercomswap_sc_stats') return { channels: [] };
      if (tool === 'intercomswap_quote_post_from_rfq') {
        posted.push({ tool, args });
        return { type: 'quote_posted' };
      }
      throw new Error(`unexpected tool: ${tool}`);
    },
  });

  try {
    await mgr.start({
      channels: ['0000intercomswapbtcusdt'],
      usdt_mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      enable_quote_from_offers: false,
      enable_quote_from_rfqs: true,
      enable_accept_quotes: false,
      enable_invite_from_accepts: false,
      enable_join_invites: false,
      enable_settlement: false,
    });
    assert.equal(posted.length, 0);
  } finally {
    await mgr.stop({ reason: 'test_done' });
  }
});

test('tradeauto: aggregate liquidity mode is honored for RFQ auto-accept', async () => {
  const tradeId = 'swap_test_accept_aggregate_1';
  const now = Date.now();
  const accepted = [];
  const events = [
    {
      seq: 1,
      ts: now,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.rfq',
      local: true,
      dir: 'out',
      origin: 'local',
      message: env('swap.rfq', tradeId, TAKER, {
        pair: 'BTC_LN/USDT_SOL',
        direction: 'BTC_LN->USDT_SOL',
        btc_sats: 10000,
        usdt_amount: '1000000',
        valid_until_unix: Math.floor((now + 120_000) / 1000),
      }),
    },
    {
      seq: 2,
      ts: now + 1,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.quote',
      message: env('swap.quote', tradeId, MAKER, {
        rfq_id: '1'.repeat(64),
        btc_sats: 10000,
        usdt_amount: '1000000',
      }),
    },
  ];

  let readOnce = false;
  const mgr = new TradeAutoManager({
    scLogInfo: () => ({ latest_seq: 2 }),
    scLogRead: () => {
      if (readOnce) return { latest_seq: 2, events: [] };
      readOnce = true;
      return { latest_seq: 2, events };
    },
    runTool: async ({ tool, args }) => {
      if (tool === 'intercomswap_sc_subscribe') return { type: 'subscribed' };
      if (tool === 'intercomswap_sc_info') return { peer: TAKER };
      if (tool === 'intercomswap_sol_signer_pubkey') return { pubkey: SOL_RECIPIENT };
      if (tool === 'intercomswap_sc_stats') return { channels: [] };
      if (tool === 'intercomswap_quote_accept') {
        accepted.push({ tool, args });
        return { type: 'quote_accept_posted' };
      }
      throw new Error(`unexpected tool: ${tool}`);
    },
  });

  try {
    await mgr.start({
      channels: ['0000intercomswapbtcusdt'],
      usdt_mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      ln_liquidity_mode: 'aggregate',
      enable_quote_from_offers: false,
      enable_accept_quotes: true,
      enable_invite_from_accepts: false,
      enable_join_invites: false,
      enable_settlement: false,
    });
    assert.equal(accepted.length, 1);
    assert.equal(String(accepted[0]?.args?.ln_liquidity_mode || ''), 'aggregate');
  } finally {
    await mgr.stop({ reason: 'test_done' });
  }
});

test('tradeauto: backend auto-leaves stale swap channels (expired invite)', async () => {
  const tradeId = 'swap_test_2';
  const left = [];
  const now = Date.now();
  const events = [
    {
      seq: 1,
      ts: now,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.swap_invite',
      message: env('swap.swap_invite', tradeId, MAKER, {
        swap_channel: `swap:${tradeId}`,
        invite: { payload: { inviteePubKey: TAKER, inviterPubKey: MAKER, expiresAt: now - 10_000 }, sig: 'f'.repeat(128) },
      }),
    },
  ];

  let readOnce = false;
  const mgr = new TradeAutoManager({
    scLogInfo: () => ({ latest_seq: 1 }),
    scLogRead: () => {
      if (readOnce) return { latest_seq: 1, events: [] };
      readOnce = true;
      return { latest_seq: 1, events };
    },
    runTool: async ({ tool, args }) => {
      if (tool === 'intercomswap_sc_subscribe') return { type: 'subscribed' };
      if (tool === 'intercomswap_sc_info') return { peer: TAKER };
      if (tool === 'intercomswap_sol_signer_pubkey') return { pubkey: SOL_RECIPIENT };
      if (tool === 'intercomswap_sc_stats') return { channels: [`swap:${tradeId}`] };
      if (tool === 'intercomswap_sc_leave') {
        left.push(String(args?.channel || ''));
        return { type: 'left', channel: String(args?.channel || '') };
      }
      throw new Error(`unexpected tool: ${tool}`);
    },
  });

  try {
    await mgr.start({
      channels: ['0000intercomswapbtcusdt'],
      enable_quote_from_offers: false,
      enable_accept_quotes: false,
      enable_invite_from_accepts: false,
      enable_join_invites: false,
      enable_settlement: false,
      hygiene_interval_ms: 1_000,
    });
    assert.deepEqual(left, [`swap:${tradeId}`]);
  } finally {
    await mgr.stop({ reason: 'test_done' });
  }
});

test('tradeauto: taker waiting_terms replays quote_accept and then accepts terms', async () => {
  const tradeId = 'swap_test_3';
  const swapChannel = `swap:${tradeId}`;
  const now = Date.now();
  const rfq = {
    seq: 1,
    ts: now,
    channel: '0000intercomswapbtcusdt',
    kind: 'swap.rfq',
    message: env('swap.rfq', tradeId, TAKER, {
      btc_sats: 10000,
      usdt_amount: '1000000',
      sol_recipient: SOL_RECIPIENT,
    }),
  };
  const quote = {
    seq: 2,
    ts: now + 1,
    channel: '0000intercomswapbtcusdt',
    kind: 'swap.quote',
    message: env('swap.quote', tradeId, MAKER, {
      rfq_id: 'd'.repeat(64),
      btc_sats: 10000,
      usdt_amount: '1000000',
      trade_fee_collector: SOL_RECIPIENT,
      sol_refund_window_sec: 72 * 3600,
      valid_until_unix: Math.floor((now + 60_000) / 1000),
    }),
  };
  const quoteAccept = {
    seq: 3,
    ts: now + 2,
    channel: '0000intercomswapbtcusdt',
    kind: 'swap.quote_accept',
    message: env('swap.quote_accept', tradeId, TAKER, {
      rfq_id: 'd'.repeat(64),
      quote_id: 'e'.repeat(64),
    }),
  };
  const swapInvite = {
    seq: 4,
    ts: now + 3,
    channel: '0000intercomswapbtcusdt',
    kind: 'swap.swap_invite',
    message: env('swap.swap_invite', tradeId, MAKER, {
      swap_channel: swapChannel,
      invite: { payload: { inviteePubKey: TAKER, inviterPubKey: MAKER, expiresAt: now + 60_000 }, sig: 'f'.repeat(128) },
    }),
  };
  const terms = {
    seq: 5,
    ts: now + 100,
    channel: swapChannel,
    kind: 'swap.terms',
    message: env('swap.terms', tradeId, MAKER, {
      btc_sats: 10000,
      usdt_amount: '1000000',
      sol_mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      sol_recipient: SOL_RECIPIENT,
      sol_refund: '2JfWqV6nS6f7QjE9pP2WfW2z1CYKo7U2uC8hYq7pW6sM',
      sol_refund_after_unix: Math.floor((now + 72 * 3600 * 1000) / 1000),
      ln_receiver_peer: MAKER,
      ln_payer_peer: TAKER,
      trade_fee_collector: SOL_RECIPIENT,
      app_hash: '727bd54d63839285a7ead6baf7e9fedd130cacb820cd6392ffcba46aff8db87b',
    }),
  };

  let readCount = 0;
  const replayCalls = [];
  const accepted = [];
  const mgr = new TradeAutoManager({
    scLogInfo: () => ({ latest_seq: 5 }),
    scLogRead: () => {
      readCount += 1;
      if (readCount === 1) return { latest_seq: 4, events: [rfq, quote, quoteAccept, swapInvite] };
      if (readCount === 2) return { latest_seq: 5, events: [terms] };
      return { latest_seq: 5, events: [] };
    },
    runTool: async ({ tool, args }) => {
      if (tool === 'intercomswap_sc_subscribe') return { type: 'subscribed' };
      if (tool === 'intercomswap_sc_info') return { peer: TAKER };
      if (tool === 'intercomswap_sol_signer_pubkey') return { pubkey: SOL_RECIPIENT };
      if (tool === 'intercomswap_sc_stats') return { channels: [swapChannel] };
      if (tool === 'intercomswap_sc_send_json') {
        replayCalls.push({ tool, args });
        return { type: 'sent' };
      }
      if (tool === 'intercomswap_terms_accept_from_terms') {
        accepted.push({ tool, args });
        return { type: 'terms_accept_posted' };
      }
      throw new Error(`unexpected tool: ${tool}`);
    },
  });

  try {
    await mgr.start({
      channels: ['0000intercomswapbtcusdt'],
      interval_ms: 50,
      usdt_mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      enable_quote_from_offers: false,
      enable_accept_quotes: false,
      enable_invite_from_accepts: false,
      enable_join_invites: false,
      enable_settlement: true,
      waiting_terms_ping_cooldown_ms: 1_000,
      waiting_terms_max_wait_ms: 60_000,
    });

    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && accepted.length < 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    assert.ok(
      replayCalls.some((c) => String(c?.args?.json?.kind || '') === 'swap.quote_accept'),
      'expected quote_accept replay while waiting terms'
    );
    assert.ok(
      replayCalls.some((c) => String(c?.args?.json?.control || '') === 'auth'),
      'expected auth replay while waiting terms'
    );
    assert.equal(accepted.length, 1);
    assert.equal(String(accepted[0]?.args?.channel || ''), swapChannel);
  } finally {
    await mgr.stop({ reason: 'test_done' });
  }
});

test('tradeauto: waiting_terms timeout auto-leaves swap channel (bounded wait)', async () => {
  const tradeId = 'swap_test_4';
  const swapChannel = `swap:${tradeId}`;
  const now = Date.now();
  const events = [
    {
      seq: 1,
      ts: now,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.rfq',
      message: env('swap.rfq', tradeId, TAKER, {
        btc_sats: 10000,
        usdt_amount: '1000000',
        sol_recipient: SOL_RECIPIENT,
      }),
    },
    {
      seq: 2,
      ts: now + 1,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.quote',
      message: env('swap.quote', tradeId, MAKER, {
        rfq_id: 'd'.repeat(64),
        btc_sats: 10000,
        usdt_amount: '1000000',
        trade_fee_collector: SOL_RECIPIENT,
      }),
    },
    {
      seq: 3,
      ts: now + 2,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.quote_accept',
      message: env('swap.quote_accept', tradeId, TAKER, {
        rfq_id: 'd'.repeat(64),
        quote_id: 'e'.repeat(64),
      }),
    },
    {
      seq: 4,
      ts: now + 3,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.swap_invite',
      message: env('swap.swap_invite', tradeId, MAKER, {
        swap_channel: swapChannel,
        invite: { payload: { inviteePubKey: TAKER, inviterPubKey: MAKER, expiresAt: now + 60_000 }, sig: 'f'.repeat(128) },
      }),
    },
  ];

  const left = [];
  const mgr = new TradeAutoManager({
    scLogInfo: () => ({ latest_seq: 4 }),
    scLogRead: () => ({ latest_seq: 4, events }),
    runTool: async ({ tool, args }) => {
      if (tool === 'intercomswap_sc_subscribe') return { type: 'subscribed' };
      if (tool === 'intercomswap_sc_info') return { peer: TAKER };
      if (tool === 'intercomswap_sol_signer_pubkey') return { pubkey: SOL_RECIPIENT };
      if (tool === 'intercomswap_sc_stats') return { channels: [swapChannel] };
      if (tool === 'intercomswap_sc_leave') {
        left.push(String(args?.channel || ''));
        return { type: 'left', channel: String(args?.channel || '') };
      }
      if (tool === 'intercomswap_sc_send_json') return { type: 'sent' };
      throw new Error(`unexpected tool: ${tool}`);
    },
  });

  try {
    await mgr.start({
      channels: ['0000intercomswapbtcusdt'],
      interval_ms: 50,
      enable_quote_from_offers: false,
      enable_accept_quotes: false,
      enable_invite_from_accepts: false,
      enable_join_invites: false,
      enable_settlement: true,
      waiting_terms_max_pings: 0,
      waiting_terms_max_wait_ms: 5_000,
      waiting_terms_leave_on_timeout: true,
      swap_auto_leave_cooldown_ms: 1_000,
    });

    const deadline = Date.now() + 9_000;
    while (Date.now() < deadline && left.length < 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(left.includes(swapChannel), 'expected timeout leave on stale waiting_terms trade');
  } finally {
    await mgr.stop({ reason: 'test_done' });
  }
});

test('tradeauto: ln_pay failure auto-leave is deterministic and does not leave early', async () => {
  const tradeId = 'swap_test_6';
  const swapChannel = `swap:${tradeId}`;
  const now = Date.now();

  const termsEnv = env('swap.terms', tradeId, MAKER, {
    btc_sats: 1000,
    usdt_amount: '670000',
    sol_mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    sol_recipient: SOL_RECIPIENT,
    sol_refund: '2JfWqV6nS6f7QjE9pP2WfW2z1CYKo7U2uC8hYq7pW6sM',
    sol_refund_after_unix: Math.floor((now + 72 * 3600 * 1000) / 1000),
    ln_receiver_peer: MAKER,
    ln_payer_peer: TAKER,
    trade_fee_collector: SOL_RECIPIENT,
  });
  const invoiceEnv = env('swap.ln_invoice', tradeId, MAKER, {
    bolt11: 'lnbc10u1p5cemg5pp503h4ceyly03nvgevmevjv4jrlrsr3s6tg89r8surn4lext8hpnfqdygwfn8zttjvecj6vfhxucrsdpnxymrydf4x5kkydnrxenrqwp595cnwdes8q6rxdp3xgcrvvfqf9h8getjvdhk6grnwashqgrjvecj6vfhxucrsdpnxymrydf4x5kkydnrxenrqwp5cqzzsxqrrsssp5k8zm63dhvg36cjhs48ckxk2glm7lc5hk94ahjhuzpwqu68hscqlq9qxpqysgqdkwmv5hvuke35jept3g8fc46cqlupsn7juv2scmqr530u8ywdv3xxp6walt49s7tlzszjkqdwc8f4emwue5qqelqkfpxz725cxjjdcqpa8930v',
    payment_hash_hex: '7c6f5c649f23e336232cde59265643f8e038c34b41ca33c3839d7f932cf70cd2',
  });
  const escrowEnv = env('swap.sol_escrow_created', tradeId, MAKER, {
    payment_hash_hex: '7c6f5c649f23e336232cde59265643f8e038c34b41ca33c3839d7f932cf70cd2',
    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    amount: '670000',
    recipient: SOL_RECIPIENT,
    refund: '2JfWqV6nS6f7QjE9pP2WfW2z1CYKo7U2uC8hYq7pW6sM',
    refund_after_unix: Math.floor((now + 72 * 3600 * 1000) / 1000),
    trade_fee_collector: SOL_RECIPIENT,
    tx_sig: '5'.repeat(88),
  });

  const events = [
    {
      seq: 1,
      ts: now + 1,
      channel: swapChannel,
      kind: 'swap.terms',
      message: termsEnv,
    },
    {
      seq: 2,
      ts: now + 2,
      channel: swapChannel,
      kind: 'swap.accept',
      message: env('swap.accept', tradeId, TAKER, {}),
    },
    {
      seq: 3,
      ts: now + 3,
      channel: swapChannel,
      kind: 'swap.ln_invoice',
      message: invoiceEnv,
    },
    {
      seq: 4,
      ts: now + 4,
      channel: swapChannel,
      kind: 'swap.sol_escrow_created',
      message: escrowEnv,
    },
  ];

  const left = [];
  let lnPayAttempts = 0;
  const mgr = new TradeAutoManager({
    scLogInfo: () => ({ latest_seq: 4 }),
    scLogRead: () => ({ latest_seq: 4, events }),
    runTool: async ({ tool, args }) => {
      if (tool === 'intercomswap_sc_subscribe') return { type: 'subscribed' };
      if (tool === 'intercomswap_sc_info') return { peer: TAKER };
      if (tool === 'intercomswap_sol_signer_pubkey') return { pubkey: SOL_RECIPIENT };
      if (tool === 'intercomswap_sc_stats') return { channels: [swapChannel] };
      if (tool === 'intercomswap_swap_ln_pay_and_post_verified') {
        lnPayAttempts += 1;
        throw new Error('ln pay failed: FAILURE_REASON_NO_ROUTE');
      }
      if (tool === 'intercomswap_sc_leave') {
        left.push(String(args?.channel || ''));
        return { type: 'left', channel: String(args?.channel || '') };
      }
      throw new Error(`unexpected tool: ${tool}`);
    },
  });

  try {
    await mgr.start({
      channels: ['0000intercomswapbtcusdt'],
      interval_ms: 50,
      enable_quote_from_offers: false,
      enable_quote_from_rfqs: false,
      enable_accept_quotes: false,
      enable_invite_from_accepts: false,
      enable_join_invites: false,
      enable_settlement: true,
      ln_pay_fail_leave_attempts: 3,
      ln_pay_fail_leave_min_wait_ms: 200,
      ln_pay_retry_cooldown_ms: 50,
      swap_auto_leave_cooldown_ms: 200,
    });

    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(left.length, 0, 'must not leave before deterministic thresholds');

    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && left.length < 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(lnPayAttempts >= 3, 'expected repeated ln_pay failures before leave');
    assert.ok(left.includes(swapChannel), 'expected deterministic auto-leave after threshold');
  } finally {
    await mgr.stop({ reason: 'test_done' });
  }
});

test('tradeauto: unroutable invoice precheck aborts immediately and traces once', async () => {
  const tradeId = 'swap_test_6b';
  const swapChannel = `swap:${tradeId}`;
  const now = Date.now();

  const termsEnv = env('swap.terms', tradeId, MAKER, {
    btc_sats: 1000,
    usdt_amount: '670000',
    sol_mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    sol_recipient: SOL_RECIPIENT,
    sol_refund: '2JfWqV6nS6f7QjE9pP2WfW2z1CYKo7U2uC8hYq7pW6sM',
    sol_refund_after_unix: Math.floor((now + 72 * 3600 * 1000) / 1000),
    ln_receiver_peer: MAKER,
    ln_payer_peer: TAKER,
    trade_fee_collector: SOL_RECIPIENT,
  });
  const invoiceEnv = env('swap.ln_invoice', tradeId, MAKER, {
    bolt11: 'lnbc10u1p5cemg5pp503h4ceyly03nvgevmevjv4jrlrsr3s6tg89r8surn4lext8hpnfqdygwfn8zttjvecj6vfhxucrsdpnxymrydf4x5kkydnrxenrqwp595cnwdes8q6rxdp3xgcrvvfqf9h8getjvdhk6grnwashqgrjvecj6vfhxucrsdpnxymrydf4x5kkydnrxenrqwp5cqzzsxqrrsssp5k8zm63dhvg36cjhs48ckxk2glm7lc5hk94ahjhuzpwqu68hscqlq9qxpqysgqdkwmv5hvuke35jept3g8fc46cqlupsn7juv2scmqr530u8ywdv3xxp6walt49s7tlzszjkqdwc8f4emwue5qqelqkfpxz725cxjjdcqpa8930v',
    payment_hash_hex: '7c6f5c649f23e336232cde59265643f8e038c34b41ca33c3839d7f932cf70cd2',
  });
  const escrowEnv = env('swap.sol_escrow_created', tradeId, MAKER, {
    payment_hash_hex: '7c6f5c649f23e336232cde59265643f8e038c34b41ca33c3839d7f932cf70cd2',
    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    amount: '670000',
    recipient: SOL_RECIPIENT,
    refund: '2JfWqV6nS6f7QjE9pP2WfW2z1CYKo7U2uC8hYq7pW6sM',
    refund_after_unix: Math.floor((now + 72 * 3600 * 1000) / 1000),
    trade_fee_collector: SOL_RECIPIENT,
    tx_sig: '6'.repeat(88),
  });

  const events = [
    { seq: 1, ts: now + 1, channel: swapChannel, kind: 'swap.terms', message: termsEnv },
    { seq: 2, ts: now + 2, channel: swapChannel, kind: 'swap.accept', message: env('swap.accept', tradeId, TAKER, {}) },
    { seq: 3, ts: now + 3, channel: swapChannel, kind: 'swap.ln_invoice', message: invoiceEnv },
    { seq: 4, ts: now + 4, channel: swapChannel, kind: 'swap.sol_escrow_created', message: escrowEnv },
  ];

  const left = [];
  let lnPayAttempts = 0;
  const mgr = new TradeAutoManager({
    scLogInfo: () => ({ latest_seq: 4 }),
    scLogRead: () => ({ latest_seq: 4, events }),
    runTool: async ({ tool, args }) => {
      if (tool === 'intercomswap_sc_subscribe') return { type: 'subscribed' };
      if (tool === 'intercomswap_sc_info') return { peer: TAKER };
      if (tool === 'intercomswap_sol_signer_pubkey') return { pubkey: SOL_RECIPIENT };
      if (tool === 'intercomswap_sc_stats') return { channels: [swapChannel] };
      if (tool === 'intercomswap_swap_ln_pay_and_post_verified') {
        lnPayAttempts += 1;
        throw new Error('intercomswap_swap_ln_pay_and_post_verified: unroutable invoice precheck: destination deadbeef has no route hints and this node has no direct active channel to destination');
      }
      if (tool === 'intercomswap_sc_leave') {
        left.push(String(args?.channel || ''));
        return { type: 'left', channel: String(args?.channel || '') };
      }
      throw new Error(`unexpected tool: ${tool}`);
    },
  });

  try {
    await mgr.start({
      channels: ['0000intercomswapbtcusdt'],
      interval_ms: 50,
      enable_quote_from_offers: false,
      enable_quote_from_rfqs: false,
      enable_accept_quotes: false,
      enable_invite_from_accepts: false,
      enable_join_invites: false,
      enable_settlement: true,
      trace_enabled: true,
      ln_pay_fail_leave_attempts: 5,
      ln_pay_fail_leave_min_wait_ms: 60_000,
      ln_pay_retry_cooldown_ms: 50,
      swap_auto_leave_cooldown_ms: 200,
    });

    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && left.length < 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(lnPayAttempts, 1, 'unroutable precheck should abort without repeated ln_pay attempts');
    assert.ok(left.includes(swapChannel), 'expected immediate auto-leave for unroutable precheck');

    await new Promise((resolve) => setTimeout(resolve, 250));
    const st = mgr.status();
    const abortedEvents = (Array.isArray(st.recent_events) ? st.recent_events : []).filter(
      (e) => e && e.type === 'ln_pay_aborted' && e.trade_id === tradeId
    );
    assert.equal(abortedEvents.length, 1, 'expected a single ln_pay_aborted trace event for the trade');
  } finally {
    await mgr.stop({ reason: 'test_done' });
  }
});

test('tradeauto: taker ln_route_precheck failure is traced and status-posted', async () => {
  const tradeId = 'swap_test_precheck_fail_stage';
  const swapChannel = `swap:${tradeId}`;
  const now = Date.now();
  const termsEnv = env('swap.terms', tradeId, MAKER, {
    btc_sats: 1000,
    usdt_amount: '670000',
    sol_mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    sol_recipient: SOL_RECIPIENT,
    sol_refund: '2JfWqV6nS6f7QjE9pP2WfW2z1CYKo7U2uC8hYq7pW6sM',
    sol_refund_after_unix: Math.floor((now + 72 * 3600 * 1000) / 1000),
    ln_receiver_peer: MAKER,
    ln_payer_peer: TAKER,
    trade_fee_collector: SOL_RECIPIENT,
  });
  const invoiceEnv = env('swap.ln_invoice', tradeId, MAKER, {
    bolt11:
      'lnbc10u1p5cemg5pp503h4ceyly03nvgevmevjv4jrlrsr3s6tg89r8surn4lext8hpnfqdygwfn8zttjvecj6vfhxucrsdpnxymrydf4x5kkydnrxenrqwp595cnwdes8q6rxdp3xgcrvvfqf9h8getjvdhk6grnwashqgrjvecj6vfhxucrsdpnxymrydf4x5kkydnrxenrqwp5cqzzsxqrrsssp5k8zm63dhvg36cjhs48ckxk2glm7lc5hk94ahjhuzpwqu68hscqlq9qxpqysgqdkwmv5hvuke35jept3g8fc46cqlupsn7juv2scmqr530u8ywdv3xxp6walt49s7tlzszjkqdwc8f4emwue5qqelqkfpxz725cxjjdcqpa8930v',
    payment_hash_hex: '7c6f5c649f23e336232cde59265643f8e038c34b41ca33c3839d7f932cf70cd2',
  });
  const events = [
    { seq: 1, ts: now + 1, channel: swapChannel, kind: 'swap.terms', message: termsEnv },
    { seq: 2, ts: now + 2, channel: swapChannel, kind: 'swap.accept', message: env('swap.accept', tradeId, TAKER, {}) },
    { seq: 3, ts: now + 3, channel: swapChannel, kind: 'swap.ln_invoice', message: invoiceEnv },
  ];

  const statusNotes = [];
  const mgr = new TradeAutoManager({
    scLogInfo: () => ({ latest_seq: 3 }),
    scLogRead: () => ({ latest_seq: 3, events }),
    runTool: async ({ tool, args }) => {
      if (tool === 'intercomswap_sc_subscribe') return { type: 'subscribed' };
      if (tool === 'intercomswap_sc_info') return { peer: TAKER };
      if (tool === 'intercomswap_sol_signer_pubkey') return { pubkey: SOL_RECIPIENT };
      if (tool === 'intercomswap_sc_stats') return { channels: [swapChannel] };
      if (tool === 'intercomswap_swap_ln_route_precheck_from_terms_invoice') {
        throw new Error('intercomswap_swap_ln_route_precheck_from_terms_invoice: unroutable invoice precheck: payer has no active Lightning channels');
      }
      if (tool === 'intercomswap_swap_status_post') {
        statusNotes.push(String(args?.note || ''));
        return { type: 'status_posted' };
      }
      throw new Error(`unexpected tool: ${tool}`);
    },
  });

  try {
    await mgr.start({
      channels: ['0000intercomswapbtcusdt'],
      interval_ms: 50,
      trace_enabled: true,
      enable_quote_from_offers: false,
      enable_quote_from_rfqs: false,
      enable_accept_quotes: false,
      enable_invite_from_accepts: false,
      enable_join_invites: false,
      enable_settlement: true,
      ln_route_precheck_retry_cooldown_ms: 10_000,
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(statusNotes.some((n) => String(n || '').startsWith('ln_route_precheck_fail')), 'expected ln_route_precheck_fail status note');
    const st = mgr.status();
    const traces = Array.isArray(st.recent_events) ? st.recent_events : [];
    assert.equal(
      traces.some((e) => e && e.type === 'ln_route_precheck_fail' && e.trade_id === tradeId),
      true,
      'expected ln_route_precheck_fail trace event'
    );
  } finally {
    await mgr.stop({ reason: 'test_done' });
  }
});

test('tradeauto: maker waits for taker ln_route_precheck_ok before escrow', async () => {
  const tradeId = 'swap_test_precheck_gate';
  const swapChannel = `swap:${tradeId}`;
  const now = Date.now();
  const termsEnv = env('swap.terms', tradeId, MAKER, {
    btc_sats: 1000,
    usdt_amount: '670000',
    sol_mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    sol_recipient: SOL_RECIPIENT,
    sol_refund: '2JfWqV6nS6f7QjE9pP2WfW2z1CYKo7U2uC8hYq7pW6sM',
    sol_refund_after_unix: Math.floor((now + 72 * 3600 * 1000) / 1000),
    ln_receiver_peer: MAKER,
    ln_payer_peer: TAKER,
    trade_fee_collector: SOL_RECIPIENT,
  });
  const invoiceEnv = env('swap.ln_invoice', tradeId, MAKER, {
    bolt11:
      'lnbc10u1p5cemg5pp503h4ceyly03nvgevmevjv4jrlrsr3s6tg89r8surn4lext8hpnfqdygwfn8zttjvecj6vfhxucrsdpnxymrydf4x5kkydnrxenrqwp595cnwdes8q6rxdp3xgcrvvfqf9h8getjvdhk6grnwashqgrjvecj6vfhxucrsdpnxymrydf4x5kkydnrxenrqwp5cqzzsxqrrsssp5k8zm63dhvg36cjhs48ckxk2glm7lc5hk94ahjhuzpwqu68hscqlq9qxpqysgqdkwmv5hvuke35jept3g8fc46cqlupsn7juv2scmqr530u8ywdv3xxp6walt49s7tlzszjkqdwc8f4emwue5qqelqkfpxz725cxjjdcqpa8930v',
    payment_hash_hex: '7c6f5c649f23e336232cde59265643f8e038c34b41ca33c3839d7f932cf70cd2',
  });
  const events = [
    { seq: 1, ts: now + 1, channel: swapChannel, kind: 'swap.terms', message: termsEnv },
    { seq: 2, ts: now + 2, channel: swapChannel, kind: 'swap.accept', message: env('swap.accept', tradeId, TAKER, {}) },
    { seq: 3, ts: now + 3, channel: swapChannel, kind: 'swap.ln_invoice', message: invoiceEnv },
  ];
  let latestSeq = 3;
  const escrowCalls = [];
  const mgr = new TradeAutoManager({
    scLogInfo: () => ({ latest_seq: latestSeq }),
    scLogRead: () => ({ latest_seq: latestSeq, events }),
    runTool: async ({ tool }) => {
      if (tool === 'intercomswap_sc_subscribe') return { type: 'subscribed' };
      if (tool === 'intercomswap_sc_info') return { peer: MAKER };
      if (tool === 'intercomswap_sol_signer_pubkey') return { pubkey: '2JfWqV6nS6f7QjE9pP2WfW2z1CYKo7U2uC8hYq7pW6sM' };
      if (tool === 'intercomswap_sc_stats') return { channels: [swapChannel] };
      if (tool === 'intercomswap_swap_sol_escrow_init_and_post') {
        escrowCalls.push(Date.now());
        return { type: 'sol_escrow_posted' };
      }
      throw new Error(`unexpected tool: ${tool}`);
    },
  });

  try {
    await mgr.start({
      channels: ['0000intercomswapbtcusdt'],
      interval_ms: 50,
      trace_enabled: true,
      enable_quote_from_offers: false,
      enable_quote_from_rfqs: false,
      enable_accept_quotes: false,
      enable_invite_from_accepts: false,
      enable_join_invites: false,
      enable_settlement: true,
      ln_route_precheck_wait_cooldown_ms: 50,
    });

    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(escrowCalls.length, 0, 'maker must not lock escrow before taker precheck');

    events.push({
      seq: 4,
      ts: now + 4,
      channel: swapChannel,
      kind: 'swap.status',
      message: env('swap.status', tradeId, TAKER, {
        state: 'accepted',
        note: 'ln_route_precheck_ok invoice_sats=1000 invoice_route_hints=0 active_channels=1 max_outbound_sats=1000 total_outbound_sats=1000',
      }),
    });
    latestSeq = 4;

    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && escrowCalls.length < 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(escrowCalls.length >= 1, true, 'maker should proceed after taker precheck ok');
  } finally {
    await mgr.stop({ reason: 'test_done' });
  }
});

test('tradeauto: waiting_terms replays latest quote_accept for reposted trade ids', async () => {
  const tradeId = 'swap_test_5';
  const oldSwapChannel = `swap:${tradeId}:old`;
  const newSwapChannel = `swap:${tradeId}:new`;
  const now = Date.now();
  const events = [
    {
      seq: 1,
      ts: now,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.rfq',
      message: env('swap.rfq', tradeId, TAKER, {
        btc_sats: 10000,
        usdt_amount: '1000000',
        sol_recipient: SOL_RECIPIENT,
      }),
    },
    {
      seq: 2,
      ts: now + 1,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.quote',
      message: env('swap.quote', tradeId, MAKER, {
        rfq_id: 'd'.repeat(64),
        quote_id: '1'.repeat(64),
        btc_sats: 10000,
        usdt_amount: '1000000',
      }),
    },
    {
      seq: 3,
      ts: now + 2,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.quote_accept',
      message: env('swap.quote_accept', tradeId, TAKER, {
        rfq_id: 'd'.repeat(64),
        quote_id: '1'.repeat(64),
      }),
    },
    {
      seq: 4,
      ts: now + 3,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.swap_invite',
      message: env('swap.swap_invite', tradeId, MAKER, {
        swap_channel: oldSwapChannel,
        invite: { payload: { inviteePubKey: TAKER, inviterPubKey: MAKER, expiresAt: now + 60_000 }, sig: 'f'.repeat(128) },
      }),
    },
    {
      seq: 5,
      ts: now + 10,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.quote',
      message: env('swap.quote', tradeId, MAKER, {
        rfq_id: 'd'.repeat(64),
        quote_id: '2'.repeat(64),
        btc_sats: 10000,
        usdt_amount: '1000000',
      }),
    },
    {
      seq: 6,
      ts: now + 11,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.quote_accept',
      message: env('swap.quote_accept', tradeId, TAKER, {
        rfq_id: 'd'.repeat(64),
        quote_id: '2'.repeat(64),
      }),
    },
    {
      seq: 7,
      ts: now + 12,
      channel: '0000intercomswapbtcusdt',
      kind: 'swap.swap_invite',
      message: env('swap.swap_invite', tradeId, MAKER, {
        swap_channel: newSwapChannel,
        invite: { payload: { inviteePubKey: TAKER, inviterPubKey: MAKER, expiresAt: now + 60_000 }, sig: 'f'.repeat(128) },
      }),
    },
  ];

  const replayCalls = [];
  const mgr = new TradeAutoManager({
    scLogInfo: () => ({ latest_seq: 7 }),
    scLogRead: () => ({ latest_seq: 7, events }),
    runTool: async ({ tool, args }) => {
      if (tool === 'intercomswap_sc_subscribe') return { type: 'subscribed' };
      if (tool === 'intercomswap_sc_info') return { peer: TAKER };
      if (tool === 'intercomswap_sol_signer_pubkey') return { pubkey: SOL_RECIPIENT };
      if (tool === 'intercomswap_sc_stats') return { channels: [newSwapChannel] };
      if (tool === 'intercomswap_join_from_swap_invite') return { type: 'joined', swap_channel: newSwapChannel };
      if (tool === 'intercomswap_sc_send_json') {
        replayCalls.push({ tool, args });
        return { type: 'sent' };
      }
      if (tool === 'intercomswap_swap_status_post') return { type: 'status_posted' };
      throw new Error(`unexpected tool: ${tool}`);
    },
  });

  try {
    await mgr.start({
      channels: ['0000intercomswapbtcusdt'],
      interval_ms: 50,
      enable_quote_from_offers: false,
      enable_accept_quotes: false,
      enable_invite_from_accepts: false,
      enable_join_invites: false,
      enable_settlement: true,
      waiting_terms_ping_cooldown_ms: 1_000,
      waiting_terms_max_pings: 1,
      waiting_terms_max_wait_ms: 60_000,
    });

    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && replayCalls.length < 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    assert.ok(replayCalls.length >= 1, 'expected waiting_terms replay calls');
    const quoteAcceptReplays = replayCalls
      .filter((c) => c?.args?.json?.kind === 'swap.quote_accept')
      .map((c) => String(c?.args?.json?.body?.quote_id || ''));
    assert.ok(quoteAcceptReplays.length >= 1, 'expected quote_accept replay payload');
    assert.ok(quoteAcceptReplays.every((id) => id === '2'.repeat(64)), 'expected latest quote_accept to be replayed');
  } finally {
    await mgr.stop({ reason: 'test_done' });
  }
});
