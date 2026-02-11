import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import net from 'node:net';

import b4a from 'b4a';
import PeerWallet from 'trac-wallet';
import DHT from 'hyperdht';

import { ScBridgeClient } from '../src/sc-bridge/client.js';
import { createUnsignedEnvelope, attachSignature, signUnsignedEnvelopeHex } from '../src/protocol/signedMessage.js';
import { createSignedWelcome, signPayloadHex, toB64Json } from '../src/sidechannel/capabilities.js';
import { KIND, PAIR, ASSET } from '../src/swap/constants.js';
import { hashUnsignedEnvelope } from '../src/swap/hash.js';
import { deriveIntercomswapAppHash } from '../src/swap/app.js';
import { LN_USDT_ESCROW_PROGRAM_ID } from '../src/solana/lnUsdtEscrowClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const APP_HASH = deriveIntercomswapAppHash({ solanaProgramId: LN_USDT_ESCROW_PROGRAM_ID.toBase58() });

async function retry(fn, { tries = 80, delayMs = 250, label = 'retry' } = {}) {
  let lastErr = null;
  for (let i = 0; i < tries; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(`${label} failed after ${tries} tries: ${lastErr?.message ?? String(lastErr)}`);
}

async function connectBridge(sc, label) {
  await retry(
    async () => {
      try {
        await sc.connect();
      } catch (err) {
        sc.close();
        throw err;
      }
    },
    { label, tries: 160, delayMs: 250 }
  );
}

async function mkdirp(dir) {
  await mkdir(dir, { recursive: true });
}

async function writePeerKeypair({ storesDir, storeName }) {
  const wallet = new PeerWallet();
  await wallet.ready;
  await wallet.generateKeyPair();
  const keyPairPath = path.join(storesDir, storeName, 'db', 'keypair.json');
  await mkdirp(path.dirname(keyPairPath));
  wallet.exportToFile(keyPairPath, b4a.alloc(0));
  return {
    keyPairPath,
    pubHex: b4a.toString(wallet.publicKey, 'hex'),
    secHex: b4a.toString(wallet.secretKey, 'hex'),
  };
}

function signEnvelope(unsignedEnvelope, keys) {
  const sigHex = signUnsignedEnvelopeHex(unsignedEnvelope, keys.secHex);
  return attachSignature(unsignedEnvelope, { signerPubKeyHex: keys.pubHex, sigHex });
}

async function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function pickFreePorts(n) {
  const out = new Set();
  while (out.size < n) out.add(await pickFreePort());
  return Array.from(out);
}

function spawnPeer(args, { label }) {
  const proc = spawn('pear', ['run', '.', ...args], {
    cwd: repoRoot,
    env: { ...process.env, COPYFILE_DISABLE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const append = (chunk) => {
    out += chunk;
    if (out.length > 20000) out = out.slice(-20000);
  };
  proc.stdout.on('data', (d) => append(String(d)));
  proc.stderr.on('data', (d) => append(String(d)));
  proc.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      // Surface in logs if a peer dies unexpectedly.
      // eslint-disable-next-line no-console
      console.error(`[e2e:${label}] peer exited code=${code}. tail:\n${out}`);
    }
  });
  return { proc, tail: () => out };
}

async function killProc(proc) {
  if (!proc) return;
  if (proc.exitCode !== null) return;
  try {
    proc.kill('SIGINT');
  } catch (_e) {}
  await Promise.race([
    new Promise((r) => proc.once('exit', r)),
    new Promise((r) => setTimeout(r, 5000)),
  ]);
  if (proc.exitCode !== null) return;
  try {
    proc.kill('SIGKILL');
  } catch (_e) {}
  await Promise.race([
    new Promise((r) => proc.once('exit', r)),
    new Promise((r) => setTimeout(r, 5000)),
  ]);
}

function spawnBot(args, { label }) {
  const proc = spawn('node', args, {
    cwd: repoRoot,
    env: { ...process.env, COPYFILE_DISABLE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  const appendOut = (chunk) => {
    out += chunk;
    if (out.length > 20000) out = out.slice(-20000);
  };
  const appendErr = (chunk) => {
    err += chunk;
    if (err.length > 20000) err = err.slice(-20000);
  };
  proc.stdout.on('data', (d) => appendOut(String(d)));
  proc.stderr.on('data', (d) => appendErr(String(d)));
  const wait = () =>
    new Promise((resolve, reject) => {
      proc.once('exit', (code) => {
        if (code === 0) resolve({ out, err });
        else reject(new Error(`[${label}] exit code=${code}. stderr tail:\n${err}\nstdout tail:\n${out}`));
      });
      proc.once('error', (e) => reject(e));
    });
  return { proc, wait, tail: () => ({ out, err }) };
}

function parseJsonLines(text) {
  const events = [];
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch (_e) {}
  }
  return events;
}

function ensureOk(res, label) {
  assert.ok(res && typeof res === 'object', `${label} failed (no response)`);
  if (res.type === 'error') throw new Error(`${label} failed: ${res.error}`);
  return res;
}

function stripSignature(envelope) {
  if (!envelope || typeof envelope !== 'object') return envelope;
  const { sig: _sig, signer: _signer, ...unsigned } = envelope;
  return unsigned;
}

function waitForSidechannel(sc, { channel, pred, timeoutMs = 10_000, label = 'waitForSidechannel' }) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${label} timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    const onMsg = (evt) => {
      try {
        if (!evt || evt.type !== 'sidechannel_message') return;
        if (channel && evt.channel !== channel) return;
        if (!pred || pred(evt.message, evt)) {
          cleanup();
          resolve(evt);
        }
      } catch (err) {
        cleanup();
        reject(err);
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      sc.off('sidechannel_message', onMsg);
    };

    sc.on('sidechannel_message', onMsg);
  });
}

async function expectNoSidechannel(sc, { channel, pred, durationMs = 1200, label = 'expectNoSidechannel' } = {}) {
  let seen = null;
  const onMsg = (evt) => {
    try {
      if (!evt || evt.type !== 'sidechannel_message') return;
      if (channel && evt.channel !== channel) return;
      if (!pred || pred(evt.message, evt)) {
        seen = evt;
      }
    } catch (_e) {}
  };
  sc.on('sidechannel_message', onMsg);
  try {
    await new Promise((r) => setTimeout(r, durationMs));
  } finally {
    sc.off('sidechannel_message', onMsg);
  }
  if (seen) throw new Error(`${label}: unexpectedly saw message kind=${seen?.message?.kind || 'unknown'}`);
}

test('e2e: RFQ maker/taker bots negotiate and join swap channel (sidechannel invites)', async (t) => {
  const runId = crypto.randomBytes(4).toString('hex');
  const rfqChannel = `btc-usdt-sol-rfq-${runId}`;

  // Local DHT bootstrapper for reliability (avoid public bootstrap nodes).
  const dhtPort = 30000 + crypto.randomInt(0, 10000);
  const dht = DHT.bootstrapper(dhtPort, '127.0.0.1');
  await dht.ready();
  const dhtBootstrap = `127.0.0.1:${dhtPort}`;
  t.after(async () => {
    try {
      await dht.destroy({ force: true });
    } catch (_e) {}
  });

  const storesDir = path.join(repoRoot, 'stores');
  const makerStore = `e2e-rfq-maker-${runId}`;
  const takerStore = `e2e-rfq-taker-${runId}`;

  const makerKeys = await writePeerKeypair({ storesDir, storeName: makerStore });
  const takerKeys = await writePeerKeypair({ storesDir, storeName: takerStore });

  const signMakerHex = (payload) => signPayloadHex(payload, makerKeys.secHex);
  const rfqWelcome = createSignedWelcome(
    { channel: rfqChannel, ownerPubKey: makerKeys.pubHex, text: `rfq ${runId}` },
    signMakerHex
  );
  const rfqWelcomeB64 = toB64Json(rfqWelcome);

  const makerToken = `token-maker-${runId}`;
  const takerToken = `token-taker-${runId}`;
  const [makerPort, takerPort] = await pickFreePorts(2);

  // Always close client resources, even if the connectivity barrier fails.
  let makerSc = null;
  let takerSc = null;
  t.after(() => {
    try {
      makerSc?.close?.();
    } catch (_e) {}
    try {
      takerSc?.close?.();
    } catch (_e) {}
  });

  const makerPeer = spawnPeer(
    [
      '--peer-store-name',
      makerStore,
      '--subnet-channel',
      `e2e-rfq-subnet-${runId}`,
      '--msb',
      '0',
      '--price-oracle',
      '1',
      '--price-providers',
      'static',
      '--price-static-btc-usdt',
      '200000',
      '--price-static-usdt-usd',
      '1',
      '--price-static-count',
      '5',
      '--price-poll-ms',
      '200',
      '--dht-bootstrap',
      dhtBootstrap,
      '--sc-bridge',
      '1',
      '--sc-bridge-token',
      makerToken,
      '--sc-bridge-port',
      String(makerPort),
      '--sidechannels',
      rfqChannel,
      '--sidechannel-pow',
      '0',
      '--sidechannel-invite-required',
      '1',
      '--sidechannel-invite-prefixes',
      'swap:',
      '--sidechannel-inviter-keys',
      makerKeys.pubHex,
      '--sidechannel-owner',
      `${rfqChannel}:${makerKeys.pubHex}`,
      '--sidechannel-default-owner',
      makerKeys.pubHex,
      '--sidechannel-welcome',
      `${rfqChannel}:b64:${rfqWelcomeB64}`,
    ],
    { label: 'maker' }
  );

  const takerPeer = spawnPeer(
    [
      '--peer-store-name',
      takerStore,
      '--subnet-channel',
      `e2e-rfq-subnet-${runId}`,
      '--msb',
      '0',
      '--price-oracle',
      '1',
      '--price-providers',
      'static',
      '--price-static-btc-usdt',
      '200000',
      '--price-static-usdt-usd',
      '1',
      '--price-static-count',
      '5',
      '--price-poll-ms',
      '200',
      '--dht-bootstrap',
      dhtBootstrap,
      '--sc-bridge',
      '1',
      '--sc-bridge-token',
      takerToken,
      '--sc-bridge-port',
      String(takerPort),
      '--sidechannels',
      rfqChannel,
      '--sidechannel-pow',
      '0',
      '--sidechannel-invite-required',
      '1',
      '--sidechannel-invite-prefixes',
      'swap:',
      '--sidechannel-inviter-keys',
      makerKeys.pubHex,
      '--sidechannel-owner',
      `${rfqChannel}:${makerKeys.pubHex}`,
      '--sidechannel-default-owner',
      makerKeys.pubHex,
      '--sidechannel-welcome',
      `${rfqChannel}:b64:${rfqWelcomeB64}`,
    ],
    { label: 'taker' }
  );

  t.after(async () => {
    await killProc(takerPeer.proc);
    await killProc(makerPeer.proc);
  });

  // Wait until both SC-Bridge servers are reachable.
  makerSc = new ScBridgeClient({ url: `ws://127.0.0.1:${makerPort}`, token: makerToken });
  takerSc = new ScBridgeClient({ url: `ws://127.0.0.1:${takerPort}`, token: takerToken });
  await connectBridge(makerSc, 'maker sc-bridge');
  await connectBridge(takerSc, 'taker sc-bridge');

  // Ensure sidechannels have passed the DHT bootstrap barrier and joined topics.
  await retry(async () => {
    const s = await makerSc.stats();
    if (s.type !== 'stats' || s.sidechannelStarted !== true) throw new Error('maker sidechannel not started');
  }, { label: 'maker sidechannel started', tries: 400, delayMs: 250 });
  await retry(async () => {
    const s = await takerSc.stats();
    if (s.type !== 'stats' || s.sidechannelStarted !== true) throw new Error('taker sidechannel not started');
  }, { label: 'taker sidechannel started', tries: 400, delayMs: 250 });

  // Connectivity barrier: ensure peers can exchange messages in the RFQ channel before starting bots.
  ensureOk(await makerSc.join(rfqChannel), `join ${rfqChannel} (maker)`);
  ensureOk(await takerSc.join(rfqChannel), `join ${rfqChannel} (taker)`);
  ensureOk(await makerSc.subscribe([rfqChannel]), `subscribe ${rfqChannel} (maker)`);
  ensureOk(await takerSc.subscribe([rfqChannel]), `subscribe ${rfqChannel} (taker)`);

  // Under full-suite load, discovery/connect can lag even with local DHT. Wait for at least one
  // sidechannel connection on both peers before running the bidirectional preflight exchange.
  await retry(async () => {
    const s = await makerSc.stats();
    const n = typeof s?.connectionCount === 'number' ? s.connectionCount : 0;
    if (n < 1) throw new Error('maker has no sidechannel connections yet');
  }, { label: 'maker sidechannel connected', tries: 800, delayMs: 250 });
  await retry(async () => {
    const s = await takerSc.stats();
    const n = typeof s?.connectionCount === 'number' ? s.connectionCount : 0;
    if (n < 1) throw new Error('taker has no sidechannel connections yet');
  }, { label: 'taker sidechannel connected', tries: 800, delayMs: 250 });
  // SC messages are not buffered; if peers haven't connected yet, a one-shot ping can be dropped.
  // Resend periodically until we see it on the other side.
  ensureOk(await makerSc.send(rfqChannel, { type: 'e2e_ping', from: 'maker', runId }), 'send ping maker->taker');
  let pingStop = false;
  const pingResender = setInterval(async () => {
    if (pingStop) return;
    try {
      await makerSc.join(rfqChannel);
      await makerSc.subscribe([rfqChannel]);
      await makerSc.send(rfqChannel, { type: 'e2e_ping', from: 'maker', runId });
    } catch (_e) {}
  }, 500);
  t.after(() => clearInterval(pingResender));
  await waitForSidechannel(takerSc, {
    channel: rfqChannel,
    pred: (m) => m?.type === 'e2e_ping' && m?.from === 'maker' && m?.runId === runId,
    timeoutMs: 180_000,
    label: 'ping maker->taker',
  });
  pingStop = true;
  clearInterval(pingResender);

  ensureOk(await takerSc.send(rfqChannel, { type: 'e2e_ping', from: 'taker', runId }), 'send ping taker->maker');
  let ping2Stop = false;
  const ping2Resender = setInterval(async () => {
    if (ping2Stop) return;
    try {
      await takerSc.join(rfqChannel);
      await takerSc.subscribe([rfqChannel]);
      await takerSc.send(rfqChannel, { type: 'e2e_ping', from: 'taker', runId });
    } catch (_e) {}
  }, 500);
  t.after(() => clearInterval(ping2Resender));
  await waitForSidechannel(makerSc, {
    channel: rfqChannel,
    pred: (m) => m?.type === 'e2e_ping' && m?.from === 'taker' && m?.runId === runId,
    timeoutMs: 180_000,
    label: 'ping taker->maker',
  });
  ping2Stop = true;
  clearInterval(ping2Resender);

  makerSc.close();
  takerSc.close();

  const makerBot = spawnBot(
    [
      'scripts/rfq-maker.mjs',
      '--url',
      `ws://127.0.0.1:${makerPort}`,
      '--token',
      makerToken,
      '--peer-keypair',
      makerKeys.keyPairPath,
      '--rfq-channel',
      rfqChannel,
      '--once',
      '1',
    ],
    { label: 'maker-bot' }
  );

  const takerBot = spawnBot(
    [
      'scripts/rfq-taker.mjs',
      '--url',
      `ws://127.0.0.1:${takerPort}`,
      '--token',
      takerToken,
      '--peer-keypair',
      takerKeys.keyPairPath,
      '--rfq-channel',
      rfqChannel,
      '--once',
      '1',
      '--timeout-sec',
      '30',
    ],
    { label: 'taker-bot' }
  );

  // If the test fails before bots exit, ensure they don't keep the event loop alive.
  t.after(async () => {
    await killProc(takerBot?.proc);
    await killProc(makerBot?.proc);
  });

  const [makerRes, takerRes] = await Promise.all([makerBot.wait(), takerBot.wait()]);

  const makerEvents = parseJsonLines(makerRes.out);
  const takerEvents = parseJsonLines(takerRes.out);

  const inviteSent = makerEvents.find((e) => e?.type === 'swap_invite_sent');
  assert.ok(inviteSent, `maker bot did not emit swap_invite_sent. stdout tail:\n${makerRes.out}\nstderr tail:\n${makerRes.err}`);

  const joined = takerEvents.find((e) => e?.type === 'swap_joined');
  assert.ok(joined, `taker bot did not emit swap_joined. stdout tail:\n${takerRes.out}\nstderr tail:\n${takerRes.err}`);

  const swapChannel = String(joined.swap_channel || '').trim();
  assert.ok(swapChannel.startsWith('swap:'), 'swap_channel should be swap:*');

  // Once-mode bots should not leave ephemeral swap:* channels behind on the long-running peer.
  const takerSc2 = new ScBridgeClient({ url: `ws://127.0.0.1:${takerPort}`, token: takerToken });
  await connectBridge(takerSc2, 'taker sc-bridge (post)');
  await retry(async () => {
    const stats = await takerSc2.stats();
    assert.equal(stats.type, 'stats');
    assert.ok(Array.isArray(stats.channels));
    assert.ok(stats.channels.includes(rfqChannel), 'RFQ channel should remain joined');
    if (stats.channels.includes(swapChannel)) {
      throw new Error(`still joined swap channel: ${swapChannel}`);
    }
  }, { label: 'taker left swap channel', tries: 80, delayMs: 250 });
  takerSc2.close();
});

test('e2e: taker listens to maker Offers (svc_announce) and posts RFQ (Offer -> RFQ -> invite)', async (t) => {
  const runId = crypto.randomBytes(4).toString('hex');
  const rfqChannel = `btc-usdt-sol-rfq-offer-${runId}`;

  // Local DHT bootstrapper for reliability (avoid public bootstrap nodes).
  const dhtPort = 30000 + crypto.randomInt(0, 10000);
  const dht = DHT.bootstrapper(dhtPort, '127.0.0.1');
  await dht.ready();
  const dhtBootstrap = `127.0.0.1:${dhtPort}`;
  t.after(async () => {
    try {
      await dht.destroy({ force: true });
    } catch (_e) {}
  });

  const storesDir = path.join(repoRoot, 'stores');
  const makerStore = `e2e-offer-maker-${runId}`;
  const takerStore = `e2e-offer-taker-${runId}`;

  const makerKeys = await writePeerKeypair({ storesDir, storeName: makerStore });
  const takerKeys = await writePeerKeypair({ storesDir, storeName: takerStore });

  const makerToken = `token-maker-offer-${runId}`;
  const takerToken = `token-taker-offer-${runId}`;
  const [makerPort, takerPort] = await pickFreePorts(2);

  const makerPeer = spawnPeer(
    [
      '--peer-store-name',
      makerStore,
      '--subnet-channel',
      `e2e-offer-subnet-${runId}`,
      '--msb',
      '0',
      '--price-oracle',
      '1',
      '--price-providers',
      'static',
      '--price-static-btc-usdt',
      '200000',
      '--price-static-usdt-usd',
      '1',
      '--price-static-count',
      '5',
      '--price-poll-ms',
      '200',
      '--dht-bootstrap',
      dhtBootstrap,
      '--sc-bridge',
      '1',
      '--sc-bridge-token',
      makerToken,
      '--sc-bridge-port',
      String(makerPort),
      '--sidechannel-pow',
      '0',
      '--sidechannel-welcome-required',
      '0',
    ],
    { label: 'maker-offer' }
  );

  const takerPeer = spawnPeer(
    [
      '--peer-store-name',
      takerStore,
      '--subnet-channel',
      `e2e-offer-subnet-${runId}`,
      '--msb',
      '0',
      '--price-oracle',
      '1',
      '--price-providers',
      'static',
      '--price-static-btc-usdt',
      '200000',
      '--price-static-usdt-usd',
      '1',
      '--price-static-count',
      '5',
      '--price-poll-ms',
      '200',
      '--dht-bootstrap',
      dhtBootstrap,
      '--sc-bridge',
      '1',
      '--sc-bridge-token',
      takerToken,
      '--sc-bridge-port',
      String(takerPort),
      '--sidechannel-pow',
      '0',
      '--sidechannel-welcome-required',
      '0',
    ],
    { label: 'taker-offer' }
  );

  t.after(async () => {
    await killProc(makerPeer.proc);
    await killProc(takerPeer.proc);
  });

  const makerSc = new ScBridgeClient({ url: `ws://127.0.0.1:${makerPort}`, token: makerToken });
  const takerSc = new ScBridgeClient({ url: `ws://127.0.0.1:${takerPort}`, token: takerToken });
  await connectBridge(makerSc, 'maker sc-bridge');
  await connectBridge(takerSc, 'taker sc-bridge');

  await retry(async () => {
    const s = await makerSc.stats();
    if (s.type !== 'stats' || s.sidechannelStarted !== true) throw new Error('maker sidechannel not started');
  }, { label: 'maker sidechannel started', tries: 400, delayMs: 250 });
  await retry(async () => {
    const s = await takerSc.stats();
    if (s.type !== 'stats' || s.sidechannelStarted !== true) throw new Error('taker sidechannel not started');
  }, { label: 'taker sidechannel started', tries: 400, delayMs: 250 });

  // Ensure both peers can exchange messages in the rendezvous before bots start.
  ensureOk(await makerSc.join(rfqChannel), `join ${rfqChannel} (maker)`);
  ensureOk(await takerSc.join(rfqChannel), `join ${rfqChannel} (taker)`);
  ensureOk(await makerSc.subscribe([rfqChannel]), `subscribe ${rfqChannel} (maker)`);
  ensureOk(await takerSc.subscribe([rfqChannel]), `subscribe ${rfqChannel} (taker)`);
  await retry(async () => {
    const s = await makerSc.stats();
    const n = typeof s?.connectionCount === 'number' ? s.connectionCount : 0;
    if (n < 1) throw new Error('maker has no sidechannel connections yet (hijack)');
  }, { label: 'maker sidechannel connected (hijack)', tries: 800, delayMs: 250 });
  await retry(async () => {
    const s = await takerSc.stats();
    const n = typeof s?.connectionCount === 'number' ? s.connectionCount : 0;
    if (n < 1) throw new Error('taker has no sidechannel connections yet (hijack)');
  }, { label: 'taker sidechannel connected (hijack)', tries: 800, delayMs: 250 });

  // Sidechannels are unbuffered: establish bidirectional connectivity before we rely on bots.
  // This avoids flakes where the initial topic announce/lookup is missed and discovery takes longer.
  {
    const preflightA = { type: 'preflight', run_id: runId, who: 'maker' };
    const preflightB = { type: 'preflight', run_id: runId, who: 'taker' };

    const waitA = waitForSidechannel(takerSc, {
      channel: rfqChannel,
      pred: (m) => m?.type === 'preflight' && String(m?.run_id || '') === runId && String(m?.who || '') === 'maker',
      timeoutMs: 45_000,
      label: 'preflight maker->taker',
    });
    ensureOk(await makerSc.send(rfqChannel, preflightA), 'send preflight maker->taker (initial)');
    let stopA = false;
    const resendA = setInterval(async () => {
      if (stopA) return;
      try {
        // Under full-suite CPU/IO load discovery can lag; reassert channel join+sub and then resend.
        await makerSc.join(rfqChannel);
        await makerSc.subscribe([rfqChannel]);
        await makerSc.send(rfqChannel, preflightA);
      } catch (_e) {}
    }, 1000);
    t.after(() => clearInterval(resendA));
    try {
      await waitA;
    } catch (_e) {
      // Best-effort only. Offer/RFQ flow below has its own retries and is the real assertion.
    }
    stopA = true;
    clearInterval(resendA);

    const waitB = waitForSidechannel(makerSc, {
      channel: rfqChannel,
      pred: (m) => m?.type === 'preflight' && String(m?.run_id || '') === runId && String(m?.who || '') === 'taker',
      timeoutMs: 45_000,
      label: 'preflight taker->maker',
    });
    ensureOk(await takerSc.send(rfqChannel, preflightB), 'send preflight taker->maker (initial)');
    let stopB = false;
    const resendB = setInterval(async () => {
      if (stopB) return;
      try {
        await takerSc.join(rfqChannel);
        await takerSc.subscribe([rfqChannel]);
        await takerSc.send(rfqChannel, preflightB);
      } catch (_e) {}
    }, 1000);
    t.after(() => clearInterval(resendB));
    try {
      await waitB;
    } catch (_e) {
      // Best-effort only. Offer/RFQ flow below has its own retries and is the real assertion.
    }
    stopB = true;
    clearInterval(resendB);
  }

  // Start bots.
  const makerBot = spawnBot(
    [
      'scripts/rfq-maker.mjs',
      '--url',
      `ws://127.0.0.1:${makerPort}`,
      '--token',
      makerToken,
      '--peer-keypair',
      makerKeys.keyPairPath,
      '--rfq-channel',
      rfqChannel,
      '--once',
      '1',
    ],
    { label: 'maker-bot-offer' }
  );

  const takerBot = spawnBot(
    [
      'scripts/rfq-taker.mjs',
      '--url',
      `ws://127.0.0.1:${takerPort}`,
      '--token',
      takerToken,
      '--peer-keypair',
      takerKeys.keyPairPath,
      '--rfq-channel',
      rfqChannel,
      '--listen-offers',
      '1',
      '--offer-channel',
      rfqChannel,
      '--once',
      '1',
      '--timeout-sec',
      '40',
    ],
    { label: 'taker-bot-offer' }
  );

  t.after(async () => {
    await killProc(takerBot?.proc);
    await killProc(makerBot?.proc);
    try {
      makerSc.close();
      takerSc.close();
    } catch (_e) {}
  });

  // Broadcast an actionable Offer repeatedly until the taker posts an RFQ (sidechannel is unbuffered).
  const nowSec = Math.floor(Date.now() / 1000);
  const offerUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.SVC_ANNOUNCE,
    tradeId: `svc_offer_${runId}`,
    body: {
      name: `maker-offer-${runId}`,
      pairs: [PAIR.BTC_LN__USDT_SOL],
      rfq_channels: [rfqChannel],
      app_hash: APP_HASH,
      offers: [
        {
          pair: PAIR.BTC_LN__USDT_SOL,
          have: ASSET.USDT_SOL,
          want: ASSET.BTC_LN,
          app_hash: APP_HASH,
          btc_sats: 50000,
          usdt_amount: '100000000',
          max_platform_fee_bps: 500,
          max_trade_fee_bps: 1000,
          max_total_fee_bps: 1500,
          min_sol_refund_window_sec: 72 * 3600,
          max_sol_refund_window_sec: 7 * 24 * 3600,
        },
      ],
      valid_until_unix: nowSec + 60,
    },
    ts: Date.now(),
    nonce: `offer-${runId}`,
  });
  const offerSigned = signEnvelope(offerUnsigned, makerKeys);

  ensureOk(await makerSc.send(rfqChannel, offerSigned), 'send offer (initial)');
  let offerStop = false;
  const offerResender = setInterval(async () => {
    if (offerStop) return;
    try {
      await makerSc.send(rfqChannel, offerSigned);
    } catch (_e) {}
  }, 250);
  t.after(() => clearInterval(offerResender));

	  await waitForSidechannel(makerSc, {
	    channel: rfqChannel,
	    pred: (m) => m?.kind === KIND.RFQ,
	    // Under CPU+IO load (full e2e suite) offer->rfq can take longer even with local DHT bootstrap.
	    timeoutMs: 60_000,
	    label: 'wait for RFQ response to offer',
	  });
  offerStop = true;
  clearInterval(offerResender);

  const [makerRes, takerRes] = await Promise.all([makerBot.wait(), takerBot.wait()]);
  const makerEvents = parseJsonLines(makerRes.out);
  const takerEvents = parseJsonLines(takerRes.out);

  assert.ok(
    takerEvents.find((e) => e?.type === 'offer_matched'),
    `taker bot did not emit offer_matched. stdout tail:\n${takerRes.out}\nstderr tail:\n${takerRes.err}`
  );
  assert.ok(
    makerEvents.find((e) => e?.type === 'swap_invite_sent'),
    `maker bot did not emit swap_invite_sent. stdout tail:\n${makerRes.out}\nstderr tail:\n${makerRes.err}`
  );
  assert.ok(
    takerEvents.find((e) => e?.type === 'swap_joined'),
    `taker bot did not emit swap_joined. stdout tail:\n${takerRes.out}\nstderr tail:\n${takerRes.err}`
  );
});

test('e2e: maker rejects quote_accept from non-RFQ signer (prevents quote hijack)', async (t) => {
  const runId = crypto.randomBytes(4).toString('hex');
  const rfqChannel = `btc-usdt-sol-rfq-hijack-${runId}`;

  // Local DHT bootstrapper for reliability (avoid public bootstrap nodes).
  const dhtPort = 30000 + crypto.randomInt(0, 10000);
  const dht = DHT.bootstrapper(dhtPort, '127.0.0.1');
  await dht.ready();
  const dhtBootstrap = `127.0.0.1:${dhtPort}`;
  t.after(async () => {
    try {
      await dht.destroy({ force: true });
    } catch (_e) {}
  });

  const storesDir = path.join(repoRoot, 'stores');
  const makerStore = `e2e-rfq-maker-hijack-${runId}`;
  const takerStore = `e2e-rfq-taker-hijack-${runId}`;
  const attackerStore = `e2e-rfq-attacker-hijack-${runId}`;

  const makerKeys = await writePeerKeypair({ storesDir, storeName: makerStore });
  const takerKeys = await writePeerKeypair({ storesDir, storeName: takerStore });
  const attackerKeys = await writePeerKeypair({ storesDir, storeName: attackerStore });

  const signMakerHex = (payload) => signPayloadHex(payload, makerKeys.secHex);
  const rfqWelcome = createSignedWelcome(
    { channel: rfqChannel, ownerPubKey: makerKeys.pubHex, text: `rfq ${runId}` },
    signMakerHex
  );
  const rfqWelcomeB64 = toB64Json(rfqWelcome);

  const makerToken = `token-maker-hijack-${runId}`;
  const takerToken = `token-taker-hijack-${runId}`;
  const attackerToken = `token-attacker-hijack-${runId}`;
  const [makerPort, takerPort, attackerPort] = await pickFreePorts(3);

  const makerPeer = spawnPeer(
    [
      '--peer-store-name',
      makerStore,
      '--subnet-channel',
      `e2e-rfq-hijack-subnet-${runId}`,
      '--msb',
      '0',
      '--price-oracle',
      '1',
      '--price-providers',
      'static',
      '--price-static-btc-usdt',
      '200000',
      '--price-static-usdt-usd',
      '1',
      '--price-static-count',
      '5',
      '--price-poll-ms',
      '200',
      '--dht-bootstrap',
      dhtBootstrap,
      '--sc-bridge',
      '1',
      '--sc-bridge-token',
      makerToken,
      '--sc-bridge-port',
      String(makerPort),
      '--sidechannels',
      rfqChannel,
      '--sidechannel-pow',
      '0',
      '--sidechannel-invite-required',
      '1',
      '--sidechannel-invite-prefixes',
      'swap:',
      '--sidechannel-inviter-keys',
      makerKeys.pubHex,
      '--sidechannel-owner',
      `${rfqChannel}:${makerKeys.pubHex}`,
      '--sidechannel-default-owner',
      makerKeys.pubHex,
      '--sidechannel-welcome',
      `${rfqChannel}:b64:${rfqWelcomeB64}`,
    ],
    { label: 'maker-hijack' }
  );

  const takerPeer = spawnPeer(
    [
      '--peer-store-name',
      takerStore,
      '--subnet-channel',
      `e2e-rfq-hijack-subnet-${runId}`,
      '--msb',
      '0',
      '--price-oracle',
      '1',
      '--price-providers',
      'static',
      '--price-static-btc-usdt',
      '200000',
      '--price-static-usdt-usd',
      '1',
      '--price-static-count',
      '5',
      '--price-poll-ms',
      '200',
      '--dht-bootstrap',
      dhtBootstrap,
      '--sc-bridge',
      '1',
      '--sc-bridge-token',
      takerToken,
      '--sc-bridge-port',
      String(takerPort),
      '--sidechannels',
      rfqChannel,
      '--sidechannel-pow',
      '0',
      '--sidechannel-invite-required',
      '1',
      '--sidechannel-invite-prefixes',
      'swap:',
      '--sidechannel-inviter-keys',
      makerKeys.pubHex,
      '--sidechannel-owner',
      `${rfqChannel}:${makerKeys.pubHex}`,
      '--sidechannel-default-owner',
      makerKeys.pubHex,
      '--sidechannel-welcome',
      `${rfqChannel}:b64:${rfqWelcomeB64}`,
    ],
    { label: 'taker-hijack' }
  );

  const attackerPeer = spawnPeer(
    [
      '--peer-store-name',
      attackerStore,
      '--subnet-channel',
      `e2e-rfq-hijack-subnet-${runId}`,
      '--msb',
      '0',
      '--price-oracle',
      '1',
      '--price-providers',
      'static',
      '--price-static-btc-usdt',
      '200000',
      '--price-static-usdt-usd',
      '1',
      '--price-static-count',
      '5',
      '--price-poll-ms',
      '200',
      '--dht-bootstrap',
      dhtBootstrap,
      '--sc-bridge',
      '1',
      '--sc-bridge-token',
      attackerToken,
      '--sc-bridge-port',
      String(attackerPort),
      '--sidechannels',
      rfqChannel,
      '--sidechannel-pow',
      '0',
      '--sidechannel-invite-required',
      '1',
      '--sidechannel-invite-prefixes',
      'swap:',
      '--sidechannel-inviter-keys',
      makerKeys.pubHex,
      '--sidechannel-owner',
      `${rfqChannel}:${makerKeys.pubHex}`,
      '--sidechannel-default-owner',
      makerKeys.pubHex,
      '--sidechannel-welcome',
      `${rfqChannel}:b64:${rfqWelcomeB64}`,
    ],
    { label: 'attacker-hijack' }
  );

  t.after(async () => {
    await killProc(attackerPeer.proc);
    await killProc(takerPeer.proc);
    await killProc(makerPeer.proc);
  });

  // Wait until all SC-Bridge servers are reachable.
  const makerSc = new ScBridgeClient({ url: `ws://127.0.0.1:${makerPort}`, token: makerToken });
  const takerSc = new ScBridgeClient({ url: `ws://127.0.0.1:${takerPort}`, token: takerToken });
  const attackerSc = new ScBridgeClient({ url: `ws://127.0.0.1:${attackerPort}`, token: attackerToken });
  await connectBridge(makerSc, 'maker sc-bridge (hijack)');
  await connectBridge(takerSc, 'taker sc-bridge (hijack)');
  await connectBridge(attackerSc, 'attacker sc-bridge (hijack)');
  t.after(async () => {
    makerSc.close();
    takerSc.close();
    attackerSc.close();
  });

  // Ensure sidechannels have passed the DHT bootstrap barrier and joined topics.
  await retry(async () => {
    const s = await makerSc.stats();
    if (s.type !== 'stats' || s.sidechannelStarted !== true) throw new Error('maker sidechannel not started');
  }, { label: 'maker sidechannel started (hijack)', tries: 400, delayMs: 250 });
  await retry(async () => {
    const s = await takerSc.stats();
    if (s.type !== 'stats' || s.sidechannelStarted !== true) throw new Error('taker sidechannel not started');
  }, { label: 'taker sidechannel started (hijack)', tries: 400, delayMs: 250 });
  await retry(async () => {
    const s = await attackerSc.stats();
    if (s.type !== 'stats' || s.sidechannelStarted !== true) throw new Error('attacker sidechannel not started');
  }, { label: 'attacker sidechannel started (hijack)', tries: 400, delayMs: 250 });

  // Connectivity barrier: ensure maker/taker can exchange messages before driving the hijack scenario.
  ensureOk(await makerSc.join(rfqChannel), `join ${rfqChannel} (maker)`);
  ensureOk(await takerSc.join(rfqChannel), `join ${rfqChannel} (taker)`);
  ensureOk(await makerSc.subscribe([rfqChannel]), `subscribe ${rfqChannel} (maker)`);
  ensureOk(await takerSc.subscribe([rfqChannel]), `subscribe ${rfqChannel} (taker)`);
  // SC messages are not buffered; if the peers haven't connected yet, a one-shot ping can be dropped.
  // Resend periodically until we see it on the other side.
  ensureOk(
    await makerSc.send(rfqChannel, { type: 'e2e_ping', from: 'maker', runId }),
    'send ping maker->taker (hijack initial)'
  );
  let pingStop = false;
  const pingResender = setInterval(async () => {
    if (pingStop) return;
    try {
      await makerSc.join(rfqChannel);
      await makerSc.subscribe([rfqChannel]);
      await makerSc.send(rfqChannel, { type: 'e2e_ping', from: 'maker', runId });
    } catch (_e) {}
  }, 500);
  t.after(() => clearInterval(pingResender));
  await waitForSidechannel(takerSc, {
    channel: rfqChannel,
    pred: (m) => m?.type === 'e2e_ping' && m?.from === 'maker' && m?.runId === runId,
    timeoutMs: 60_000,
    label: 'ping maker->taker (hijack)',
  });
  pingStop = true;
  clearInterval(pingResender);

  ensureOk(await takerSc.join(rfqChannel), `join ${rfqChannel} (taker)`);
  ensureOk(await attackerSc.join(rfqChannel), `join ${rfqChannel} (attacker)`);
  ensureOk(await takerSc.subscribe([rfqChannel]), `subscribe ${rfqChannel} (taker)`);

  const makerBot = spawnBot(
    [
      'scripts/rfq-maker.mjs',
      '--url',
      `ws://127.0.0.1:${makerPort}`,
      '--token',
      makerToken,
      '--peer-keypair',
      makerKeys.keyPairPath,
      '--rfq-channel',
      rfqChannel,
      '--price-guard',
      '0',
      '--once',
      '1',
    ],
    { label: 'maker-bot-hijack' }
  );

  // If the test fails mid-way, ensure the once-mode maker-bot doesn't keep the event loop alive.
  t.after(async () => {
    await killProc(makerBot?.proc);
  });

  // Ensure maker-bot is fully connected/subscribed before we expect QUOTE responses.
  await retry(
    async () => {
      if (makerBot.proc.exitCode !== null) {
        const tail = makerBot.tail();
        throw new Error(`maker-bot exited early. stdout tail:\n${tail.out}\nstderr tail:\n${tail.err}`);
      }
      const tail = makerBot.tail();
      if (!String(tail.out || '').includes('"type":"ready"')) throw new Error('not_ready');
    },
    { label: 'maker-bot ready', tries: 160, delayMs: 250 }
  );

  const tradeId = `swap_${crypto.randomUUID()}`;
  const nowSec = Math.floor(Date.now() / 1000);
  const rfqUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.RFQ,
    tradeId,
    body: {
      rfq_channel: rfqChannel,
      pair: PAIR.BTC_LN__USDT_SOL,
      direction: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
      app_hash: APP_HASH,
      btc_sats: 10000,
      usdt_amount: '1234567',
      // Fee ceilings + refund window are pre-filtering inputs for the maker.
      max_platform_fee_bps: 500,
      max_trade_fee_bps: 1000,
      max_total_fee_bps: 1500,
      min_sol_refund_window_sec: 72 * 3600,
      max_sol_refund_window_sec: 7 * 24 * 3600,
      valid_until_unix: nowSec + 60,
    },
  });
  const rfqSigned = signEnvelope(rfqUnsigned, takerKeys);

  // Make sure RFQ broadcast is allowed (avoids silent send-denied loops).
  ensureOk(await takerSc.send(rfqChannel, rfqSigned), 'send rfq (initial)');

  // Maker bot might not be subscribed yet; resend RFQ until we see a quote.
  let rfqStop = false;
  const rfqResender = setInterval(async () => {
    if (rfqStop) return;
    try {
      await takerSc.send(rfqChannel, rfqSigned);
    } catch (_e) {}
  }, 250);
  t.after(() => clearInterval(rfqResender));

  // Wait for maker quote, then attempt hijack accept from attacker.
  let quoteEvt;
  try {
    quoteEvt = await waitForSidechannel(takerSc, {
      channel: rfqChannel,
      pred: (m) => m?.kind === KIND.QUOTE && String(m.trade_id) === tradeId,
      timeoutMs: 10_000,
      label: 'wait quote',
    });
  } catch (err) {
    const tail = makerBot?.tail?.() || { out: '', err: '' };
    throw new Error(
      `${err?.message ?? String(err)}\nmaker-bot stdout tail:\n${tail.out}\nmaker-bot stderr tail:\n${tail.err}`
    );
  }
  rfqStop = true;
  clearInterval(rfqResender);
  const quote = quoteEvt.message;
  const quoteId = hashUnsignedEnvelope(stripSignature(quote));
  const rfqId = String(quote.body?.rfq_id || '').trim().toLowerCase();

  const attackerAcceptUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.QUOTE_ACCEPT,
    tradeId,
    body: { rfq_id: rfqId, quote_id: quoteId },
  });
  {
    const qa = signEnvelope(attackerAcceptUnsigned, attackerKeys);
    ensureOk(await attackerSc.send(rfqChannel, qa), 'send attacker quote_accept');
  }

  // Maker must ignore the hijack accept (no swap invite should be broadcast).
  await expectNoSidechannel(takerSc, {
    channel: rfqChannel,
    durationMs: 1500,
    pred: (m) => m?.kind === KIND.SWAP_INVITE && String(m.trade_id) === tradeId && String(m.body?.quote_id || '').trim().toLowerCase() === quoteId,
    label: 'no swap invite for attacker accept',
  });

  // Legit accept from the RFQ signer should succeed.
  const takerAcceptUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.QUOTE_ACCEPT,
    tradeId,
    body: { rfq_id: rfqId, quote_id: quoteId },
  });
  {
    const qa = signEnvelope(takerAcceptUnsigned, takerKeys);
    ensureOk(await takerSc.send(rfqChannel, qa), 'send taker quote_accept');
  }

  const inviteEvt = await waitForSidechannel(takerSc, {
    channel: rfqChannel,
    pred: (m) => m?.kind === KIND.SWAP_INVITE && String(m.trade_id) === tradeId,
    timeoutMs: 10_000,
    label: 'wait swap invite',
  });
  const invite = inviteEvt.message?.body?.invite;
  assert.ok(invite && invite.payload, 'swap invite should include invite payload');
  assert.equal(String(invite.payload.inviteePubKey || '').toLowerCase(), takerKeys.pubHex.toLowerCase());

  // Once-mode maker bot should exit successfully.
  await makerBot.wait();
});
