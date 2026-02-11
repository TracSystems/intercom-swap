import test from 'node:test';
import assert from 'node:assert/strict';

import { AutopostManager } from '../src/prompt/autopost.js';

test('AutopostManager starts, runs immediately, repeats, and stops', async () => {
  let calls = 0;
  const mgr = new AutopostManager({
    runTool: async ({ tool, args }) => {
      calls += 1;
      return { type: 'ok', tool, args };
    },
  });

  const started = await mgr.start({
    name: 'job1',
    tool: 'intercomswap_rfq_post',
    interval_sec: 1,
    ttl_sec: 60,
    args: { channel: 'c', trade_id: 'rfq-1', btc_sats: 1, usdt_amount: '1' },
  });
  assert.equal(started.type, 'autopost_started');
  assert.equal(calls, 1, 'runs once immediately');

  // Wait for at least one interval tick.
  await new Promise((r) => setTimeout(r, 1100));
  assert.ok(calls >= 2, `expected at least 2 calls, got ${calls}`);

  const stopped = await mgr.stop({ name: 'job1' });
  assert.equal(stopped.type, 'autopost_stopped');

  const afterStop = calls;
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(calls, afterStop, 'no further calls after stop');
});

test('AutopostManager stops automatically on expiry and does not extend validity', async () => {
  let calls = 0;
  const seenValidUntil = new Set();
  const mgr = new AutopostManager({
    runTool: async ({ tool, args }) => {
      calls += 1;
      seenValidUntil.add(Number(args?.valid_until_unix));
      return { type: 'ok', tool, args };
    },
  });

  const nowSec = Math.floor(Date.now() / 1000);
  const validUntil = nowSec + 10;

  const started = await mgr.start({
    name: 'job2',
    tool: 'intercomswap_rfq_post',
    interval_sec: 1,
    ttl_sec: 10,
    valid_until_unix: validUntil,
    args: { channel: 'c', trade_id: 'rfq-2', btc_sats: 1, usdt_amount: '1' },
  });
  assert.equal(started.type, 'autopost_started');
  assert.equal(started.valid_until_unix, validUntil);
  assert.equal(calls, 1, 'runs once immediately');

  // Wait long enough for expiry and the interval to observe it.
  await new Promise((r) => setTimeout(r, 11_500));
  const st = mgr.status();
  assert.ok(!st.jobs.find((j) => j.name === 'job2'), 'job removed after expiry');

  // Reposts must not extend validity; every run must share the same fixed valid_until_unix.
  assert.equal(seenValidUntil.size, 1);
  assert.ok(seenValidUntil.has(validUntil));

  const afterExpiry = calls;
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(calls, afterExpiry, 'no further calls after expiry stop');
});

test('AutopostManager prunes filled offer lines and stops once empty', async () => {
  let calls = 0;
  const signer = 'a'.repeat(64);
  let trades = [];

  const mgr = new AutopostManager({
    runTool: async ({ tool, args }) => {
      calls += 1;
      return { type: 'offer_posted', tool, args, envelope: { signer } };
    },
    listTrades: async () => trades,
  });

  const started = await mgr.start({
    name: 'offerjob',
    tool: 'intercomswap_offer_post',
    interval_sec: 1,
    ttl_sec: 60,
    args: {
      channels: ['c'],
      name: 'maker:alice',
      offers: [{ btc_sats: 1, usdt_amount: '1' }],
    },
  });
  assert.equal(started.type, 'autopost_started');
  assert.equal(calls, 1, 'runs once immediately');

  // Simulate a completed trade that matches the advertised offer line.
  trades = [
    {
      trade_id: 'swap-1',
      state: 'claimed',
      maker_peer: signer,
      btc_sats: 1,
      usdt_amount: '1',
      updated_at: Date.now(),
    },
  ];

  // Wait for at least one interval tick; job should stop without running again.
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(calls, 1, 'no further calls after filled line prunes to empty');

  const st = mgr.status();
  assert.ok(!st.jobs.find((j) => j.name === 'offerjob'), 'job removed after fill');
});

test('AutopostManager stops immediately on insufficient-funds style errors', async () => {
  let calls = 0;
  const mgr = new AutopostManager({
    runTool: async () => {
      calls += 1;
      throw new Error('intercomswap_rfq_post: insufficient LN outbound liquidity (mode=single_channel)');
    },
  });

  const started = await mgr.start({
    name: 'rfq-low-liq',
    tool: 'intercomswap_rfq_post',
    interval_sec: 1,
    ttl_sec: 60,
    args: { channel: 'c', trade_id: 'rfq-low-liq', btc_sats: 9999999, usdt_amount: '1' },
  });
  assert.equal(started.type, 'autopost_stopped');
  assert.equal(started.reason, 'insufficient_funds');
  assert.equal(calls, 1, 'first run attempted once and then stopped');

  const st = mgr.status();
  assert.ok(!st.jobs.find((j) => j.name === 'rfq-low-liq'), 'job removed after insufficient-funds stop');
});
