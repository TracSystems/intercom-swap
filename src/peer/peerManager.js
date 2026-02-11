import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeName(name) {
  return String(name || '').replaceAll(/[^a-zA-Z0-9._-]/g, '_');
}

function assertSafeId(label, value) {
  const s = String(value || '');
  if (!/^[A-Za-z0-9._-]+$/.test(s)) {
    throw new Error(`${label} must match /^[A-Za-z0-9._-]+$/ (got: ${JSON.stringify(s)})`);
  }
  return s;
}

function resolvePathMaybeRelative(p, { baseDir }) {
  const s = String(p || '').trim();
  if (!s) return '';
  return path.isAbsolute(s) ? s : path.resolve(baseDir, s);
}

function stateDirForRepo(repoRoot) {
  return path.join(repoRoot, 'onchain', 'peers');
}

export function peerStatePaths({ repoRoot, name }) {
  const stateDir = stateDirForRepo(repoRoot);
  const safe = safeName(name);
  return {
    stateDir,
    json: path.join(stateDir, `${safe}.json`),
    pid: path.join(stateDir, `${safe}.pid`),
    log: path.join(stateDir, `${safe}.log`),
  };
}

export function defaultPeerScBridgeTokenFile({ repoRoot, store }) {
  const safeStore = safeName(assertSafeId('defaultPeerScBridgeTokenFile: store', store));
  return path.join(repoRoot, 'onchain', 'sc-bridge', `${safeStore}.token`);
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_e) {
    return null;
  }
}

function writeJson(p, obj) {
  fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_e) {
    return false;
  }
}

async function waitForExit(pid, waitMs) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isAlive(pid);
}

function ensureTokenFile(tokenFile) {
  mkdirp(path.dirname(tokenFile));
  if (!fs.existsSync(tokenFile)) {
    const token = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(tokenFile, `${token}\n`);
    try {
      fs.chmodSync(tokenFile, 0o600);
    } catch (_e) {}
  }
  const token = String(fs.readFileSync(tokenFile, 'utf8') || '').trim();
  if (!token) throw new Error(`Empty SC-Bridge token file: ${tokenFile}`);
  return token;
}

async function waitForTcp({ host, port, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await new Promise((resolve, reject) => {
        const sock = net.connect({ host, port });
        const done = (err) => {
          try {
            sock.destroy();
          } catch (_e) {}
          err ? reject(err) : resolve();
        };
        sock.once('connect', () => done(null));
        sock.once('error', (err) => done(err));
      });
      return;
    } catch (_e) {
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for tcp://${host}:${port}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

function readCsvList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((v) => String(v || '').trim()).filter(Boolean);
  return String(value)
    .split(',')
    .map((v) => String(v || '').trim())
    .filter(Boolean);
}

function buildPearArgs({
  store,
  scPort,
  scHost,
  scToken,
  msbEnabled,
  priceOracleEnabled,
  subnetChannel,
  dhtBootstrap,
  msbDhtBootstrap,
  sidechannels,
  sidechannelPowEnabled,
  sidechannelPowDifficulty,
  sidechannelWelcomeRequired,
  sidechannelInviteRequired,
  sidechannelInvitePrefixes,
  sidechannelInviterKeys,
} = {}) {
  const args = [
    'run',
    '.',
    '--peer-store-name',
    store,
    '--terminal',
    '0',
    '--msb-store-name',
    `${store}-msb`,
    '--msb',
    msbEnabled ? '1' : '0',
    '--price-oracle',
    priceOracleEnabled ? '1' : '0',
    '--sc-bridge',
    '1',
    '--sc-bridge-host',
    scHost,
    '--sc-bridge-port',
    String(scPort),
    '--sc-bridge-token',
    scToken,
    '--sidechannel-pow',
    sidechannelPowEnabled ? '1' : '0',
    '--sidechannel-pow-difficulty',
    String(sidechannelPowDifficulty),
    '--sidechannel-welcome-required',
    sidechannelWelcomeRequired ? '1' : '0',
    '--sidechannel-invite-required',
    sidechannelInviteRequired ? '1' : '0',
  ];

  if (sidechannels && sidechannels.length > 0) {
    args.push('--sidechannels', sidechannels.join(','));
  }
  if (sidechannelInvitePrefixes && sidechannelInvitePrefixes.length > 0) {
    args.push('--sidechannel-invite-prefixes', sidechannelInvitePrefixes.join(','));
  }
  if (sidechannelInviterKeys && sidechannelInviterKeys.length > 0) {
    args.push('--sidechannel-inviter-keys', sidechannelInviterKeys.join(','));
  }
  if (subnetChannel) {
    args.push('--subnet-channel', subnetChannel);
  }
  if (dhtBootstrap && dhtBootstrap.length > 0) {
    args.push('--dht-bootstrap', dhtBootstrap.join(','));
  }
  if (msbDhtBootstrap && msbDhtBootstrap.length > 0) {
    args.push('--msb-dht-bootstrap', msbDhtBootstrap.join(','));
  }
  return args;
}

function listPeerConfigs({ repoRoot }) {
  const stateDir = stateDirForRepo(repoRoot);
  mkdirp(stateDir);
  const list = fs.readdirSync(stateDir).filter((f) => f.endsWith('.json'));
  const rows = [];
  for (const f of list) {
    const cfg = readJson(path.join(stateDir, f));
    if (!cfg?.name) continue;
    rows.push(cfg);
  }
  return rows;
}

function ensureStoreNotRunningElsewhere({ repoRoot, name, store }) {
  for (const cfg of listPeerConfigs({ repoRoot })) {
    if (cfg?.store !== store) continue;
    if (cfg?.name === name) continue;
    const paths = peerStatePaths({ repoRoot, name: cfg.name });
    const pidText = fs.existsSync(paths.pid) ? fs.readFileSync(paths.pid, 'utf8').trim() : '';
    const pid = pidText ? Number.parseInt(pidText, 10) : null;
    if (pid && Number.isFinite(pid) && isAlive(pid)) {
      throw new Error(`Peer store "${store}" is already running under instance "${cfg.name}" (pid=${pid}).`);
    }
  }
}

export async function peerStart({
  repoRoot = process.cwd(),
  name,
  store,
  scPort,
  scHost = '127.0.0.1',
  logPath = '',
  readyTimeoutMs = 15_000,

  msbEnabled = false,
  priceOracleEnabled = false,
  subnetChannel = '',
  dhtBootstrap = [],
  msbDhtBootstrap = [],

  sidechannels = [],
  sidechannelPowEnabled = true,
  sidechannelPowDifficulty = 12,
  sidechannelWelcomeRequired = false,
  sidechannelInviteRequired = true,
  sidechannelInvitePrefixes = ['swap:'],
  sidechannelInviterKeys = [],

  pearBin = 'pear',
} = {}) {
  if (!name) throw new Error('peerStart: name is required');
  if (!store) throw new Error('peerStart: store is required');
  assertSafeId('peerStart: name', name);
  assertSafeId('peerStart: store', store);
  if (!Number.isInteger(scPort) || scPort <= 0 || scPort > 65535) throw new Error('peerStart: scPort invalid');

  ensureStoreNotRunningElsewhere({ repoRoot, name, store });

  const paths = peerStatePaths({ repoRoot, name });
  mkdirp(paths.stateDir);

  const pidText = fs.existsSync(paths.pid) ? fs.readFileSync(paths.pid, 'utf8').trim() : '';
  const existingPid = pidText ? Number.parseInt(pidText, 10) : null;
  if (existingPid && Number.isFinite(existingPid) && isAlive(existingPid)) {
    return { type: 'peer_already_running', name, store, pid: existingPid, log: paths.log };
  }

  const tokenFile = defaultPeerScBridgeTokenFile({ repoRoot, store });
  const scToken = ensureTokenFile(tokenFile);

  const log = resolvePathMaybeRelative(logPath, { baseDir: repoRoot }) || paths.log;
  mkdirp(path.dirname(log));

  const normMsbEnabled = msbEnabled === null || msbEnabled === undefined ? false : Boolean(msbEnabled);
  const normPriceOracleEnabled =
    priceOracleEnabled === null || priceOracleEnabled === undefined ? false : Boolean(priceOracleEnabled);
  const normPowEnabled = sidechannelPowEnabled === null || sidechannelPowEnabled === undefined ? true : Boolean(sidechannelPowEnabled);
  const normWelcomeRequired =
    sidechannelWelcomeRequired === null || sidechannelWelcomeRequired === undefined ? false : Boolean(sidechannelWelcomeRequired);
  const normInviteRequired =
    sidechannelInviteRequired === null || sidechannelInviteRequired === undefined ? true : Boolean(sidechannelInviteRequired);

  const args = buildPearArgs({
    store,
    scPort,
    scHost,
    scToken,
    msbEnabled: normMsbEnabled,
    priceOracleEnabled: normPriceOracleEnabled,
    subnetChannel: String(subnetChannel || '').trim(),
    dhtBootstrap: readCsvList(dhtBootstrap),
    msbDhtBootstrap: readCsvList(msbDhtBootstrap),
    sidechannels: readCsvList(sidechannels),
    sidechannelPowEnabled: normPowEnabled,
    sidechannelPowDifficulty: Number.isInteger(sidechannelPowDifficulty) ? sidechannelPowDifficulty : 12,
    sidechannelWelcomeRequired: normWelcomeRequired,
    sidechannelInviteRequired: normInviteRequired,
    sidechannelInvitePrefixes: readCsvList(sidechannelInvitePrefixes),
    sidechannelInviterKeys: readCsvList(sidechannelInviterKeys),
  });

  const outFd = fs.openSync(log, 'a');
  const child = spawn(pearBin, args, {
    cwd: repoRoot,
    detached: true,
    stdio: ['ignore', outFd, outFd],
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  try {
    fs.closeSync(outFd);
  } catch (_e) {}
  child.unref();

  fs.writeFileSync(paths.pid, `${child.pid}\n`);
  writeJson(paths.json, {
    v: 1,
    name,
    store,
    pid: child.pid,
    log,
    started_at: Date.now(),
    sc_bridge: {
      host: scHost,
      port: Number(scPort),
      token_file: tokenFile,
    },
    args: {
      msb: normMsbEnabled,
      price_oracle: normPriceOracleEnabled,
      subnet_channel: String(subnetChannel || '').trim() || null,
      dht_bootstrap: readCsvList(dhtBootstrap),
      msb_dht_bootstrap: readCsvList(msbDhtBootstrap),
      sidechannels: readCsvList(sidechannels),
      sidechannel_pow: normPowEnabled,
      sidechannel_pow_difficulty: Number.isInteger(sidechannelPowDifficulty) ? sidechannelPowDifficulty : 12,
      sidechannel_welcome_required: normWelcomeRequired,
      sidechannel_invite_required: normInviteRequired,
      sidechannel_invite_prefixes: readCsvList(sidechannelInvitePrefixes),
      sidechannel_inviter_keys: readCsvList(sidechannelInviterKeys),
    },
  });

  if (readyTimeoutMs > 0) {
    await waitForTcp({ host: scHost, port: scPort, timeoutMs: readyTimeoutMs });
  }

  return {
    type: 'peer_started',
    name,
    store,
    pid: child.pid,
    log,
    sc_bridge: { url: `ws://${scHost}:${scPort}`, token_file: tokenFile },
  };
}

export async function peerStop({
  repoRoot = process.cwd(),
  name,
  signal = 'SIGTERM',
  waitMs = 2000,
} = {}) {
  if (!name) throw new Error('peerStop: name is required');
  const paths = peerStatePaths({ repoRoot, name });
  mkdirp(paths.stateDir);

  const pidText = fs.existsSync(paths.pid) ? fs.readFileSync(paths.pid, 'utf8').trim() : '';
  const pid = pidText ? Number.parseInt(pidText, 10) : null;
  if (!pid || !Number.isFinite(pid)) {
    return { type: 'peer_stopped', name, ok: true, pid: null, reason: 'no_pidfile' };
  }

  if (!isAlive(pid)) {
    try {
      fs.unlinkSync(paths.pid);
    } catch (_e) {}
    return { type: 'peer_stopped', name, ok: true, pid, reason: 'not_running' };
  }

  // pear run may spawn additional processes. When we start detached, the child is the leader of a
  // new process group on POSIX, so we signal the entire group to avoid orphaned runtimes.
  const target = process.platform === 'win32' ? pid : -pid;
  try {
    process.kill(target, signal);
  } catch (err) {
    throw new Error(`Failed to signal pid=${pid}: ${err?.message ?? String(err)}`);
  }

  const ok = await waitForExit(pid, waitMs);
  if (!ok && signal !== 'SIGKILL') {
    try {
      process.kill(target, 'SIGKILL');
    } catch (_e) {}
  }

  try {
    fs.unlinkSync(paths.pid);
  } catch (_e) {}
  return { type: 'peer_stopped', name, ok: true, pid, signal };
}

export async function peerRestart({ repoRoot = process.cwd(), name, waitMs = 2000, readyTimeoutMs = 15_000 } = {}) {
  if (!name) throw new Error('peerRestart: name is required');
  const paths = peerStatePaths({ repoRoot, name });
  const cfg = readJson(paths.json);
  if (!cfg) {
    throw new Error(`Missing peer state: ${paths.json}\nHint: start the peer first.`);
  }
  await peerStop({ repoRoot, name, waitMs });
  return peerStart({
    repoRoot,
    name,
    store: cfg.store,
    scPort: Number(cfg?.sc_bridge?.port),
    scHost: String(cfg?.sc_bridge?.host || '127.0.0.1'),
    logPath: cfg.log || '',
    readyTimeoutMs,
    msbEnabled: Boolean(cfg?.args?.msb),
    priceOracleEnabled: Boolean(cfg?.args?.price_oracle),
    subnetChannel: cfg?.args?.subnet_channel || '',
    dhtBootstrap: cfg?.args?.dht_bootstrap || [],
    msbDhtBootstrap: cfg?.args?.msb_dht_bootstrap || [],
    sidechannels: cfg?.args?.sidechannels || [],
    sidechannelPowEnabled: Boolean(cfg?.args?.sidechannel_pow),
    sidechannelPowDifficulty: Number(cfg?.args?.sidechannel_pow_difficulty) || 12,
    sidechannelWelcomeRequired: Boolean(cfg?.args?.sidechannel_welcome_required),
    sidechannelInviteRequired: Boolean(cfg?.args?.sidechannel_invite_required),
    sidechannelInvitePrefixes: cfg?.args?.sidechannel_invite_prefixes || [],
    sidechannelInviterKeys: cfg?.args?.sidechannel_inviter_keys || [],
  });
}

export function peerStatus({ repoRoot = process.cwd(), name = '' } = {}) {
  const stateDir = stateDirForRepo(repoRoot);
  mkdirp(stateDir);
  const list = fs.readdirSync(stateDir).filter((f) => f.endsWith('.json'));
  const rows = [];
  for (const f of list) {
    const cfg = readJson(path.join(stateDir, f));
    if (!cfg?.name) continue;
    if (name && cfg.name !== name) continue;
    const paths = peerStatePaths({ repoRoot, name: cfg.name });
    const pidText = fs.existsSync(paths.pid) ? fs.readFileSync(paths.pid, 'utf8').trim() : '';
    const pid = pidText ? Number.parseInt(pidText, 10) : null;
    rows.push({
      name: cfg.name,
      store: cfg.store,
      pid: pid && Number.isFinite(pid) ? pid : null,
      alive: pid && Number.isFinite(pid) ? isAlive(pid) : false,
      log: cfg.log || null,
      sc_bridge: cfg.sc_bridge || null,
      args: cfg.args || {},
      started_at: cfg.started_at || null,
    });
  }
  return { type: 'peer_status', peers: rows };
}

export function peerAddInviterKey({ repoRoot = process.cwd(), name, pubkey } = {}) {
  if (!name) throw new Error('peerAddInviterKey: name is required');
  const key = String(pubkey || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('peerAddInviterKey: invalid pubkey');

  const paths = peerStatePaths({ repoRoot, name });
  const cfg = readJson(paths.json);
  if (!cfg) throw new Error(`Missing peer state: ${paths.json}`);

  const args = cfg.args && typeof cfg.args === 'object' ? { ...cfg.args } : {};
  const list = Array.isArray(args.sidechannel_inviter_keys)
    ? args.sidechannel_inviter_keys.map((v) => String(v || '').trim().toLowerCase()).filter(Boolean)
    : [];
  if (!list.includes(key)) list.push(key);
  args.sidechannel_inviter_keys = list;
  cfg.args = args;
  writeJson(paths.json, cfg);
  return { type: 'peer_inviter_key_added', name: cfg.name || name, pubkey: key, count: list.length };
}
