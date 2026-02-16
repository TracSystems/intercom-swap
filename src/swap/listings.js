import { sha256Hex } from './hash.js';

function normalizeHex32(hex, label) {
  const s = String(hex || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(s)) throw new Error(`${label} must be 32-byte hex`);
  return s;
}

// Offer envelopes (swap.svc_announce) are reposted periodically for discovery.
// Their envelope hash includes ts+nonce, so it changes on each repost. We need a stable
// identifier for "the same offer listing" across reposts so listing consumption is deterministic.
export function deriveOfferListingId({ signerHex, offerTradeId, appHash = '', solanaProgramId = '' } = {}) {
  const signer = normalizeHex32(signerHex, 'signerHex');
  const tradeId = String(offerTradeId || '').trim();
  if (!tradeId) throw new Error('offerTradeId is required');
  const a = String(appHash || '').trim().toLowerCase();
  const p = String(solanaProgramId || '').trim();
  return sha256Hex(`offer_listing_v1:${signer}:${tradeId}:${a}:${p}`);
}

