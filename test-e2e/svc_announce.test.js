import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import http from 'node:http';
import { URL } from 'node:url';

import b4a from 'b4a';
import PeerWallet from 'trac-wallet';
import DHT from 'hyperdht';

import { ScBridgeClient } from '../src/sc-bridge/client.js';
import { KIND } from '../src/swap/constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

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
  };
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
  return { proc, tail: () => ({ out, err }) };
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

function ensureOk(res, label) {
  if (!res || typeof res !== 'object') throw new Error(`${label} failed (no response)`);
  if (res.type === 'error') throw new Error(`${label} failed: ${res.error}`);
  return res;
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

async function waitForNdjsonEvent({ url, headers = {}, predicate, timeoutMs = 20_000 }) {
  const u = new URL(url);
  if (u.protocol !== 'http:') throw new Error(`unsupported protocol: ${u.protocol}`);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        headers,
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 400) {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            reject(new Error(`ndjson stream HTTP ${status}: ${text.slice(0, 400)}`));
          });
          return;
        }
        let buf = '';
        const deadline = setTimeout(() => {
          try {
            req.destroy();
          } catch (_e) {}
          reject(new Error(`ndjson stream timeout after ${timeoutMs}ms`));
        }, timeoutMs);

        res.on('data', (chunk) => {
          buf += String(chunk || '');
          while (true) {
            const idx = buf.indexOf('\n');
            if (idx < 0) break;
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            let obj = null;
            try {
              obj = JSON.parse(line);
            } catch (_e) {
              continue;
            }
            try {
              if (predicate(obj)) {
                clearTimeout(deadline);
                try {
                  req.destroy();
                } catch (_e) {}
                resolve(obj);
                return;
              }
            } catch (err) {
              clearTimeout(deadline);
              try {
                req.destroy();
              } catch (_e) {}
              reject(err);
              return;
            }
          }
        });
        res.on('end', () => {
          clearTimeout(deadline);
          reject(new Error('ndjson stream ended before predicate matched'));
        });
        res.on('error', (err) => {
          clearTimeout(deadline);
          reject(err);
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function readNdjsonUntilFinal({ url, headers = {}, body, timeoutMs = 30_000 }) {
  const u = new URL(url);
  if (u.protocol !== 'http:') throw new Error(`unsupported protocol: ${u.protocol}`);
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(data),
          ...headers,
        },
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 400) {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            reject(new Error(`ndjson run HTTP ${status}: ${text.slice(0, 400)}`));
          });
          return;
        }
        let buf = '';
        const events = [];
        const deadline = setTimeout(() => {
          try {
            req.destroy();
          } catch (_e) {}
          reject(new Error(`ndjson run timeout after ${timeoutMs}ms`));
        }, timeoutMs);

        res.on('data', (chunk) => {
          buf += String(chunk || '');
          while (true) {
            const idx = buf.indexOf('\n');
            if (idx < 0) break;
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            let obj = null;
            try {
              obj = JSON.parse(line);
            } catch (_e) {
              continue;
            }
            events.push(obj);
            if (obj && typeof obj === 'object' && obj.type === 'final') {
              clearTimeout(deadline);
              try {
                req.destroy();
              } catch (_e) {}
              resolve(events);
              return;
            }
          }
        });
        res.on('end', () => {
          clearTimeout(deadline);
          reject(new Error('ndjson run ended before final'));
        });
        res.on('error', (err) => {
          clearTimeout(deadline);
          reject(err);
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function startFakeLlmServer({ toolName = 'intercomswap_sc_stats' } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(String(req.url || '/'), 'http://127.0.0.1');
      if (req.method !== 'POST' || u.pathname !== '/v1/chat/completions') {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : {};
      const messages = Array.isArray(body?.messages) ? body.messages : [];
      const hasToolResult = messages.some((m) => m && typeof m === 'object' && (m.role === 'tool' || m.role === 'function'));

      // First response: emit a tool call.
      if (!hasToolResult) {
        const json = {
          id: 'fake-1',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body?.model || 'fake',
          choices: [
            {
              index: 0,
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: { name: toolName, arguments: '{}' },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(json));
        return;
      }

      // Second response: final JSON message.
      const json = {
        id: 'fake-2',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body?.model || 'fake',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: { role: 'assistant', content: JSON.stringify({ type: 'message', text: 'ok' }) },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(json));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err?.message ?? String(err) }));
    }
  });

  const port = await pickFreePort();
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    stop: async () => new Promise((resolve) => server.close(resolve)),
  };
}

test('e2e: svc_announce re-broadcast reaches late joiners', async (t) => {
  const runId = crypto.randomBytes(4).toString('hex');

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
  const announcerStore = `e2e-svc-announcer-${runId}`;
  const listenerStore = `e2e-svc-listener-${runId}`;
  const announcerKeys = await writePeerKeypair({ storesDir, storeName: announcerStore });
  await writePeerKeypair({ storesDir, storeName: listenerStore });
  const listenerKeypairPath = path.join(storesDir, listenerStore, 'db', 'keypair.json');

  const announcerToken = `token-announcer-${runId}`;
  const listenerToken = `token-listener-${runId}`;
  const [announcerPort, listenerPort] = await pickFreePorts(2);

  const announcerPeer = spawnPeer(
    [
      '--peer-store-name',
      announcerStore,
      '--subnet-channel',
      `e2e-svc-subnet-${runId}`,
      '--msb',
      '0',
      '--dht-bootstrap',
      dhtBootstrap,
      '--sc-bridge',
      '1',
      '--sc-bridge-token',
      announcerToken,
      '--sc-bridge-port',
      String(announcerPort),
      '--sidechannel-pow',
      '0',
      '--sidechannel-welcome-required',
      '0',
    ],
    { label: 'announcer' }
  );

  t.after(async () => {
    await killProc(announcerPeer.proc);
  });

  // Wait until announcer SC-Bridge is reachable and sidechannels started.
  const announcerSc = new ScBridgeClient({ url: `ws://127.0.0.1:${announcerPort}`, token: announcerToken });
  await connectBridge(announcerSc, 'announcer sc-bridge');
  await retry(async () => {
    const s = await announcerSc.stats();
    if (s.type !== 'stats' || s.sidechannelStarted !== true) throw new Error('announcer sidechannel not started');
  }, { label: 'announcer sidechannel started', tries: 200, delayMs: 250 });
  announcerSc.close();

  // Start the announce loop on the announcer peer.
  const cfgDir = path.join(repoRoot, 'onchain/announce');
  fs.mkdirSync(cfgDir, { recursive: true });
  const cfgPath = path.join(cfgDir, `e2e-svc-${runId}.json`);
  fs.writeFileSync(
    cfgPath,
    `${JSON.stringify(
      {
        name: `svc-${runId}`,
        pairs: ['BTC_LN/USDT_SOL'],
        rfq_channels: ['0000intercomswapbtcusdt'],
        note: `e2e ${runId}`,
        offers: [{ have: 'USDT_SOL', want: 'BTC_LN', pair: 'BTC_LN/USDT_SOL' }],
      },
      null,
      2
    )}\n`
  );

  const loop = spawnBot(
    [
      'scripts/swapctl.mjs',
      '--url',
      `ws://127.0.0.1:${announcerPort}`,
      '--token',
      announcerToken,
      '--peer-keypair',
      announcerKeys.keyPairPath,
      'svc-announce-loop',
      '--channels',
      '0000intercom',
      '--config',
      cfgPath,
      '--interval-sec',
      '1',
      '--watch',
      '0',
      '--ttl-sec',
      '5',
    ],
    { label: 'svc-announce-loop' }
  );
  t.after(async () => {
    await killProc(loop.proc);
  });

  // Wait for at least one broadcast before the listener peer joins.
  await new Promise((r) => setTimeout(r, 1200));

  const listenerPeer = spawnPeer(
    [
      '--peer-store-name',
      listenerStore,
      '--subnet-channel',
      `e2e-svc-subnet-${runId}`,
      '--msb',
      '0',
      '--dht-bootstrap',
      dhtBootstrap,
      '--sc-bridge',
      '1',
      '--sc-bridge-token',
      listenerToken,
      '--sc-bridge-port',
      String(listenerPort),
      '--sidechannel-pow',
      '0',
      '--sidechannel-welcome-required',
      '0',
    ],
    { label: 'listener' }
  );
  t.after(async () => {
    await killProc(listenerPeer.proc);
  });

  const listenerSc = new ScBridgeClient({ url: `ws://127.0.0.1:${listenerPort}`, token: listenerToken });
  await connectBridge(listenerSc, 'listener sc-bridge');
  await retry(async () => {
    const s = await listenerSc.stats();
    if (s.type !== 'stats' || s.sidechannelStarted !== true) throw new Error('listener sidechannel not started');
  }, { label: 'listener sidechannel started', tries: 200, delayMs: 250 });
  // Ensure the late-joining peer has actually established at least one hyperswarm connection
  // before we assert that rebroadcasted announcements are observable. This avoids rare flakes
  // where discovery/connect takes longer than the stream timeout even with a local DHT.
  await retry(async () => {
    const s = await listenerSc.stats();
    const n = typeof s?.connectionCount === 'number' ? s.connectionCount : 0;
    if (n < 1) throw new Error('listener has no sidechannel connections yet');
  }, { label: 'listener sidechannel connected', tries: 240, delayMs: 250 });

  // Start a fake OpenAI-compatible LLM server to test LLM-mode prompting deterministically.
  const llm = await startFakeLlmServer({ toolName: 'intercomswap_sc_stats' });
  t.after(async () => {
    try {
      await llm.stop();
    } catch (_e) {}
  });

  // Start promptd connected to the listener peer, with HTTP auth enabled.
  const promptdToken = `promptd-auth-${runId}`;
  const promptdPort = await pickFreePort();
  const promptdCfg = path.join(repoRoot, `onchain/prompt/e2e-svc-stream-${runId}.json`);
  fs.mkdirSync(path.dirname(promptdCfg), { recursive: true });
  fs.writeFileSync(
    promptdCfg,
    JSON.stringify(
      {
        agent: { role: 'taker' },
        peer: { keypair: listenerKeypairPath },
        llm: { base_url: llm.baseUrl, api_key: '', model: 'fake', response_format: { type: 'json_object' } },
        server: {
          host: '127.0.0.1',
          port: promptdPort,
          audit_dir: `onchain/prompt/audit-e2e-svc-${runId}`,
          auth_token: promptdToken,
          auto_approve_default: false,
          max_steps: 8,
          max_repairs: 0,
        },
        sc_bridge: { url: `ws://127.0.0.1:${listenerPort}`, token: listenerToken },
        receipts: { db: `onchain/receipts/e2e-svc-stream-${runId}.sqlite` },
        ln: { impl: 'cln', backend: 'cli', network: 'regtest' },
        solana: { rpc_url: 'http://127.0.0.1:8899', commitment: 'confirmed', program_id: '', keypair: '' },
      },
      null,
      2
    )
  );

  const promptd = spawnPromptd({ configPath: promptdCfg, label: 'promptd-svc-stream' });
  t.after(async () => {
    await killProc(promptd.proc);
  });
  const listen = await promptd.waitReady();
  const base = `http://${listen.host}:${listen.port}`;
  const authHeaders = { authorization: `Bearer ${promptdToken}` };

  // Verify SC stream receives the svc_announce broadcast (memory-safe NDJSON).
  const streamEvent = await waitForNdjsonEvent({
    url: `${base}/v1/sc/stream?channels=0000intercom&since=0&backlog=5`,
    headers: authHeaders,
    predicate: (evt) => evt?.type === 'sc_event' && evt?.channel === '0000intercom' && evt?.message?.kind === KIND.SVC_ANNOUNCE,
    timeoutMs: 20_000,
  });
  assert.equal(String(streamEvent?.message?.body?.name), `svc-${runId}`);

  // Verify /v1/run/stream works in direct-tool mode (no LLM dependency).
  {
    const events = await readNdjsonUntilFinal({
      url: `${base}/v1/run/stream`,
      headers: authHeaders,
      body: {
        prompt: JSON.stringify({ type: 'tool', name: 'intercomswap_sc_stats', arguments: {} }),
        session_id: `e2e-svc-direct-${runId}`,
        auto_approve: false,
        dry_run: false,
        max_steps: 1,
      },
    });
    assert.ok(events.some((e) => e && typeof e === 'object' && e.type === 'tool' && e.name === 'intercomswap_sc_stats'));
    assert.ok(events.some((e) => e && typeof e === 'object' && e.type === 'final'));
  }

  // Verify LLM-mode prompting works end-to-end with tool calls (fake server).
  {
    const events = await readNdjsonUntilFinal({
      url: `${base}/v1/run/stream`,
      headers: authHeaders,
      body: {
        prompt: 'Show SC-Bridge stats and then reply with ok.',
        session_id: `e2e-svc-llm-${runId}`,
        auto_approve: false,
        dry_run: false,
        max_steps: 6,
      },
      timeoutMs: 30_000,
    });
    assert.ok(events.some((e) => e && typeof e === 'object' && e.type === 'llm'));
    assert.ok(events.some((e) => e && typeof e === 'object' && e.type === 'tool' && e.name === 'intercomswap_sc_stats'));
    const final = events.findLast((e) => e && typeof e === 'object' && e.type === 'final');
    assert.equal(final?.content_json?.type, 'message');
    assert.equal(final?.content_json?.text, 'ok');
  }

  const seen = [];
  listenerSc.on('sidechannel_message', (evt) => {
    if (evt?.channel !== '0000intercom') return;
    seen.push(evt.message);
  });

  await retry(
    async () => {
      const msg = seen.find((m) => m && typeof m === 'object' && m.kind === KIND.SVC_ANNOUNCE);
      assert.ok(msg, `did not observe svc_announce. stderr tail:\n${loop.tail().err}`);
      assert.equal(String(msg.body?.name), `svc-${runId}`);
      return msg;
    },
    { label: 'observe svc_announce', tries: 40, delayMs: 250 }
  );

  listenerSc.close();
});

test('e2e: prompt tool offer_post broadcasts swap.svc_announce', async (t) => {
  const runId = crypto.randomBytes(4).toString('hex');

  // Local DHT bootstrapper for reliability.
  const dhtPort = 30000 + crypto.randomInt(0, 10000);
  const dht = DHT.bootstrapper(dhtPort, '127.0.0.1');
  await dht.ready();
  const dhtBootstrap = `127.0.0.1:${dhtPort}`;
  t.after(async () => {
    try {
      await dht.destroy({ force: true });
    } catch (_e) {}
  });

  const channel = `svc-offer-${runId}`;

  const storesDir = path.join(repoRoot, 'stores');
  const announcerStore = `e2e-offer-tool-announcer-${runId}`;
  const listenerStore = `e2e-offer-tool-listener-${runId}`;
  const announcerKeys = await writePeerKeypair({ storesDir, storeName: announcerStore });
  await writePeerKeypair({ storesDir, storeName: listenerStore });
  const listenerKeypairPath = path.join(storesDir, listenerStore, 'db', 'keypair.json');

  const announcerToken = `token-announcer-offer-${runId}`;
  const listenerToken = `token-listener-offer-${runId}`;
  const [announcerPort, listenerPort] = await pickFreePorts(2);

  const announcerPeer = spawnPeer(
    [
      '--peer-store-name',
      announcerStore,
      '--subnet-channel',
      `e2e-offer-subnet-${runId}`,
      '--msb',
      '0',
      '--dht-bootstrap',
      dhtBootstrap,
      '--sc-bridge',
      '1',
      '--sc-bridge-token',
      announcerToken,
      '--sc-bridge-port',
      String(announcerPort),
      '--sidechannel-pow',
      '0',
      '--sidechannel-welcome-required',
      '0',
    ],
    { label: 'announcer-offer-tool' }
  );
  t.after(async () => {
    await killProc(announcerPeer.proc);
  });

  const listenerPeer = spawnPeer(
    [
      '--peer-store-name',
      listenerStore,
      '--subnet-channel',
      `e2e-offer-subnet-${runId}`,
      '--msb',
      '0',
      '--dht-bootstrap',
      dhtBootstrap,
      '--sc-bridge',
      '1',
      '--sc-bridge-token',
      listenerToken,
      '--sc-bridge-port',
      String(listenerPort),
      '--sidechannel-pow',
      '0',
      '--sidechannel-welcome-required',
      '0',
    ],
    { label: 'listener-offer-tool' }
  );
  t.after(async () => {
    await killProc(listenerPeer.proc);
  });

  const announcerSc = new ScBridgeClient({ url: `ws://127.0.0.1:${announcerPort}`, token: announcerToken });
  const listenerSc = new ScBridgeClient({ url: `ws://127.0.0.1:${listenerPort}`, token: listenerToken });
  await connectBridge(announcerSc, 'announcer sc-bridge (offer)');
  await connectBridge(listenerSc, 'listener sc-bridge (offer)');

  await retry(async () => {
    const s = await announcerSc.stats();
    if (s.type !== 'stats' || s.sidechannelStarted !== true) throw new Error('announcer sidechannel not started');
  }, { label: 'announcer sidechannel started', tries: 200, delayMs: 250 });
  await retry(async () => {
    const s = await listenerSc.stats();
    if (s.type !== 'stats' || s.sidechannelStarted !== true) throw new Error('listener sidechannel not started');
  }, { label: 'listener sidechannel started', tries: 200, delayMs: 250 });

  // Ensure both peers are joined for delivery.
  ensureOk(await announcerSc.join(channel), `join ${channel} (announcer)`);
  ensureOk(await listenerSc.join(channel), `join ${channel} (listener)`);
  ensureOk(await announcerSc.subscribe([channel]), `subscribe ${channel} (announcer)`);
  ensureOk(await listenerSc.subscribe([channel]), `subscribe ${channel} (listener)`);

  // Fake OpenAI endpoint so promptd can boot, even though we only use direct-tool mode here.
  const llm = await startFakeLlmServer({ toolName: 'intercomswap_sc_stats' });
  t.after(async () => {
    try {
      await llm.stop();
    } catch (_e) {}
  });

  const promptdToken = `promptd-auth-offer-${runId}`;
  const promptdPort = await pickFreePort();
  const promptdCfg = path.join(repoRoot, `onchain/prompt/e2e-offer-post-${runId}.json`);
  fs.mkdirSync(path.dirname(promptdCfg), { recursive: true });
  fs.writeFileSync(
    promptdCfg,
    JSON.stringify(
      {
        agent: { role: 'maker' },
        peer: { keypair: announcerKeys.keyPairPath },
        llm: { base_url: llm.baseUrl, api_key: '', model: 'fake', response_format: { type: 'json_object' } },
        server: {
          host: '127.0.0.1',
          port: promptdPort,
          audit_dir: `onchain/prompt/audit-e2e-offer-${runId}`,
          auth_token: promptdToken,
          auto_approve_default: false,
          max_steps: 4,
          max_repairs: 0,
        },
        sc_bridge: { url: `ws://127.0.0.1:${announcerPort}`, token: announcerToken },
        receipts: { db: `onchain/receipts/e2e-offer-post-${runId}.sqlite` },
        ln: { impl: 'cln', backend: 'cli', network: 'regtest' },
        solana: { rpc_url: 'http://127.0.0.1:8899', commitment: 'confirmed', program_id: '', keypair: '' },
      },
      null,
      2
    )
  );

  const promptd = spawnPromptd({ configPath: promptdCfg, label: 'promptd-offer-post' });
  t.after(async () => {
    await killProc(promptd.proc);
  });
  const listen = await promptd.waitReady();
  const base = `http://${listen.host}:${listen.port}`;
  const authHeaders = { authorization: `Bearer ${promptdToken}` };

  // Sidechannels are unbuffered: ensure connectivity right before the one-shot prompt-tool broadcast.
  // (Connections can go idle while promptd boots.)
  const preflight = {
    kind: KIND.SVC_ANNOUNCE,
    trade_id: `preflight_${runId}`,
    body: { name: `preflight:${runId}` },
  };
  const preflightWait = waitForSidechannel(listenerSc, {
    channel,
    pred: (m) => m?.kind === KIND.SVC_ANNOUNCE && String(m?.body?.name || '') === `preflight:${runId}`,
    // Under CPU+IO load (full e2e suite) discovery can take longer even with a local DHT bootstrapper.
    // Keep this generous to avoid flakes; the resender loop makes it fast when the swarm is healthy.
    timeoutMs: 45_000,
    label: 'preflight delivery',
  });
  ensureOk(await announcerSc.send(channel, preflight), 'send preflight (initial)');
  let preflightStop = false;
  let preflightTicks = 0;
  const preflightResender = setInterval(async () => {
    if (preflightStop) return;
    preflightTicks += 1;
    try {
      await announcerSc.send(channel, preflight);
    } catch (_e) {}
    // Under load, swarm joins/flush can lag. Re-join/re-subscribe periodically to retrigger discovery.
    // (join() is idempotent and will re-run swarm.join()+flush() in the sidechannel feature.)
    if (preflightTicks % 10 === 0) {
      try {
        await announcerSc.join(channel);
      } catch (_e) {}
      try {
        await listenerSc.join(channel);
      } catch (_e) {}
      try {
        await announcerSc.subscribe([channel]);
      } catch (_e) {}
      try {
        await listenerSc.subscribe([channel]);
      } catch (_e) {}
    }
  }, 250);
  t.after(() => clearInterval(preflightResender));
  try {
    await preflightWait;
  } catch (_e) {
    // Best-effort only. The real assertion is the offer svc_announce delivery below.
  }

  const offerWait = waitForSidechannel(listenerSc, {
    channel,
    pred: (m) => m?.kind === KIND.SVC_ANNOUNCE && String(m?.body?.name || '') === `maker:${runId}`,
    timeoutMs: 60_000,
    label: 'observe offer svc_announce',
  });

  const events = await readNdjsonUntilFinal({
    url: `${base}/v1/run/stream`,
    headers: authHeaders,
    body: {
      prompt: JSON.stringify({
        type: 'tool',
        name: 'intercomswap_offer_post',
        arguments: {
          channels: [channel],
          name: `maker:${runId}`,
          rfq_channels: [channel],
          ttl_sec: 30,
          offers: [
            {
              pair: 'BTC_LN/USDT_SOL',
              have: 'USDT_SOL',
              want: 'BTC_LN',
              btc_sats: 10000,
              usdt_amount: '1000000',
              max_platform_fee_bps: 500,
              max_trade_fee_bps: 1000,
              max_total_fee_bps: 1500,
              min_sol_refund_window_sec: 72 * 3600,
              max_sol_refund_window_sec: 7 * 24 * 3600,
            },
          ],
        },
      }),
      session_id: `e2e-offer-post-${runId}`,
      auto_approve: true,
      dry_run: false,
      max_steps: 1,
    },
    timeoutMs: 30_000,
  });
  const final = events.findLast((e) => e && typeof e === 'object' && e.type === 'final');
  assert.equal(final?.content_json?.type, 'offer_posted');

  await offerWait;

  preflightStop = true;
  clearInterval(preflightResender);

  announcerSc.close();
  listenerSc.close();
});
