import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import net from 'node:net';

import DHT from 'hyperdht';
import b4a from 'b4a';
import PeerWallet from 'trac-wallet';

import { Connection, Keypair, PublicKey } from '@solana/web3.js';

import { LN_USDT_ESCROW_PROGRAM_ID } from '../src/solana/lnUsdtEscrowClient.js';
import { createSignedWelcome, signPayloadHex, toB64Json } from '../src/sidechannel/capabilities.js';

const execFileP = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const composeFile = path.join(repoRoot, 'dev/ln-regtest/docker-compose.yml');

async function sh(cmd, args, opts = {}) {
  const { stdout, stderr } = await execFileP(cmd, args, {
    cwd: repoRoot,
    maxBuffer: 1024 * 1024 * 50,
    ...opts,
  });
  return { stdout: String(stdout || ''), stderr: String(stderr || '') };
}

async function dockerCompose(args) {
  return sh('docker', ['compose', '-f', composeFile, ...args]);
}

async function dockerComposeJson(args) {
  const { stdout } = await dockerCompose(args);
  const text = stdout.trim();
  try {
    return JSON.parse(text);
  } catch (_e) {
    throw new Error(`Failed to parse JSON: ${text.slice(0, 200)}`);
  }
}

async function retry(fn, { tries = 120, delayMs = 500, label = 'retry' } = {}) {
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

async function btcCli(args) {
  const { stdout } = await dockerCompose([
    'exec',
    '-T',
    'bitcoind',
    'bitcoin-cli',
    '-regtest',
    '-rpcuser=rpcuser',
    '-rpcpassword=rpcpass',
    '-rpcport=18443',
    ...args,
  ]);
  const text = stdout.trim();
  try {
    return JSON.parse(text);
  } catch (_e) {
    return { result: text };
  }
}

async function clnCli(service, args) {
  return dockerComposeJson(['exec', '-T', service, 'lightning-cli', '--network=regtest', ...args]);
}

function hasConfirmedUtxo(listFundsResult) {
  const outs = listFundsResult?.outputs;
  if (!Array.isArray(outs)) return false;
  return outs.some((o) => String(o?.status || '').toLowerCase() === 'confirmed');
}

function rowsFromLnListChannels(res) {
  if (res && Array.isArray(res.channels)) return res.channels;
  if (res && res.result && Array.isArray(res.result.channels)) return res.result.channels;
  return [];
}

function channelPeerId(row) {
  return String(
    row?.peer_id ||
      row?.peerId ||
      row?.remote_pubkey ||
      row?.remotePubkey ||
      row?.node_id ||
      row?.nodeId ||
      ''
  )
    .trim()
    .toLowerCase();
}

function isActiveChannel(row) {
  const st = String(row?.state || row?.status || '').trim().toUpperCase();
  if (st === 'CHANNELD_NORMAL' || st.includes('NORMAL')) return true;
  if (row?.active === true) return true;
  if (row?.is_active === true) return true;
  return false;
}

function channelCloseId(row) {
  const chId = String(row?.channel_id || row?.channelId || '').trim();
  if (chId) return chId;
  const shortId = String(row?.short_channel_id || row?.shortChannelId || '').trim();
  if (shortId) return shortId;
  const point = String(row?.channel_point || row?.channelPoint || '').trim();
  if (point) return point;
  const txid = String(row?.funding_txid || row?.fundingTxid || '').trim();
  const outnumRaw = row?.funding_outnum ?? row?.output_index ?? row?.outputIndex ?? null;
  const outnum = Number.parseInt(String(outnumRaw ?? ''), 10);
  if (txid && Number.isInteger(outnum) && outnum >= 0) return `${txid}:${outnum}`;
  return '';
}

async function startSolanaValidator({ soPath, ledgerSuffix }) {
  const rpcPort = await pickFreeRpcPortWithWs();
  const wsPort = rpcPort + 1;
  let faucetPort = await pickFreePort();
  for (let i = 0; i < 50; i += 1) {
    if (faucetPort !== rpcPort && faucetPort !== wsPort) break;
    faucetPort = await pickFreePort();
  }
  const ledgerPath = path.join(repoRoot, `onchain/solana/ledger-e2e-promptd-${ledgerSuffix}`);
  const args = [
    '--reset',
    '--ledger',
    ledgerPath,
    '--bind-address',
    '127.0.0.1',
    '--rpc-port',
    String(rpcPort),
    '--faucet-port',
    String(faucetPort),
    '--bpf-program',
    LN_USDT_ESCROW_PROGRAM_ID.toBase58(),
    soPath,
    '--quiet',
  ];

  const proc = spawn('solana-test-validator', args, {
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

  const rpcUrl = `http://127.0.0.1:${rpcPort}`;
  const wsUrl = `ws://127.0.0.1:${wsPort}`;
  const connection = new Connection(rpcUrl, { commitment: 'confirmed', wsEndpoint: wsUrl });
  await retry(() => connection.getVersion(), { label: 'solana rpc ready', tries: 180, delayMs: 500 });

  return {
    proc,
    connection,
    rpcUrl,
    rpcPort,
    wsUrl,
    wsPort,
    faucetPort,
    tail: () => out,
    stop: async () => {
      try {
        connection?._rpcWebSocket?.close?.();
      } catch (_e) {}
      proc.kill('SIGINT');
      await new Promise((r) => proc.once('exit', r));
    },
  };
}

async function writePeerKeypair({ storesDir, storeName }) {
  const wallet = new PeerWallet();
  await wallet.ready;
  await wallet.generateKeyPair();
  const keyPairPath = path.join(storesDir, storeName, 'db', 'keypair.json');
  fs.mkdirSync(path.dirname(keyPairPath), { recursive: true });
  wallet.exportToFile(keyPairPath, b4a.alloc(0));
  return {
    keyPairPath,
    pubHex: b4a.toString(wallet.publicKey, 'hex'),
    secHex: b4a.toString(wallet.secretKey, 'hex'),
  };
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

async function isTcpPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

async function pickFreeRpcPortWithWs() {
  // solana-test-validator uses rpc-port for HTTP and rpc-port+1 for PubSub websocket.
  for (let i = 0; i < 200; i += 1) {
    const rpcPort = await pickFreePort();
    if (!Number.isInteger(rpcPort) || rpcPort < 1024 || rpcPort >= 65535) continue;
    const wsPort = rpcPort + 1;
    if (wsPort >= 65535) continue;
    if (await isTcpPortFree(wsPort)) return rpcPort;
  }
  throw new Error('Failed to pick free Solana rpc port (and rpc+1 websocket port)');
}

function requestJson(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const data = JSON.stringify(body);
    const req = (isHttps ? https : http).request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(data),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (err) {
            reject(new Error(`Invalid JSON response: ${text.slice(0, 200)}`));
            return;
          }
          resolve({ status: res.statusCode || 0, json });
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function promptTool({ baseUrl, sessionId, autoApprove, name, args }) {
  const prompt = JSON.stringify({ type: 'tool', name, arguments: args || {} });
  const body = {
    prompt,
    session_id: sessionId,
    auto_approve: Boolean(autoApprove),
    dry_run: false,
    max_steps: 1,
  };
  const { status, json } = await requestJson(`${baseUrl}/v1/run`, body);
  if (status >= 400) throw new Error(json?.error || `HTTP ${status}`);
  return json?.content_json ?? null;
}

function spawnPromptd({ configPath, label }) {
  const proc = spawn('node', ['scripts/promptd.mjs', '--config', configPath], {
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
  proc.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      // eslint-disable-next-line no-console
      console.error(`[e2e:${label}] promptd exited code=${code}. stderr tail:\n${err}\nstdout tail:\n${out}`);
    }
  });

  const waitReady = async () => {
    const started = Date.now();
    while (Date.now() - started < 60_000) {
      // promptd logs a pretty-printed JSON object (multi-line). Don't try to parse line-by-line.
      const matches = Array.from(
        out.matchAll(
          /"type"\s*:\s*"promptd_listening"[\s\S]*?"host"\s*:\s*"([^"]+)"[\s\S]*?"port"\s*:\s*(\d+)/g
        )
      );
      if (matches.length > 0) {
        const m = matches[matches.length - 1];
        return { host: m[1], port: Number(m[2]) };
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`[${label}] promptd did not become ready. stderr tail:\n${err}\nstdout tail:\n${out}`);
  };

  return { proc, waitReady, tail: () => ({ out, err }) };
}

function writeSolanaKeypairJson(filePath, keypair) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(Array.from(keypair.secretKey)));
}

test('e2e: promptd direct-tool mode drives full swap (LN regtest <-> Solana escrow)', async (t) => {
  const runId = crypto.randomBytes(4).toString('hex');
  const rfqChannel = `e2e-promptd-rfq-${runId}`;
  const guardRfqChannel = `0000e2e-promptd-guard-${runId}`;
  const tradeId = `e2e-promptd-trade-${runId}`;
  const guardTradeId = `e2e-promptd-guard-trade-${runId}`;

  // Build the program once for the local validator.
  await sh('cargo', ['build-sbf'], { cwd: path.join(repoRoot, 'solana/ln_usdt_escrow') });
  const soPath = path.join(repoRoot, 'solana/ln_usdt_escrow/target/deploy/ln_usdt_escrow.so');

  // Start Solana local validator (clones Token + ATA from devnet, loads our program).
  const sol = await startSolanaValidator({ soPath, ledgerSuffix: runId });
  t.after(async () => {
    try {
      await sol.stop();
    } catch (_e) {}
  });

  // Start LN stack.
  // Ensure a clean slate: stale lightning-rpc sockets in the volume can cause ECONNREFUSED,
  // and fixed invoice labels can collide across runs if volumes are reused.
  try {
    await dockerCompose(['down', '-v', '--remove-orphans']);
  } catch (_e) {}
  await dockerCompose(['up', '-d']);
  t.after(async () => {
    try {
      await dockerCompose(['down', '-v', '--remove-orphans']);
    } catch (_e) {}
  });
  await retry(() => btcCli(['getblockchaininfo']), { label: 'bitcoind ready', tries: 180, delayMs: 500 });
  await retry(() => clnCli('cln-alice', ['getinfo']), { label: 'cln-alice ready', tries: 180, delayMs: 500 });
  await retry(() => clnCli('cln-bob', ['getinfo']), { label: 'cln-bob ready', tries: 180, delayMs: 500 });

  // Mine spendable coins.
  try {
    await btcCli(['createwallet', 'miner']);
  } catch (_e) {}
  const minerAddr = (await btcCli(['-rpcwallet=miner', 'getnewaddress'])).result;
  await btcCli(['-rpcwallet=miner', 'generatetoaddress', '101', minerAddr]);

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

  // Spawn two peers (maker + taker) with SC-Bridge enabled.
  const storesDir = path.join(repoRoot, 'stores');
  const makerStore = `e2e-promptd-maker-${runId}`;
  const takerStore = `e2e-promptd-taker-${runId}`;
  const makerKeys = await writePeerKeypair({ storesDir, storeName: makerStore });
  const takerKeys = await writePeerKeypair({ storesDir, storeName: takerStore });

  const signMakerHex = (payload) => signPayloadHex(payload, makerKeys.secHex);
  // Welcome is required by default for non-entry channels.
  const rfqWelcome = createSignedWelcome(
    { channel: rfqChannel, ownerPubKey: makerKeys.pubHex, text: `rfq ${runId}` },
    signMakerHex
  );
  const rfqWelcomeB64 = toB64Json(rfqWelcome);

  const makerTokenWs = `token-maker-${runId}`;
  const takerTokenWs = `token-taker-${runId}`;
  const [makerScPort, takerScPort] = await pickFreePorts(2);

  const makerPeer = spawnPeer(
    [
      '--peer-store-name',
      makerStore,
      '--msb-store-name',
      `${makerStore}-msb`,
      '--subnet-channel',
      `e2e-subnet-${runId}-m`,
      '--dht-bootstrap',
      dhtBootstrap,
      '--msb',
      '0',
      '--sc-bridge',
      '1',
      '--sc-bridge-token',
      makerTokenWs,
      '--sc-bridge-port',
      String(makerScPort),
      '--sidechannels',
      rfqChannel,
      '--sidechannel-owner',
      `${rfqChannel}:${makerKeys.pubHex}`,
      '--sidechannel-default-owner',
      makerKeys.pubHex,
      '--sidechannel-welcome',
      `${rfqChannel}:b64:${rfqWelcomeB64}`,
      '--sidechannel-pow',
      '0',
      '--sidechannel-invite-required',
      '1',
      '--sidechannel-invite-prefixes',
      'swap:',
      '--sidechannel-inviter-keys',
      makerKeys.pubHex,
    ],
    { label: 'peer-maker' }
  );
  const takerPeer = spawnPeer(
    [
      '--peer-store-name',
      takerStore,
      '--msb-store-name',
      `${takerStore}-msb`,
      '--subnet-channel',
      `e2e-subnet-${runId}-t`,
      '--dht-bootstrap',
      dhtBootstrap,
      '--msb',
      '0',
      '--sc-bridge',
      '1',
      '--sc-bridge-token',
      takerTokenWs,
      '--sc-bridge-port',
      String(takerScPort),
      '--sidechannels',
      rfqChannel,
      '--sidechannel-owner',
      `${rfqChannel}:${makerKeys.pubHex}`,
      '--sidechannel-default-owner',
      makerKeys.pubHex,
      '--sidechannel-pow',
      '0',
      '--sidechannel-invite-required',
      '1',
      '--sidechannel-invite-prefixes',
      'swap:',
      '--sidechannel-inviter-keys',
      makerKeys.pubHex,
    ],
    { label: 'peer-taker' }
  );
  t.after(async () => {
    await killProc(takerPeer.proc);
    await killProc(makerPeer.proc);
  });

  // Create local Solana keypairs for promptd (signers must be local).
  const makerSol = Keypair.generate();
  const takerSol = Keypair.generate();
  const makerSolPath = path.join(repoRoot, `onchain/solana/e2e-promptd/${runId}/maker.json`);
  const takerSolPath = path.join(repoRoot, `onchain/solana/e2e-promptd/${runId}/taker.json`);
  writeSolanaKeypairJson(makerSolPath, makerSol);
  writeSolanaKeypairJson(takerSolPath, takerSol);

  const makerReceipts = `onchain/receipts/e2e-promptd-${runId}-maker.sqlite`;
  const takerReceipts = `onchain/receipts/e2e-promptd-${runId}-taker.sqlite`;

  // Start promptd instances (maker + taker). LLM config is dummy for direct-tool mode.
  const [makerPromptdPort, takerPromptdPort] = await pickFreePorts(2);
  const makerCfg = path.join(repoRoot, `onchain/prompt/e2e-${runId}-maker.json`);
  const takerCfg = path.join(repoRoot, `onchain/prompt/e2e-${runId}-taker.json`);
  fs.mkdirSync(path.dirname(makerCfg), { recursive: true });
  fs.writeFileSync(
    makerCfg,
    JSON.stringify(
      {
        agent: { role: 'maker' },
        peer: { keypair: makerKeys.keyPairPath },
        llm: { base_url: 'http://127.0.0.1:1/v1', api_key: '', model: 'dummy', response_format: { type: 'json_object' } },
        server: { host: '127.0.0.1', port: makerPromptdPort, audit_dir: `onchain/prompt/audit-e2e-${runId}-maker`, auto_approve_default: false, max_steps: 12, max_repairs: 0 },
        sc_bridge: { url: `ws://127.0.0.1:${makerScPort}`, token: makerTokenWs },
        receipts: { db: makerReceipts },
        ln: { impl: 'cln', backend: 'docker', network: 'regtest', compose_file: 'dev/ln-regtest/docker-compose.yml', service: 'cln-alice' },
        solana: { rpc_url: sol.rpcUrl, commitment: 'confirmed', program_id: LN_USDT_ESCROW_PROGRAM_ID.toBase58(), keypair: makerSolPath },
      },
      null,
      2
    )
  );
  fs.writeFileSync(
    takerCfg,
    JSON.stringify(
      {
        agent: { role: 'taker' },
        peer: { keypair: takerKeys.keyPairPath },
        llm: { base_url: 'http://127.0.0.1:1/v1', api_key: '', model: 'dummy', response_format: { type: 'json_object' } },
        server: { host: '127.0.0.1', port: takerPromptdPort, audit_dir: `onchain/prompt/audit-e2e-${runId}-taker`, auto_approve_default: false, max_steps: 12, max_repairs: 0 },
        sc_bridge: { url: `ws://127.0.0.1:${takerScPort}`, token: takerTokenWs },
        receipts: { db: takerReceipts },
        ln: { impl: 'cln', backend: 'docker', network: 'regtest', compose_file: 'dev/ln-regtest/docker-compose.yml', service: 'cln-bob' },
        solana: { rpc_url: sol.rpcUrl, commitment: 'confirmed', program_id: LN_USDT_ESCROW_PROGRAM_ID.toBase58(), keypair: takerSolPath },
      },
      null,
      2
    )
  );

  const makerPromptd = spawnPromptd({ configPath: makerCfg, label: 'promptd-maker' });
  const takerPromptd = spawnPromptd({ configPath: takerCfg, label: 'promptd-taker' });
  t.after(async () => {
    await killProc(takerPromptd.proc);
    await killProc(makerPromptd.proc);
  });

  const makerListen = await makerPromptd.waitReady();
  const takerListen = await takerPromptd.waitReady();
  const makerBase = `http://${makerListen.host}:${makerListen.port}`;
  const takerBase = `http://${takerListen.host}:${takerListen.port}`;
  const makerSession = `e2e-maker-${runId}`;
  const takerSession = `e2e-taker-${runId}`;

  // LN funding via prompt tools.
  const makerLnAddr = await promptTool({ baseUrl: makerBase, sessionId: makerSession, autoApprove: true, name: 'intercomswap_ln_newaddr', args: {} });
  const takerLnAddr = await promptTool({ baseUrl: takerBase, sessionId: takerSession, autoApprove: true, name: 'intercomswap_ln_newaddr', args: {} });
  const makerBtcAddr = makerLnAddr?.bech32 || makerLnAddr?.address || makerLnAddr?.addr;
  const takerBtcAddr = takerLnAddr?.bech32 || takerLnAddr?.address || takerLnAddr?.addr;
  assert.ok(makerBtcAddr, 'maker LN newaddr missing bech32/address');
  assert.ok(takerBtcAddr, 'taker LN newaddr missing bech32/address');

  await btcCli(['-rpcwallet=miner', 'sendtoaddress', makerBtcAddr, '1']);
  await btcCli(['-rpcwallet=miner', 'sendtoaddress', takerBtcAddr, '1']);
  await btcCli(['-rpcwallet=miner', 'generatetoaddress', '6', minerAddr]);

  await retry(async () => {
    const funds = await clnCli('cln-alice', ['listfunds']);
    if (!hasConfirmedUtxo(funds)) throw new Error('alice not funded (no confirmed UTXO yet)');
    return funds;
  }, { label: 'alice funded', tries: 120, delayMs: 500 });
  await retry(async () => {
    const funds = await clnCli('cln-bob', ['listfunds']);
    if (!hasConfirmedUtxo(funds)) throw new Error('bob not funded (no confirmed UTXO yet)');
    return funds;
  }, { label: 'bob funded', tries: 120, delayMs: 500 });

  // Open one reusable LN channel (taker -> maker) via prompt tools.
  const makerInfo = await promptTool({ baseUrl: makerBase, sessionId: makerSession, autoApprove: false, name: 'intercomswap_ln_info', args: {} });
  const takerInfo = await promptTool({ baseUrl: takerBase, sessionId: takerSession, autoApprove: false, name: 'intercomswap_ln_info', args: {} });
  const makerNodeId = makerInfo?.info?.id || makerInfo?.id;
  const takerNodeId = takerInfo?.info?.id || takerInfo?.id;
  assert.match(String(makerNodeId || ''), /^[0-9a-f]{66}$/i, 'maker LN node id missing');
  assert.match(String(takerNodeId || ''), /^[0-9a-f]{66}$/i, 'taker LN node id missing');

  await promptTool({
    baseUrl: takerBase,
    sessionId: takerSession,
    autoApprove: true,
    name: 'intercomswap_ln_connect',
    args: { peer: `${makerNodeId}@cln-alice:9735` },
  });
  await promptTool({
    baseUrl: takerBase,
    sessionId: takerSession,
    autoApprove: true,
    name: 'intercomswap_ln_fundchannel',
    args: { node_id: makerNodeId, amount_sats: 1_000_000 },
  });
  await btcCli(['-rpcwallet=miner', 'generatetoaddress', '6', minerAddr]);
  await retry(async () => {
    const chans = await clnCli('cln-bob', ['listpeerchannels']);
    const c = chans.channels?.find((x) => x.peer_id === makerNodeId);
    const st = c?.state || '';
    if (st !== 'CHANNELD_NORMAL') throw new Error(`channel state=${st}`);
    return chans;
  }, { label: 'channel active', tries: 160, delayMs: 500 });

  // LN channel manager coverage: list peers/channels, open second channel, close that specific channel.
  const lnPeers = await promptTool({
    baseUrl: takerBase,
    sessionId: takerSession,
    autoApprove: false,
    name: 'intercomswap_ln_listpeers',
    args: {},
  });
  const peerRows = Array.isArray(lnPeers?.peers) ? lnPeers.peers : [];
  assert.ok(
    peerRows.some((p) => String(p?.id || p?.pub_key || p?.pubKey || '').trim().toLowerCase() === String(makerNodeId).trim().toLowerCase()),
    'ln_listpeers should include maker peer'
  );

  const chansBeforeOpenRaw = await promptTool({
    baseUrl: takerBase,
    sessionId: takerSession,
    autoApprove: false,
    name: 'intercomswap_ln_listchannels',
    args: {},
  });
  const chansBeforeOpen = rowsFromLnListChannels(chansBeforeOpenRaw).filter(
    (c) => channelPeerId(c) === String(makerNodeId).trim().toLowerCase() && isActiveChannel(c)
  );
  assert.ok(chansBeforeOpen.length >= 1, 'expected at least one active channel before manager test');
  const beforeCloseIds = new Set(chansBeforeOpen.map((c) => channelCloseId(c)).filter(Boolean));

  await promptTool({
    baseUrl: takerBase,
    sessionId: takerSession,
    autoApprove: true,
    name: 'intercomswap_ln_fundchannel',
    args: { peer: `${makerNodeId}@cln-alice:9735`, amount_sats: 200_000 },
  });
  await btcCli(['-rpcwallet=miner', 'generatetoaddress', '6', minerAddr]);

  const chansAfterOpenRaw = await retry(
    async () => {
      const out = await promptTool({
        baseUrl: takerBase,
        sessionId: takerSession,
        autoApprove: false,
        name: 'intercomswap_ln_listchannels',
        args: {},
      });
      const rows = rowsFromLnListChannels(out).filter(
        (c) => channelPeerId(c) === String(makerNodeId).trim().toLowerCase() && isActiveChannel(c)
      );
      if (rows.length < chansBeforeOpen.length + 1) {
        throw new Error(`second channel not active yet (have=${rows.length}, need>=${chansBeforeOpen.length + 1})`);
      }
      return out;
    },
    { label: 'second channel active', tries: 120, delayMs: 500 }
  );

  const chansAfterOpen = rowsFromLnListChannels(chansAfterOpenRaw).filter(
    (c) => channelPeerId(c) === String(makerNodeId).trim().toLowerCase() && isActiveChannel(c)
  );
  const closeTarget = chansAfterOpen.find((c) => {
    const id = channelCloseId(c);
    return id && !beforeCloseIds.has(id);
  });
  assert.ok(closeTarget, 'could not identify newly opened channel to close');
  const closeTargetId = channelCloseId(closeTarget);
  assert.ok(closeTargetId, 'close target missing channel id');

  const closeRes = await promptTool({
    baseUrl: takerBase,
    sessionId: takerSession,
    autoApprove: true,
    name: 'intercomswap_ln_closechannel',
    args: { channel_id: closeTargetId },
  });
  assert.ok(closeRes && typeof closeRes === 'object', 'ln_closechannel should return a result');
  await btcCli(['-rpcwallet=miner', 'generatetoaddress', '3', minerAddr]);

  await retry(
    async () => {
      const out = await promptTool({
        baseUrl: takerBase,
        sessionId: takerSession,
        autoApprove: false,
        name: 'intercomswap_ln_listchannels',
        args: {},
      });
      const rows = rowsFromLnListChannels(out).filter(
        (c) => channelPeerId(c) === String(makerNodeId).trim().toLowerCase() && isActiveChannel(c)
      );
      if (rows.some((c) => channelCloseId(c) === closeTargetId)) {
        throw new Error('close target channel still active');
      }
      if (rows.length < 1) throw new Error('must keep at least one active channel for swap');
      return out;
    },
    { label: 'closed channel no longer active', tries: 120, delayMs: 500 }
  );

  // Solana funding + mint/test token inventory via prompt tools.
  const makerSolPk = (await promptTool({ baseUrl: makerBase, sessionId: makerSession, autoApprove: false, name: 'intercomswap_sol_signer_pubkey', args: {} }))?.pubkey;
  const takerSolPk = (await promptTool({ baseUrl: takerBase, sessionId: takerSession, autoApprove: false, name: 'intercomswap_sol_signer_pubkey', args: {} }))?.pubkey;
  assert.ok(makerSolPk, 'maker sol pubkey missing');
  assert.ok(takerSolPk, 'taker sol pubkey missing');

  await promptTool({ baseUrl: makerBase, sessionId: makerSession, autoApprove: true, name: 'intercomswap_sol_airdrop', args: { lamports: '2000000000' } });
  await promptTool({ baseUrl: takerBase, sessionId: takerSession, autoApprove: true, name: 'intercomswap_sol_airdrop', args: { lamports: '1000000000' } });

  const mintRes = await promptTool({ baseUrl: makerBase, sessionId: makerSession, autoApprove: true, name: 'intercomswap_sol_mint_create', args: { decimals: 6 } });
  const mint = mintRes?.mint;
  assert.ok(mint, 'mint_create missing mint');

  // Mint enough to cover escrow amount + fees.
  const usdtAmount = '100000000'; // 100.000000 (decimals=6)
  await promptTool({
    baseUrl: makerBase,
    sessionId: makerSession,
    autoApprove: true,
    name: 'intercomswap_sol_mint_to',
    args: { mint, to_owner: makerSolPk, amount: '200000000', create_ata: true },
  });

  const beforeTakerBal = await promptTool({
    baseUrl: takerBase,
    sessionId: takerSession,
    autoApprove: false,
    name: 'intercomswap_sol_token_balance',
    args: { owner: takerSolPk, mint },
  });

  // Fee config (platform + trade) via prompt tools.
  await promptTool({
    baseUrl: makerBase,
    sessionId: makerSession,
    autoApprove: true,
    name: 'intercomswap_sol_config_set',
    // Platform fee bps is fixed in this stack; only the collector is configurable.
    args: { fee_collector: makerSolPk },
  });
  await promptTool({
    baseUrl: makerBase,
    sessionId: makerSession,
    autoApprove: true,
    name: 'intercomswap_sol_trade_config_set',
    // Keep trade fee aligned with RFQ defaults (10 bps) to avoid fee guardrail rejections in quote_post_from_rfq.
    args: { fee_bps: 10, fee_collector: makerSolPk },
  });

  // SC setup: join + subscribe to rendezvous.
  await promptTool({ baseUrl: makerBase, sessionId: makerSession, autoApprove: true, name: 'intercomswap_sc_join', args: { channel: rfqChannel } });
  await promptTool({ baseUrl: takerBase, sessionId: takerSession, autoApprove: true, name: 'intercomswap_sc_join', args: { channel: rfqChannel } });
  await promptTool({ baseUrl: makerBase, sessionId: makerSession, autoApprove: true, name: 'intercomswap_sc_join', args: { channel: guardRfqChannel } });
  await promptTool({ baseUrl: takerBase, sessionId: takerSession, autoApprove: true, name: 'intercomswap_sc_join', args: { channel: guardRfqChannel } });
  await promptTool({ baseUrl: makerBase, sessionId: makerSession, autoApprove: false, name: 'intercomswap_sc_subscribe', args: { channels: [rfqChannel] } });
  await promptTool({ baseUrl: takerBase, sessionId: takerSession, autoApprove: false, name: 'intercomswap_sc_subscribe', args: { channels: [rfqChannel] } });
  await promptTool({ baseUrl: makerBase, sessionId: makerSession, autoApprove: false, name: 'intercomswap_sc_subscribe', args: { channels: [guardRfqChannel] } });
  await promptTool({ baseUrl: takerBase, sessionId: takerSession, autoApprove: false, name: 'intercomswap_sc_subscribe', args: { channels: [guardRfqChannel] } });

  // Liquidity guardrail e2e: enforce mode + insufficient-liquidity rejection paths.
  const guardRejectBtcSats = 2_000_000_000;
  const guardPassBtcSats = 10_000;
  const guardUsdtAmount = '25000000';

  await assert.rejects(
    () =>
      promptTool({
        baseUrl: takerBase,
        sessionId: takerSession,
        autoApprove: true,
        name: 'intercomswap_rfq_post',
        args: {
          channel: guardRfqChannel,
          trade_id: guardTradeId,
          btc_sats: guardRejectBtcSats,
          usdt_amount: guardUsdtAmount,
          valid_until_unix: Math.floor(Date.now() / 1000) + 120,
          ln_liquidity_mode: 'single_channel',
        },
      }),
    /insufficient LN outbound liquidity \(mode=single_channel/i,
    'rfq_post should reject when single channel cannot cover btc_sats'
  );

  const guardRfqPosted = await promptTool({
    baseUrl: takerBase,
    sessionId: takerSession,
    autoApprove: true,
    name: 'intercomswap_rfq_post',
    args: {
      channel: guardRfqChannel,
      trade_id: guardTradeId,
      btc_sats: guardPassBtcSats,
      usdt_amount: guardUsdtAmount,
      valid_until_unix: Math.floor(Date.now() / 1000) + 120,
      ln_liquidity_mode: 'aggregate',
    },
  });
  assert.equal(guardRfqPosted?.type, 'rfq_posted');
  assert.equal(String(guardRfqPosted?.ln_liquidity?.mode || ''), 'aggregate');
  assert.ok(Number(guardRfqPosted?.ln_liquidity?.required_sats || 0) >= guardPassBtcSats);

  // Quote-post reject path: maker cannot quote a BTC amount larger than their LN inbound.
  await assert.rejects(
    () =>
      promptTool({
        baseUrl: makerBase,
        sessionId: makerSession,
        autoApprove: true,
        name: 'intercomswap_quote_post',
        args: {
          channel: guardRfqChannel,
          trade_id: `${guardTradeId}-reject`,
          rfq_id: crypto.randomBytes(32).toString('hex'),
          btc_sats: guardRejectBtcSats,
          usdt_amount: guardUsdtAmount,
          trade_fee_collector: makerSolPk,
          valid_for_sec: 120,
        },
      }),
    /insufficient LN inbound liquidity \(mode=aggregate/i,
    'quote_post should reject when maker inbound cannot cover btc_sats'
  );

  const passQuote = await promptTool({
    baseUrl: makerBase,
    sessionId: makerSession,
    autoApprove: true,
    name: 'intercomswap_quote_post',
    args: {
      channel: guardRfqChannel,
      trade_id: `${guardTradeId}-pass`,
      rfq_id: crypto.randomBytes(32).toString('hex'),
      btc_sats: guardPassBtcSats,
      usdt_amount: guardUsdtAmount,
      trade_fee_collector: makerSolPk,
      valid_for_sec: 120,
    },
  });
  assert.equal(passQuote?.type, 'quote_posted');

  const guardAccept = await promptTool({
    baseUrl: takerBase,
    sessionId: takerSession,
    autoApprove: true,
    name: 'intercomswap_quote_accept',
    args: {
      channel: guardRfqChannel,
      quote_envelope: passQuote.envelope,
      ln_liquidity_mode: 'aggregate',
    },
  });
  assert.equal(guardAccept?.type, 'quote_accept_posted');
  assert.equal(String(guardAccept?.ln_liquidity?.mode || ''), 'aggregate');

  // RFQ -> QUOTE -> ACCEPT -> SWAP_INVITE
  const rfqSeen = await retry(async () => {
    await promptTool({
      baseUrl: takerBase,
      sessionId: takerSession,
      autoApprove: true,
      name: 'intercomswap_rfq_post',
      args: {
        channel: rfqChannel,
        trade_id: tradeId,
        btc_sats: 50000,
        usdt_amount: usdtAmount,
        valid_until_unix: Math.floor(Date.now() / 1000) + 60,
      },
    });

    const seen = await promptTool({
      baseUrl: makerBase,
      sessionId: makerSession,
      autoApprove: false,
      name: 'intercomswap_sc_wait_envelope',
      args: { channels: [rfqChannel], kinds: ['swap.rfq'], timeout_ms: 6000 },
    });
    if (seen?.type !== 'swap_envelope') throw new Error(`rfq not seen yet: ${seen?.type || 'null'}`);
    return seen;
  }, { label: 'rfq exchange (rebroadcast until delivered)', tries: 20, delayMs: 500 });
  assert.equal(rfqSeen?.type, 'swap_envelope');

  const quoteSeen = await retry(async () => {
    await promptTool({
      baseUrl: makerBase,
      sessionId: makerSession,
      autoApprove: true,
      name: 'intercomswap_quote_post_from_rfq',
      args: {
        channel: rfqChannel,
        rfq_envelope: rfqSeen.envelope_handle,
        trade_fee_collector: makerSolPk,
        valid_for_sec: 60,
      },
    });

    const seen = await promptTool({
      baseUrl: takerBase,
      sessionId: takerSession,
      autoApprove: false,
      name: 'intercomswap_sc_wait_envelope',
      args: { channels: [rfqChannel], kinds: ['swap.quote'], timeout_ms: 6000 },
    });
    if (seen?.type !== 'swap_envelope') throw new Error(`quote not seen yet: ${seen?.type || 'null'}`);
    return seen;
  }, { label: 'quote exchange (rebroadcast until delivered)', tries: 20, delayMs: 500 });
  assert.equal(quoteSeen?.type, 'swap_envelope');

  const acceptSeen = await retry(async () => {
    await promptTool({
      baseUrl: takerBase,
      sessionId: takerSession,
      autoApprove: true,
      name: 'intercomswap_quote_accept',
      args: { channel: rfqChannel, quote_envelope: quoteSeen.envelope_handle },
    });

    const seen = await promptTool({
      baseUrl: makerBase,
      sessionId: makerSession,
      autoApprove: false,
      name: 'intercomswap_sc_wait_envelope',
      args: { channels: [rfqChannel], kinds: ['swap.quote_accept'], timeout_ms: 6000 },
    });
    if (seen?.type !== 'swap_envelope') throw new Error(`quote_accept not seen yet: ${seen?.type || 'null'}`);
    return seen;
  }, { label: 'quote_accept exchange (rebroadcast until delivered)', tries: 20, delayMs: 500 });
  assert.equal(acceptSeen?.type, 'swap_envelope');

  const { inviteRes, swapChannel, swapInviteSeen } = await retry(async () => {
    const res = await promptTool({
      baseUrl: makerBase,
      sessionId: makerSession,
      autoApprove: true,
      name: 'intercomswap_swap_invite_from_accept',
      args: { channel: rfqChannel, accept_envelope: acceptSeen.envelope_handle, welcome_text: `swap ${runId}`, ttl_sec: 600 },
    });
    const ch = res?.swap_channel || `swap:${tradeId}`;
    if (!ch) throw new Error('swap_channel missing');

    const seen = await promptTool({
      baseUrl: takerBase,
      sessionId: takerSession,
      autoApprove: false,
      name: 'intercomswap_sc_wait_envelope',
      args: { channels: [rfqChannel], kinds: ['swap.swap_invite'], timeout_ms: 6000 },
    });
    if (seen?.type !== 'swap_envelope') throw new Error(`swap_invite not seen yet: ${seen?.type || 'null'}`);
    return { inviteRes: res, swapChannel: ch, swapInviteSeen: seen };
  }, { label: 'swap_invite exchange (rebroadcast until delivered)', tries: 20, delayMs: 500 });
  assert.ok(swapChannel, 'swap_channel missing');
  assert.equal(swapInviteSeen?.type, 'swap_envelope');

  await promptTool({
    baseUrl: takerBase,
    sessionId: takerSession,
    autoApprove: true,
    name: 'intercomswap_join_from_swap_invite',
    args: { swap_invite_envelope: swapInviteSeen.envelope_handle },
  });

  // Subscribe to per-trade channel for envelope waits.
  await promptTool({ baseUrl: makerBase, sessionId: makerSession, autoApprove: false, name: 'intercomswap_sc_subscribe', args: { channels: [swapChannel] } });
  await promptTool({ baseUrl: takerBase, sessionId: takerSession, autoApprove: false, name: 'intercomswap_sc_subscribe', args: { channels: [swapChannel] } });

  const makerScInfo = await retry(
    () => promptTool({ baseUrl: makerBase, sessionId: makerSession, autoApprove: false, name: 'intercomswap_sc_info', args: {} }),
    { label: 'maker sc_info', tries: 80, delayMs: 250 }
  );
  const takerScInfo = await retry(
    () => promptTool({ baseUrl: takerBase, sessionId: takerSession, autoApprove: false, name: 'intercomswap_sc_info', args: {} }),
    { label: 'taker sc_info', tries: 80, delayMs: 250 }
  );
  const makerPeerHex = String(makerScInfo?.peer || makerScInfo?.info?.peerPubkey || '').trim().toLowerCase();
  const takerPeerHex = String(takerScInfo?.peer || takerScInfo?.info?.peerPubkey || '').trim().toLowerCase();
  assert.match(makerPeerHex, /^[0-9a-f]{64}$/);
  assert.match(takerPeerHex, /^[0-9a-f]{64}$/);

  const nowSec = Math.floor(Date.now() / 1000);
  // Guardrail is ">= 3600s from now" at tool execution time; give headroom for test runtime.
  const refundAfterUnix = nowSec + 7200;

  // TERMS -> ACCEPT -> INVOICE -> ESCROW -> PAY -> CLAIM
  await promptTool({
    baseUrl: makerBase,
    sessionId: makerSession,
    autoApprove: true,
    name: 'intercomswap_terms_post',
    args: {
      channel: swapChannel,
      trade_id: tradeId,
      btc_sats: 50000,
      usdt_amount: usdtAmount,
      sol_mint: mint,
      sol_recipient: takerSolPk,
      sol_refund: makerSolPk,
      sol_refund_after_unix: refundAfterUnix,
      ln_receiver_peer: makerPeerHex,
      ln_payer_peer: takerPeerHex,
      trade_fee_collector: makerSolPk,
      terms_valid_until_unix: nowSec + 300,
    },
  });

  const termsSeen = await promptTool({
    baseUrl: takerBase,
    sessionId: takerSession,
    autoApprove: false,
    name: 'intercomswap_sc_wait_envelope',
    args: { channels: [swapChannel], kinds: ['swap.terms'], timeout_ms: 20000 },
  });
  assert.equal(termsSeen?.type, 'swap_envelope');

  await promptTool({
    baseUrl: takerBase,
    sessionId: takerSession,
    autoApprove: true,
    name: 'intercomswap_terms_accept_from_terms',
    args: { channel: swapChannel, terms_envelope: termsSeen.envelope_handle },
  });

  const acceptTermsSeen = await promptTool({
    baseUrl: makerBase,
    sessionId: makerSession,
    autoApprove: false,
    name: 'intercomswap_sc_wait_envelope',
    args: { channels: [swapChannel], kinds: ['swap.accept'], timeout_ms: 20000 },
  });
  assert.equal(acceptTermsSeen?.type, 'swap_envelope');

  await promptTool({
    baseUrl: makerBase,
    sessionId: makerSession,
    autoApprove: true,
    name: 'intercomswap_swap_ln_invoice_create_and_post',
    args: { channel: swapChannel, trade_id: tradeId, btc_sats: 50000, label: tradeId, description: `swap ${runId}`, expiry_sec: 3600 },
  });

  const invSeen = await promptTool({
    baseUrl: takerBase,
    sessionId: takerSession,
    autoApprove: false,
    name: 'intercomswap_sc_wait_envelope',
    args: { channels: [swapChannel], kinds: ['swap.ln_invoice'], timeout_ms: 20000 },
  });
  assert.equal(invSeen?.type, 'swap_envelope');
  const paymentHashHex = String(invSeen?.payment_hash_hex || '').trim().toLowerCase();
  assert.match(paymentHashHex, /^[0-9a-f]{64}$/);

  // LN route precheck must happen BEFORE maker locks USDT into escrow.
  // Taker (LN payer) reports ln_route_precheck_ok via swap.status; maker refuses to escrow otherwise.
  const lnPre = await promptTool({
    baseUrl: takerBase,
    sessionId: takerSession,
    autoApprove: false,
    name: 'intercomswap_swap_ln_route_precheck_from_terms_invoice',
    args: { channel: swapChannel, terms_envelope: termsSeen.envelope_handle, invoice_envelope: invSeen.envelope_handle },
  });
  assert.equal(lnPre?.ok, true, `ln route precheck failed: ${lnPre?.error || 'unknown'}`);

  await promptTool({
    baseUrl: takerBase,
    sessionId: takerSession,
    autoApprove: true,
    name: 'intercomswap_swap_status_post',
    args: { channel: swapChannel, trade_id: tradeId, state: 'accepted', note: 'ln_route_precheck_ok (e2e)' },
  });

  const precheckSeen = await promptTool({
    baseUrl: makerBase,
    sessionId: makerSession,
    autoApprove: false,
    name: 'intercomswap_sc_wait_envelope',
    args: { channels: [swapChannel], kinds: ['swap.status'], timeout_ms: 20000 },
  });
  assert.equal(precheckSeen?.type, 'swap_envelope');

  await promptTool({
    baseUrl: makerBase,
    sessionId: makerSession,
    autoApprove: true,
    name: 'intercomswap_swap_sol_escrow_init_and_post',
    args: {
      channel: swapChannel,
      trade_id: tradeId,
      payment_hash_hex: paymentHashHex,
      mint,
      amount: usdtAmount,
      recipient: takerSolPk,
      refund: makerSolPk,
      refund_after_unix: refundAfterUnix,
      trade_fee_collector: makerSolPk,
    },
  });

  const escrowSeen = await promptTool({
    baseUrl: takerBase,
    sessionId: takerSession,
    autoApprove: false,
    name: 'intercomswap_sc_wait_envelope',
    args: { channels: [swapChannel], kinds: ['swap.sol_escrow_created'], timeout_ms: 20000 },
  });
  assert.equal(escrowSeen?.type, 'swap_envelope');

  const prePay = await promptTool({
    baseUrl: takerBase,
    sessionId: takerSession,
    autoApprove: false,
    name: 'intercomswap_swap_verify_pre_pay',
    args: { terms_envelope: termsSeen.envelope_handle, invoice_envelope: invSeen.envelope_handle, escrow_envelope: escrowSeen.envelope_handle, now_unix: nowSec + 1 },
  });
  assert.equal(prePay?.ok, true, `pre-pay check failed: ${prePay?.error || 'unknown'}`);

  const paid = await promptTool({
    baseUrl: takerBase,
    sessionId: takerSession,
    autoApprove: true,
    name: 'intercomswap_swap_ln_pay_and_post_verified',
    args: { channel: swapChannel, terms_envelope: termsSeen.envelope_handle, invoice_envelope: invSeen.envelope_handle, escrow_envelope: escrowSeen.envelope_handle, now_unix: nowSec + 2 },
  });
  assert.equal(paid?.type, 'ln_paid_posted');
  const preimageHandle = paid?.preimage_hex;
  assert.ok(typeof preimageHandle === 'string' && preimageHandle.startsWith('secret:'), 'preimage should be sealed into secret handle');

  // Open-claims list should show the trade before claim.
  const openClaims = await promptTool({
    baseUrl: takerBase,
    sessionId: takerSession,
    autoApprove: false,
    name: 'intercomswap_receipts_list_open_claims',
    args: { limit: 50, offset: 0 },
  });
  assert.ok(Array.isArray(openClaims), 'open claims should be an array');
  assert.ok(openClaims.some((x) => x?.trade_id === tradeId), 'expected trade in open claims list');

  await promptTool({
    baseUrl: takerBase,
    sessionId: takerSession,
    autoApprove: true,
    name: 'intercomswap_swap_sol_claim_and_post',
    args: { channel: swapChannel, trade_id: tradeId, preimage_hex: preimageHandle, mint },
  });

  const claimedSeen = await promptTool({
    baseUrl: makerBase,
    sessionId: makerSession,
    autoApprove: false,
    name: 'intercomswap_sc_wait_envelope',
    args: { channels: [swapChannel], kinds: ['swap.sol_claimed'], timeout_ms: 20000 },
  });
  assert.equal(claimedSeen?.type, 'swap_envelope');

  // Balances: taker should receive full usdtAmount (fees are additive on payer side).
  const afterTakerBal = await promptTool({
    baseUrl: takerBase,
    sessionId: takerSession,
    autoApprove: false,
    name: 'intercomswap_sol_token_balance',
    args: { owner: takerSolPk, mint },
  });
  assert.equal(String(afterTakerBal?.amount || '0'), usdtAmount);
  assert.equal(String(beforeTakerBal?.amount || '0'), '0');

  // Receipts: state should be claimed for both sides.
  const makerReceipt = await promptTool({
    baseUrl: makerBase,
    sessionId: makerSession,
    autoApprove: false,
    name: 'intercomswap_receipts_show',
    args: { trade_id: tradeId },
  });
  const takerReceipt = await promptTool({
    baseUrl: takerBase,
    sessionId: takerSession,
    autoApprove: false,
    name: 'intercomswap_receipts_show',
    args: { trade_id: tradeId },
  });
  assert.equal(makerReceipt?.state, 'escrow'); // maker does not claim; terminal is observed via SOL_CLAIMED
  assert.equal(takerReceipt?.state, 'claimed');

  // Channel hygiene: leave swap channel locally after done.
  await promptTool({ baseUrl: takerBase, sessionId: takerSession, autoApprove: true, name: 'intercomswap_sc_leave', args: { channel: swapChannel } });
  await promptTool({ baseUrl: makerBase, sessionId: makerSession, autoApprove: true, name: 'intercomswap_sc_leave', args: { channel: swapChannel } });
});
