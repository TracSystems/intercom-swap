import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import {
  createAssociatedTokenAccount,
  createMint,
  getAccount,
  getAssociatedTokenAddress,
  mintTo,
  transfer as splTransfer,
} from '@solana/spl-token';

import { ScBridgeClient } from '../sc-bridge/client.js';
import { createUnsignedEnvelope, attachSignature, signUnsignedEnvelopeHex, verifySignedEnvelope } from '../protocol/signedMessage.js';
import { validateSwapEnvelope } from '../swap/schema.js';
import { ASSET, KIND, PAIR } from '../swap/constants.js';
import { INTERCOMSWAP_APP_TAG, deriveIntercomswapAppHash } from '../swap/app.js';
import { hashUnsignedEnvelope, sha256Hex } from '../swap/hash.js';
import { hashTermsEnvelope } from '../swap/terms.js';
import { verifySwapPrePayOnchain } from '../swap/verify.js';
import {
  createSignedWelcome,
  createSignedInvite,
  signPayloadHex,
} from '../sidechannel/capabilities.js';
import { loadPeerWalletFromFile } from '../peer/keypair.js';

import {
  lnConnect,
  lnDecodePay,
  lnFundChannel,
  lnGetInfo,
  lnInvoice,
  lnListFunds,
  lnNewAddress,
  lnPay,
  lnPayStatus,
  lnPreimageGet,
  lnWithdraw,
} from '../ln/client.js';

import { generateSolanaKeypair, readSolanaKeypair, writeSolanaKeypair } from '../solana/keypair.js';
import { SolanaRpcPool } from '../solana/rpcPool.js';
import { solLocalStart, solLocalStatus, solLocalStop } from '../solana/localValidatorManager.js';
import {
  LN_USDT_ESCROW_PROGRAM_ID,
  deriveEscrowPda,
  deriveConfigPda,
  deriveTradeConfigPda,
  createEscrowTx,
  claimEscrowTx,
  refundEscrowTx,
  getConfigState,
  getTradeConfigState,
  getEscrowState,
  initConfigTx,
  initTradeConfigTx,
  setConfigTx,
  setTradeConfigTx,
  withdrawFeesTx,
  withdrawTradeFeesTx,
} from '../solana/lnUsdtEscrowClient.js';
import { isSecretHandle } from './secrets.js';

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function assertPlainObject(args, toolName) {
  if (!isObject(args)) throw new Error(`${toolName}: arguments must be an object`);
  const proto = Object.getPrototypeOf(args);
  if (proto !== Object.prototype && proto !== null) throw new Error(`${toolName}: arguments must be a plain object`);
}

function assertAllowedKeys(args, toolName, allowed) {
  const allow = new Set(allowed);
  for (const k of Object.keys(args)) {
    if (!allow.has(k)) throw new Error(`${toolName}: unexpected argument "${k}"`);
  }
}

function expectString(args, toolName, key, { min = 1, max = 10_000, pattern = null } = {}) {
  const v = args[key];
  if (typeof v !== 'string') throw new Error(`${toolName}: ${key} must be a string`);
  const s = v.trim();
  if (s.length < min) throw new Error(`${toolName}: ${key} must be at least ${min} chars`);
  if (s.length > max) throw new Error(`${toolName}: ${key} must be <= ${max} chars`);
  if (pattern && !pattern.test(s)) throw new Error(`${toolName}: ${key} is invalid`);
  return s;
}

function expectOptionalString(args, toolName, key, { min = 1, max = 10_000, pattern = null } = {}) {
  if (!(key in args) || args[key] === null || args[key] === undefined) return null;
  // Treat empty/whitespace strings as "not set" for optional fields. This makes the tool surface
  // more robust against weaker models that emit "" for optional strings.
  if (typeof args[key] === 'string' && !String(args[key]).trim()) return null;
  return expectString(args, toolName, key, { min, max, pattern });
}

function expectInt(args, toolName, key, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const v = args[key];
  if (!Number.isInteger(v)) throw new Error(`${toolName}: ${key} must be an integer`);
  if (v < min) throw new Error(`${toolName}: ${key} must be >= ${min}`);
  if (v > max) throw new Error(`${toolName}: ${key} must be <= ${max}`);
  return v;
}

function expectOptionalInt(args, toolName, key, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!(key in args) || args[key] === null || args[key] === undefined) return null;
  return expectInt(args, toolName, key, { min, max });
}

function expectBool(args, toolName, key) {
  const v = args[key];
  if (typeof v !== 'boolean') throw new Error(`${toolName}: ${key} must be a boolean`);
  return v;
}

function normalizeChannelName(name) {
  const s = String(name || '').trim();
  if (!s) throw new Error('channel is required');
  if (s.length > 128) throw new Error('channel too long');
  if (/\s/.test(s)) throw new Error('channel must not contain whitespace');
  return s;
}

function normalizeHex32(hex, label = 'hex32') {
  const s = String(hex || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(s)) throw new Error(`${label} must be 32-byte hex`);
  return s;
}

function normalizeHex33(hex, label = 'hex33') {
  const s = String(hex || '').trim().toLowerCase();
  if (!/^[0-9a-f]{66}$/.test(s)) throw new Error(`${label} must be 33-byte hex`);
  return s;
}

function normalizeBase58(s, label = 'base58') {
  const v = String(s || '').trim();
  if (!v) throw new Error(`${label} is required`);
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(v)) throw new Error(`${label} invalid`);
  return v;
}

function normalizeAtomicAmount(s, label = 'amount') {
  const v = String(s || '').trim();
  if (!/^[0-9]+$/.test(v)) throw new Error(`${label} must be a decimal string integer`);
  return v;
}

function parseLocalRpcPortFromUrls(urls, fallback = 8899) {
  try {
    const first = Array.isArray(urls) ? String(urls[0] || '') : String(urls || '');
    const raw = first.split(',')[0].trim();
    if (!raw) return fallback;
    const u = new URL(raw);
    const host = String(u.hostname || '').trim().toLowerCase();
    if (host !== '127.0.0.1' && host !== 'localhost') return fallback;
    const p = u.port ? Number.parseInt(u.port, 10) : 0;
    if (Number.isFinite(p) && p > 0 && p <= 65535) return p;
    // Default ports by protocol (rare for Solana, but keep sane).
    if (u.protocol === 'https:') return 443;
    if (u.protocol === 'http:') return 80;
    return fallback;
  } catch (_e) {
    return fallback;
  }
}

const SOL_REFUND_MIN_SEC = 3600; // 1h
const SOL_REFUND_MAX_SEC = 7 * 24 * 3600; // 1w
const SOL_REFUND_DEFAULT_SEC = 72 * 3600; // 72h

function assertRefundAfterUnixWindow(refundAfterUnix, toolName) {
  const now = Math.floor(Date.now() / 1000);
  const delta = Number(refundAfterUnix) - now;
  if (!Number.isFinite(delta)) throw new Error(`${toolName}: refund_after_unix invalid`);
  if (delta < SOL_REFUND_MIN_SEC) {
    throw new Error(`${toolName}: refund_after_unix too soon (min ${SOL_REFUND_MIN_SEC}s from now)`);
  }
  if (delta > SOL_REFUND_MAX_SEC) {
    throw new Error(`${toolName}: refund_after_unix too far (max ${SOL_REFUND_MAX_SEC}s from now)`);
  }
}

function stripSignature(envelope) {
  const { sig: _sig, signer: _signer, ...unsigned } = envelope || {};
  return unsigned;
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (_e) {
    return JSON.stringify({ error: 'unserializable tool result' });
  }
}

function decodeB64JsonMaybe(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  const s = String(value || '').trim();
  if (!s) return null;
  try {
    const decoded = Buffer.from(s, 'base64').toString('utf8');
    return JSON.parse(decoded);
  } catch (_e) {
    return null;
  }
}

function resolveSecretArg(secrets, value, { label, expectType = null } = {}) {
  if (typeof value !== 'string') return value;
  const s = value.trim();
  if (!isSecretHandle(s)) return value;
  if (!secrets || typeof secrets.get !== 'function') {
    throw new Error(`${label} is a secret handle but no secrets store was provided`);
  }
  const resolved = secrets.get(s);
  if (resolved === null || resolved === undefined) throw new Error(`Unknown ${label} secret handle`);
  if (expectType && typeof resolved !== expectType) throw new Error(`${label} secret handle has invalid type`);
  return resolved;
}

async function withScBridge({ url, token }, fn) {
  const sc = new ScBridgeClient({ url, token });
  try {
    await sc.connect();
    return await fn(sc);
  } finally {
    sc.close();
  }
}

function signSwapEnvelope(unsignedEnvelope, { pubHex, secHex }) {
  const sigHex = signUnsignedEnvelopeHex(unsignedEnvelope, secHex);
  const signed = attachSignature(unsignedEnvelope, { signerPubKeyHex: pubHex, sigHex });
  const v = validateSwapEnvelope(signed);
  if (!v.ok) throw new Error(`Signed envelope invalid: ${v.error}`);
  return signed;
}

async function sendEnvelope(sc, channel, envelope) {
  const v = validateSwapEnvelope(envelope);
  if (!v.ok) throw new Error(`Envelope invalid: ${v.error}`);
  const res = await sc.send(channel, envelope);
  if (res.type === 'error') throw new Error(res.error || 'send failed');
  return res;
}

function requireApproval(toolName, autoApprove) {
  if (autoApprove) return;
  throw new Error(`${toolName}: blocked (auto_approve is false)`);
}

function computePaymentHashFromPreimage(preimageHex) {
  const bytes = Buffer.from(preimageHex, 'hex');
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sanitizeEscrowVerifyOnchain(onchain) {
  if (!onchain || typeof onchain !== 'object') return null;
  const st = onchain.state;
  const state =
    st && typeof st === 'object'
      ? {
          v: st.v ?? null,
          status: st.status ?? null,
          payment_hash_hex: st.paymentHashHex ?? null,
          recipient: st.recipient?.toBase58?.() ?? null,
          refund: st.refund?.toBase58?.() ?? null,
          refund_after_unix: st.refundAfter !== undefined && st.refundAfter !== null ? st.refundAfter.toString() : null,
          mint: st.mint?.toBase58?.() ?? null,
          net_amount: st.netAmount !== undefined && st.netAmount !== null ? st.netAmount.toString() : null,
          fee_amount: st.feeAmount !== undefined && st.feeAmount !== null ? st.feeAmount.toString() : null,
          fee_bps: st.feeBps ?? null,
          vault: st.vault?.toBase58?.() ?? null,
          bump: st.bump ?? null,
        }
      : null;
  return {
    derived_escrow_pda: onchain.derived_escrow_pda ?? null,
    derived_vault_ata: onchain.derived_vault_ata ?? null,
    state,
  };
}

async function sendAndConfirm(connection, tx, commitment) {
  const sig = await connection.sendRawTransaction(tx.serialize());
  const conf = await connection.confirmTransaction(sig, commitment);
  if (conf?.value?.err) throw new Error(`Tx failed: ${JSON.stringify(conf.value.err)}`);
  return sig;
}

async function getOrCreateAta(connection, payerKeypair, owner, mint, commitment) {
  const ata = await getAssociatedTokenAddress(mint, owner, true);
  try {
    await getAccount(connection, ata, commitment);
    return ata;
  } catch (_e) {
    // createAssociatedTokenAccount will throw if ATA exists; retrying is fine.
  }
  await createAssociatedTokenAccount(connection, payerKeypair, mint, owner);
  return ata;
}

function resolveRepoPath(p) {
  const s = String(p || '').trim();
  if (!s) throw new Error('path is required');
  return path.isAbsolute(s) ? s : path.resolve(process.cwd(), s);
}

function resolveOnchainPath(p, { label = 'path', allowDir = false } = {}) {
  const resolved = resolveRepoPath(p);
  const onchainRoot = path.resolve(process.cwd(), 'onchain');
  const rel = path.relative(onchainRoot, resolved);
  const within = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  if (!within && resolved !== onchainRoot) {
    throw new Error(`${label} must be under onchain/ (got ${resolved})`);
  }
  if (!allowDir) {
    const st = fs.existsSync(resolved) ? fs.statSync(resolved) : null;
    if (st && st.isDirectory()) throw new Error(`${label} must be a file path (got directory)`);
  }
  return resolved;
}

function resolveWithinRepoRoot(p, { label = 'path', mustExist = false, allowDir = false } = {}) {
  const resolved = resolveRepoPath(p);
  const root = path.resolve(process.cwd());
  const rel = path.relative(root, resolved);
  const within = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  if (!within && resolved !== root) {
    throw new Error(`${label} must be within the repo root (got ${resolved})`);
  }
  if (mustExist && !fs.existsSync(resolved)) {
    throw new Error(`${label} does not exist: ${resolved}`);
  }
  if (!allowDir) {
    const st = fs.existsSync(resolved) ? fs.statSync(resolved) : null;
    if (st && st.isDirectory()) throw new Error(`${label} must be a file path (got directory)`);
  }
  return resolved;
}

function normalizeDockerServiceName(value, label = 'service') {
  const s = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(s)) {
    throw new Error(`${label}: invalid docker compose service name`);
  }
  return s;
}

async function dockerCompose({ composeFile, args, cwd }) {
  try {
    const { stdout, stderr } = await execFileP('docker', ['compose', '-f', composeFile, ...args], {
      cwd,
      maxBuffer: 1024 * 1024 * 10,
    });
    return { stdout: String(stdout || ''), stderr: String(stderr || '') };
  } catch (err) {
    const stderr = String(err?.stderr || '').trim();
    const stdout = String(err?.stdout || '').trim();
    const msg = stderr || stdout || err?.message || String(err);
    const e = new Error(msg);
    e.code = err?.code;
    throw e;
  }
}

export class ToolExecutor {
  constructor({
    scBridge,
    peer,
    ln,
    solana,
    receipts,
  }) {
    this.scBridge = scBridge; // { url, token }
    this.peer = peer; // { keypairPath }
    this.ln = ln; // config object passed to src/ln/client.js
    this.solana = solana; // { rpcUrls, commitment, programId, keypairPath, computeUnitLimit, computeUnitPriceMicroLamports }
    this.receipts = receipts; // { dbPath }

    // Persistent SC-Bridge session for subscriptions + event polling.
    this._sc = null;
    this._scConnecting = null;
    this._scSubscribed = new Set();
    this._scWaiters = new Set(); // { filter, resolve, reject, timer }
    this._scQueue = [];
    this._scQueueMax = 500;
    // Append-only-ish ring buffer for UI/event streaming (does not interfere with _scQueue consumers).
    this._scSeq = 0;
    this._scLog = []; // [{...evt, seq}]
    this._scLogMax = 2000;
    this._scLogWaiters = new Set(); // { sinceSeq, resolve, timer }

    this._peerSigning = null; // { pubHex, secHex }
    this._solanaKeypair = null;
    this._solanaPool = null;
  }

  _pool() {
    if (this._solanaPool) return this._solanaPool;
    const urls = this.solana?.rpcUrls || 'http://127.0.0.1:8899';
    const commitment = this.solana?.commitment || 'confirmed';
    this._solanaPool = new SolanaRpcPool({ rpcUrls: urls, commitment });
    return this._solanaPool;
  }

  _programId() {
    const s = String(this.solana?.programId || '').trim();
    return s ? new PublicKey(s) : LN_USDT_ESCROW_PROGRAM_ID;
  }

  _commitment() {
    return String(this.solana?.commitment || 'confirmed').trim() || 'confirmed';
  }

  _computeBudget() {
    return {
      computeUnitLimit: this.solana?.computeUnitLimit ?? null,
      computeUnitPriceMicroLamports: this.solana?.computeUnitPriceMicroLamports ?? null,
    };
  }

  _requireSolanaSigner() {
    if (this._solanaKeypair) return this._solanaKeypair;
    const p = String(this.solana?.keypairPath || '').trim();
    if (!p) throw new Error('Solana signer not configured (set solana.keypair in prompt setup JSON)');
    this._solanaKeypair = readSolanaKeypair(p);
    return this._solanaKeypair;
  }

  async _requirePeerSigning() {
    if (this._peerSigning) return this._peerSigning;
    const p = String(this.peer?.keypairPath || '').trim();
    if (!p) {
      throw new Error('Peer signing not configured (set peer.keypair in prompt setup JSON)');
    }
    const { pubHex, secHex } = await loadPeerWalletFromFile(p);
    const sc = await this._scEnsurePersistent({ timeoutMs: 10_000 });
    const peerHex = String(sc?.hello?.peer || '').trim().toLowerCase();
    if (peerHex && peerHex !== pubHex) {
      throw new Error(`peer keypair pubkey mismatch vs sc-bridge peer (${peerHex} != ${pubHex})`);
    }
    this._peerSigning = { pubHex, secHex };
    return this._peerSigning;
  }

  async _openReceiptsStore({ required = false } = {}) {
    const raw = String(this.receipts?.dbPath || '').trim();
    if (!raw) {
      if (required) throw new Error('receipts db not configured (set receipts.db in prompt setup JSON)');
      return null;
    }
    const dbPath = resolveOnchainPath(raw, { label: 'receipts.db' });
    const { TradeReceiptsStore } = await import('../receipts/store.js');
    return TradeReceiptsStore.open({ dbPath });
  }

  async _scEnsurePersistent({ timeoutMs = 10_000 } = {}) {
    if (this._sc && this._sc.ws) return this._sc;
    if (this._scConnecting) return this._scConnecting;

    this._scConnecting = (async () => {
      const sc = new ScBridgeClient({ url: this.scBridge.url, token: this.scBridge.token });
      await sc.connect({ timeoutMs });

      sc.on('sidechannel_message', (msg) => {
        try {
          this._onScEvent(msg);
        } catch (_e) {}
      });

      // Re-apply subscriptions on reconnect.
      if (this._scSubscribed.size > 0) {
        await sc.subscribe(Array.from(this._scSubscribed));
      }

      this._sc = sc;
      this._scConnecting = null;
      return sc;
    })().catch((err) => {
      this._scConnecting = null;
      throw err;
    });

    return this._scConnecting;
  }

  async scEnsureConnected({ timeoutMs = 10_000 } = {}) {
    return this._scEnsurePersistent({ timeoutMs });
  }

  _scLogAppend(evt) {
    // Append to streaming log with a monotonic seq (do not remove on consumption).
    this._scSeq += 1;
    const logEvt = { ...(evt || {}), seq: this._scSeq };
    this._scLog.push(logEvt);
    if (this._scLog.length > this._scLogMax) {
      this._scLog.splice(0, this._scLog.length - this._scLogMax);
    }
    for (const waiter of this._scLogWaiters) {
      try {
        if (this._scSeq > waiter.sinceSeq) {
          this._scLogWaiters.delete(waiter);
          clearTimeout(waiter.timer);
          waiter.resolve(true);
        }
      } catch (_e) {}
    }
  }

  _onScEvent(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type !== 'sidechannel_message') return;
    const channel = String(msg.channel || '').trim();
    if (!channel) return;

    const evt = {
      type: 'sidechannel_message',
      channel,
      id: msg.id ?? null,
      from: msg.from ?? null,
      origin: msg.origin ?? null,
      relayedBy: msg.relayedBy ?? null,
      ttl: msg.ttl ?? null,
      ts: msg.ts ?? Date.now(),
      message: msg.message,
    };

    this._scLogAppend(evt);

    // Deliver directly to a waiter (consume once), otherwise enqueue.
    for (const waiter of this._scWaiters) {
      try {
        if (waiter.filter(evt)) {
          this._scWaiters.delete(waiter);
          clearTimeout(waiter.timer);
          waiter.resolve(evt);
          return;
        }
      } catch (_e) {}
    }

    this._scQueue.push(evt);
    if (this._scQueue.length > this._scQueueMax) {
      this._scQueue.splice(0, this._scQueue.length - this._scQueueMax);
    }
  }

  async _sendEnvelopeLogged(sc, channel, envelope) {
    const res = await sendEnvelope(sc, channel, envelope);
    try {
      const chan = String(channel || '').trim();
      if (chan) {
        this._scLogAppend({
          type: 'sidechannel_outbound',
          dir: 'out',
          local: true,
          channel: chan,
          id: res?.id ?? null,
          from: envelope?.signer ?? null,
          origin: 'local',
          relayedBy: null,
          ttl: null,
          ts: Date.now(),
          message: envelope,
        });
      }
    } catch (_e) {}
    return res;
  }

  scLogInfo() {
    const oldest = this._scLog.length > 0 ? this._scLog[0].seq : null;
    return {
      type: 'sc_log_info',
      subscribed_channels: Array.from(this._scSubscribed),
      oldest_seq: oldest,
      latest_seq: this._scSeq,
      size: this._scLog.length,
      max_size: this._scLogMax,
    };
  }

  scLogRead({ sinceSeq = 0, limit = 500, channels = null } = {}) {
    const since = Number.isFinite(sinceSeq) ? Math.max(0, Math.trunc(sinceSeq)) : 0;
    const lim = Number.isFinite(limit) ? Math.max(1, Math.min(5000, Math.trunc(limit))) : 500;
    const chanSet =
      Array.isArray(channels) && channels.length > 0
        ? new Set(channels.map((c) => normalizeChannelName(String(c))))
        : null;

    const events = [];
    for (const e of this._scLog) {
      if (!e || typeof e !== 'object') continue;
      if (e.seq <= since) continue;
      if (chanSet && !chanSet.has(e.channel)) continue;
      events.push(e);
      if (events.length >= lim) break;
    }

    const oldest = this._scLog.length > 0 ? this._scLog[0].seq : null;
    return {
      type: 'sc_log_read',
      since_seq: since,
      oldest_seq: oldest,
      latest_seq: this._scSeq,
      events,
    };
  }

  async scLogWait({ sinceSeq = 0, timeoutMs = 15_000 } = {}) {
    const since = Number.isFinite(sinceSeq) ? Math.max(0, Math.trunc(sinceSeq)) : 0;
    const to = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(120_000, Math.trunc(timeoutMs))) : 15_000;
    if (this._scSeq > since) return true;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._scLogWaiters.delete(waiter);
        resolve(false);
      }, to);
      const waiter = { sinceSeq: since, resolve, timer };
      this._scLogWaiters.add(waiter);
    });
  }

  async _scWaitFor(filterFn, { timeoutMs = 10_000 } = {}) {
    // First, drain from queue.
    for (let i = 0; i < this._scQueue.length; i += 1) {
      const evt = this._scQueue[i];
      try {
        if (filterFn(evt)) {
          this._scQueue.splice(i, 1);
          return evt;
        }
      } catch (_e) {}
    }

    if (!timeoutMs || timeoutMs <= 0) return null;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._scWaiters.delete(waiter);
        resolve(null);
      }, timeoutMs);
      const waiter = { filter: filterFn, resolve, reject, timer };
      this._scWaiters.add(waiter);
    });
  }

  async execute(toolName, args, { autoApprove = false, dryRun = false, secrets = null } = {}) {
    assertPlainObject(args ?? {}, toolName);

    if (toolName === 'intercomswap_app_info') {
      assertAllowedKeys(args, toolName, []);
      const programId = this._programId().toBase58();
      const appHash = deriveIntercomswapAppHash({ solanaProgramId: programId, appTag: INTERCOMSWAP_APP_TAG });
      return { type: 'app_info', app_tag: INTERCOMSWAP_APP_TAG, solana_program_id: programId, app_hash: appHash };
    }

    if (toolName === 'intercomswap_env_get') {
      assertAllowedKeys(args, toolName, []);

      const lnImpl = String(this.ln?.impl || '').trim() || 'cln';
      const lnBackend = String(this.ln?.backend || '').trim() || 'cli';
      const lnNetwork = String(this.ln?.network || '').trim() || '';

      const solRpcRaw = String(this.solana?.rpcUrls || '').trim();
      const solRpcUrls = solRpcRaw
        ? solRpcRaw
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      const solCommitment = String(this.solana?.commitment || '').trim() || 'confirmed';
      const programId = this._programId().toBase58();
      const appHash = deriveIntercomswapAppHash({ solanaProgramId: programId, appTag: INTERCOMSWAP_APP_TAG });

      const classifyLn = (net) => {
        const s = String(net || '').trim().toLowerCase();
        if (!s) return { kind: 'unknown', is_test: null };
        if (['regtest', 'testnet', 'signet'].includes(s)) return { kind: 'test', is_test: true };
        if (['bitcoin', 'mainnet'].includes(s)) return { kind: 'mainnet', is_test: false };
        return { kind: 'unknown', is_test: null };
      };
      const classifySol = (urls) => {
        const hay = (Array.isArray(urls) ? urls : [])
          .map((u) => String(u || '').toLowerCase())
          .join(' ');
        if (!hay) return { kind: 'unknown', is_test: null };
        if (hay.includes('127.0.0.1:8899') || hay.includes('localhost:8899')) {
          return { kind: 'local', is_test: true };
        }
        if (hay.includes('devnet')) return { kind: 'devnet', is_test: true };
        if (hay.includes('testnet')) return { kind: 'testnet', is_test: true };
        if (hay.includes('mainnet')) return { kind: 'mainnet', is_test: false };
        return { kind: 'unknown', is_test: null };
      };

      const lnClass = classifyLn(lnNetwork);
      const solClass = classifySol(solRpcUrls);

      let envKind = 'unknown';
      if (lnClass.is_test === true && solClass.is_test === true) envKind = 'test';
      else if (lnClass.is_test === false && solClass.is_test === false) envKind = 'mainnet';
      else if (lnClass.is_test !== null || solClass.is_test !== null) envKind = 'mixed';

      const receiptsDb = String(this.receipts?.dbPath || '').trim() || '';
      const peerKeypair = String(this.peer?.keypairPath || '').trim() || '';
      const peerKeypairExists = peerKeypair ? fs.existsSync(peerKeypair) : false;

      return {
        type: 'env',
        env_kind: envKind,
        peer: { keypair: peerKeypair || null, exists: peerKeypair ? peerKeypairExists : null },
        ln: { impl: lnImpl, backend: lnBackend, network: lnNetwork || null, classify: lnClass },
        solana: {
          rpc_urls: solRpcUrls,
          commitment: solCommitment,
          program_id: programId,
          classify: solClass,
        },
        app: { app_tag: INTERCOMSWAP_APP_TAG, app_hash: appHash },
        sc_bridge: { url: String(this.scBridge?.url || '').trim() || null, token_configured: Boolean(this.scBridge?.token) },
        receipts: { db: receiptsDb || null },
      };
    }

    // Read-only SC-Bridge
    if (toolName === 'intercomswap_sc_info') {
      assertAllowedKeys(args, toolName, []);
      return withScBridge(this.scBridge, (sc) => sc.info());
    }
    if (toolName === 'intercomswap_sc_stats') {
      assertAllowedKeys(args, toolName, []);
      return withScBridge(this.scBridge, (sc) => sc.stats());
    }
    if (toolName === 'intercomswap_sc_price_get') {
      assertAllowedKeys(args, toolName, []);
      return withScBridge(this.scBridge, (sc) => sc.priceGet());
    }

    // SC-Bridge event stream helpers (persistent connection).
    if (toolName === 'intercomswap_sc_subscribe') {
      assertAllowedKeys(args, toolName, ['channels']);
      const channels = args.channels;
      if (!Array.isArray(channels) || channels.length < 1) {
        throw new Error(`${toolName}: channels must be a non-empty array`);
      }
      const list = channels.map((c) => normalizeChannelName(String(c)));
      for (const ch of list) this._scSubscribed.add(ch);
      if (dryRun) return { type: 'dry_run', tool: toolName, channels: list };
      const sc = await this._scEnsurePersistent();
      await sc.subscribe(list);
      return { type: 'subscribed', channels: Array.from(this._scSubscribed) };
    }

    if (toolName === 'intercomswap_sc_wait_envelope') {
      assertAllowedKeys(args, toolName, ['channels', 'kinds', 'timeout_ms']);
      const channels = Array.isArray(args.channels) ? args.channels.map((c) => normalizeChannelName(String(c))) : [];
      const kinds = Array.isArray(args.kinds) ? args.kinds.map((k) => String(k || '').trim()).filter(Boolean) : [];
      const timeoutMs = Number.isInteger(args.timeout_ms) ? args.timeout_ms : 10_000;
      if (timeoutMs < 10 || timeoutMs > 120_000) throw new Error(`${toolName}: timeout_ms out of range`);

      if (!secrets || typeof secrets.put !== 'function') {
        throw new Error(`${toolName}: secrets store required`);
      }

      await this._scEnsurePersistent();
      const channelAllow = new Set(channels);
      const kindAllow = new Set(kinds);

      const evt = await this._scWaitFor(
        (e) => {
          if (!e || typeof e !== 'object') return false;
          if (channels.length > 0 && !channelAllow.has(e.channel)) return false;
          const msg = e.message;
          if (!isObject(msg)) return false;
          const v = validateSwapEnvelope(msg);
          if (!v.ok) return false;
          if (kinds.length > 0 && !kindAllow.has(String(msg.kind))) return false;
          return true;
        },
        { timeoutMs }
      );

      if (!evt) return { type: 'timeout', timeout_ms: timeoutMs };

      const env = evt.message;
      const envId = hashUnsignedEnvelope(stripSignature(env));
      const sigOk = verifySignedEnvelope(env);
      const handle = secrets.put(env, { key: 'swap_envelope', channel: evt.channel, id: envId, kind: env.kind });

      const out = {
        type: 'swap_envelope',
        channel: evt.channel,
        kind: env.kind,
        trade_id: env.trade_id,
        envelope_id: envId,
        signer: env.signer || null,
        ts: env.ts || null,
        signature_ok: Boolean(sigOk.ok),
        envelope_handle: handle,
        from: evt.from,
        origin: evt.origin,
        relayedBy: evt.relayedBy,
        ttl: evt.ttl,
      };

      // Add minimal kind-specific summary fields (safe, small).
      if (isObject(env.body)) {
        if (env.kind === KIND.RFQ || env.kind === KIND.QUOTE || env.kind === KIND.TERMS) {
          if (env.body.btc_sats !== undefined) out.btc_sats = env.body.btc_sats;
          if (env.body.usdt_amount !== undefined) out.usdt_amount = env.body.usdt_amount;
        }
        if (env.body.rfq_id !== undefined) out.rfq_id = env.body.rfq_id;
        if (env.body.quote_id !== undefined) out.quote_id = env.body.quote_id;
        if (env.kind === KIND.SWAP_INVITE && env.body.swap_channel) out.swap_channel = env.body.swap_channel;

        // Payment/escrow summary fields (safe for operators/UI; avoids forcing models to parse envelopes).
        if (env.kind === KIND.LN_INVOICE) {
          if (env.body.payment_hash_hex !== undefined) out.payment_hash_hex = env.body.payment_hash_hex;
          if (env.body.amount_msat !== undefined) out.amount_msat = env.body.amount_msat;
          if (env.body.expires_at_unix !== undefined) out.expires_at_unix = env.body.expires_at_unix;
        }
        if (env.kind === KIND.SOL_ESCROW_CREATED) {
          if (env.body.payment_hash_hex !== undefined) out.payment_hash_hex = env.body.payment_hash_hex;
          if (env.body.program_id !== undefined) out.program_id = env.body.program_id;
          if (env.body.escrow_pda !== undefined) out.escrow_pda = env.body.escrow_pda;
          if (env.body.vault_ata !== undefined) out.vault_ata = env.body.vault_ata;
          if (env.body.mint !== undefined) out.mint = env.body.mint;
          if (env.body.amount !== undefined) out.amount = env.body.amount;
          if (env.body.recipient !== undefined) out.recipient = env.body.recipient;
          if (env.body.refund !== undefined) out.refund = env.body.refund;
          if (env.body.refund_after_unix !== undefined) out.refund_after_unix = env.body.refund_after_unix;
          if (env.body.tx_sig !== undefined) out.tx_sig = env.body.tx_sig;
        }
      }

      return out;
    }

    // SC-Bridge mutations
    if (toolName === 'intercomswap_sc_join') {
      assertAllowedKeys(args, toolName, ['channel', 'invite_b64', 'welcome_b64']);
      requireApproval(toolName, autoApprove);
      const channel = normalizeChannelName(expectString(args, toolName, 'channel', { max: 128 }));
      const inviteRaw = expectOptionalString(args, toolName, 'invite_b64', { max: 16384 });
      const welcomeRaw = expectOptionalString(args, toolName, 'welcome_b64', { max: 16384 });
      const invite = inviteRaw !== null ? resolveSecretArg(secrets, inviteRaw, { label: 'invite_b64' }) : null;
      const welcome = welcomeRaw !== null ? resolveSecretArg(secrets, welcomeRaw, { label: 'welcome_b64' }) : null;
      if (dryRun) return { type: 'dry_run', tool: toolName, channel };
      return withScBridge(this.scBridge, (sc) => sc.join(channel, { invite, welcome }));
    }
    if (toolName === 'intercomswap_sc_join_many') {
      assertAllowedKeys(args, toolName, ['channels']);
      requireApproval(toolName, autoApprove);
      if (!Array.isArray(args.channels) || args.channels.length < 1) {
        throw new Error(`${toolName}: channels must be a non-empty array`);
      }
      const channels = args.channels.map((c) => normalizeChannelName(expectString({ channel: c }, toolName, 'channel', { max: 128 })));
      if (dryRun) return { type: 'dry_run', tool: toolName, channels };
      return withScBridge(this.scBridge, async (sc) => {
        const out = [];
        for (const channel of channels) out.push(await sc.join(channel, {}));
        return { type: 'sc_join_many', channels, results: out };
      });
    }
    if (toolName === 'intercomswap_sc_leave') {
      assertAllowedKeys(args, toolName, ['channel']);
      requireApproval(toolName, autoApprove);
      const channel = normalizeChannelName(expectString(args, toolName, 'channel', { max: 128 }));
      if (dryRun) return { type: 'dry_run', tool: toolName, channel };
      return withScBridge(this.scBridge, (sc) => sc.leave(channel));
    }
    if (toolName === 'intercomswap_sc_leave_many') {
      assertAllowedKeys(args, toolName, ['channels']);
      requireApproval(toolName, autoApprove);
      if (!Array.isArray(args.channels) || args.channels.length < 1) {
        throw new Error(`${toolName}: channels must be a non-empty array`);
      }
      const channels = args.channels.map((c) => normalizeChannelName(expectString({ channel: c }, toolName, 'channel', { max: 128 })));
      if (dryRun) return { type: 'dry_run', tool: toolName, channels };
      return withScBridge(this.scBridge, async (sc) => {
        const out = [];
        for (const channel of channels) out.push(await sc.leave(channel));
        return { type: 'sc_leave_many', channels, results: out };
      });
    }
    if (toolName === 'intercomswap_sc_open') {
      assertAllowedKeys(args, toolName, ['channel', 'via', 'invite_b64', 'welcome_b64']);
      requireApproval(toolName, autoApprove);
      const channel = normalizeChannelName(expectString(args, toolName, 'channel', { max: 128 }));
      const via = normalizeChannelName(expectString(args, toolName, 'via', { max: 128 }));
      const inviteRaw = expectOptionalString(args, toolName, 'invite_b64', { max: 16384 });
      const welcomeRaw = expectOptionalString(args, toolName, 'welcome_b64', { max: 16384 });
      const invite = inviteRaw !== null ? resolveSecretArg(secrets, inviteRaw, { label: 'invite_b64' }) : null;
      const welcome = welcomeRaw !== null ? resolveSecretArg(secrets, welcomeRaw, { label: 'welcome_b64' }) : null;
      if (dryRun) return { type: 'dry_run', tool: toolName, channel, via };
      return withScBridge(this.scBridge, (sc) => sc.open(channel, { via, invite, welcome }));
    }
    if (toolName === 'intercomswap_sc_send_text') {
      assertAllowedKeys(args, toolName, ['channel', 'text']);
      requireApproval(toolName, autoApprove);
      const channel = normalizeChannelName(expectString(args, toolName, 'channel', { max: 128 }));
      const text = expectString(args, toolName, 'text', { min: 1, max: 2000 });
      if (dryRun) return { type: 'dry_run', tool: toolName, channel };
      return withScBridge(this.scBridge, (sc) => sc.send(channel, text));
    }
    if (toolName === 'intercomswap_sc_send_json') {
      assertAllowedKeys(args, toolName, ['channel', 'json']);
      requireApproval(toolName, autoApprove);
      const channel = normalizeChannelName(expectString(args, toolName, 'channel', { max: 128 }));
      if (!('json' in args)) throw new Error(`${toolName}: json is required`);
      if (!isObject(args.json) && !Array.isArray(args.json)) throw new Error(`${toolName}: json must be an object/array`);
      const size = Buffer.byteLength(safeJsonStringify(args.json), 'utf8');
      if (size > 16_384) throw new Error(`${toolName}: json too large (${size} bytes)`);
      if (dryRun) return { type: 'dry_run', tool: toolName, channel };
      return withScBridge(this.scBridge, (sc) => sc.send(channel, args.json));
    }

    // RFQ / swap envelopes (signed + broadcast)
    if (toolName === 'intercomswap_rfq_post') {
      assertAllowedKeys(args, toolName, [
        'channel',
        'trade_id',
        'btc_sats',
        'usdt_amount',
        'max_platform_fee_bps',
        'max_trade_fee_bps',
        'max_total_fee_bps',
        'min_sol_refund_window_sec',
        'max_sol_refund_window_sec',
        'valid_until_unix',
      ]);
      requireApproval(toolName, autoApprove);
      const channel = normalizeChannelName(expectString(args, toolName, 'channel', { max: 128 }));
      const tradeId = expectString(args, toolName, 'trade_id', { min: 1, max: 128, pattern: /^[A-Za-z0-9_.:-]+$/ });
      const btcSats = expectInt(args, toolName, 'btc_sats', { min: 1 });
      const usdtAmount = normalizeAtomicAmount(expectString(args, toolName, 'usdt_amount', { max: 64 }), 'usdt_amount');
      const maxPlatformFeeBps = expectOptionalInt(args, toolName, 'max_platform_fee_bps', { min: 0, max: 500 }) ?? 500;
      const maxTradeFeeBps = expectOptionalInt(args, toolName, 'max_trade_fee_bps', { min: 0, max: 1000 }) ?? 1000;
      const maxTotalFeeBps = expectOptionalInt(args, toolName, 'max_total_fee_bps', { min: 0, max: 1500 }) ?? 1500;
      const minSolRefundWindowSec =
        expectOptionalInt(args, toolName, 'min_sol_refund_window_sec', { min: SOL_REFUND_MIN_SEC, max: SOL_REFUND_MAX_SEC }) ??
        SOL_REFUND_DEFAULT_SEC;
      const maxSolRefundWindowSec =
        expectOptionalInt(args, toolName, 'max_sol_refund_window_sec', { min: SOL_REFUND_MIN_SEC, max: SOL_REFUND_MAX_SEC }) ??
        SOL_REFUND_MAX_SEC;
      if (minSolRefundWindowSec > maxSolRefundWindowSec) {
        throw new Error(`${toolName}: min_sol_refund_window_sec must be <= max_sol_refund_window_sec`);
      }
      const validUntil = expectOptionalInt(args, toolName, 'valid_until_unix', { min: 1 });
      const appHash = deriveIntercomswapAppHash({ solanaProgramId: this._programId().toBase58() });

      const unsigned = createUnsignedEnvelope({
        v: 1,
        kind: KIND.RFQ,
        tradeId,
        body: {
          pair: PAIR.BTC_LN__USDT_SOL,
          direction: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
          app_hash: appHash,
          btc_sats: btcSats,
          usdt_amount: usdtAmount,
          max_platform_fee_bps: maxPlatformFeeBps,
          max_trade_fee_bps: maxTradeFeeBps,
          max_total_fee_bps: maxTotalFeeBps,
          min_sol_refund_window_sec: minSolRefundWindowSec,
          max_sol_refund_window_sec: maxSolRefundWindowSec,
          ...(validUntil ? { valid_until_unix: validUntil } : {}),
        },
      });
      const rfqId = hashUnsignedEnvelope(unsigned);

      if (dryRun) return { type: 'dry_run', tool: toolName, channel, rfq_id: rfqId, unsigned };

      const signing = await this._requirePeerSigning();
      return withScBridge(this.scBridge, async (sc) => {
        const signed = signSwapEnvelope(unsigned, signing);
        await this._sendEnvelopeLogged(sc, channel, signed);
        return { type: 'rfq_posted', channel, rfq_id: rfqId, envelope: signed };
      });
    }

    if (toolName === 'intercomswap_quote_post') {
      assertAllowedKeys(args, toolName, [
        'channel',
        'trade_id',
        'rfq_id',
        'btc_sats',
        'usdt_amount',
        'platform_fee_bps',
        'trade_fee_bps',
        'trade_fee_collector',
        'platform_fee_collector',
        'sol_refund_window_sec',
        'valid_until_unix',
        'valid_for_sec',
      ]);
      requireApproval(toolName, autoApprove);
      const channel = normalizeChannelName(expectString(args, toolName, 'channel', { max: 128 }));
      const tradeId = expectString(args, toolName, 'trade_id', { min: 1, max: 128, pattern: /^[A-Za-z0-9_.:-]+$/ });
      const rfqId = normalizeHex32(expectString(args, toolName, 'rfq_id', { min: 64, max: 64 }), 'rfq_id');
      const btcSats = expectInt(args, toolName, 'btc_sats', { min: 1 });
      const usdtAmount = normalizeAtomicAmount(expectString(args, toolName, 'usdt_amount', { max: 64 }), 'usdt_amount');
      const platformFeeBps = expectInt(args, toolName, 'platform_fee_bps', { min: 0, max: 500 });
      const tradeFeeBps = expectInt(args, toolName, 'trade_fee_bps', { min: 0, max: 1000 });
      if (platformFeeBps + tradeFeeBps > 1500) throw new Error(`${toolName}: total fee bps exceeds 1500 cap`);
      const tradeFeeCollector = normalizeBase58(expectString(args, toolName, 'trade_fee_collector', { max: 64 }), 'trade_fee_collector');
      const platformFeeCollector = args.platform_fee_collector
        ? normalizeBase58(String(args.platform_fee_collector), 'platform_fee_collector')
        : null;
      const solRefundWindowSec =
        expectOptionalInt(args, toolName, 'sol_refund_window_sec', { min: SOL_REFUND_MIN_SEC, max: SOL_REFUND_MAX_SEC }) ??
        SOL_REFUND_DEFAULT_SEC;
      const validUntilRaw = expectOptionalInt(args, toolName, 'valid_until_unix', { min: 1 });
      const validFor = expectOptionalInt(args, toolName, 'valid_for_sec', { min: 10, max: 60 * 60 * 24 * 7 });
      const nowSec = Math.floor(Date.now() / 1000);
      const validUntil = validUntilRaw ?? (validFor ? nowSec + validFor : null);
      if (!validUntil) {
        throw new Error(`${toolName}: valid_until_unix or valid_for_sec is required`);
      }
      const appHash = deriveIntercomswapAppHash({ solanaProgramId: this._programId().toBase58() });

      const unsigned = createUnsignedEnvelope({
        v: 1,
        kind: KIND.QUOTE,
        tradeId,
        body: {
          rfq_id: rfqId,
          pair: PAIR.BTC_LN__USDT_SOL,
          direction: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
          app_hash: appHash,
          btc_sats: btcSats,
          usdt_amount: usdtAmount,
          platform_fee_bps: platformFeeBps,
          trade_fee_bps: tradeFeeBps,
          trade_fee_collector: tradeFeeCollector,
          sol_refund_window_sec: solRefundWindowSec,
          ...(platformFeeCollector ? { platform_fee_collector: platformFeeCollector } : {}),
          valid_until_unix: validUntil,
        },
      });
      const quoteId = hashUnsignedEnvelope(unsigned);
      if (dryRun) return { type: 'dry_run', tool: toolName, channel, quote_id: quoteId, unsigned };
      const signing = await this._requirePeerSigning();
      return withScBridge(this.scBridge, async (sc) => {
        const signed = signSwapEnvelope(unsigned, signing);
        await this._sendEnvelopeLogged(sc, channel, signed);
        return { type: 'quote_posted', channel, quote_id: quoteId, envelope: signed };
      });
    }

    if (toolName === 'intercomswap_quote_post_from_rfq') {
      assertAllowedKeys(args, toolName, [
        'channel',
        'rfq_envelope',
        'platform_fee_bps',
        'trade_fee_bps',
        'trade_fee_collector',
        'platform_fee_collector',
        'sol_refund_window_sec',
        'valid_until_unix',
        'valid_for_sec',
      ]);
      requireApproval(toolName, autoApprove);
      const channel = normalizeChannelName(expectString(args, toolName, 'channel', { max: 128 }));
      const rfq = resolveSecretArg(secrets, args.rfq_envelope, { label: 'rfq_envelope', expectType: 'object' });
      if (!isObject(rfq)) throw new Error(`${toolName}: rfq_envelope must be an object`);
      const v = validateSwapEnvelope(rfq);
      if (!v.ok) throw new Error(`${toolName}: invalid rfq_envelope: ${v.error}`);
      if (rfq.kind !== KIND.RFQ) throw new Error(`${toolName}: rfq_envelope.kind must be ${KIND.RFQ}`);
      const sigOk = verifySignedEnvelope(rfq);
      if (!sigOk.ok) throw new Error(`${toolName}: rfq_envelope signature invalid: ${sigOk.error}`);

      const tradeId = String(rfq.trade_id);
      const btcSats = Number(rfq?.body?.btc_sats);
      if (!Number.isInteger(btcSats) || btcSats < 1) throw new Error(`${toolName}: rfq_envelope.body.btc_sats invalid`);
      const usdtAmount = normalizeAtomicAmount(String(rfq?.body?.usdt_amount), 'rfq_envelope.body.usdt_amount');

      const rfqId = hashUnsignedEnvelope(stripSignature(rfq));

      const platformFeeBps = expectInt(args, toolName, 'platform_fee_bps', { min: 0, max: 500 });
      const tradeFeeBps = expectInt(args, toolName, 'trade_fee_bps', { min: 0, max: 1000 });
      if (platformFeeBps + tradeFeeBps > 1500) throw new Error(`${toolName}: total fee bps exceeds 1500 cap`);
      const tradeFeeCollector = normalizeBase58(expectString(args, toolName, 'trade_fee_collector', { max: 64 }), 'trade_fee_collector');
      const platformFeeCollector = args.platform_fee_collector
        ? normalizeBase58(String(args.platform_fee_collector), 'platform_fee_collector')
        : null;
      const solRefundWindowSec =
        expectOptionalInt(args, toolName, 'sol_refund_window_sec', { min: SOL_REFUND_MIN_SEC, max: SOL_REFUND_MAX_SEC }) ??
        SOL_REFUND_DEFAULT_SEC;

      const rfqMinWindowRaw = rfq?.body?.min_sol_refund_window_sec;
      const rfqMaxWindowRaw = rfq?.body?.max_sol_refund_window_sec;
      const rfqMinWindow =
        rfqMinWindowRaw !== undefined && rfqMinWindowRaw !== null ? Number.parseInt(String(rfqMinWindowRaw), 10) : null;
      const rfqMaxWindow =
        rfqMaxWindowRaw !== undefined && rfqMaxWindowRaw !== null ? Number.parseInt(String(rfqMaxWindowRaw), 10) : null;
      if (rfqMinWindow !== null && Number.isFinite(rfqMinWindow) && solRefundWindowSec < rfqMinWindow) {
        throw new Error(`${toolName}: sol_refund_window_sec below RFQ minimum`);
      }
      if (rfqMaxWindow !== null && Number.isFinite(rfqMaxWindow) && solRefundWindowSec > rfqMaxWindow) {
        throw new Error(`${toolName}: sol_refund_window_sec above RFQ maximum`);
      }

      const validUntilRaw = expectOptionalInt(args, toolName, 'valid_until_unix', { min: 1 });
      const validFor = expectOptionalInt(args, toolName, 'valid_for_sec', { min: 10, max: 60 * 60 * 24 * 7 });
      const nowSec = Math.floor(Date.now() / 1000);
      const validUntil = validUntilRaw ?? (validFor ? nowSec + validFor : null);
      if (!validUntil) {
        throw new Error(`${toolName}: valid_until_unix or valid_for_sec is required`);
      }

      const appHash = deriveIntercomswapAppHash({ solanaProgramId: this._programId().toBase58() });
      const rfqAppHash = String(rfq?.body?.app_hash || '').trim().toLowerCase();
      if (rfqAppHash !== appHash) {
        throw new Error(`${toolName}: rfq_envelope.app_hash mismatch (wrong app/program for this channel)`);
      }

      const unsigned = createUnsignedEnvelope({
        v: 1,
        kind: KIND.QUOTE,
        tradeId,
        body: {
          rfq_id: rfqId,
          pair: PAIR.BTC_LN__USDT_SOL,
          direction: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
          app_hash: appHash,
          btc_sats: btcSats,
          usdt_amount: usdtAmount,
          platform_fee_bps: platformFeeBps,
          trade_fee_bps: tradeFeeBps,
          trade_fee_collector: tradeFeeCollector,
          sol_refund_window_sec: solRefundWindowSec,
          ...(platformFeeCollector ? { platform_fee_collector: platformFeeCollector } : {}),
          valid_until_unix: validUntil,
        },
      });
      const quoteId = hashUnsignedEnvelope(unsigned);
      if (dryRun) return { type: 'dry_run', tool: toolName, channel, quote_id: quoteId, unsigned };
      const signing = await this._requirePeerSigning();
      return withScBridge(this.scBridge, async (sc) => {
        const signed = signSwapEnvelope(unsigned, signing);
        await this._sendEnvelopeLogged(sc, channel, signed);
        return { type: 'quote_posted', channel, quote_id: quoteId, envelope: signed, rfq_id: rfqId };
      });
    }

    if (toolName === 'intercomswap_quote_accept') {
      assertAllowedKeys(args, toolName, ['channel', 'quote_envelope']);
      requireApproval(toolName, autoApprove);
      const channel = normalizeChannelName(expectString(args, toolName, 'channel', { max: 128 }));
      const quote = resolveSecretArg(secrets, args.quote_envelope, { label: 'quote_envelope', expectType: 'object' });
      if (!isObject(quote)) throw new Error(`${toolName}: quote_envelope must be an object`);
      const v = validateSwapEnvelope(quote);
      if (!v.ok) throw new Error(`${toolName}: invalid quote_envelope: ${v.error}`);
      if (quote.kind !== KIND.QUOTE) throw new Error(`${toolName}: quote_envelope.kind must be ${KIND.QUOTE}`);
      const sigOk = verifySignedEnvelope(quote);
      if (!sigOk.ok) throw new Error(`${toolName}: quote_envelope signature invalid: ${sigOk.error}`);

      const appHash = deriveIntercomswapAppHash({ solanaProgramId: this._programId().toBase58(), appTag: INTERCOMSWAP_APP_TAG });
      const quoteAppHash = String(quote?.body?.app_hash || '').trim().toLowerCase();
      if (quoteAppHash !== appHash) {
        throw new Error(`${toolName}: quote_envelope.app_hash mismatch (wrong app/program for this channel)`);
      }

      const quoteId = hashUnsignedEnvelope(stripSignature(quote));
      const rfqId = String(quote.body.rfq_id);
      const tradeId = String(quote.trade_id);

      const unsigned = createUnsignedEnvelope({
        v: 1,
        kind: KIND.QUOTE_ACCEPT,
        tradeId,
        body: { rfq_id: rfqId, quote_id: quoteId },
      });
      if (dryRun) return { type: 'dry_run', tool: toolName, channel, unsigned };

      const signing = await this._requirePeerSigning();
      return withScBridge(this.scBridge, async (sc) => {
        const signed = signSwapEnvelope(unsigned, signing);
        await this._sendEnvelopeLogged(sc, channel, signed);
        return { type: 'quote_accept_posted', channel, envelope: signed, rfq_id: rfqId, quote_id: quoteId };
      });
    }

    if (toolName === 'intercomswap_swap_invite_from_accept') {
      assertAllowedKeys(args, toolName, ['channel', 'accept_envelope', 'swap_channel', 'welcome_text', 'ttl_sec']);
      requireApproval(toolName, autoApprove);
      const channel = normalizeChannelName(expectString(args, toolName, 'channel', { max: 128 }));
      const accept = resolveSecretArg(secrets, args.accept_envelope, { label: 'accept_envelope', expectType: 'object' });
      if (!isObject(accept)) throw new Error(`${toolName}: accept_envelope must be an object`);
      const v = validateSwapEnvelope(accept);
      if (!v.ok) throw new Error(`${toolName}: invalid accept_envelope: ${v.error}`);
      if (accept.kind !== KIND.QUOTE_ACCEPT) throw new Error(`${toolName}: accept_envelope.kind must be ${KIND.QUOTE_ACCEPT}`);
      const sigOk = verifySignedEnvelope(accept);
      if (!sigOk.ok) throw new Error(`${toolName}: accept_envelope signature invalid: ${sigOk.error}`);

      const tradeId = String(accept.trade_id);
      const swapChannel = args.swap_channel ? normalizeChannelName(String(args.swap_channel)) : `swap:${tradeId}`;
      const welcomeText = expectString(args, toolName, 'welcome_text', { min: 1, max: 500 });
      const ttlSec = expectOptionalInt(args, toolName, 'ttl_sec', { min: 30, max: 60 * 60 * 24 * 7 });
      const inviteePubKey = String(accept.signer || '').trim().toLowerCase();
      if (!inviteePubKey) throw new Error(`${toolName}: accept envelope missing signer pubkey`);

      const rfqId = String(accept.body.rfq_id);
      const quoteId = String(accept.body.quote_id);

      if (dryRun) {
        return { type: 'dry_run', tool: toolName, channel, swap_channel: swapChannel, rfq_id: rfqId, quote_id: quoteId };
      }

      const signing = await this._requirePeerSigning();
      const ownerPubKey = signing.pubHex;
      const issuedAt = Date.now();
      const welcome = createSignedWelcome(
        { channel: swapChannel, ownerPubKey, text: welcomeText, issuedAt, version: 1 },
        (payload) => signPayloadHex(payload, signing.secHex)
      );
      const invite = createSignedInvite(
        {
          channel: swapChannel,
          inviteePubKey,
          inviterPubKey: ownerPubKey,
          inviterAddress: null,
          issuedAt,
          ttlMs: (ttlSec !== null ? ttlSec : 7 * 24 * 3600) * 1000,
          version: 1,
        },
        (payload) => signPayloadHex(payload, signing.secHex),
        { welcome }
      );
      const unsigned = createUnsignedEnvelope({
        v: 1,
        kind: KIND.SWAP_INVITE,
        tradeId,
        body: {
          rfq_id: rfqId,
          quote_id: quoteId,
          swap_channel: swapChannel,
          owner_pubkey: ownerPubKey,
          invite,
          welcome,
        },
      });
      const signed = signSwapEnvelope(unsigned, signing);

      return withScBridge(this.scBridge, async (sc) => {
        await this._sendEnvelopeLogged(sc, channel, signed);

        // Ensure the maker peer has joined and verified the dynamic welcome, otherwise it will drop
        // inbound messages on swap:* until welcomed.
        const joinRes = await sc.join(swapChannel, { welcome });
        if (joinRes?.type === 'error') throw new Error(joinRes.error || 'join failed');

        return {
          type: 'swap_invite_posted',
          channel,
          swap_channel: swapChannel,
          owner_pubkey: ownerPubKey,
          envelope: signed,
          invite,
          welcome,
          maker_join: joinRes,
        };
      });
    }

    if (toolName === 'intercomswap_join_from_swap_invite') {
      assertAllowedKeys(args, toolName, ['swap_invite_envelope']);
      requireApproval(toolName, autoApprove);
      const inv = resolveSecretArg(secrets, args.swap_invite_envelope, { label: 'swap_invite_envelope', expectType: 'object' });
      if (!isObject(inv)) throw new Error(`${toolName}: swap_invite_envelope must be an object`);
      const v = validateSwapEnvelope(inv);
      if (!v.ok) throw new Error(`${toolName}: invalid swap_invite_envelope: ${v.error}`);
      if (inv.kind !== KIND.SWAP_INVITE) throw new Error(`${toolName}: swap_invite_envelope.kind must be ${KIND.SWAP_INVITE}`);
      const sigOk = verifySignedEnvelope(inv);
      if (!sigOk.ok) throw new Error(`${toolName}: swap_invite_envelope signature invalid: ${sigOk.error}`);

      const swapChannel = String(inv.body.swap_channel || '').trim();
      if (!swapChannel) throw new Error(`${toolName}: swap_invite missing swap_channel`);

      const invite =
        inv.body.invite || (inv.body.invite_b64 ? decodeB64JsonMaybe(inv.body.invite_b64) : null);
      const welcome =
        inv.body.welcome || (inv.body.welcome_b64 ? decodeB64JsonMaybe(inv.body.welcome_b64) : null);
      if (!invite) throw new Error(`${toolName}: swap_invite missing invite`);

      if (dryRun) return { type: 'dry_run', tool: toolName, swap_channel: swapChannel };
      return withScBridge(this.scBridge, (sc) => sc.join(swapChannel, { invite, welcome }));
    }

    // Peer manager (local pear run processes; does not grant shell access)
    if (toolName === 'intercomswap_peer_status') {
      assertAllowedKeys(args, toolName, ['name']);
      const name = expectOptionalString(args, toolName, 'name', { min: 1, max: 64, pattern: /^[A-Za-z0-9._-]+$/ });
      const { peerStatus } = await import('../peer/peerManager.js');
      return peerStatus({ repoRoot: process.cwd(), name: name || '' });
    }

    if (toolName === 'intercomswap_peer_start') {
      assertAllowedKeys(args, toolName, [
        'name',
        'store',
        'sc_port',
        'sidechannels',
        'inviter_keys',
        'dht_bootstrap',
        'msb_dht_bootstrap',
        'subnet_channel',
        'msb_enabled',
        'price_oracle_enabled',
        'pow_enabled',
        'pow_difficulty',
        'welcome_required',
        'invite_required',
        'invite_prefixes',
        'log_path',
        'ready_timeout_ms',
      ]);
      requireApproval(toolName, autoApprove);
      const name = expectString(args, toolName, 'name', { min: 1, max: 64, pattern: /^[A-Za-z0-9._-]+$/ });
      const store = expectString(args, toolName, 'store', { min: 1, max: 64, pattern: /^[A-Za-z0-9._-]+$/ });
      const scPort = expectInt(args, toolName, 'sc_port', { min: 1, max: 65535 });

      const sidechannels = Array.isArray(args.sidechannels) ? args.sidechannels.map(normalizeChannelName) : [];
      if (sidechannels.length > 50) throw new Error(`${toolName}: sidechannels too long`);

      const inviterKeys = Array.isArray(args.inviter_keys) ? args.inviter_keys.map((v) => normalizeHex32(v, 'inviter_keys')) : [];
      if (inviterKeys.length > 25) throw new Error(`${toolName}: inviter_keys too long`);

      const parseBoot = (value, label) => {
        if (!Array.isArray(value)) return [];
        const out = [];
        for (const entry of value) {
          const s = String(entry || '').trim();
          if (!s) continue;
          if (s.length > 200) throw new Error(`${toolName}: ${label} entry too long`);
          if (/\s|\r|\n/.test(s)) throw new Error(`${toolName}: ${label} must not contain whitespace/newlines`);
          out.push(s);
        }
        return out;
      };
      const dhtBootstrap = parseBoot(args.dht_bootstrap, 'dht_bootstrap');
      const msbDhtBootstrap = parseBoot(args.msb_dht_bootstrap, 'msb_dht_bootstrap');

      const subnetChannel = expectOptionalString(args, toolName, 'subnet_channel', { min: 1, max: 200, pattern: /^[^\s]+$/ }) || '';

      const msbEnabled = 'msb_enabled' in args ? expectBool(args, toolName, 'msb_enabled') : false;
      const priceOracleEnabled = 'price_oracle_enabled' in args ? expectBool(args, toolName, 'price_oracle_enabled') : false;
      const powEnabled = 'pow_enabled' in args ? expectBool(args, toolName, 'pow_enabled') : true;
      const powDifficulty = expectOptionalInt(args, toolName, 'pow_difficulty', { min: 0, max: 32 });
      const welcomeRequired = 'welcome_required' in args ? expectBool(args, toolName, 'welcome_required') : false;
      const inviteRequired = 'invite_required' in args ? expectBool(args, toolName, 'invite_required') : true;

      const invitePrefixes = Array.isArray(args.invite_prefixes)
        ? args.invite_prefixes.map((v) => String(v || '').trim()).filter(Boolean)
        : ['swap:'];
      if (invitePrefixes.length > 25) throw new Error(`${toolName}: invite_prefixes too long`);
      for (const p of invitePrefixes) {
        if (p.length > 64) throw new Error(`${toolName}: invite_prefixes entry too long`);
        if (/\s|\r|\n/.test(p)) throw new Error(`${toolName}: invite_prefixes must not contain whitespace/newlines`);
      }

      const logPathArg = expectOptionalString(args, toolName, 'log_path', { min: 1, max: 400 });
      const logPath = logPathArg ? resolveOnchainPath(logPathArg, { label: 'log_path' }) : '';

      const readyTimeoutMs = expectOptionalInt(args, toolName, 'ready_timeout_ms', { min: 0, max: 120_000 }) ?? 15_000;

      if (dryRun) {
        return {
          type: 'dry_run',
          tool: toolName,
          name,
          store,
          sc_port: scPort,
          sidechannels,
          inviter_keys: inviterKeys,
          dht_bootstrap: dhtBootstrap,
          msb_dht_bootstrap: msbDhtBootstrap,
          subnet_channel: subnetChannel || null,
          msb_enabled: msbEnabled,
          price_oracle_enabled: priceOracleEnabled,
          pow_enabled: powEnabled,
          pow_difficulty: powDifficulty ?? null,
          welcome_required: welcomeRequired,
          invite_required: inviteRequired,
          invite_prefixes: invitePrefixes,
          log_path: logPath || null,
          ready_timeout_ms: readyTimeoutMs,
        };
      }

      const { peerStart } = await import('../peer/peerManager.js');
      const out = await peerStart({
        repoRoot: process.cwd(),
        name,
        store,
        scPort,
        sidechannels,
        sidechannelInviterKeys: inviterKeys,
        dhtBootstrap,
        msbDhtBootstrap,
        subnetChannel,
        msbEnabled,
        priceOracleEnabled,
        sidechannelPowEnabled: powEnabled,
        sidechannelPowDifficulty: powDifficulty ?? 12,
        sidechannelWelcomeRequired: welcomeRequired,
        sidechannelInviteRequired: inviteRequired,
        sidechannelInvitePrefixes: invitePrefixes,
        logPath,
        readyTimeoutMs,
      });

      // UX: if promptd wasn't configured with a peer signing keypair path, infer it from the store.
      // This lets operators post signed RFQs immediately after starting a peer via Collin.
      try {
        const inferred = path.join(process.cwd(), 'stores', store, 'db', 'keypair.json');
        if (!this.peer) this.peer = { keypairPath: inferred };
        if (!String(this.peer.keypairPath || '').trim()) this.peer.keypairPath = inferred;
        this._peerSigning = null;
        if (out && typeof out === 'object') {
          out.peer_keypair = { inferred: true, path: inferred };
        }
      } catch (_e) {}

      return out;
    }

    if (toolName === 'intercomswap_peer_stop') {
      assertAllowedKeys(args, toolName, ['name', 'signal', 'wait_ms']);
      requireApproval(toolName, autoApprove);
      const name = expectString(args, toolName, 'name', { min: 1, max: 64, pattern: /^[A-Za-z0-9._-]+$/ });
      const signal = expectOptionalString(args, toolName, 'signal', { min: 3, max: 10 }) || 'SIGTERM';
      if (!['SIGTERM', 'SIGINT', 'SIGKILL'].includes(signal)) throw new Error(`${toolName}: invalid signal`);
      const waitMs = expectOptionalInt(args, toolName, 'wait_ms', { min: 0, max: 120_000 }) ?? 2000;
      if (dryRun) return { type: 'dry_run', tool: toolName, name, signal, wait_ms: waitMs };
      const { peerStop } = await import('../peer/peerManager.js');
      return peerStop({ repoRoot: process.cwd(), name, signal, waitMs });
    }

    if (toolName === 'intercomswap_peer_restart') {
      assertAllowedKeys(args, toolName, ['name', 'wait_ms', 'ready_timeout_ms']);
      requireApproval(toolName, autoApprove);
      const name = expectString(args, toolName, 'name', { min: 1, max: 64, pattern: /^[A-Za-z0-9._-]+$/ });
      const waitMs = expectOptionalInt(args, toolName, 'wait_ms', { min: 0, max: 120_000 }) ?? 2000;
      const readyTimeoutMs = expectOptionalInt(args, toolName, 'ready_timeout_ms', { min: 0, max: 120_000 }) ?? 15_000;
      if (dryRun) return { type: 'dry_run', tool: toolName, name, wait_ms: waitMs, ready_timeout_ms: readyTimeoutMs };
      const { peerRestart } = await import('../peer/peerManager.js');
      return peerRestart({ repoRoot: process.cwd(), name, waitMs, readyTimeoutMs });
    }

    // RFQ bot manager (local processes; does not stop the peer)
    if (toolName === 'intercomswap_rfqbot_status') {
      assertAllowedKeys(args, toolName, ['name']);
      const name = expectOptionalString(args, toolName, 'name', { min: 1, max: 64, pattern: /^[A-Za-z0-9._-]+$/ });
      const { rfqbotStatus } = await import('../rfq/botManager.js');
      return rfqbotStatus({ repoRoot: process.cwd(), name: name || '' });
    }

    if (toolName === 'intercomswap_rfqbot_start_maker' || toolName === 'intercomswap_rfqbot_start_taker') {
      assertAllowedKeys(args, toolName, ['name', 'store', 'sc_port', 'receipts_db', 'argv']);
      requireApproval(toolName, autoApprove);
      const name = expectString(args, toolName, 'name', { min: 1, max: 64, pattern: /^[A-Za-z0-9._-]+$/ });
      const store = expectString(args, toolName, 'store', { min: 1, max: 64, pattern: /^[A-Za-z0-9._-]+$/ });
      const scPort = expectInt(args, toolName, 'sc_port', { min: 1, max: 65535 });
      const receiptsDbArg = expectOptionalString(args, toolName, 'receipts_db', { min: 1, max: 400 });
      const receiptsDb = receiptsDbArg ? resolveOnchainPath(receiptsDbArg, { label: 'receipts_db' }) : '';
      const argv = Array.isArray(args.argv) ? args.argv.map((v) => String(v || '').trim()).filter(Boolean) : [];
      if (argv.length > 80) throw new Error(`${toolName}: argv too long (max 80)`);
      for (const a of argv) {
        if (a.length > 200) throw new Error(`${toolName}: argv entry too long`);
        if (/\r|\n/.test(a)) throw new Error(`${toolName}: argv must not contain newlines`);
      }
      const role = toolName === 'intercomswap_rfqbot_start_maker' ? 'maker' : 'taker';
      if (dryRun) return { type: 'dry_run', tool: toolName, name, role, store, sc_port: scPort, receipts_db: receiptsDb || null, argv };
      const { rfqbotStart } = await import('../rfq/botManager.js');
      return rfqbotStart({ repoRoot: process.cwd(), name, role, store, scPort, receiptsDb, argv });
    }

    if (toolName === 'intercomswap_rfqbot_stop') {
      assertAllowedKeys(args, toolName, ['name', 'signal', 'wait_ms']);
      requireApproval(toolName, autoApprove);
      const name = expectString(args, toolName, 'name', { min: 1, max: 64, pattern: /^[A-Za-z0-9._-]+$/ });
      const signal = expectOptionalString(args, toolName, 'signal', { min: 3, max: 10 }) || 'SIGTERM';
      if (!['SIGTERM', 'SIGINT', 'SIGKILL'].includes(signal)) throw new Error(`${toolName}: invalid signal`);
      const waitMs = expectOptionalInt(args, toolName, 'wait_ms', { min: 0, max: 120_000 }) ?? 2000;
      if (dryRun) return { type: 'dry_run', tool: toolName, name, signal, wait_ms: waitMs };
      const { rfqbotStop } = await import('../rfq/botManager.js');
      return rfqbotStop({ repoRoot: process.cwd(), name, signal, waitMs });
    }

    if (toolName === 'intercomswap_rfqbot_restart') {
      assertAllowedKeys(args, toolName, ['name', 'wait_ms']);
      requireApproval(toolName, autoApprove);
      const name = expectString(args, toolName, 'name', { min: 1, max: 64, pattern: /^[A-Za-z0-9._-]+$/ });
      const waitMs = expectOptionalInt(args, toolName, 'wait_ms', { min: 0, max: 120_000 }) ?? 2000;
      if (dryRun) return { type: 'dry_run', tool: toolName, name, wait_ms: waitMs };
      const { rfqbotRestart } = await import('../rfq/botManager.js');
      return rfqbotRestart({ repoRoot: process.cwd(), name, waitMs });
    }

    if (toolName === 'intercomswap_terms_post') {
      assertAllowedKeys(args, toolName, [
        'channel',
        'trade_id',
        'btc_sats',
        'usdt_amount',
        'sol_mint',
        'sol_recipient',
        'sol_refund',
        'sol_refund_after_unix',
        'ln_receiver_peer',
        'ln_payer_peer',
        'platform_fee_bps',
        'trade_fee_bps',
        'trade_fee_collector',
        'platform_fee_collector',
        'terms_valid_until_unix',
      ]);
      requireApproval(toolName, autoApprove);
      const channel = normalizeChannelName(expectString(args, toolName, 'channel', { max: 128 }));
      const tradeId = expectString(args, toolName, 'trade_id', { min: 1, max: 128, pattern: /^[A-Za-z0-9_.:-]+$/ });
      const btcSats = expectInt(args, toolName, 'btc_sats', { min: 1 });
      const usdtAmount = normalizeAtomicAmount(expectString(args, toolName, 'usdt_amount', { max: 64 }), 'usdt_amount');
      const solMint = normalizeBase58(expectString(args, toolName, 'sol_mint', { max: 64 }), 'sol_mint');
      const solRecipient = normalizeBase58(expectString(args, toolName, 'sol_recipient', { max: 64 }), 'sol_recipient');
      const solRefund = normalizeBase58(expectString(args, toolName, 'sol_refund', { max: 64 }), 'sol_refund');
      const solRefundAfter = expectInt(args, toolName, 'sol_refund_after_unix', { min: 1 });
      assertRefundAfterUnixWindow(solRefundAfter, toolName);
      const lnReceiverPeer = normalizeHex32(expectString(args, toolName, 'ln_receiver_peer', { min: 64, max: 64 }), 'ln_receiver_peer');
      const lnPayerPeer = normalizeHex32(expectString(args, toolName, 'ln_payer_peer', { min: 64, max: 64 }), 'ln_payer_peer');
      const platformFeeBps = expectInt(args, toolName, 'platform_fee_bps', { min: 0, max: 500 });
      const tradeFeeBps = expectInt(args, toolName, 'trade_fee_bps', { min: 0, max: 1000 });
      const tradeFeeCollector = normalizeBase58(expectString(args, toolName, 'trade_fee_collector', { max: 64 }), 'trade_fee_collector');
      const platformFeeCollector = args.platform_fee_collector
        ? normalizeBase58(String(args.platform_fee_collector), 'platform_fee_collector')
        : null;
      const termsValidUntil = expectOptionalInt(args, toolName, 'terms_valid_until_unix', { min: 1 });

      const appHash = deriveIntercomswapAppHash({ solanaProgramId: this._programId().toBase58(), appTag: INTERCOMSWAP_APP_TAG });
      const unsigned = createUnsignedEnvelope({
        v: 1,
        kind: KIND.TERMS,
        tradeId,
        body: {
          pair: PAIR.BTC_LN__USDT_SOL,
          direction: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
          app_hash: appHash,
          btc_sats: btcSats,
          usdt_amount: usdtAmount,
          usdt_decimals: 6,
          sol_mint: solMint,
          sol_recipient: solRecipient,
          sol_refund: solRefund,
          sol_refund_after_unix: solRefundAfter,
          ln_receiver_peer: lnReceiverPeer,
          ln_payer_peer: lnPayerPeer,
          platform_fee_bps: platformFeeBps,
          trade_fee_bps: tradeFeeBps,
          trade_fee_collector: tradeFeeCollector,
          ...(platformFeeCollector ? { platform_fee_collector: platformFeeCollector } : {}),
          ...(termsValidUntil ? { terms_valid_until_unix: termsValidUntil } : {}),
        },
      });

      if (dryRun) return { type: 'dry_run', tool: toolName, channel, unsigned };

      const signing = await this._requirePeerSigning();
      const store = await this._openReceiptsStore({ required: true });
      try {
        return await withScBridge(this.scBridge, async (sc) => {
          const signed = signSwapEnvelope(unsigned, signing);
          await this._sendEnvelopeLogged(sc, channel, signed);

          const programId = this._programId().toBase58();
          store.upsertTrade(tradeId, {
            role: 'maker',
            swap_channel: channel,
            maker_peer: String(signed.signer || '').trim().toLowerCase() || lnReceiverPeer,
            taker_peer: lnPayerPeer,
            btc_sats: btcSats,
            usdt_amount: usdtAmount,
            sol_mint: solMint,
            sol_program_id: programId,
            sol_recipient: solRecipient,
            sol_refund: solRefund,
            sol_refund_after_unix: solRefundAfter,
            state: 'terms',
            last_error: null,
          });
          store.appendEvent(tradeId, 'terms_post', {
            terms_hash: hashTermsEnvelope(signed),
            channel,
            program_id: programId,
          });

          return { type: 'terms_posted', channel, terms_hash: hashTermsEnvelope(signed), envelope: signed };
        });
      } finally {
        store.close();
      }
    }

    if (toolName === 'intercomswap_terms_accept') {
      assertAllowedKeys(args, toolName, ['channel', 'trade_id', 'terms_hash_hex']);
      requireApproval(toolName, autoApprove);
      const channel = normalizeChannelName(expectString(args, toolName, 'channel', { max: 128 }));
      const tradeId = expectString(args, toolName, 'trade_id', { min: 1, max: 128, pattern: /^[A-Za-z0-9_.:-]+$/ });
      const termsHash = normalizeHex32(expectString(args, toolName, 'terms_hash_hex', { min: 64, max: 64 }), 'terms_hash');

      const unsigned = createUnsignedEnvelope({
        v: 1,
        kind: KIND.ACCEPT,
        tradeId,
        body: { terms_hash: termsHash },
      });
      if (dryRun) return { type: 'dry_run', tool: toolName, channel, unsigned };
      const signing = await this._requirePeerSigning();
      const store = await this._openReceiptsStore({ required: true });
      try {
        return await withScBridge(this.scBridge, async (sc) => {
          const signed = signSwapEnvelope(unsigned, signing);
          await this._sendEnvelopeLogged(sc, channel, signed);
          store.upsertTrade(tradeId, {
            role: 'taker',
            swap_channel: channel,
            state: 'accepted',
            last_error: null,
          });
          store.appendEvent(tradeId, 'terms_accept', { channel, terms_hash: termsHash });
          return { type: 'terms_accept_posted', channel, envelope: signed };
        });
      } finally {
        store.close();
      }
    }

    if (toolName === 'intercomswap_terms_accept_from_terms') {
      assertAllowedKeys(args, toolName, ['channel', 'terms_envelope']);
      requireApproval(toolName, autoApprove);
      const channel = normalizeChannelName(expectString(args, toolName, 'channel', { max: 128 }));
      const terms = resolveSecretArg(secrets, args.terms_envelope, { label: 'terms_envelope', expectType: 'object' });
      if (!isObject(terms)) throw new Error(`${toolName}: terms_envelope must be an object`);
      const v = validateSwapEnvelope(terms);
      if (!v.ok) throw new Error(`${toolName}: invalid terms_envelope: ${v.error}`);
      if (terms.kind !== KIND.TERMS) throw new Error(`${toolName}: terms_envelope.kind must be ${KIND.TERMS}`);
      const sigOk = verifySignedEnvelope(terms);
      if (!sigOk.ok) throw new Error(`${toolName}: terms_envelope signature invalid: ${sigOk.error}`);

      const appHash = deriveIntercomswapAppHash({ solanaProgramId: this._programId().toBase58(), appTag: INTERCOMSWAP_APP_TAG });
      const termsAppHash = String(terms?.body?.app_hash || '').trim().toLowerCase();
      if (termsAppHash !== appHash) {
        throw new Error(`${toolName}: terms_envelope.app_hash mismatch (wrong app/program for this channel)`);
      }

      const tradeId = String(terms.trade_id || '').trim();
      if (!tradeId) throw new Error(`${toolName}: terms_envelope missing trade_id`);
      const termsHash = hashTermsEnvelope(terms);

      const unsigned = createUnsignedEnvelope({
        v: 1,
        kind: KIND.ACCEPT,
        tradeId,
        body: { terms_hash: termsHash },
      });
      if (dryRun) return { type: 'dry_run', tool: toolName, channel, trade_id: tradeId, terms_hash_hex: termsHash };
      const signing = await this._requirePeerSigning();
      const store = await this._openReceiptsStore({ required: true });
      try {
        return await withScBridge(this.scBridge, async (sc) => {
          const signed = signSwapEnvelope(unsigned, signing);
          await this._sendEnvelopeLogged(sc, channel, signed);
          const body = isObject(terms.body) ? terms.body : {};
          const btcSats = Number.isFinite(Number(body.btc_sats)) ? Math.trunc(Number(body.btc_sats)) : null;
          const usdtAmount = typeof body.usdt_amount === 'string' ? body.usdt_amount : null;
          const programId = this._programId().toBase58();
          store.upsertTrade(tradeId, {
            role: 'taker',
            swap_channel: channel,
            maker_peer: String(terms.signer || '').trim().toLowerCase() || null,
            taker_peer: String(signed.signer || '').trim().toLowerCase() || null,
            btc_sats: btcSats ?? undefined,
            usdt_amount: usdtAmount ?? undefined,
            sol_mint: typeof body.sol_mint === 'string' ? body.sol_mint : undefined,
            sol_program_id: programId,
            sol_recipient: typeof body.sol_recipient === 'string' ? body.sol_recipient : undefined,
            sol_refund: typeof body.sol_refund === 'string' ? body.sol_refund : undefined,
            sol_refund_after_unix: Number.isFinite(Number(body.sol_refund_after_unix))
              ? Math.trunc(Number(body.sol_refund_after_unix))
              : undefined,
            state: 'accepted',
            last_error: null,
          });
          store.appendEvent(tradeId, 'terms_accept', { channel, terms_hash: termsHash, program_id: programId });
          return { type: 'terms_accept_posted', channel, trade_id: tradeId, terms_hash_hex: termsHash, envelope: signed };
        });
      } finally {
        store.close();
      }
    }

    // LN docker stack management (local dev/test convenience).
    // NOTE: this is intentionally limited to `docker compose -f <composeFile> {ps,up,down}`.
    if (toolName === 'intercomswap_ln_docker_ps') {
      assertAllowedKeys(args, toolName, ['compose_file']);
      if (String(this.ln?.backend || '').trim() !== 'docker') {
        throw new Error(`${toolName}: ln.backend must be "docker"`);
      }
      const composeFileRaw = args.compose_file ? String(args.compose_file).trim() : String(this.ln?.composeFile || '').trim();
      if (!composeFileRaw) throw new Error(`${toolName}: missing compose file (ln.compose_file)`);
      const composeFile = resolveWithinRepoRoot(composeFileRaw, { label: 'compose_file', mustExist: true });
      const { stdout } = await dockerCompose({ composeFile, args: ['ps', '--format', 'json'], cwd: process.cwd() });
      const text = String(stdout || '').trim();

      // docker compose outputs one JSON object per line (NDJSON), not a single JSON array.
      // Keep the returned payload small and operator-friendly.
      const services = [];
      if (text) {
        for (const line of text.split('\n')) {
          const s = line.trim();
          if (!s) continue;
          try {
            const row = JSON.parse(s);
            if (!row || typeof row !== 'object') continue;
            services.push({
              service: row.Service ?? null,
              name: row.Name ?? row.Names ?? null,
              state: row.State ?? null,
              status: row.Status ?? null,
              exit_code: Number.isFinite(Number(row.ExitCode)) ? Number(row.ExitCode) : null,
              ports: row.Ports ?? null,
            });
          } catch (_e) {
            // Ignore invalid lines.
          }
        }
      }

      return { type: 'ln_docker_ps', compose_file: composeFile, services };
    }

    if (toolName === 'intercomswap_ln_docker_up') {
      assertAllowedKeys(args, toolName, ['services', 'compose_file']);
      requireApproval(toolName, autoApprove);
      if (String(this.ln?.backend || '').trim() !== 'docker') {
        throw new Error(`${toolName}: ln.backend must be "docker"`);
      }
      const composeFileRaw = args.compose_file ? String(args.compose_file).trim() : String(this.ln?.composeFile || '').trim();
      if (!composeFileRaw) throw new Error(`${toolName}: missing compose file (ln.compose_file)`);
      const composeFile = resolveWithinRepoRoot(composeFileRaw, { label: 'compose_file', mustExist: true });

      const want = Array.isArray(args.services) ? args.services : [];
      const services = [];
      if (want.length > 0) {
        const seen = new Set();
        for (const s of want) {
          const svc = normalizeDockerServiceName(s, 'services');
          if (seen.has(svc)) continue;
          seen.add(svc);
          services.push(svc);
        }
      } else {
        const cfgSvc = String(this.ln?.service || '').trim();
        if (cfgSvc) {
          services.push('bitcoind', normalizeDockerServiceName(cfgSvc, 'ln.service'));
        }
      }

      const fullArgs = ['up', '-d', '--remove-orphans'];
      if (services.length > 0) fullArgs.push(...services);
      if (dryRun) return { type: 'dry_run', tool: toolName, compose_file: composeFile, services: services.length > 0 ? services : null };
      const out = await dockerCompose({ composeFile, args: fullArgs, cwd: process.cwd() });
      return {
        type: 'ln_docker_up',
        compose_file: composeFile,
        services: services.length > 0 ? services : null,
        stdout: String(out.stdout || '').trim() || null,
        stderr: String(out.stderr || '').trim() || null,
      };
    }

    if (toolName === 'intercomswap_ln_docker_down') {
      assertAllowedKeys(args, toolName, ['compose_file', 'volumes']);
      requireApproval(toolName, autoApprove);
      if (String(this.ln?.backend || '').trim() !== 'docker') {
        throw new Error(`${toolName}: ln.backend must be "docker"`);
      }
      const composeFileRaw = args.compose_file ? String(args.compose_file).trim() : String(this.ln?.composeFile || '').trim();
      if (!composeFileRaw) throw new Error(`${toolName}: missing compose file (ln.compose_file)`);
      const composeFile = resolveWithinRepoRoot(composeFileRaw, { label: 'compose_file', mustExist: true });
      const volumes = 'volumes' in args ? expectBool(args, toolName, 'volumes') : false;
      const fullArgs = ['down'];
      if (volumes) fullArgs.push('--volumes');
      if (dryRun) return { type: 'dry_run', tool: toolName, compose_file: composeFile, volumes };
      const out = await dockerCompose({ composeFile, args: fullArgs, cwd: process.cwd() });
      return {
        type: 'ln_docker_down',
        compose_file: composeFile,
        volumes,
        stdout: String(out.stdout || '').trim() || null,
        stderr: String(out.stderr || '').trim() || null,
      };
    }

    // Lightning tools
    if (toolName === 'intercomswap_ln_info') {
      assertAllowedKeys(args, toolName, []);
      return lnGetInfo(this.ln);
    }
    if (toolName === 'intercomswap_ln_newaddr') {
      assertAllowedKeys(args, toolName, []);
      requireApproval(toolName, autoApprove);
      if (dryRun) return { type: 'dry_run', tool: toolName };
      return lnNewAddress(this.ln);
    }
    if (toolName === 'intercomswap_ln_listfunds') {
      assertAllowedKeys(args, toolName, []);
      return lnListFunds(this.ln);
    }
    if (toolName === 'intercomswap_ln_withdraw') {
      assertAllowedKeys(args, toolName, ['address', 'amount_sats', 'sat_per_vbyte']);
      requireApproval(toolName, autoApprove);
      const address = expectString(args, toolName, 'address', { min: 10, max: 200 });
      const amountSats = expectInt(args, toolName, 'amount_sats', { min: 1 });
      const satPerVbyte = expectOptionalInt(args, toolName, 'sat_per_vbyte', { min: 1, max: 10_000 });
      if (dryRun) return { type: 'dry_run', tool: toolName, address, amount_sats: amountSats, sat_per_vbyte: satPerVbyte };
      return lnWithdraw(this.ln, { address, amountSats, satPerVbyte });
    }
    if (toolName === 'intercomswap_ln_connect') {
      assertAllowedKeys(args, toolName, ['peer']);
      requireApproval(toolName, autoApprove);
      const peer = expectString(args, toolName, 'peer', { min: 10, max: 200 });
      if (dryRun) return { type: 'dry_run', tool: toolName, peer };
      return lnConnect(this.ln, { peer });
    }
    if (toolName === 'intercomswap_ln_fundchannel') {
      assertAllowedKeys(args, toolName, ['node_id', 'amount_sats', 'private']);
      requireApproval(toolName, autoApprove);
      const nodeId = normalizeHex33(expectString(args, toolName, 'node_id', { min: 66, max: 66 }), 'node_id');
      const amountSats = expectInt(args, toolName, 'amount_sats', { min: 1000 });
      const privateFlag = 'private' in args ? expectBool(args, toolName, 'private') : false;
      if (dryRun) return { type: 'dry_run', tool: toolName, node_id: nodeId, amount_sats: amountSats, private: privateFlag };
      // Note: privacy support is implementation-specific; we enforce the arg shape, but do not currently plumb it.
      return lnFundChannel(this.ln, { nodeId, amountSats, block: true });
    }
    if (toolName === 'intercomswap_ln_invoice_create') {
      assertAllowedKeys(args, toolName, ['amount_msat', 'label', 'description', 'expiry_sec']);
      requireApproval(toolName, autoApprove);
      const amountMsat = expectInt(args, toolName, 'amount_msat', { min: 1 });
      const label = expectString(args, toolName, 'label', { min: 1, max: 120 });
      const description = expectString(args, toolName, 'description', { min: 1, max: 500 });
      const expirySec = expectOptionalInt(args, toolName, 'expiry_sec', { min: 60, max: 60 * 60 * 24 * 7 });
      if (dryRun) return { type: 'dry_run', tool: toolName };
      return lnInvoice(this.ln, { amountMsat, label, description, expirySec });
    }
    if (toolName === 'intercomswap_ln_decodepay') {
      assertAllowedKeys(args, toolName, ['bolt11']);
      const bolt11 = expectString(args, toolName, 'bolt11', { min: 20, max: 8000 });
      return lnDecodePay(this.ln, { bolt11 });
    }
    if (toolName === 'intercomswap_ln_pay') {
      assertAllowedKeys(args, toolName, ['bolt11']);
      requireApproval(toolName, autoApprove);
      const bolt11 = expectString(args, toolName, 'bolt11', { min: 20, max: 8000 });
      if (dryRun) return { type: 'dry_run', tool: toolName };
      return lnPay(this.ln, { bolt11 });
    }
    if (toolName === 'intercomswap_ln_pay_status') {
      assertAllowedKeys(args, toolName, ['payment_hash_hex']);
      const paymentHashHex = normalizeHex32(expectString(args, toolName, 'payment_hash_hex', { min: 64, max: 64 }), 'payment_hash_hex');
      return lnPayStatus(this.ln, { paymentHashHex });
    }
    if (toolName === 'intercomswap_ln_preimage_get') {
      assertAllowedKeys(args, toolName, ['payment_hash_hex']);
      requireApproval(toolName, autoApprove);
      const paymentHashHex = normalizeHex32(expectString(args, toolName, 'payment_hash_hex', { min: 64, max: 64 }), 'payment_hash_hex');
      if (dryRun) return { type: 'dry_run', tool: toolName };
      return lnPreimageGet(this.ln, { paymentHashHex });
    }

    // Swap settlement helpers (deterministic; sign + send swap envelopes)
    if (toolName === 'intercomswap_swap_ln_invoice_create_and_post') {
      assertAllowedKeys(args, toolName, ['channel', 'trade_id', 'btc_sats', 'label', 'description', 'expiry_sec']);
      requireApproval(toolName, autoApprove);
      const channel = normalizeChannelName(expectString(args, toolName, 'channel', { max: 128 }));
      const tradeId = expectString(args, toolName, 'trade_id', { min: 1, max: 128, pattern: /^[A-Za-z0-9_.:-]+$/ });
      const btcSats = expectInt(args, toolName, 'btc_sats', { min: 1 });
      const label = expectString(args, toolName, 'label', { min: 1, max: 120 });
      const description = expectString(args, toolName, 'description', { min: 1, max: 500 });
      const expirySec = expectOptionalInt(args, toolName, 'expiry_sec', { min: 60, max: 60 * 60 * 24 * 7 });
      if (dryRun) return { type: 'dry_run', tool: toolName, channel, trade_id: tradeId };

      const store = await this._openReceiptsStore({ required: true });
      try {
      const amountMsat = (BigInt(String(btcSats)) * 1000n).toString();
      const invoice = await lnInvoice(this.ln, { amountMsat, label, description, expirySec });
      const bolt11 = String(invoice?.bolt11 || '').trim();
      const paymentHashHex = String(invoice?.payment_hash || '').trim().toLowerCase();
      if (!bolt11) throw new Error(`${toolName}: invoice missing bolt11`);
      if (!/^[0-9a-f]{64}$/.test(paymentHashHex)) throw new Error(`${toolName}: invoice missing payment_hash`);

      // Best-effort decode for expiry.
      let expiresAtUnix = null;
      try {
        const dec = await lnDecodePay(this.ln, { bolt11 });
        const created = Number(dec?.created_at ?? dec?.timestamp ?? dec?.creation_date ?? null);
        const exp = Number(dec?.expiry ?? dec?.expiry_seconds ?? null);
        if (Number.isFinite(created) && created > 0 && Number.isFinite(exp) && exp > 0) {
          expiresAtUnix = Math.trunc(created + exp);
        }
      } catch (_e) {}

      const unsigned = createUnsignedEnvelope({
        v: 1,
        kind: KIND.LN_INVOICE,
        tradeId,
        body: {
          bolt11,
          payment_hash_hex: paymentHashHex,
          amount_msat: String(amountMsat),
          ...(expiresAtUnix ? { expires_at_unix: expiresAtUnix } : {}),
        },
      });

      store.upsertTrade(tradeId, {
        role: 'maker',
        swap_channel: channel,
        btc_sats: btcSats,
        ln_invoice_bolt11: bolt11,
        ln_payment_hash_hex: paymentHashHex,
        state: 'invoice',
        last_error: null,
      });
      store.appendEvent(tradeId, 'ln_invoice', {
        channel,
        payment_hash_hex: paymentHashHex,
        amount_msat: String(amountMsat),
        expires_at_unix: expiresAtUnix,
      });

      const signing = await this._requirePeerSigning();
      return await withScBridge(this.scBridge, async (sc) => {
        const signed = signSwapEnvelope(unsigned, signing);
        await this._sendEnvelopeLogged(sc, channel, signed);
        store.appendEvent(tradeId, 'ln_invoice_posted', { channel, payment_hash_hex: paymentHashHex });
        const envHandle = secrets && typeof secrets.put === 'function'
          ? secrets.put(signed, { key: 'ln_invoice', channel, trade_id: tradeId, payment_hash_hex: paymentHashHex })
          : null;
        return {
          type: 'ln_invoice_posted',
          channel,
          trade_id: tradeId,
          payment_hash_hex: paymentHashHex,
          bolt11,
          expires_at_unix: expiresAtUnix,
          envelope_handle: envHandle,
          envelope: envHandle ? null : signed,
        };
      });
      } finally {
        store.close();
      }
    }

    if (toolName === 'intercomswap_swap_sol_escrow_init_and_post') {
      assertAllowedKeys(args, toolName, [
        'channel',
        'trade_id',
        'payment_hash_hex',
        'mint',
        'amount',
        'recipient',
        'refund',
        'refund_after_unix',
        'platform_fee_bps',
        'trade_fee_bps',
        'trade_fee_collector',
      ]);
      requireApproval(toolName, autoApprove);
      const channel = normalizeChannelName(expectString(args, toolName, 'channel', { max: 128 }));
      const tradeId = expectString(args, toolName, 'trade_id', { min: 1, max: 128, pattern: /^[A-Za-z0-9_.:-]+$/ });
      const paymentHashHex = normalizeHex32(expectString(args, toolName, 'payment_hash_hex', { min: 64, max: 64 }), 'payment_hash_hex');
      const mint = new PublicKey(normalizeBase58(expectString(args, toolName, 'mint', { max: 64 }), 'mint'));
      const amountStr = normalizeAtomicAmount(expectString(args, toolName, 'amount', { max: 64 }), 'amount');
      const amount = BigInt(amountStr);
      const recipient = new PublicKey(normalizeBase58(expectString(args, toolName, 'recipient', { max: 64 }), 'recipient'));
      const refund = new PublicKey(normalizeBase58(expectString(args, toolName, 'refund', { max: 64 }), 'refund'));
      const refundAfterUnix = expectInt(args, toolName, 'refund_after_unix', { min: 1 });
      assertRefundAfterUnixWindow(refundAfterUnix, toolName);
      const platformFeeBps = expectInt(args, toolName, 'platform_fee_bps', { min: 0, max: 500 });
      const tradeFeeBps = expectInt(args, toolName, 'trade_fee_bps', { min: 0, max: 1000 });
      const tradeFeeCollector = new PublicKey(normalizeBase58(expectString(args, toolName, 'trade_fee_collector', { max: 64 }), 'trade_fee_collector'));
      if (dryRun) return { type: 'dry_run', tool: toolName, channel, trade_id: tradeId, payment_hash_hex: paymentHashHex };

      const store = await this._openReceiptsStore({ required: true });
      try {
      const signer = this._requireSolanaSigner();
      const programId = this._programId();
      const commitment = this._commitment();
      const { computeUnitLimit, computeUnitPriceMicroLamports } = this._computeBudget();

      const build = await this._pool().call(async (connection) => {
        const payerAta = await getOrCreateAta(connection, signer, signer.publicKey, mint, commitment);
        return createEscrowTx({
          connection,
          payer: signer,
          payerTokenAccount: payerAta,
          mint,
          paymentHashHex,
          recipient,
          refund,
          refundAfterUnix,
          amount,
          expectedPlatformFeeBps: platformFeeBps,
          expectedTradeFeeBps: tradeFeeBps,
          tradeFeeCollector,
          computeUnitLimit,
          computeUnitPriceMicroLamports,
          programId,
        });
      }, { label: 'swap_sol_escrow_build' });

      const escrowSig = await this._pool().call((connection) => sendAndConfirm(connection, build.tx, commitment), { label: 'swap_sol_escrow_send' });

      store.upsertTrade(tradeId, {
        role: 'maker',
        swap_channel: channel,
        ln_payment_hash_hex: paymentHashHex,
        sol_mint: mint.toBase58(),
        sol_program_id: programId.toBase58(),
        sol_recipient: recipient.toBase58(),
        sol_refund: refund.toBase58(),
        sol_escrow_pda: build.escrowPda.toBase58(),
        sol_vault_ata: build.vault.toBase58(),
        sol_refund_after_unix: refundAfterUnix,
        state: 'escrow',
        last_error: null,
      });
      store.appendEvent(tradeId, 'sol_escrow_created', {
        channel,
        payment_hash_hex: paymentHashHex,
        escrow_pda: build.escrowPda.toBase58(),
        vault_ata: build.vault.toBase58(),
        tx_sig: escrowSig,
      });

      const unsigned = createUnsignedEnvelope({
        v: 1,
        kind: KIND.SOL_ESCROW_CREATED,
        tradeId,
        body: {
          payment_hash_hex: paymentHashHex,
          program_id: programId.toBase58(),
          escrow_pda: build.escrowPda.toBase58(),
          vault_ata: build.vault.toBase58(),
          mint: mint.toBase58(),
          amount: amountStr,
          refund_after_unix: refundAfterUnix,
          recipient: recipient.toBase58(),
          refund: refund.toBase58(),
          tx_sig: escrowSig,
        },
      });

      const signing = await this._requirePeerSigning();
      return await withScBridge(this.scBridge, async (sc) => {
        const signed = signSwapEnvelope(unsigned, signing);
        await this._sendEnvelopeLogged(sc, channel, signed);
        store.appendEvent(tradeId, 'sol_escrow_posted', { channel, payment_hash_hex: paymentHashHex });
        const envHandle = secrets && typeof secrets.put === 'function'
          ? secrets.put(signed, { key: 'sol_escrow_created', channel, trade_id: tradeId, payment_hash_hex: paymentHashHex })
          : null;
        return {
          type: 'sol_escrow_posted',
          channel,
          trade_id: tradeId,
          payment_hash_hex: paymentHashHex,
          program_id: programId.toBase58(),
          escrow_pda: build.escrowPda.toBase58(),
          vault_ata: build.vault.toBase58(),
          tx_sig: escrowSig,
          envelope_handle: envHandle,
          envelope: envHandle ? null : signed,
        };
      });
      } finally {
        store.close();
      }
    }

    if (toolName === 'intercomswap_swap_verify_pre_pay') {
      assertAllowedKeys(args, toolName, ['terms_envelope', 'invoice_envelope', 'escrow_envelope', 'now_unix']);
      const nowUnix =
        'now_unix' in args && args.now_unix !== null && args.now_unix !== undefined
          ? expectInt(args, toolName, 'now_unix', { min: 1 })
          : Math.floor(Date.now() / 1000);

      const terms = resolveSecretArg(secrets, args.terms_envelope, { label: 'terms_envelope', expectType: 'object' });
      const invoice = resolveSecretArg(secrets, args.invoice_envelope, { label: 'invoice_envelope', expectType: 'object' });
      const escrow = resolveSecretArg(secrets, args.escrow_envelope, { label: 'escrow_envelope', expectType: 'object' });

      for (const [label, env, kind] of [
        ['terms_envelope', terms, KIND.TERMS],
        ['invoice_envelope', invoice, KIND.LN_INVOICE],
        ['escrow_envelope', escrow, KIND.SOL_ESCROW_CREATED],
      ]) {
        if (!isObject(env)) throw new Error(`${toolName}: ${label} must be an object`);
        const v = validateSwapEnvelope(env);
        if (!v.ok) throw new Error(`${toolName}: invalid ${label}: ${v.error}`);
        if (env.kind !== kind) throw new Error(`${toolName}: ${label}.kind must be ${kind}`);
        const sigOk = verifySignedEnvelope(env);
        if (!sigOk.ok) throw new Error(`${toolName}: ${label} signature invalid: ${sigOk.error}`);
      }

      const tradeId = String(terms.trade_id || '').trim();
      if (!tradeId) throw new Error(`${toolName}: terms_envelope missing trade_id`);
      if (String(invoice.trade_id || '').trim() !== tradeId) throw new Error(`${toolName}: invoice trade_id mismatch vs terms`);
      if (String(escrow.trade_id || '').trim() !== tradeId) throw new Error(`${toolName}: escrow trade_id mismatch vs terms`);

      const expectedProgramId = this._programId().toBase58();
      const expectedAppHash = deriveIntercomswapAppHash({ solanaProgramId: expectedProgramId, appTag: INTERCOMSWAP_APP_TAG });
      const termsAppHash = String(terms?.body?.app_hash || '').trim().toLowerCase();
      if (termsAppHash !== expectedAppHash) {
        throw new Error(`${toolName}: terms_envelope.app_hash mismatch (wrong app/program for this channel)`);
      }
      const escrowProgramId = String(escrow?.body?.program_id || '').trim();
      if (escrowProgramId && escrowProgramId !== expectedProgramId) {
        throw new Error(`${toolName}: escrow.program_id mismatch (expected ${expectedProgramId}, got ${escrowProgramId})`);
      }

      const commitment = this._commitment();
      return this._pool().call(async (connection) => {
        const res = await verifySwapPrePayOnchain({
          terms: terms.body,
          invoiceBody: invoice.body,
          escrowBody: escrow.body,
          connection,
          commitment,
          now_unix: nowUnix,
        });

        // Fee guardrails: compare negotiated fee fields to what is actually on-chain.
        let feeMismatchError = null;
        if (res.ok && res.onchain?.state && isObject(terms.body)) {
          const t = terms.body;
          const st = res.onchain.state;
          if (t.platform_fee_bps !== undefined && t.platform_fee_bps !== null && st.platformFeeBps !== undefined) {
            if (Number(st.platformFeeBps) !== Number(t.platform_fee_bps)) {
              feeMismatchError = 'platform_fee_bps mismatch vs onchain';
            }
          }
          if (t.trade_fee_bps !== undefined && t.trade_fee_bps !== null && st.tradeFeeBps !== undefined) {
            if (Number(st.tradeFeeBps) !== Number(t.trade_fee_bps)) {
              feeMismatchError = 'trade_fee_bps mismatch vs onchain';
            }
          }
          if (t.trade_fee_collector && st.tradeFeeCollector?.toBase58) {
            if (String(st.tradeFeeCollector.toBase58()) !== String(t.trade_fee_collector)) {
              feeMismatchError = 'trade_fee_collector mismatch vs onchain';
            }
          }
        }

        return {
          type: 'pre_pay_check',
          ok: Boolean(res.ok) && !feeMismatchError,
          trade_id: tradeId,
          error: res.ok ? feeMismatchError : res.error,
          payment_hash_hex: res.ok && !feeMismatchError ? String(invoice.body?.payment_hash_hex || '').trim().toLowerCase() : null,
          decoded_invoice: res.decoded_invoice ?? null,
          onchain: sanitizeEscrowVerifyOnchain(res.onchain),
        };
      }, { label: 'swap_verify_pre_pay' });
    }

    if (toolName === 'intercomswap_swap_ln_pay_and_post') {
      assertAllowedKeys(args, toolName, ['channel', 'trade_id', 'bolt11', 'payment_hash_hex']);
      requireApproval(toolName, autoApprove);
      const channel = normalizeChannelName(expectString(args, toolName, 'channel', { max: 128 }));
      const tradeId = expectString(args, toolName, 'trade_id', { min: 1, max: 128, pattern: /^[A-Za-z0-9_.:-]+$/ });
      const bolt11 = expectString(args, toolName, 'bolt11', { min: 20, max: 8000 });
      const paymentHashHex = normalizeHex32(expectString(args, toolName, 'payment_hash_hex', { min: 64, max: 64 }), 'payment_hash_hex');
      if (dryRun) return { type: 'dry_run', tool: toolName, channel, trade_id: tradeId, payment_hash_hex: paymentHashHex };

      const store = await this._openReceiptsStore({ required: true });
      try {
        const payRes = await lnPay(this.ln, { bolt11 });
        const preimageHex = String(payRes?.payment_preimage || '').trim().toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(preimageHex)) throw new Error(`${toolName}: missing payment_preimage`);

        store.upsertTrade(tradeId, {
          role: 'taker',
          swap_channel: channel,
          ln_payment_hash_hex: paymentHashHex,
          ln_preimage_hex: preimageHex,
          state: 'ln_paid',
          last_error: null,
        });
        store.appendEvent(tradeId, 'ln_paid', { channel, payment_hash_hex: paymentHashHex });

        const unsigned = createUnsignedEnvelope({
          v: 1,
          kind: KIND.LN_PAID,
          tradeId,
          body: { payment_hash_hex: paymentHashHex },
        });

        const signing = await this._requirePeerSigning();
        return await withScBridge(this.scBridge, async (sc) => {
          const signed = signSwapEnvelope(unsigned, signing);
          await this._sendEnvelopeLogged(sc, channel, signed);
          store.appendEvent(tradeId, 'ln_paid_posted', { channel, payment_hash_hex: paymentHashHex });
          const envHandle = secrets && typeof secrets.put === 'function'
            ? secrets.put(signed, { key: 'ln_paid', channel, trade_id: tradeId, payment_hash_hex: paymentHashHex })
            : null;
          return {
            type: 'ln_paid_posted',
            channel,
            trade_id: tradeId,
            payment_hash_hex: paymentHashHex,
            preimage_hex: preimageHex,
            envelope_handle: envHandle,
            envelope: envHandle ? null : signed,
          };
        });
      } finally {
        store.close();
      }
    }

    if (toolName === 'intercomswap_swap_ln_pay_and_post_from_invoice') {
      assertAllowedKeys(args, toolName, ['channel', 'invoice_envelope']);
      requireApproval(toolName, autoApprove);
      const channel = normalizeChannelName(expectString(args, toolName, 'channel', { max: 128 }));
      const inv = resolveSecretArg(secrets, args.invoice_envelope, { label: 'invoice_envelope', expectType: 'object' });
      if (!isObject(inv)) throw new Error(`${toolName}: invoice_envelope must be an object`);
      const v = validateSwapEnvelope(inv);
      if (!v.ok) throw new Error(`${toolName}: invalid invoice_envelope: ${v.error}`);
      if (inv.kind !== KIND.LN_INVOICE) throw new Error(`${toolName}: invoice_envelope.kind must be ${KIND.LN_INVOICE}`);
      const sigOk = verifySignedEnvelope(inv);
      if (!sigOk.ok) throw new Error(`${toolName}: invoice_envelope signature invalid: ${sigOk.error}`);

      const tradeId = expectString({ trade_id: String(inv.trade_id || '') }, toolName, 'trade_id', {
        min: 1,
        max: 128,
        pattern: /^[A-Za-z0-9_.:-]+$/,
      });
      const bolt11 = expectString({ bolt11: String(inv.body?.bolt11 || '') }, toolName, 'bolt11', { min: 20, max: 8000 });
      const paymentHashHex = normalizeHex32(String(inv.body?.payment_hash_hex || ''), 'payment_hash_hex');

      if (dryRun) return { type: 'dry_run', tool: toolName, channel, trade_id: tradeId, payment_hash_hex: paymentHashHex };

      const store = await this._openReceiptsStore({ required: true });
      try {
        const payRes = await lnPay(this.ln, { bolt11 });
        const preimageHex = String(payRes?.payment_preimage || '').trim().toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(preimageHex)) throw new Error(`${toolName}: missing payment_preimage`);

        store.upsertTrade(tradeId, {
          role: 'taker',
          swap_channel: channel,
          ln_payment_hash_hex: paymentHashHex,
          ln_preimage_hex: preimageHex,
          state: 'ln_paid',
          last_error: null,
        });
        store.appendEvent(tradeId, 'ln_paid', { channel, payment_hash_hex: paymentHashHex });

        const unsigned = createUnsignedEnvelope({
          v: 1,
          kind: KIND.LN_PAID,
          tradeId,
          body: { payment_hash_hex: paymentHashHex },
        });

        const signing = await this._requirePeerSigning();
        return await withScBridge(this.scBridge, async (sc) => {
          const signed = signSwapEnvelope(unsigned, signing);
          await this._sendEnvelopeLogged(sc, channel, signed);
          store.appendEvent(tradeId, 'ln_paid_posted', { channel, payment_hash_hex: paymentHashHex });
          const envHandle = secrets && typeof secrets.put === 'function'
            ? secrets.put(signed, { key: 'ln_paid', channel, trade_id: tradeId, payment_hash_hex: paymentHashHex })
            : null;
          return {
            type: 'ln_paid_posted',
            channel,
            trade_id: tradeId,
            payment_hash_hex: paymentHashHex,
            preimage_hex: preimageHex,
            envelope_handle: envHandle,
            envelope: envHandle ? null : signed,
          };
        });
      } finally {
        store.close();
      }
    }

    if (toolName === 'intercomswap_swap_ln_pay_and_post_verified') {
      assertAllowedKeys(args, toolName, ['channel', 'terms_envelope', 'invoice_envelope', 'escrow_envelope', 'now_unix']);
      requireApproval(toolName, autoApprove);
      const channel = normalizeChannelName(expectString(args, toolName, 'channel', { max: 128 }));
      const nowUnix =
        'now_unix' in args && args.now_unix !== null && args.now_unix !== undefined
          ? expectInt(args, toolName, 'now_unix', { min: 1 })
          : Math.floor(Date.now() / 1000);

      const terms = resolveSecretArg(secrets, args.terms_envelope, { label: 'terms_envelope', expectType: 'object' });
      const invoice = resolveSecretArg(secrets, args.invoice_envelope, { label: 'invoice_envelope', expectType: 'object' });
      const escrow = resolveSecretArg(secrets, args.escrow_envelope, { label: 'escrow_envelope', expectType: 'object' });

      for (const [label, env, kind] of [
        ['terms_envelope', terms, KIND.TERMS],
        ['invoice_envelope', invoice, KIND.LN_INVOICE],
        ['escrow_envelope', escrow, KIND.SOL_ESCROW_CREATED],
      ]) {
        if (!isObject(env)) throw new Error(`${toolName}: ${label} must be an object`);
        const v = validateSwapEnvelope(env);
        if (!v.ok) throw new Error(`${toolName}: invalid ${label}: ${v.error}`);
        if (env.kind !== kind) throw new Error(`${toolName}: ${label}.kind must be ${kind}`);
        const sigOk = verifySignedEnvelope(env);
        if (!sigOk.ok) throw new Error(`${toolName}: ${label} signature invalid: ${sigOk.error}`);
      }

      const tradeId = expectString({ trade_id: String(terms.trade_id || '') }, toolName, 'trade_id', {
        min: 1,
        max: 128,
        pattern: /^[A-Za-z0-9_.:-]+$/,
      });
      if (String(invoice.trade_id || '').trim() !== tradeId) throw new Error(`${toolName}: invoice trade_id mismatch vs terms`);
      if (String(escrow.trade_id || '').trim() !== tradeId) throw new Error(`${toolName}: escrow trade_id mismatch vs terms`);

      const bolt11 = expectString({ bolt11: String(invoice.body?.bolt11 || '') }, toolName, 'bolt11', { min: 20, max: 8000 });
      const paymentHashHex = normalizeHex32(String(invoice.body?.payment_hash_hex || ''), 'payment_hash_hex');
      if (dryRun) return { type: 'dry_run', tool: toolName, channel, trade_id: tradeId, payment_hash_hex: paymentHashHex };

      const store = await this._openReceiptsStore({ required: true });
      try {
        const commitment = this._commitment();
        const verifyRes = await this._pool().call(async (connection) => {
          const res = await verifySwapPrePayOnchain({
            terms: terms.body,
            invoiceBody: invoice.body,
            escrowBody: escrow.body,
            connection,
            commitment,
            now_unix: nowUnix,
          });
          if (!res.ok) return res;

          // Fee guardrails: compare negotiated fee fields to what is actually on-chain.
          if (res.onchain?.state && isObject(terms.body)) {
            const t = terms.body;
            const st = res.onchain.state;
            if (t.platform_fee_bps !== undefined && t.platform_fee_bps !== null && st.platformFeeBps !== undefined) {
              if (Number(st.platformFeeBps) !== Number(t.platform_fee_bps)) {
                return { ok: false, error: 'platform_fee_bps mismatch vs onchain', decoded_invoice: res.decoded_invoice, onchain: res.onchain };
              }
            }
            if (t.trade_fee_bps !== undefined && t.trade_fee_bps !== null && st.tradeFeeBps !== undefined) {
              if (Number(st.tradeFeeBps) !== Number(t.trade_fee_bps)) {
                return { ok: false, error: 'trade_fee_bps mismatch vs onchain', decoded_invoice: res.decoded_invoice, onchain: res.onchain };
              }
            }
            if (t.trade_fee_collector && st.tradeFeeCollector?.toBase58) {
              if (String(st.tradeFeeCollector.toBase58()) !== String(t.trade_fee_collector)) {
                return { ok: false, error: 'trade_fee_collector mismatch vs onchain', decoded_invoice: res.decoded_invoice, onchain: res.onchain };
              }
            }
          }

          return res;
        }, { label: 'swap_verify_pre_pay' });
        if (!verifyRes.ok) throw new Error(`${toolName}: pre-pay verification failed: ${verifyRes.error}`);

        const payRes = await lnPay(this.ln, { bolt11 });
        const preimageHex = String(payRes?.payment_preimage || '').trim().toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(preimageHex)) throw new Error(`${toolName}: missing payment_preimage`);
        const gotHash = computePaymentHashFromPreimage(preimageHex);
        if (gotHash !== paymentHashHex) throw new Error(`${toolName}: preimage payment_hash mismatch`);

        store.upsertTrade(tradeId, {
          role: 'taker',
          swap_channel: channel,
          ln_payment_hash_hex: paymentHashHex,
          ln_preimage_hex: preimageHex,
          state: 'ln_paid',
          last_error: null,
        });
        store.appendEvent(tradeId, 'ln_paid', { channel, payment_hash_hex: paymentHashHex });

        const unsigned = createUnsignedEnvelope({
          v: 1,
          kind: KIND.LN_PAID,
          tradeId,
          body: { payment_hash_hex: paymentHashHex },
        });

        const signing = await this._requirePeerSigning();
        return await withScBridge(this.scBridge, async (sc) => {
          const signed = signSwapEnvelope(unsigned, signing);
          await this._sendEnvelopeLogged(sc, channel, signed);
          store.appendEvent(tradeId, 'ln_paid_posted', { channel, payment_hash_hex: paymentHashHex });
          const envHandle = secrets && typeof secrets.put === 'function'
            ? secrets.put(signed, { key: 'ln_paid', channel, trade_id: tradeId, payment_hash_hex: paymentHashHex })
            : null;
          return {
            type: 'ln_paid_posted',
            channel,
            trade_id: tradeId,
            payment_hash_hex: paymentHashHex,
            preimage_hex: preimageHex,
            envelope_handle: envHandle,
            envelope: envHandle ? null : signed,
          };
        });
      } finally {
        store.close();
      }
    }

    if (toolName === 'intercomswap_swap_sol_claim_and_post') {
      assertAllowedKeys(args, toolName, ['channel', 'trade_id', 'preimage_hex', 'mint']);
      requireApproval(toolName, autoApprove);
      const channel = normalizeChannelName(expectString(args, toolName, 'channel', { max: 128 }));
      const tradeId = expectString(args, toolName, 'trade_id', { min: 1, max: 128, pattern: /^[A-Za-z0-9_.:-]+$/ });
      const preimageArg = expectString(args, toolName, 'preimage_hex', { min: 1, max: 200 });
      const preimageResolved = resolveSecretArg(secrets, preimageArg, { label: 'preimage_hex', expectType: 'string' });
      const preimageHex = normalizeHex32(preimageResolved, 'preimage_hex');
      const paymentHashHex = computePaymentHashFromPreimage(preimageHex);
      const mint = new PublicKey(normalizeBase58(expectString(args, toolName, 'mint', { max: 64 }), 'mint'));
      if (dryRun) return { type: 'dry_run', tool: toolName, channel, trade_id: tradeId, payment_hash_hex: paymentHashHex };

      const store = await this._openReceiptsStore({ required: true });
      try {
      const signer = this._requireSolanaSigner();
      const programId = this._programId();
      const commitment = this._commitment();
      const { computeUnitLimit, computeUnitPriceMicroLamports } = this._computeBudget();

      const claimBuild = await this._pool().call(async (connection) => {
        const escrow = await getEscrowState(connection, paymentHashHex, programId, commitment);
        if (!escrow) throw new Error('Escrow not found');
        if (!escrow.recipient.equals(signer.publicKey)) {
          throw new Error(`Recipient mismatch (escrow.recipient=${escrow.recipient.toBase58()})`);
        }
        if (!escrow.mint.equals(mint)) throw new Error(`Mint mismatch (escrow.mint=${escrow.mint.toBase58()})`);

        const tradeFeeCollector = escrow.tradeFeeCollector ?? escrow.feeCollector;
        if (!tradeFeeCollector) throw new Error('Escrow missing tradeFeeCollector');

        const recipientAta = await getOrCreateAta(connection, signer, signer.publicKey, mint, commitment);
        return claimEscrowTx({
          connection,
          recipient: signer,
          recipientTokenAccount: recipientAta,
          mint,
          paymentHashHex,
          preimageHex,
          tradeFeeCollector,
          computeUnitLimit,
          computeUnitPriceMicroLamports,
          programId,
        });
      }, { label: 'swap_sol_claim_build' });

      const claimSig = await this._pool().call((connection) => sendAndConfirm(connection, claimBuild.tx, commitment), { label: 'swap_sol_claim_send' });

      store.upsertTrade(tradeId, {
        role: 'taker',
        swap_channel: channel,
        ln_payment_hash_hex: paymentHashHex,
        ln_preimage_hex: preimageHex,
        sol_mint: mint.toBase58(),
        sol_program_id: programId.toBase58(),
        sol_escrow_pda: claimBuild.escrowPda.toBase58(),
        sol_vault_ata: claimBuild.vault.toBase58(),
        state: 'claimed',
        last_error: null,
      });
      store.appendEvent(tradeId, 'sol_claimed', {
        channel,
        payment_hash_hex: paymentHashHex,
        escrow_pda: claimBuild.escrowPda.toBase58(),
        tx_sig: claimSig,
      });

      const unsigned = createUnsignedEnvelope({
        v: 1,
        kind: KIND.SOL_CLAIMED,
        tradeId,
        body: {
          payment_hash_hex: paymentHashHex,
          escrow_pda: claimBuild.escrowPda.toBase58(),
          tx_sig: claimSig,
        },
      });

		      const signing = await this._requirePeerSigning();
		      return await withScBridge(this.scBridge, async (sc) => {
		        const signed = signSwapEnvelope(unsigned, signing);
		        await this._sendEnvelopeLogged(sc, channel, signed);
		        store.appendEvent(tradeId, 'sol_claimed_posted', { channel, payment_hash_hex: paymentHashHex });
		        const envHandle = secrets && typeof secrets.put === 'function'
		          ? secrets.put(signed, { key: 'sol_claimed', channel, trade_id: tradeId, payment_hash_hex: paymentHashHex })
		          : null;
	        return {
          type: 'sol_claimed_posted',
          channel,
          trade_id: tradeId,
          payment_hash_hex: paymentHashHex,
          escrow_pda: claimBuild.escrowPda.toBase58(),
          tx_sig: claimSig,
          envelope_handle: envHandle,
          envelope: envHandle ? null : signed,
        };
      });
      } finally {
        store.close();
      }
    }

    // Solana wallet ops
    if (toolName === 'intercomswap_sol_local_status') {
      assertAllowedKeys(args, toolName, []);
      const rpcPort = parseLocalRpcPortFromUrls(this.solana?.rpcUrls || '', 8899);
      return solLocalStatus({ repoRoot: process.cwd(), name: 'local', host: '127.0.0.1', rpcPort });
    }

    if (toolName === 'intercomswap_sol_local_start') {
      assertAllowedKeys(args, toolName, [
        'rpc_port',
        'faucet_port',
        'ledger_dir',
        'so_path',
        'program_id',
        'reset',
        'quiet',
        'ready_timeout_ms',
      ]);
      requireApproval(toolName, autoApprove);

      const rpcPort = expectOptionalInt(args, toolName, 'rpc_port', { min: 1, max: 65535 }) ?? parseLocalRpcPortFromUrls(this.solana?.rpcUrls || '', 8899);
      const faucetPort = expectOptionalInt(args, toolName, 'faucet_port', { min: 1, max: 65535 }) ?? 9900;
      const ledgerDir = expectOptionalString(args, toolName, 'ledger_dir', { min: 1, max: 400 }) || path.join('onchain', 'solana', `ledger-local-${rpcPort}`);
      const soPath = expectOptionalString(args, toolName, 'so_path', { min: 1, max: 400 }) || '';
      const programId = expectOptionalString(args, toolName, 'program_id', { min: 32, max: 64, pattern: /^[1-9A-HJ-NP-Za-km-z]+$/ }) || this._programId().toBase58();
      const reset = 'reset' in args ? expectBool(args, toolName, 'reset') : false;
      const quiet = 'quiet' in args ? expectBool(args, toolName, 'quiet') : true;
      const readyTimeoutMs = expectOptionalInt(args, toolName, 'ready_timeout_ms', { min: 0, max: 120_000 }) ?? 60_000;

      if (dryRun) {
        return {
          type: 'dry_run',
          tool: toolName,
          host: '127.0.0.1',
          rpc_port: rpcPort,
          rpc_url: `http://127.0.0.1:${rpcPort}`,
          faucet_port: faucetPort,
          ledger_dir: ledgerDir,
          program_id: programId,
          so_path: soPath || null,
          reset,
          quiet,
          ready_timeout_ms: readyTimeoutMs,
        };
      }

      return solLocalStart({
        repoRoot: process.cwd(),
        name: 'local',
        host: '127.0.0.1',
        rpcPort,
        faucetPort,
        ledgerDir,
        programId,
        soPath,
        reset,
        quiet,
        readyTimeoutMs,
      });
    }

    if (toolName === 'intercomswap_sol_local_stop') {
      assertAllowedKeys(args, toolName, ['signal', 'wait_ms']);
      requireApproval(toolName, autoApprove);
      const signal = expectOptionalString(args, toolName, 'signal', { min: 3, max: 10 }) || 'SIGINT';
      const waitMs = expectOptionalInt(args, toolName, 'wait_ms', { min: 0, max: 120_000 }) ?? 5000;
      if (dryRun) return { type: 'dry_run', tool: toolName, signal, wait_ms: waitMs };
      return solLocalStop({ repoRoot: process.cwd(), name: 'local', signal, waitMs });
    }

    if (toolName === 'intercomswap_sol_signer_pubkey') {
      assertAllowedKeys(args, toolName, []);
      const signer = this._requireSolanaSigner();
      return { type: 'sol_signer', pubkey: signer.publicKey.toBase58() };
    }

    if (toolName === 'intercomswap_sol_keygen') {
      assertAllowedKeys(args, toolName, ['out', 'seed_hex', 'overwrite']);
      requireApproval(toolName, autoApprove);
      const outArg = expectString(args, toolName, 'out', { min: 1, max: 400 });
      const outPath = resolveOnchainPath(outArg, { label: 'out' });
      const seedHex = expectOptionalString(args, toolName, 'seed_hex', { min: 64, max: 64, pattern: /^[0-9a-fA-F]{64}$/ });
      const overwrite = 'overwrite' in args ? expectBool(args, toolName, 'overwrite') : false;
      if (dryRun) return { type: 'dry_run', tool: toolName, out: outPath };
      const kp = generateSolanaKeypair({ seedHex: seedHex ? seedHex.toLowerCase() : null });
      const written = writeSolanaKeypair(outPath, kp, { overwrite });
      return { type: 'sol_keygen', out: written, pubkey: kp.publicKey.toBase58() };
    }

    if (toolName === 'intercomswap_sol_keypair_pubkey') {
      assertAllowedKeys(args, toolName, ['keypair_path']);
      const keypairPathArg = expectString(args, toolName, 'keypair_path', { min: 1, max: 400 });
      const keypairPath = resolveOnchainPath(keypairPathArg, { label: 'keypair_path' });
      const kp = readSolanaKeypair(keypairPath);
      return { type: 'sol_keypair_pubkey', keypair_path: keypairPath, pubkey: kp.publicKey.toBase58() };
    }

    if (toolName === 'intercomswap_sol_airdrop') {
      assertAllowedKeys(args, toolName, ['pubkey', 'lamports']);
      requireApproval(toolName, autoApprove);
      const lamportsStr = normalizeAtomicAmount(expectString(args, toolName, 'lamports', { max: 64 }), 'lamports');
      const lamportsBig = BigInt(lamportsStr);
      if (lamportsBig <= 0n) throw new Error(`${toolName}: lamports must be > 0`);
      if (lamportsBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${toolName}: lamports too large for JS number`);
      const lamports = Number(lamportsBig);
      const signer = this._requireSolanaSigner();
      const pubkeyStr = expectOptionalString(args, toolName, 'pubkey', { min: 32, max: 64, pattern: /^[1-9A-HJ-NP-Za-km-z]+$/ });
      const to = pubkeyStr ? new PublicKey(normalizeBase58(pubkeyStr, 'pubkey')) : signer.publicKey;
      if (dryRun) return { type: 'dry_run', tool: toolName, pubkey: to.toBase58(), lamports: lamportsStr };
      const commitment = this._commitment();
      return this._pool().call(async (connection) => {
        const sig = await connection.requestAirdrop(to, lamports);
        await connection.confirmTransaction(sig, commitment);
        return { type: 'airdrop', pubkey: to.toBase58(), lamports: lamportsStr, tx_sig: sig };
      }, { label: 'sol_airdrop' });
    }

    if (toolName === 'intercomswap_sol_transfer_sol') {
      assertAllowedKeys(args, toolName, ['to', 'lamports']);
      requireApproval(toolName, autoApprove);
      const to = new PublicKey(normalizeBase58(expectString(args, toolName, 'to', { max: 64 }), 'to'));
      const lamportsStr = normalizeAtomicAmount(expectString(args, toolName, 'lamports', { max: 64 }), 'lamports');
      const lamportsBig = BigInt(lamportsStr);
      if (lamportsBig <= 0n) throw new Error(`${toolName}: lamports must be > 0`);
      if (lamportsBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${toolName}: lamports too large for JS number`);
      const lamports = Number(lamportsBig);
      if (dryRun) return { type: 'dry_run', tool: toolName, to: to.toBase58(), lamports: lamportsStr };

      const signer = this._requireSolanaSigner();
      const commitment = this._commitment();
      return this._pool().call(async (connection) => {
        const ix = SystemProgram.transfer({
          fromPubkey: signer.publicKey,
          toPubkey: to,
          lamports,
        });
        const tx = new Transaction().add(ix);
        tx.feePayer = signer.publicKey;
        const latest = await connection.getLatestBlockhash(commitment);
        tx.recentBlockhash = latest.blockhash;
        tx.sign(signer);
        const sig = await sendAndConfirm(connection, tx, commitment);
        return { type: 'sol_transfer', from: signer.publicKey.toBase58(), to: to.toBase58(), lamports: lamportsStr, tx_sig: sig };
      }, { label: 'sol_transfer_sol' });
    }

    if (toolName === 'intercomswap_sol_token_transfer') {
      assertAllowedKeys(args, toolName, ['mint', 'to_owner', 'amount', 'create_ata']);
      requireApproval(toolName, autoApprove);
      const mint = new PublicKey(normalizeBase58(expectString(args, toolName, 'mint', { max: 64 }), 'mint'));
      const toOwner = new PublicKey(normalizeBase58(expectString(args, toolName, 'to_owner', { max: 64 }), 'to_owner'));
      const amountStr = normalizeAtomicAmount(expectString(args, toolName, 'amount', { max: 64 }), 'amount');
      const amount = BigInt(amountStr);
      if (amount <= 0n) throw new Error(`${toolName}: amount must be > 0`);
      const createAta = 'create_ata' in args ? expectBool(args, toolName, 'create_ata') : true;
      if (dryRun) return { type: 'dry_run', tool: toolName, mint: mint.toBase58(), to_owner: toOwner.toBase58(), amount: amountStr };

      const signer = this._requireSolanaSigner();
      const commitment = this._commitment();
      return this._pool().call(async (connection) => {
        const fromAta = await getOrCreateAta(connection, signer, signer.publicKey, mint, commitment);
        const toAta = await getAssociatedTokenAddress(mint, toOwner, true);
        if (createAta) await getOrCreateAta(connection, signer, toOwner, mint, commitment);
        else await getAccount(connection, toAta, commitment);
        const sig = await splTransfer(connection, signer, fromAta, toAta, signer.publicKey, amount, [], { commitment });
        return {
          type: 'token_transfer',
          mint: mint.toBase58(),
          from_owner: signer.publicKey.toBase58(),
          to_owner: toOwner.toBase58(),
          from_ata: fromAta.toBase58(),
          to_ata: toAta.toBase58(),
          amount: amountStr,
          tx_sig: sig,
        };
      }, { label: 'sol_token_transfer' });
    }

    if (toolName === 'intercomswap_sol_mint_create') {
      assertAllowedKeys(args, toolName, ['decimals']);
      requireApproval(toolName, autoApprove);
      const decimals = expectInt(args, toolName, 'decimals', { min: 0, max: 18 });
      if (dryRun) return { type: 'dry_run', tool: toolName, decimals };
      const signer = this._requireSolanaSigner();
      const commitment = this._commitment();
      return this._pool().call(async (connection) => {
        const mintKp = Keypair.generate();
        const mint = await createMint(connection, signer, signer.publicKey, signer.publicKey, decimals, mintKp, { commitment });
        return { type: 'mint_created', mint: mint.toBase58(), decimals };
      }, { label: 'sol_mint_create' });
    }

    if (toolName === 'intercomswap_sol_mint_to') {
      assertAllowedKeys(args, toolName, ['mint', 'to_owner', 'amount', 'create_ata']);
      requireApproval(toolName, autoApprove);
      const mint = new PublicKey(normalizeBase58(expectString(args, toolName, 'mint', { max: 64 }), 'mint'));
      const toOwner = new PublicKey(normalizeBase58(expectString(args, toolName, 'to_owner', { max: 64 }), 'to_owner'));
      const amountStr = normalizeAtomicAmount(expectString(args, toolName, 'amount', { max: 64 }), 'amount');
      const amount = BigInt(amountStr);
      if (amount <= 0n) throw new Error(`${toolName}: amount must be > 0`);
      const createAta = 'create_ata' in args ? expectBool(args, toolName, 'create_ata') : true;
      if (dryRun) return { type: 'dry_run', tool: toolName, mint: mint.toBase58(), to_owner: toOwner.toBase58(), amount: amountStr };

      const signer = this._requireSolanaSigner();
      const commitment = this._commitment();
      return this._pool().call(async (connection) => {
        const toAta = await getAssociatedTokenAddress(mint, toOwner, true);
        if (createAta) await getOrCreateAta(connection, signer, toOwner, mint, commitment);
        else await getAccount(connection, toAta, commitment);
        const sig = await mintTo(connection, signer, mint, toAta, signer.publicKey, amount, [], { commitment });
        return { type: 'mint_to', mint: mint.toBase58(), to_owner: toOwner.toBase58(), to_ata: toAta.toBase58(), amount: amountStr, tx_sig: sig };
      }, { label: 'sol_mint_to' });
    }

    // Solana (read-only)
    if (toolName === 'intercomswap_sol_balance') {
      assertAllowedKeys(args, toolName, ['pubkey']);
      const pubkey = new PublicKey(normalizeBase58(expectString(args, toolName, 'pubkey', { max: 64 }), 'pubkey'));
      const commitment = this._commitment();
      return this._pool().call((connection) => connection.getBalance(pubkey, commitment), { label: 'sol_balance' });
    }

    if (toolName === 'intercomswap_sol_token_balance') {
      assertAllowedKeys(args, toolName, ['owner', 'mint']);
      const owner = new PublicKey(normalizeBase58(expectString(args, toolName, 'owner', { max: 64 }), 'owner'));
      const mint = new PublicKey(normalizeBase58(expectString(args, toolName, 'mint', { max: 64 }), 'mint'));
      const commitment = this._commitment();
      return this._pool().call(
        async (connection) => {
          const ata = await getAssociatedTokenAddress(mint, owner, true);
          try {
            const acct = await getAccount(connection, ata, commitment);
            return { ata: ata.toBase58(), amount: acct.amount.toString(), decimals: acct.decimals ?? null };
          } catch (_e) {
            return { ata: ata.toBase58(), amount: '0', decimals: null };
          }
        },
        { label: 'sol_token_balance' }
      );
    }

    if (toolName === 'intercomswap_sol_escrow_get') {
      assertAllowedKeys(args, toolName, ['payment_hash_hex', 'mint']);
      const paymentHashHex = normalizeHex32(expectString(args, toolName, 'payment_hash_hex', { min: 64, max: 64 }), 'payment_hash_hex');
      const programId = this._programId();
      const commitment = this._commitment();
      // mint is currently unused for lookup (escrow PDA depends only on payment hash).
      void normalizeBase58(expectString(args, toolName, 'mint', { max: 64 }), 'mint');
      return this._pool().call(async (connection) => {
        const st = await getEscrowState(connection, paymentHashHex, programId, commitment);
        if (!st) return null;
        const { pda: escrowPda } = deriveEscrowPda(paymentHashHex, programId);
        return {
          v: st.v,
          status: st.status,
          payment_hash_hex: st.paymentHashHex,
          escrow_pda: escrowPda.toBase58(),
          recipient: st.recipient?.toBase58?.() ?? null,
          refund: st.refund?.toBase58?.() ?? null,
          refund_after_unix: st.refundAfter !== undefined && st.refundAfter !== null ? st.refundAfter.toString() : null,
          mint: st.mint?.toBase58?.() ?? null,
          amount: st.amount !== undefined && st.amount !== null ? st.amount.toString() : null,
          net_amount: st.netAmount !== undefined && st.netAmount !== null ? st.netAmount.toString() : null,
          platform_fee_amount:
            st.platformFeeAmount !== undefined && st.platformFeeAmount !== null ? st.platformFeeAmount.toString() : null,
          platform_fee_bps: st.platformFeeBps ?? 0,
          platform_fee_collector: st.platformFeeCollector?.toBase58?.() ?? st.feeCollector?.toBase58?.() ?? null,
          trade_fee_amount:
            st.tradeFeeAmount !== undefined && st.tradeFeeAmount !== null ? st.tradeFeeAmount.toString() : null,
          trade_fee_bps: st.tradeFeeBps ?? 0,
          trade_fee_collector: st.tradeFeeCollector?.toBase58?.() ?? null,
          // Legacy fields for older escrow versions / clients:
          fee_amount: st.feeAmount !== undefined && st.feeAmount !== null ? st.feeAmount.toString() : null,
          fee_bps: st.feeBps ?? null,
          fee_collector: st.feeCollector?.toBase58?.() ?? null,
          vault: st.vault?.toBase58?.() ?? null,
          bump: st.bump,
        };
      }, { label: 'sol_escrow_get' });
    }

    if (toolName === 'intercomswap_sol_config_get') {
      assertAllowedKeys(args, toolName, []);
      const programId = this._programId();
      const commitment = this._commitment();
      return this._pool().call(async (connection) => {
        const st = await getConfigState(connection, programId, commitment);
        if (!st) return null;
        const { pda: configPda } = deriveConfigPda(programId);
        return {
          v: st.v,
          config_pda: configPda.toBase58(),
          authority: st.authority?.toBase58?.() ?? null,
          fee_collector: st.feeCollector?.toBase58?.() ?? null,
          fee_bps: st.feeBps,
          bump: st.bump,
        };
      }, { label: 'sol_config_get' });
    }

    if (toolName === 'intercomswap_sol_trade_config_get') {
      assertAllowedKeys(args, toolName, ['fee_collector']);
      const feeCollector = new PublicKey(normalizeBase58(expectString(args, toolName, 'fee_collector', { max: 64 }), 'fee_collector'));
      const programId = this._programId();
      const commitment = this._commitment();
      return this._pool().call(async (connection) => {
        const st = await getTradeConfigState(connection, feeCollector, programId, commitment);
        if (!st) return null;
        const { pda: tradeConfigPda } = deriveTradeConfigPda(feeCollector, programId);
        return {
          v: st.v,
          trade_config_pda: tradeConfigPda.toBase58(),
          authority: st.authority?.toBase58?.() ?? null,
          fee_collector: st.feeCollector?.toBase58?.() ?? null,
          fee_bps: st.feeBps,
          bump: st.bump,
        };
      }, { label: 'sol_trade_config_get' });
    }

    // Solana mutations
    if (toolName === 'intercomswap_sol_config_set') {
      assertAllowedKeys(args, toolName, ['fee_bps', 'fee_collector']);
      requireApproval(toolName, autoApprove);
      const feeBps = expectInt(args, toolName, 'fee_bps', { min: 0, max: 500 });
      const feeCollector = new PublicKey(normalizeBase58(expectString(args, toolName, 'fee_collector', { max: 64 }), 'fee_collector'));
      if (dryRun) return { type: 'dry_run', tool: toolName, fee_bps: feeBps, fee_collector: feeCollector.toBase58() };

      const signer = this._requireSolanaSigner();
      const programId = this._programId();
      const commitment = this._commitment();
      const { computeUnitLimit, computeUnitPriceMicroLamports } = this._computeBudget();

      return this._pool().call(async (connection) => {
        // If config does not exist, init it.
        const current = await getConfigState(connection, programId, commitment);
        const build = current
          ? await setConfigTx({
              connection,
              authority: signer,
              feeCollector,
              feeBps,
              computeUnitLimit,
              computeUnitPriceMicroLamports,
              programId,
            })
          : await initConfigTx({
              connection,
              payer: signer,
              feeCollector,
              feeBps,
              computeUnitLimit,
              computeUnitPriceMicroLamports,
              programId,
            });
        const sig = await sendAndConfirm(connection, build.tx, commitment);
        return { type: current ? 'config_set' : 'config_init', sig, config_pda: build.configPda.toBase58() };
      }, { label: 'sol_config_set' });
    }

    if (toolName === 'intercomswap_sol_trade_config_set') {
      assertAllowedKeys(args, toolName, ['fee_bps', 'fee_collector']);
      requireApproval(toolName, autoApprove);
      const feeBps = expectInt(args, toolName, 'fee_bps', { min: 0, max: 1000 });
      const feeCollector = new PublicKey(normalizeBase58(expectString(args, toolName, 'fee_collector', { max: 64 }), 'fee_collector'));
      if (dryRun) return { type: 'dry_run', tool: toolName, fee_bps: feeBps, fee_collector: feeCollector.toBase58() };

      const signer = this._requireSolanaSigner();
      const programId = this._programId();
      const commitment = this._commitment();
      const { computeUnitLimit, computeUnitPriceMicroLamports } = this._computeBudget();

      return this._pool().call(async (connection) => {
        const current = await getTradeConfigState(connection, feeCollector, programId, commitment);
        const build = current
          ? await setTradeConfigTx({
              connection,
              authority: signer,
              feeCollector,
              feeBps,
              computeUnitLimit,
              computeUnitPriceMicroLamports,
              programId,
            })
          : await initTradeConfigTx({
              connection,
              payer: signer,
              feeCollector,
              feeBps,
              computeUnitLimit,
              computeUnitPriceMicroLamports,
              programId,
            });
        const sig = await sendAndConfirm(connection, build.tx, commitment);
        return { type: current ? 'trade_config_set' : 'trade_config_init', sig, trade_config_pda: build.tradeConfigPda.toBase58() };
      }, { label: 'sol_trade_config_set' });
    }

    if (toolName === 'intercomswap_sol_fees_withdraw') {
      assertAllowedKeys(args, toolName, ['mint', 'to', 'amount']);
      requireApproval(toolName, autoApprove);
      const mint = new PublicKey(normalizeBase58(expectString(args, toolName, 'mint', { max: 64 }), 'mint'));
      const to = new PublicKey(normalizeBase58(expectString(args, toolName, 'to', { max: 64 }), 'to'));
      const amountStr = normalizeAtomicAmount(expectString(args, toolName, 'amount', { max: 64 }), 'amount');
      const amount = BigInt(amountStr);
      if (dryRun) return { type: 'dry_run', tool: toolName };

      const signer = this._requireSolanaSigner();
      const programId = this._programId();
      const commitment = this._commitment();
      const { computeUnitLimit, computeUnitPriceMicroLamports } = this._computeBudget();

      return this._pool().call(async (connection) => {
        const toAta = await getOrCreateAta(connection, signer, to, mint, commitment);
        const build = await withdrawFeesTx({
          connection,
          feeCollector: signer,
          feeCollectorTokenAccount: toAta,
          mint,
          amount,
          computeUnitLimit,
          computeUnitPriceMicroLamports,
          programId,
        });
        const sig = await sendAndConfirm(connection, build.tx, commitment);
        return { type: 'fees_withdrawn', sig, fee_vault_ata: build.feeVaultAta.toBase58(), to_ata: toAta.toBase58() };
      }, { label: 'sol_fees_withdraw' });
    }

    if (toolName === 'intercomswap_sol_trade_fees_withdraw') {
      assertAllowedKeys(args, toolName, ['mint', 'to', 'amount']);
      requireApproval(toolName, autoApprove);
      const mint = new PublicKey(normalizeBase58(expectString(args, toolName, 'mint', { max: 64 }), 'mint'));
      const to = new PublicKey(normalizeBase58(expectString(args, toolName, 'to', { max: 64 }), 'to'));
      const amountStr = normalizeAtomicAmount(expectString(args, toolName, 'amount', { max: 64 }), 'amount');
      const amount = BigInt(amountStr);
      if (dryRun) return { type: 'dry_run', tool: toolName };

      const signer = this._requireSolanaSigner();
      const programId = this._programId();
      const commitment = this._commitment();
      const { computeUnitLimit, computeUnitPriceMicroLamports } = this._computeBudget();

      return this._pool().call(async (connection) => {
        const toAta = await getOrCreateAta(connection, signer, to, mint, commitment);
        const build = await withdrawTradeFeesTx({
          connection,
          feeCollector: signer,
          feeCollectorTokenAccount: toAta,
          mint,
          amount,
          computeUnitLimit,
          computeUnitPriceMicroLamports,
          programId,
        });
        const sig = await sendAndConfirm(connection, build.tx, commitment);
        return {
          type: 'trade_fees_withdrawn',
          sig,
          trade_config_pda: build.tradeConfigPda.toBase58(),
          fee_vault_ata: build.feeVaultAta.toBase58(),
          to_ata: toAta.toBase58(),
        };
      }, { label: 'sol_trade_fees_withdraw' });
    }

    if (toolName === 'intercomswap_sol_escrow_init') {
      assertAllowedKeys(args, toolName, [
        'payment_hash_hex',
        'mint',
        'amount',
        'recipient',
        'refund',
        'refund_after_unix',
        'platform_fee_bps',
        'trade_fee_bps',
        'trade_fee_collector',
        'platform_fee_collector',
      ]);
      requireApproval(toolName, autoApprove);
      const paymentHashHex = normalizeHex32(expectString(args, toolName, 'payment_hash_hex', { min: 64, max: 64 }), 'payment_hash_hex');
      const mint = new PublicKey(normalizeBase58(expectString(args, toolName, 'mint', { max: 64 }), 'mint'));
      const amountStr = normalizeAtomicAmount(expectString(args, toolName, 'amount', { max: 64 }), 'amount');
      const amount = BigInt(amountStr);
      const recipient = new PublicKey(normalizeBase58(expectString(args, toolName, 'recipient', { max: 64 }), 'recipient'));
      const refund = new PublicKey(normalizeBase58(expectString(args, toolName, 'refund', { max: 64 }), 'refund'));
      const refundAfterUnix = expectInt(args, toolName, 'refund_after_unix', { min: 1 });
      assertRefundAfterUnixWindow(refundAfterUnix, toolName);
      const platformFeeBps = expectInt(args, toolName, 'platform_fee_bps', { min: 0, max: 500 });
      const tradeFeeBps = expectInt(args, toolName, 'trade_fee_bps', { min: 0, max: 1000 });
      const tradeFeeCollector = new PublicKey(normalizeBase58(expectString(args, toolName, 'trade_fee_collector', { max: 64 }), 'trade_fee_collector'));
      // platform_fee_collector is validated in TERMS, but not required for escrow init (program uses config).
      void args.platform_fee_collector;

      if (dryRun) return { type: 'dry_run', tool: toolName, payment_hash_hex: paymentHashHex };

      const signer = this._requireSolanaSigner();
      const programId = this._programId();
      const commitment = this._commitment();
      const { computeUnitLimit, computeUnitPriceMicroLamports } = this._computeBudget();

      return this._pool().call(async (connection) => {
        const payerAta = await getOrCreateAta(connection, signer, signer.publicKey, mint, commitment);
        const build = await createEscrowTx({
          connection,
          payer: signer,
          payerTokenAccount: payerAta,
          mint,
          paymentHashHex,
          recipient,
          refund,
          refundAfterUnix,
          amount,
          expectedPlatformFeeBps: platformFeeBps,
          expectedTradeFeeBps: tradeFeeBps,
          tradeFeeCollector,
          computeUnitLimit,
          computeUnitPriceMicroLamports,
          programId,
        });
        const sig = await sendAndConfirm(connection, build.tx, commitment);
        return {
          type: 'escrow_inited',
          sig,
          program_id: programId.toBase58(),
          payment_hash_hex: paymentHashHex,
          escrow_pda: build.escrowPda.toBase58(),
          vault_ata: build.vault.toBase58(),
          platform_fee_vault_ata: build.platformFeeVaultAta.toBase58(),
          trade_config_pda: build.tradeConfigPda.toBase58(),
          trade_fee_vault_ata: build.tradeFeeVaultAta.toBase58(),
        };
      }, { label: 'sol_escrow_init' });
    }

    if (toolName === 'intercomswap_sol_escrow_claim') {
      assertAllowedKeys(args, toolName, ['preimage_hex', 'mint']);
      requireApproval(toolName, autoApprove);
      const preimageArg = expectString(args, toolName, 'preimage_hex', { min: 1, max: 200 });
      const preimageResolved = resolveSecretArg(secrets, preimageArg, { label: 'preimage_hex', expectType: 'string' });
      const preimageHex = normalizeHex32(preimageResolved, 'preimage_hex');
      const paymentHashHex = computePaymentHashFromPreimage(preimageHex);
      const mint = new PublicKey(normalizeBase58(expectString(args, toolName, 'mint', { max: 64 }), 'mint'));
      if (dryRun) return { type: 'dry_run', tool: toolName, payment_hash_hex: paymentHashHex };

      const signer = this._requireSolanaSigner();
      const programId = this._programId();
      const commitment = this._commitment();
      const { computeUnitLimit, computeUnitPriceMicroLamports } = this._computeBudget();

      return this._pool().call(async (connection) => {
        const escrow = await getEscrowState(connection, paymentHashHex, programId, commitment);
        if (!escrow) throw new Error('Escrow not found');
        if (!escrow.recipient.equals(signer.publicKey)) {
          throw new Error(`Recipient mismatch (escrow.recipient=${escrow.recipient.toBase58()})`);
        }
        if (!escrow.mint.equals(mint)) throw new Error(`Mint mismatch (escrow.mint=${escrow.mint.toBase58()})`);

        const tradeFeeCollector = escrow.tradeFeeCollector ?? escrow.feeCollector;
        if (!tradeFeeCollector) throw new Error('Escrow missing tradeFeeCollector');

        const recipientAta = await getOrCreateAta(connection, signer, signer.publicKey, mint, commitment);
        const build = await claimEscrowTx({
          connection,
          recipient: signer,
          recipientTokenAccount: recipientAta,
          mint,
          paymentHashHex,
          preimageHex,
          tradeFeeCollector,
          computeUnitLimit,
          computeUnitPriceMicroLamports,
          programId,
        });
        const sig = await sendAndConfirm(connection, build.tx, commitment);
        return { type: 'escrow_claimed', sig, escrow_pda: build.escrowPda.toBase58(), vault_ata: build.vault.toBase58() };
      }, { label: 'sol_escrow_claim' });
    }

    if (toolName === 'intercomswap_sol_escrow_refund') {
      assertAllowedKeys(args, toolName, ['payment_hash_hex', 'mint']);
      requireApproval(toolName, autoApprove);
      const paymentHashHex = normalizeHex32(expectString(args, toolName, 'payment_hash_hex', { min: 64, max: 64 }), 'payment_hash_hex');
      const mint = new PublicKey(normalizeBase58(expectString(args, toolName, 'mint', { max: 64 }), 'mint'));
      if (dryRun) return { type: 'dry_run', tool: toolName, payment_hash_hex: paymentHashHex };

      const signer = this._requireSolanaSigner();
      const programId = this._programId();
      const commitment = this._commitment();
      const { computeUnitLimit, computeUnitPriceMicroLamports } = this._computeBudget();

      return this._pool().call(async (connection) => {
        const escrow = await getEscrowState(connection, paymentHashHex, programId, commitment);
        if (!escrow) throw new Error('Escrow not found');
        if (!escrow.refund.equals(signer.publicKey)) {
          throw new Error(`Refund mismatch (escrow.refund=${escrow.refund.toBase58()})`);
        }
        if (!escrow.mint.equals(mint)) throw new Error(`Mint mismatch (escrow.mint=${escrow.mint.toBase58()})`);

        const refundAta = await getOrCreateAta(connection, signer, signer.publicKey, mint, commitment);
        const build = await refundEscrowTx({
          connection,
          refund: signer,
          refundTokenAccount: refundAta,
          mint,
          paymentHashHex,
          computeUnitLimit,
          computeUnitPriceMicroLamports,
          programId,
        });
        const sig = await sendAndConfirm(connection, build.tx, commitment);
        return { type: 'escrow_refunded', sig, escrow_pda: build.escrowPda.toBase58(), vault_ata: build.vault.toBase58() };
      }, { label: 'sol_escrow_refund' });
    }

    // Receipts + recovery (local-only)
    if (
      toolName === 'intercomswap_receipts_list' ||
      toolName === 'intercomswap_receipts_show' ||
      toolName === 'intercomswap_receipts_list_open_claims' ||
      toolName === 'intercomswap_receipts_list_open_refunds' ||
      toolName === 'intercomswap_swaprecover_claim' ||
      toolName === 'intercomswap_swaprecover_refund'
    ) {
      const { TradeReceiptsStore } = await import('../receipts/store.js');
      const dbPath = String(this.receipts?.dbPath || '').trim();
      if (!dbPath) throw new Error('receipts db not configured (set receipts.db in prompt setup JSON)');
      const store = TradeReceiptsStore.open({ dbPath });
      try {

      const pickTrade = ({ tradeId, paymentHashHex }) => {
        if (tradeId) {
          const t = store.getTrade(tradeId);
          if (!t) throw new Error(`Trade not found: trade_id=${tradeId}`);
          return t;
        }
        if (paymentHashHex) {
          const t = store.getTradeByPaymentHash(paymentHashHex);
          if (!t) throw new Error(`Trade not found for payment_hash=${paymentHashHex}`);
          return t;
        }
        throw new Error('Missing trade_id or payment_hash_hex');
      };

      if (toolName === 'intercomswap_receipts_list') {
        assertAllowedKeys(args, toolName, ['limit', 'offset']);
        const limit = expectOptionalInt(args, toolName, 'limit', { min: 1, max: 1000 }) ?? 50;
        const offset = expectOptionalInt(args, toolName, 'offset', { min: 0, max: 1_000_000 }) ?? 0;
        return store.listTradesPaged({ limit, offset });
      }

      if (toolName === 'intercomswap_receipts_list_open_claims') {
        assertAllowedKeys(args, toolName, ['limit', 'offset']);
        const limit = expectOptionalInt(args, toolName, 'limit', { min: 1, max: 1000 }) ?? 50;
        const offset = expectOptionalInt(args, toolName, 'offset', { min: 0, max: 1_000_000 }) ?? 0;
        return store.listOpenClaims({ limit, offset, state: 'ln_paid' });
      }

      if (toolName === 'intercomswap_receipts_list_open_refunds') {
        assertAllowedKeys(args, toolName, ['now_unix', 'limit', 'offset']);
        const nowUnix = expectOptionalInt(args, toolName, 'now_unix', { min: 1 }) ?? null;
        const limit = expectOptionalInt(args, toolName, 'limit', { min: 1, max: 1000 }) ?? 50;
        const offset = expectOptionalInt(args, toolName, 'offset', { min: 0, max: 1_000_000 }) ?? 0;
        return store.listOpenRefunds({ nowUnix, limit, offset, state: 'escrow' });
      }

      if (toolName === 'intercomswap_receipts_show') {
        assertAllowedKeys(args, toolName, ['trade_id']);
        const tradeId = expectString(args, toolName, 'trade_id', { min: 1, max: 128 });
        return store.getTrade(tradeId);
      }

      if (toolName === 'intercomswap_swaprecover_claim') {
        assertAllowedKeys(args, toolName, ['trade_id', 'payment_hash_hex']);
        requireApproval(toolName, autoApprove);
        const tradeId = expectOptionalString(args, toolName, 'trade_id', { min: 1, max: 128 });
        const paymentHashHex = expectOptionalString(args, toolName, 'payment_hash_hex', { min: 64, max: 64, pattern: /^[0-9a-fA-F]{64}$/ });
        const trade = pickTrade({ tradeId, paymentHashHex: paymentHashHex ? normalizeHex32(paymentHashHex, 'payment_hash_hex') : null });

        const hash = normalizeHex32(String(trade.ln_payment_hash_hex || ''), 'ln_payment_hash_hex');
        const preimageHex = normalizeHex32(String(trade.ln_preimage_hex || ''), 'ln_preimage_hex');
        const mintStr = String(trade.sol_mint || '').trim();
        const programStr = String(trade.sol_program_id || '').trim();
        if (!mintStr) throw new Error('Trade missing sol_mint (cannot claim)');
        if (!programStr) throw new Error('Trade missing sol_program_id (cannot claim)');

        const signer = this._requireSolanaSigner();
        const signerPk = signer.publicKey.toBase58();
        if (String(trade.sol_recipient || '').trim() && String(trade.sol_recipient).trim() !== signerPk) {
          throw new Error(`Signer mismatch (need sol_recipient=${trade.sol_recipient})`);
        }

        if (dryRun) return { type: 'dry_run', tool: toolName, trade_id: trade.trade_id, payment_hash_hex: hash };

        const mint = new PublicKey(mintStr);
        const programId = new PublicKey(programStr);
        const commitment = this._commitment();
        const { computeUnitLimit, computeUnitPriceMicroLamports } = this._computeBudget();

        const build = await this._pool().call(async (connection) => {
          const onchain = await getEscrowState(connection, hash, programId, commitment);
          if (!onchain) throw new Error('Escrow not found on chain');
          if (!onchain.recipient.equals(signer.publicKey)) {
            throw new Error(`Recipient mismatch (escrow.recipient=${onchain.recipient.toBase58()})`);
          }
          const tradeFeeCollector = onchain.tradeFeeCollector ?? onchain.feeCollector;
          if (!tradeFeeCollector) throw new Error('Escrow missing tradeFeeCollector');
          const recipientAta = await getOrCreateAta(connection, signer, signer.publicKey, mint, commitment);
          return claimEscrowTx({
            connection,
            recipient: signer,
            recipientTokenAccount: recipientAta,
            mint,
            paymentHashHex: hash,
            preimageHex,
            tradeFeeCollector,
            computeUnitLimit,
            computeUnitPriceMicroLamports,
            programId,
          });
        }, { label: 'swaprecover_claim_build' });

        const sig = await this._pool().call((connection) => sendAndConfirm(connection, build.tx, commitment), { label: 'swaprecover_claim_send' });

        store.upsertTrade(trade.trade_id, { state: 'claimed' });
        store.appendEvent(trade.trade_id, 'recovery_claim', { tx_sig: sig, payment_hash_hex: hash });
        return { type: 'recovered_claimed', trade_id: trade.trade_id, payment_hash_hex: hash, tx_sig: sig, escrow_pda: build.escrowPda.toBase58(), vault_ata: build.vault.toBase58() };
      }

      if (toolName === 'intercomswap_swaprecover_refund') {
        assertAllowedKeys(args, toolName, ['trade_id', 'payment_hash_hex']);
        requireApproval(toolName, autoApprove);
        const tradeId = expectOptionalString(args, toolName, 'trade_id', { min: 1, max: 128 });
        const paymentHashHex = expectOptionalString(args, toolName, 'payment_hash_hex', { min: 64, max: 64, pattern: /^[0-9a-fA-F]{64}$/ });
        const trade = pickTrade({ tradeId, paymentHashHex: paymentHashHex ? normalizeHex32(paymentHashHex, 'payment_hash_hex') : null });

        const hash = normalizeHex32(String(trade.ln_payment_hash_hex || ''), 'ln_payment_hash_hex');
        const mintStr = String(trade.sol_mint || '').trim();
        const programStr = String(trade.sol_program_id || '').trim();
        if (!mintStr) throw new Error('Trade missing sol_mint (cannot refund)');
        if (!programStr) throw new Error('Trade missing sol_program_id (cannot refund)');

        const signer = this._requireSolanaSigner();
        const signerPk = signer.publicKey.toBase58();
        if (String(trade.sol_refund || '').trim() && String(trade.sol_refund).trim() !== signerPk) {
          throw new Error(`Signer mismatch (need sol_refund=${trade.sol_refund})`);
        }

        if (dryRun) return { type: 'dry_run', tool: toolName, trade_id: trade.trade_id, payment_hash_hex: hash };

        const mint = new PublicKey(mintStr);
        const programId = new PublicKey(programStr);
        const commitment = this._commitment();
        const { computeUnitLimit, computeUnitPriceMicroLamports } = this._computeBudget();

        const build = await this._pool().call(async (connection) => {
          const onchain = await getEscrowState(connection, hash, programId, commitment);
          if (!onchain) throw new Error('Escrow not found on chain');
          if (!onchain.refund.equals(signer.publicKey)) {
            throw new Error(`Refund mismatch (escrow.refund=${onchain.refund.toBase58()})`);
          }
          const refundAta = await getOrCreateAta(connection, signer, signer.publicKey, mint, commitment);
          return refundEscrowTx({
            connection,
            refund: signer,
            refundTokenAccount: refundAta,
            mint,
            paymentHashHex: hash,
            computeUnitLimit,
            computeUnitPriceMicroLamports,
            programId,
          });
        }, { label: 'swaprecover_refund_build' });

        const sig = await this._pool().call((connection) => sendAndConfirm(connection, build.tx, commitment), { label: 'swaprecover_refund_send' });

        store.upsertTrade(trade.trade_id, { state: 'refunded' });
        store.appendEvent(trade.trade_id, 'recovery_refund', { tx_sig: sig, payment_hash_hex: hash });
        return { type: 'recovered_refunded', trade_id: trade.trade_id, payment_hash_hex: hash, tx_sig: sig, escrow_pda: build.escrowPda.toBase58(), vault_ata: build.vault.toBase58() };
      }
      } finally {
        try {
          store.close();
        } catch (_e) {}
      }
    }

    throw new Error(`Unknown tool: ${toolName}`);
  }
}
