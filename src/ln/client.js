import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

function parseJsonOrJsonLines(text) {
  const s = String(text || '').trim();
  if (!s) return { result: '' };

  try {
    return JSON.parse(s);
  } catch (_e) {
    // Some lncli commands emit multiple JSON objects (stream) in a single stdout.
    // Extract a sequence of top-level JSON objects/arrays by brace matching.
    const out = [];

    let i = 0;
    while (i < s.length) {
      // Skip whitespace until we find a JSON start.
      while (i < s.length && /\s/.test(s[i])) i += 1;
      if (i >= s.length) break;

      const start = s[i];
      const open = start === '{' ? '{' : start === '[' ? '[' : null;
      const close = start === '{' ? '}' : start === '[' ? ']' : null;
      if (!open) break;

      let depth = 0;
      let inString = false;
      let esc = false;
      let j = i;
      for (; j < s.length; j += 1) {
        const ch = s[j];
        if (inString) {
          if (esc) {
            esc = false;
            continue;
          }
          if (ch === '\\') {
            esc = true;
            continue;
          }
          if (ch === '"') {
            inString = false;
            continue;
          }
          continue;
        }

        if (ch === '"') {
          inString = true;
          continue;
        }
        if (ch === open) depth += 1;
        if (ch === close) {
          depth -= 1;
          if (depth === 0) {
            j += 1;
            break;
          }
        }
      }

      if (depth !== 0) break;
      const chunk = s.slice(i, j).trim();
      try {
        out.push(JSON.parse(chunk));
      } catch (_e2) {}
      i = j;
    }

    if (out.length > 0) return out[out.length - 1];
    return { result: s };
  }
}

function decodeMaybeB64Hex(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  if (/^[0-9a-f]{64}$/i.test(s)) return s.toLowerCase();
  try {
    const hex = Buffer.from(s, 'base64').toString('hex');
    if (/^[0-9a-f]{64}$/i.test(hex)) return hex.toLowerCase();
    return null;
  } catch (_e) {
    return null;
  }
}

function normalizeClnAmountMsat(amountMsat) {
  const s = String(amountMsat || '').trim();
  if (!s) throw new Error('Missing amount');
  if (/^[0-9]+(msat|sat)$/i.test(s)) return s;
  if (/^[0-9]+$/.test(s)) return `${s}msat`;
  throw new Error(`Invalid CLN amount: ${s} (expected <n> or <n>msat/<n>sat)`);
}

function isUnknownFlagError(err, flagName) {
  const msg = String(err?.message || '').toLowerCase();
  const name = String(flagName || '').trim().replace(/^--?/, '').toLowerCase();
  if (!name) return false;
  if (!(msg.includes('flag provided but not defined') || msg.includes('unknown flag'))) return false;
  return msg.includes(name);
}

async function execCli({ cmd, args, cwd }) {
  try {
    const { stdout } = await execFileP(cmd, args, { cwd, maxBuffer: 1024 * 1024 * 50 });
    return parseJsonOrJsonLines(stdout);
  } catch (err) {
    const code = err?.code;
    const stderr = String(err?.stderr || '').trim();
    const stdout = String(err?.stdout || '').trim();
    const msg = stderr || stdout || err?.message || String(err);
    const e = new Error(msg);
    e.code = code;
    throw e;
  }
}

async function lnClnCli({
  backend,
  composeFile,
  service,
  network,
  cliBin,
  args,
  cwd,
}) {
  const useDocker = backend === 'docker';
  const cmd = useDocker ? 'docker' : (cliBin || 'lightning-cli');
  const fullArgs = useDocker
    ? ['compose', '-f', composeFile, 'exec', '-T', service, 'lightning-cli', `--network=${network}`, ...args]
    : [`--network=${network}`, ...args];
  return execCli({ cmd, args: fullArgs, cwd });
}

async function lnLndCli({
  backend,
  composeFile,
  service,
  network,
  cliBin,
  lnd = null,
  args,
  cwd,
}) {
  const useDocker = backend === 'docker';
  const lncliBin = cliBin || 'lncli';
  const baseArgs = [`--network=${network}`];
  // For CLI backend, lnd connection details should be explicit.
  if (!useDocker) {
    if (lnd?.rpcserver) baseArgs.push(`--rpcserver=${String(lnd.rpcserver)}`);
    if (lnd?.tlscertpath) baseArgs.push(`--tlscertpath=${String(lnd.tlscertpath)}`);
    if (lnd?.macaroonpath) baseArgs.push(`--macaroonpath=${String(lnd.macaroonpath)}`);
    if (lnd?.lnddir) baseArgs.push(`--lnddir=${String(lnd.lnddir)}`);
  }

  const cmd = useDocker ? 'docker' : lncliBin;
  const fullArgs = useDocker
    ? ['compose', '-f', composeFile, 'exec', '-T', service, lncliBin, ...baseArgs, ...args]
    : [...baseArgs, ...args];
  return execCli({ cmd, args: fullArgs, cwd });
}

export async function lnGetInfo(opts) {
  if (opts.impl === 'lnd') return lnLndCli({ ...opts, args: ['getinfo'] });
  return lnClnCli({ ...opts, args: ['getinfo'] });
}

export async function lnListFunds(opts) {
  if (opts.impl === 'lnd') {
    const wallet = await lnLndCli({ ...opts, args: ['walletbalance'] });
    const channel = await lnLndCli({ ...opts, args: ['channelbalance'] });
    const channels = await lnLndCli({ ...opts, args: ['listchannels'] });
    return { wallet, channel, channels };
  }
  return lnClnCli({ ...opts, args: ['listfunds'] });
}

export async function lnListChannels(opts) {
  if (opts.impl === 'lnd') {
    return lnLndCli({ ...opts, args: ['listchannels'] });
  }
  // CLN: prefer richer channel view (states, balances) over listfunds-only view.
  return lnClnCli({ ...opts, args: ['listpeerchannels'] });
}

export async function lnListPeers(opts) {
  if (opts.impl === 'lnd') {
    return lnLndCli({ ...opts, args: ['listpeers'] });
  }
  return lnClnCli({ ...opts, args: ['listpeers'] });
}

export async function lnNewAddress(opts, { type = 'p2wkh' } = {}) {
  if (opts.impl === 'lnd') {
    const r = await lnLndCli({ ...opts, args: ['newaddress', type] });
    const address = String(r?.address || '').trim();
    if (!address) throw new Error('LND newaddress missing address');
    return { address, raw: r };
  }
  const r = await lnClnCli({ ...opts, args: ['newaddr'] });
  const address = String(r?.bech32 || '').trim();
  if (!address) throw new Error('CLN newaddr missing bech32');
  return { address, raw: r };
}

export async function lnConnect(opts, { peer }) {
  const p = String(peer || '').trim();
  if (!p) throw new Error('Missing peer');
  if (opts.impl === 'lnd') return lnLndCli({ ...opts, args: ['connect', p] });
  return lnClnCli({ ...opts, args: ['connect', p] });
}

export async function lnFundChannel(opts, { nodeId, amountSats, privateFlag = false, satPerVbyte = null, block = true }) {
  const id = String(nodeId || '').trim();
  const amt = Number(amountSats);
  if (!id) throw new Error('Missing nodeId');
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('Invalid amountSats');

  if (opts.impl === 'lnd') {
    const args = ['openchannel', '--node_key', id, '--local_amt', String(amt)];
    if (privateFlag) args.push('--private');
    if (Number.isInteger(satPerVbyte) && satPerVbyte > 0) args.push('--sat_per_vbyte', String(Math.trunc(satPerVbyte)));
    if (block) args.push('--block');
    return lnLndCli({ ...opts, args });
  }

  // For CLN, use named args so we can safely plumb optional fields without relying on positional ordering.
  const args = ['fundchannel', `id=${id}`, `amount=${String(amt)}`];
  if (privateFlag) args.push('announce=false');
  if (Number.isInteger(satPerVbyte) && satPerVbyte > 0) {
    // CLN expects feerate as "<n>perkw" (sats per 1000 weight units). 1 vB = 4 weight units -> 1kw = 250 vB.
    const perkw = Math.max(1, Math.trunc(satPerVbyte) * 250);
    args.push(`feerate=${perkw}perkw`);
  }
  return lnClnCli({ ...opts, args });
}

function readBoolLike(v, fallback = false) {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) && v !== 0;
  const s = String(v).trim().toLowerCase();
  if (!s) return fallback;
  return s === '1' || s === 'true' || s === 'yes' || s === 'y';
}

function extractTxidLike(obj) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of ['txid', 'splice_txid', 'funding_txid', 'tx_hash', 'transaction_id']) {
    const s = String(obj?.[k] || '').trim().toLowerCase();
    if (/^[0-9a-f]{64}$/.test(s)) return s;
  }
  return null;
}

export async function lnSpliceChannel(opts, { channelId, relativeSats, satPerVbyte = null, maxRounds = 24, signFirst = false }) {
  const id = String(channelId || '').trim();
  if (!id) throw new Error('Missing channelId');

  const rel = Number(relativeSats);
  if (!Number.isFinite(rel) || !Number.isInteger(rel) || rel === 0) {
    throw new Error('Invalid relativeSats (must be a non-zero integer, sats)');
  }

  const rounds = Number(maxRounds);
  if (!Number.isFinite(rounds) || !Number.isInteger(rounds) || rounds < 1 || rounds > 100) {
    throw new Error('Invalid maxRounds (expected integer 1..100)');
  }

  const feeRate = satPerVbyte === null || satPerVbyte === undefined ? null : Number(satPerVbyte);
  if (feeRate !== null && (!Number.isFinite(feeRate) || !Number.isInteger(feeRate) || feeRate < 1 || feeRate > 10_000)) {
    throw new Error('Invalid satPerVbyte (expected integer 1..10000)');
  }

  if (opts.impl !== 'cln') {
    throw new Error(`Splicing is not supported for ln.impl=${String(opts.impl || 'unknown')}. Use additional channel opens (or close/reopen) instead.`);
  }

  // CLN expects feerate as sat/kw for splice_*; 1 sat/vB = 250 sat/kw.
  const perkw = feeRate !== null ? Math.max(1, Math.trunc(feeRate) * 250) : null;
  const initArgs = ['splice_init', `channel_id=${id}`, `relative_amount=${String(rel)}`];
  if (perkw !== null) initArgs.push(`feerate_per_kw=${String(perkw)}`);

  let init = null;
  try {
    init = await lnClnCli({ ...opts, args: initArgs });
  } catch (e) {
    const msg = String(e?.message || e || '');
    if (/splicing not supported/i.test(msg)) {
      throw new Error('CLN reports splicing is not enabled. Start lightningd with experimental splicing support to use this operation.');
    }
    throw e;
  }

  let last = init;
  let psbt = String(last?.psbt || '').trim();
  let commitmentsSecured = readBoolLike(last?.commitments_secured, false);
  let updateRounds = 0;

  while (!commitmentsSecured) {
    if (!psbt) {
      throw new Error('splice_init/splice_update did not return a PSBT to continue negotiation');
    }
    updateRounds += 1;
    if (updateRounds > rounds) {
      throw new Error(`splice_update did not reach commitments_secured=true within ${rounds} rounds`);
    }
    last = await lnClnCli({ ...opts, args: ['splice_update', id, psbt] });
    psbt = String(last?.psbt || '').trim();
    commitmentsSecured = readBoolLike(last?.commitments_secured, false);
  }

  if (!psbt) {
    throw new Error('splice negotiation reached commitments_secured=true but no PSBT was returned for signing');
  }

  const signed = await lnClnCli({ ...opts, args: ['signpsbt', psbt] });
  const signedPsbt = String(signed?.signed_psbt || signed?.psbt || '').trim();
  if (!signedPsbt) throw new Error('signpsbt did not return a signed PSBT');

  const signedArgs = ['splice_signed', id, signedPsbt];
  if (signFirst) signedArgs.push('true');
  const done = await lnClnCli({ ...opts, args: signedArgs });

  return {
    type: 'ln_splice',
    channel_id: id,
    relative_sats: rel,
    fee_per_kw: perkw,
    update_rounds: updateRounds,
    commitments_secured: commitmentsSecured,
    txid: extractTxidLike(done) || extractTxidLike(last) || extractTxidLike(init),
    raw: {
      init,
      update_last: last,
      signpsbt: signed,
      splice_signed: done,
    },
  };
}

function parseLndChannelPoint(channelIdRaw) {
  const s = String(channelIdRaw || '').trim();
  const m = s.match(/^([0-9a-fA-F]{64}):([0-9]+)$/);
  if (!m) throw new Error('LND channel_id must be funding_txid:output_index');
  const fundingTxid = m[1].toLowerCase();
  const outputIndex = Number.parseInt(m[2], 10);
  if (!Number.isInteger(outputIndex) || outputIndex < 0) {
    throw new Error('LND channel_id output index is invalid');
  }
  return { fundingTxid, outputIndex };
}

export async function lnCloseChannel(opts, { channelId, force = false, satPerVbyte = null, block = false }) {
  const id = String(channelId || '').trim();
  if (!id) throw new Error('Missing channelId');

  if (opts.impl === 'lnd') {
    const { fundingTxid, outputIndex } = parseLndChannelPoint(id);
    const args = ['closechannel', '--funding_txid', fundingTxid, '--output_index', String(outputIndex)];
    if (force) args.push('--force');
    if (Number.isInteger(satPerVbyte) && satPerVbyte > 0) args.push('--sat_per_vbyte', String(Math.trunc(satPerVbyte)));
    if (block) args.push('--block');
    return lnLndCli({ ...opts, args });
  }

  // CLN uses "close <id>" where id may be peer_id/channel_id/short_channel_id.
  // We keep this cooperative by default and do not expose forced close knobs here.
  if (force) {
    throw new Error('CLN force close is not supported by this tool path (use expert tooling if required)');
  }
  if (satPerVbyte !== null && satPerVbyte !== undefined) {
    throw new Error('CLN close fee override is not supported by this tool path');
  }
  return lnClnCli({ ...opts, args: ['close', id] });
}

export async function lnInvoice(opts, { amountMsat, label, description, expirySec = null }) {
  const desc = String(description || '').trim();
  if (!desc) throw new Error('Missing invoice description');

  if (opts.impl === 'lnd') {
    const memo = String(label || '').trim() ? `${String(label).trim()} ${desc}`.trim() : desc;
    const amt = BigInt(String(amountMsat));
    if (amt <= 0n) throw new Error('Invalid amountMsat');
    const args = ['addinvoice', '--amt_msat', String(amt), '--memo', memo];
    if (expirySec !== null && expirySec !== undefined) {
      const exp = Number(expirySec);
      if (Number.isFinite(exp) && exp > 0) args.push('--expiry', String(exp));
    }
    const r = await lnLndCli({ ...opts, args });

    const bolt11 = String(r?.payment_request || r?.paymentRequest || '').trim();
    if (!bolt11) throw new Error('LND addinvoice missing payment_request');

    const paymentHashHex =
      decodeMaybeB64Hex(r?.r_hash_str) ||
      decodeMaybeB64Hex(r?.r_hash) ||
      decodeMaybeB64Hex(r?.rHashStr) ||
      decodeMaybeB64Hex(r?.rHash);
    if (!paymentHashHex) throw new Error('LND addinvoice missing r_hash(_str)');

    return { bolt11, payment_hash: paymentHashHex, raw: r };
  }

  const amount = normalizeClnAmountMsat(amountMsat);
  const lab = String(label || '').trim();
  if (!lab) throw new Error('Missing invoice label');
  const args = ['invoice', amount, lab, desc];
  if (expirySec !== null && expirySec !== undefined) {
    const exp = Number(expirySec);
    if (Number.isFinite(exp) && exp > 0) args.push(String(exp));
  }
  const r = await lnClnCli({ ...opts, args });
  const bolt11 = String(r?.bolt11 || '').trim();
  const paymentHashHex = String(r?.payment_hash || '').trim().toLowerCase();
  if (!bolt11) throw new Error('CLN invoice missing bolt11');
  if (!/^[0-9a-f]{64}$/.test(paymentHashHex)) throw new Error('CLN invoice missing payment_hash');
  return { bolt11, payment_hash: paymentHashHex, raw: r };
}

export async function lnDecodePay(opts, { bolt11 }) {
  const inv = String(bolt11 || '').trim();
  if (!inv) throw new Error('Missing bolt11');
  if (opts.impl === 'lnd') return lnLndCli({ ...opts, args: ['decodepayreq', inv] });
  return lnClnCli({ ...opts, args: ['decodepay', inv] });
}

export async function lnPay(
  opts,
  {
    bolt11,
    allowSelfPayment = false,
    feeLimitSat = null,
    outgoingChanId = null,
    lastHopPubkey = null,
  } = {}
) {
  const inv = String(bolt11 || '').trim();
  if (!inv) throw new Error('Missing bolt11');

  if (opts.impl === 'lnd') {
    let feeLimitInt = null;
    if (feeLimitSat !== null && feeLimitSat !== undefined) {
      const n = Number(feeLimitSat);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) throw new Error('Invalid feeLimitSat');
      feeLimitInt = n;
    }
    const buildLndPayArgs = (feeFlag = '--fee_limit_sat') => {
      const args = ['payinvoice', '--force', '--json'];
      if (allowSelfPayment) args.push('--allow_self_payment');
      if (feeLimitInt !== null) args.push(feeFlag, String(feeLimitInt));
      if (outgoingChanId !== null && outgoingChanId !== undefined) {
        const s = String(outgoingChanId).trim();
        if (!/^[0-9]+$/.test(s)) throw new Error('Invalid outgoingChanId (expected numeric chan_id)');
        args.push('--outgoing_chan_id', s);
      }
      if (lastHopPubkey !== null && lastHopPubkey !== undefined) {
        const s = String(lastHopPubkey).trim().toLowerCase();
        if (!/^[0-9a-f]{66}$/i.test(s)) throw new Error('Invalid lastHopPubkey (expected hex33)');
        args.push('--last_hop', s);
      }
      args.push(inv);
      return args;
    };

    let r;
    try {
      r = await lnLndCli({ ...opts, args: buildLndPayArgs('--fee_limit_sat') });
    } catch (err) {
      // lncli versions differ: some use --fee_limit instead of --fee_limit_sat.
      if (feeLimitInt !== null && isUnknownFlagError(err, '--fee_limit_sat')) {
        r = await lnLndCli({ ...opts, args: buildLndPayArgs('--fee_limit') });
      } else {
        throw err;
      }
    }
    const preimageHex =
      decodeMaybeB64Hex(r?.payment_preimage) ||
      decodeMaybeB64Hex(r?.paymentPreimage) ||
      decodeMaybeB64Hex(r?.payment_preimage_hex) ||
      decodeMaybeB64Hex(r?.paymentPreimageHex);
    if (!preimageHex) throw new Error('LND payinvoice missing payment_preimage');
    return { payment_preimage: preimageHex, raw: r };
  }

  if (allowSelfPayment) {
    // No reliable cross-version CLN equivalent for explicit self-pay routing in this tool path.
    // We still attempt a normal pay below.
  }
  const r = await lnClnCli({ ...opts, args: ['pay', inv] });
  const preimageHex = String(r?.payment_preimage || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(preimageHex)) throw new Error('CLN pay missing payment_preimage');
  return { payment_preimage: preimageHex, raw: r };
}

export async function lnPayStatus(opts, { paymentHashHex }) {
  const hash = String(paymentHashHex || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('paymentHashHex must be 32-byte hex');

  if (opts.impl === 'lnd') {
    // No direct "lookup outgoing payment by hash" command; scan a window.
    const r = await lnLndCli({ ...opts, args: ['listpayments', '--include_incomplete', '--max_payments', '200'] });
    const payments = Array.isArray(r?.payments) ? r.payments : [];
    const match = payments.find((p) => {
      const cand = decodeMaybeB64Hex(p?.payment_hash) || decodeMaybeB64Hex(p?.paymentHash);
      return cand === hash;
    }) || null;
    return { payment_hash_hex: hash, payment: match, raw: r };
  }

  // CLN versions differ; try listpays first, then listsendpays.
  let r;
  try {
    r = await lnClnCli({ ...opts, args: ['listpays', hash] });
  } catch (_e) {
    r = await lnClnCli({ ...opts, args: ['listsendpays', hash] });
  }
  return { payment_hash_hex: hash, raw: r };
}

export async function lnPreimageGet(opts, { paymentHashHex }) {
  const st = await lnPayStatus(opts, { paymentHashHex });

  if (opts.impl === 'lnd') {
    const p = st.payment;
    const preimageHex =
      decodeMaybeB64Hex(p?.payment_preimage) ||
      decodeMaybeB64Hex(p?.paymentPreimage) ||
      decodeMaybeB64Hex(p?.payment_preimage_hex) ||
      decodeMaybeB64Hex(p?.paymentPreimageHex);
    return { payment_hash_hex: st.payment_hash_hex, preimage_hex: preimageHex, raw: st.raw };
  }

  const pays = Array.isArray(st.raw?.pays) ? st.raw.pays : Array.isArray(st.raw?.payments) ? st.raw.payments : [];
  let preimageHex = null;
  for (const p of pays) {
    const cand = p?.preimage || p?.payment_preimage || p?.payment_preimage_hex || p?.preimage_hex;
    if (typeof cand === 'string' && /^[0-9a-f]{64}$/i.test(cand.trim())) {
      preimageHex = cand.trim().toLowerCase();
      break;
    }
  }
  return { payment_hash_hex: st.payment_hash_hex, preimage_hex: preimageHex, raw: st.raw };
}

export async function lnWithdraw(opts, { address, amountSats, satPerVbyte = null }) {
  const addr = String(address || '').trim();
  if (!addr) throw new Error('Missing address');
  const amt = Number(amountSats);
  if (!Number.isFinite(amt) || !Number.isInteger(amt) || amt <= 0) throw new Error('Invalid amountSats');

  const feeRate = satPerVbyte === null || satPerVbyte === undefined ? null : Number(satPerVbyte);
  if (feeRate !== null && (!Number.isFinite(feeRate) || !Number.isInteger(feeRate) || feeRate < 1 || feeRate > 10_000)) {
    throw new Error('Invalid satPerVbyte (expected integer 1..10000)');
  }

  if (opts.impl === 'lnd') {
    const args = ['sendcoins', '--addr', addr, '--amount', String(amt)];
    if (feeRate !== null) args.push('--sat_per_vbyte', String(feeRate));
    return lnLndCli({ ...opts, args });
  }

  // CLN withdraw feerate can be provided as a string; we support sat/vbyte by converting
  // to sat/kw ("perkw") since CLN accepts <n>perkw.
  const args = ['withdraw', addr, String(amt)];
  if (feeRate !== null) {
    const perkw = Math.max(1, Math.trunc(feeRate * 250));
    args.push(`${perkw}perkw`);
  }
  return lnClnCli({ ...opts, args });
}
