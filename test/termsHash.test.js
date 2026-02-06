import test from 'node:test';
import assert from 'node:assert/strict';
import b4a from 'b4a';
import PeerWallet from 'trac-wallet';

import { createUnsignedEnvelope, encodeEnvelopeForSigning, attachSignature } from '../src/protocol/signedMessage.js';
import { hashUnsignedEnvelope } from '../src/swap/hash.js';
import { ASSET, KIND, PAIR } from '../src/swap/constants.js';
import { acceptBodyForTerms, hashTermsEnvelope } from '../src/swap/terms.js';

test('swap terms: hash helper matches canonical unsigned envelope hash', async () => {
  const w = new PeerWallet();
  await w.ready;
  await w.generateKeyPair();

  const termsUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.TERMS,
    tradeId: 'swap_test_terms_hash_1',
    body: {
      pair: PAIR.BTC_LN__USDT_SOL,
      direction: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
      btc_sats: 1,
      usdt_amount: '1',
      sol_mint: 'So11111111111111111111111111111111111111112',
      sol_recipient: '11111111111111111111111111111111',
      sol_refund: '11111111111111111111111111111111',
      sol_refund_after_unix: 1770000000,
      ln_receiver_peer: b4a.toString(w.publicKey, 'hex'),
      ln_payer_peer: b4a.toString(w.publicKey, 'hex'),
    },
    ts: 123,
    nonce: 'n1',
  });

  const msg = encodeEnvelopeForSigning(termsUnsigned);
  const sigBuf = w.sign(b4a.from(msg, 'utf8'));
  const termsSigned = attachSignature(termsUnsigned, {
    signerPubKeyHex: b4a.toString(w.publicKey, 'hex'),
    sigHex: b4a.toString(sigBuf, 'hex'),
  });

  const want = hashUnsignedEnvelope(termsUnsigned);
  assert.equal(hashTermsEnvelope(termsUnsigned), want);
  assert.equal(hashTermsEnvelope(termsSigned), want);
  assert.deepEqual(acceptBodyForTerms(termsSigned), { terms_hash: want });
});

