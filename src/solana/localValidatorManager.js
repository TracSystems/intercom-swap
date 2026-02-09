import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeName(name) {
  return String(name || '').replaceAll(/[^a-zA-Z0-9._-]/g, '_');
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
    await new Promise((r) => setTimeout(r, 120));
  }
  return !isAlive(pid);
}

async function isTcpListening({ host, port, timeoutMs = 250 } = {}) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return false;
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok) => {
      try {
        sock.destroy();
      } catch (_e) {}
      resolve(Boolean(ok));
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

async function waitForTcp({ host, port, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (await isTcpListening({ host, port, timeoutMs: 250 })) return;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for tcp://${host}:${port}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

function resolveRepoPath(repoRoot, maybePath) {
  const s = String(maybePath || '').trim();
  if (!s) return '';
  return path.isAbsolute(s) ? s : path.resolve(repoRoot, s);
}

function resolveWithinRepoRoot(repoRoot, p, { label = 'path', mustExist = false, allowDir = false } = {}) {
  const resolved = resolveRepoPath(repoRoot, p);
  const root = path.resolve(repoRoot);
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

function resolveOnchainDir(repoRoot, p, { label = 'dir' } = {}) {
  const resolved = resolveRepoPath(repoRoot, p);
  const onchainRoot = path.resolve(repoRoot, 'onchain');
  const rel = path.relative(onchainRoot, resolved);
  const within = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  if (!within && resolved !== onchainRoot) {
    throw new Error(`${label} must be under onchain/ (got ${resolved})`);
  }
  return resolved;
}

function stateDirForRepo(repoRoot) {
  return path.join(repoRoot, 'onchain', 'solana', 'validator');
}

export function solLocalStatePaths({ repoRoot, name = 'local' } = {}) {
  const stateDir = stateDirForRepo(repoRoot);
  mkdirp(stateDir);
  const safe = safeName(name);
  return {
    stateDir,
    json: path.join(stateDir, `${safe}.json`),
    pid: path.join(stateDir, `${safe}.pid`),
    log: path.join(stateDir, `${safe}.log`),
  };
}

export async function solLocalStatus({
  repoRoot = process.cwd(),
  name = 'local',
  rpcPort = 8899,
  host = '127.0.0.1',
} = {}) {
  const paths = solLocalStatePaths({ repoRoot, name });
  const cfg = fs.existsSync(paths.json) ? readJson(paths.json) : null;
  const pidText = fs.existsSync(paths.pid) ? fs.readFileSync(paths.pid, 'utf8').trim() : '';
  const pid = pidText ? Number.parseInt(pidText, 10) : null;
  const alive = pid && Number.isFinite(pid) ? isAlive(pid) : false;
  const listening = await isTcpListening({ host, port: rpcPort, timeoutMs: 250 });

  return {
    type: 'sol_local_status',
    name,
    host,
    rpc_port: rpcPort,
    rpc_url: `http://${host}:${rpcPort}`,
    pid: alive ? pid : null,
    alive: Boolean(alive),
    rpc_listening: Boolean(listening),
    log: cfg?.log || paths.log,
    ledger_dir: cfg?.ledger_dir || null,
    program_id: cfg?.program_id || null,
    so_path: cfg?.so_path || null,
    started_at: cfg?.started_at || null,
  };
}

export async function solLocalStart({
  repoRoot = process.cwd(),
  name = 'local',
  host = '127.0.0.1',
  rpcPort = 8899,
  faucetPort = 9900,
  ledgerDir = '',
  programId,
  soPath = '',
  reset = false,
  quiet = true,
  logPath = '',
  readyTimeoutMs = 60_000,
} = {}) {
  const paths = solLocalStatePaths({ repoRoot, name });

  const pidText = fs.existsSync(paths.pid) ? fs.readFileSync(paths.pid, 'utf8').trim() : '';
  const existingPid = pidText ? Number.parseInt(pidText, 10) : null;
  if (existingPid && Number.isFinite(existingPid) && isAlive(existingPid)) {
    return {
      type: 'sol_local_already_running',
      name,
      host,
      rpc_port: rpcPort,
      rpc_url: `http://${host}:${rpcPort}`,
      pid: existingPid,
      log: paths.log,
    };
  }

  const ledger =
    resolveOnchainDir(repoRoot, ledgerDir || path.join('onchain', 'solana', `ledger-${safeName(name)}`), {
      label: 'ledger_dir',
    });
  mkdirp(ledger);

  let so = String(soPath || '').trim();
  if (!so) {
    const candidate1 = path.join('solana', 'ln_usdt_escrow', 'target', 'deploy', 'ln_usdt_escrow.so');
    const candidate2 = path.join('onchain', 'solana', 'mainnet', 'ln_usdt_escrow.mainnet.so');
    if (fs.existsSync(resolveRepoPath(repoRoot, candidate1))) so = candidate1;
    else if (fs.existsSync(resolveRepoPath(repoRoot, candidate2))) so = candidate2;
  }
  if (!so) {
    throw new Error(
      'Missing Solana program .so for local validator. Build it first (scripts/solprogctl.sh build) or provide so_path.'
    );
  }
  const soResolved = resolveWithinRepoRoot(repoRoot, so, { label: 'so_path', mustExist: true });
  const st = fs.statSync(soResolved);
  if (!st.isFile()) throw new Error(`so_path must be a file: ${soResolved}`);

  const log = logPath ? resolveOnchainDir(repoRoot, logPath, { label: 'log_path' }) : paths.log;
  mkdirp(path.dirname(log));

  if (!Number.isInteger(rpcPort) || rpcPort <= 0 || rpcPort > 65535) throw new Error('rpc_port must be a valid port');
  if (!Number.isInteger(faucetPort) || faucetPort <= 0 || faucetPort > 65535) throw new Error('faucet_port must be a valid port');
  if (!programId || typeof programId !== 'string') throw new Error('program_id is required');

  const args = [];
  if (reset) args.push('--reset');
  args.push('--ledger', ledger);
  args.push('--bind-address', host);
  args.push('--rpc-port', String(rpcPort));
  args.push('--faucet-port', String(faucetPort));
  args.push('--bpf-program', String(programId).trim(), soResolved);
  if (quiet) args.push('--quiet');

  const outFd = fs.openSync(log, 'a');
  const child = spawn('solana-test-validator', args, {
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
    pid: child.pid,
    host,
    rpc_port: rpcPort,
    faucet_port: faucetPort,
    rpc_url: `http://${host}:${rpcPort}`,
    ledger_dir: ledger,
    program_id: String(programId).trim(),
    so_path: soResolved,
    log,
    started_at: Date.now(),
    reset: Boolean(reset),
  });

  if (readyTimeoutMs > 0) {
    await waitForTcp({ host, port: rpcPort, timeoutMs: readyTimeoutMs });
  }

  return {
    type: 'sol_local_started',
    name,
    pid: child.pid,
    host,
    rpc_port: rpcPort,
    rpc_url: `http://${host}:${rpcPort}`,
    faucet_port: faucetPort,
    ledger_dir: ledger,
    program_id: String(programId).trim(),
    so_path: soResolved,
    log,
  };
}

export async function solLocalStop({
  repoRoot = process.cwd(),
  name = 'local',
  signal = 'SIGINT',
  waitMs = 5000,
} = {}) {
  const paths = solLocalStatePaths({ repoRoot, name });
  const pidText = fs.existsSync(paths.pid) ? fs.readFileSync(paths.pid, 'utf8').trim() : '';
  const pid = pidText ? Number.parseInt(pidText, 10) : null;
  if (!pid || !Number.isFinite(pid) || !isAlive(pid)) {
    try {
      fs.unlinkSync(paths.pid);
    } catch (_e) {}
    return { type: 'sol_local_not_running', name, pid: null };
  }

  if (!['SIGINT', 'SIGTERM', 'SIGKILL'].includes(signal)) throw new Error('signal must be SIGINT|SIGTERM|SIGKILL');
  process.kill(pid, signal);
  await waitForExit(pid, waitMs);
  try {
    fs.unlinkSync(paths.pid);
  } catch (_e) {}
  return { type: 'sol_local_stopped', name, pid };
}

