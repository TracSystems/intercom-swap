import { verifyBolt11MatchesInvoiceBody } from '../ln/bolt11.js';
import { verifyLnUsdtEscrowOnchain } from '../solana/verifyLnUsdtEscrow.js';

const normalizeHex = (value) => String(value || '').trim().toLowerCase();

// Safety margin to reduce asymmetric risk: do not pay an LN invoice if the Solana refund window is too close.
// This is local policy (does not change the wire/on-chain protocol), but it prevents "paid LN but claim
// becomes invalid due to refund_after boundary" in slow/contended conditions.
const DEFAULT_MIN_REFUND_DELTA_SEC = 10 * 60; // 10 minutes
const DEFAULT_MIN_INVOICE_EXPIRY_DELTA_SEC = 60; // 1 minute

export function verifyInvoiceBody({ invoiceBody }) {
  if (!invoiceBody || typeof invoiceBody !== 'object') {
    return { ok: false, error: 'invoiceBody is required', decoded: null };
  }
  return verifyBolt11MatchesInvoiceBody({
    bolt11: invoiceBody.bolt11,
    payment_hash_hex: invoiceBody.payment_hash_hex,
    amount_msat: invoiceBody.amount_msat,
    expires_at_unix: invoiceBody.expires_at_unix,
  });
}

export function verifyEscrowAgainstTerms({ terms, escrowBody }) {
  if (!terms || typeof terms !== 'object') return { ok: false, error: 'terms is required' };
  if (!escrowBody || typeof escrowBody !== 'object') return { ok: false, error: 'escrowBody is required' };

  if (String(escrowBody.recipient) !== String(terms.sol_recipient)) {
    return { ok: false, error: 'escrow recipient mismatch vs terms' };
  }
  if (String(escrowBody.refund) !== String(terms.sol_refund)) {
    return { ok: false, error: 'escrow refund mismatch vs terms' };
  }
  if (String(escrowBody.mint) !== String(terms.sol_mint)) {
    return { ok: false, error: 'escrow mint mismatch vs terms' };
  }
  if (String(escrowBody.amount) !== String(terms.usdt_amount)) {
    return { ok: false, error: 'escrow amount mismatch vs terms' };
  }
  if (Number(escrowBody.refund_after_unix) < Number(terms.sol_refund_after_unix)) {
    return { ok: false, error: 'escrow refund_after_unix earlier than terms' };
  }

  return { ok: true, error: null };
}

// Payer-side checks before paying the LN invoice.
// This is intentionally conservative: if any mismatch is detected, the safe action is "do not pay".
export function verifySwapPrePay({ terms, invoiceBody, escrowBody, now_unix = null }) {
  if (!terms || typeof terms !== 'object') return { ok: false, error: 'terms is required' };
  if (!invoiceBody || typeof invoiceBody !== 'object') return { ok: false, error: 'invoiceBody is required' };
  if (!escrowBody || typeof escrowBody !== 'object') return { ok: false, error: 'escrowBody is required' };

  const inv = verifyInvoiceBody({ invoiceBody });
  if (!inv.ok) return { ok: false, error: `invoice invalid: ${inv.error}`, decoded_invoice: inv.decoded };

  const escrow = verifyEscrowAgainstTerms({ terms, escrowBody });
  if (!escrow.ok) return { ok: false, error: escrow.error, decoded_invoice: inv.decoded };

  if (normalizeHex(invoiceBody.payment_hash_hex) !== normalizeHex(escrowBody.payment_hash_hex)) {
    return { ok: false, error: 'payment_hash mismatch (invoice vs escrow)', decoded_invoice: inv.decoded };
  }

  if (now_unix !== undefined && now_unix !== null) {
    const now = Number(now_unix);
    if (!Number.isFinite(now) || now <= 0) return { ok: false, error: 'now_unix must be a unix seconds number', decoded_invoice: inv.decoded };

    const invoiceExpiresAt = invoiceBody.expires_at_unix ?? inv.decoded?.expires_at_unix ?? null;
    if (invoiceExpiresAt !== null && invoiceExpiresAt !== undefined) {
      if (now >= Number(invoiceExpiresAt)) {
        return { ok: false, error: 'invoice already expired', decoded_invoice: inv.decoded };
      }
      const minInvDelta = DEFAULT_MIN_INVOICE_EXPIRY_DELTA_SEC;
      if (Number.isFinite(minInvDelta) && minInvDelta > 0) {
        const delta = Number(invoiceExpiresAt) - now;
        if (Number.isFinite(delta) && delta < minInvDelta) {
          return {
            ok: false,
            error: `invoice expires too soon (need >=${minInvDelta}s margin)`,
            decoded_invoice: inv.decoded,
          };
        }
      }
    }
    if (escrowBody.refund_after_unix !== undefined && escrowBody.refund_after_unix !== null) {
      if (now >= Number(escrowBody.refund_after_unix)) {
        return { ok: false, error: 'escrow refund_after already reached', decoded_invoice: inv.decoded };
      }
      const minRefundDelta = DEFAULT_MIN_REFUND_DELTA_SEC;
      if (Number.isFinite(minRefundDelta) && minRefundDelta > 0) {
        const delta = Number(escrowBody.refund_after_unix) - now;
        if (Number.isFinite(delta) && delta < minRefundDelta) {
          return {
            ok: false,
            error: `escrow refund_after too soon (need >=${minRefundDelta}s claim margin)`,
            decoded_invoice: inv.decoded,
          };
        }
      }
    }
  }

  return { ok: true, error: null, decoded_invoice: inv.decoded };
}

export async function verifySwapPrePayOnchain({
  terms,
  invoiceBody,
  escrowBody,
  connection,
  commitment = 'confirmed',
  now_unix = null,
} = {}) {
  const base = verifySwapPrePay({ terms, invoiceBody, escrowBody, now_unix });
  if (!base.ok) return base;

  const onchain = await verifyLnUsdtEscrowOnchain({ connection, escrowBody, commitment });
  if (!onchain.ok) {
    return {
      ok: false,
      error: `escrow onchain invalid: ${onchain.error}`,
      decoded_invoice: base.decoded_invoice,
      onchain,
    };
  }

  return { ok: true, error: null, decoded_invoice: base.decoded_invoice, onchain };
}
