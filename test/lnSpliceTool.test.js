import test from 'node:test';
import assert from 'node:assert/strict';

import { ToolExecutor } from '../src/prompt/executor.js';

function mkExecutor() {
  return new ToolExecutor({
    scBridge: { url: 'ws://127.0.0.1:1', token: 'x' },
    peer: { keypairPath: '' },
    ln: { impl: 'cln', backend: 'cli', network: 'regtest' },
    solana: { rpcUrls: 'http://127.0.0.1:8899', commitment: 'confirmed', programId: '' },
    receipts: { dbPath: 'onchain/receipts/test/swap-maker.sqlite' },
  });
}

test('ln_splice dry_run: accepts non-zero relative sats', async () => {
  const ex = mkExecutor();
  const out = await ex.execute(
    'intercomswap_ln_splice',
    {
      channel_id: 'abc123',
      relative_sats: 25_000,
      sat_per_vbyte: 2,
      max_rounds: 8,
      sign_first: true,
    },
    { autoApprove: true, dryRun: true }
  );
  assert.equal(out.type, 'dry_run');
  assert.equal(out.tool, 'intercomswap_ln_splice');
  assert.equal(out.channel_id, 'abc123');
  assert.equal(out.relative_sats, 25_000);
  assert.equal(out.sat_per_vbyte, 2);
  assert.equal(out.max_rounds, 8);
  assert.equal(out.sign_first, true);
});

test('ln_splice: rejects zero relative_sats', async () => {
  const ex = mkExecutor();
  await assert.rejects(
    () =>
      ex.execute(
        'intercomswap_ln_splice',
        {
          channel_id: 'abc123',
          relative_sats: 0,
        },
        { autoApprove: true, dryRun: true }
      ),
    /relative_sats must be non-zero/
  );
});

