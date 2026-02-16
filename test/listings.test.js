import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveOfferListingId } from '../src/swap/listings.js';

test('deriveOfferListingId is stable for the same (signer, trade_id, app_hash, program_id)', () => {
  const signerHex = 'a'.repeat(64);
  const offerTradeId = 'svc:offer_maker_test_123';
  const appHash = 'deadbeef';
  const solanaProgramId = '4RS6xpspM1V2K7FKSqeSH6VVaZbtzHzhJqacwrz8gJrF';

  const id1 = deriveOfferListingId({ signerHex, offerTradeId, appHash, solanaProgramId });
  const id2 = deriveOfferListingId({ signerHex, offerTradeId, appHash, solanaProgramId });

  assert.equal(id1, id2);
  assert.match(id1, /^[0-9a-f]{64}$/);
});

test('deriveOfferListingId changes when trade_id changes', () => {
  const signerHex = 'b'.repeat(64);
  const appHash = 'deadbeef';
  const solanaProgramId = '4RS6xpspM1V2K7FKSqeSH6VVaZbtzHzhJqacwrz8gJrF';

  const id1 = deriveOfferListingId({ signerHex, offerTradeId: 'svc:one', appHash, solanaProgramId });
  const id2 = deriveOfferListingId({ signerHex, offerTradeId: 'svc:two', appHash, solanaProgramId });

  assert.notEqual(id1, id2);
});

test('deriveOfferListingId rejects invalid signer hex', () => {
  assert.throws(() => deriveOfferListingId({ signerHex: 'zzz', offerTradeId: 'svc:x' }), /must be 32-byte hex/);
});

