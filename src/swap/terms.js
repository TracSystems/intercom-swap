import { KIND } from './constants.js';
import { hashUnsignedEnvelope } from './hash.js';

function stripSignature(envelope) {
  const { sig: _sig, signer: _signer, ...unsigned } = envelope || {};
  return unsigned;
}

export function hashTermsEnvelope(termsEnvelope) {
  if (!termsEnvelope || typeof termsEnvelope !== 'object') throw new Error('termsEnvelope is required');
  const unsigned = stripSignature(termsEnvelope);
  if (unsigned.kind !== KIND.TERMS) throw new Error(`Expected kind=${KIND.TERMS}`);
  return hashUnsignedEnvelope(unsigned);
}

export function acceptBodyForTerms(termsEnvelope) {
  return { terms_hash: hashTermsEnvelope(termsEnvelope) };
}

