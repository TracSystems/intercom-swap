import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import './app.css';
import {
  chatAdd,
  chatClear,
  chatListBefore,
  chatListLatest,
  COLLINS_ACTIVITY_RETENTION_MS,
  COLLINS_SC_FEED_RETENTION_MS,
  dbPruneRetention,
  promptAdd,
  promptListBefore,
  promptListLatest,
  scAdd,
  scListBefore,
  scListLatest,
  setDbNamespace,
} from './lib/db';

type OracleSummary = { ok: boolean; ts: number | null; btc_usd: number | null; usdt_usd: number | null; btc_usdt: number | null };

const MAINNET_USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const SOL_TX_FEE_BUFFER_LAMPORTS = 50_000; // best-effort guardrail for claim/refund/transfer tx fees
const LN_ROUTE_FEE_BUFFER_MIN_SATS = 50;
const LN_ROUTE_FEE_BUFFER_BPS = 10; // 0.10%
const LN_OPEN_TX_FEE_BUFFER_MIN_SATS = 1_000;
const LN_OPEN_TX_WEIGHT_BUFFER_VB = 600; // conservative wallet funding tx estimate for channel open
const LND_NEW_ANCHOR_RESERVE_SATS = 10_000;
const MS_PER_HOUR = 60 * 60 * 1000;
const SWAP_WATCH_RETENTION_MS = 2 * MS_PER_HOUR;

type LnPeerSuggestion = { id: string; addr: string; uri: string; connected: boolean };

// Mainnet default channel peer (hub) used by Collin Channel Manager.
// This is intentionally opinionated to reduce "NO_ROUTE" incidents caused by isolated channel topology.
const ACINQ_NODE_ID = '03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f';
const ACINQ_PEER_ADDR = '3.33.236.230:9735';
const ACINQ_PEER_URI = `${ACINQ_NODE_ID}@${ACINQ_PEER_ADDR}`;

function isConnectedPeerFlag(v: any): boolean {
  if (v === undefined || v === null) return true;
  if (v === true) return true;
  if (v === false) return false;
  if (typeof v === 'number') return Number.isFinite(v) && v > 0;
  const s = String(v).trim().toLowerCase();
  if (!s) return true;
  return s === '1' || s === 'true' || s === 'yes' || s === 'connected';
}

function parseNodeIdFromPeerUri(raw: any): string | null {
  const peer = String(raw || '').trim();
  if (!peer) return null;
  const node = peer.includes('@') ? peer.slice(0, peer.indexOf('@')) : peer;
  const id = String(node || '').trim().toLowerCase();
  if (!/^[0-9a-f]{66}$/i.test(id)) return null;
  return id;
}

function collectLnPeerSuggestions(listPeersRaw: any): LnPeerSuggestion[] {
  const out: LnPeerSuggestion[] = [];
  const seen = new Set<string>();
  const peers = Array.isArray(listPeersRaw?.peers) ? listPeersRaw.peers : [];
  for (const p of peers) {
    const id = String((p as any)?.id || (p as any)?.pub_key || '').trim().toLowerCase();
    if (!/^[0-9a-f]{66}$/i.test(id)) continue;
    const connected = isConnectedPeerFlag((p as any)?.connected);
    const addrsRaw = Array.isArray((p as any)?.netaddr)
      ? (p as any).netaddr
      : typeof (p as any)?.address === 'string'
        ? [(p as any).address]
        : [];
    for (const a of addrsRaw) {
      const addr = String(a || '').replace(/^\\+/, '').trim();
      if (!addr || !addr.includes(':')) continue;
      const uri = `${id}@${addr}`;
      if (seen.has(uri)) continue;
      seen.add(uri);
      out.push({ id, addr, uri, connected });
    }
  }
  out.sort((a, b) => {
    if (a.connected !== b.connected) return a.connected ? -1 : 1;
    return a.uri.localeCompare(b.uri);
  });
  return out.slice(0, 20);
}

function extractLnOpenTxHint(out: any): { txid: string; channelPoint: string; shortId: string } {
  const txidCandidates = [
    out?.txid,
    out?.funding_txid,
    out?.fundingTxid,
    out?.tx_hash,
    out?.tx,
    out?.transaction_id,
  ];
  const pointCandidates = [
    out?.channel_point,
    out?.channelPoint,
    out?.channel_id,
    out?.short_channel_id,
  ];
  let txid = '';
  for (const c of txidCandidates) {
    const s = String(c || '').trim();
    if (/^[0-9a-f]{64}$/i.test(s)) {
      txid = s.toLowerCase();
      break;
    }
    // LND channel_point may contain "<txid>:<vout>".
    const m = s.match(/^([0-9a-f]{64}):\d+$/i);
    if (m) {
      txid = String(m[1]).toLowerCase();
      break;
    }
  }
  let channelPoint = '';
  for (const c of pointCandidates) {
    const s = String(c || '').trim();
    if (!s) continue;
    channelPoint = s;
    if (!txid) {
      const m = s.match(/^([0-9a-f]{64}):\d+$/i);
      if (m) txid = String(m[1]).toLowerCase();
    }
    break;
  }
  const shortId = String(out?.short_channel_id || '').trim();
  return { txid, channelPoint, shortId };
}

function isLnWalletLockedError(raw: any): boolean {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return false;
  return (
    s.includes('wallet locked') ||
    s.includes('wallet is locked') ||
    s.includes('wallet encrypted and locked') ||
    s.includes('unlock it to enable full rpc access') ||
    s.includes('unlock wallet') ||
    s.includes('must unlock wallet')
  );
}

function parseToolSearchTokens(input: string): string[] {
  const s = String(input || '').trim().toLowerCase();
  if (!s) return [];
  const raw = s.split(/[^a-z0-9_]+/g).map((t) => t.trim()).filter(Boolean);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of raw) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function toolSearchScore(
  tool: { name: string; description?: string | null },
  rawQuery: string,
  queryTokens: string[]
): number {
  const name = String(tool?.name || '').toLowerCase();
  const desc = String(tool?.description || '').toLowerCase();
  const q = String(rawQuery || '').trim().toLowerCase();
  if (!q) return 0;

  let score = 0;

  if (name === q) score += 10_000;
  else if (name.startsWith(q)) score += 6_000;
  else if (name.includes(q)) score += 3_000;
  else if (desc.includes(q)) score += 1_000;

  let matchedAnyToken = false;
  for (const t of queryTokens) {
    if (!t) continue;
    if (name === t) {
      score += 2_000;
      matchedAnyToken = true;
      continue;
    }
    if (name.startsWith(t)) {
      score += 1_400;
      matchedAnyToken = true;
      continue;
    }
    if (name.includes(t)) {
      score += 900;
      matchedAnyToken = true;
      continue;
    }
    if (desc.includes(t)) {
      score += 300;
      matchedAnyToken = true;
    }
  }

  // If there is a query and no name/description match at all, hide it.
  if (score <= 0 && queryTokens.length > 0 && !matchedAnyToken) return -1;
  return score;
}

function deriveScEventDedupKey(evt: any): string {
  if (!evt || typeof evt !== 'object') return '';
  const t = String((evt as any).type || '').trim();
  if (t !== 'sc_event') return '';
  const channel = String((evt as any).channel || '').trim();
  const kind = String((evt as any).kind || '').trim();
  const tradeId = String((evt as any).trade_id || '').trim();
  const msg = (evt as any).message && typeof (evt as any).message === 'object' ? (evt as any).message : null;
  const signer = String(msg?.signer || '').trim().toLowerCase();
  const sig = String(msg?.sig || '').trim().toLowerCase();
  if (signer && sig) return `sig:${channel}:${kind}:${tradeId}:${signer}:${sig}`;
  const seq = typeof (evt as any).seq === 'number' && Number.isFinite((evt as any).seq) ? Math.trunc((evt as any).seq) : 0;
  if (seq > 0) return `seq:${seq}`;
  if (!channel && !kind && !tradeId) return '';
  const ts =
    typeof (evt as any).ts === 'number' && Number.isFinite((evt as any).ts)
      ? Math.trunc((evt as any).ts)
      : msg && typeof msg.ts === 'number' && Number.isFinite(msg.ts)
        ? Math.trunc(msg.ts)
        : 0;
  return `evt:${channel}:${kind}:${tradeId}:${ts}`;
}

function eventTsMs(evt: any): number {
  if (!evt || typeof evt !== 'object') return 0;
  const directTs = typeof (evt as any).ts === 'number' ? (evt as any).ts : null;
  if (directTs !== null && Number.isFinite(directTs) && directTs > 0) return Math.trunc(directTs);
  const startedAt = typeof (evt as any).started_at === 'number' ? (evt as any).started_at : null;
  if (startedAt !== null && Number.isFinite(startedAt) && startedAt > 0) return Math.trunc(startedAt);
  const msgTs = typeof (evt as any)?.message?.ts === 'number' ? (evt as any).message.ts : null;
  if (msgTs !== null && Number.isFinite(msgTs) && msgTs > 0) return Math.trunc(msgTs);
  return 0;
}

function compareScEventsNewestFirst(a: any, b: any): number {
  const at = eventTsMs(a);
  const bt = eventTsMs(b);
  if (bt !== at) return bt - at;
  const adb = typeof a?.db_id === 'number' && Number.isFinite(a.db_id) ? Math.trunc(a.db_id) : -1;
  const bdb = typeof b?.db_id === 'number' && Number.isFinite(b.db_id) ? Math.trunc(b.db_id) : -1;
  if (bdb !== adb) return bdb - adb;
  const asq = typeof a?.seq === 'number' && Number.isFinite(a.seq) ? Math.trunc(a.seq) : -1;
  const bsq = typeof b?.seq === 'number' && Number.isFinite(b.seq) ? Math.trunc(b.seq) : -1;
  return bsq - asq;
}

function listingRepostKey(evt: any): string {
  if (!evt || typeof evt !== 'object') return '';
  const kind = String((evt as any)?.kind || (evt as any)?.message?.kind || '').trim().toLowerCase();
  if (kind !== 'swap.rfq' && kind !== 'swap.svc_announce' && kind !== 'swap.quote') return '';
  const tradeId = String((evt as any)?.trade_id || (evt as any)?.message?.trade_id || '').trim().toLowerCase();
  if (!tradeId) return '';
  const channel = String((evt as any)?.channel || '').trim().toLowerCase();
  const signer = String((evt as any)?.message?.signer || (evt as any)?.from || '').trim().toLowerCase();
  return `${kind}|${channel}|${tradeId}|${signer}`;
}

function dedupeListingRepostsLatest(events: any[]): any[] {
  if (!Array.isArray(events) || events.length < 2) return Array.isArray(events) ? events : [];
  const sorted = [...events].sort(compareScEventsNewestFirst);
  const seen = new Set<string>();
  const out: any[] = [];
  for (const e of sorted) {
    const key = listingRepostKey(e);
    if (!key) {
      out.push(e);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

const SC_UI_KIND_ALLOWLIST = new Set<string>([
  'swap.rfq',
  'swap.svc_announce',
  'swap.quote',
  'swap.accept',
  'swap.swap_invite',
  'swap.trade_lock',
  'swap.ln_paid',
  'swap.sol_claimed',
  'swap.sol_refunded',
  'swap.cancel',
]);

function shouldKeepScEventInUi(evt: any): boolean {
  if (!evt || typeof evt !== 'object') return false;
  const t = String((evt as any).type || '').trim();
  if (t !== 'sc_event') return true;
  const kind = String((evt as any).kind || (evt as any)?.message?.kind || '').trim();
  if (!kind) return false;
  return SC_UI_KIND_ALLOWLIST.has(kind);
}

function isSwapTradeChannelName(raw: any): boolean {
  const ch = String(raw || '').trim().toLowerCase();
  return ch.startsWith('swap:');
}

function isPendingLnChannelState(raw: any): boolean {
  const s = String(raw || '').trim().toLowerCase();
  return s.includes('pending');
}

function normalizeChannels(
  input: any,
  opts: { max?: number; dropSwapTradeChannels?: boolean } = {}
): string[] {
  const max = Number.isFinite(opts?.max as any) && Number(opts.max) > 0 ? Math.max(1, Math.trunc(Number(opts.max))) : 50;
  const dropSwapTradeChannels = opts?.dropSwapTradeChannels !== false;
  const out: string[] = [];
  const seen = new Set<string>();
  const list = Array.isArray(input) ? input : [];
  for (const cRaw of list) {
    const c = String(cRaw || '').trim();
    if (!c) continue;
    if (dropSwapTradeChannels && isSwapTradeChannelName(c)) continue;
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

function App() {
  const [activeTab, setActiveTab] = useState<
    | 'overview'
    | 'prompt'
    | 'sell_usdt'
    | 'sell_btc'
    | 'invites'
    | 'trade_actions'
    | 'refunds'
    | 'wallets'
    | 'console'
    | 'settings'
  >('overview');

  const [navOpen, setNavOpen] = useState(true);

  const [health, setHealth] = useState<{ ok: boolean; ts: number } | null>(null);
  const [tools, setTools] = useState<Array<any> | null>(null);

  const [sessionId, setSessionId] = useState<string>(() => {
    try {
      const v = String(window.localStorage.getItem('collin_prompt_session_id') || '').trim();
      if (v) return v;
    } catch (_e) {}
    const gen =
      (globalThis.crypto && typeof (globalThis.crypto as any).randomUUID === 'function'
        ? (globalThis.crypto as any).randomUUID()
        : `sess-${Date.now()}-${Math.random().toString(16).slice(2)}`) || `sess-${Date.now()}`;
    try {
      window.localStorage.setItem('collin_prompt_session_id', gen);
    } catch (_e) {}
    return gen;
  });
  const [autoApprove, setAutoApprove] = useState<boolean>(() => {
    try {
      const raw = String(window.localStorage.getItem('collin_auto_approve') || '').trim();
      if (!raw) return true; // default ON on first run
      return raw === '1';
    } catch (_e) {
      return true;
    }
  });
  const [runMode, setRunMode] = useState<'tool' | 'llm'>('tool');

  const [scConnected, setScConnected] = useState(false);
  const [scConnecting, setScConnecting] = useState(false);
  const [scStreamErr, setScStreamErr] = useState<string | null>(null);
  const [scChannels, setScChannels] = useState<string>('0000intercomswapbtcusdt');
  const [scSwapWatchChannels, setScSwapWatchChannelsState] = useState<string[]>([]);
  const scSwapWatchFirstSeenAtRef = useRef<Map<string, number>>(new Map());
  const [scFilter, setScFilter] = useState<{ channel: string; kind: string }>({ channel: '', kind: '' });
  const [showExpiredInvites, setShowExpiredInvites] = useState<boolean>(() => {
    try {
      return String(window.localStorage.getItem('collin_show_expired_invites') || '') === '1';
    } catch (_e) {
      return false;
    }
  });
  const [showDismissedInvites, setShowDismissedInvites] = useState<boolean>(() => {
    try {
      return String(window.localStorage.getItem('collin_show_dismissed_invites') || '') === '1';
    } catch (_e) {
      return false;
    }
  });
  // Used for expiry-based UI (invites, etc.). Without this, useMemo() caching can prevent items
  // from ever transitioning into "expired" if no new events arrive.
  const [uiNowMs, setUiNowMs] = useState<number>(() => Date.now());
  const [dismissedInviteTradeIds, setDismissedInviteTradeIds] = useState<Record<string, number>>(() => {
    try {
      const raw = String(window.localStorage.getItem('collin_dismissed_invites') || '').trim();
      if (!raw) return {};
      const obj: any = JSON.parse(raw);
      if (!obj || typeof obj !== 'object') return {};
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(obj)) {
        const key = String(k || '').trim();
        if (!key) continue;
        const n = typeof v === 'number' ? v : typeof v === 'string' && /^[0-9]+$/.test(v.trim()) ? Number.parseInt(v.trim(), 10) : 0;
        out[key] = Number.isFinite(n) && n > 0 ? n : Date.now();
      }
      return out;
    } catch (_e) {
      return {};
    }
  });

	  const [selected, setSelected] = useState<any>(null);

		  const [promptInput, setPromptInput] = useState('');
	  const [promptChat, setPromptChat] = useState<Array<{ id: number; role: 'user' | 'assistant'; ts: number; text: string }>>([]);
	  const promptChatListRef = useRef<HTMLDivElement | null>(null);
    const [promptChatFollowTail, setPromptChatFollowTail] = useState(true);
    const [promptChatUnseen, setPromptChatUnseen] = useState(0);
    const promptChatFollowTailRef = useRef(true);
	  const [toolFilter, setToolFilter] = useState('');
	  const [toolName, setToolName] = useState('');
	  const [toolArgsText, setToolArgsText] = useState('{\n  \n}');
  const [toolInputMode, setToolInputMode] = useState<'form' | 'json'>('form');
  const [toolArgsObj, setToolArgsObj] = useState<Record<string, any>>({});
  const [toolArgsParseErr, setToolArgsParseErr] = useState<string | null>(null);

  const [promptEvents, setPromptEvents] = useState<any[]>([]);
  const [scEvents, setScEvents] = useState<any[]>([]);
  const scEventsMax = 3000;
  const scEventDedupTtlMs = 20 * 60 * 1000;
  const scEventDedupMax = 20_000;
  const scEventDedupPruneEveryMs = 5000;
  const scEventDedupOverflowFactor = 1.2;
  const scEventUiFlushMs = 120;
  const scEventUiFlushBatch = 240;
  const scEventDedupRef = useRef<Map<string, number>>(new Map());
  const scEventDedupNextPruneAtRef = useRef<number>(0);
  const scPendingUiEventsRef = useRef<any[]>([]);
  const scUiFlushTimerRef = useRef<number | null>(null);
  const promptEventsMax = 3000;
  const promptChatMax = 1200;

  const [runBusy, setRunBusy] = useState(false);
  const [runErr, setRunErr] = useState<string | null>(null);
  const [stackOpBusy, setStackOpBusy] = useState(false);
  const [consoleEvents, setConsoleEvents] = useState<any[]>([]);
  const consoleEventsMax = 500;
  const consoleListRef = useRef<HTMLDivElement | null>(null);

  const [preflight, setPreflight] = useState<any>(null);
  const [preflightBusy, setPreflightBusy] = useState(false);
  const [tradeAutoWorkerEnabled, setTradeAutoWorkerEnabled] = useState<boolean>(true);
  const [tradeAutoTraceEnabled, setTradeAutoTraceEnabled] = useState<boolean>(false);
  const [envInfo, setEnvInfo] = useState<any>(null);
  const [envBusy, setEnvBusy] = useState(false);
  const [envErr, setEnvErr] = useState<string | null>(null);

  type ToastKind = 'info' | 'success' | 'error';
  type Toast = { id: string; kind: ToastKind; message: string; ts: number };
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastTimersRef = useRef<Map<string, any>>(new Map());
  function pushToast(kind: ToastKind, message: string, { ttlMs }: { ttlMs?: number } = {}) {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const ts = Date.now();
    const toast: Toast = { id, kind, message, ts };
    setToasts((prev) => [toast].concat(prev).slice(0, 6));
    const ttl = typeof ttlMs === 'number' ? ttlMs : kind === 'error' ? 10_000 : 4_500;
    const timer = setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
      toastTimersRef.current.delete(id);
    }, ttl);
    toastTimersRef.current.set(id, timer);
  }
  function dismissToast(id: string) {
    const t = toastTimersRef.current.get(id);
    if (t) clearTimeout(t);
    toastTimersRef.current.delete(id);
    setToasts((prev) => prev.filter((x) => x.id !== id));
  }
  useEffect(() => {
    return () => {
      for (const t of toastTimersRef.current.values()) clearTimeout(t);
      toastTimersRef.current.clear();
    };
  }, []);

  // Human-friendly funding helpers (so operators don’t have to fish JSON out of logs).
  const [lnFundingAddr, setLnFundingAddr] = useState<string | null>(null);
  const [lnFundingAddrErr, setLnFundingAddrErr] = useState<string | null>(null);
  const [solBalance, setSolBalance] = useState<any>(null);
  const [solBalanceErr, setSolBalanceErr] = useState<string | null>(null);
  const [walletUsdtMint, setWalletUsdtMint] = useState<string>(() => {
    try {
      return String(window.localStorage.getItem('collin_wallet_usdt_mint') || '').trim();
    } catch (_e) {
      return '';
    }
  });
  const walletUsdtMintEnvRef = useRef<string>('');
  const [walletUsdtAta, setWalletUsdtAta] = useState<string | null>(null);
  const [walletUsdtAtomic, setWalletUsdtAtomic] = useState<string | null>(null);
  const [walletUsdtErr, setWalletUsdtErr] = useState<string | null>(null);

  const [lnWithdrawTo, setLnWithdrawTo] = useState<string>('');
  const [lnWithdrawAmountSats, setLnWithdrawAmountSats] = useState<number | null>(null);
  const [lnWithdrawSatPerVbyte, setLnWithdrawSatPerVbyte] = useState<number>(2);
  const [lnRebalanceAmountSats, setLnRebalanceAmountSats] = useState<number>(10_000);
  const [lnRebalanceFeeLimitSat, setLnRebalanceFeeLimitSat] = useState<number>(50);
  const [lnRebalanceOutgoingChanId, setLnRebalanceOutgoingChanId] = useState<string>('');
  const [lnRebalanceOpen, setLnRebalanceOpen] = useState<boolean>(() => {
    try {
      return String(window.localStorage.getItem('collin_ln_rebalance_open') || '') === '1';
    } catch (_e) {
      return false;
    }
  });

  const [solSendTo, setSolSendTo] = useState<string>('');
  const [solSendLamports, setSolSendLamports] = useState<string | null>(null);

  const [usdtSendToOwner, setUsdtSendToOwner] = useState<string>('');
  const [usdtSendAtomic, setUsdtSendAtomic] = useState<string | null>(null);

  // Optional Solana priority fee overrides (applied to UI-driven Solana transactions).
  const [solCuLimit, setSolCuLimit] = useState<number>(() => {
    try {
      const v = Number.parseInt(String(window.localStorage.getItem('collin_sol_cu_limit') || '0'), 10);
      return Number.isFinite(v) ? Math.max(0, Math.min(1_400_000, Math.trunc(v))) : 0;
    } catch (_e) {
      return 0;
    }
  });
  const [solCuPrice, setSolCuPrice] = useState<number>(() => {
    try {
      const v = Number.parseInt(String(window.localStorage.getItem('collin_sol_cu_price') || '0'), 10);
      return Number.isFinite(v) ? Math.max(0, Math.min(1_000_000_000, Math.trunc(v))) : 0;
    } catch (_e) {
      return 0;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem('collin_sol_cu_limit', String(solCuLimit || 0));
      window.localStorage.setItem('collin_sol_cu_price', String(solCuPrice || 0));
    } catch (_e) {}
  }, [solCuLimit, solCuPrice]);

  useEffect(() => {
    try {
      window.localStorage.setItem('collin_prompt_session_id', String(sessionId || ''));
    } catch (_e) {}
  }, [sessionId]);

  useEffect(() => {
    try {
      const mint = walletUsdtMint.trim();
      if (!mint) return;
      window.localStorage.setItem('collin_wallet_usdt_mint', mint);
      const kind = String(envInfo?.env_kind || '').trim().toLowerCase();
      if (kind) window.localStorage.setItem(`collin_wallet_usdt_mint:${kind}`, mint);
    } catch (_e) {}
  }, [walletUsdtMint, envInfo?.env_kind]);

  useEffect(() => {
    // Keep the configured USDT mint scoped per env_kind (test vs mainnet).
    const kind = String(envInfo?.env_kind || '').trim().toLowerCase();
    if (!kind) return;
    if (walletUsdtMintEnvRef.current === kind) return;
    walletUsdtMintEnvRef.current = kind;
    try {
      const saved = String(window.localStorage.getItem(`collin_wallet_usdt_mint:${kind}`) || '').trim();
      if (saved) {
        setWalletUsdtMint(saved);
        return;
      }
    } catch (_e) {}
    if (kind === 'mainnet') setWalletUsdtMint(MAINNET_USDT_MINT);
  }, [envInfo?.env_kind]);

  useEffect(() => {
    try {
      window.localStorage.setItem('collin_show_expired_invites', showExpiredInvites ? '1' : '0');
    } catch (_e) {}
  }, [showExpiredInvites]);

  useEffect(() => {
    try {
      window.localStorage.setItem('collin_show_dismissed_invites', showDismissedInvites ? '1' : '0');
    } catch (_e) {}
  }, [showDismissedInvites]);

  useEffect(() => {
    try {
      window.localStorage.setItem('collin_dismissed_invites', JSON.stringify(dismissedInviteTradeIds || {}));
    } catch (_e) {}
  }, [dismissedInviteTradeIds]);

  useEffect(() => {
    // Best-effort UX: infer token mint from the most recent receipt, so operators immediately see the right USDT mint.
    if (walletUsdtMint.trim()) return;
    const rec = Array.isArray(preflight?.receipts) ? preflight.receipts[0] : null;
    const mint = String(rec?.sol_mint || '').trim();
    if (mint) setWalletUsdtMint(mint);
  }, [preflight?.receipts, walletUsdtMint]);

  useEffect(() => {
    // Platform fee is set by the Solana program config (not negotiated). Mirror it into the RFQ/Offer caps.
    const bps = typeof preflight?.sol_config?.fee_bps === 'number' ? Number(preflight.sol_config.fee_bps) : null;
    if (typeof bps === 'number' && Number.isFinite(bps) && bps >= 0) {
      setOfferMaxPlatformFeeBps(Math.trunc(bps));
      setRfqMaxPlatformFeeBps(Math.trunc(bps));
    }
  }, [preflight?.sol_config?.fee_bps]);

  const [lnPeerInput, setLnPeerInput] = useState<string>('');
  const [lnPeerAdvancedOpen, setLnPeerAdvancedOpen] = useState<boolean>(() => {
    try {
      return String(window.localStorage.getItem('collin_ln_peer_advanced_open') || '') === '1';
    } catch (_e) {
      return false;
    }
  });
  const [lnAutoPeerFailover, setLnAutoPeerFailover] = useState<boolean>(() => {
    try {
      return String(window.localStorage.getItem('collin_ln_auto_peer_failover') || '1') !== '0';
    } catch (_e) {
      return true;
    }
  });
  const [lnChannelAmountSats, setLnChannelAmountSats] = useState<number>(1_000_000);
  const [lnChannelPushSats, setLnChannelPushSats] = useState<number>(0);
  const [lnChannelSatPerVbyte, setLnChannelSatPerVbyte] = useState<number>(2);
  const [lnChannelCloseSatPerVbyte, setLnChannelCloseSatPerVbyte] = useState<number>(2);
  const [lnSpliceChannelId, setLnSpliceChannelId] = useState<string>('');
  const [lnSpliceRelativeSats, setLnSpliceRelativeSats] = useState<number>(100_000);
  const [lnSpliceSatPerVbyte, setLnSpliceSatPerVbyte] = useState<number>(2);
  const [lnSpliceMaxRounds, setLnSpliceMaxRounds] = useState<number>(24);
  const [lnSpliceSignFirst, setLnSpliceSignFirst] = useState<boolean>(false);
  const [lnSpliceOpen, setLnSpliceOpen] = useState<boolean>(() => {
    try {
      return String(window.localStorage.getItem('collin_ln_splice_open') || '') === '1';
    } catch (_e) {
      return false;
    }
  });
  const [lnLiquidityMode, setLnLiquidityMode] = useState<'single_channel' | 'aggregate'>(() => {
    try {
      const v = String(window.localStorage.getItem('collin_ln_liquidity_mode') || '').trim();
      if (v === 'aggregate') return 'aggregate';
    } catch (_e) {}
    return 'single_channel';
  });
  const [lnShowInactiveChannels, setLnShowInactiveChannels] = useState<boolean>(() => {
    try {
      return String(window.localStorage.getItem('collin_ln_show_inactive_channels') || '') === '1';
    } catch (_e) {
      return false;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem('collin_ln_liquidity_mode', lnLiquidityMode);
    } catch (_e) {}
  }, [lnLiquidityMode]);
  useEffect(() => {
    try {
      window.localStorage.setItem('collin_ln_auto_peer_failover', lnAutoPeerFailover ? '1' : '0');
    } catch (_e) {}
  }, [lnAutoPeerFailover]);
  useEffect(() => {
    try {
      window.localStorage.setItem('collin_ln_peer_advanced_open', lnPeerAdvancedOpen ? '1' : '0');
    } catch (_e) {}
  }, [lnPeerAdvancedOpen]);
  useEffect(() => {
    try {
      window.localStorage.setItem('collin_ln_splice_open', lnSpliceOpen ? '1' : '0');
    } catch (_e) {}
  }, [lnSpliceOpen]);
  useEffect(() => {
    try {
      window.localStorage.setItem('collin_ln_rebalance_open', lnRebalanceOpen ? '1' : '0');
    } catch (_e) {}
  }, [lnRebalanceOpen]);
  useEffect(() => {
    try {
      window.localStorage.setItem('collin_ln_show_inactive_channels', lnShowInactiveChannels ? '1' : '0');
    } catch (_e) {}
  }, [lnShowInactiveChannels]);
  useEffect(() => {
    // UX helper: default peer on mainnet is ACINQ (reduces NO_ROUTE incidents). On non-mainnet,
    // prefill from connected peers if available so operators don't start from an empty field.
    if (lnPeerInput.trim()) return;
    const kind = String(envInfo?.env_kind || '').trim().toLowerCase();
    if (kind === 'mainnet') {
      setLnPeerInput(ACINQ_PEER_URI);
      return;
    }
    const peers = collectLnPeerSuggestions(preflight?.ln_listpeers);
    const next = peers.find((p) => p.connected) || peers[0];
    if (next?.uri) setLnPeerInput(next.uri);
  }, [preflight?.ln_listpeers, lnPeerInput, envInfo?.env_kind]);

  useEffect(() => {
    // Auto-pick a channel for splice UI so operators are not blocked on an empty field.
    if (lnSpliceChannelId.trim()) return;
    const rows = Array.isArray((preflight as any)?.ln_summary?.channel_rows) ? (preflight as any).ln_summary.channel_rows : [];
    const next = rows.find((r: any) => Boolean(r?.active) && String(r?.id || '').trim()) || rows.find((r: any) => String(r?.id || '').trim());
    const id = String(next?.id || '').trim();
    if (id) setLnSpliceChannelId(id);
  }, [preflight?.ln_summary?.channel_rows, lnSpliceChannelId]);

  useEffect(() => {
    // For self-rebalance helper (LND), prefill a numeric chan_id if available.
    if (lnRebalanceOutgoingChanId.trim()) return;
    const rows = Array.isArray((preflight as any)?.ln_summary?.channel_rows) ? (preflight as any).ln_summary.channel_rows : [];
    const next =
      rows.find((r: any) => Boolean(r?.active) && /^[0-9]+$/.test(String(r?.chan_id || '').trim())) ||
      rows.find((r: any) => /^[0-9]+$/.test(String(r?.chan_id || '').trim()));
    const id = String(next?.chan_id || '').trim();
    if (id) setLnRebalanceOutgoingChanId(id);
  }, [preflight?.ln_summary?.channel_rows, lnRebalanceOutgoingChanId]);

  // Stack observer: lightweight operator signal when a previously-ready stack degrades.
  const stackOkRef = useRef<boolean | null>(null);
  const [, setStackLastOkTs] = useState<number | null>(null);

  // Sell USDT: offer announcer (non-binding discovery message).
  type OfferLine = { id: string; btc_sats: number; usdt_amount: string };
  const [offerName, setOfferName] = useState<string>('');
  const [offerLines, setOfferLines] = useState<OfferLine[]>(() => [
    { id: `offer-${Date.now()}-0`, btc_sats: 10_000, usdt_amount: '1000000' }, // 1.000000 USDT
  ]);
  const [offerMaxPlatformFeeBps, setOfferMaxPlatformFeeBps] = useState<number>(50); // 0.5%
  const [offerMaxTradeFeeBps, setOfferMaxTradeFeeBps] = useState<number>(50); // 0.5%
  const [offerMaxTotalFeeBps, setOfferMaxTotalFeeBps] = useState<number>(100); // 1.0%
  const [offerMinSolRefundWindowSec, setOfferMinSolRefundWindowSec] = useState<number>(72 * 3600);
  const [offerMaxSolRefundWindowSec, setOfferMaxSolRefundWindowSec] = useState<number>(7 * 24 * 3600);
  const [offerValidUntilUnix, setOfferValidUntilUnix] = useState<number>(() => Math.floor(Date.now() / 1000) + 72 * 3600);
  const [offerBusy, setOfferBusy] = useState(false);
  const [offerRunAsBot, setOfferRunAsBot] = useState<boolean>(false);
  const [offerBotIntervalSec, setOfferBotIntervalSec] = useState<number>(60);

  // Sell BTC: RFQ poster (binding direction BTC_LN->USDT_SOL).
  type RfqLine = { id: string; trade_id: string; btc_sats: number; usdt_amount: string };
  const [rfqChannel, setRfqChannel] = useState<string>('0000intercomswapbtcusdt');
  const [rfqLines, setRfqLines] = useState<RfqLine[]>(() => [
    { id: `rfq-${Date.now()}-0`, trade_id: `rfq-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`, btc_sats: 10_000, usdt_amount: '1000000' }, // 1.000000 USDT
  ]);
  const [rfqMaxPlatformFeeBps, setRfqMaxPlatformFeeBps] = useState<number>(50); // 0.5%
  const [rfqMaxTradeFeeBps, setRfqMaxTradeFeeBps] = useState<number>(50); // 0.5%
  const [rfqMaxTotalFeeBps, setRfqMaxTotalFeeBps] = useState<number>(100); // 1.0%
  const [rfqMinSolRefundWindowSec, setRfqMinSolRefundWindowSec] = useState<number>(72 * 3600);
  const [rfqMaxSolRefundWindowSec, setRfqMaxSolRefundWindowSec] = useState<number>(7 * 24 * 3600);
  const [rfqValidUntilUnix, setRfqValidUntilUnix] = useState<number>(() => Math.floor(Date.now() / 1000) + 72 * 3600);
  const [rfqBusy, setRfqBusy] = useState(false);
  const [rfqRunAsBot, setRfqRunAsBot] = useState<boolean>(false);
  const [rfqBotIntervalSec, setRfqBotIntervalSec] = useState<number>(60);
  const [sellUsdtInboxOpen, setSellUsdtInboxOpen] = useState<boolean>(() => {
    try {
      return String(window.localStorage.getItem('collin_sell_usdt_inbox_open') || '1') !== '0';
    } catch (_e) {
      return true;
    }
  });
  const [sellUsdtMyOpen, setSellUsdtMyOpen] = useState<boolean>(() => {
    try {
      return String(window.localStorage.getItem('collin_sell_usdt_my_open') || '1') !== '0';
    } catch (_e) {
      return true;
    }
  });
  const [sellBtcInboxOpen, setSellBtcInboxOpen] = useState<boolean>(() => {
    try {
      return String(window.localStorage.getItem('collin_sell_btc_inbox_open') || '1') !== '0';
    } catch (_e) {
      return true;
    }
  });
  const [sellBtcQuotesOpen, setSellBtcQuotesOpen] = useState<boolean>(() => {
    try {
      return String(window.localStorage.getItem('collin_sell_btc_quotes_open') || '1') !== '0';
    } catch (_e) {
      return true;
    }
  });
  const [sellBtcMyOpen, setSellBtcMyOpen] = useState<boolean>(() => {
    try {
      return String(window.localStorage.getItem('collin_sell_btc_my_open') || '1') !== '0';
    } catch (_e) {
      return true;
    }
  });
  const [knownChannelsOpen, setKnownChannelsOpen] = useState<boolean>(() => {
    try {
      return String(window.localStorage.getItem('collin_known_channels_open') || '') === '1';
    } catch (_e) {
      return false;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem('collin_auto_approve', autoApprove ? '1' : '0');
    } catch (_e) {}
  }, [autoApprove]);
  useEffect(() => {
    try {
      window.localStorage.setItem('collin_sell_usdt_inbox_open', sellUsdtInboxOpen ? '1' : '0');
    } catch (_e) {}
  }, [sellUsdtInboxOpen]);
  useEffect(() => {
    try {
      window.localStorage.setItem('collin_sell_usdt_my_open', sellUsdtMyOpen ? '1' : '0');
    } catch (_e) {}
  }, [sellUsdtMyOpen]);
  useEffect(() => {
    try {
      window.localStorage.setItem('collin_sell_btc_inbox_open', sellBtcInboxOpen ? '1' : '0');
    } catch (_e) {}
  }, [sellBtcInboxOpen]);
  useEffect(() => {
    try {
      window.localStorage.setItem('collin_sell_btc_quotes_open', sellBtcQuotesOpen ? '1' : '0');
    } catch (_e) {}
  }, [sellBtcQuotesOpen]);
  useEffect(() => {
    try {
      window.localStorage.setItem('collin_sell_btc_my_open', sellBtcMyOpen ? '1' : '0');
    } catch (_e) {}
  }, [sellBtcMyOpen]);
  useEffect(() => {
    try {
      window.localStorage.setItem('collin_known_channels_open', knownChannelsOpen ? '1' : '0');
    } catch (_e) {}
  }, [knownChannelsOpen]);
  const [leaveChannel, setLeaveChannel] = useState<string>('');
  const [leaveBusy, setLeaveBusy] = useState(false);

  // Local receipts-driven views (paginated; memory-safe).
  const [trades, setTrades] = useState<any[]>([]);
  const [tradesOffset, setTradesOffset] = useState(0);
  const [tradesHasMore, setTradesHasMore] = useState(true);
  const [tradesLoading, setTradesLoading] = useState(false);
  const tradesLimit = 50;
  const tradesListRef = useRef<HTMLDivElement | null>(null);

  const [openRefunds, setOpenRefunds] = useState<any[]>([]);
  const [openRefundsOffset, setOpenRefundsOffset] = useState(0);
  const [openRefundsHasMore, setOpenRefundsHasMore] = useState(true);
  const [openRefundsLoading, setOpenRefundsLoading] = useState(false);
  const openRefundsLimit = 50;
  const openRefundsListRef = useRef<HTMLDivElement | null>(null);

  const [openClaims, setOpenClaims] = useState<any[]>([]);
  const [openClaimsOffset, setOpenClaimsOffset] = useState(0);
  const [openClaimsHasMore, setOpenClaimsHasMore] = useState(true);
		  const [openClaimsLoading, setOpenClaimsLoading] = useState(false);
		  const openClaimsLimit = 50;
		  const openClaimsListRef = useRef<HTMLDivElement | null>(null);

  // Receipts source picker: lets operators inspect receipts written by other helpers/bots too.
  type ReceiptsSource = { key: string; label: string; db: string; exists?: boolean };
  const [receiptsSourceKey, setReceiptsSourceKey] = useState<string>('default');
  const receiptsSources: ReceiptsSource[] = useMemo(() => {
    const out: ReceiptsSource[] = [];
    const srcRaw: any[] = Array.isArray((envInfo as any)?.receipts?.sources) ? ((envInfo as any).receipts.sources as any[]) : [];
    for (const s of srcRaw) {
      if (!s || typeof s !== 'object') continue;
      const key = String((s as any).key || '').trim();
      const label = String((s as any).label || '').trim() || key;
      const db = String((s as any).db || '').trim();
      const exists = (s as any).exists === undefined ? undefined : Boolean((s as any).exists);
      if (!key || !db) continue;
      out.push({ key, label, db, exists });
    }
    const envDb = String((envInfo as any)?.receipts?.db || '').trim();
    if (!out.find((s) => s.key === 'default') && envDb) {
      out.push({ key: 'default', label: 'default (setup.json)', db: envDb, exists: true });
    }
    out.sort((a, b) => {
      if (a.key === 'default' && b.key !== 'default') return -1;
      if (b.key === 'default' && a.key !== 'default') return 1;
      return a.label.localeCompare(b.label);
    });
    return out;
  }, [envInfo]);
  const selectedReceiptsSource: ReceiptsSource | null = useMemo(() => {
    if (receiptsSources.length < 1) return null;
    return receiptsSources.find((s) => s.key === receiptsSourceKey) || receiptsSources.find((s) => s.key === 'default') || receiptsSources[0] || null;
  }, [receiptsSources, receiptsSourceKey]);
  useEffect(() => {
    if (receiptsSources.length < 1) return;
    if (!receiptsSources.some((s) => s.key === receiptsSourceKey)) {
      setReceiptsSourceKey(receiptsSources.find((s) => s.key === 'default')?.key || receiptsSources[0].key);
    }
  }, [receiptsSources, receiptsSourceKey]);
  const receiptsDbArg = useMemo(() => {
    if (!selectedReceiptsSource) return {};
    if (selectedReceiptsSource.key === 'default') return {};
    return { db: selectedReceiptsSource.db };
  }, [selectedReceiptsSource]);

		  const scAbortRef = useRef<AbortController | null>(null);
		  const scStreamGenRef = useRef(0);
		  const scStreamWantedRef = useRef(true);
		  const promptAbortRef = useRef<AbortController | null>(null);

  const scListRef = useRef<HTMLDivElement | null>(null);
  const promptListRef = useRef<HTMLDivElement | null>(null);

  const scLoadingOlderRef = useRef(false);
  const promptLoadingOlderRef = useRef(false);
  const chatLoadingOlderRef = useRef(false);

  // Logs render newest-first. If the operator is scrolled away from the top, keep their viewport stable
  // when new events arrive (avoid jumpiness).
  useEffect(() => {
    promptChatFollowTailRef.current = promptChatFollowTail;
  }, [promptChatFollowTail]);

  const filteredScEvents = useMemo(() => {
    const chan = scFilter.channel.trim().toLowerCase();
    const kind = scFilter.kind.trim().toLowerCase();
    return scEvents.filter((e) => {
      const c = String((e as any)?.channel || (e as any)?.message?.channel || '').toLowerCase();
      const k = String((e as any)?.kind || (e as any)?.message?.kind || '').toLowerCase();
      if (chan && !c.includes(chan)) return false;
      if (kind && !k.includes(kind)) return false;
      return true;
    });
  }, [scEvents, scFilter]);
  const filteredScEventsDisplay = useMemo(() => dedupeListingRepostsLatest(filteredScEvents), [filteredScEvents]);

  const localPeerPubkeyHex = useMemo(() => {
    try {
      const scInfo = preflight?.sc_info && typeof preflight.sc_info === 'object' ? (preflight.sc_info as any) : null;
      const info = scInfo?.info && typeof scInfo.info === 'object' ? scInfo.info : null;
      const hex = info ? String(info.peerPubkey || '').trim() : '';
      return hex ? hex.toLowerCase() : '';
    } catch (_e) {
      return '';
    }
  }, [preflight?.sc_info]);

  const evtSignerHex = (evt: any) => {
    try {
      const s = String(evt?.message?.signer || evt?.from || '').trim();
      return s ? s.toLowerCase() : '';
    } catch (_e) {
      return '';
    }
  };

  const normalizeChatRole = (v: any): 'user' | 'assistant' => {
    return String(v || '').trim() === 'assistant' ? 'assistant' : 'user';
  };

  function finalEventContentJson(e: any) {
    // promptd emits {type:"final", content_json: {...}} (not wrapped).
    if (!e || typeof e !== 'object') return null;
    if (String((e as any).type || '') !== 'final') return null;
    const cj = (e as any).content_json;
    if (cj && typeof cj === 'object') return cj;
    const c = (e as any).content;
    if (typeof c === 'string' && c.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(c);
        return parsed && typeof parsed === 'object' ? parsed : null;
      } catch (_e) {}
    }
    return null;
  }

  function toolEventResultJson(e: any) {
    // promptd emits tool steps as {type:"tool", name:"...", result:{...}}.
    if (!e || typeof e !== 'object') return null;
    if (String((e as any).type || '') !== 'tool') return null;
    const r = (e as any).result;
    return r && typeof r === 'object' ? r : null;
  }

  const localPostedSigKeys = useMemo(() => {
    // Best-effort local outbox detection. Used to keep inboxes clean even before sc_info loads.
    const set = new Set<string>();
    const add = (env: any) => {
      try {
        const signer = String(env?.signer || '').trim().toLowerCase();
        const sig = String(env?.sig || '').trim().toLowerCase();
        if (signer && sig) set.add(`${signer}:${sig}`);
      } catch (_e) {}
    };

    // Prompt tool results (works even if the SC feed is down).
    for (const e of promptEvents) {
      try {
        const fin = finalEventContentJson(e);
        if (fin && typeof fin === 'object') {
          const t = String((fin as any).type || '').trim();
          if (t === 'offer_posted' || t === 'rfq_posted') add((fin as any).envelope);
        }
        const toolRes = toolEventResultJson(e);
        if (toolRes && typeof toolRes === 'object') {
          const t = String((toolRes as any).type || '').trim();
          if (t === 'offer_posted' || t === 'rfq_posted') add((toolRes as any).envelope);
        }
      } catch (_e) {}
    }

    // Also include outbound network echoes when we know the local signer.
    if (localPeerPubkeyHex) {
      for (const e of scEvents) {
        try {
          const k = String((e as any)?.kind || '');
          if (k !== 'swap.rfq' && k !== 'swap.svc_announce') continue;
          const signer = evtSignerHex(e);
          if (!signer || signer !== localPeerPubkeyHex) continue;
          add((e as any)?.message);
        } catch (_e) {}
      }
    }

    return set;
  }, [promptEvents, scEvents, localPeerPubkeyHex]);

  const rfqEvents = useMemo(() => {
    const out = filteredScEvents.filter((e) => {
      const k = String((e as any)?.kind || (e as any)?.message?.kind || '');
      if (k !== 'swap.rfq') return false;
      const signer = evtSignerHex(e);
      if (localPeerPubkeyHex && signer && signer === localPeerPubkeyHex) return false;
      try {
        const env = (e as any)?.message;
        const s = String(env?.signer || '').trim().toLowerCase();
        const sig = String(env?.sig || '').trim().toLowerCase();
        const key = s && sig ? `${s}:${sig}` : '';
        if (key && localPostedSigKeys.has(key)) return false;
      } catch (_e) {}
      return true;
    });
    return dedupeListingRepostsLatest(out);
  }, [filteredScEvents, localPeerPubkeyHex, localPostedSigKeys]);

  const offerEvents = useMemo(() => {
    const out = filteredScEvents.filter((e) => {
      const k = String((e as any)?.kind || (e as any)?.message?.kind || '');
      if (k !== 'swap.svc_announce') return false;
      const signer = evtSignerHex(e);
      if (localPeerPubkeyHex && signer && signer === localPeerPubkeyHex) return false;
      try {
        const env = (e as any)?.message;
        const s = String(env?.signer || '').trim().toLowerCase();
        const sig = String(env?.sig || '').trim().toLowerCase();
        const key = s && sig ? `${s}:${sig}` : '';
        if (key && localPostedSigKeys.has(key)) return false;
      } catch (_e) {}
      return true;
    });
    return dedupeListingRepostsLatest(out);
  }, [filteredScEvents, localPeerPubkeyHex, localPostedSigKeys]);

  const myOfferPosts = useMemo(() => {
    // Offer announcements we posted locally.
    // Primary source: prompt tool results (works even when sc/stream isn't connected yet).
    // Secondary source: outbound sidechannel log (covers autopost/bots which don't create prompt history entries).
    const out: any[] = [];
    const seen = new Set<string>();
    const envSigKey = (env: any) => {
      try {
        const signer = String(env?.signer || '').trim().toLowerCase();
        const sig = String(env?.sig || '').trim().toLowerCase();
        return signer && sig ? `${signer}:${sig}` : '';
      } catch (_e) {
        return '';
      }
    };
    for (const e of promptEvents) {
      try {
        const cj = finalEventContentJson(e);
        const tr = toolEventResultJson(e);
        const obj = cj && String((cj as any).type || '') === 'offer_posted'
          ? cj
          : tr && String((tr as any).type || '') === 'offer_posted'
            ? tr
            : null;
        if (!obj) continue;
        const env = (obj as any).envelope;
        if (!env || typeof env !== 'object') continue;
        const id = String(obj.svc_announce_id || '').trim();
        const key =
          id ||
          envSigKey(env) ||
          String(env.trade_id || env.tradeId || '') ||
          String((e as any).db_id || '') ||
          String(e.ts || '');
        if (!key) continue;
        if (seen.has(key)) continue;
        seen.add(key);

        const chans = Array.isArray(obj.channels) ? obj.channels.map((c: any) => String(c || '').trim()).filter(Boolean) : [];
        out.push({
          channel: chans[0] || '',
          channels: chans,
          rfq_channels: Array.isArray(obj.rfq_channels) ? obj.rfq_channels : [],
          trade_id: String(env.trade_id || env.tradeId || '').trim(),
          ts: typeof env.ts === 'number' ? env.ts : typeof e.ts === 'number' ? e.ts : Date.now(),
          message: env,
          kind: String(env.kind || ''),
          dir: 'out',
          local: true,
          svc_announce_id: id || null,
        });
      } catch (_e) {}
    }
    // Include outbound sc events (autopost/bots).
    for (const e of scEvents) {
      try {
        if (String((e as any)?.kind || '') !== 'swap.svc_announce') continue;
        const signer = evtSignerHex(e);
        if (!localPeerPubkeyHex || signer !== localPeerPubkeyHex) continue;
        const env = (e as any)?.message;
        const key = envSigKey(env) || String((e as any).db_id || (e as any).seq || (e as any).ts || '');
        if (!key) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(e);
      } catch (_e) {}
    }
    out.sort((a, b) => Number(b?.ts || 0) - Number(a?.ts || 0));
    return dedupeListingRepostsLatest(out);
  }, [promptEvents, scEvents, localPeerPubkeyHex]);

  const myRfqPosts = useMemo(() => {
    // RFQs we posted locally.
    // Primary source: prompt tool results (works even when sc/stream isn't connected yet).
    // Secondary source: outbound sidechannel log (covers autopost/bots).
    const out: any[] = [];
    const seen = new Set<string>();
    const envSigKey = (env: any) => {
      try {
        const signer = String(env?.signer || '').trim().toLowerCase();
        const sig = String(env?.sig || '').trim().toLowerCase();
        return signer && sig ? `${signer}:${sig}` : '';
      } catch (_e) {
        return '';
      }
    };
    for (const e of promptEvents) {
      try {
        const cj = finalEventContentJson(e);
        const tr = toolEventResultJson(e);
        const obj = cj && String((cj as any).type || '') === 'rfq_posted'
          ? cj
          : tr && String((tr as any).type || '') === 'rfq_posted'
            ? tr
            : null;
        if (!obj) continue;
        const env = (obj as any).envelope;
        if (!env || typeof env !== 'object') continue;
        const rfqId = String(obj.rfq_id || '').trim();
        const key =
          rfqId ||
          envSigKey(env) ||
          String(env.trade_id || env.tradeId || '') ||
          String((e as any).db_id || '') ||
          String(e.ts || '');
        if (!key) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          channel: String((obj as any).channel || '').trim(),
          trade_id: String(env.trade_id || env.tradeId || '').trim(),
          ts: typeof env.ts === 'number' ? env.ts : typeof e.ts === 'number' ? e.ts : Date.now(),
          message: env,
          kind: String(env.kind || ''),
          dir: 'out',
          local: true,
          rfq_id: rfqId || null,
        });
      } catch (_e) {}
    }
    for (const e of scEvents) {
      try {
        if (String((e as any)?.kind || '') !== 'swap.rfq') continue;
        const signer = evtSignerHex(e);
        if (!localPeerPubkeyHex || signer !== localPeerPubkeyHex) continue;
        const env = (e as any)?.message;
        const key = envSigKey(env) || String((e as any).db_id || (e as any).seq || (e as any).ts || '');
        if (!key) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(e);
      } catch (_e) {}
    }
    out.sort((a, b) => Number(b?.ts || 0) - Number(a?.ts || 0));
    return dedupeListingRepostsLatest(out);
  }, [promptEvents, scEvents, localPeerPubkeyHex]);

  const myRfqTradeIds = useMemo(() => {
    const out = new Set<string>();
    for (const e of myRfqPosts) {
      const tradeId = String((e as any)?.trade_id || (e as any)?.message?.trade_id || '').trim();
      if (tradeId) out.add(tradeId);
    }
    return out;
  }, [myRfqPosts]);

  const myRfqIds = useMemo(() => {
    const out = new Set<string>();
    for (const e of myRfqPosts) {
      const rfqId = String((e as any)?.rfq_id || '').trim().toLowerCase();
      if (/^[0-9a-f]{64}$/i.test(rfqId)) out.add(rfqId);
    }
    return out;
  }, [myRfqPosts]);

  const quoteEvents = useMemo(() => {
    const out: any[] = [];
    const seen = new Set<string>();
    for (const e of filteredScEvents) {
      try {
        const kind = String((e as any)?.kind || (e as any)?.message?.kind || '').trim();
        if (kind !== 'swap.quote') continue;
        const signer = evtSignerHex(e);
        if (localPeerPubkeyHex && signer && signer === localPeerPubkeyHex) continue;
        const msg = (e as any)?.message;
        const body = msg?.body && typeof msg.body === 'object' ? msg.body : {};
        const tradeId = String((e as any)?.trade_id || msg?.trade_id || '').trim();
        const rfqId = String(body?.rfq_id || '').trim().toLowerCase();
        const isMine = (tradeId && myRfqTradeIds.has(tradeId)) || (/^[0-9a-f]{64}$/i.test(rfqId) && myRfqIds.has(rfqId));
        if (!isMine) continue;
        const sig = String(msg?.sig || '').trim().toLowerCase();
        const key = sig || `${tradeId}|${String((e as any)?.db_id || (e as any)?.seq || (e as any)?.ts || '')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(e);
      } catch (_e) {}
    }
    out.sort((a, b) => Number((b as any)?.ts || 0) - Number((a as any)?.ts || 0));
    return dedupeListingRepostsLatest(out);
  }, [filteredScEvents, localPeerPubkeyHex, myRfqTradeIds, myRfqIds]);

  const joinedChannels = useMemo(() => {
    try {
      const chans = Array.isArray(preflight?.sc_stats?.channels) ? (preflight.sc_stats.channels as any[]) : [];
      const out = chans.map((c) => String(c || '').trim()).filter(Boolean);
      out.sort();
      return out;
    } catch (_e) {
      return [];
    }
  }, [preflight?.sc_stats]);

  const joinedChannelsSet = useMemo(() => new Set(joinedChannels), [joinedChannels]);

  // Terminal trades seen in local receipts. Use this in invite hygiene so stale invites disappear even if
  // we did not observe the terminal sidechannel message in the current stream window.
  const terminalReceiptTradeIdsSet = useMemo(() => {
    const out = new Set<string>();
    const addTrade = (t: any) => {
      const tradeId = String(t?.trade_id || '').trim();
      if (!tradeId) return;
      const state = String(t?.state || '').trim().toLowerCase();
      if (state === 'claimed' || state === 'refunded' || state === 'canceled' || state === 'cancelled') out.add(tradeId);
    };
    for (const t of trades) addTrade(t);
    for (const t of openClaims) addTrade(t);
    for (const t of openRefunds) addTrade(t);
    if (selected?.type === 'trade') addTrade(selected?.trade);
    return out;
  }, [trades, openClaims, openRefunds, selected]);

  // Terminal swap events observed on sidechannels and/or receipts. Once a trade is terminal, any lingering
  // swap_invite is treated as stale and auto-hygiene will leave its swap:* channel + hide the invite.
  const terminalTradeIdsSet = useMemo(() => {
    const out = new Set<string>(terminalReceiptTradeIdsSet);
    for (const e of scEvents) {
      try {
        const kind = String((e as any)?.kind || '').trim();
        if (kind !== 'swap.sol_claimed' && kind !== 'swap.sol_refunded' && kind !== 'swap.cancel') continue;
        const msg = (e as any)?.message;
        const tradeId = String((e as any)?.trade_id || msg?.trade_id || '').trim();
        if (tradeId) out.add(tradeId);
      } catch (_e) {}
    }
    return out;
  }, [scEvents, terminalReceiptTradeIdsSet]);

  const rendezvousChannels = useMemo(
    () => normalizeChannels(scChannels.split(',').map((s) => s.trim()).filter(Boolean), { max: 50, dropSwapTradeChannels: true }),
    [scChannels]
  );

  const rendezvousChannelsSet = useMemo(() => new Set(rendezvousChannels), [rendezvousChannels]);

  const watchedChannelsSet = useMemo(() => {
    const set = new Set<string>();
    for (const c of rendezvousChannels) set.add(c);
    for (const c of scSwapWatchChannels) set.add(c);
    return set;
  }, [rendezvousChannels, scSwapWatchChannels]);

 const inviteEvents = useMemo(() => {
    const now = uiNowMs;
    const out: any[] = [];
    const seen = new Set<string>();
    for (const e of scEvents) {
      try {
        if (String((e as any)?.kind || '') !== 'swap.swap_invite') continue;
        const msg = (e as any)?.message;
        const tradeId = String(msg?.trade_id || (e as any)?.trade_id || '').trim();
        const done = Boolean(tradeId && terminalTradeIdsSet.has(tradeId));
        const swapCh = String(msg?.body?.swap_channel || '').trim();
        const joined = Boolean(swapCh && (joinedChannelsSet.has(swapCh) || watchedChannelsSet.has(swapCh)));
        const expiresAtRaw = msg?.body?.invite?.payload?.expiresAt;
        const expiresAtMs = epochToMs(expiresAtRaw);
        const expired = expiresAtMs && Number.isFinite(expiresAtMs) && expiresAtMs > 0 ? now > expiresAtMs : false;
        if (expired && !showExpiredInvites) continue;
        // Once we've already joined a swap channel, keep the invites inbox actionable by default.
        if (joined && !showDismissedInvites) continue;
        // Trades that are already done (claimed/refunded/canceled) should not linger in the invites inbox.
        if (done && !showDismissedInvites) continue;
        if (tradeId && dismissedInviteTradeIds && dismissedInviteTradeIds[tradeId] && !showDismissedInvites) continue;

        const key = `${tradeId || ''}|${swapCh || ''}|${String((e as any)?.from || '')}|${String((e as any)?.seq || '')}`;
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        out.push({ ...e, _invite_expires_at_ms: expiresAtMs, _invite_expired: expired, _invite_joined: joined, _invite_done: done });
      } catch (_e) {}
    }
    return out;
  }, [scEvents, showExpiredInvites, dismissedInviteTradeIds, showDismissedInvites, uiNowMs, joinedChannelsSet, watchedChannelsSet, terminalTradeIdsSet]);

  const knownChannels = useMemo(() => {
    const set = new Set<string>();
    for (const e of scEvents) {
      const c = String((e as any)?.channel || '').trim();
      if (c) set.add(c);
    }
    for (const c of rendezvousChannels) set.add(c);
    for (const c of scSwapWatchChannels) set.add(c);
    try {
      const joined = Array.isArray(preflight?.sc_stats?.channels) ? (preflight.sc_stats.channels as any[]) : [];
      for (const c of joined) {
        const ch = String(c || '').trim();
        if (ch) set.add(ch);
      }
    } catch (_e) {}
    return Array.from(set).sort();
  }, [scEvents, rendezvousChannels, scSwapWatchChannels, preflight?.sc_stats]);
  const knownChannelsForInputs = useMemo(() => knownChannels.slice(0, 500), [knownChannels]);
  const knownRendezvousChannelsForInputs = useMemo(
    () => knownChannelsForInputs.filter((c) => !isSwapTradeChannelName(c)),
    [knownChannelsForInputs]
  );

  useEffect(() => {
    if (!isSwapTradeChannelName(rfqChannel)) return;
    const next = knownRendezvousChannelsForInputs[0] || rendezvousChannels[0] || '0000intercomswapbtcusdt';
    if (next !== rfqChannel) setRfqChannel(next);
  }, [rfqChannel, knownRendezvousChannelsForInputs, rendezvousChannels]);

  const lnWalletLocked = useMemo(() => {
    const errs = [
      preflight?.ln_info_error,
      preflight?.ln_listfunds_error,
      preflight?.ln_listpeers_error,
      preflight?.ln_docker_ps_error,
      lnFundingAddrErr,
    ];
    return errs.some((e) => isLnWalletLockedError(e));
  }, [preflight?.ln_info_error, preflight?.ln_listfunds_error, preflight?.ln_listpeers_error, preflight?.ln_docker_ps_error, lnFundingAddrErr]);

  const lnWalletLockedMessage = useMemo(() => {
    const errs = [
      preflight?.ln_info_error,
      preflight?.ln_listfunds_error,
      preflight?.ln_listpeers_error,
      preflight?.ln_docker_ps_error,
      lnFundingAddrErr,
    ];
    for (const e of errs) {
      if (isLnWalletLockedError(e)) {
        return String(e || '').trim();
      }
    }
    return '';
  }, [preflight?.ln_info_error, preflight?.ln_listfunds_error, preflight?.ln_listpeers_error, preflight?.ln_docker_ps_error, lnFundingAddrErr]);

  // Stale swap-channel auto-leave is handled by backend tradeauto worker.
  // UI only auto-dismisses stale invites for a cleaner actionable inbox.

  // Auto-dismiss stale invites even if we aren't joined. This keeps the invites inbox actionable.
  const autoDismissTradeRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!health?.ok) return;
    const now = uiNowMs;
    const toDismiss: string[] = [];
    for (const e of scEvents) {
      try {
        if (String((e as any)?.kind || '') !== 'swap.swap_invite') continue;
        const msg = (e as any)?.message;
        const tradeId = String(msg?.trade_id || (e as any)?.trade_id || '').trim();
        if (!tradeId) continue;
        if (dismissedInviteTradeIds && dismissedInviteTradeIds[tradeId]) continue;
        if (autoDismissTradeRef.current.has(tradeId)) continue;
        const done = terminalTradeIdsSet.has(tradeId);
        const swapCh = String(msg?.body?.swap_channel || '').trim();
        const joined = Boolean(swapCh && (joinedChannelsSet.has(swapCh) || watchedChannelsSet.has(swapCh)));
        const expiresAtMs = epochToMs(msg?.body?.invite?.payload?.expiresAt) || 0;
        const expired = expiresAtMs && Number.isFinite(expiresAtMs) && expiresAtMs > 0 ? now > expiresAtMs : false;
        if (!done && !expired && !joined) continue;
        autoDismissTradeRef.current.add(tradeId);
        toDismiss.push(tradeId);
      } catch (_e) {}
    }
    if (toDismiss.length === 0) return;
    for (const tid of toDismiss.slice(0, 20)) dismissInviteTrade(tid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [health?.ok, scEvents, uiNowMs, dismissedInviteTradeIds, terminalTradeIdsSet, joinedChannelsSet, watchedChannelsSet]);
  function dismissInviteTrade(tradeIdRaw: string) {
    const tradeId = String(tradeIdRaw || '').trim();
    if (!tradeId) return;
    setDismissedInviteTradeIds((prev) => ({ ...(prev || {}), [tradeId]: Date.now() }));
  }

  function undismissInviteTrade(tradeIdRaw: string) {
    const tradeId = String(tradeIdRaw || '').trim();
    if (!tradeId) return;
    setDismissedInviteTradeIds((prev) => {
      const next = { ...(prev || {}) };
      delete next[tradeId];
      return next;
    });
  }

  function setRendezvousChannels(next: string[]) {
    const uniq = normalizeChannels(next.map((s) => String(s || '').trim()).filter(Boolean), { max: 50, dropSwapTradeChannels: true });
    setScChannels(uniq.join(','));
  }

  function setRendezvousChannelsFromInput(raw: string) {
    const uniq = normalizeChannels(
      String(raw || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      { max: 50, dropSwapTradeChannels: true }
    );
    setScChannels(uniq.join(','));
  }

  function setSwapWatchChannels(next: string[]) {
    const uniq = normalizeChannels(next.map((s) => String(s || '').trim()).filter(Boolean), { max: 50, dropSwapTradeChannels: false }).filter((c) =>
      isSwapTradeChannelName(c)
    );
    const now = Date.now();
    const prevSeen = scSwapWatchFirstSeenAtRef.current;
    const nextSeen = new Map<string, number>();
    for (const c of uniq) {
      const seenAt = Number(prevSeen.get(c) || 0);
      nextSeen.set(c, seenAt > 0 ? seenAt : now);
    }
    scSwapWatchFirstSeenAtRef.current = nextSeen;
    setScSwapWatchChannelsState(uniq);
  }

  function watchChannel(channelRaw: string) {
    const channel = String(channelRaw || '').trim();
    if (!channel) return;
    if (isSwapTradeChannelName(channel)) {
      if (scSwapWatchChannels.includes(channel)) return;
      setSwapWatchChannels([...scSwapWatchChannels, channel]);
    } else {
      if (rendezvousChannelsSet.has(channel)) return;
      setRendezvousChannels([...rendezvousChannels, channel]);
    }
    // Restart the stream quickly so the new channel appears without requiring a manual reconnect.
    setTimeout(() => void startScStream(), 150);
  }

  function unwatchChannel(channelRaw: string) {
    const channel = String(channelRaw || '').trim();
    if (!channel) return;
    if (isSwapTradeChannelName(channel)) {
      setSwapWatchChannels(scSwapWatchChannels.filter((c) => c !== channel));
    } else {
      setRendezvousChannels(rendezvousChannels.filter((c) => c !== channel));
    }
    setTimeout(() => void startScStream(), 150);
  }

  // Keep UI watchlist aligned with actual joined swap channels.
  // This prevents "joined but unwatched" confusion and ensures swap channel events are streamed in UI.
  useEffect(() => {
    if (!health?.ok) return;
    if (!Array.isArray(joinedChannels) || joinedChannels.length < 1) return;
    const missing: string[] = [];
    for (const chRaw of joinedChannels) {
      const ch = String(chRaw || '').trim();
      if (!ch || !ch.startsWith('swap:')) continue;
      if (watchedChannelsSet.has(ch)) continue;
      missing.push(ch);
    }
    if (missing.length < 1) return;
    setSwapWatchChannels([...scSwapWatchChannels, ...missing]);
    setTimeout(() => void startScStream(), 150);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [health?.ok, joinedChannels, watchedChannelsSet, scSwapWatchChannels]);

  // Invite/swap watch hygiene: drop swap:* watch channels once first seen age exceeds 2h.
  useEffect(() => {
    if (!Array.isArray(scSwapWatchChannels) || scSwapWatchChannels.length < 1) return;
    const now = uiNowMs;
    const keep: string[] = [];
    const firstSeen = scSwapWatchFirstSeenAtRef.current;
    for (const ch of scSwapWatchChannels) {
      const seenAt = Number(firstSeen.get(ch) || 0);
      if (seenAt > 0 && now - seenAt > SWAP_WATCH_RETENTION_MS) continue;
      keep.push(ch);
    }
    if (keep.length === scSwapWatchChannels.length) return;
    setSwapWatchChannels(keep);
    setTimeout(() => void startScStream(), 150);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uiNowMs, scSwapWatchChannels]);

  async function acceptQuoteEnvelope(quoteEvt: any, opts: { origin: 'manual' }) {
    const channel = String((quoteEvt as any)?.channel || '').trim();
    const msg = quoteEvt?.message;
    if (!channel || !msg || typeof msg !== 'object') throw new Error('quote event missing channel/message');
    if (opts.origin === 'manual' && toolRequiresApproval('intercomswap_quote_accept') && !autoApprove) {
      const ok = window.confirm(`Accept quote now?\n\nchannel: ${channel}`);
      if (!ok) return null;
    }
    const out = await runToolFinal(
      'intercomswap_quote_accept',
      { channel, quote_envelope: msg, ln_liquidity_mode: lnLiquidityMode },
      { auto_approve: true }
    );
    const cj = out?.content_json;
    if (cj && typeof cj === 'object' && String((cj as any).type || '') === 'error') {
      throw new Error(String((cj as any).error || 'quote_accept failed'));
    }
    return cj && typeof cj === 'object' ? cj : null;
  }

  async function quoteFromRfqEnvelope(rfqEvt: any, opts: { origin: 'manual' }) {
    const channel = String((rfqEvt as any)?.channel || '').trim();
    const msg = rfqEvt?.message;
    if (!channel || !msg || typeof msg !== 'object') throw new Error('rfq event missing channel/message');
    const body = msg?.body && typeof msg.body === 'object' ? msg.body : {};
    const tradeFeeCollector = String(solSignerPubkey || '').trim();
    if (!tradeFeeCollector) {
      throw new Error('Solana signer pubkey unavailable (cannot set trade_fee_collector)');
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const quoteTtlSec = 180;
    const rfqValidUntilRaw = Number.parseInt(String((body as any)?.valid_until_unix ?? ''), 10);
    const rfqValidUntil = Number.isFinite(rfqValidUntilRaw) && rfqValidUntilRaw > 0 ? rfqValidUntilRaw : null;
    const candidateUntil = nowSec + quoteTtlSec;
    const validUntilUnix =
      rfqValidUntil && rfqValidUntil > nowSec + 5
        ? Math.max(nowSec + 10, Math.min(candidateUntil, rfqValidUntil))
        : candidateUntil;

    const minWinRaw = Number.parseInt(String((body as any)?.min_sol_refund_window_sec ?? ''), 10);
    const maxWinRaw = Number.parseInt(String((body as any)?.max_sol_refund_window_sec ?? ''), 10);
    const minWin = Number.isFinite(minWinRaw) ? minWinRaw : null;
    const maxWin = Number.isFinite(maxWinRaw) ? maxWinRaw : null;
    let refundWindowSec = 72 * 3600;
    if (typeof minWin === 'number') refundWindowSec = Math.max(refundWindowSec, minWin);
    if (typeof maxWin === 'number') refundWindowSec = Math.min(refundWindowSec, maxWin);
    refundWindowSec = Math.max(3600, Math.min(7 * 24 * 3600, Math.trunc(refundWindowSec)));

    if (opts.origin === 'manual' && toolRequiresApproval('intercomswap_quote_post_from_rfq') && !autoApprove) {
      const ok = window.confirm(`Post quote for this RFQ now?\n\nchannel: ${channel}`);
      if (!ok) return null;
    }
    const out = await runToolFinal(
      'intercomswap_quote_post_from_rfq',
      {
        channel,
        rfq_envelope: msg,
        trade_fee_collector: tradeFeeCollector,
        sol_refund_window_sec: refundWindowSec,
        valid_until_unix: validUntilUnix,
      },
      { auto_approve: true }
    );
    const cj = out?.content_json;
    if (cj && typeof cj === 'object' && String((cj as any).type || '') === 'error') {
      throw new Error(String((cj as any).error || 'quote_post_from_rfq failed'));
    }
    return cj && typeof cj === 'object' ? cj : null;
  }

  function feedEventId(prefix: string, e: any, fallbackIndex?: number) {
    const db = typeof e?.db_id === 'number' ? e.db_id : null;
    if (db !== null) return `${prefix}db:${db}`;
    const seq = typeof e?.seq === 'number' ? e.seq : null;
    if (seq !== null) return `${prefix}seq:${seq}`;
    const sig = String(e?.message?.sig || '').trim().toLowerCase();
    if (sig) return `${prefix}sig:${sig}`;
    const trade = String(e?.trade_id || e?.message?.trade_id || '').trim().toLowerCase();
    const ts = typeof e?.ts === 'number' ? e.ts : '';
    const kind = String(e?.kind || e?.message?.kind || '').trim().toLowerCase();
    if (trade || ts || kind) return `${prefix}${kind}:${trade}:${ts}`;
    if (typeof fallbackIndex === 'number') return `${prefix}idx:${fallbackIndex}`;
    return `${prefix}x`;
  }

  function toggleSellUsdtSection(section: 'inbox' | 'mine') {
    if (section === 'inbox') {
      setSellUsdtInboxOpen((prev) => {
        const next = !prev;
        if (next) setSellUsdtMyOpen(false);
        return next;
      });
      return;
    }
    setSellUsdtMyOpen((prev) => {
      const next = !prev;
      if (next) setSellUsdtInboxOpen(false);
      return next;
    });
  }

  function toggleSellBtcSection(section: 'offers' | 'quotes' | 'mine') {
    if (section === 'offers') {
      setSellBtcInboxOpen((prev) => {
        const next = !prev;
        if (next) {
          setSellBtcQuotesOpen(false);
          setSellBtcMyOpen(false);
        }
        return next;
      });
      return;
    }
    if (section === 'quotes') {
      setSellBtcQuotesOpen((prev) => {
        const next = !prev;
        if (next) {
          setSellBtcInboxOpen(false);
          setSellBtcMyOpen(false);
        }
        return next;
      });
      return;
    }
    setSellBtcMyOpen((prev) => {
      const next = !prev;
      if (next) {
        setSellBtcInboxOpen(false);
        setSellBtcQuotesOpen(false);
      }
      return next;
    });
  }

  const sellUsdtFeedItems = useMemo(() => {
    const out: any[] = [];
    out.push({ _t: 'header', id: 'h:inboxrfqs', title: 'BTC Sales', count: rfqEvents.length, open: sellUsdtInboxOpen, onToggle: () => toggleSellUsdtSection('inbox') });
    if (sellUsdtInboxOpen) {
      for (let i = 0; i < rfqEvents.length; i += 1) {
        const e = rfqEvents[i];
        out.push({ _t: 'rfq', id: feedEventId('inrfq:', e, i), evt: e });
      }
    }
    out.push({ _t: 'header', id: 'h:myoffers', title: 'My USDT Sales', count: myOfferPosts.length, open: sellUsdtMyOpen, onToggle: () => toggleSellUsdtSection('mine') });
    if (sellUsdtMyOpen) {
      for (let i = 0; i < myOfferPosts.length; i += 1) {
        const e = myOfferPosts[i];
        out.push({ _t: 'offer', id: feedEventId('myoffer:', e, i), evt: e, badge: 'outbox' });
      }
    }
    return out;
  }, [myOfferPosts, rfqEvents, sellUsdtInboxOpen, sellUsdtMyOpen]);

  const sellBtcFeedItems = useMemo(() => {
    const out: any[] = [];
    out.push({ _t: 'header', id: 'h:inboxoffers', title: 'USDT Sales', count: offerEvents.length, open: sellBtcInboxOpen, onToggle: () => toggleSellBtcSection('offers') });
    if (sellBtcInboxOpen) {
      for (let i = 0; i < offerEvents.length; i += 1) {
        const e = offerEvents[i];
        out.push({ _t: 'offer', id: feedEventId('inoffer:', e, i), evt: e });
      }
    }
    out.push({ _t: 'header', id: 'h:inboxquotes', title: 'Exact Matches', count: quoteEvents.length, open: sellBtcQuotesOpen, onToggle: () => toggleSellBtcSection('quotes') });
    if (sellBtcQuotesOpen) {
      for (let i = 0; i < quoteEvents.length; i += 1) {
        const e = quoteEvents[i];
        out.push({ _t: 'quote', id: feedEventId('inq:', e, i), evt: e });
      }
    }
    out.push({ _t: 'header', id: 'h:myrfqs', title: 'My BTC Sales', count: myRfqPosts.length, open: sellBtcMyOpen, onToggle: () => toggleSellBtcSection('mine') });
    if (sellBtcMyOpen) {
      for (let i = 0; i < myRfqPosts.length; i += 1) {
        const e = myRfqPosts[i];
        out.push({ _t: 'rfq', id: feedEventId('myrfq:', e, i), evt: e, badge: 'outbox' });
      }
    }
    return out;
  }, [offerEvents, quoteEvents, myRfqPosts, sellBtcInboxOpen, sellBtcQuotesOpen, sellBtcMyOpen]);

  function oldestDbId(list: any[]) {
    let min = Number.POSITIVE_INFINITY;
    for (const e of list) {
      const id = typeof e?.db_id === 'number' ? e.db_id : null;
      if (id !== null && Number.isFinite(id) && id < min) min = id;
    }
    return Number.isFinite(min) ? min : null;
  }

  async function loadOlderScEvents({ limit = 200 } = {}) {
    if (scLoadingOlderRef.current) return;
    const beforeId = oldestDbId(scEvents);
    if (!beforeId) return;
    scLoadingOlderRef.current = true;
    try {
      const older = await scListBefore({ beforeId, limit });
      if (!older || older.length === 0) return;
      const cutoff = Date.now() - COLLINS_SC_FEED_RETENTION_MS;
      const mapped = older
        .map((r) => ({ ...(r.evt || {}), db_id: r.id }))
        .filter((e) => {
          const ts = eventTsMs(e);
          return ts <= 0 || ts >= cutoff;
        });
      if (mapped.length < 1) return;
      setScEvents((prev) => {
        const seen = new Set(prev.map((e) => e?.db_id).filter((n) => typeof n === 'number'));
        const toAdd = mapped.filter((e) => typeof e?.db_id === 'number' && !seen.has(e.db_id));
        const next = prev.concat(toAdd);
        if (next.length <= scEventsMax) return next;
        // Keep newest window and drop oldest.
        return next.slice(0, scEventsMax);
      });
    } finally {
      scLoadingOlderRef.current = false;
    }
  }

  async function loadOlderPromptEvents({ limit = 200 } = {}) {
    if (promptLoadingOlderRef.current) return;
    const beforeId = oldestDbId(promptEvents);
    if (!beforeId) return;
    promptLoadingOlderRef.current = true;
    try {
      const older = await promptListBefore({ beforeId, limit });
      if (!older || older.length === 0) return;
      const cutoff = Date.now() - COLLINS_ACTIVITY_RETENTION_MS;
      const mapped = older
        .map((r) => ({ ...(r.evt || {}), db_id: r.id }))
        .filter((e) => {
          const ts = eventTsMs(e);
          return ts <= 0 || ts >= cutoff;
        });
      if (mapped.length < 1) return;
      setPromptEvents((prev) => {
        const seen = new Set(prev.map((e) => e?.db_id).filter((n) => typeof n === 'number'));
        const toAdd = mapped.filter((e) => typeof e?.db_id === 'number' && !seen.has(e.db_id));
        const next = prev.concat(toAdd);
        if (next.length <= promptEventsMax) return next;
        return next.slice(0, promptEventsMax);
      });
    } finally {
      promptLoadingOlderRef.current = false;
    }
  }

  function oldestChatId(list: any[]) {
    if (!Array.isArray(list) || list.length === 0) return null;
    const first = list[0];
    const id = typeof first?.id === 'number' ? first.id : null;
    return id !== null && Number.isFinite(id) ? id : null;
  }

  async function loadOlderChatMessages({ limit = 200 } = {}) {
    if (chatLoadingOlderRef.current) return;
    const beforeId = oldestChatId(promptChat);
    if (!beforeId) return;
    chatLoadingOlderRef.current = true;

    const el = promptChatListRef.current;
    const prevHeight = el ? el.scrollHeight : 0;
    const prevTop = el ? el.scrollTop : 0;

    try {
      const older = await chatListBefore({ beforeId, limit });
      if (!older || older.length === 0) return;
      const cutoff = Date.now() - COLLINS_ACTIVITY_RETENTION_MS;
      // DB returns newest-first; chat UI wants oldest-first.
      const mapped = older
        .map((r: any) => ({ id: Number(r.id), role: normalizeChatRole(r.role), ts: Number(r.ts), text: String(r.text || '') }))
        .filter((m) => Number.isFinite(m.ts) && m.ts >= cutoff)
        .reverse();
      if (mapped.length < 1) return;
      setPromptChat((prev) => {
        const seen = new Set(prev.map((m) => m?.id).filter((n) => typeof n === 'number'));
        const toAdd = mapped.filter((m) => typeof m?.id === 'number' && !seen.has(m.id));
        const next = toAdd.concat(prev);
        // Keep chat memory bounded. If we exceed the window, drop newest items (operators can jump back to latest).
        if (next.length <= promptChatMax) return next;
        return next.slice(0, promptChatMax);
      });
      requestAnimationFrame(() => {
        const el2 = promptChatListRef.current;
        if (!el2) return;
        const delta = el2.scrollHeight - prevHeight;
        if (delta > 0) el2.scrollTop = prevTop + delta;
      });
    } finally {
      chatLoadingOlderRef.current = false;
    }
  }

  function normalizeToolList(raw: any): Array<{ name: string; description: string; parameters: any }> {
    const list = Array.isArray(raw?.tools) ? raw.tools : Array.isArray(raw) ? raw : [];
    const out: Array<{ name: string; description: string; parameters: any }> = [];
    for (const t of list) {
      const fn = t?.function;
      const name = String(fn?.name || '').trim();
      if (!name) continue;
      out.push({
        name,
        description: String(fn?.description || '').trim(),
        parameters: fn?.parameters ?? null,
      });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  const activeTool = useMemo(() => {
    if (!tools || !toolName) return null;
    return (tools as any[]).find((t: any) => t?.name === toolName) || null;
  }, [tools, toolName]);

  const scoredTools = useMemo(() => {
    const list = Array.isArray(tools) ? tools : [];
    const q = toolFilter.trim();
    const qTokens = parseToolSearchTokens(q);
    return list
      .map((t: any) => {
        const name = String(t?.name || '');
        const desc = String(t?.description || '');
        const score = toolSearchScore({ name, description: desc }, q, qTokens);
        return { tool: t, score, name };
      })
      .filter((row) => row.score >= 0)
      .sort((a, b) => (b.score - a.score) || String(a.name).localeCompare(String(b.name)));
  }, [tools, toolFilter]);

  const groupedTools = useMemo(() => {
    const groups: Record<string, any[]> = {};
    for (const row of scoredTools) {
      const t = row.tool;
      const name = String((t as any)?.name || '');
      const g = toolGroup(name);
      (groups[g] ||= []).push(t);
    }
    const order = [
      'SC-Bridge',
      'Peers',
      'RFQ Protocol',
      'Swap Helpers',
      'RFQ Bots',
      'Lightning',
      'Solana',
      'Receipts/Recovery',
      'Other',
    ];
    const out = [];
    for (const g of order) {
      const arr = groups[g];
      if (!arr || arr.length === 0) continue;
      arr.sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));
      out.push({ group: g, tools: arr });
    }
    return out;
  }, [scoredTools]);

  const toolSuggestions = useMemo(() => {
    const q = toolFilter.trim();
    if (!q) return [];
    return scoredTools.slice(0, 10).map((row) => row.tool);
  }, [scoredTools, toolFilter]);

  const activePeerState = useMemo(() => {
    const scPort = (() => {
      try {
        const u = new URL(String(envInfo?.sc_bridge?.url || '').trim() || 'ws://127.0.0.1:49222');
        const p = u.port ? Number.parseInt(u.port, 10) : 0;
        return Number.isFinite(p) && p > 0 ? p : 49222;
      } catch (_e) {
        return 49222;
      }
    })();
    const peers = Array.isArray(preflight?.peer_status?.peers) ? preflight.peer_status.peers : [];
    return peers.find((p: any) => Boolean(p?.alive) && Number(p?.sc_bridge?.port) === scPort) || null;
  }, [preflight?.peer_status, envInfo?.sc_bridge?.url]);

  const invitePolicy = useMemo(() => {
    const args = activePeerState?.args && typeof activePeerState.args === 'object' ? activePeerState.args : {};
    const inviteRequired = Boolean(args?.sidechannel_invite_required);
    const invitePrefixes = Array.isArray(args?.sidechannel_invite_prefixes)
      ? args.sidechannel_invite_prefixes.map((v: any) => String(v || '').trim()).filter(Boolean)
      : [];
    const inviterKeys = new Set(
      (Array.isArray(args?.sidechannel_inviter_keys) ? args.sidechannel_inviter_keys : [])
        .map((v: any) => String(v || '').trim().toLowerCase())
        .filter((v: string) => /^[0-9a-f]{64}$/.test(v))
    );
    const appliesToSwap =
      inviteRequired &&
      (invitePrefixes.length === 0 || invitePrefixes.some((p: string) => String('swap:trade').startsWith(String(p))));
    return {
      inviteRequired,
      invitePrefixes,
      inviterKeys,
      appliesToSwap,
      missingTrustedInviters: appliesToSwap && inviterKeys.size === 0,
    };
  }, [activePeerState]);

  const stackGate = useMemo(() => {
    const reasons: string[] = [];
    const okPromptd = Boolean(health?.ok);
    if (!okPromptd) reasons.push('promptd offline');

    const okChecklist = Boolean(preflight && typeof preflight === 'object');
    if (!okChecklist) reasons.push('checklist not run');

    const scPort = (() => {
      try {
        const u = new URL(String(envInfo?.sc_bridge?.url || '').trim() || 'ws://127.0.0.1:49222');
        const p = u.port ? Number.parseInt(u.port, 10) : 0;
        return Number.isFinite(p) && p > 0 ? p : 49222;
      } catch (_e) {
        return 49222;
      }
    })();
    const okPeer = Boolean(
      preflight?.peer_status?.peers?.some?.((p: any) => Boolean(p?.alive) && Number(p?.sc_bridge?.port) === scPort)
    );
    if (okChecklist && !okPeer) reasons.push('peer not running');

		    // Treat "connecting" as ok for gating so the UI doesn't hard-block on transient feed reconnects.
		    const okStream = Boolean(scConnected || scConnecting);
		    if (okChecklist && !okStream) reasons.push('sc/stream not connected');

    const okLnChannels = Boolean(preflight?.ln_summary?.channels_active && Number(preflight.ln_summary.channels_active) > 0);
    const okLn = okLnChannels && !preflight?.ln_listfunds_error && !lnWalletLocked;
    if (okChecklist && !okLn) {
      if (lnWalletLocked) reasons.push('Lightning wallet locked (unlock required)');
      else reasons.push('Lightning not ready (no channels)');
    }

    const solKind = String(preflight?.env?.solana?.classify?.kind || envInfo?.solana?.classify?.kind || '');
    const okSolRpc = solKind !== 'local' || Boolean(preflight?.sol_local_status?.rpc_listening);
    const okSolSigner = Boolean(preflight?.sol_signer?.pubkey) && !preflight?.sol_signer_error;
    const okSolConfig = !preflight?.sol_config_error;
    const okSol = okSolRpc && okSolSigner && okSolConfig;
    if (okChecklist && !okSol) reasons.push('Solana not ready');

    const okReceipts = !preflight?.receipts_error;
    if (okChecklist && !okReceipts) reasons.push('receipts not ready');

    const okApp = Boolean(preflight?.app?.app_hash) && !preflight?.app_error;
    if (okChecklist && !okApp) reasons.push('app binding missing');

    const invitePolicyWarning =
      okChecklist && invitePolicy.missingTrustedInviters
        ? 'No trusted inviter keys are preloaded yet. First valid signed swap-invite join will auto-learn and persist the inviter key.'
        : null;

    return {
      ok: okPromptd && okChecklist && okPeer && okStream && okLn && okSol && okReceipts && okApp,
      reasons,
      okPromptd,
      okChecklist,
      okPeer,
      okStream,
      okLn,
      lnWalletLocked,
      okSol,
      okReceipts,
      okApp,
      invitePolicyWarning,
    };
			  }, [health, preflight, scConnected, scConnecting, envInfo, invitePolicy.missingTrustedInviters, lnWalletLocked]);

  const stackAnyRunning = useMemo(() => {
    try {
      const scPort = (() => {
        try {
          const u = new URL(String(envInfo?.sc_bridge?.url || '').trim() || 'ws://127.0.0.1:49222');
          const p = u.port ? Number.parseInt(u.port, 10) : 0;
          return Number.isFinite(p) && p > 0 ? p : 49222;
        } catch (_e) {
          return 49222;
        }
      })();
      // Only consider the peer that matches *this* promptd instance (sc_bridge.url).
      const peerUp = Boolean(
        preflight?.peer_status?.peers?.some?.((p: any) => Boolean(p?.alive) && Number(p?.sc_bridge?.port) === scPort)
      );
      const solUp = Boolean(preflight?.sol_local_status?.alive) || Boolean(preflight?.sol_local_status?.rpc_listening);
      const dockerUp = Array.isArray(preflight?.ln_docker_ps?.services) && preflight.ln_docker_ps.services.length > 0;
      const lnUp = Boolean(preflight?.ln_summary?.channels_active && Number(preflight.ln_summary.channels_active) > 0) || dockerUp;
      return peerUp || solUp || lnUp;
    } catch (_e) {
      return false;
    }
  }, [preflight, envInfo?.sc_bridge?.url]);

  async function fetchJson(path: string, init?: RequestInit) {
    const res = await fetch(path, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(init?.headers || {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${res.status} ${res.statusText}${text ? `: ${text}` : ''}`);
    }
    return await res.json();
  }

  function setToolArgsBoth(obj: any) {
    const o = obj && typeof obj === 'object' ? obj : {};
    setToolArgsObj(o as any);
    setToolArgsText(JSON.stringify(o, null, 2));
  }

  async function runDirectToolOnce(name: string, args: any, { auto_approve = false } = {}) {
    const prompt = JSON.stringify({ type: 'tool', name, arguments: args && typeof args === 'object' ? args : {} });
    const out = await fetchJson('/v1/run', {
      method: 'POST',
      body: JSON.stringify({ prompt, session_id: sessionId, auto_approve, dry_run: false }),
    });
    if (out && typeof out === 'object') {
      if (out.content_json !== undefined) return out.content_json;
      if (typeof out.content === 'string') {
        try {
          return JSON.parse(out.content);
        } catch (_e) {}
      }
    }
    return out;
  }

  async function runToolFinal(name: string, args: any, { auto_approve = true } = {}) {
    const prompt = JSON.stringify({ type: 'tool', name, arguments: args && typeof args === 'object' ? args : {} });
    const out = await fetchJson('/v1/run', {
      method: 'POST',
      body: JSON.stringify({ prompt, session_id: sessionId, auto_approve, dry_run: false }),
    });
    if (out && typeof out === 'object' && out.session_id) setSessionId(String(out.session_id));
    // Persist a synthetic "final" event so local outbox lists work even if sc/stream doesn't echo.
    try {
      const ts = Date.now();
      await appendPromptEvent(
        {
          type: 'final',
          session_id: out?.session_id || sessionId,
          content: out?.content ?? null,
          content_json: out?.content_json ?? null,
          steps: Array.isArray(out?.steps) ? out.steps.length : out?.steps ? 1 : 0,
          ts,
        },
        { persist: true }
      );
    } catch (_e) {}
    return out;
  }

  async function stackStart() {
	    if (stackOpBusy) return;
	    setStackOpBusy(true);
	    setRunErr(null);
	    try {
	      pushToast('info', 'Starting stack (peer + LN + Solana). This can take ~1-2 minutes...', { ttlMs: 9000 });
	      const sidechannels = rendezvousChannels.slice(0, 50);

      setRunMode('tool');
      setToolName('intercomswap_stack_start');
      setToolArgsBoth({ sidechannels });

	      const final = await runPromptStream({
	        prompt: JSON.stringify({ type: 'tool', name: 'intercomswap_stack_start', arguments: { sidechannels } }),
	        session_id: sessionId,
	        auto_approve: true,
	        dry_run: false,
	      });

	      const cj = final && typeof final === 'object' ? (final as any).content_json : null;
	      const lnErr = cj && typeof cj === 'object' ? String((cj as any).ln_error || '').trim() : '';
	      const solErr = cj && typeof cj === 'object' ? String((cj as any).solana_error || '').trim() : '';
	      const tradeAutoErr =
	        cj && typeof cj === 'object' && (cj as any).trade_auto && typeof (cj as any).trade_auto === 'object'
	          ? String(((cj as any).trade_auto as any).error || '').trim()
	          : '';
	      if (lnErr || solErr || tradeAutoErr) {
	        pushToast('error', `Stack started with issues:\n${lnErr ? `- LN: ${lnErr}\n` : ''}${solErr ? `- Solana: ${solErr}\n` : ''}${tradeAutoErr ? `- Trade worker: ${tradeAutoErr}` : ''}`.trim(), {
	          ttlMs: 12_000,
	        });
	      } else if (final && typeof final === 'object' && String((final as any).type || '') === 'error') {
	        pushToast('error', String((final as any).error || 'stack start failed'));
      } else {
	        pushToast('success', 'Stack started');
	      }

      if (tradeAutoWorkerEnabled) {
        try {
          const channels = rendezvousChannels.slice(0, 64);
          await runToolFinal(
            'intercomswap_tradeauto_start',
            {
              channels: channels.length > 0 ? channels : ['0000intercomswapbtcusdt'],
              trace_enabled: tradeAutoTraceEnabled,
              ln_liquidity_mode: 'aggregate',
              enable_quote_from_offers: true,
              // Safety default: only quote RFQs when they match a local Offer line.
              enable_quote_from_rfqs: false,
              enable_accept_quotes: true,
              enable_invite_from_accepts: true,
              enable_join_invites: true,
              enable_settlement: true,
            },
            { auto_approve: true }
          );
          await runToolFinal('intercomswap_tradeauto_trace_set', { trace_enabled: tradeAutoTraceEnabled }, { auto_approve: true });
        } catch (_e) {}
      }

      // Refresh status and auto-connect the sidechannel stream once SC-Bridge is up.
      await refreshPreflight({ includeTradeAuto: true });
	      if (!scConnected && !scConnecting && scStreamWantedRef.current) {
	        await new Promise((r) => setTimeout(r, 250));
	        void startScStream();
	      }
	    } finally {
	      setStackOpBusy(false);
	    }
	  }

	  async function stackStop() {
	    if (stackOpBusy) return;
	    setStackOpBusy(true);
	    setRunErr(null);
	    try {
	      pushToast('info', 'Stopping stack...', { ttlMs: 6500 });
	      stopScStream();

      setRunMode('tool');
      setToolName('intercomswap_stack_stop');
      setToolArgsBoth({});

	      const final = await runPromptStream({
	        prompt: JSON.stringify({ type: 'tool', name: 'intercomswap_stack_stop', arguments: {} }),
	        session_id: sessionId,
	        auto_approve: true,
	        dry_run: false,
	      });
	      if (final && typeof final === 'object' && String((final as any).type || '') === 'error') {
	        pushToast('error', String((final as any).error || 'stack stop failed'));
	      } else {
	        pushToast('success', 'Stack stopped');
	      }
	      await refreshPreflight();
	    } finally {
	      setStackOpBusy(false);
	    }
	  }


  async function setTradeWorkerMode(next: boolean) {
    if (runBusy || stackOpBusy) return;
    setRunBusy(true);
    setRunErr(null);
    try {
      if (next) {
        const channels = rendezvousChannels.slice(0, 64);
        await runToolFinal(
          'intercomswap_tradeauto_start',
          {
            channels: channels.length > 0 ? channels : ['0000intercomswapbtcusdt'],
            trace_enabled: tradeAutoTraceEnabled,
            ln_liquidity_mode: 'aggregate',
            enable_quote_from_offers: true,
            // Safety default: only quote RFQs when they match a local Offer line.
            enable_quote_from_rfqs: false,
            enable_accept_quotes: true,
            enable_invite_from_accepts: true,
            enable_join_invites: true,
            enable_settlement: true,
          },
          { auto_approve: true }
        );
        await runToolFinal('intercomswap_tradeauto_trace_set', { trace_enabled: tradeAutoTraceEnabled }, { auto_approve: true });
      } else {
        await runToolFinal('intercomswap_tradeauto_stop', { reason: 'manual_stop' }, { auto_approve: true });
      }
      pushToast('success', `Trade worker ${next ? 'enabled' : 'disabled'}`);
      await refreshPreflight({ includeTradeAuto: true });
    } catch (e: any) {
      const msg = e?.message || String(e);
      setRunErr(msg);
      pushToast('error', `Trade worker toggle failed: ${msg}`);
    } finally {
      setRunBusy(false);
    }
  }

  async function setTradeTraceMode(next: boolean) {
    if (runBusy || stackOpBusy) return;
    setRunBusy(true);
    setRunErr(null);
    try {
      // Trace requires a running worker. If the worker is off, best-effort start it first.
      if (next && !(tradeAutoStatus?.running === true)) {
        const channels = rendezvousChannels.slice(0, 64);
        await runToolFinal(
          'intercomswap_tradeauto_start',
          {
            channels: channels.length > 0 ? channels : ['0000intercomswapbtcusdt'],
            trace_enabled: true,
            ln_liquidity_mode: 'aggregate',
            enable_quote_from_offers: true,
            // Safety default: only quote RFQs when they match a local Offer line.
            enable_quote_from_rfqs: false,
            enable_accept_quotes: true,
            enable_invite_from_accepts: true,
            enable_join_invites: true,
            enable_settlement: true,
          },
          { auto_approve: true }
        );
      }
      await runToolFinal('intercomswap_tradeauto_trace_set', { trace_enabled: next }, { auto_approve: true });
      pushToast('success', `Trade trace ${next ? 'enabled' : 'disabled'}`);
      await refreshPreflight({ includeTradeAuto: true });
    } catch (e: any) {
      const msg = e?.message || String(e);
      setRunErr(msg);
      pushToast('error', `Trade trace toggle failed: ${msg}`);
    } finally {
      setRunBusy(false);
    }
  }

  function stackBlockedToast(actionLabel: string) {
    const missing = stackGate.reasons.length > 0 ? stackGate.reasons.map((r) => `- ${r}`).join('\n') : '- unknown';
    pushToast('error', `${actionLabel}: stack not ready\n\nMissing:\n${missing}`);
  }

  async function recoverClaimForTrade(trade: any) {
    if (!stackGate.ok) return void stackBlockedToast('Claim');
    const trade_id = String(trade?.trade_id || '').trim();
    if (!trade_id) return void pushToast('error', 'Claim: missing trade_id');
    const state = String(trade?.state || '').trim();
    const preimage = String(trade?.ln_preimage_hex || '').trim();

    if (state === 'claimed') return void pushToast('success', `Already claimed (${trade_id})`);
    if (state === 'refunded') return void pushToast('info', `Already refunded (${trade_id})`);
    if (state !== 'ln_paid') return void pushToast('info', `Not claimable yet (state=${state || '?'})`);
    if (!preimage) return void pushToast('error', `Cannot claim: missing LN preimage in receipts (${trade_id})`);

	    try {
	      if (toolRequiresApproval('intercomswap_swaprecover_claim') && !autoApprove) {
	        const ok = window.confirm(`Claim escrow now?\n\ntrade_id: ${trade_id}`);
	        if (!ok) return;
	      }
		      await runToolFinal(
		        'intercomswap_swaprecover_claim',
		        {
		          ...receiptsDbArg,
		          trade_id,
		          ...(solCuLimit > 0 ? { cu_limit: solCuLimit } : {}),
		          ...(solCuPrice > 0 ? { cu_price: solCuPrice } : {}),
		        },
		        { auto_approve: true }
		      );
	      pushToast('success', `Claim submitted (${trade_id})`);
	      void loadTradesPage({ reset: true });
	      void loadOpenClaimsPage({ reset: true });
	      void loadOpenRefundsPage({ reset: true });
	    } catch (err: any) {
      pushToast('error', err?.message || String(err));
    }
  }

  async function recoverRefundForTrade(trade: any) {
    if (!stackGate.ok) return void stackBlockedToast('Refund');
    const trade_id = String(trade?.trade_id || '').trim();
    if (!trade_id) return void pushToast('error', 'Refund: missing trade_id');
    const state = String(trade?.state || '').trim();
    const refundAfterRaw = trade?.sol_refund_after_unix;
    const refundAfter =
      typeof refundAfterRaw === 'number'
        ? refundAfterRaw
        : typeof refundAfterRaw === 'string' && /^[0-9]+$/.test(refundAfterRaw.trim())
          ? Number.parseInt(refundAfterRaw.trim(), 10)
          : null;
    const nowSec = Math.floor(Date.now() / 1000);

    if (state === 'refunded') return void pushToast('success', `Already refunded (${trade_id})`);
    if (state === 'claimed') return void pushToast('info', `Already claimed (${trade_id})`);
    if (state !== 'escrow') return void pushToast('info', `Not refundable yet (state=${state || '?'})`);
    if (!refundAfter || !Number.isFinite(refundAfter) || refundAfter <= 0) {
      return void pushToast('info', `Refund not yet available (missing refund_after_unix) (${trade_id})`);
    }
    if (nowSec < refundAfter) {
      return void pushToast(
        'info',
        `Refund available after ${unixSecToUtcIso(refundAfter)} (${refundAfter}).\n\nWait: ${secToHuman(refundAfter - nowSec)}`
      );
    }

	    try {
	      if (toolRequiresApproval('intercomswap_swaprecover_refund') && !autoApprove) {
	        const ok = window.confirm(`Refund escrow now?\n\ntrade_id: ${trade_id}`);
	        if (!ok) return;
	      }
		      await runToolFinal(
		        'intercomswap_swaprecover_refund',
		        {
		          ...receiptsDbArg,
		          trade_id,
		          ...(solCuLimit > 0 ? { cu_limit: solCuLimit } : {}),
		          ...(solCuPrice > 0 ? { cu_price: solCuPrice } : {}),
		        },
		        { auto_approve: true }
		      );
	      pushToast('success', `Refund submitted (${trade_id})`);
	      void loadTradesPage({ reset: true });
	      void loadOpenRefundsPage({ reset: true });
	      void loadOpenClaimsPage({ reset: true });
	    } catch (err: any) {
      pushToast('error', err?.message || String(err));
    }
  }

  async function stopAutopostJob(nameRaw: string) {
    const name = String(nameRaw || '').trim();
    if (!name) return;
    try {
      const jobs = Array.isArray((preflight as any)?.autopost?.jobs) ? (preflight as any).autopost.jobs : [];
      const exists = jobs.some((j: any) => String(j?.name || '').trim() === name);
      if (!exists) {
        pushToast('info', `Bot already stopped or missing (${name})`);
        return;
      }
    } catch (_e) {}
    try {
      if (toolRequiresApproval('intercomswap_autopost_stop') && !autoApprove) {
        const ok = window.confirm(`Stop bot?\n\n${name}`);
        if (!ok) return;
      }
      await runToolFinal('intercomswap_autopost_stop', { name }, { auto_approve: true });
      pushToast('success', `Bot stopped (${name})`);
      void refreshPreflight();
    } catch (err: any) {
      pushToast('error', err?.message || String(err));
    }
  }

  async function ensureLnRegtestChannel() {
    const lnBackend = String(envInfo?.ln?.backend || '');
    const lnNetwork = String(envInfo?.ln?.network || '');
    const isRegtestDocker = lnBackend === 'docker' && lnNetwork === 'regtest';
    if (!isRegtestDocker) {
      pushToast('error', 'LN regtest bootstrap is only available in docker+regtest mode.');
      return;
    }
    if (runBusy || stackOpBusy) return;
    const channels = Number(preflight?.ln_summary?.channels || 0);
    const listfundsErr = String(preflight?.ln_listfunds_error || '').trim();
    if (channels > 0 && !listfundsErr) {
      pushToast('success', 'Lightning channel already exists');
      return;
    }
    const ok =
      autoApprove ||
      window.confirm(
        'Bootstrap LN regtest now?\n\nThis will mine blocks, fund both LN node wallets, and open a channel (docker-only).'
      );
    if (!ok) return;
    pushToast('info', 'Bootstrapping LN regtest (mine+fund+open). This can take ~1 minute...', { ttlMs: 9000 });
    const final = await runPromptStream({
      prompt: JSON.stringify({ type: 'tool', name: 'intercomswap_ln_regtest_init', arguments: {} }),
      session_id: sessionId,
      auto_approve: true,
      dry_run: false,
    });
    if (final && typeof final === 'object' && String((final as any).type || '') === 'error') {
      pushToast('error', String((final as any).error || 'LN bootstrap failed'));
    } else {
      pushToast('success', 'Lightning ready');
    }
    void refreshPreflight();
  }

  async function ensureSolLocalValidator() {
    const solKind = String(envInfo?.solana?.classify?.kind || '');
    if (solKind !== 'local') {
      pushToast('error', 'Local Solana bootstrap is only available when solana.rpc_url is localhost.');
      return;
    }
    if (runBusy || stackOpBusy) return;
    const ok =
      autoApprove ||
      window.confirm('Start local Solana validator now?\n\nThis will load the escrow program into solana-test-validator.');
    if (!ok) return;
    pushToast('info', 'Starting local Solana validator...', { ttlMs: 9000 });
    const final = await runPromptStream({
      prompt: JSON.stringify({ type: 'tool', name: 'intercomswap_sol_local_start', arguments: {} }),
      session_id: sessionId,
      auto_approve: true,
      dry_run: false,
    });
    if (final && typeof final === 'object' && String((final as any).type || '') === 'error') {
      pushToast('error', String((final as any).error || 'Solana local start failed'));
    } else {
      pushToast('success', 'Solana local validator ready');
    }
    void refreshPreflight();
  }

  async function unlockLnWallet() {
    const impl = String(envInfo?.ln?.impl || '').trim().toLowerCase();
    const backend = String(envInfo?.ln?.backend || '').trim().toLowerCase();
    if (impl !== 'lnd' || backend !== 'docker') {
      pushToast('error', 'Unlock helper supports LND+docker only. Unlock your LN wallet in backend, then refresh BTC.');
      return;
    }
    if (runBusy || stackOpBusy) return;
    const ok =
      autoApprove ||
      window.confirm(
        'Unlock Lightning wallet now?\n\nThis uses ln.wallet_password_file from prompt setup, or inferred files under onchain/lnd/<network>/ (maker.wallet-password.txt / taker.wallet-password.txt / wallet.pw).'
      );
    if (!ok) return;
    try {
      await runToolFinal('intercomswap_ln_unlock', {}, { auto_approve: true });
      setLnFundingAddrErr(null);
      pushToast('success', 'Lightning wallet unlocked');
      await refreshPreflight({ includeTradeAuto: tradeAutoTraceEnabled });
    } catch (err: any) {
      pushToast('error', err?.message || String(err));
    }
  }

  function ensureLnLiquidityForLines({
    role,
    lines,
    actionLabel,
    lnSummaryOverride,
  }: {
    role: 'send' | 'receive';
    lines: Array<{ btc_sats: number }>;
    actionLabel: string;
    lnSummaryOverride?: any;
  }): boolean {
    const lnSummary =
      lnSummaryOverride && typeof lnSummaryOverride === 'object'
        ? lnSummaryOverride
        : preflight && typeof preflight === 'object'
          ? (preflight as any).ln_summary
          : null;
    const required = lines
      .map((l) => Number(l?.btc_sats || 0))
      .filter((n) => Number.isInteger(n) && n > 0)
      .sort((a, b) => b - a);
    if (required.length < 1) return true;
    const lnActiveChannelCountNow = Number((lnSummary as any)?.channels_active || 0);
    if (lnActiveChannelCountNow < 1) {
      pushToast('error', `${actionLabel}: no active Lightning channels`);
      return false;
    }

    const maxSingle =
      role === 'send'
        ? typeof (lnSummary as any)?.max_outbound_sats === 'number'
          ? (lnSummary as any).max_outbound_sats
          : null
        : typeof (lnSummary as any)?.max_inbound_sats === 'number'
          ? (lnSummary as any).max_inbound_sats
          : null;
    const total =
      role === 'send'
        ? typeof (lnSummary as any)?.total_outbound_sats === 'number'
          ? (lnSummary as any).total_outbound_sats
          : null
        : typeof (lnSummary as any)?.total_inbound_sats === 'number'
          ? (lnSummary as any).total_inbound_sats
          : null;
    const roleLabel = role === 'send' ? 'outbound' : 'inbound';
    const rawNeeded = required[0];
    const lnFeeBuffer = role === 'send' ? Math.max(LN_ROUTE_FEE_BUFFER_MIN_SATS, Math.ceil(rawNeeded * (LN_ROUTE_FEE_BUFFER_BPS / 10_000))) : 0;
    const needed = rawNeeded + lnFeeBuffer;

    if (lnLiquidityMode === 'single_channel') {
      if (typeof maxSingle !== 'number' || maxSingle < needed) {
        pushToast(
          'error',
          `${actionLabel}: insufficient LN ${roleLabel} liquidity (mode=single_channel).\nneed ${needed} sats (includes ${lnFeeBuffer} sats LN fee buffer), have max ${
            typeof maxSingle === 'number' ? `${maxSingle} sats` : 'unknown'
          }.`
        );
        return false;
      }
      return true;
    }

    if (typeof total !== 'number' || total < needed) {
      pushToast(
        'error',
        `${actionLabel}: insufficient LN ${roleLabel} liquidity (mode=aggregate).\nneed ${needed} sats (includes ${lnFeeBuffer} sats LN fee buffer), have total ${
          typeof total === 'number' ? `${total} sats` : 'unknown'
        }.`
      );
      return false;
    }
    return true;
  }

  function ensureOfferFundingForLines({
    lines,
    maxTotalFeeBps,
    actionLabel,
    usdtAvailableOverrideAtomic,
  }: {
    lines: Array<{ btc_sats: number; usdt_amount: string }>;
    maxTotalFeeBps: number;
    actionLabel: string;
    usdtAvailableOverrideAtomic?: bigint | null;
  }): boolean {
    const usdtAvailableAtomic =
      typeof usdtAvailableOverrideAtomic === 'bigint'
        ? usdtAvailableOverrideAtomic
        : parseAtomicBigInt(walletUsdtAtomic) ?? parseAtomicBigInt((preflight as any)?.sol_usdt?.amount);
    if (usdtAvailableAtomic === null) {
      pushToast('error', `${actionLabel}: USDT wallet balance unavailable (refresh status first)`);
      return false;
    }

    const lamportsRaw = (preflight as any)?.sol_balance;
    const lamportsNum =
      typeof lamportsRaw === 'number'
        ? lamportsRaw
        : typeof lamportsRaw === 'string' && /^[0-9]+$/.test(lamportsRaw.trim())
          ? Number.parseInt(lamportsRaw.trim(), 10)
          : typeof (solBalance as any)?.lamports === 'number'
            ? Number((solBalance as any).lamports)
            : null;
    if (!Number.isFinite(lamportsNum as any) || Number(lamportsNum) < SOL_TX_FEE_BUFFER_LAMPORTS) {
      pushToast(
        'error',
        `${actionLabel}: low SOL for transaction fees (need at least ${SOL_TX_FEE_BUFFER_LAMPORTS} lamports buffer)`
      );
      return false;
    }

    const bps = Number.isFinite(maxTotalFeeBps) ? Math.max(0, Math.min(1500, Math.trunc(maxTotalFeeBps))) : 0;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const usdtAtomic = parseAtomicBigInt(line?.usdt_amount);
      if (usdtAtomic === null) continue;
      const required = applyBpsCeilAtomic(usdtAtomic, bps);
      if (required > usdtAvailableAtomic) {
        pushToast(
          'error',
          `${actionLabel}: line ${i + 1} exceeds USDT balance (need ${required.toString()} incl. fees, have ${usdtAvailableAtomic.toString()})`
        );
        return false;
      }
    }
    return true;
  }

  async function fetchFreshTradeGuardrailSnapshot({
    needLn,
    needUsdt,
  }: {
    needLn: boolean;
    needUsdt: boolean;
  }): Promise<{ lnSummary?: any; usdtAvailableAtomic?: bigint | null }> {
    const out: { lnSummary?: any; usdtAvailableAtomic?: bigint | null } = {};
    const tasks: Promise<void>[] = [];

    if (needLn) {
      tasks.push(
        (async () => {
          try {
            const [listfunds, listchannels] = await Promise.all([
              runDirectToolOnce('intercomswap_ln_listfunds', {}, { auto_approve: false }),
              runDirectToolOnce('intercomswap_ln_listchannels', {}, { auto_approve: false }),
            ]);
            const impl = String((envInfo as any)?.ln?.impl || (preflight as any)?.env?.ln?.impl || (preflight as any)?.ln_info?.implementation || '');
            const lnSummary = summarizeLn(listfunds, listchannels, impl);
            out.lnSummary = lnSummary;
            setPreflight((prev: any) =>
              prev && typeof prev === 'object'
                ? {
                    ...prev,
                    ln_listfunds: listfunds,
                    ln_channels: listchannels,
                    ln_summary: lnSummary,
                  }
                : prev
            );
          } catch (_e) {}
        })()
      );
    }

    if (needUsdt) {
      tasks.push(
        (async () => {
          const owner = String(solSignerPubkey || '').trim();
          const mint = String(walletUsdtMint || '').trim();
          if (!owner || !mint) return;
          try {
            const bal = await runDirectToolOnce(
              'intercomswap_sol_token_balance',
              { owner, mint },
              { auto_approve: false }
            );
            const amountAtomic = parseAtomicBigInt((bal as any)?.amount);
            if (amountAtomic === null) return;
            const ata = String((bal as any)?.ata || '').trim() || null;
            out.usdtAvailableAtomic = amountAtomic;
            setWalletUsdtAta(ata);
            setWalletUsdtAtomic(amountAtomic.toString());
            setWalletUsdtErr(null);
            setPreflight((prev: any) =>
              prev && typeof prev === 'object'
                ? {
                    ...prev,
                    sol_usdt: {
                      ...(prev?.sol_usdt && typeof prev.sol_usdt === 'object' ? prev.sol_usdt : {}),
                      ata,
                      amount: amountAtomic.toString(),
                    },
                  }
                : prev
            );
          } catch (_e) {}
        })()
      );
    }

    if (tasks.length > 0) await Promise.all(tasks);
    return out;
  }

  function adoptOfferIntoRfqDraft(offerEvt: any) {
    try {
      const msg = offerEvt?.message;
      const body = msg?.body;
      const offers = Array.isArray(body?.offers) ? body.offers : [];
      if (offers.length < 1) throw new Error('Offer has no offers[]');

      const rfqChans = Array.isArray(body?.rfq_channels)
        ? body.rfq_channels.map((c: any) => String(c || '').trim()).filter(Boolean)
        : [];
      const channelRaw =
        rfqChans[0] || String(offerEvt?.channel || '').trim() || rendezvousChannels[0] || '0000intercomswapbtcusdt';
      const channel = isSwapTradeChannelName(channelRaw)
        ? (rendezvousChannels[0] || '0000intercomswapbtcusdt')
        : channelRaw;

      // Adopt all offer lines (max 20). Each RFQ line has its own trade_id so multiple can run in parallel.
      const adoptedLines: RfqLine[] = [];
      const now = Date.now();
      for (let i = 0; i < offers.length && adoptedLines.length < 20; i += 1) {
        const o = offers[i] && typeof offers[i] === 'object' ? offers[i] : null;
        if (!o) continue;
        const btcSats = Number((o as any)?.btc_sats);
        const usdtAmount = String((o as any)?.usdt_amount || '').trim();
        if (!Number.isInteger(btcSats) || btcSats < 1) continue;
        if (!/^[0-9]+$/.test(usdtAmount)) continue;
        adoptedLines.push({
          id: `rfqline-${now}-${i}-${Math.random().toString(16).slice(2)}`,
          trade_id: `rfq-${now}-${i}-${Math.random().toString(16).slice(2, 10)}`,
          btc_sats: btcSats,
          usdt_amount: usdtAmount,
        });
      }
      if (adoptedLines.length < 1) throw new Error('Offer has no valid lines (btc_sats/usdt_amount)');

      const o0 = offers[0] && typeof offers[0] === 'object' ? offers[0] : null;
      const maxTrade = Number((o0 as any)?.max_trade_fee_bps);
      const maxTotal = Number((o0 as any)?.max_total_fee_bps);
      const minWin = Number((o0 as any)?.min_sol_refund_window_sec);
      const maxWin = Number((o0 as any)?.max_sol_refund_window_sec);

      const nowSec = Math.floor(Date.now() / 1000);
      const offerUntil = Number(body?.valid_until_unix);
      const until = Number.isFinite(offerUntil) && offerUntil > nowSec + 60 ? Math.trunc(offerUntil) : nowSec + 24 * 3600;

      setRfqChannel(channel);
      setRfqLines(adoptedLines);
      const SOL_REFUND_MIN_SEC = 3600;
      const SOL_REFUND_MAX_SEC = 7 * 24 * 3600;

      const warnings: string[] = [];
      const clampBps = (raw: number, cap: number, label: string) => {
        const n = Math.trunc(raw);
        const c = Math.max(0, Math.min(cap, n));
        if (c !== n) warnings.push(`${label} fee cap clamped: ${n} -> ${c} bps`);
        return c;
      };
      const clampSec = (raw: number, label: string) => {
        const n = Math.trunc(raw);
        const c = Math.min(SOL_REFUND_MAX_SEC, Math.max(SOL_REFUND_MIN_SEC, n));
        if (c !== n) warnings.push(`${label} sol window clamped: ${n} -> ${c} sec`);
        return c;
      };

      if (Number.isFinite(maxTrade)) setRfqMaxTradeFeeBps(clampBps(maxTrade, 1000, 'trade'));
      if (Number.isFinite(maxTotal)) setRfqMaxTotalFeeBps(clampBps(maxTotal, 1500, 'total'));

      let nextMinWin = Number.isFinite(minWin) ? clampSec(minWin, 'min') : rfqMinSolRefundWindowSec;
      let nextMaxWin = Number.isFinite(maxWin) ? clampSec(maxWin, 'max') : rfqMaxSolRefundWindowSec;
      if (nextMinWin > nextMaxWin) {
        warnings.push(`sol window invalid (min > max); adjusted max to ${nextMinWin}s`);
        nextMaxWin = nextMinWin;
      }
      setRfqMinSolRefundWindowSec(nextMinWin);
      setRfqMaxSolRefundWindowSec(nextMaxWin);
      setRfqValidUntilUnix(until);

      setActiveTab('sell_btc');
      if (warnings.length > 0) pushToast('info', warnings.join('\n'), { ttlMs: 10_000 });
      pushToast('info', `Offer loaded into New RFQ (${adoptedLines.length} line${adoptedLines.length === 1 ? '' : 's'}). Review then click “Post RFQ”.`, { ttlMs: 6500 });
    } catch (e: any) {
      pushToast('error', e?.message || String(e));
    }
  }

  async function postOffer() {
    if (offerBusy) return;
    if (!stackGate.ok) return void stackBlockedToast('Post offer');

	    const SOL_REFUND_MIN_SEC = 3600; // 1h
	    const SOL_REFUND_MAX_SEC = 7 * 24 * 3600; // 1w

	    const name = offerName.trim();

	    const lines = Array.isArray(offerLines) ? offerLines : [];
	    if (lines.length < 1) return void pushToast('error', 'Offer must include at least 1 line');
	    if (lines.length > 20) return void pushToast('error', 'Offer has too many lines (max 20)');
    for (let i = 0; i < lines.length; i += 1) {
      const l = lines[i];
      const btc = Number((l as any)?.btc_sats);
      const usdt = String((l as any)?.usdt_amount || '').trim();
      if (!Number.isInteger(btc) || btc < 1) return void pushToast('error', `Offer line ${i + 1}: BTC must be >= 1 sat`);
      if (!/^[0-9]+$/.test(usdt)) return void pushToast('error', `Offer line ${i + 1}: USDT must be a base-unit integer`);
    }
    const offerActionLabel = offerRunAsBot ? 'Start offer bot' : 'Post offer';
    const freshSnapshot = await fetchFreshTradeGuardrailSnapshot({ needLn: true, needUsdt: true });
    if (!ensureLnLiquidityForLines({ role: 'receive', lines, actionLabel: offerActionLabel, lnSummaryOverride: freshSnapshot.lnSummary })) return;
    if (
      !ensureOfferFundingForLines({
        lines,
        maxTotalFeeBps: offerMaxTotalFeeBps,
        actionLabel: offerActionLabel,
        usdtAvailableOverrideAtomic: freshSnapshot.usdtAvailableAtomic,
      })
    ) {
      return;
    }

	    if (offerMaxPlatformFeeBps + offerMaxTradeFeeBps > offerMaxTotalFeeBps) {
	      return void pushToast('error', 'Fee caps invalid: total must be >= platform + trade');
	    }
    if (offerMinSolRefundWindowSec > offerMaxSolRefundWindowSec) {
      return void pushToast('error', 'Solana refund window invalid: min must be <= max');
    }
    if (
      !Number.isInteger(offerMinSolRefundWindowSec) ||
      offerMinSolRefundWindowSec < SOL_REFUND_MIN_SEC ||
      offerMinSolRefundWindowSec > SOL_REFUND_MAX_SEC
    ) {
      return void pushToast('error', `Solana refund window invalid: min must be ${SOL_REFUND_MIN_SEC}s..${SOL_REFUND_MAX_SEC}s`);
    }
    if (
      !Number.isInteger(offerMaxSolRefundWindowSec) ||
      offerMaxSolRefundWindowSec < SOL_REFUND_MIN_SEC ||
      offerMaxSolRefundWindowSec > SOL_REFUND_MAX_SEC
    ) {
      return void pushToast('error', `Solana refund window invalid: max must be ${SOL_REFUND_MIN_SEC}s..${SOL_REFUND_MAX_SEC}s`);
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (!Number.isInteger(offerValidUntilUnix) || offerValidUntilUnix <= nowSec) {
      return void pushToast('error', 'Expiry must be in the future');
    }

	    const channels = rendezvousChannels.slice(0, 20);
	    if (channels.length < 1) return void pushToast('error', 'No rendezvous channels configured');

	    const autoName =
	      name ||
      (localPeerPubkeyHex
        ? `maker:${localPeerPubkeyHex.slice(0, 8)}`
        : `maker:${Math.random().toString(16).slice(2, 10)}`);

	    if (toolRequiresApproval('intercomswap_offer_post') && !autoApprove) {
	      const first = lines[0];
	      const ok = window.confirm(
	        `Post offer now?\n\nchannels: ${channels.join(', ')}\nlines: ${lines.length}\nline1 BTC: ${first?.btc_sats} sats\nline1 USDT: ${first?.usdt_amount}`
	      );
	      if (!ok) return;
	    }

    setOfferBusy(true);
    try {
	      const baseArgs = {
	        channels,
	        name: autoName,
	        rfq_channels: channels,
	        offers: lines.map((l) => ({
	          pair: 'BTC_LN/USDT_SOL',
	          have: 'USDT_SOL',
	          want: 'BTC_LN',
	          btc_sats: Number((l as any)?.btc_sats) || 0,
	          usdt_amount: String((l as any)?.usdt_amount || ''),
	          max_platform_fee_bps: offerMaxPlatformFeeBps,
	          max_trade_fee_bps: offerMaxTradeFeeBps,
	          max_total_fee_bps: offerMaxTotalFeeBps,
	          min_sol_refund_window_sec: offerMinSolRefundWindowSec,
	          max_sol_refund_window_sec: offerMaxSolRefundWindowSec,
	        })),
	      };

      if (!offerRunAsBot) {
        const args = { ...baseArgs, valid_until_unix: offerValidUntilUnix };
        const out = await runToolFinal('intercomswap_offer_post', args, { auto_approve: true });
        const cj = out?.content_json;
        if (cj && typeof cj === 'object' && cj.type === 'error') throw new Error(String(cj.error || 'offer_post failed'));
        const id = String(cj?.svc_announce_id || '').trim();
        pushToast('success', `Offer posted${id ? ` (${id.slice(0, 12)}…)` : ''}`);
      } else {
        const nowSec = Math.floor(Date.now() / 1000);
        const ttlSec = Math.max(10, Math.min(7 * 24 * 3600, Math.trunc(offerValidUntilUnix - nowSec)));
        const safeLabel = autoName.replaceAll(/[^A-Za-z0-9._-]/g, '_').slice(0, 28);
        const botName = `offer_${safeLabel}_${Date.now()}`.slice(0, 64);

        if (toolRequiresApproval('intercomswap_autopost_start') && !autoApprove) {
          const ok = window.confirm(`Start offer bot now?\n\nname: ${botName}\ninterval_sec: ${offerBotIntervalSec}\nttl_sec: ${ttlSec}`);
          if (!ok) return;
        }

        const out = await runToolFinal(
          'intercomswap_autopost_start',
          {
            name: botName,
            tool: 'intercomswap_offer_post',
            interval_sec: offerBotIntervalSec,
            ttl_sec: ttlSec,
            valid_until_unix: offerValidUntilUnix,
            args: baseArgs,
          },
          { auto_approve: true }
        );
        const cj = out?.content_json;
        if (cj && typeof cj === 'object' && cj.type === 'error') throw new Error(String(cj.error || 'autopost_start failed'));
        if (cj && typeof cj === 'object' && String((cj as any).type || '') === 'autopost_stopped') {
          pushToast('error', `Offer bot not started (${botName}): ${String((cj as any).reason || 'stopped')}`);
        } else {
          pushToast('success', `Offer bot started (${botName})`);
        }
        void refreshPreflight();
      }
    } catch (e: any) {
      pushToast('error', e?.message || String(e));
    } finally {
      setOfferBusy(false);
    }
  }

  async function postRfq() {
    if (rfqBusy) return;
    if (!stackGate.ok) return void stackBlockedToast('Post RFQ');

    const SOL_REFUND_MIN_SEC = 3600; // 1h
    const SOL_REFUND_MAX_SEC = 7 * 24 * 3600; // 1w

    const channel = rfqChannel.trim() || rendezvousChannels[0] || '';
    if (!channel) return void pushToast('error', 'RFQ channel is required');
    const solRecipient = String(solSignerPubkey || '').trim();
    if (!solRecipient) return void pushToast('error', 'Solana signer pubkey unavailable (cannot set RFQ sol_recipient)');

    const lines = Array.isArray(rfqLines) ? rfqLines : [];
    if (lines.length < 1) return void pushToast('error', 'RFQ must include at least 1 line');
    if (lines.length > 20) return void pushToast('error', 'RFQ has too many lines (max 20)');
    for (let i = 0; i < lines.length; i += 1) {
      const l = lines[i];
      const trade_id = String(l?.trade_id || '').trim();
      if (!trade_id) return void pushToast('error', `RFQ line ${i + 1}: trade_id missing`);
      if (!/^[A-Za-z0-9_.:-]+$/.test(trade_id)) return void pushToast('error', `RFQ line ${i + 1}: trade_id invalid`);
      const btc = Number((l as any)?.btc_sats);
      const usdt = String((l as any)?.usdt_amount || '').trim();
      if (!Number.isInteger(btc) || btc < 1) return void pushToast('error', `RFQ line ${i + 1}: BTC must be >= 1 sat`);
      if (!/^[0-9]+$/.test(usdt)) return void pushToast('error', `RFQ line ${i + 1}: USDT must be a base-unit integer`);
    }
    const rfqActionLabel = rfqRunAsBot ? 'Start RFQ bot' : 'Post RFQ';
    const freshSnapshot = await fetchFreshTradeGuardrailSnapshot({ needLn: true, needUsdt: false });
    if (!ensureLnLiquidityForLines({ role: 'send', lines, actionLabel: rfqActionLabel, lnSummaryOverride: freshSnapshot.lnSummary })) return;
    if (!Number.isFinite(solLamportsAvailable as any) || Number(solLamportsAvailable) < SOL_TX_FEE_BUFFER_LAMPORTS) {
      return void pushToast(
        'error',
        `Post RFQ: low SOL for claim/refund transactions (need at least ${SOL_TX_FEE_BUFFER_LAMPORTS} lamports buffer)`
      );
    }

    if (rfqMaxPlatformFeeBps + rfqMaxTradeFeeBps > rfqMaxTotalFeeBps) {
      return void pushToast('error', 'Fee caps invalid: total must be >= platform + trade');
    }
    if (rfqMinSolRefundWindowSec > rfqMaxSolRefundWindowSec) {
      return void pushToast('error', 'Solana refund window invalid: min must be <= max');
    }
    if (
      !Number.isInteger(rfqMinSolRefundWindowSec) ||
      rfqMinSolRefundWindowSec < SOL_REFUND_MIN_SEC ||
      rfqMinSolRefundWindowSec > SOL_REFUND_MAX_SEC
    ) {
      return void pushToast('error', `Solana refund window invalid: min must be ${SOL_REFUND_MIN_SEC}s..${SOL_REFUND_MAX_SEC}s`);
    }
    if (
      !Number.isInteger(rfqMaxSolRefundWindowSec) ||
      rfqMaxSolRefundWindowSec < SOL_REFUND_MIN_SEC ||
      rfqMaxSolRefundWindowSec > SOL_REFUND_MAX_SEC
    ) {
      return void pushToast('error', `Solana refund window invalid: max must be ${SOL_REFUND_MIN_SEC}s..${SOL_REFUND_MAX_SEC}s`);
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (!Number.isInteger(rfqValidUntilUnix) || rfqValidUntilUnix <= nowSec) {
      return void pushToast('error', 'Expiry must be in the future');
    }

    if (toolRequiresApproval('intercomswap_rfq_post') && !autoApprove) {
      const first = lines[0];
      const ok = window.confirm(
        `Post ${lines.length} RFQ${lines.length === 1 ? '' : 's'} now?\n\nchannel: ${channel}\nfirst.trade_id: ${String(first?.trade_id || '')}\nfirst.BTC: ${Number(first?.btc_sats || 0)} sats\nfirst.USDT: ${String(first?.usdt_amount || '')}`
      );
      if (!ok) return;
    }

    setRfqBusy(true);
    try {
      const baseArgs = {
        channel,
        sol_recipient: solRecipient,
        max_platform_fee_bps: rfqMaxPlatformFeeBps,
        max_trade_fee_bps: rfqMaxTradeFeeBps,
        max_total_fee_bps: rfqMaxTotalFeeBps,
        min_sol_refund_window_sec: rfqMinSolRefundWindowSec,
        max_sol_refund_window_sec: rfqMaxSolRefundWindowSec,
      };

      if (!rfqRunAsBot) {
        let okCount = 0;
        let firstId = '';
        for (let i = 0; i < lines.length; i += 1) {
          const l = lines[i];
          const args = {
            ...baseArgs,
            trade_id: String(l.trade_id),
            btc_sats: Number(l.btc_sats),
            usdt_amount: String(l.usdt_amount),
            valid_until_unix: rfqValidUntilUnix,
            ln_liquidity_mode: lnLiquidityMode,
          };
          const out = await runToolFinal('intercomswap_rfq_post', args, { auto_approve: true });
          const cj = out?.content_json;
          if (cj && typeof cj === 'object' && cj.type === 'error') throw new Error(String(cj.error || 'rfq_post failed'));
          const id = String(cj?.rfq_id || '').trim();
          if (!firstId && id) firstId = id;
          okCount += 1;
        }
        pushToast(
          'success',
          `RFQ${okCount === 1 ? '' : 's'} posted: ${okCount}${firstId ? ` (first ${firstId.slice(0, 12)}…)` : ''}`
        );
        // Prepare a fresh batch (new trade_ids) for the next manual post, while keeping amounts.
        setRfqLines((prev) =>
          prev.map((l, i) => ({
            ...l,
            id: `rfq-${Date.now()}-${i}`,
            trade_id: `rfq-${Date.now()}-${i}-${Math.random().toString(16).slice(2, 10)}`,
          }))
        );
      } else {
        const nowSec = Math.floor(Date.now() / 1000);
        const ttlSec = Math.max(10, Math.min(7 * 24 * 3600, Math.trunc(rfqValidUntilUnix - nowSec)));
        let okCount = 0;
        for (let i = 0; i < lines.length; i += 1) {
          const l = lines[i];
          const trade_id = String(l.trade_id).trim();
          const safeLabel = trade_id.replaceAll(/[^A-Za-z0-9._-]/g, '_').slice(0, 30);
          const botName = `rfq_${safeLabel}_${Date.now()}_${i + 1}`.slice(0, 64);

          if (toolRequiresApproval('intercomswap_autopost_start') && !autoApprove) {
            const ok = window.confirm(`Start RFQ bot now?\n\nname: ${botName}\ninterval_sec: ${rfqBotIntervalSec}\nttl_sec: ${ttlSec}`);
            if (!ok) return;
          }

          const subArgs = {
            ...baseArgs,
            trade_id,
            btc_sats: Number(l.btc_sats),
            usdt_amount: String(l.usdt_amount),
            ln_liquidity_mode: lnLiquidityMode,
          };

          const out = await runToolFinal(
            'intercomswap_autopost_start',
            {
              name: botName,
              tool: 'intercomswap_rfq_post',
              interval_sec: rfqBotIntervalSec,
              ttl_sec: ttlSec,
              valid_until_unix: rfqValidUntilUnix,
              args: subArgs,
            },
            { auto_approve: true }
          );
          const cj = out?.content_json;
          if (cj && typeof cj === 'object' && cj.type === 'error') throw new Error(String(cj.error || 'autopost_start failed'));
          if (cj && typeof cj === 'object' && String((cj as any).type || '') === 'autopost_stopped') {
            throw new Error(`RFQ bot not started (${botName}): ${String((cj as any).reason || 'stopped')}`);
          }
          okCount += 1;
        }
        pushToast('success', `RFQ bot${okCount === 1 ? '' : 's'} started: ${okCount}`);
        void refreshPreflight();
      }
    } catch (e: any) {
      pushToast('error', e?.message || String(e));
    } finally {
      setRfqBusy(false);
    }
  }

	  function validateToolArgs(tool: any, args: any): string[] {
	    if (!tool) return ['Tools not loaded (click Reload tools).'];
	    if (!args || typeof args !== 'object') return ['Arguments must be an object.'];
	    const params = tool?.parameters;
	    const props: Record<string, any> =
	      params?.properties && typeof params.properties === 'object' ? (params.properties as any) : {};
	    const reqList: string[] = Array.isArray(params?.required) ? params.required.map((v: any) => String(v)) : [];
	    const req = new Set<string>(reqList);
	    const errs: string[] = [];

    for (const k of req) {
      const v = (args as any)[k];
      const sch = (props as any)[k] || {};
      if (v === undefined || v === null) {
        errs.push(`${k}: required`);
        continue;
      }
      if (typeof v === 'string' && !v.trim()) {
        errs.push(`${k}: required`);
        continue;
      }
      if (Array.isArray(v) && typeof sch?.minItems === 'number' && v.length < sch.minItems) {
        errs.push(`${k}: must have at least ${sch.minItems} item(s)`);
        continue;
      }
    }

    for (const [k, v] of Object.entries(args || {})) {
      const sch: any = (props as any)[k];
      if (!sch || typeof sch !== 'object') continue;
      if (Array.isArray(sch.anyOf)) continue; // too complex; server validates

      const t = sch.type;
      if (Array.isArray(sch.enum) && sch.enum.length > 0) {
        const ok = sch.enum.some((ev: any) => String(ev) === String(v));
        if (!ok) errs.push(`${k}: must be one of ${sch.enum.map((x: any) => JSON.stringify(x)).join(', ')}`);
      }

      if (t === 'string') {
        if (typeof v !== 'string') {
          errs.push(`${k}: must be a string`);
          continue;
        }
        const s = v.trim();
        if (typeof sch.minLength === 'number' && s.length < sch.minLength) errs.push(`${k}: too short (min ${sch.minLength})`);
        if (typeof sch.maxLength === 'number' && s.length > sch.maxLength) errs.push(`${k}: too long (max ${sch.maxLength})`);
        if (typeof sch.pattern === 'string') {
          try {
            const re = new RegExp(sch.pattern);
            if (!re.test(s)) errs.push(`${k}: invalid format`);
          } catch (_e) {
            // ignore invalid regex from schema
          }
        }
      } else if (t === 'integer') {
        if (typeof v !== 'number' || !Number.isInteger(v)) {
          errs.push(`${k}: must be an integer`);
          continue;
        }
        if (typeof sch.minimum === 'number' && v < sch.minimum) errs.push(`${k}: must be >= ${sch.minimum}`);
        if (typeof sch.maximum === 'number' && v > sch.maximum) errs.push(`${k}: must be <= ${sch.maximum}`);
      } else if (t === 'boolean') {
        if (typeof v !== 'boolean') errs.push(`${k}: must be true/false`);
      } else if (t === 'array') {
        if (!Array.isArray(v)) {
          errs.push(`${k}: must be an array`);
          continue;
        }
        if (typeof sch.minItems === 'number' && v.length < sch.minItems) errs.push(`${k}: must have >= ${sch.minItems} item(s)`);
        if (typeof sch.maxItems === 'number' && v.length > sch.maxItems) errs.push(`${k}: must have <= ${sch.maxItems} item(s)`);
      } else if (t === 'object') {
        if (!v || typeof v !== 'object' || Array.isArray(v)) errs.push(`${k}: must be an object`);
      }
    }

    return errs;
  }

  async function refreshHealth() {
    try {
      const out = await fetchJson('/healthz', { method: 'GET', headers: {} });
      setHealth({ ok: Boolean(out?.ok), ts: Date.now() });
    } catch (_e) {
      setHealth({ ok: false, ts: Date.now() });
    }
  }

  async function refreshTools() {
    try {
      const out = await fetchJson('/v1/tools', { method: 'GET' });
      const list = normalizeToolList(out);
      setTools(list);
      if (!toolName && list.length > 0) setToolName(list[0].name);
    } catch (err: any) {
      setTools(null);
      void appendPromptEvent(
        { type: 'ui', ts: Date.now(), message: `tools fetch failed (promptd offline?): ${err?.message || String(err)}` },
        { persist: false }
      );
    }
  }

  const preflightBusyRef = useRef(false);
  const preflightRunSeqRef = useRef(0);
  useEffect(() => {
    preflightBusyRef.current = preflightBusy;
  }, [preflightBusy]);

  function summarizeLn(listfunds: any, listchannels: any, implRaw: string) {
    try {
      const impl = String(implRaw || '').trim().toLowerCase();
      if (!listfunds || typeof listfunds !== 'object') return { ok: false, channels: 0 };

      const parseMsat = (v: any): bigint | null => {
        if (v === null || v === undefined) return null;
        if (typeof v === 'bigint') return v;
        if (typeof v === 'number') return Number.isFinite(v) ? BigInt(Math.trunc(v)) : null;
        if (typeof v === 'object') {
          for (const k of ['msat', 'amount_msat', 'to_us_msat', 'to_them_msat', 'spendable_msat', 'receivable_msat']) {
            if ((v as any)[k] !== undefined) {
              const r = parseMsat((v as any)[k]);
              if (r !== null) return r;
            }
          }
          for (const k of ['sat', 'amount_sat']) {
            if ((v as any)[k] !== undefined) {
              const r = parseSats((v as any)[k]);
              if (r !== null) return r * 1000n;
            }
          }
          return null;
        }
        const s = String(v).trim().toLowerCase();
        if (!s) return null;
        const m = s.match(/^([0-9]+)(msat|sat)?$/);
        if (!m) return null;
        const n = BigInt(m[1]);
        const unit = m[2] || 'msat';
        return unit === 'sat' ? n * 1000n : n;
      };

      const parseSats = (v: any): bigint | null => {
        if (v === null || v === undefined) return null;
        if (typeof v === 'bigint') return v;
        if (typeof v === 'number') return Number.isFinite(v) ? BigInt(Math.trunc(v)) : null;
        if (typeof v === 'object') {
          for (const k of ['sat', 'amount_sat', 'capacity', 'local_balance', 'remote_balance']) {
            if ((v as any)[k] !== undefined) {
              const r = parseSats((v as any)[k]);
              if (r !== null) return r;
            }
          }
          for (const k of ['msat', 'amount_msat']) {
            if ((v as any)[k] !== undefined) {
              const r = parseMsat((v as any)[k]);
              if (r !== null) return r / 1000n;
            }
          }
          return null;
        }
        const s = String(v).trim().toLowerCase();
        if (!s) return null;
        const m = s.match(/^([0-9]+)(sat|msat)?$/);
        if (!m) return null;
        const n = BigInt(m[1]);
        const unit = m[2] || 'sat';
        return unit === 'msat' ? n / 1000n : n;
      };

      const toSafe = (bn: bigint | null): number | null => {
        if (bn === null) return null;
        const max = BigInt(Number.MAX_SAFE_INTEGER);
        if (bn < 0n || bn > max) return null;
        return Number(bn);
      };

      const rows: Array<{
        id: string;
        chan_id: string;
        peer: string;
        state: string;
        active: boolean;
        private: boolean;
        capacity_sats: number | null;
        local_sats: number | null;
        remote_sats: number | null;
        funding_txid: string;
        channel_point: string;
      }> = [];

      const clnChannels = Array.isArray((listchannels as any)?.channels)
        ? (listchannels as any).channels
        : Array.isArray((listfunds as any)?.channels)
          ? (listfunds as any).channels
          : [];
      const lndChannels = Array.isArray((listchannels as any)?.channels)
        ? (listchannels as any).channels
        : Array.isArray((listfunds as any)?.channels?.channels)
          ? (listfunds as any).channels.channels
          : [];

      if (impl === 'lnd') {
        for (const ch of lndChannels) {
          const local = parseSats((ch as any)?.local_balance) ?? 0n;
          const remote = parseSats((ch as any)?.remote_balance) ?? 0n;
          const cap = parseSats((ch as any)?.capacity) ?? local + remote;
          rows.push({
            id: String((ch as any)?.channel_point || (ch as any)?.chan_id || '').trim(),
            chan_id: String((ch as any)?.chan_id || '').trim(),
            peer: String((ch as any)?.remote_pubkey || '').trim().toLowerCase(),
            state: (ch as any)?.active ? 'active' : 'inactive',
            active: Boolean((ch as any)?.active),
            private: Boolean((ch as any)?.private),
            capacity_sats: toSafe(cap),
            local_sats: toSafe(local),
            remote_sats: toSafe(remote),
            funding_txid: (() => {
              const cp = String((ch as any)?.channel_point || '').trim();
              const m = cp.match(/^([0-9a-f]{64}):\d+$/i);
              if (m) return String(m[1] || '').toLowerCase();
              return '';
            })(),
            channel_point: String((ch as any)?.channel_point || '').trim(),
          });
        }
        const pendingRaw = (listfunds as any)?.pending;
        const pendingOpen = Array.isArray((pendingRaw as any)?.pending_open_channels)
          ? (pendingRaw as any).pending_open_channels
          : [];
        for (const p of pendingOpen) {
          const chan = (p as any)?.channel && typeof (p as any).channel === 'object' ? (p as any).channel : {};
          const cp = String((chan as any)?.channel_point || '').trim();
          const cap = parseSats((chan as any)?.capacity);
          const local = parseSats((chan as any)?.local_balance);
          const remote = parseSats((chan as any)?.remote_balance);
          const txid = (() => {
            const m = cp.match(/^([0-9a-f]{64}):\d+$/i);
            return m ? String(m[1] || '').toLowerCase() : '';
          })();
          const id = cp || txid || `pending:${String((chan as any)?.remote_node_pub || '').trim().toLowerCase()}`;
          rows.push({
            id,
            chan_id: '',
            peer: String((chan as any)?.remote_node_pub || '').trim().toLowerCase(),
            state: 'pending_open',
            active: false,
            private: Boolean((chan as any)?.private),
            capacity_sats: toSafe(cap),
            local_sats: toSafe(local),
            remote_sats: toSafe(remote),
            funding_txid: txid,
            channel_point: cp,
          });
        }
      } else {
        for (const ch of clnChannels) {
          const state = String((ch as any)?.state || '').trim();
          const active = state === 'CHANNELD_NORMAL';
          const localMsat =
            parseMsat((ch as any)?.spendable_msat) ??
            parseMsat((ch as any)?.to_us_msat) ??
            parseMsat((ch as any)?.our_amount_msat) ??
            0n;
          const amountMsat = parseMsat((ch as any)?.total_msat) ?? parseMsat((ch as any)?.amount_msat);
          const remoteMsat = parseMsat((ch as any)?.receivable_msat) ?? parseMsat((ch as any)?.to_them_msat) ?? (amountMsat !== null ? amountMsat - localMsat : 0n);
          const capMsat = amountMsat ?? localMsat + remoteMsat;
          const fundingTxid = String((ch as any)?.funding_txid || '').trim().toLowerCase();
          const fundingOutnum = Number.isInteger((ch as any)?.funding_outnum) ? (ch as any).funding_outnum : null;
          const idFromFunding = fundingTxid && fundingOutnum !== null ? `${fundingTxid}:${fundingOutnum}` : '';
          rows.push({
            id: String((ch as any)?.channel_id || (ch as any)?.short_channel_id || idFromFunding || (ch as any)?.peer_id || '').trim(),
            chan_id: '',
            peer: String((ch as any)?.peer_id || '').trim().toLowerCase(),
            state,
            active,
            private: Boolean((ch as any)?.private),
            capacity_sats: toSafe(capMsat / 1000n),
            local_sats: toSafe(localMsat / 1000n),
            remote_sats: toSafe(remoteMsat / 1000n),
            funding_txid: fundingTxid,
            channel_point: idFromFunding,
          });
        }
      }

      let walletSats: number | null = null;
      let walletConfirmedSats: number | null = null;
      let walletUnconfirmedSats: number | null = null;
      let walletLockedSats: number | null = null;
      let walletReservedAnchorSats: number | null = null;
      if (impl === 'lnd') {
        const w = (listfunds as any).wallet;
        const confirmed = w && typeof w === 'object' ? Number.parseInt(String((w as any).confirmed_balance || '0'), 10) : 0;
        const unconfirmed = w && typeof w === 'object' ? Number.parseInt(String((w as any).unconfirmed_balance || '0'), 10) : 0;
        const locked = w && typeof w === 'object' ? Number.parseInt(String((w as any).locked_balance || '0'), 10) : 0;
        const reservedAnchor =
          w && typeof w === 'object' ? Number.parseInt(String((w as any).reserved_balance_anchor_chan || '0'), 10) : 0;
        const conf = Number.isFinite(confirmed) ? Math.max(0, Math.trunc(confirmed)) : 0;
        const unconf = Number.isFinite(unconfirmed) ? Math.max(0, Math.trunc(unconfirmed)) : 0;
        const lock = Number.isFinite(locked) ? Math.max(0, Math.trunc(locked)) : 0;
        const reserve = Number.isFinite(reservedAnchor) ? Math.max(0, Math.trunc(reservedAnchor)) : 0;
        const spendable = Math.max(0, conf - lock - reserve);
        walletSats = spendable;
        walletConfirmedSats = conf;
        walletUnconfirmedSats = unconf;
        walletLockedSats = lock;
        walletReservedAnchorSats = reserve;
      } else {
        const outputs = Array.isArray((listfunds as any).outputs) ? (listfunds as any).outputs : [];
        let walletMsat = 0n;
        for (const o of outputs) {
          const msat = parseMsat((o as any)?.amount_msat);
          if (msat !== null) walletMsat += msat;
        }
        walletSats = toSafe(walletMsat / 1000n);
        walletConfirmedSats = walletSats;
        walletUnconfirmedSats = null;
        walletLockedSats = 0;
        walletReservedAnchorSats = 0;
      }

      let totalOutbound = 0n;
      let maxOutbound = 0n;
      let totalInbound = 0n;
      let maxInbound = 0n;
      let activeCount = 0;
      for (const r of rows) {
        if (!r.active) continue;
        activeCount += 1;
        const out = typeof r.local_sats === 'number' ? BigInt(Math.max(0, Math.trunc(r.local_sats))) : 0n;
        const inn = typeof r.remote_sats === 'number' ? BigInt(Math.max(0, Math.trunc(r.remote_sats))) : 0n;
        totalOutbound += out;
        totalInbound += inn;
        if (out > maxOutbound) maxOutbound = out;
        if (inn > maxInbound) maxInbound = inn;
      }

      return {
        ok: true,
        channels: rows.length,
        channels_active: activeCount,
        wallet_sats: walletSats,
        wallet_confirmed_sats: walletConfirmedSats,
        wallet_unconfirmed_sats: walletUnconfirmedSats,
        wallet_locked_sats: walletLockedSats,
        wallet_reserved_anchor_sats: walletReservedAnchorSats,
        channel_rows: rows,
        max_outbound_sats: toSafe(maxOutbound),
        total_outbound_sats: toSafe(totalOutbound),
        max_inbound_sats: toSafe(maxInbound),
        total_inbound_sats: toSafe(totalInbound),
      };
    } catch (_e) {
      return { ok: false, channels: 0, channels_active: 0, channel_rows: [] };
    }
  }

  function summarizePrice(snapshot: any) {
    try {
      if (!snapshot || typeof snapshot !== 'object') {
        return { ok: false, ts: null, btc_usd: null, btc_usdt: null, usdt_usd: null, error: 'no_snapshot' };
      }
      if (String((snapshot as any).type || '') === 'error') {
        return {
          ok: false,
          ts: typeof (snapshot as any).ts === 'number' ? (snapshot as any).ts : null,
          btc_usd: null,
          btc_usdt: null,
          usdt_usd: null,
          error: String((snapshot as any).error || 'price oracle error'),
        };
      }
      if (String((snapshot as any).type || '') !== 'price_snapshot') {
        return { ok: false, ts: null, btc_usd: null, btc_usdt: null, usdt_usd: null, error: 'unexpected_snapshot_type' };
      }
      const pairs = (snapshot as any).pairs && typeof (snapshot as any).pairs === 'object' ? (snapshot as any).pairs : {};
      const btc = pairs?.BTC_USDT && typeof pairs.BTC_USDT === 'object' ? pairs.BTC_USDT : null;
      const usdt = pairs?.USDT_USD && typeof pairs.USDT_USD === 'object' ? pairs.USDT_USD : null;
      const btcUsdt = typeof btc?.median === 'number' && Number.isFinite(btc.median) ? btc.median : null;
      const usdtUsd = typeof usdt?.median === 'number' && Number.isFinite(usdt.median) ? usdt.median : 1;
      const btcUsd = btcUsdt !== null && usdtUsd !== null ? btcUsdt * usdtUsd : null;
      return {
        ok: Boolean((snapshot as any).ok),
        ts: typeof (snapshot as any).ts === 'number' ? (snapshot as any).ts : null,
        btc_usdt: btcUsdt,
        usdt_usd: usdtUsd,
        btc_usd: typeof btcUsd === 'number' && Number.isFinite(btcUsd) ? btcUsd : null,
        btc_ok: Boolean(btc?.ok),
        usdt_ok: usdt ? Boolean(usdt?.ok) : true,
        providers: Array.isArray((snapshot as any).providers) ? (snapshot as any).providers.slice(0, 20) : [],
      };
    } catch (_e) {
      return { ok: false, ts: null, btc_usd: null, btc_usdt: null, usdt_usd: null, error: 'price_summary_failed' };
    }
  }

  async function refreshPreflight(opts: { includeTradeAuto?: boolean } = {}) {
    // Single-flight guard: prevents overlapping checklist polls from piling up under load.
    if (preflightBusyRef.current) return;
    preflightBusyRef.current = true;
    const runSeq = preflightRunSeqRef.current + 1;
    preflightRunSeqRef.current = runSeq;
    setPreflightBusy(true);
    const out: any = { ts: Date.now() };
    const includeTradeAuto = opts.includeTradeAuto ?? true;
    try {
      out.env = await runDirectToolOnce('intercomswap_env_get', {}, { auto_approve: false });
      setEnvInfo(out.env);
      setEnvErr(null);
    } catch (e: any) {
      out.env_error = e?.message || String(e);
      setEnvErr(out.env_error);
    }
    try {
      out.peer_status = await runDirectToolOnce('intercomswap_peer_status', {}, { auto_approve: false });
    } catch (e: any) {
      out.peer_status_error = e?.message || String(e);
    }
    try {
      out.sc_info = await runDirectToolOnce('intercomswap_sc_info', {}, { auto_approve: false });
    } catch (e: any) {
      out.sc_info_error = e?.message || String(e);
    }
    try {
      out.sc_stats = await runDirectToolOnce('intercomswap_sc_stats', {}, { auto_approve: false });
    } catch (e: any) {
      out.sc_stats_error = e?.message || String(e);
    }
    try {
      const snap = await runDirectToolOnce('intercomswap_sc_price_get', {}, { auto_approve: false });
      out.price = summarizePrice(snap);
    } catch (e: any) {
      out.price_error = e?.message || String(e);
    }
    try {
      out.autopost = await runDirectToolOnce('intercomswap_autopost_status', {}, { auto_approve: false });
    } catch (e: any) {
      out.autopost_error = e?.message || String(e);
    }
    out.tradeauto = null;
    out.tradeauto_error = null;
    if (includeTradeAuto) {
      try {
        out.tradeauto = await runDirectToolOnce('intercomswap_tradeauto_status', {}, { auto_approve: false });
      } catch (e: any) {
        out.tradeauto_error = e?.message || String(e);
      }
    }
    try {
      out.ln_info = await runDirectToolOnce('intercomswap_ln_info', {}, { auto_approve: false });
    } catch (e: any) {
      out.ln_info_error = e?.message || String(e);
    }
    try {
      out.ln_listpeers = await runDirectToolOnce('intercomswap_ln_listpeers', {}, { auto_approve: false });
    } catch (e: any) {
      out.ln_listpeers_error = e?.message || String(e);
    }
    try {
      out.ln_listfunds = await runDirectToolOnce('intercomswap_ln_listfunds', {}, { auto_approve: false });
      out.ln_channels = await runDirectToolOnce('intercomswap_ln_listchannels', {}, { auto_approve: false });
      out.ln_summary = summarizeLn(out.ln_listfunds, out.ln_channels, String(out?.env?.ln?.impl || out?.ln_info?.implementation || ''));
    } catch (e: any) {
      out.ln_listfunds_error = e?.message || String(e);
    }
	    // If LN backend is docker, show compose service status in the checklist so operators can see
	    // whether the containers are actually running (without needing to run tools manually).
	    if (String(out?.env?.ln?.backend || '') === 'docker') {
	      try {
	        out.ln_docker_ps = await runDirectToolOnce('intercomswap_ln_docker_ps', {}, { auto_approve: false });
	      } catch (e: any) {
	        out.ln_docker_ps_error = e?.message || String(e);
	      }
	    }

	    // If Solana is configured for localhost, show (and allow starting) a local test validator.
	    const solKind = String(out?.env?.solana?.classify?.kind || '');
	    if (solKind === 'local') {
	      try {
	        out.sol_local_status = await runDirectToolOnce('intercomswap_sol_local_status', {}, { auto_approve: false });
	      } catch (e: any) {
	        out.sol_local_status_error = e?.message || String(e);
	      }
	    }
	    try {
	      out.sol_signer = await runDirectToolOnce('intercomswap_sol_signer_pubkey', {}, { auto_approve: false });
	    } catch (e: any) {
	      out.sol_signer_error = e?.message || String(e);
	    }
    try {
      const signerPk = String(out?.sol_signer?.pubkey || '').trim();
      if (signerPk) {
        out.sol_balance = await runDirectToolOnce('intercomswap_sol_balance', { pubkey: signerPk }, { auto_approve: false });
        const mint = String(walletUsdtMint || '').trim();
        if (mint) {
          out.sol_usdt = await runDirectToolOnce(
            'intercomswap_sol_token_balance',
            { owner: signerPk, mint },
            { auto_approve: false }
          );
        }
      }
    } catch (e: any) {
      out.sol_balance_error = e?.message || String(e);
    }
	    try {
	      const solLocalUp = solKind !== 'local' || Boolean(out?.sol_local_status?.rpc_listening);
	      if (!solLocalUp) {
	        const rpc = String(Array.isArray(out?.env?.solana?.rpc_urls) ? out.env.solana.rpc_urls[0] : 'http://127.0.0.1:8899');
	        out.sol_config_error = `Solana RPC is down (${rpc}). Start local validator first.`;
	      } else {
	        out.sol_config = await runDirectToolOnce('intercomswap_sol_config_get', {}, { auto_approve: false });
	      }
	    } catch (e: any) {
	      out.sol_config_error = e?.message || String(e);
	    }
    try {
      out.app = await runDirectToolOnce('intercomswap_app_info', {}, { auto_approve: false });
    } catch (e: any) {
      out.app_error = e?.message || String(e);
    }
    try {
      // Ensure receipts DB is configured + writable early, so swaps always have a recovery trail.
      out.receipts = await runDirectToolOnce('intercomswap_receipts_list', { limit: 1, offset: 0 }, { auto_approve: false });
    } catch (e: any) {
      out.receipts_error = e?.message || String(e);
    }

    if (preflightRunSeqRef.current === runSeq) setPreflight(out);
    if (preflightRunSeqRef.current === runSeq) setPreflightBusy(false);
    if (preflightRunSeqRef.current === runSeq) preflightBusyRef.current = false;
  }

  async function refreshEnv() {
    setEnvBusy(true);
    try {
      const out = await runDirectToolOnce('intercomswap_env_get', {}, { auto_approve: false });
      setEnvInfo(out);
      setEnvErr(null);
    } catch (e: any) {
      setEnvInfo(null);
      setEnvErr(e?.message || String(e));
    } finally {
      setEnvBusy(false);
    }
  }

  async function loadTradesPage({ reset = false } = {}) {
    if (tradesLoading) return;
    setTradesLoading(true);
    try {
      const offset = reset ? 0 : tradesOffset;
      const page = await runDirectToolOnce('intercomswap_receipts_list', { ...receiptsDbArg, limit: tradesLimit, offset }, { auto_approve: false });
      const arr = Array.isArray(page) ? page : [];
      setTrades((prev) => {
        const next = reset ? [] : prev;
        const seen = new Set(next.map((t) => String(t?.trade_id || '')).filter(Boolean));
        const toAdd = arr.filter((t) => {
          const id = String(t?.trade_id || '').trim();
          if (!id) return false;
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        });
        const out = next.concat(toAdd);
        return out.length <= 2000 ? out : out.slice(0, 2000);
      });
      setTradesOffset(offset + arr.length);
      setTradesHasMore(arr.length === tradesLimit);
    } catch (e: any) {
      setTradesHasMore(false);
      void appendPromptEvent({ type: 'error', ts: Date.now(), error: `trades load failed: ${e?.message || String(e)}` }, { persist: false });
    } finally {
      setTradesLoading(false);
    }
  }

  async function loadOpenRefundsPage({ reset = false } = {}) {
    if (openRefundsLoading) return;
    setOpenRefundsLoading(true);
    try {
      const offset = reset ? 0 : openRefundsOffset;
      const page = await runDirectToolOnce(
        'intercomswap_receipts_list_open_refunds',
        { ...receiptsDbArg, limit: openRefundsLimit, offset },
        { auto_approve: false }
      );
      const arr = Array.isArray(page) ? page : [];
      setOpenRefunds((prev) => {
        const next = reset ? [] : prev;
        const seen = new Set(next.map((t) => String(t?.trade_id || '')).filter(Boolean));
        const toAdd = arr.filter((t) => {
          const id = String(t?.trade_id || '').trim();
          if (!id) return false;
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        });
        const out = next.concat(toAdd);
        return out.length <= 2000 ? out : out.slice(0, 2000);
      });
      setOpenRefundsOffset(offset + arr.length);
      setOpenRefundsHasMore(arr.length === openRefundsLimit);
    } catch (e: any) {
      setOpenRefundsHasMore(false);
      void appendPromptEvent(
        { type: 'error', ts: Date.now(), error: `open refunds load failed: ${e?.message || String(e)}` },
        { persist: false }
      );
    } finally {
      setOpenRefundsLoading(false);
    }
  }

  async function loadOpenClaimsPage({ reset = false } = {}) {
    if (openClaimsLoading) return;
    setOpenClaimsLoading(true);
    try {
      const offset = reset ? 0 : openClaimsOffset;
      const page = await runDirectToolOnce(
        'intercomswap_receipts_list_open_claims',
        { ...receiptsDbArg, limit: openClaimsLimit, offset },
        { auto_approve: false }
      );
      const arr = Array.isArray(page) ? page : [];
      setOpenClaims((prev) => {
        const next = reset ? [] : prev;
        const seen = new Set(next.map((t) => String(t?.trade_id || '')).filter(Boolean));
        const toAdd = arr.filter((t) => {
          const id = String(t?.trade_id || '').trim();
          if (!id) return false;
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        });
        const out = next.concat(toAdd);
        return out.length <= 2000 ? out : out.slice(0, 2000);
      });
      setOpenClaimsOffset(offset + arr.length);
      setOpenClaimsHasMore(arr.length === openClaimsLimit);
    } catch (e: any) {
      setOpenClaimsHasMore(false);
      void appendPromptEvent(
        { type: 'error', ts: Date.now(), error: `open claims load failed: ${e?.message || String(e)}` },
        { persist: false }
      );
    } finally {
      setOpenClaimsLoading(false);
    }
  }

  async function appendPromptEvent(evt: any, { persist = true } = {}) {
    const e = evt && typeof evt === 'object' ? evt : { type: 'event', evt };
    const ts = typeof e.ts === 'number' ? e.ts : typeof e.started_at === 'number' ? e.started_at : Date.now();
    const normalized = { ...e, ts };
    const sid = String(e.session_id || sessionId || '');
    const type = String(e.type || 'event');
    let dbId: number | null = null;
    if (persist) {
      try {
        dbId = await promptAdd({ ts, session_id: sid, type, evt: normalized });
      } catch (_e) {}
    }

    const el = promptListRef.current;
    const prevHeight = el ? el.scrollHeight : 0;
    const prevTop = el ? el.scrollTop : 0;
    const keepViewport = Boolean(el && prevTop > 80);

    setPromptEvents((prev) => {
      const cutoff = Date.now() - COLLINS_ACTIVITY_RETENTION_MS;
      const next = [{ ...normalized, db_id: dbId }]
        .concat(prev)
        .filter((row) => {
          const tsRow = eventTsMs(row);
          return tsRow <= 0 || tsRow >= cutoff;
        });
      if (next.length <= promptEventsMax) return next;
      return next.slice(0, promptEventsMax);
    });
    if (keepViewport) {
      requestAnimationFrame(() => {
        const el2 = promptListRef.current;
        if (!el2) return;
        const delta = el2.scrollHeight - prevHeight;
        if (delta > 0) el2.scrollTop = prevTop + delta;
      });
    }
  }

  function scrollChatToBottom() {
    const el = promptChatListRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }

  async function appendChatMessage(
    role: 'user' | 'assistant',
    text: string,
    { forceFollowTail = false }: { forceFollowTail?: boolean } = {}
  ) {
    const ts = Date.now();
    const clean = String(text || '').slice(0, 200_000);
    const follow = forceFollowTail || Boolean(promptChatFollowTailRef.current);
    if (forceFollowTail) {
      promptChatFollowTailRef.current = true;
      setPromptChatFollowTail(true);
      setPromptChatUnseen(0);
    }

    let id: number | null = null;
    try {
      id = await chatAdd({ ts, role, text: clean });
    } catch (_e) {
      id = null;
    }

    const msg = {
      id: id !== null ? id : Math.floor(Date.now() + Math.random() * 1000),
      role,
      ts,
      text: clean,
    };

    if (!follow && role === 'assistant') {
      setPromptChatUnseen((n) => Math.min(999, n + 1));
      return;
    }

    setPromptChat((prev) => {
      const next = prev.concat([msg]);
      if (next.length <= promptChatMax) return next;
      // Keep newest window in memory.
      return next.slice(next.length - promptChatMax);
    });
    if (follow) requestAnimationFrame(scrollChatToBottom);
  }

  function maybePruneScEventDedupMap(now: number) {
    const map = scEventDedupRef.current;
    const sizeLimit = Math.max(scEventDedupMax, Math.trunc(scEventDedupMax * scEventDedupOverflowFactor));
    const dueByTime = now >= Number(scEventDedupNextPruneAtRef.current || 0);
    const dueBySize = map.size > sizeLimit;
    if (!dueByTime && !dueBySize) return;

    for (const [k, seenAt] of map.entries()) {
      if (!k || !Number.isFinite(seenAt) || now - Number(seenAt) > scEventDedupTtlMs) map.delete(k);
    }
    if (map.size > scEventDedupMax) {
      const ordered = Array.from(map.entries()).sort((a, b) => Number(a[1] || 0) - Number(b[1] || 0));
      const drop = map.size - scEventDedupMax;
      for (let i = 0; i < drop; i += 1) {
        const key = String(ordered[i]?.[0] || '');
        if (key) map.delete(key);
      }
    }
    scEventDedupNextPruneAtRef.current = now + scEventDedupPruneEveryMs;
  }

  function flushPendingScUiEvents() {
    scUiFlushTimerRef.current = null;
    const pending = scPendingUiEventsRef.current;
    if (!Array.isArray(pending) || pending.length < 1) return;
    const takeCount = Math.min(pending.length, scEventUiFlushBatch);
    const batch = pending.splice(0, takeCount);
    if (batch.length < 1) return;

    const newestFirst = [...batch].reverse();
    const el = scListRef.current;
    const prevHeight = el ? el.scrollHeight : 0;
    const prevTop = el ? el.scrollTop : 0;
    const keepViewport = Boolean(el && prevTop > 80);

    setScEvents((prev) => {
      const cutoff = Date.now() - COLLINS_SC_FEED_RETENTION_MS;
      const next = newestFirst.concat(prev).filter((row) => {
        const tsRow = eventTsMs(row);
        return tsRow <= 0 || tsRow >= cutoff;
      });
      if (next.length <= scEventsMax) return next;
      return next.slice(0, scEventsMax);
    });
    if (keepViewport) {
      requestAnimationFrame(() => {
        const el2 = scListRef.current;
        if (!el2) return;
        const delta = el2.scrollHeight - prevHeight;
        if (delta > 0) el2.scrollTop = prevTop + delta;
      });
    }

    if (scPendingUiEventsRef.current.length > 0 && scUiFlushTimerRef.current === null) {
      scUiFlushTimerRef.current = window.setTimeout(flushPendingScUiEvents, scEventUiFlushMs);
    }
  }

  function scheduleScUiFlush() {
    if (scUiFlushTimerRef.current !== null) return;
    scUiFlushTimerRef.current = window.setTimeout(flushPendingScUiEvents, scEventUiFlushMs);
  }

  function appendScEvent(evt: any, { persist = true } = {}) {
    const e = evt && typeof evt === 'object' ? evt : { type: 'event', evt };
    if (!shouldKeepScEventInUi(e)) return;
    const msgTs = e?.message && typeof e.message.ts === 'number' ? e.message.ts : null;
    const ts = typeof e.ts === 'number' ? e.ts : msgTs !== null ? msgTs : Date.now();
    const feedCutoff = Date.now() - COLLINS_SC_FEED_RETENTION_MS;
    if (Number.isFinite(ts) && ts > 0 && ts < feedCutoff) return;
    const normalized = { ...e, ts };
    const dedupKey = deriveScEventDedupKey(normalized);
    if (dedupKey) {
      const now = Date.now();
      const map = scEventDedupRef.current;
      const prevSeenAt = Number(map.get(dedupKey) || 0);
      if (prevSeenAt > 0 && now - prevSeenAt <= scEventDedupTtlMs) return;
      map.set(dedupKey, now);
      maybePruneScEventDedupMap(now);
    }

    scPendingUiEventsRef.current.push(normalized);
    if (scPendingUiEventsRef.current.length > scEventsMax * 2) {
      scPendingUiEventsRef.current.splice(0, scPendingUiEventsRef.current.length - scEventsMax * 2);
    }
    scheduleScUiFlush();

    if (persist && normalized.type === 'sc_event') {
      const channel = String(e.channel || '');
      const kind = String(e.kind || '');
      const trade_id = String(e.trade_id || '');
      const seq = typeof e.seq === 'number' ? e.seq : null;
      void scAdd({ ts, channel, kind, trade_id, seq, evt: normalized }).catch(() => {});
    }
  }

			  async function copyToClipboard(label: string, value: any) {
			    const s = String(value ?? '').trim();
			    if (!s) return;
			    try {
			      await navigator.clipboard.writeText(s);
			      pushToast('success', `Copied ${label}`);
			      void appendPromptEvent({ type: 'ui', ts: Date.now(), message: `copied ${label}` }, { persist: false });
			    } catch (_e) {}
			  }

	  function deriveKindTrade(msg: any) {
    if (!msg || typeof msg !== 'object') return { kind: '', trade_id: '' };
    const kind = typeof msg.kind === 'string' ? msg.kind : '';
    const trade_id = typeof msg.trade_id === 'string' ? msg.trade_id : '';
    return { kind, trade_id };
  }

		  async function startScStream() {
		    // Mark the stream as wanted. This is the default; STOP stack will disable it.
		    scStreamWantedRef.current = true;

	    // Bump generation so stale async finally/catch blocks cannot clobber the latest stream state.
	    scStreamGenRef.current += 1;
	    const gen = scStreamGenRef.current;

			if (scAbortRef.current) scAbortRef.current.abort();
			const ac = new AbortController();
			scAbortRef.current = ac;

			const channels = Array.from(watchedChannelsSet).slice(0, 50);
	    const url = new URL('/v1/sc/stream', window.location.origin);
	    if (channels.length > 0) url.searchParams.set('channels', channels.join(','));
	    url.searchParams.set('backlog', '250');

		    setScConnecting(true);
		    setScConnected(false);
		    setScStreamErr(null);

		    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

		    const isAbortLike = (err: any, msg: string) => {
		      if (ac.signal.aborted) return true;
		      if (err && typeof err === 'object') {
		        if (String((err as any).name || '') === 'AbortError') return true;
		      }
		      if (/client_closed/i.test(msg)) return true;
		      return false;
		    };
		    const isTransientNetErr = (msg: string) => {
		      const s = String(msg || '');
		      return (
	        /BodyStreamBuffer was aborted/i.test(s) ||
	        /Received network error or non-101 status code/i.test(s) ||
	        /Failed to fetch/i.test(s) ||
	        /NetworkError/i.test(s) ||
		        /Load failed/i.test(s) ||
		        /socket hang up/i.test(s) ||
		        /ECONNRESET/i.test(s)
		      );
		    };

		    // Auto-reconnect loop: the feed is required for a safe human UX.
		    let backoffMs = 450;
		    while (!ac.signal.aborted && scStreamWantedRef.current && scStreamGenRef.current === gen) {
		      try {
		        const res = await fetch(url.toString(), { method: 'GET', signal: ac.signal });
		        if (!res.ok || !res.body) throw new Error(`sc/stream failed: ${res.status}`);

	        const reader = res.body.getReader();
	        const td = new TextDecoder();
	        let buf = '';

	        while (true) {
	          const { done, value } = await reader.read();
	          if (done) break;
	          buf += td.decode(value, { stream: true });
	          while (true) {
	            const idx = buf.indexOf('\n');
	            if (idx < 0) break;
	            const line = buf.slice(0, idx).trim();
	            buf = buf.slice(idx + 1);
	            if (!line) continue;
	            let obj: any = null;
	            try {
	              obj = JSON.parse(line);
	            } catch (_e) {
	              appendScEvent({ type: 'parse_error', ts: Date.now(), line }, { persist: false });
	              continue;
	            }

			            if (obj.type === 'sc_stream_open') {
			              backoffMs = 450;
			              if (scStreamGenRef.current === gen) {
			                setScConnected(true);
			                setScConnecting(false);
		                setScStreamErr(null);
	              }
	              continue;
	            }

	            // Heartbeats are transport-level keepalives; don’t pollute the operator log.
	            if (obj.type === 'heartbeat') continue;

	            if (obj.type === 'sc_event') {
	              const msg = obj.message;
	              const d = deriveKindTrade(msg);
	              appendScEvent({ ...obj, ...d }, { persist: true });
	              continue;
	            }

	            if (obj.type === 'error') {
	              // Server-side stream error. Treat as reconnect-worthy.
	              throw new Error(String(obj?.error || 'sc/stream error'));
	            }

	            appendScEvent(obj, { persist: false });
	          }
	        }
		      } catch (err: any) {
		        const msg = err?.message || String(err);
		        if (isAbortLike(err, msg)) break;
		        const transient = isTransientNetErr(msg);

		        // Only update state if this is still the active stream.
		        if (scStreamGenRef.current === gen) {
		          setScConnected(false);
		          setScConnecting(true);
		          setScStreamErr(transient ? null : msg);
		        }
		        if (!transient) {
		          appendScEvent({ type: 'error', ts: Date.now(), error: msg }, { persist: false });
		        }
		      }

	      // Stream ended (disconnect) without abort. Reconnect with backoff.
	      if (ac.signal.aborted || !scStreamWantedRef.current || scStreamGenRef.current !== gen) break;

		      if (scStreamGenRef.current === gen) {
		        setScConnected(false);
		        setScConnecting(true);
		        // Disconnects can happen on flaky networks; reconnect silently.
		        setScStreamErr(null);
		      }
		      // Keep operator logs clean: connection churn is reflected in status pills, not the feed.

		      await sleep(backoffMs);
		      backoffMs = Math.min(8000, Math.trunc(backoffMs * 1.6));
		    }

	    if (scStreamGenRef.current === gen) {
	      setScConnecting(false);
	      setScConnected(false);
	    }
		}

		  function stopScStream() {
		    scStreamWantedRef.current = false;
		    if (scAbortRef.current) scAbortRef.current.abort();
		    scAbortRef.current = null;
        if (scUiFlushTimerRef.current !== null) {
          clearTimeout(scUiFlushTimerRef.current);
          scUiFlushTimerRef.current = null;
        }
        scPendingUiEventsRef.current = [];
		    setScConnecting(false);
		    setScConnected(false);
		    setScStreamErr(null);
		  }

	  async function runPromptStream(payload: any) {
	    // Hard gate: never allow trade/protocol actions unless the full stack is up.
	    // This prevents operators from broadcasting RFQs/offers or starting bots when settlement isn’t possible.
	    try {
      const promptStr = String(payload?.prompt || '').trim();
      let toolName: string | null = null;
      if (promptStr.startsWith('{')) {
        try {
          const obj: any = JSON.parse(promptStr);
          if (obj && typeof obj === 'object' && String(obj.type || '') === 'tool' && typeof obj.name === 'string') {
            toolName = String(obj.name).trim() || null;
          }
        } catch (_e) {}
      }

      const block =
        (toolName && toolNeedsFullStack(toolName) && !stackGate.ok) ||
        (!toolName && runMode === 'llm' && !stackGate.ok);

	      if (block) {
	        const missing = stackGate.reasons.length > 0 ? stackGate.reasons.map((r) => `- ${r}`).join('\n') : '- unknown';
	        const msg = `${toolName || 'prompt'}: blocked (stack not ready)\n\nMissing:\n${missing}\n\nGo to Overview -> Getting Started and complete the checklist.`;
	        setRunErr(msg);
	        setConsoleEvents([{ type: 'error', ts: Date.now(), error: msg }]);
	        void appendPromptEvent({ type: 'error', ts: Date.now(), error: msg }, { persist: false });
	        return { type: 'blocked', error: msg };
	      }
	    } catch (_e) {}

    if (promptAbortRef.current) promptAbortRef.current.abort();
    const ac = new AbortController();
    promptAbortRef.current = ac;

    setRunBusy(true);
    setRunErr(null);
    setConsoleEvents([]);

    await appendPromptEvent({ type: 'ui', ts: Date.now(), message: 'run starting...' }, { persist: false });

	    let finalObj: any = null;
	    try {
	      const res = await fetch('/v1/run/stream', {
	        method: 'POST',
	        signal: ac.signal,
	        headers: { 'content-type': 'application/json' },
	        body: JSON.stringify(payload),
	      });
	      if (!res.ok || !res.body) throw new Error(`run failed: ${res.status}`);

      const reader = res.body.getReader();
      const td = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += td.decode(value, { stream: true });
        while (true) {
          const idx = buf.indexOf('\n');
          if (idx < 0) break;
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          let obj: any = null;
	          try {
	            obj = JSON.parse(line);
	          } catch (_e) {
	            await appendPromptEvent({ type: 'parse_error', ts: Date.now(), line }, { persist: false });
	            continue;
	          }
	          if (obj.type === 'final') finalObj = obj;
	          if (obj.type === 'run_start' && obj.session_id) setSessionId(String(obj.session_id));
	          if (obj.type === 'error') setRunErr(String(obj.error || 'error'));
	          if (obj.type === 'tool' && obj.result && typeof obj.result === 'object' && obj.result.type === 'error') {
	            const msg = String(obj?.result?.error || `${obj?.name || 'tool'} failed`);
	            setRunErr(msg);
	          }
		          if (obj.type === 'done') setRunBusy(false);
		          setConsoleEvents((prev) => {
		            const next = [obj].concat(prev);
		            if (next.length <= consoleEventsMax) return next;
		            return next.slice(0, consoleEventsMax);
		          });
		          await appendPromptEvent(obj, { persist: true });
	        }
	      }
	      return finalObj;
	    } catch (err: any) {
	      const msg = err?.message || String(err);
		      setRunErr(msg);
		      setConsoleEvents((prev) => {
		        const next = [{ type: 'error', ts: Date.now(), error: msg }].concat(prev);
		        if (next.length <= consoleEventsMax) return next;
		        return next.slice(0, consoleEventsMax);
		      });
	      await appendPromptEvent({ type: 'error', ts: Date.now(), error: msg }, { persist: false });
	      return { type: 'error', error: msg };
	    } finally {
	      setRunBusy(false);
	    }
	  }

  async function onRun() {
    if (runMode === 'tool') {
      const name = toolName.trim();
      if (!name) return;
      if (!activeTool || activeTool?.name !== name) {
        const msg = 'Tools not loaded yet. Click "Reload tools".';
        setRunErr(msg);
        void appendPromptEvent({ type: 'error', ts: Date.now(), error: msg }, { persist: false });
        return;
      }
      let args: any = {};
      if (toolInputMode === 'form') {
        args = toolArgsObj && typeof toolArgsObj === 'object' ? toolArgsObj : {};
      } else {
        try {
          args = toolArgsText.trim() ? JSON.parse(toolArgsText) : {};
          setToolArgsParseErr(null);
          if (args && typeof args === 'object') setToolArgsObj(args);
        } catch (e: any) {
          const msg = `Invalid JSON args: ${e?.message || String(e)}`;
          setToolArgsParseErr(msg);
          setRunErr(msg);
          void appendPromptEvent({ type: 'error', ts: Date.now(), error: msg }, { persist: false });
          return;
        }
      }

      const argErrs = validateToolArgs(activeTool, args);
      if (argErrs.length > 0) {
        const msg = `Invalid args:\n- ${argErrs.join('\n- ')}`;
        setRunErr(msg);
        void appendPromptEvent({ type: 'error', ts: Date.now(), error: msg }, { persist: false });
        return;
      }

      if (toolRequiresApproval(name) && !autoApprove) {
        const ok = window.confirm(`${name} requires approval (it changes state or can move funds).\n\nApprove once and run now?`);
        if (!ok) {
          const msg = `${name}: blocked (not approved)`;
          setRunErr(msg);
          void appendPromptEvent({ type: 'error', ts: Date.now(), error: msg }, { persist: false });
          return;
        }
      }
      const directToolPrompt = {
        type: 'tool',
        name,
        arguments: args && typeof args === 'object' ? args : {},
      };
      await runPromptStream({
        prompt: JSON.stringify(directToolPrompt),
        session_id: sessionId,
        auto_approve: toolRequiresApproval(name) ? true : autoApprove,
        dry_run: false,
      });
      return;
    }

    const p = promptInput.trim();
    if (!p) return;
    await runPromptStream({
      prompt: p,
      session_id: sessionId,
      auto_approve: autoApprove,
      dry_run: false,
    });
  }

  useEffect(() => {
    refreshHealth();
    refreshTools();
    void refreshEnv();
    void refreshPreflight();
    const t = setInterval(refreshHealth, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep uiNowMs ticking so expiry-based UI stays correct even if the network is quiet.
  useEffect(() => {
    const t = setInterval(() => setUiNowMs(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  // Periodic local DB hygiene to bound disk growth.
  useEffect(() => {
    const kindRaw = String(envInfo?.env_kind || '').trim().toLowerCase();
    if (!kindRaw) return;
    const run = () =>
      void dbPruneRetention({
        scFeedRetentionMs: COLLINS_SC_FEED_RETENTION_MS,
        activityRetentionMs: COLLINS_ACTIVITY_RETENTION_MS,
      }).catch(() => {});
    run();
    const t = setInterval(run, 30 * 60 * 1000);
    return () => clearInterval(t);
  }, [envInfo?.env_kind]);

  // Stack observer:
  // - Periodically refresh the checklist while the stack is up (so the UI detects crashes/disconnects).
  // - Emit a toast if the stack transitions from READY -> not ready.
  useEffect(() => {
    const okPromptd = Boolean(health?.ok);
    const running = Boolean(stackAnyRunning || stackGate.ok);
    if (!okPromptd || !running) return;
    const intervalMs = 15_000;
    const t = setInterval(() => {
      if (preflightBusyRef.current) return;
      void refreshPreflight();
    }, intervalMs);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [health?.ok, stackAnyRunning, stackGate.ok, tradeAutoTraceEnabled, tradeAutoWorkerEnabled]);

  useEffect(() => {
    const ok = Boolean(stackGate.ok);
    const prev = stackOkRef.current;
    if (prev === null) {
      stackOkRef.current = ok;
      if (ok) setStackLastOkTs(Date.now());
      return;
    }
    if (ok) setStackLastOkTs(Date.now());
    if (prev && !ok) {
      const reasons = stackGate.reasons.length > 0 ? stackGate.reasons.map((r) => `- ${r}`).join('\n') : '- unknown';
      pushToast('error', `Stack issue detected (something crashed/disconnected)\n\n${reasons}`, { ttlMs: 12_000 });
    }
    stackOkRef.current = ok;
  }, [stackGate.ok, stackGate.reasons]);

  // Close detail modal via Escape.
  useEffect(() => {
    const isModal = selected && selected.type !== 'console_event' && selected.type !== 'prompt_event';
    if (!isModal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelected(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected]);

  // Auto-connect the sidechannel feed once a peer is up. The UI relies on this for RFQ/Offer inboxes.
  useEffect(() => {
    const scPort = (() => {
      try {
        const u = new URL(String(envInfo?.sc_bridge?.url || '').trim() || 'ws://127.0.0.1:49222');
        const p = u.port ? Number.parseInt(u.port, 10) : 0;
        return Number.isFinite(p) && p > 0 ? p : 49222;
      } catch (_e) {
        return 49222;
      }
    })();
    const okPeer = Boolean(
      preflight?.peer_status?.peers?.some?.((p: any) => Boolean(p?.alive) && Number(p?.sc_bridge?.port) === scPort)
    );
    if (!health?.ok || !okPeer) return;
    if (!scStreamWantedRef.current) return;
    if (scConnected || scConnecting) return;
    void startScStream();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [health?.ok, preflight?.peer_status, scChannels, scSwapWatchChannels, envInfo?.sc_bridge?.url]);

  // Lazy load tab-specific data.
  useEffect(() => {
    if (activeTab === 'trade_actions' && trades.length === 0) void loadTradesPage({ reset: true });
    if (activeTab === 'refunds' && (openRefunds.length === 0 || openClaims.length === 0)) {
      if (openRefunds.length === 0) void loadOpenRefundsPage({ reset: true });
      if (openClaims.length === 0) void loadOpenClaimsPage({ reset: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // When switching receipts DB sources, reset pagination so operators don't mix multiple stores.
  useEffect(() => {
    if (!selectedReceiptsSource) return;
    setTrades([]);
    setTradesOffset(0);
    setTradesHasMore(true);
    setOpenRefunds([]);
    setOpenRefundsOffset(0);
    setOpenRefundsHasMore(true);
    setOpenClaims([]);
    setOpenClaimsOffset(0);
    setOpenClaimsHasMore(true);
    if (activeTab === 'trade_actions') void loadTradesPage({ reset: true });
    if (activeTab === 'refunds') {
      void loadOpenRefundsPage({ reset: true });
      void loadOpenClaimsPage({ reset: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedReceiptsSource?.key]);

  // Load recent history from local IndexedDB.
  // IMPORTANT: keep test vs mainnet separate by using a namespaced DB per env_kind.
  useEffect(() => {
    const kindRaw = String(envInfo?.env_kind || '').trim().toLowerCase();
    if (!kindRaw) return;
    const kind = kindRaw === 'test' || kindRaw === 'mainnet' || kindRaw === 'mixed' ? kindRaw : 'default';
    setDbNamespace(kind);

    // Reset in-memory logs when switching env kinds so operators don't get "mixed" UI.
    setScEvents([]);
    scEventDedupRef.current.clear();
    scEventDedupNextPruneAtRef.current = 0;
    scPendingUiEventsRef.current = [];
    if (scUiFlushTimerRef.current !== null) {
      clearTimeout(scUiFlushTimerRef.current);
      scUiFlushTimerRef.current = null;
    }
    setScSwapWatchChannelsState([]);
    scSwapWatchFirstSeenAtRef.current.clear();
    setPromptEvents([]);
    setPromptChat([]);

    (async () => {
      try {
        await dbPruneRetention({
          scFeedRetentionMs: COLLINS_SC_FEED_RETENTION_MS,
          activityRetentionMs: COLLINS_ACTIVITY_RETENTION_MS,
        });
      } catch (_e) {}
      const now = Date.now();
      const scCutoff = now - COLLINS_SC_FEED_RETENTION_MS;
      const activityCutoff = now - COLLINS_ACTIVITY_RETENTION_MS;
      try {
        const sc = await scListLatest({ limit: 400 });
        setScEvents(
          sc
            .map((r) => ({ ...(r.evt || {}), db_id: r.id }))
            .filter((e) => {
              const ts = eventTsMs(e);
              return ts <= 0 || ts >= scCutoff;
            })
        );
      } catch (_e) {}
      try {
        const pe = await promptListLatest({ limit: 300 });
        setPromptEvents(
          pe
            .map((r) => ({ ...(r.evt || {}), db_id: r.id }))
            .filter((e) => {
              const ts = eventTsMs(e);
              return ts <= 0 || ts >= activityCutoff;
            })
        );
      } catch (_e) {}
      try {
        const ch = await chatListLatest({ limit: 300 });
        // DB returns newest-first; chat UI wants oldest-first.
        setPromptChat(
          ch
            .map((r: any) => ({
              id: Number(r.id),
              role: normalizeChatRole(r.role),
              ts: Number(r.ts),
              text: String(r.text || ''),
            }))
            .filter((m: any) => Number.isFinite(m.ts) && m.ts >= activityCutoff)
            .reverse()
        );
        requestAnimationFrame(scrollChatToBottom);
      } catch (_e) {}
    })();
  }, [envInfo?.env_kind]);

  useEffect(() => {
    return () => {
      if (scUiFlushTimerRef.current !== null) {
        clearTimeout(scUiFlushTimerRef.current);
        scUiFlushTimerRef.current = null;
      }
      scPendingUiEventsRef.current = [];
    };
  }, []);

  // No “follow tail” UI: logs render newest-first.

  const onScScroll = () => {
    const cur = scListRef.current;
    if (!cur) return;
    const nearBottom = cur.scrollHeight - cur.scrollTop - cur.clientHeight < 180;
    if (nearBottom) void loadOlderScEvents({ limit: 250 });
  };

  const onPromptScroll = () => {
    const cur = promptListRef.current;
    if (!cur) return;
    const nearBottom = cur.scrollHeight - cur.scrollTop - cur.clientHeight < 180;
    if (nearBottom) void loadOlderPromptEvents({ limit: 250 });
  };

  const onPromptChatScroll = () => {
    const cur = promptChatListRef.current;
    if (!cur) return;
    const distBottom = cur.scrollHeight - cur.scrollTop - cur.clientHeight;
    const nearBottom = distBottom < 160;
    const nearTop = cur.scrollTop < 160;

    const following = Boolean(promptChatFollowTailRef.current);
    if (following && !nearBottom) {
      promptChatFollowTailRef.current = false;
      setPromptChatFollowTail(false);
    }
    if (!following && nearBottom) {
      promptChatFollowTailRef.current = true;
      setPromptChatFollowTail(true);
      setPromptChatUnseen(0);
    }

    if (nearTop) void loadOlderChatMessages({ limit: 250 });
  };

  const onTradesScroll = () => {
    const cur = tradesListRef.current;
    if (!cur) return;
    const nearBottom = cur.scrollHeight - cur.scrollTop - cur.clientHeight < 180;
    if (nearBottom && tradesHasMore && !tradesLoading) void loadTradesPage({ reset: false });
  };

  const onOpenRefundsScroll = () => {
    const cur = openRefundsListRef.current;
    if (!cur) return;
    const nearBottom = cur.scrollHeight - cur.scrollTop - cur.clientHeight < 180;
    if (nearBottom && openRefundsHasMore && !openRefundsLoading) void loadOpenRefundsPage({ reset: false });
  };

  const onOpenClaimsScroll = () => {
    const cur = openClaimsListRef.current;
    if (!cur) return;
    const nearBottom = cur.scrollHeight - cur.scrollTop - cur.clientHeight < 180;
    if (nearBottom && openClaimsHasMore && !openClaimsLoading) void loadOpenClaimsPage({ reset: false });
  };

  const lnInfoObj = preflight?.ln_info && typeof preflight.ln_info === 'object' ? preflight.ln_info : null;
  const lnAlias = lnInfoObj ? String((lnInfoObj as any).alias || '').trim() : '';
  const lnNodeId = lnInfoObj ? String((lnInfoObj as any).id || (lnInfoObj as any).identity_pubkey || '').trim() : '';
  const lnNodeIdShort = lnNodeId ? `${lnNodeId.slice(0, 16)}…` : '';
	  const solSignerPubkey = String(preflight?.sol_signer?.pubkey || '').trim();
  const lnChannelCount = Number(preflight?.ln_summary?.channels || 0);
  const lnActiveChannelCount = Number(preflight?.ln_summary?.channels_active || 0);
  const lnChannelRows = Array.isArray(preflight?.ln_summary?.channel_rows) ? preflight.ln_summary.channel_rows : [];
  const lnNumericChanIdOptions = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const ch of lnChannelRows) {
      const v = String((ch as any)?.chan_id || '').trim();
      if (!/^[0-9]+$/.test(v)) continue;
      if (seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
    out.sort((a, b) => (a.length !== b.length ? a.length - b.length : a.localeCompare(b)));
    return out;
  }, [lnChannelRows]);
  const lnVisibleChannelRows = useMemo(() => {
    if (lnShowInactiveChannels) return lnChannelRows;
    return lnChannelRows.filter((ch: any) => Boolean(ch?.active) || isPendingLnChannelState((ch as any)?.state));
  }, [lnChannelRows, lnShowInactiveChannels]);
  const lnMaxOutboundSats = typeof preflight?.ln_summary?.max_outbound_sats === 'number' ? preflight.ln_summary.max_outbound_sats : null;
  const lnTotalOutboundSats = typeof preflight?.ln_summary?.total_outbound_sats === 'number' ? preflight.ln_summary.total_outbound_sats : null;
  const lnMaxInboundSats = typeof preflight?.ln_summary?.max_inbound_sats === 'number' ? preflight.ln_summary.max_inbound_sats : null;
  const lnTotalInboundSats = typeof preflight?.ln_summary?.total_inbound_sats === 'number' ? preflight.ln_summary.total_inbound_sats : null;
	  const lnWalletSats = typeof (preflight as any)?.ln_summary?.wallet_sats === 'number' ? (preflight as any).ln_summary.wallet_sats : null;
  const lnWalletConfirmedSats =
    typeof (preflight as any)?.ln_summary?.wallet_confirmed_sats === 'number'
      ? (preflight as any).ln_summary.wallet_confirmed_sats
      : null;
  const lnWalletReservedAnchorSats =
    typeof (preflight as any)?.ln_summary?.wallet_reserved_anchor_sats === 'number'
      ? (preflight as any).ln_summary.wallet_reserved_anchor_sats
      : null;
  const solLamportsAvailable =
    typeof (preflight as any)?.sol_balance === 'number'
      ? Number((preflight as any).sol_balance)
      : typeof (preflight as any)?.sol_balance === 'string' && /^[0-9]+$/.test(String((preflight as any).sol_balance).trim())
        ? Number.parseInt(String((preflight as any).sol_balance).trim(), 10)
        : typeof (solBalance as any)?.lamports === 'number'
          ? Number((solBalance as any).lamports)
          : null;
  const usdtBalanceAtomic =
    String((preflight as any)?.sol_usdt?.amount || '').trim() ||
    String(walletUsdtAtomic || '').trim() ||
    '';
  const lnImpl = String((preflight as any)?.env?.ln?.impl || (preflight as any)?.ln_info?.implementation || envInfo?.ln?.impl || '').trim().toLowerCase();
	  const lnBackend = String(envInfo?.ln?.backend || '');
  const lnRebalanceSupported = lnImpl === 'lnd';
  const lnRebalanceMinChannelsOk = lnActiveChannelCount >= 2;
  const lnSpliceBackendSupported = lnImpl === 'cln';
  const lnUnlockHelperSupported = lnImpl === 'lnd' && lnBackend === 'docker';
	  const lnNetwork = String(envInfo?.ln?.network || '');
	  const isLnRegtestDocker = lnBackend === 'docker' && lnNetwork === 'regtest';
  const solKind = String(preflight?.env?.solana?.classify?.kind || envInfo?.solana?.classify?.kind || '');
  const solLocalUp = solKind !== 'local' || Boolean(preflight?.sol_local_status?.rpc_listening);
  const solConfigOk = !preflight?.sol_config_error;
	  const needSolLocalStart = solKind === 'local' && !solLocalUp;
	  const needLnBootstrap = isLnRegtestDocker && !lnWalletLocked && (lnChannelCount < 1 || Boolean(preflight?.ln_listfunds_error));
  const autopostJobs = Array.isArray((preflight as any)?.autopost?.jobs) ? (preflight as any).autopost.jobs : [];
  const offerAutopostJobs = autopostJobs.filter((j: any) => String(j?.tool || '') === 'intercomswap_offer_post');
  const rfqAutopostJobs = autopostJobs.filter((j: any) => String(j?.tool || '') === 'intercomswap_rfq_post');
  const tradeAutoStatus = (preflight as any)?.tradeauto && typeof (preflight as any).tradeauto === 'object'
    ? ((preflight as any).tradeauto as any)
    : null;

  // Sync UI toggles to backend truth (so reloads / remote restarts do not desync the buttons).
  useEffect(() => {
    if (!tradeAutoStatus || typeof tradeAutoStatus !== 'object') return;
    if (typeof tradeAutoStatus.running === 'boolean') setTradeAutoWorkerEnabled(Boolean(tradeAutoStatus.running));
    if (typeof tradeAutoStatus.trace_enabled === 'boolean') setTradeAutoTraceEnabled(Boolean(tradeAutoStatus.trace_enabled));
  }, [tradeAutoStatus?.running, tradeAutoStatus?.trace_enabled]);
  const tradeAutoRecent = useMemo(() => {
    const rows = Array.isArray(tradeAutoStatus?.recent_events) ? tradeAutoStatus.recent_events : [];
    return rows
      .slice()
      .reverse()
      .map((evt: any, idx: number) => ({
        _idx: idx,
        ts: typeof evt?.ts === 'number' ? evt.ts : null,
        type: String(evt?.type || 'trace'),
        stage: String(evt?.stage || '').trim() || null,
        trade_id: String(evt?.trade_id || '').trim() || null,
        channel: String(evt?.channel || '').trim() || null,
        sig: String(evt?.sig || '').trim() || null,
        error: String(evt?.error || '').trim() || null,
        cooldown_ms: typeof evt?.cooldown_ms === 'number' ? evt.cooldown_ms : null,
      }));
  }, [tradeAutoStatus?.recent_events]);
  const oracle: OracleSummary = useMemo(() => {
    const p = preflight?.price && typeof preflight.price === 'object' ? (preflight.price as any) : null;
    return {
      ok: Boolean(p?.ok),
	      ts: typeof p?.ts === 'number' ? p.ts : null,
	      btc_usd: typeof p?.btc_usd === 'number' && Number.isFinite(p.btc_usd) ? p.btc_usd : null,
	      btc_usdt: typeof p?.btc_usdt === 'number' && Number.isFinite(p.btc_usdt) ? p.btc_usdt : null,
	      usdt_usd: typeof p?.usdt_usd === 'number' && Number.isFinite(p.usdt_usd) ? p.usdt_usd : 1,
	    };
	  }, [preflight?.price]);
  const lnPeerSuggestions = useMemo<LnPeerSuggestion[]>(
    () => collectLnPeerSuggestions((preflight as any)?.ln_listpeers),
    [preflight?.ln_listpeers]
  );
  const lnConnectedPeerSuggestions = useMemo(() => lnPeerSuggestions.filter((p) => p.connected), [lnPeerSuggestions]);
  const lnConnectedPeerCount = lnConnectedPeerSuggestions.length;
  const lnSelectedPeerNodeId = useMemo(() => parseNodeIdFromPeerUri(lnPeerInput), [lnPeerInput]);
  const lnSelectedPeerConnected = useMemo(() => {
    if (!lnSelectedPeerNodeId) return false;
    return lnConnectedPeerSuggestions.some((p) => p.id === lnSelectedPeerNodeId);
  }, [lnConnectedPeerSuggestions, lnSelectedPeerNodeId]);
  const lnSelectedPeerKnown = useMemo(() => {
    if (!lnSelectedPeerNodeId) return false;
    return lnPeerSuggestions.some((p) => p.id === lnSelectedPeerNodeId);
  }, [lnPeerSuggestions, lnSelectedPeerNodeId]);
  const lnPeerFailoverKeyRef = useRef<string>('');
  const lnPeerFailoverSeenRef = useRef<{ nodeId: string; wasConnected: boolean } | null>(null);

  useEffect(() => {
    const peers = lnConnectedPeerSuggestions;
    if (peers.length < 1) return;
    const currentRaw = lnPeerInput.trim();
    if (!currentRaw) {
      const next = peers[0];
      if (next?.uri) setLnPeerInput(next.uri);
      return;
    }
    if (!lnAutoPeerFailover) return;
    const currentNodeId = parseNodeIdFromPeerUri(currentRaw);
    if (!currentNodeId) {
      const next = peers[0];
      if (next?.uri && next.uri !== currentRaw) {
        setLnPeerInput(next.uri);
        pushToast('info', `LN peer auto-selected: ${next.id.slice(0, 12)}…`);
      }
      return;
    }
    if (!lnPeerFailoverSeenRef.current || lnPeerFailoverSeenRef.current.nodeId !== currentNodeId) {
      lnPeerFailoverSeenRef.current = { nodeId: currentNodeId, wasConnected: false };
    }
    const currentOk = peers.some((p) => p.id === currentNodeId);
    if (currentOk) {
      lnPeerFailoverSeenRef.current.wasConnected = true;
      lnPeerFailoverKeyRef.current = '';
      return;
    }
    // Do not auto-failover a peer that was never observed as connected (prevents overriding the mainnet default).
    if (!lnPeerFailoverSeenRef.current.wasConnected) return;
    const next = peers.find((p) => p.id !== currentNodeId) || peers[0];
    if (!next?.uri || next.uri === currentRaw) return;
    const key = `${currentNodeId}->${next.id}`;
    if (lnPeerFailoverKeyRef.current === key) return;
    lnPeerFailoverKeyRef.current = key;
    setLnPeerInput(next.uri);
    pushToast('info', `LN peer auto-failover: ${currentNodeId.slice(0, 12)}… -> ${next.id.slice(0, 12)}…`, { ttlMs: 8000 });
  }, [lnConnectedPeerSuggestions, lnPeerInput, lnAutoPeerFailover]);

		  return (
	    <div
	      className={`shell ${navOpen ? 'nav-open' : 'nav-closed'}`}
	    >
	      <header className="topbar">
	        <div className="topbar-left">
	          <button className="iconbtn" onClick={() => setNavOpen((v) => !v)} aria-label="Toggle navigation">
	            ☰
	          </button>
	          <div className="logo">
	            <AnimatedLogo text="COLLIN" tagline="control center" />
	          </div>
	        </div>
	        <div className="topbar-right">
	          <button
	            className={`btn ${stackAnyRunning ? 'danger' : 'primary'}`}
	            onClick={stackAnyRunning ? stackStop : stackStart}
	            disabled={!health?.ok || stackOpBusy}
	            title={stackAnyRunning ? 'Stop peer + LN + Solana (local)' : 'Start peer + LN + Solana (bootstrap)'}
	          >
	            {stackOpBusy ? 'Busy…' : stackAnyRunning ? 'STOP' : 'START'}
	          </button>
	        </div>
	      </header>

	      {navOpen ? (
	        <aside className="nav">
	          <nav className="nav-inner">
	            <NavButton active={activeTab === 'overview'} onClick={() => setActiveTab('overview')} label="Overview" />
	            <NavButton
	              active={activeTab === 'sell_usdt'}
	              onClick={() => setActiveTab('sell_usdt')}
	              label="Sell USDT"
	              badge={myOfferPosts.length}
	            />
	            <NavButton
	              active={activeTab === 'sell_btc'}
	              onClick={() => setActiveTab('sell_btc')}
	              label="Sell BTC"
	              badge={myRfqPosts.length}
	            />
	            <NavButton
	              active={activeTab === 'invites'}
	              onClick={() => setActiveTab('invites')}
	              label="Invites"
	              badge={inviteEvents.length}
	            />
	            <NavButton active={activeTab === 'trade_actions'} onClick={() => setActiveTab('trade_actions')} label="Trade Actions" />
	            <NavButton active={activeTab === 'refunds'} onClick={() => setActiveTab('refunds')} label="Refunds" />
	            <NavButton active={activeTab === 'wallets'} onClick={() => setActiveTab('wallets')} label="Wallets" />
	            <NavButton active={activeTab === 'settings'} onClick={() => setActiveTab('settings')} label="Settings" />
	            <NavButton active={activeTab === 'prompt'} onClick={() => setActiveTab('prompt')} label="Prompt" />
	            <NavButton active={activeTab === 'console'} onClick={() => setActiveTab('console')} label="Console" />
	          </nav>
	        </aside>
	      ) : null}

      <main className="main">
        {activeTab === 'overview' ? (
          <div className="grid2">
            <Panel title="Getting Started">
              {!stackGate.ok ? (
                <div className="alert">
                  {!stackAnyRunning ? (
                    <>
                      <b>Setup required.</b> Click <b>START</b> in the header to bootstrap peer + sidechannels + Lightning + Solana + receipts.
                    </>
                  ) : (
                    <>
                      <b>Stack is running.</b> Complete the remaining checklist items below to enable trading.
                    </>
                  )}
                </div>
              ) : null}
              {stackGate.invitePolicyWarning ? (
                <div className="alert">
                  <b>Invite Policy:</b> {stackGate.invitePolicyWarning}
                </div>
              ) : null}

              <div className="row">
                <button className="btn primary" onClick={() => void refreshPreflight()} disabled={preflightBusy}>
                  {preflightBusy ? 'Checking…' : 'Refresh status'}
                </button>
                <button className="btn" onClick={() => setActiveTab('wallets')}>
                  Wallets
                </button>
              </div>

		              {!stackGate.ok ? (
		                <div className="alert warn">
		                  <b>Trading setup incomplete.</b> Complete these items to enable trading:
		                  <div className="muted small" style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>
		                    {stackGate.reasons.length > 0 ? stackGate.reasons.map((r) => `- ${r}`).join('\n') : '- unknown'}
		                  </div>
		                </div>
		              ) : (
		                <div className="alert">
		                  <span className="chip hi">READY</span> You can post Offers (Sell USDT) and RFQs (Sell BTC).
		                </div>
		              )}

              {lnWalletLocked ? (
                <div className="alert warn">
                  <b>Lightning wallet is locked.</b> Unlock the wallet in your LN backend, then press <span className="mono">Refresh BTC</span> in Wallets.
                  {lnWalletLockedMessage ? <div className="muted small" style={{ marginTop: 6 }}>{lnWalletLockedMessage}</div> : null}
                  {lnUnlockHelperSupported ? (
                    <div className="row" style={{ marginTop: 8 }}>
                      <button className="btn primary" onClick={() => void unlockLnWallet()} disabled={runBusy || stackOpBusy}>
                        Unlock LN wallet
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {!stackGate.ok && stackAnyRunning ? (
                <div className="row">
                  {!scConnected ? (
                    <button className="btn primary" onClick={startScStream} disabled={!health?.ok || stackOpBusy}>
                      {scConnecting ? 'Connecting feed…' : 'Connect feed'}
                    </button>
                  ) : null}
                  {needLnBootstrap ? (
                    <button className="btn primary" onClick={ensureLnRegtestChannel} disabled={runBusy || stackOpBusy}>
                      Bootstrap LN regtest
                    </button>
                  ) : null}
                  {needSolLocalStart ? (
                    <button className="btn primary" onClick={ensureSolLocalValidator} disabled={runBusy || stackOpBusy}>
                      Start Solana local
                    </button>
                  ) : null}
                  {!solConfigOk && solKind === 'local' && solLocalUp ? (
                    <button className="btn" onClick={() => void refreshPreflight()} disabled={preflightBusy}>
                      Retry Solana config
                    </button>
                  ) : null}
                </div>
              ) : null}

              <div className="field">
                <div className="field-hd">
                  <span className="mono">Rendezvous Channels</span>
                </div>
                <input
                  className="input mono"
                  value={scChannels}
                  onChange={(e) => setRendezvousChannelsFromInput(e.target.value)}
                  placeholder="0000intercomswapbtcusdt"
                />
              </div>

              <div className="field">
                <div className="field-hd">
                  <span className="mono">Funding</span>
                </div>
                <div className="row">
                  <span className="tag">BTC</span>
                  <input className="input mono" value={lnFundingAddr || ''} readOnly placeholder="Generate a BTC funding address…" />
                  <button className="btn" disabled={!lnFundingAddr} onClick={() => copyToClipboard('btc address', lnFundingAddr)}>
                    Copy
                  </button>
                  <button
                    className="btn primary"
                    disabled={runBusy || stackOpBusy}
                    onClick={async () => {
                      try {
                        const out = await runDirectToolOnce('intercomswap_ln_newaddr', {}, { auto_approve: true });
                        const addr = String(out?.address || '').trim();
                        if (!addr) throw new Error('ln_newaddr returned no address');
                        setLnFundingAddr(addr);
                        setLnFundingAddrErr(null);
                      } catch (e: any) {
                        setLnFundingAddrErr(e?.message || String(e));
                      }
                    }}
                  >
                    New BTC address
                  </button>
                </div>
                {lnFundingAddrErr ? <div className="alert bad">{lnFundingAddrErr}</div> : null}
	                {lnWalletSats !== null ? (
	                  <div className="muted small">
	                    wallet: <span className="mono">{satsToBtcDisplay(lnWalletSats)} BTC</span> (<span className="mono">{lnWalletSats} sats</span>)
	                    {oracle.btc_usd ? <span> ≈ <span className="mono">{fmtUsd((lnWalletSats / 1e8) * oracle.btc_usd)}</span></span> : null}
	                  </div>
	                ) : null}

                <div className="row">
                  <span className="tag">SOL</span>
                  <input className="input mono" value={solSignerPubkey || ''} readOnly placeholder="sol signer pubkey…" />
                  <button className="btn" disabled={!solSignerPubkey} onClick={() => copyToClipboard('solana pubkey', solSignerPubkey)}>
                    Copy
                  </button>
                  <button
                    className="btn"
                    disabled={runBusy || !solSignerPubkey}
                    onClick={async () => {
                      try {
                        const lamports = await runDirectToolOnce('intercomswap_sol_balance', { pubkey: solSignerPubkey }, { auto_approve: false });
                        setSolBalance(lamports);
                        setSolBalanceErr(null);
                      } catch (e: any) {
                        setSolBalanceErr(e?.message || String(e));
                      }
                    }}
                  >
                    Refresh SOL
                  </button>
                  {solBalance !== null && solBalance !== undefined ? (
                    <span className="chip">
                      {lamportsToSolDisplay(solBalance)} SOL ({String(solBalance)} lamports)
                    </span>
                  ) : null}
                </div>
                {solBalanceErr ? <div className="alert bad">{solBalanceErr}</div> : null}
              </div>

		              <div className="field">
		                <div className="field-hd">
		                  <span className="mono">Lightning Channel</span>
		                </div>
		                <div className="row">
		                  {lnChannelCount > 0 ? <span className="chip hi">{lnChannelCount} channel(s)</span> : <span className="chip warn">no channels</span>}
		                  {needLnBootstrap ? (
		                    <button className="btn primary" onClick={ensureLnRegtestChannel} disabled={runBusy || stackOpBusy}>
		                      Bootstrap regtest
		                    </button>
		                  ) : (
		                    <button className="btn" onClick={() => setActiveTab('wallets')}>
		                      Open channel…
		                    </button>
		                  )}
		                </div>
		              </div>
            </Panel>

	            <Panel title="Live Feed">
	              <div className="row">
	                <input
	                  className="input"
	                  value={scChannels}
	                  onChange={(e) => setRendezvousChannelsFromInput(e.target.value)}
	                  placeholder="channels (csv)"
	                />
	                <span className={`chip ${scConnected ? 'hi' : scConnecting ? 'warn' : ''}`}>
	                  {scConnected ? 'connected' : scConnecting ? 'connecting' : 'stopped'}
	                </span>
	                <button className="btn primary" onClick={startScStream} disabled={!health?.ok || stackOpBusy}>
	                  {scConnected || scConnecting ? 'Reconnect' : 'Connect'}
	                </button>
	              </div>
		              {scStreamErr ? <div className="alert bad">feed: {scStreamErr}</div> : null}
              <div className="row">
                <input
                  className="input"
                  value={scFilter.channel}
                  onChange={(e) => setScFilter((p) => ({ ...p, channel: e.target.value }))}
                  placeholder="filter channel (contains)"
                />
                <input
                  className="input"
                  value={scFilter.kind}
                  onChange={(e) => setScFilter((p) => ({ ...p, kind: e.target.value }))}
                  placeholder="filter kind (contains)"
                />
              </div>
              <div className="muted small">Filters are substring matches. Example: kind=<span className="mono">swap.rfq</span>.</div>
              <VirtualList
                listRef={scListRef}
                items={filteredScEventsDisplay}
                itemKey={(e) => String(e.db_id || e.seq || e.id || e.ts || '')}
                estimatePx={78}
                onScroll={onScScroll}
                render={(e) => (
                  <EventRow
                    evt={e}
                    onSelect={() => setSelected({ type: 'sc_event', evt: e })}
                    selected={selected?.type === 'sc_event' && selected?.evt?.seq === e.seq}
                  />
                )}
              />
            </Panel>

            <Panel title="Trade Automation (Backend)">
              <div className="row">
                <button
                  className={`btn small ${tradeAutoStatus?.running ? 'ghost' : 'primary'}`}
                  onClick={() => void setTradeWorkerMode(!(tradeAutoStatus?.running === true))}
                  disabled={runBusy || stackOpBusy}
                >
                  {tradeAutoStatus?.running ? 'Disable Worker' : 'Enable Worker'}
                </button>
                <button
                  className={`btn small ${tradeAutoStatus?.trace_enabled ? 'ghost' : 'primary'}`}
                  onClick={() => void setTradeTraceMode(!(tradeAutoStatus?.trace_enabled === true))}
                  disabled={runBusy || stackOpBusy}
                >
                  {tradeAutoStatus?.trace_enabled ? 'Disable Trace' : 'Enable Trace'}
                </button>
                <span className={`chip ${tradeAutoStatus?.trace_enabled ? 'hi' : 'warn'}`}>
                  {tradeAutoStatus?.trace_enabled ? 'trace on' : 'trace off'}
                </span>
                <span className={`chip ${tradeAutoStatus?.running ? 'hi' : 'warn'}`}>
                  {tradeAutoStatus?.running ? 'worker on' : 'worker off'}
                </span>
                {tradeAutoStatus?.stats?.actions !== undefined ? (
                  <span className="chip">actions: {Number(tradeAutoStatus.stats.actions || 0)}</span>
                ) : null}
                {tradeAutoStatus?.stats?.ticks !== undefined ? (
                  <span className="chip">ticks: {Number(tradeAutoStatus.stats.ticks || 0)}</span>
                ) : null}
                {tradeAutoStatus?.stats?.last_tick_at ? (
                  <span className="chip">last tick: {msToUtcIso(Number(tradeAutoStatus.stats.last_tick_at))}</span>
                ) : null}
              </div>
              {!tradeAutoStatus?.trace_enabled ? (
                <div className="muted small" style={{ marginTop: 6 }}>
                  Trace is disabled by default. The worker can still trade automatically while trace is off.
                </div>
              ) : null}
              {preflight?.tradeauto_error ? (
                <div className="alert bad" style={{ marginTop: 8 }}>
                  tradeauto_status: {String(preflight.tradeauto_error)}
                </div>
              ) : null}
              {tradeAutoStatus?.stats?.last_error ? (
                <div className="alert warn" style={{ marginTop: 8 }}>
                  last error: {String(tradeAutoStatus.stats.last_error)}
                </div>
              ) : null}
              {tradeAutoStatus?.trace_enabled ? (
                <>
                  <div className="muted small" style={{ marginTop: 6 }}>
                    backend trace from <span className="mono">intercomswap_tradeauto_status</span> (newest first)
                  </div>
                  <VirtualList
                    items={tradeAutoRecent}
                    itemKey={(e) => `${e.ts || 0}:${e.type}:${e.stage || ''}:${e.trade_id || ''}:${e._idx}`}
                    estimatePx={84}
                    render={(e: any) => (
                      <div className="rowitem">
                        <div className="rowitem-top">
                          <span className="mono chip">{String(e.type || 'trace')}</span>
                          <span className="mono dim">{typeof e.ts === 'number' ? msToUtcIso(e.ts) : '—'}</span>
                        </div>
                        <div className="rowitem-mid">
                          {e.trade_id ? (
                            <div>
                              trade: <span className="mono">{String(e.trade_id)}</span>
                            </div>
                          ) : null}
                          {e.stage ? (
                            <div>
                              stage: <span className="mono">{String(e.stage)}</span>
                            </div>
                          ) : null}
                          {e.channel ? (
                            <div>
                              channel: <span className="mono">{String(e.channel)}</span>
                            </div>
                          ) : null}
                          {e.sig ? (
                            <div>
                              sig: <span className="mono">{String(e.sig)}</span>
                            </div>
                          ) : null}
                          {typeof e.cooldown_ms === 'number' ? (
                            <div>
                              retry: <span className="mono">{Math.trunc(e.cooldown_ms)} ms</span>
                            </div>
                          ) : null}
                          {e.error ? (
                            <div className="mono" style={{ color: 'var(--bad)', whiteSpace: 'pre-wrap' }}>
                              {String(e.error)}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    )}
                  />
                </>
              ) : null}
            </Panel>
          </div>
        ) : null}

        {activeTab === 'prompt' ? (
          <div className="grid2">
            <Panel title="Prompt">
              <textarea
                className="textarea"
                value={promptInput}
                onChange={(e) => setPromptInput(e.target.value)}
                placeholder="Ask Collin to run actions using tools..."
              />
              <div className="row">
                <button
                  className="btn primary"
                  onClick={async () => {
                    const text = promptInput.trim();
                    if (!text) return;
                    setPromptInput('');
                    setRunMode('llm');
                    setRunErr(null);
                    setRunBusy(true);
                    try {
                      await appendChatMessage('user', text, { forceFollowTail: true });
                      const out = await fetchJson('/v1/run', {
                        method: 'POST',
                        body: JSON.stringify({ prompt: text, session_id: sessionId, auto_approve: autoApprove, dry_run: false }),
                      });
                      if (out && typeof out === 'object' && out.session_id) setSessionId(String(out.session_id));
                      const reply =
                        out && typeof out === 'object' && out.content_json !== undefined
                          ? typeof out.content_json === 'string'
                            ? out.content_json
                            : JSON.stringify(out.content_json, null, 2)
                          : out && typeof out === 'object' && typeof out.content === 'string'
                            ? out.content
                            : JSON.stringify(out, null, 2);
                      await appendChatMessage('assistant', reply);
                    } catch (e: any) {
                      const msg = e?.message || String(e);
                      pushToast('error', msg);
                      await appendChatMessage('assistant', `Error: ${msg}`);
                    } finally {
                      setRunBusy(false);
                    }
                  }}
                  disabled={runBusy || !health?.ok}
                >
                  {runBusy ? 'Running…' : 'Run'}
                </button>
                <button
                  className="btn"
                  onClick={async () => {
                    try {
                      await chatClear();
                    } catch (_e) {}
                    setPromptChat([]);
                    setPromptChatUnseen(0);
                    promptChatFollowTailRef.current = true;
                    setPromptChatFollowTail(true);
                    requestAnimationFrame(scrollChatToBottom);
                  }}
                  disabled={runBusy}
                >
                  Clear chat
                </button>
              </div>
            </Panel>
            <Panel title="Chat">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <div className="muted small">
                  {promptChatFollowTail ? (
                    <span className="chip hi">following</span>
                  ) : (
                    <span className="chip warn">paused</span>
                  )}
                  {promptChatUnseen > 0 ? (
                    <span className="chip" style={{ marginLeft: 8 }}>
                      {promptChatUnseen} new
                    </span>
                  ) : null}
                </div>
                {!promptChatFollowTail || promptChatUnseen > 0 ? (
                  <button
                    className="btn small"
                    onClick={async () => {
                      promptChatFollowTailRef.current = true;
                      setPromptChatFollowTail(true);
                      setPromptChatUnseen(0);
                      try {
                        const ch = await chatListLatest({ limit: 300 });
                        setPromptChat(
                          ch
                            .map((r: any) => ({
                              id: Number(r.id),
                              role: normalizeChatRole(r.role),
                              ts: Number(r.ts),
                              text: String(r.text || ''),
                            }))
                            .reverse()
                        );
                      } catch (_e) {}
                      requestAnimationFrame(scrollChatToBottom);
                    }}
                  >
                    Scroll to bottom
                  </button>
                ) : (
                  <span />
                )}
              </div>
              <VirtualList
                listRef={promptChatListRef}
                items={promptChat}
                itemKey={(m) => String(m?.id || '')}
                estimatePx={84}
                onScroll={onPromptChatScroll}
                render={(m) => (
                  <div className="rowitem">
                    <div className="rowitem-top">
                      <span className={`mono chip ${m.role === 'assistant' ? 'hi' : ''}`}>{m.role}</span>
                      <span className="mono dim">{new Date(m.ts).toLocaleTimeString()}</span>
                    </div>
                    <div className="rowitem-mid">
                      <span className="mono" style={{ whiteSpace: 'pre-wrap' }}>
                        {String(m.text || '')}
                      </span>
                    </div>
                  </div>
                )}
              />
            </Panel>
          </div>
        ) : null}

        {activeTab === 'sell_usdt' ? (
          <div className="grid2">
            <Panel title="Sell USDT">
              {!stackGate.ok ? (
                <div className="alert warn">
                  <b>Offer setup incomplete.</b> Complete these checklist items to enable posting:
                  <div className="muted small" style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>
                    {stackGate.reasons.length > 0 ? stackGate.reasons.map((r) => `- ${r}`).join('\n') : '- unknown'}
                  </div>
                </div>
              ) : null}

              <div className="field">
                <div className="field-hd">
                  <span className="mono">Label (optional)</span>
                </div>
                <input
                  className="input"
                  value={offerName}
                  onChange={(e) => setOfferName(e.target.value)}
                  placeholder="maker:alice (auto if empty)"
                />
                <div className="muted small">Display-only label. Not unique. Auto-generated if empty.</div>
              </div>

              <div className="field">
                <div className="field-hd">
                  <span className="mono">Rendezvous Channels</span>
                </div>
                <input
                  className="input mono"
                  value={scChannels}
                  onChange={(e) => setRendezvousChannelsFromInput(e.target.value)}
                  placeholder="0000intercomswapbtcusdt"
                />
                <div className="muted small">Offers are broadcast here. BTC sellers post matching RFQs into the same channels.</div>
              </div>

              <div className="field">
                <div className="muted small">
                  wallet snapshot:{' '}
                  LN inbound(single) <span className="mono">{typeof lnMaxInboundSats === 'number' ? `${lnMaxInboundSats} sats` : '—'}</span>
                  {' · '}USDT <span className="mono">{usdtBalanceAtomic || '—'}</span> atomic
                  {' · '}SOL <span className="mono">{Number.isFinite(solLamportsAvailable as any) ? `${solLamportsAvailable} lamports` : '—'}</span>
                </div>
              </div>

	              <div className="field">
	                <div className="field-hd">
	                  <span className="mono">Offer Lines</span>
	                </div>
	                <div className="muted small">Add multiple price points in one broadcast (max 20 lines).</div>
	                {offerLines.map((l, idx) => (
	                  <div key={l.id} className="rowitem" style={{ marginTop: 10 }}>
	                    <div className="rowitem-top">
	                      <span className="mono chip">{idx + 1}</span>
	                      {offerLines.length > 1 ? (
	                        <button
	                          className="btn small danger"
	                          onClick={() => setOfferLines((prev) => prev.filter((x) => x.id !== l.id))}
	                        >
	                          Remove
	                        </button>
	                      ) : null}
	                    </div>
	                    <div className="rowitem-mid">
	                      <div className="gridform" style={{ width: '100%' }}>
	                        <div className="field">
	                          <div className="field-hd">
	                            <span className="mono">Receive BTC (Lightning)</span>
	                          </div>
	                          <BtcSatsField
	                            name={`offer_btc_${l.id}`}
	                            sats={l.btc_sats}
	                            onSats={(n) =>
	                              setOfferLines((prev) =>
	                                prev.map((x) => (x.id === l.id ? { ...x, btc_sats: Number(n || 0) } : x))
	                              )
	                            }
	                          />
	                        </div>
	                        <div className="field">
	                          <div className="field-hd">
	                            <span className="mono">Pay USDT (Solana)</span>
	                          </div>
	                          <UsdtAtomicField
	                            decimals={6}
	                            atomic={l.usdt_amount}
	                            onAtomic={(a) =>
	                              setOfferLines((prev) =>
	                                prev.map((x) => (x.id === l.id ? { ...x, usdt_amount: String(a || '') } : x))
	                              )
	                            }
	                            placeholder="10"
		                          />
		                        </div>
		                      </div>
		                      {(() => {
		                        const btcSats = Number(l.btc_sats);
		                        const usdtAtomic = String(l.usdt_amount || '').trim();
		                        const btcBtc = Number.isFinite(btcSats) ? btcSats / 1e8 : null;
		                        const usdt = usdtAtomic ? atomicToNumber(usdtAtomic, 6) : null;
		                        const implied = btcBtc && btcBtc > 0 && usdt !== null ? usdt / btcBtc : null;
		                        const btcUsd = btcBtc !== null && oracle.btc_usd ? btcBtc * oracle.btc_usd : null;
		                        const usdtUsd = usdt !== null && oracle.usdt_usd ? usdt * oracle.usdt_usd : null;
                            const usdtHave = parseAtomicBigInt(usdtBalanceAtomic);
                            const usdtNeed = parseAtomicBigInt(usdtAtomic);
                            const usdtNeedWithFees = usdtNeed !== null ? applyBpsCeilAtomic(usdtNeed, offerMaxTotalFeeBps) : null;
                            const usdtOk = usdtNeedWithFees !== null && usdtHave !== null ? usdtNeedWithFees <= usdtHave : null;
                            const solOk = Number.isFinite(solLamportsAvailable as any)
                              ? Number(solLamportsAvailable) >= SOL_TX_FEE_BUFFER_LAMPORTS
                              : null;
                            if (implied === null && btcUsd === null && usdtUsd === null && usdtNeedWithFees === null) return null;
		                        return (
		                          <div className="muted small" style={{ marginTop: 6 }}>
		                            {typeof implied === 'number' && Number.isFinite(implied) ? (
		                              <span>
		                                implied: <span className="mono">{implied.toFixed(2)}</span> USDT/BTC
		                              </span>
		                            ) : null}
		                            {btcUsd !== null ? (
		                              <span>
		                                {implied !== null ? ' · ' : ''}
		                                BTC value: <span className="mono">{fmtUsd(btcUsd)}</span>
		                              </span>
		                            ) : null}
		                            {usdtUsd !== null ? (
		                              <span>
		                                {(implied !== null || btcUsd !== null) ? ' · ' : ''}
		                                USDT value: <span className="mono">{fmtUsd(usdtUsd)}</span>
		                              </span>
		                            ) : null}
                            {usdtNeedWithFees !== null ? (
                              <span>
                                {(implied !== null || btcUsd !== null || usdtUsd !== null) ? ' · ' : ''}
                                need/have:{' '}
                                <span className="mono" style={usdtOk === false ? { color: 'var(--bad)' } : undefined}>
                                  {usdtNeedWithFees.toString()}
                                </span>{' '}
                                /{' '}
                                <span className="mono">{usdtHave !== null ? usdtHave.toString() : '—'}</span> atomic USDT
                              </span>
                            ) : null}
                            {solOk !== null ? (
                              <span>
                                {(implied !== null || btcUsd !== null || usdtUsd !== null || usdtNeedWithFees !== null) ? ' · ' : ''}
                                SOL fee buffer:{' '}
                                <span className="mono" style={solOk ? undefined : { color: 'var(--bad)' }}>
                                  {solOk ? 'ok' : 'low'}
                                </span>
                              </span>
                            ) : null}
		                          </div>
		                        );
		                      })()}
		                    </div>
		                  </div>
		                ))}
	                <div className="row" style={{ marginTop: 10 }}>
	                  <button
	                    className="btn"
	                    onClick={() =>
	                      setOfferLines((prev) => {
	                        if (prev.length >= 20) return prev;
	                        const last = prev[prev.length - 1] || { btc_sats: 10_000, usdt_amount: '1000000' };
	                        return prev.concat([
	                          {
	                            id: `offer-${Date.now()}-${Math.random().toString(16).slice(2)}`,
	                            btc_sats: Number((last as any).btc_sats) || 0,
	                            usdt_amount: String((last as any).usdt_amount || ''),
	                          },
	                        ]);
	                      })
	                    }
	                    disabled={offerBusy || offerLines.length >= 20}
	                  >
	                    + Add line
	                  </button>
	                </div>
	              </div>

              <div className="field">
                <div className="field-hd">
                  <span className="mono">Fee Caps</span>
                </div>
                <div className="gridform">
                  <div className="amt">
                    <div className="muted small">platform (fixed)</div>
                    <div className="mono">{bpsToPctDisplay(offerMaxPlatformFeeBps)}%</div>
                    <div className="muted small">
                      bps: <span className="mono">{offerMaxPlatformFeeBps}</span>
                    </div>
                  </div>
                  <PctBpsField
                    label="trade"
                    maxBps={1000}
                    bps={offerMaxTradeFeeBps}
                    onBps={(n) => setOfferMaxTradeFeeBps(n ?? 0)}
                  />
                  <PctBpsField
                    label="total"
                    maxBps={1500}
                    bps={offerMaxTotalFeeBps}
                    onBps={(n) => setOfferMaxTotalFeeBps(n ?? 0)}
                  />
                </div>
                <div className="muted small">platform fee comes from the Solana program config (not negotiated). total must be &gt;= platform + trade.</div>
              </div>

              <div className="field">
                <div className="field-hd">
                  <span className="mono">Solana Refund Window (Bounds)</span>
                </div>
                <div className="gridform">
                  <div>
                    <div className="muted small">min</div>
                    <DurationSecField
                      name="offer_minwin"
                      sec={offerMinSolRefundWindowSec}
                      onSec={(s: number | null) => setOfferMinSolRefundWindowSec(typeof s === 'number' ? s : 0)}
                    />
                  </div>
                  <div>
                    <div className="muted small">max</div>
                    <DurationSecField
                      name="offer_maxwin"
                      sec={offerMaxSolRefundWindowSec}
                      onSec={(s: number | null) => setOfferMaxSolRefundWindowSec(typeof s === 'number' ? s : 0)}
                    />
                  </div>
                </div>
              </div>

              <div className="field">
                <div className="field-hd">
                  <span className="mono">Expires</span>
                </div>
                <input
                  className="input mono"
                  type="datetime-local"
                  value={unixSecToDateTimeLocal(offerValidUntilUnix)}
                  onChange={(e) => {
                    const sec = dateTimeLocalToUnixSec(e.target.value);
                    if (sec !== null) setOfferValidUntilUnix(sec);
                  }}
                />
                <div className="muted small">UTC: <span className="mono">{unixSecToUtcIso(offerValidUntilUnix)}</span></div>
                <div className="row">
                  <button
                    className="btn small"
                    onClick={() => setOfferValidUntilUnix(Math.floor(Date.now() / 1000) + 5 * 60)}
                    disabled={offerBusy}
                  >
                    +5m
                  </button>
                  <button
                    className="btn small"
                    onClick={() => setOfferValidUntilUnix(Math.floor(Date.now() / 1000) + 10 * 60)}
                    disabled={offerBusy}
                  >
                    +10m
                  </button>
                  <button
                    className="btn small"
                    onClick={() => setOfferValidUntilUnix(Math.floor(Date.now() / 1000) + 30 * 60)}
                    disabled={offerBusy}
                  >
                    +30m
                  </button>
                  <button
                    className="btn small"
                    onClick={() => setOfferValidUntilUnix(Math.floor(Date.now() / 1000) + 3600)}
                    disabled={offerBusy}
                  >
                    +1h
                  </button>
                  <button
                    className="btn small"
                    onClick={() => setOfferValidUntilUnix(Math.floor(Date.now() / 1000) + 5 * 3600)}
                    disabled={offerBusy}
                  >
                    +5h
                  </button>
                  <button
                    className="btn small"
                    onClick={() => setOfferValidUntilUnix(Math.floor(Date.now() / 1000) + 10 * 3600)}
                    disabled={offerBusy}
                  >
                    +10h
                  </button>
                  <button
                    className="btn small"
                    onClick={() => setOfferValidUntilUnix(Math.floor(Date.now() / 1000) + 24 * 3600)}
                    disabled={offerBusy}
                  >
                    +24h
                  </button>
                  <button
                    className="btn small"
                    onClick={() => setOfferValidUntilUnix(Math.floor(Date.now() / 1000) + 72 * 3600)}
                    disabled={offerBusy}
                  >
                    +72h
                  </button>
                  <button
                    className="btn small"
                    onClick={() => setOfferValidUntilUnix(Math.floor(Date.now() / 1000) + 7 * 24 * 3600)}
                    disabled={offerBusy}
                  >
                    +1w
                  </button>
                </div>
              </div>

              <div className="field">
                <div className="field-hd">
                  <span className="mono">Run As Bot (optional)</span>
                </div>
                <label className="check">
                  <input type="checkbox" checked={offerRunAsBot} onChange={(e) => setOfferRunAsBot(e.target.checked)} />
                  repost this offer periodically
                </label>
                {offerRunAsBot ? (
                  <div className="row" style={{ marginTop: 6 }}>
                    <span className="muted small">interval</span>
                    <select className="select" value={String(offerBotIntervalSec)} onChange={(e) => setOfferBotIntervalSec(Number(e.target.value) || 60)}>
                      <option value="10">10s</option>
                      <option value="30">30s</option>
                      <option value="60">60s</option>
                      <option value="300">5m</option>
                      <option value="600">10m</option>
                    </select>
                  </div>
                ) : null}
              </div>

              {offerAutopostJobs.length > 0 ? (
                <div className="field">
                  <div className="field-hd">
                    <span className="mono">Offer Bots</span>
                  </div>
                  <div className="muted small">Running bots can be stopped without restarting the stack.</div>
                  <VirtualList
                    items={offerAutopostJobs}
                    itemKey={(j: any) => String(j?.name || '')}
                    estimatePx={64}
                    render={(j: any) => (
                      <div className="row" style={{ marginTop: 6 }}>
                        <span className={`chip ${j.last_ok === false ? 'danger' : j.last_ok === true ? 'hi' : ''}`}>
                          {String(j.name)}
                        </span>
                        <span className="muted small">
                          every {secToHuman(Number(j.interval_sec || 0))} · expires{' '}
                          {typeof j.valid_until_unix === 'number' ? unixSecToUtcIso(j.valid_until_unix) : '—'}
                        </span>
                        <button
                          className="btn small"
                          onClick={() => {
                            try {
                              const a = j?.args && typeof j.args === 'object' ? j.args : null;
                              const chans = Array.isArray(a?.channels)
                                ? a.channels.map((c: any) => String(c || '').trim()).filter(Boolean)
                                : [];
                              if (chans.length > 0) setRendezvousChannels(chans);
                              if (typeof a?.name === 'string') setOfferName(a.name);
                              const offers = Array.isArray(a?.offers) ? a.offers : [];
                              const lines = offers
                                .map((o: any, i: number) => ({
                                  id: `loaded-${Date.now()}-${i}`,
                                  btc_sats: Number(o?.btc_sats) || 0,
                                  usdt_amount: String(o?.usdt_amount || '').trim(),
                                }))
                                .filter((x: any) => Number.isInteger(x.btc_sats) && x.btc_sats >= 0 && /^[0-9]+$/.test(x.usdt_amount || ''));
                              if (lines.length > 0) setOfferLines(lines.slice(0, 20));
                              const o0 = offers[0] && typeof offers[0] === 'object' ? offers[0] : null;
                              if (o0) {
                                if (typeof o0.max_trade_fee_bps === 'number') setOfferMaxTradeFeeBps(o0.max_trade_fee_bps);
                                if (typeof o0.max_total_fee_bps === 'number') setOfferMaxTotalFeeBps(o0.max_total_fee_bps);
                                if (typeof o0.min_sol_refund_window_sec === 'number') setOfferMinSolRefundWindowSec(o0.min_sol_refund_window_sec);
                                if (typeof o0.max_sol_refund_window_sec === 'number') setOfferMaxSolRefundWindowSec(o0.max_sol_refund_window_sec);
                              }
                              setOfferRunAsBot(true);
                              const intv = Number(j?.interval_sec || 0);
                              if (Number.isFinite(intv) && intv > 0) setOfferBotIntervalSec(Math.trunc(intv));
                              const vu = Number(j?.valid_until_unix || 0);
                              if (Number.isFinite(vu) && vu > 0) setOfferValidUntilUnix(Math.trunc(vu));
                              pushToast('success', `Loaded bot config (${String(j.name)})`);
                            } catch (e: any) {
                              pushToast('error', e?.message || String(e));
                            }
                          }}
                        >
                          Load
                        </button>
                        <button className="btn small danger" onClick={() => void stopAutopostJob(String(j.name))}>
                          Stop
                        </button>
                      </div>
                    )}
                  />
                </div>
              ) : null}

              <div className="row">
                <button
                  className="btn primary"
                  onClick={postOffer}
                  disabled={offerBusy || stackOpBusy || !health?.ok || !stackGate.ok}
                >
                  {offerBusy ? 'Posting…' : offerRunAsBot ? 'Start Offer Bot' : 'Post Offer'}
                </button>
              </div>
            </Panel>

            <Panel title="Activity">
              <VirtualList
                items={sellUsdtFeedItems}
                itemKey={(it) => String(it?.id || '')}
                estimatePx={58}
                render={(it) =>
                  it._t === 'header' ? (
                    <div className="feedhdr feedhdr-toggle" onClick={it.onToggle}>
                      <span className="mono">{it.title} <span className="dim">{typeof it.count === 'number' ? it.count : ''}</span></span>
                      <span className="mono dim">{it.open ? '▾' : '▸'}</span>
                    </div>
	                  ) : it._t === 'offer' ? (
	                    <OfferRow
	                      evt={it.evt}
	                      oracle={oracle}
	                      showRespond={false}
	                      onSelect={() => setSelected({ type: it.badge ? 'offer_posted' : 'offer', evt: it.evt })}
	                      onRespond={() => {}}
	                    />
	                  ) : (
	                    <RfqRow
	                      evt={it.evt}
	                      oracle={oracle}
	                      showQuote={!it.badge}
	                      onSelect={() => setSelected({ type: it.badge ? 'rfq_posted' : 'rfq', evt: it.evt })}
	                      onQuote={() => {
	                        void (async () => {
	                          try {
	                            const out = await quoteFromRfqEnvelope(it.evt, { origin: 'manual' });
	                            const quoteId = String((out as any)?.quote_id || '').trim();
	                            pushToast('success', `Quote posted${quoteId ? ` (${quoteId.slice(0, 12)}…)` : ''}`);
	                          } catch (e: any) {
	                            pushToast('error', e?.message || String(e));
	                          }
	                        })();
	                      }}
	                    />
	                  )
                }
              />
            </Panel>
          </div>
        ) : null}

        {activeTab === 'sell_btc' ? (
          <div className="grid2">
            <Panel title="Sell BTC">
              {!stackGate.ok ? (
                <div className="alert warn">
                  <b>RFQ setup incomplete.</b> Complete these checklist items to enable posting:
                  <div className="muted small" style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>
                    {stackGate.reasons.length > 0 ? stackGate.reasons.map((r) => `- ${r}`).join('\n') : '- unknown'}
                  </div>
                </div>
              ) : null}

              <div className="field">
                <div className="field-hd">
                  <span className="mono">Channel</span>
                </div>
                <select className="select" value={rfqChannel} onChange={(e) => setRfqChannel(e.target.value)}>
                  {knownRendezvousChannelsForInputs.length > 0 ? (
                    knownRendezvousChannelsForInputs.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))
                  ) : (
                    <option value={rendezvousChannels[0] || '0000intercomswapbtcusdt'}>default</option>
                  )}
                </select>
              </div>

              <div className="field">
                <div className="muted small">
                  wallet snapshot:{' '}
                  LN send(single) <span className="mono">{typeof lnMaxOutboundSats === 'number' ? `${lnMaxOutboundSats} sats` : '—'}</span>
                  {' · '}LN send(total) <span className="mono">{typeof lnTotalOutboundSats === 'number' ? `${lnTotalOutboundSats} sats` : '—'}</span>
                  {' · '}USDT <span className="mono">{usdtBalanceAtomic || '—'}</span> atomic
                  {' · '}SOL <span className="mono">{Number.isFinite(solLamportsAvailable as any) ? `${solLamportsAvailable} lamports` : '—'}</span>
                  {' · '}sol_recipient <span className="mono">{solSignerPubkey || '—'}</span>
                </div>
              </div>

              <div className="field">
                <div className="field-hd">
                  <span className="mono">RFQ Lines</span>
                </div>
                <div className="muted small">Each line posts a separate RFQ (max 20).</div>
                {rfqLines.map((l, idx) => (
                  <div key={l.id} className="rowitem" style={{ marginTop: 10 }}>
                    <div className="rowitem-top">
                      <span className="mono chip">{idx + 1}</span>
                      <span className="muted small">
                        trade_id: <span className="mono">{String(l.trade_id || '').slice(0, 24)}{String(l.trade_id || '').length > 24 ? '…' : ''}</span>
                      </span>
                      <button className="btn small" onClick={() => copyToClipboard('trade_id', l.trade_id)} disabled={!String(l.trade_id || '').trim()}>
                        Copy
                      </button>
                      {rfqLines.length > 1 ? (
                        <button className="btn small danger" onClick={() => setRfqLines((prev) => prev.filter((x) => x.id !== l.id))}>
                          Remove
                        </button>
                      ) : null}
                    </div>
                    <div className="rowitem-mid">
                      <div className="gridform" style={{ width: '100%' }}>
                        <div className="field">
                          <div className="field-hd">
                            <span className="mono">Pay BTC (Lightning)</span>
                          </div>
                          <BtcSatsField
                            name={`rfq_btc_${l.id}`}
                            sats={l.btc_sats}
                            onSats={(n) =>
                              setRfqLines((prev) =>
                                prev.map((x) => (x.id === l.id ? { ...x, btc_sats: Number(n || 0) } : x))
                              )
                            }
                          />
                        </div>
                        <div className="field">
                          <div className="field-hd">
                            <span className="mono">Receive USDT (Solana)</span>
                          </div>
                          <UsdtAtomicField
                            decimals={6}
                            atomic={l.usdt_amount}
                            onAtomic={(a) =>
                              setRfqLines((prev) =>
                                prev.map((x) => (x.id === l.id ? { ...x, usdt_amount: String(a || '') } : x))
                              )
                            }
                            placeholder="10"
                          />
                        </div>
                      </div>
                      {(() => {
                        const btcSats = Number(l.btc_sats);
                        const usdtAtomic = String(l.usdt_amount || '').trim();
                        const btcBtc = Number.isFinite(btcSats) ? btcSats / 1e8 : null;
                        const usdt = usdtAtomic ? atomicToNumber(usdtAtomic, 6) : null;
                        const implied = btcBtc && btcBtc > 0 && usdt !== null ? usdt / btcBtc : null;
                        const btcUsd = btcBtc !== null && oracle.btc_usd ? btcBtc * oracle.btc_usd : null;
                        const usdtUsd = usdt !== null && oracle.usdt_usd ? usdt * oracle.usdt_usd : null;
                        const btcNeed = Number.isFinite(btcSats) ? btcSats + Math.max(LN_ROUTE_FEE_BUFFER_MIN_SATS, Math.ceil(btcSats * (LN_ROUTE_FEE_BUFFER_BPS / 10_000))) : null;
                        const btcHave =
                          lnLiquidityMode === 'aggregate'
                            ? (typeof lnTotalOutboundSats === 'number' ? lnTotalOutboundSats : null)
                            : (typeof lnMaxOutboundSats === 'number' ? lnMaxOutboundSats : null);
                        const btcOk = btcNeed !== null && typeof btcHave === 'number' ? btcNeed <= btcHave : null;
                        const usdtHave = parseAtomicBigInt(usdtBalanceAtomic);
                        const solOk = Number.isFinite(solLamportsAvailable as any)
                          ? Number(solLamportsAvailable) >= SOL_TX_FEE_BUFFER_LAMPORTS
                          : null;
                        if (implied === null && btcUsd === null && usdtUsd === null && btcNeed === null) return null;
                        return (
                          <div className="muted small" style={{ marginTop: 6 }}>
                            {typeof implied === 'number' && Number.isFinite(implied) ? (
                              <span>
                                implied: <span className="mono">{implied.toFixed(2)}</span> USDT/BTC
                              </span>
                            ) : null}
                            {btcUsd !== null ? (
                              <span>
                                {implied !== null ? ' · ' : ''}
                                BTC value: <span className="mono">{fmtUsd(btcUsd)}</span>
                              </span>
                            ) : null}
                            {usdtUsd !== null ? (
                              <span>
                                {(implied !== null || btcUsd !== null) ? ' · ' : ''}
                                USDT value: <span className="mono">{fmtUsd(usdtUsd)}</span>
                              </span>
                            ) : null}
                            {btcNeed !== null ? (
                              <span>
                                {(implied !== null || btcUsd !== null || usdtUsd !== null) ? ' · ' : ''}
                                need/have ({lnLiquidityMode === 'aggregate' ? 'agg' : 'single'}):{' '}
                                <span className="mono" style={btcOk === false ? { color: 'var(--bad)' } : undefined}>
                                  {btcNeed}
                                </span>{' '}
                                /{' '}
                                <span className="mono">{typeof btcHave === 'number' ? btcHave : '—'}</span> sats
                              </span>
                            ) : null}
                            <span>
                              {(implied !== null || btcUsd !== null || usdtUsd !== null || btcNeed !== null) ? ' · ' : ''}
                              USDT wallet: <span className="mono">{usdtHave !== null ? usdtHave.toString() : '—'}</span> atomic
                            </span>
                            {solOk !== null ? (
                              <span>
                                {' · '}SOL fee buffer:{' '}
                                <span className="mono" style={solOk ? undefined : { color: 'var(--bad)' }}>
                                  {solOk ? 'ok' : 'low'}
                                </span>
                              </span>
                            ) : null}
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                ))}
                <div className="row" style={{ marginTop: 10 }}>
                  <button
                    className="btn"
                    onClick={() =>
                      setRfqLines((prev) => {
                        if (prev.length >= 20) return prev;
                        const last = prev[prev.length - 1] || { btc_sats: 10_000, usdt_amount: '1000000' };
                        const now = Date.now();
                        return prev.concat([
                          {
                            id: `rfq-${now}-${Math.random().toString(16).slice(2)}`,
                            trade_id: `rfq-${now}-${Math.random().toString(16).slice(2, 10)}`,
                            btc_sats: Number((last as any).btc_sats) || 0,
                            usdt_amount: String((last as any).usdt_amount || ''),
                          },
                        ]);
                      })
                    }
                    disabled={rfqBusy || rfqLines.length >= 20}
                  >
                    + Add line
                  </button>
                </div>
              </div>

	              <div className="field">
	                <div className="field-hd">
	                  <span className="mono">Fee Caps</span>
	                </div>
                <div className="gridform">
                  <div className="amt">
                    <div className="muted small">platform (fixed)</div>
                    <div className="mono">{bpsToPctDisplay(rfqMaxPlatformFeeBps)}%</div>
                    <div className="muted small">
                      bps: <span className="mono">{rfqMaxPlatformFeeBps}</span>
                    </div>
                  </div>
                  <PctBpsField
                    label="trade"
                    maxBps={1000}
                    bps={rfqMaxTradeFeeBps}
                    onBps={(n) => setRfqMaxTradeFeeBps(n ?? 0)}
                  />
                  <PctBpsField
                    label="total"
                    maxBps={1500}
                    bps={rfqMaxTotalFeeBps}
                    onBps={(n) => setRfqMaxTotalFeeBps(n ?? 0)}
                  />
                </div>
                <div className="muted small">platform fee comes from the Solana program config (not negotiated). total must be &gt;= platform + trade.</div>
              </div>

              <div className="field">
                <div className="field-hd">
                  <span className="mono">Solana Refund Window (Bounds)</span>
                </div>
                <div className="gridform">
                  <div>
                    <div className="muted small">min</div>
                    <DurationSecField
                      name="rfq_minwin"
                      sec={rfqMinSolRefundWindowSec}
                      onSec={(s: number | null) => setRfqMinSolRefundWindowSec(typeof s === 'number' ? s : 0)}
                    />
                  </div>
                  <div>
                    <div className="muted small">max</div>
                    <DurationSecField
                      name="rfq_maxwin"
                      sec={rfqMaxSolRefundWindowSec}
                      onSec={(s: number | null) => setRfqMaxSolRefundWindowSec(typeof s === 'number' ? s : 0)}
                    />
                  </div>
                </div>
              </div>

              <div className="field">
                <div className="field-hd">
                  <span className="mono">Expires</span>
                </div>
                <input
                  className="input mono"
                  type="datetime-local"
                  value={unixSecToDateTimeLocal(rfqValidUntilUnix)}
                  onChange={(e) => {
                    const sec = dateTimeLocalToUnixSec(e.target.value);
                    if (sec !== null) setRfqValidUntilUnix(sec);
                  }}
                />
                <div className="muted small">UTC: <span className="mono">{unixSecToUtcIso(rfqValidUntilUnix)}</span></div>
                <div className="row">
                  <button
                    className="btn small"
                    onClick={() => setRfqValidUntilUnix(Math.floor(Date.now() / 1000) + 5 * 60)}
                    disabled={rfqBusy}
                  >
                    +5m
                  </button>
                  <button
                    className="btn small"
                    onClick={() => setRfqValidUntilUnix(Math.floor(Date.now() / 1000) + 10 * 60)}
                    disabled={rfqBusy}
                  >
                    +10m
                  </button>
                  <button
                    className="btn small"
                    onClick={() => setRfqValidUntilUnix(Math.floor(Date.now() / 1000) + 30 * 60)}
                    disabled={rfqBusy}
                  >
                    +30m
                  </button>
                  <button
                    className="btn small"
                    onClick={() => setRfqValidUntilUnix(Math.floor(Date.now() / 1000) + 3600)}
                    disabled={rfqBusy}
                  >
                    +1h
                  </button>
                  <button
                    className="btn small"
                    onClick={() => setRfqValidUntilUnix(Math.floor(Date.now() / 1000) + 5 * 3600)}
                    disabled={rfqBusy}
                  >
                    +5h
                  </button>
                  <button
                    className="btn small"
                    onClick={() => setRfqValidUntilUnix(Math.floor(Date.now() / 1000) + 10 * 3600)}
                    disabled={rfqBusy}
                  >
                    +10h
                  </button>
                  <button
                    className="btn small"
                    onClick={() => setRfqValidUntilUnix(Math.floor(Date.now() / 1000) + 24 * 3600)}
                    disabled={rfqBusy}
                  >
                    +24h
                  </button>
                  <button
                    className="btn small"
                    onClick={() => setRfqValidUntilUnix(Math.floor(Date.now() / 1000) + 72 * 3600)}
                    disabled={rfqBusy}
                  >
                    +72h
                  </button>
                  <button
                    className="btn small"
                    onClick={() => setRfqValidUntilUnix(Math.floor(Date.now() / 1000) + 7 * 24 * 3600)}
                    disabled={rfqBusy}
                  >
                    +1w
                  </button>
                </div>
              </div>

              <div className="field">
                <div className="field-hd">
                  <span className="mono">Run As Bot (optional)</span>
                </div>
                <label className="check">
                  <input type="checkbox" checked={rfqRunAsBot} onChange={(e) => setRfqRunAsBot(e.target.checked)} />
                  repost this RFQ periodically
                </label>
                {rfqRunAsBot ? (
                  <div className="row" style={{ marginTop: 6 }}>
                    <span className="muted small">interval</span>
                    <select className="select" value={String(rfqBotIntervalSec)} onChange={(e) => setRfqBotIntervalSec(Number(e.target.value) || 60)}>
                      <option value="10">10s</option>
                      <option value="30">30s</option>
                      <option value="60">60s</option>
                      <option value="300">5m</option>
                      <option value="600">10m</option>
                    </select>
                  </div>
                ) : null}
              </div>

              {rfqAutopostJobs.length > 0 ? (
                <div className="field">
                  <div className="field-hd">
                    <span className="mono">RFQ Bots</span>
                  </div>
                  <div className="muted small">Running bots can be stopped without restarting the stack.</div>
                  <VirtualList
                    items={rfqAutopostJobs}
                    itemKey={(j: any) => String(j?.name || '')}
                    estimatePx={64}
                    render={(j: any) => (
                      <div className="row" style={{ marginTop: 6 }}>
                        <span className={`chip ${j.last_ok === false ? 'danger' : j.last_ok === true ? 'hi' : ''}`}>
                          {String(j.name)}
                        </span>
                        <span className="muted small">
                          every {secToHuman(Number(j.interval_sec || 0))} · expires{' '}
                          {typeof j.valid_until_unix === 'number' ? unixSecToUtcIso(j.valid_until_unix) : '—'}
                        </span>
                        <button
                          className="btn small"
                          onClick={() => {
                            try {
                              const a = j?.args && typeof j.args === 'object' ? j.args : null;
                              if (typeof a?.channel === 'string') {
                                const ch = String(a.channel || '').trim();
                                if (!isSwapTradeChannelName(ch)) setRfqChannel(ch);
                              }
                              const tradeIdRaw = typeof a?.trade_id === 'string' ? a.trade_id.trim() : '';
                              const trade_id = tradeIdRaw || `rfq-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
                              const btc_sats = typeof a?.btc_sats === 'number' ? a.btc_sats : 10_000;
                              const usdt_amount = typeof a?.usdt_amount === 'string' ? a.usdt_amount : '1000000';
                              setRfqLines([
                                {
                                  id: `loaded-${Date.now()}-${Math.random().toString(16).slice(2)}`,
                                  trade_id,
                                  btc_sats,
                                  usdt_amount,
                                },
                              ]);
                              if (typeof a?.max_trade_fee_bps === 'number') setRfqMaxTradeFeeBps(a.max_trade_fee_bps);
                              if (typeof a?.max_total_fee_bps === 'number') setRfqMaxTotalFeeBps(a.max_total_fee_bps);
                              if (typeof a?.min_sol_refund_window_sec === 'number') setRfqMinSolRefundWindowSec(a.min_sol_refund_window_sec);
                              if (typeof a?.max_sol_refund_window_sec === 'number') setRfqMaxSolRefundWindowSec(a.max_sol_refund_window_sec);
                              setRfqRunAsBot(true);
                              const intv = Number(j?.interval_sec || 0);
                              if (Number.isFinite(intv) && intv > 0) setRfqBotIntervalSec(Math.trunc(intv));
                              const vu = Number(j?.valid_until_unix || 0);
                              if (Number.isFinite(vu) && vu > 0) setRfqValidUntilUnix(Math.trunc(vu));
                              pushToast('success', `Loaded bot config (${String(j.name)})`);
                            } catch (e: any) {
                              pushToast('error', e?.message || String(e));
                            }
                          }}
                        >
                          Load
                        </button>
                        <button className="btn small danger" onClick={() => void stopAutopostJob(String(j.name))}>
                          Stop
                        </button>
                      </div>
                    )}
                  />
                </div>
              ) : null}

              <div className="row">
                <button
                  className="btn primary"
                  onClick={postRfq}
                  disabled={rfqBusy || stackOpBusy || !health?.ok || !stackGate.ok}
                >
                  {rfqBusy ? 'Posting…' : rfqRunAsBot ? 'Start RFQ Bot' : 'Post RFQ'}
                </button>
              </div>
            </Panel>

            <Panel title="Activity">
              <VirtualList
                items={sellBtcFeedItems}
                itemKey={(it) => String(it?.id || '')}
                estimatePx={58}
                render={(it) =>
                  it._t === 'header' ? (
                    <div className="feedhdr feedhdr-toggle" onClick={it.onToggle}>
                      <span className="mono">{it.title} <span className="dim">{typeof it.count === 'number' ? it.count : ''}</span></span>
                      <span className="mono dim">{it.open ? '▾' : '▸'}</span>
                    </div>
	                  ) : it._t === 'offer' ? (
	                    <OfferRow
	                      evt={it.evt}
	                      oracle={oracle}
	                      showRespond={!it.badge}
	                      onSelect={() => setSelected({ type: it.badge ? 'offer_posted' : 'offer', evt: it.evt })}
	                      onRespond={() => adoptOfferIntoRfqDraft(it.evt)}
	                    />
                    ) : it._t === 'quote' ? (
                      <QuoteRow
                        evt={it.evt}
                        oracle={oracle}
                        onSelect={() => setSelected({ type: 'quote', evt: it.evt })}
	                        onAccept={() => {
	                          void (async () => {
	                            try {
	                              const out = await acceptQuoteEnvelope(it.evt, { origin: 'manual' });
	                              const quoteId = String((out as any)?.quote_id || '').trim();
	                              pushToast('success', `Quote accepted${quoteId ? ` (${quoteId.slice(0, 12)}…)` : ''}`);
                            } catch (e: any) {
                              pushToast('error', e?.message || String(e));
                            }
                          })();
                        }}
                      />
	                  ) : (
	                    <RfqRow
	                      evt={it.evt}
	                      oracle={oracle}
	                      showQuote={false}
	                      onSelect={() => setSelected({ type: it.badge ? 'rfq_posted' : 'rfq', evt: it.evt })}
	                      onQuote={() => {}}
	                    />
                  )
                }
              />
            </Panel>
          </div>
        ) : null}

	        {activeTab === 'invites' ? (
	          <div className="grid2">
	            <Panel title="Swap Invites">
	              <p className="muted small">Actionable invites only. Expired/done invites are auto-hidden.</p>
	              <VirtualList
	                items={inviteEvents}
	                itemKey={(e) => String(e.db_id || e.seq || e.ts || '')}
	                estimatePx={92}
	                render={(e) => (
	                  (() => {
	                    const inviteObj = ((e as any)?.message?.body?.invite || null) as any;
	                    const invitePayload = inviteObj && typeof inviteObj === 'object' && inviteObj.payload && typeof inviteObj.payload === 'object'
	                      ? inviteObj.payload
	                      : inviteObj;
	                    const inviterFromInvite = String((invitePayload as any)?.inviterPubKey || '').trim().toLowerCase();
	                    const inviterFromEnvelope = String((e as any)?.message?.signer || '').trim().toLowerCase();
	                    const resolvedInviter =
	                      /^[0-9a-f]{64}$/i.test(inviterFromInvite)
	                        ? inviterFromInvite
	                        : /^[0-9a-f]{64}$/i.test(inviterFromEnvelope)
	                          ? inviterFromEnvelope
	                          : '';
	                    const joinable = Boolean(resolvedInviter);
	                    const joinBlockReason = joinable
	                      ? null
	                      : 'Invite is missing inviter identity (no invite.payload.inviterPubKey and no envelope signer).';
	                    return (
	                  <InviteRow
	                    evt={e}
	                    onSelect={() => setSelected({ type: 'invite', evt: e })}
                    onJoin={() => {
                        if (!joinable) {
                          pushToast('error', joinBlockReason || 'Invite not joinable yet');
                          return;
                        }
                        const swapCh = String((e as any)?.message?.body?.swap_channel || '').trim();
                        if (swapCh && joinedChannelsSet.has(swapCh)) {
                          if (swapCh && !watchedChannelsSet.has(swapCh)) watchChannel(swapCh);
                          pushToast('success', `Already joined ${swapCh}${!watchedChannelsSet.has(swapCh) ? ' (watch enabled)' : ''}`);
                          return;
                        }
                        try {
                          const tradeId = String((e as any)?.trade_id || (e as any)?.message?.trade_id || '').trim();
                          if (tradeId) dismissInviteTrade(tradeId);
                        } catch (_e) {}
	                      if (toolRequiresApproval('intercomswap_join_from_swap_invite') && !autoApprove) {
	                        const ok = window.confirm('Join this swap channel now?');
	                        if (!ok) return;
	                      }
	                      void (async () => {
	                        try {
	                          await runToolFinal('intercomswap_join_from_swap_invite', { swap_invite_envelope: e.message }, { auto_approve: true });
                            try {
                              if (swapCh) watchChannel(swapCh);
                            } catch (_e) {}
	                          pushToast('success', 'Joined swap channel');
                            void refreshPreflight();
	                        } catch (err: any) {
	                          pushToast('error', err?.message || String(err));
                            try {
                              const tradeId = String((e as any)?.trade_id || (e as any)?.message?.trade_id || '').trim();
                              if (tradeId) undismissInviteTrade(tradeId);
                            } catch (_e) {}
	                        }
	                      })();
	                    }}
                      onWatch={() => {
                        try {
                          const swapCh = String((e as any)?.message?.body?.swap_channel || '').trim();
                          if (swapCh) watchChannel(swapCh);
                        } catch (_e) {}
                      }}
                      onLeave={() => {
                        const swapCh = String((e as any)?.message?.body?.swap_channel || '').trim();
                        if (!swapCh) return;
                        try {
                          const tradeId = String((e as any)?.trade_id || (e as any)?.message?.trade_id || '').trim();
                          if (tradeId) dismissInviteTrade(tradeId);
                        } catch (_e) {}
                        if (toolRequiresApproval('intercomswap_sc_leave') && !autoApprove) {
                          const ok = window.confirm(`Leave channel?\n\n${swapCh}`);
                          if (!ok) return;
                        }
                        void (async () => {
                          try {
                            await runToolFinal('intercomswap_sc_leave', { channel: swapCh }, { auto_approve: true });
                            pushToast('success', `Left ${swapCh}`);
                            if (watchedChannelsSet.has(swapCh)) unwatchChannel(swapCh);
                            void refreshPreflight();
                          } catch (err: any) {
                            pushToast('error', err?.message || String(err));
                            try {
                              const tradeId = String((e as any)?.trade_id || (e as any)?.message?.trade_id || '').trim();
                              if (tradeId) undismissInviteTrade(tradeId);
                            } catch (_e) {}
                          }
                        })();
                      }}
                      onReceipt={() => {
                        const tradeId = String((e as any)?.trade_id || (e as any)?.message?.trade_id || '').trim();
                        if (!tradeId) return;
                        void (async () => {
                          try {
                            const t = await runDirectToolOnce('intercomswap_receipts_show', { ...receiptsDbArg, trade_id: tradeId }, { auto_approve: false });
                            if (t && typeof t === 'object') {
                              setSelected({ type: 'trade', trade: t });
                              setActiveTab('trade_actions');
                              pushToast('success', `Loaded receipt (${tradeId})`);
                            } else {
                              pushToast('info', `No local receipt (${tradeId})`);
                            }
                          } catch (err: any) {
                            pushToast('error', err?.message || String(err));
                          }
                        })();
                      }}
                      onDismiss={() => {
                        const tradeId = String((e as any)?.trade_id || (e as any)?.message?.trade_id || '').trim();
                        if (!tradeId) return;
                        dismissInviteTrade(tradeId);
                        pushToast('success', `Dismissed invite (${tradeId})`);
                      }}
                      onUndismiss={() => {
                        const tradeId = String((e as any)?.trade_id || (e as any)?.message?.trade_id || '').trim();
                        if (!tradeId) return;
                        undismissInviteTrade(tradeId);
                        pushToast('success', `Restored invite (${tradeId})`);
                      }}
                      dismissed={(() => {
                        try {
                          const tradeId = String((e as any)?.trade_id || (e as any)?.message?.trade_id || '').trim();
                          return tradeId ? Boolean(dismissedInviteTradeIds && dismissedInviteTradeIds[tradeId]) : false;
                        } catch (_e) {
                          return false;
                        }
                      })()}
                      watched={(() => {
                        try {
                          const swapCh = String((e as any)?.message?.body?.swap_channel || '').trim();
                          if (!swapCh) return false;
                          return watchedChannelsSet.has(swapCh) || joinedChannelsSet.has(swapCh);
                        } catch (_e) {
                          return false;
                        }
                      })()}
                      joined={Boolean((e as any)?._invite_joined)}
                      joinable={joinable}
                      joinBlockReason={joinBlockReason}
	                  />
	                    );
	                  })()
	                )}
	              />
	            </Panel>
		            <Panel title="Joined Channels">
                <p className="muted small">Where your peer is currently joined. Leave to stop receiving/sending on that channel.</p>
                {joinedChannels.length > 0 ? (
                  <VirtualList
                    items={joinedChannels}
                    itemKey={(ch) => String(ch)}
                    estimatePx={72}
                    render={(chRaw) => {
                      const ch = String(chRaw || '').trim();
                      if (!ch) return null;
                      return (
                        <div className="rowitem">
                          <div className="rowitem-top">
                            <span className="mono chip hi">{ch}</span>
                            {watchedChannelsSet.has(ch) ? <span className="mono chip">watched</span> : <span className="mono chip dim">not watched</span>}
                          </div>
                          <div className="rowitem-bot">
                            <button className="btn small" onClick={() => void copyToClipboard('channel', ch)}>
                              Copy
                            </button>
                            {watchedChannelsSet.has(ch) ? (
                              <button className="btn small" onClick={() => unwatchChannel(ch)}>
                                Unwatch
                              </button>
                            ) : (
                              <button className="btn small" onClick={() => watchChannel(ch)}>
                                Watch
                              </button>
                            )}
                            <button
                              className="btn small"
                              onClick={() => {
                                if (toolRequiresApproval('intercomswap_sc_leave') && !autoApprove) {
                                  const ok = window.confirm(`Leave channel?\n\n${ch}`);
                                  if (!ok) return;
                                }
                                void (async () => {
                                  try {
                                    await runToolFinal('intercomswap_sc_leave', { channel: ch }, { auto_approve: true });
                                    pushToast('success', `Left ${ch}`);
                                    if (watchedChannelsSet.has(ch)) unwatchChannel(ch);
                                    void refreshPreflight();
                                  } catch (err: any) {
                                    pushToast('error', err?.message || String(err));
                                  }
                                })();
                              }}
                            >
                              Leave
                            </button>
                          </div>
                        </div>
                      );
                    }}
                  />
                ) : (
                  <p className="muted">No joined channels reported yet (check Overview -&gt; START and ensure SC-Bridge is up).</p>
                )}

	              <div className="field">
	                <div className="field-hd">
	                  <span className="mono">Leave Channel (manual)</span>
	                </div>
		                <input
		                  className="input mono"
		                  value={leaveChannel}
		                  onChange={(e) => setLeaveChannel(e.target.value)}
		                  placeholder="swap:..."
		                />
		                <div className="row">
	                  <button
	                    className="btn primary"
	                    disabled={leaveBusy || !leaveChannel.trim()}
	                    onClick={() => {
	                      const channel = leaveChannel.trim();
	                      if (!channel) return;
	                      setLeaveBusy(true);
	                      void (async () => {
	                        try {
	                          if (toolRequiresApproval('intercomswap_sc_leave') && !autoApprove) {
	                            const ok = window.confirm(`Leave channel?\n\n${channel}`);
	                            if (!ok) return;
	                          }
	                          await runToolFinal('intercomswap_sc_leave', { channel }, { auto_approve: true });
	                          pushToast('success', `Left ${channel}`);
                            if (watchedChannelsSet.has(channel)) unwatchChannel(channel);
	                          setLeaveChannel('');
                            void refreshPreflight();
	                        } catch (err: any) {
	                          pushToast('error', err?.message || String(err));
	                        } finally {
	                          setLeaveBusy(false);
	                        }
	                      })();
	                    }}
	                  >
	                    {leaveBusy ? 'Leaving…' : 'Leave'}
	                  </button>
		                </div>
		              </div>

		              <div className="field">
                    <div className="field-hd">
                      <span className="mono">Known Channels</span>
                      <button className="btn small" onClick={() => setKnownChannelsOpen((v) => !v)}>
                        {knownChannelsOpen ? 'Hide' : 'Show'}
                      </button>
                    </div>
                    <div className="muted small">
                      Virtualized list; rows outside view are unmounted.
                    </div>
                    {knownChannelsOpen ? (
                      knownChannels.length > 0 ? (
                        <VirtualList
                          items={knownChannels}
                          itemKey={(ch) => String(ch)}
                          estimatePx={64}
                          render={(chRaw) => {
                            const ch = String(chRaw || '').trim();
                            if (!ch) return null;
                            return (
                              <div className="rowitem">
                                <div className="rowitem-top">
                                  <span className="mono chip">{ch}</span>
                                  {joinedChannelsSet.has(ch) ? <span className="mono chip hi">joined</span> : <span className="mono chip dim">known</span>}
                                  {watchedChannelsSet.has(ch) ? <span className="mono chip">watched</span> : null}
                                </div>
                                <div className="rowitem-bot">
                                  <button className="btn small" onClick={() => setLeaveChannel(ch)}>
                                    Use
                                  </button>
                                  <button className="btn small" onClick={() => void copyToClipboard('channel', ch)}>
                                    Copy
                                  </button>
                                  {!watchedChannelsSet.has(ch) ? (
                                    <button className="btn small" onClick={() => watchChannel(ch)}>
                                      Watch
                                    </button>
                                  ) : (
                                    <button className="btn small" onClick={() => unwatchChannel(ch)}>
                                      Unwatch
                                    </button>
                                  )}
                                </div>
                              </div>
                            );
                          }}
                        />
                      ) : (
                        <div className="muted small">No known channels yet.</div>
                      )
                    ) : null}
                  </div>
		            </Panel>
	          </div>
	        ) : null}

	      {activeTab === 'trade_actions' ? (
	          <div className="grid2">
	            <Panel title="Trade Receipts (local, paginated)">
	              <p className="muted">
	                Viewing receipts from:{' '}
	                <span className="mono">{selectedReceiptsSource?.label || 'default (setup.json)'}</span>
	              </p>
	              <div className="row">
	                <span className="muted small">receipts</span>
	                <select
	                  className="select"
	                  value={selectedReceiptsSource?.key || 'default'}
	                  onChange={(e) => setReceiptsSourceKey(String(e.target.value || 'default'))}
	                  disabled={receiptsSources.length < 2}
	                >
	                  {receiptsSources.length > 0 ? (
	                    receiptsSources.map((s) => (
	                      <option key={s.key} value={s.key}>
	                        {s.label}
	                      </option>
	                    ))
	                  ) : (
	                    <option value="default">default (setup.json)</option>
	                  )}
	                </select>
	              </div>
	              <div className="row">
	                <button
	                  className="btn primary"
	                  onClick={() => {
                    setTrades([]);
                    setTradesOffset(0);
                    setTradesHasMore(true);
                    void loadTradesPage({ reset: true });
                  }}
                  disabled={tradesLoading}
                >
                  {tradesLoading ? 'Loading…' : 'Refresh'}
                </button>
              </div>

              <VirtualList
                listRef={tradesListRef}
                items={trades}
                itemKey={(t) => String(t?.trade_id || t?.updated_at || '')}
                estimatePx={58}
                onScroll={onTradesScroll}
	                render={(t) => (
	                  <TradeRow
	                    trade={t}
	                    oracle={oracle}
	                    selected={selected?.type === 'trade' && selected?.trade?.trade_id === t?.trade_id}
	                    onSelect={() => setSelected({ type: 'trade', trade: t })}
	                    onRecoverClaim={() => void recoverClaimForTrade(t)}
	                    onRecoverRefund={() => void recoverRefundForTrade(t)}
	                  />
	                )}
              />
            </Panel>

            <Panel title="Selected Trade Actions">
              {selected?.type === 'trade' ? (
                <>
                  <div className="muted small">
                    trade_id: <span className="mono">{String(selected?.trade?.trade_id || '')}</span>
                  </div>
                  <pre className="code">{JSON.stringify(selected?.trade || {}, null, 2)}</pre>
                  <div className="row">
                    <button
                      className="btn"
                      onClick={() => {
                        const ch = String(selected?.trade?.swap_channel || '').trim();
                        if (!ch) return;
                        void (async () => {
                          try {
                            if (toolRequiresApproval('intercomswap_sc_join') && !autoApprove) {
                              const ok = window.confirm(`Join channel?\n\n${ch}`);
                              if (!ok) return;
                            }
                            await runToolFinal('intercomswap_sc_join', { channel: ch }, { auto_approve: true });
                            pushToast('success', `Joined ${ch}`);
                            try {
                              watchChannel(ch);
                            } catch (_e) {}
                            void refreshPreflight();
                          } catch (err: any) {
                            pushToast('error', err?.message || String(err));
                          }
                        })();
                      }}
                      disabled={!String(selected?.trade?.swap_channel || '').trim()}
                    >
                      Join swap channel
                    </button>
                    <button
                      className="btn"
                      onClick={() => {
                        const ch = String(selected?.trade?.swap_channel || '').trim();
                        if (!ch) return;
                        void (async () => {
                          try {
                            if (toolRequiresApproval('intercomswap_sc_leave') && !autoApprove) {
                              const ok = window.confirm(`Leave channel?\n\n${ch}`);
                              if (!ok) return;
                            }
                            await runToolFinal('intercomswap_sc_leave', { channel: ch }, { auto_approve: true });
                            pushToast('success', `Left ${ch}`);
                            try {
                              if (watchedChannelsSet.has(ch)) unwatchChannel(ch);
                            } catch (_e) {}
                            try {
                              const tradeId = String(selected?.trade?.trade_id || '').trim();
                              if (tradeId) dismissInviteTrade(tradeId);
                            } catch (_e) {}
                            void refreshPreflight();
                          } catch (err: any) {
                            pushToast('error', err?.message || String(err));
                          }
                        })();
                      }}
                      disabled={!String(selected?.trade?.swap_channel || '').trim()}
                    >
                      Leave swap channel
                    </button>
	                    <button
	                      className="btn"
	                      onClick={() => {
	                        void recoverClaimForTrade(selected?.trade);
	                      }}
	                      aria-disabled={!stackGate.ok}
	                      title={!stackGate.ok ? 'Complete setup checklist first (see Overview)' : 'Claim (if available)'}
	                    >
	                      Claim
	                    </button>
	                    <button
	                      className="btn"
	                      onClick={() => {
	                        void recoverRefundForTrade(selected?.trade);
	                      }}
	                      aria-disabled={!stackGate.ok}
	                      title={!stackGate.ok ? 'Complete setup checklist first (see Overview)' : 'Refund (if available)'}
	                    >
	                      Refund
	                    </button>
                  </div>
                </>
              ) : (
                <p className="muted">Select a trade receipt.</p>
              )}
            </Panel>
          </div>
        ) : null}

	        {activeTab === 'refunds' ? (
	          <div className="grid2">
	            <Panel title="Open Refunds (receipts)">
	              <div className="row">
	                <span className="muted small">receipts</span>
	                <select
	                  className="select"
	                  value={selectedReceiptsSource?.key || 'default'}
	                  onChange={(e) => setReceiptsSourceKey(String(e.target.value || 'default'))}
	                  disabled={receiptsSources.length < 2}
	                >
	                  {receiptsSources.length > 0 ? (
	                    receiptsSources.map((s) => (
	                      <option key={s.key} value={s.key}>
	                        {s.label}
	                      </option>
	                    ))
	                  ) : (
	                    <option value="default">default (setup.json)</option>
	                  )}
	                </select>
	              </div>
	              <div className="row">
	                <button
	                  className="btn primary"
	                  onClick={() => {
                    setOpenRefunds([]);
                    setOpenRefundsOffset(0);
                    setOpenRefundsHasMore(true);
                    void loadOpenRefundsPage({ reset: true });
                  }}
                  disabled={openRefundsLoading}
                >
                  {openRefundsLoading ? 'Loading…' : 'Refresh'}
                </button>
              </div>
              <VirtualList
                listRef={openRefundsListRef}
                items={openRefunds}
                itemKey={(t) => String(t?.trade_id || t?.updated_at || '')}
                estimatePx={58}
                onScroll={onOpenRefundsScroll}
	                render={(t) => (
	                  <TradeRow
	                    trade={t}
	                    oracle={oracle}
	                    selected={selected?.type === 'trade' && selected?.trade?.trade_id === t?.trade_id}
	                    onSelect={() => setSelected({ type: 'trade', trade: t })}
	                    onRecoverClaim={() => void recoverClaimForTrade(t)}
	                    onRecoverRefund={() => void recoverRefundForTrade(t)}
	                  />
	                )}
              />
            </Panel>
            <Panel title="Open Claims (receipts)">
              <div className="row">
                <button
                  className="btn primary"
                  onClick={() => {
                    setOpenClaims([]);
                    setOpenClaimsOffset(0);
                    setOpenClaimsHasMore(true);
                    void loadOpenClaimsPage({ reset: true });
                  }}
                  disabled={openClaimsLoading}
                >
                  {openClaimsLoading ? 'Loading…' : 'Refresh'}
                </button>
              </div>
              <VirtualList
                listRef={openClaimsListRef}
                items={openClaims}
                itemKey={(t) => String(t?.trade_id || t?.updated_at || '')}
                estimatePx={58}
                onScroll={onOpenClaimsScroll}
	                render={(t) => (
	                  <TradeRow
	                    trade={t}
	                    oracle={oracle}
	                    selected={selected?.type === 'trade' && selected?.trade?.trade_id === t?.trade_id}
	                    onSelect={() => setSelected({ type: 'trade', trade: t })}
	                    onRecoverClaim={() => void recoverClaimForTrade(t)}
	                    onRecoverRefund={() => void recoverRefundForTrade(t)}
	                  />
	                )}
              />
            </Panel>
          </div>
        ) : null}

	        {activeTab === 'wallets' ? (
	          <div className="grid2">
            <Panel title="Lightning (BTC)">
              <div className="muted small">
                impl/backend/network:{' '}
                <span className="mono">{String(envInfo?.ln?.impl || '—')}</span> /{' '}
                <span className="mono">{String(envInfo?.ln?.backend || '—')}</span> /{' '}
                <span className="mono">{String(envInfo?.ln?.network || '—')}</span>
              </div>
              <div className="muted small">
                node: <span className="mono">{lnAlias || '—'}</span> · id:{' '}
                <span className="mono">{lnNodeIdShort || '—'}</span>
              </div>
			              <div className="row">
				                {lnChannelCount > 0 ? <span className="chip hi">{lnChannelCount} channel(s)</span> : <span className="chip warn">no channels</span>}
				                {lnWalletSats !== null ? (
			                  <span className="chip">
			                    {satsToBtcDisplay(lnWalletSats)} BTC ({lnWalletSats} sats)
			                    {oracle.btc_usd ? ` ≈ ${fmtUsd((lnWalletSats / 1e8) * oracle.btc_usd)}` : ''}
			                  </span>
			                ) : null}
			                <button className="btn small" onClick={() => void refreshPreflight()} disabled={preflightBusy}>
			                  Refresh BTC
			                </button>
			              </div>

                  {lnWalletLocked ? (
                    <div className="alert warn" style={{ marginTop: 8 }}>
                      <b>Lightning wallet locked.</b> Unlock the LN wallet first; channel operations and auto-settlement are paused.
                      {lnWalletLockedMessage ? <div className="muted small" style={{ marginTop: 6 }}>{lnWalletLockedMessage}</div> : null}
                      {lnUnlockHelperSupported ? (
                        <div className="row" style={{ marginTop: 8 }}>
                          <button className="btn primary" onClick={() => void unlockLnWallet()} disabled={runBusy || stackOpBusy}>
                            Unlock LN wallet
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}

		              {isLnRegtestDocker ? (
		                <button
		                  className="btn primary"
		                  disabled={runBusy}
		                  onClick={() => {
		                    if (lnChannelCount > 0 && !preflight?.ln_listfunds_error) {
		                      setSelected({ type: 'ln_listfunds', evt: preflight?.ln_listfunds || null });
		                      pushToast('info', 'Lightning channel already exists (opened details).', { ttlMs: 4500 });
		                      return;
		                    }
		                    void ensureLnRegtestChannel();
		                  }}
		                >
		                  {lnChannelCount > 0 ? 'Regtest channel ready (details)' : 'Bootstrap regtest (mine+fund+open)'}
		                </button>
		              ) : null}

              <div className="field">
                <div className="field-hd">
                  <span className="mono">BTC Funding Address</span>
                </div>
                <div className="muted small">Send BTC here to fund your LN node wallet.</div>
                <div className="row">
                  <input className="input mono" value={lnFundingAddr || ''} readOnly placeholder="Generate an address…" />
                  <button className="btn" disabled={!lnFundingAddr} onClick={() => copyToClipboard('btc address', lnFundingAddr)}>
                    Copy
                  </button>
                </div>
                {lnFundingAddrErr ? <div className="alert bad">{lnFundingAddrErr}</div> : null}
                <div className="row">
                  <button
                    className="btn primary"
                    disabled={runBusy}
                    onClick={async () => {
                      const ok =
                        autoApprove ||
                        window.confirm('Generate a new BTC funding address from your LN node wallet now?');
                      if (!ok) return;
                      try {
                        const out = await runDirectToolOnce('intercomswap_ln_newaddr', {}, { auto_approve: true });
                        const addr = String(out?.address || '').trim();
                        if (!addr) throw new Error('ln_newaddr returned no address');
                        setLnFundingAddr(addr);
                        setLnFundingAddrErr(null);
                      } catch (e: any) {
                        setLnFundingAddrErr(e?.message || String(e));
                      }
                    }}
                  >
                    Generate BTC address
                  </button>
                </div>
              </div>

              <div className="field">
                <div className="field-hd">
                  <span className="mono">Send BTC (on-chain)</span>
                </div>
                <div className="muted small">Withdraw BTC from the LN node wallet to a BTC address.</div>
                <div className="row">
                  <input
                    className="input mono"
                    value={lnWithdrawTo}
                    onChange={(e) => setLnWithdrawTo(e.target.value)}
                    placeholder="destination BTC address"
                  />
                </div>
                <div className="gridform">
                  <div className="field">
                    <div className="field-hd">
                      <span className="mono">amount</span>
                    </div>
                    <BtcSatsField name="ln_withdraw_amount" sats={lnWithdrawAmountSats} onSats={(n) => setLnWithdrawAmountSats(n)} />
                  </div>
                  <div className="field">
                    <div className="field-hd">
                      <span className="mono">fee rate</span>
                      <span className="muted small">sat/vB</span>
                    </div>
                    <input
                      className="input mono"
                      type="number"
                      min={1}
                      max={10000}
                      value={String(lnWithdrawSatPerVbyte)}
                      onChange={(e) => {
                        const n = Number.parseInt(e.target.value, 10);
                        if (Number.isFinite(n)) setLnWithdrawSatPerVbyte(Math.max(1, Math.min(10000, Math.trunc(n))));
                      }}
                    />
                  </div>
                </div>
                <div className="row">
                  <button
                    className="btn primary"
                    disabled={
                      runBusy ||
                      !lnWithdrawTo.trim() ||
                      !Number.isInteger(lnWithdrawAmountSats) ||
                      Number(lnWithdrawAmountSats || 0) <= 0
                    }
                    onClick={async () => {
                      const address = lnWithdrawTo.trim();
                      const amount_sats = Number(lnWithdrawAmountSats || 0);
                      const sat_per_vbyte = Number(lnWithdrawSatPerVbyte || 0);
                      if (toolRequiresApproval('intercomswap_ln_withdraw') && !autoApprove) {
                        const ok = window.confirm(
                          `Send BTC now?\n\naddress: ${address}\namount_sats: ${amount_sats}\nfee: ${sat_per_vbyte} sat/vB`
                        );
                        if (!ok) return;
                      }
                      try {
                        const out = await runDirectToolOnce(
                          'intercomswap_ln_withdraw',
                          { address, amount_sats, sat_per_vbyte: sat_per_vbyte > 0 ? sat_per_vbyte : undefined },
                          { auto_approve: true }
                        );
                        const txid = String(out?.txid || out?.tx_id || out?.tx || out?.hash || '').trim();
                        pushToast('success', `BTC sent${txid ? ` (txid ${txid.slice(0, 12)}…)` : ''}`);
                        void refreshPreflight();
                      } catch (e: any) {
                        pushToast('error', e?.message || String(e));
                      }
                    }}
                  >
                    Send BTC
                  </button>
                </div>
              </div>

              <div className="field">
                <div className="field-hd">
                  <span className="mono">Channel Manager</span>
                </div>
                <div className="muted small">
                  Open channels to add liquidity. Reusing the same peer is valid and increases total routing capacity.
                </div>

                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div className="field">
                    <div className="field-hd">
                      <span className="mono">Liquidity Guardrail</span>
                    </div>
                    <select
                      className="select"
                      value={lnLiquidityMode}
                      onChange={(e) => setLnLiquidityMode(e.target.value === 'aggregate' ? 'aggregate' : 'single_channel')}
                    >
                      <option value="single_channel">single_channel (default, safer)</option>
                      <option value="aggregate">aggregate (best-effort routing)</option>
                    </select>
                  </div>
                  <div className="field">
                    <div className="field-hd" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                      <span className="mono">Channel Peer</span>
                      <button className="btn small" onClick={() => setLnPeerAdvancedOpen((v) => !v)}>
                        {lnPeerAdvancedOpen ? 'Hide Advanced' : 'Advanced'}
                      </button>
                    </div>
                    <div className="muted small">
                      {String(envInfo?.env_kind || '').trim().toLowerCase() === 'mainnet'
                        ? `Default: ACINQ (${ACINQ_NODE_ID.slice(0, 12)}…@${ACINQ_PEER_ADDR}). Using other peers is discouraged for now (can cause NO_ROUTE due to isolated topology).`
                        : 'Select a peer URI (nodeid@host:port) to open a channel.'}
                    </div>
                    <div className="row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                      {String(envInfo?.env_kind || '').trim().toLowerCase() === 'mainnet' ? (
                        <button
                          className="btn small"
                          onClick={() => setLnPeerInput(ACINQ_PEER_URI)}
                          title={ACINQ_PEER_URI}
                          disabled={runBusy}
                        >
                          use ACINQ
                        </button>
                      ) : null}
                      <span className={`chip ${lnSelectedPeerConnected ? 'hi' : lnSelectedPeerKnown ? 'warn' : 'dim'}`}>
                        {lnSelectedPeerConnected
                          ? 'selected peer: connected'
                          : lnSelectedPeerKnown
                            ? 'selected peer: offline'
                            : lnSelectedPeerNodeId
                              ? 'selected peer: unknown'
                              : 'selected peer: missing'}
                      </span>
                      <span className={`chip ${lnConnectedPeerCount > 0 ? 'hi' : 'warn'}`}>
                        connected peers: {lnConnectedPeerCount}
                      </span>
                    </div>

                    {!lnPeerAdvancedOpen ? (
                      <div className="row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                        <span className={`mono small ${lnPeerInput.trim() ? '' : 'muted'}`}>{lnPeerInput.trim() || '(missing peer URI)'}</span>
                      </div>
                    ) : (
                      <>
                        <input
                          className="input mono"
                          value={lnPeerInput}
                          onChange={(e) => setLnPeerInput(e.target.value)}
                          placeholder="nodeid@host:port"
                        />
                        {lnPeerSuggestions.length > 0 ? (
                          <div className="row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                            {lnPeerSuggestions.map((s) => (
                              <button key={s.uri} className="btn small" onClick={() => setLnPeerInput(s.uri)} title={s.uri}>
                                use {s.id.slice(0, 12)}…@{s.addr} {s.connected ? '' : '(offline)'}
                              </button>
                            ))}
                          </div>
                        ) : null}
                        <label className="check" style={{ marginTop: 6 }}>
                          <input
                            type="checkbox"
                            checked={lnAutoPeerFailover}
                            onChange={(e) => setLnAutoPeerFailover(e.target.checked)}
                          />
                          auto-failover peer URI if selected peer goes offline
                        </label>
                        <div className="muted small" style={{ marginTop: 6 }}>
                          {lnPeerSuggestions.length > 0
                            ? 'Suggested from connected peers. Collin can auto-failover to a connected peer.'
                            : 'Paste from counterparty or run an LN connect step once to populate suggestions.'}
                        </div>
                      </>
                    )}
                  </div>
                </div>

                {(() => {
                  if (lnWalletSats === null) return null;
                  if (!Number.isInteger(lnChannelAmountSats) || lnChannelAmountSats <= 0) return null;
                  const feeBuffer = Math.max(
                    LN_OPEN_TX_FEE_BUFFER_MIN_SATS,
                    Math.trunc(Math.max(1, Number(lnChannelSatPerVbyte || 0)) * LN_OPEN_TX_WEIGHT_BUFFER_VB)
                  );
                  const anchorReserve = lnImpl === 'lnd' ? LND_NEW_ANCHOR_RESERVE_SATS : 0;
                  const needMin = lnChannelAmountSats + feeBuffer + anchorReserve;
                  if (lnWalletSats >= needMin) return null;
                  return (
                    <div className="alert warn" style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}>
                      <b>BTC funding required.</b> Spendable wallet has {satsToBtcDisplay(lnWalletSats)} BTC ({lnWalletSats} sats), but opening{' '}
                      {satsToBtcDisplay(lnChannelAmountSats)} BTC ({lnChannelAmountSats} sats) needs about {needMin} sats
                      {' '}= amount {lnChannelAmountSats}
                      {' '}+ fee buffer {feeBuffer}
                      {anchorReserve > 0 ? ` + anchor reserve ${anchorReserve}` : ''}.
                      {lnImpl === 'lnd' ? (
                        <span>
                          {' '}LND confirmed: {lnWalletConfirmedSats ?? '—'} sats, reserved anchor: {lnWalletReservedAnchorSats ?? '—'} sats.
                        </span>
                      ) : null}
                    </div>
                  );
                })()}

                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div className="field">
                    <div className="field-hd">
                      <span className="mono">channel amount</span>
                    </div>
                    <BtcSatsField name="ln_channel_amount" sats={lnChannelAmountSats} onSats={(n) => setLnChannelAmountSats(Number(n || 0))} />
                  </div>
                  <div className="field">
                    <div className="field-hd">
                      <span className="mono">push inbound (optional)</span>
                    </div>
                    <BtcSatsField
                      name="ln_channel_push"
                      sats={lnChannelPushSats}
                      onSats={(n) => setLnChannelPushSats(Math.max(0, Number(n || 0)))}
                    />
                    <div className="muted small">
                      Pushes initial balance to peer on open so your side gets immediate inbound capacity.
                    </div>
                  </div>
                  <div className="gridform">
                    <div className="field">
                      <div className="field-hd">
                        <span className="mono">open fee rate</span>
                        <span className="muted small">sat/vB</span>
                      </div>
                      <input
                        className="input mono"
                        type="number"
                        min={1}
                        max={10000}
                        value={String(lnChannelSatPerVbyte)}
                        onChange={(e) => {
                          const n = Number.parseInt(e.target.value, 10);
                          if (Number.isFinite(n)) setLnChannelSatPerVbyte(Math.max(1, Math.min(10000, Math.trunc(n))));
                        }}
                      />
                    </div>
                    <div className="field">
                      <div className="field-hd">
                        <span className="mono">close fee rate</span>
                        <span className="muted small">sat/vB</span>
                      </div>
                      <input
                        className="input mono"
                        type="number"
                        min={1}
                        max={10000}
                        value={String(lnChannelCloseSatPerVbyte)}
                        onChange={(e) => {
                          const n = Number.parseInt(e.target.value, 10);
                          if (Number.isFinite(n)) setLnChannelCloseSatPerVbyte(Math.max(1, Math.min(10000, Math.trunc(n))));
                        }}
                      />
                    </div>
                  </div>
                </div>

                <div className="row" style={{ marginTop: 8 }}>
	                  <button
	                    className="btn primary"
	                    disabled={runBusy || lnWalletLocked || !lnPeerInput.trim() || !Number.isInteger(lnChannelAmountSats) || Number(lnChannelAmountSats) <= 0}
	                    onClick={async () => {
                        if (lnWalletLocked) {
                          pushToast('error', 'Lightning wallet locked. Unlock it first, then refresh BTC status.');
                          return;
                        }
	                      const peer = lnPeerInput.trim();
	                      const m = peer.match(/^([0-9a-fA-F]{66})@/);
                      if (!m) {
                        pushToast('error', 'Peer URI must be nodeid@host:port');
                        return;
                      }
                      const node_id = String(m[1]).toLowerCase();
                      const amount_sats = Number(lnChannelAmountSats || 0);
                      const push_sats = Number(lnChannelPushSats || 0);
                      const sat_per_vbyte = Number(lnChannelSatPerVbyte || 0);
                      if (!Number.isInteger(push_sats) || push_sats < 0) {
                        pushToast('error', 'Push inbound must be an integer >= 0 sats');
                        return;
                      }
                      if (push_sats > 0 && lnImpl !== 'lnd') {
                        pushToast('error', 'Push inbound is currently supported for LND only.');
                        return;
                      }
                      if (push_sats >= amount_sats) {
                        pushToast('error', 'Push inbound must be less than channel amount');
                        return;
                      }
                      if (typeof lnWalletSats === 'number' && Number.isFinite(lnWalletSats) && lnWalletSats > 0) {
                        const feeBuffer = Math.max(
                          LN_OPEN_TX_FEE_BUFFER_MIN_SATS,
                          Math.trunc(Math.max(1, sat_per_vbyte || 0) * LN_OPEN_TX_WEIGHT_BUFFER_VB)
                        );
                        const anchorReserve = lnImpl === 'lnd' ? LND_NEW_ANCHOR_RESERVE_SATS : 0;
                        const needMin = amount_sats + feeBuffer + anchorReserve;
                        if (needMin > lnWalletSats) {
                          pushToast(
                            'error',
                            `Open blocked: need about ${needMin} sats (amount ${amount_sats} + fee ${feeBuffer}${
                              anchorReserve > 0 ? ` + anchor reserve ${anchorReserve}` : ''
                            }), spendable is ${lnWalletSats} sats`
                          );
                          return;
                        }
                      }
                      const ok =
                        autoApprove ||
                        window.confirm(
                          `Connect and open channel?\n\npeer: ${peer}\namount_sats: ${amount_sats}\npush_sats: ${push_sats}\nfee: ${
                            sat_per_vbyte > 0 ? `${sat_per_vbyte} sat/vB` : '(default)'
                          }`
                        );
                      if (!ok) return;
                      try {
                        try {
                          await runToolFinal('intercomswap_ln_connect', { peer }, { auto_approve: true });
                        } catch (e: any) {
                          const msg = String(e?.message || e || '').toLowerCase();
                          const alreadyConnected =
                            msg.includes('already connected to peer') ||
                            msg.includes('already connected');
                          if (!alreadyConnected) throw e;
                          pushToast('info', 'Peer already connected. Continuing with channel open.');
                        }
                        const openOut = await runToolFinal(
                          'intercomswap_ln_fundchannel',
                          {
                            node_id,
                            amount_sats,
                            push_sats: push_sats > 0 ? push_sats : undefined,
                            sat_per_vbyte: sat_per_vbyte > 0 ? sat_per_vbyte : undefined,
                          },
                          { auto_approve: true }
                        );
                        const outObj = openOut && typeof openOut === 'object' ? ((openOut as any).content_json ?? openOut) : {};
                        const hint = extractLnOpenTxHint(outObj);
                        const detail = hint.txid
                          ? ` (txid ${hint.txid.slice(0, 14)}…)`
                          : hint.channelPoint
                            ? ` (channel ${hint.channelPoint.slice(0, 22)}…)`
                            : '';
                        pushToast(
                          'success',
                          `Channel open submitted${detail}${push_sats > 0 ? ` with push ${push_sats} sats` : ''}`,
                          { ttlMs: 8_000 }
                        );
                        void refreshPreflight();
                      } catch (e: any) {
                        pushToast('error', e?.message || String(e));
                      }
                    }}
                  >
                    Open Channel
                  </button>
                </div>

                <div className="field ln-op-area" style={{ marginTop: 12 }}>
                  <div className="field-hd">
                    <span className="mono">Increase Inbound (Self-Pay)</span>
                    <span className={`chip ${lnRebalanceSupported ? 'hi' : 'warn'}`}>
                      {lnRebalanceSupported ? 'supported on this backend' : 'not supported on this backend'}
                    </span>
                    <button className="btn small" onClick={() => setLnRebalanceOpen((v) => !v)}>
                      {lnRebalanceOpen ? 'Hide' : 'Show'}
                    </button>
                  </div>
                  {lnRebalanceOpen ? (
                    <>
                      <div className="muted small">
                        Creates an invoice on this node and pays it from this same node to shift liquidity inbound (best-effort).
                        {' '}
                        {lnRebalanceSupported
                          ? 'LND supports explicit self-payment; route outcome still depends on available channels.'
                          : `Current LN impl is ${lnImpl || 'unknown'}; self-pay rebalance requires LND.`}
                      </div>
	                      {!lnRebalanceMinChannelsOk ? (
	                        <div className="alert warn" style={{ marginTop: 8 }}>
	                          <b>Likely no route.</b> Self-pay rebalance usually needs at least <span className="mono">2 active channels</span>{' '}
	                          to form a circular route. Current active/known channels: <span className="mono">{lnActiveChannelCount}</span>/<span className="mono">{lnChannelCount}</span>.
	                        </div>
	                      ) : null}
                      {lnWalletLocked ? (
                        <div className="alert warn" style={{ marginTop: 8 }}>
                          <b>Wallet locked.</b> Self-pay rebalance requires an unlocked Lightning wallet.
                        </div>
                      ) : null}
	                      <div className="gridform" style={{ marginTop: 8 }}>
                        <div className="field">
                          <div className="field-hd">
                            <span className="mono">amount</span>
                          </div>
                          <BtcSatsField
                            name="ln_rebalance_amount"
                            sats={lnRebalanceAmountSats}
                            onSats={(n) => setLnRebalanceAmountSats(Number(n || 0))}
                          />
                        </div>
                        <div className="field">
                          <div className="field-hd">
                            <span className="mono">max routing fee</span>
                            <span className="muted small">sat</span>
                          </div>
                          <input
                            className="input mono"
                            type="number"
                            min={0}
                            max={10000000}
                            value={String(lnRebalanceFeeLimitSat)}
                            onChange={(e) => {
                              const n = Number.parseInt(e.target.value, 10);
                              if (Number.isFinite(n)) setLnRebalanceFeeLimitSat(Math.max(0, Math.min(10_000_000, Math.trunc(n))));
                            }}
                          />
                        </div>
                        <div className="field">
                          <div className="field-hd">
                            <span className="mono">outgoing chan id (optional)</span>
                          </div>
                          <input
                            className="input mono"
                            value={lnRebalanceOutgoingChanId}
                            onChange={(e) => setLnRebalanceOutgoingChanId(e.target.value.replace(/[^0-9]/g, ''))}
                            placeholder={lnImpl === 'lnd' ? 'numeric chan_id' : 'LND only'}
                          />
                          {lnNumericChanIdOptions.length > 0 ? (
                            <div className="row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                              {lnNumericChanIdOptions.slice(0, 8).map((id) => (
                                <button key={id} className="btn small" onClick={() => setLnRebalanceOutgoingChanId(id)}>
                                  use {id}
                                </button>
                              ))}
                            </div>
                          ) : null}
                          <div className="muted small" style={{ marginTop: 6 }}>
                            Leave empty to let Lightning choose a route/channel automatically.
                          </div>
                        </div>
                      </div>
                      <div className="row" style={{ marginTop: 8 }}>
                        <button
                          className="btn primary"
	                          disabled={
	                            runBusy ||
                            lnWalletLocked ||
	                            !lnRebalanceSupported ||
	                            !Number.isInteger(lnRebalanceAmountSats) ||
	                            Number(lnRebalanceAmountSats) <= 0
	                          }
	                          onClick={async () => {
                            if (lnWalletLocked) {
                              pushToast('error', 'Lightning wallet locked. Unlock it first, then refresh BTC status.');
                              return;
                            }
                            if (!lnRebalanceMinChannelsOk) {
                              pushToast(
                                'error',
                                'Rebalance requires at least 2 active channels to form a return route. Open another channel (or open with push inbound) first.'
                              );
                              return;
                            }
	                            const amount_sats = Number(lnRebalanceAmountSats || 0);
                            const fee_limit_sat = Number(lnRebalanceFeeLimitSat || 0);
                            const outgoing_chan_id = String(lnRebalanceOutgoingChanId || '').trim();
                            if (toolRequiresApproval('intercomswap_ln_rebalance_selfpay') && !autoApprove) {
                              const ok = window.confirm(
                                `Run self-pay rebalance now?\n\namount_sats: ${amount_sats}\nfee_limit_sat: ${fee_limit_sat}${
                                  outgoing_chan_id ? `\noutgoing_chan_id: ${outgoing_chan_id}` : ''
                                }`
                              );
                              if (!ok) return;
                            }
                            try {
                              const out = await runDirectToolOnce(
                                'intercomswap_ln_rebalance_selfpay',
                                {
                                  amount_sats,
                                  fee_limit_sat: fee_limit_sat >= 0 ? fee_limit_sat : undefined,
                                  outgoing_chan_id: outgoing_chan_id || undefined,
                                },
                                { auto_approve: true }
                              );
                              if (out && typeof out === 'object' && String((out as any).type || '') === 'error') {
                                throw new Error(String((out as any).error || 'rebalance failed'));
                              }
                              const hash = String((out as any)?.payment_hash_hex || '').trim();
                              pushToast('success', `Self-pay rebalance sent${hash ? ` (${hash.slice(0, 12)}…)` : ''}`, {
                                ttlMs: 8_000,
                              });
                              void refreshPreflight();
                            } catch (e: any) {
                              pushToast('error', e?.message || String(e));
                            }
                          }}
                        >
                          Rebalance Inbound
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="muted small">Collapsed. Expand to configure self-pay inbound rebalance.</div>
                  )}
                </div>

                <div className="field ln-op-area" style={{ marginTop: 12 }}>
                  <div className="field-hd">
                    <span className="mono">Splice Channel (In/Out)</span>
                    <span className={`chip ${lnSpliceBackendSupported ? 'hi' : 'warn'}`}>
                      {lnSpliceBackendSupported ? 'supported on this backend' : 'not supported on this backend'}
                    </span>
                    <button className="btn small" onClick={() => setLnSpliceOpen((v) => !v)}>
                      {lnSpliceOpen ? 'Hide' : 'Show'}
                    </button>
                  </div>
                  {lnSpliceOpen ? (
                    <>
                      <div className="muted small">
                        Positive sats add liquidity to the selected channel. Negative sats remove liquidity back to the on-chain wallet.
                        {' '}
                        {lnSpliceBackendSupported
                          ? 'Requires CLN experimental splicing support on the node.'
                          : `Current LN impl is ${lnImpl || 'unknown'}; use additional channels or close/reopen instead.`}
                      </div>
                      <div className="gridform" style={{ marginTop: 8 }}>
                        <div className="field">
                          <div className="field-hd">
                            <span className="mono">channel id</span>
                          </div>
                          <input
                            className="input mono"
                            value={lnSpliceChannelId}
                            onChange={(e) => setLnSpliceChannelId(e.target.value)}
                            placeholder="channel_id / short_channel_id"
                          />
                        </div>
                        <div className="field">
                          <div className="field-hd">
                            <span className="mono">relative sats</span>
                          </div>
                          <input
                            className="input mono"
                            type="number"
                            min={-10_000_000_000}
                            max={10_000_000_000}
                            step={1}
                            value={String(lnSpliceRelativeSats)}
                            onChange={(e) => {
                              const n = Number.parseInt(e.target.value, 10);
                              if (Number.isFinite(n)) setLnSpliceRelativeSats(Math.max(-10_000_000_000, Math.min(10_000_000_000, Math.trunc(n))));
                            }}
                          />
                          <div className="muted small">
                            {lnSpliceRelativeSats > 0 ? 'splice in' : lnSpliceRelativeSats < 0 ? 'splice out' : 'zero is invalid'}
                          </div>
                        </div>
                        <div className="field">
                          <div className="field-hd">
                            <span className="mono">fee rate</span>
                            <span className="muted small">sat/vB</span>
                          </div>
                          <input
                            className="input mono"
                            type="number"
                            min={1}
                            max={10000}
                            value={String(lnSpliceSatPerVbyte)}
                            onChange={(e) => {
                              const n = Number.parseInt(e.target.value, 10);
                              if (Number.isFinite(n)) setLnSpliceSatPerVbyte(Math.max(1, Math.min(10000, Math.trunc(n))));
                            }}
                          />
                        </div>
                        <div className="field">
                          <div className="field-hd">
                            <span className="mono">max rounds</span>
                          </div>
                          <input
                            className="input mono"
                            type="number"
                            min={1}
                            max={100}
                            value={String(lnSpliceMaxRounds)}
                            onChange={(e) => {
                              const n = Number.parseInt(e.target.value, 10);
                              if (Number.isFinite(n)) setLnSpliceMaxRounds(Math.max(1, Math.min(100, Math.trunc(n))));
                            }}
                          />
                        </div>
                      </div>
                      <div className="row" style={{ marginTop: 8 }}>
                        <label className="check">
                          <input
                            type="checkbox"
                            checked={lnSpliceSignFirst}
                            onChange={(e) => setLnSpliceSignFirst(e.target.checked)}
                          />
                          sign_first (advanced)
                        </label>
                        <button
                          className="btn"
                          disabled={
                            runBusy ||
                            !lnSpliceBackendSupported ||
                            !lnSpliceChannelId.trim() ||
                            !Number.isInteger(lnSpliceRelativeSats) ||
                            Number(lnSpliceRelativeSats) === 0
                          }
                          onClick={async () => {
                            const channel_id = lnSpliceChannelId.trim();
                            const relative_sats = Number(lnSpliceRelativeSats || 0);
                            const sat_per_vbyte = Number(lnSpliceSatPerVbyte || 0);
                            const max_rounds = Number(lnSpliceMaxRounds || 0);
                            const ok =
                              autoApprove ||
                              window.confirm(
                                `Run splice now?\n\nchannel_id: ${channel_id}\nrelative_sats: ${relative_sats}\nfee: ${sat_per_vbyte} sat/vB`
                              );
                            if (!ok) return;
                            try {
                              const out = await runDirectToolOnce(
                                'intercomswap_ln_splice',
                                {
                                  channel_id,
                                  relative_sats,
                                  sat_per_vbyte: sat_per_vbyte > 0 ? sat_per_vbyte : undefined,
                                  max_rounds: max_rounds > 0 ? max_rounds : undefined,
                                  sign_first: lnSpliceSignFirst,
                                },
                                { auto_approve: true }
                              );
                              const txid = String((out as any)?.txid || (out as any)?.splice_txid || '').trim();
                              pushToast('success', `Splice submitted${txid ? ` (txid ${txid.slice(0, 14)}…)` : ''}`, { ttlMs: 9000 });
                              void refreshPreflight();
                            } catch (e: any) {
                              pushToast('error', e?.message || String(e));
                            }
                          }}
                        >
                          Splice
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="muted small">Collapsed. Expand to configure channel splice in/out.</div>
                  )}
                </div>

                <div className="ln-liquidity-panel" style={{ marginTop: 10 }}>
                  <div className="ln-liquidity-title mono">Liquidity Snapshot</div>
                  <div className="ln-liquidity-grid">
                    <div className="ln-liquidity-card">
                      <div className="muted small">Channels</div>
                      <div className="mono">
                        <span className="ln-liquidity-kv-label">total:</span> {lnChannelCount}
                        {' · '}
                        <span className="ln-liquidity-kv-label">active:</span> {lnActiveChannelCount}
                      </div>
                    </div>
                    <div className="ln-liquidity-card">
                      <div className="muted small">Send Capacity</div>
                      <div className="ln-liquidity-row">
                        <span className="ln-liquidity-kv-label">max (single)</span>
                        <span className="mono">{typeof lnMaxOutboundSats === 'number' ? `${satsToBtcDisplay(lnMaxOutboundSats)} BTC (${lnMaxOutboundSats} sats)` : '—'}</span>
                      </div>
                      <div className="ln-liquidity-row">
                        <span className="ln-liquidity-kv-label">total</span>
                        <span className="mono">{typeof lnTotalOutboundSats === 'number' ? `${satsToBtcDisplay(lnTotalOutboundSats)} BTC (${lnTotalOutboundSats} sats)` : '—'}</span>
                      </div>
                    </div>
                    <div className="ln-liquidity-card">
                      <div className="muted small">Receive Capacity</div>
                      <div className="ln-liquidity-row">
                        <span className="ln-liquidity-kv-label">max (single)</span>
                        <span className="mono">{typeof lnMaxInboundSats === 'number' ? `${satsToBtcDisplay(lnMaxInboundSats)} BTC (${lnMaxInboundSats} sats)` : '—'}</span>
                      </div>
                      <div className="ln-liquidity-row">
                        <span className="ln-liquidity-kv-label">total</span>
                        <span className="mono">{typeof lnTotalInboundSats === 'number' ? `${satsToBtcDisplay(lnTotalInboundSats)} BTC (${lnTotalInboundSats} sats)` : '—'}</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div style={{ marginTop: 10 }}>
                  <div className="row" style={{ marginBottom: 8 }}>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={lnShowInactiveChannels}
                        onChange={(e) => setLnShowInactiveChannels(e.target.checked)}
                      />
                      show inactive/closed channels
                    </label>
                    <span className="muted small">
                      showing <span className="mono">{lnVisibleChannelRows.length}</span>/<span className="mono">{lnChannelRows.length}</span>
                    </span>
                  </div>
                  {lnVisibleChannelRows.length > 0 ? (
                    <VirtualList
                      items={lnVisibleChannelRows}
                      itemKey={(ch: any) =>
                        String(
                          `${String(ch?.id || '').trim()}|${String(ch?.peer || '').trim()}|${String(ch?.state || '').trim()}|${
                            typeof ch?.capacity_sats === 'number' ? ch.capacity_sats : ''
                          }`
                        )
                      }
                      estimatePx={132}
                      render={(ch: any) => {
                        const id = String(ch?.id || '').trim();
                        const peer = String(ch?.peer || '').trim();
                        const state = String(ch?.state || '').trim() || '?';
                        const active = Boolean(ch?.active);
                        const pending = isPendingLnChannelState(state);
                        const statusLabel = active ? 'active' : pending ? 'pending' : 'inactive';
                        const isPrivate = Boolean(ch?.private);
                        const cap = typeof ch?.capacity_sats === 'number' ? ch.capacity_sats : null;
                        const local = typeof ch?.local_sats === 'number' ? ch.local_sats : null;
                        const remote = typeof ch?.remote_sats === 'number' ? ch.remote_sats : null;
                        const fundingTxid = String(ch?.funding_txid || '').trim().toLowerCase();
                        const channelPoint = String(ch?.channel_point || '').trim();
                        return (
                          <div className="rowitem" style={{ marginTop: 8 }}>
                            <div className="rowitem-top">
                              <span className={`chip ${active ? 'hi' : 'warn'}`}>{statusLabel}</span>
                              <span className="chip">{isPrivate ? 'private' : 'public'}</span>
                              <span className="mono dim">{state}</span>
                            </div>
                            <div className="rowitem-mid">
                              <span className="mono">peer: {peer || '—'}</span>
                              <span className="mono">id: {id || '—'}</span>
                              <span className="mono">channel_point: {channelPoint || '—'}</span>
                              <span className="mono">funding tx: {fundingTxid || '—'}</span>
                              <span className="mono">
                                capacity: {cap !== null ? `${satsToBtcDisplay(cap)} BTC (${cap} sats)` : '—'}
                              </span>
                              <span className="mono">
                                local/outbound: {local !== null ? `${satsToBtcDisplay(local)} BTC (${local} sats)` : '—'}
                              </span>
                              <span className="mono">
                                remote/inbound: {remote !== null ? `${satsToBtcDisplay(remote)} BTC (${remote} sats)` : '—'}
                              </span>
                            </div>
                            <div className="rowitem-bot">
                              {lnSpliceBackendSupported ? (
                                <button
                                  className="btn small"
                                  onClick={() => {
                                    if (!id) {
                                      pushToast('error', 'Missing channel id on this row.');
                                      return;
                                    }
                                    setLnSpliceChannelId(id);
                                    pushToast('info', `Selected channel ${id.slice(0, 16)}… for splice.`);
                                  }}
                                  disabled={!id || pending}
                                >
                                  Use for splice
                                </button>
                              ) : null}
                              <button
                                className="btn small"
                                onClick={() => {
                                  const match = lnPeerSuggestions.find((s) => s.id === String(peer || '').trim().toLowerCase());
                                  if (match?.uri) {
                                    setLnPeerInput(match.uri);
                                    pushToast('info', `Selected peer ${match.id.slice(0, 12)}… for next channel open.`);
                                  } else if (peer) {
                                    pushToast('error', 'Could not resolve peer URI for this channel (missing host:port).');
                                  } else {
                                    pushToast('error', 'Missing peer id on this channel row.');
                                  }
                                }}
                              >
                                Reuse peer
                              </button>
                              <button className="btn small" onClick={() => copyToClipboard('channel id', id)} disabled={!id}>
                                Copy ID
                              </button>
                              <button className="btn small" onClick={() => copyToClipboard('channel point', channelPoint)} disabled={!channelPoint}>
                                Copy point
                              </button>
                              <button className="btn small" onClick={() => copyToClipboard('funding txid', fundingTxid)} disabled={!fundingTxid}>
                                Copy txid
                              </button>
                              <button
                                className="btn small danger"
                                disabled={!id || pending}
                                onClick={async () => {
                                  const sat_per_vbyte = Number(lnChannelCloseSatPerVbyte || 0);
                                  const ok =
                                    autoApprove ||
                                    window.confirm(
                                      `Close channel?\n\nid: ${id}\npeer: ${peer || 'unknown'}\nfee: ${
                                        sat_per_vbyte > 0 ? `${sat_per_vbyte} sat/vB` : '(default)'
                                      }\n\nThis returns liquidity to the on-chain BTC wallet after close confirms.`
                                    );
                                  if (!ok) return;
                                  try {
                                    const out = await runDirectToolOnce(
                                      'intercomswap_ln_closechannel',
                                      { channel_id: id, sat_per_vbyte: sat_per_vbyte > 0 ? sat_per_vbyte : undefined },
                                      { auto_approve: true }
                                    );
                                    const txid = String((out as any)?.closing_txid || (out as any)?.txid || '').trim();
                                    pushToast('success', `Channel close requested${txid ? ` (txid ${txid.slice(0, 12)}…)` : ''}`);
                                    void refreshPreflight();
                                  } catch (e: any) {
                                    pushToast('error', e?.message || String(e));
                                  }
                                }}
                              >
                                Close
                              </button>
                            </div>
                          </div>
                        );
                      }}
                    />
                  ) : (
                    <div className="muted small" style={{ marginTop: 8 }}>No channels for current filter.</div>
                  )}
                </div>
              </div>
            </Panel>

	            <Panel title="Solana">
	              <div className="muted small">
	                rpc: <span className="mono">{String(Array.isArray(envInfo?.solana?.rpc_urls) ? envInfo.solana.rpc_urls[0] : '—')}</span>
	              </div>

	              <div className="field">
	                <div className="field-hd">
	                  <span className="mono">Tx Fees (Priority)</span>
	                </div>
	                <div className="muted small">
	                  Optional. Used for Solana transactions started from Collin (transfers, claims/refunds). Set to <span className="mono">0</span> to use defaults.
	                </div>
	                <div className="gridform" style={{ marginTop: 8 }}>
	                  <div className="field">
	                    <div className="field-hd">
	                      <span className="mono">CU limit</span>
	                    </div>
	                    <input
	                      className="input mono"
	                      type="number"
	                      min={0}
	                      max={1400000}
	                      value={String(solCuLimit)}
	                      onChange={(e) => {
	                        const n = Number.parseInt(e.target.value, 10);
	                        if (!Number.isFinite(n)) return;
	                        setSolCuLimit(Math.max(0, Math.min(1_400_000, Math.trunc(n))));
	                      }}
	                      placeholder="0"
	                    />
	                  </div>
	                  <div className="field">
	                    <div className="field-hd">
	                      <span className="mono">CU price</span>
	                      <span className="muted small">micro-lamports/CU</span>
	                    </div>
	                    <input
	                      className="input mono"
	                      type="number"
	                      min={0}
	                      max={1000000000}
	                      value={String(solCuPrice)}
	                      onChange={(e) => {
	                        const n = Number.parseInt(e.target.value, 10);
	                        if (!Number.isFinite(n)) return;
	                        setSolCuPrice(Math.max(0, Math.min(1_000_000_000, Math.trunc(n))));
	                      }}
	                      placeholder="0"
	                    />
	                  </div>
	                </div>
	              </div>
	              <div className="field">
	                <div className="field-hd">
	                  <span className="mono">Funding Address (SOL)</span>
	                </div>
                <div className="muted small">
                  Fund this address with SOL for transaction fees. Tokens (USDT) are received to the associated token
                  account of this owner address.
                </div>
                <div className="row">
                  <input className="input mono" value={solSignerPubkey || ''} readOnly placeholder="sol signer pubkey…" />
                  <button className="btn" disabled={!solSignerPubkey} onClick={() => copyToClipboard('solana pubkey', solSignerPubkey)}>
                    Copy
                  </button>
                </div>
                {solBalanceErr ? <div className="alert bad">{solBalanceErr}</div> : null}
                {solBalance !== null && solBalance !== undefined ? (
                  <div className="muted small">
                    balance: <span className="mono">{lamportsToSolDisplay(solBalance)} SOL</span> (<span className="mono">{String(solBalance)} lamports</span>)
                  </div>
                ) : null}
                <div className="row">
                  <button
                    className="btn primary"
                    disabled={runBusy || !solSignerPubkey}
                    onClick={async () => {
                      try {
                        const lamports = await runDirectToolOnce('intercomswap_sol_balance', { pubkey: solSignerPubkey }, { auto_approve: false });
                        setSolBalance(lamports);
                        setSolBalanceErr(null);
                      } catch (e: any) {
                        setSolBalanceErr(e?.message || String(e));
                      }
                    }}
                  >
                    Refresh SOL balance
                  </button>
                </div>
              </div>

              <div className="field">
                <div className="field-hd">
                  <span className="mono">USDT Balance (SPL)</span>
                </div>
                <div className="muted small">
                  Enter the USDT mint you’re using for swaps. Most local/dev setups use a test mint with <span className="mono">decimals=6</span>.
                </div>
                <div className="row">
                  <input
                    className="input mono"
                    value={walletUsdtMint}
                    onChange={(e) => setWalletUsdtMint(e.target.value)}
                    placeholder="USDT mint (base58)"
                  />
                  <button className="btn" disabled={!walletUsdtMint.trim()} onClick={() => copyToClipboard('usdt mint', walletUsdtMint.trim())}>
                    Copy
                  </button>
                </div>
                {walletUsdtErr ? <div className="alert bad">{walletUsdtErr}</div> : null}
                {walletUsdtAtomic ? (
                  <div className="muted small">
                    balance: <span className="mono">{atomicToDecimal(walletUsdtAtomic, 6)} USDT</span> (<span className="mono">{walletUsdtAtomic}</span>)
                    {walletUsdtAta ? (
                      <>
                        {' '}· ATA: <span className="mono">{walletUsdtAta.slice(0, 12)}…</span>
                      </>
                    ) : null}
                  </div>
                ) : null}
                <div className="row">
                  <button
                    className="btn primary"
                    disabled={runBusy || !solSignerPubkey || !walletUsdtMint.trim()}
                    onClick={async () => {
                      try {
                        const out = await runDirectToolOnce(
                          'intercomswap_sol_token_balance',
                          { owner: solSignerPubkey, mint: walletUsdtMint.trim() },
                          { auto_approve: false }
                        );
                        setWalletUsdtAta(String(out?.ata || '').trim() || null);
                        setWalletUsdtAtomic(String(out?.amount || '').trim() || '0');
                        setWalletUsdtErr(null);
                      } catch (e: any) {
                        setWalletUsdtErr(e?.message || String(e));
                      }
                    }}
                  >
                    Refresh USDT balance
                  </button>
                </div>
              </div>

              <div className="field">
                <div className="field-hd">
                  <span className="mono">Send SOL</span>
                </div>
                <div className="row">
                  <input className="input mono" value={solSendTo} onChange={(e) => setSolSendTo(e.target.value)} placeholder="to pubkey (base58)" />
                </div>
                <div className="field" style={{ marginTop: 8 }}>
                  <div className="field-hd">
                    <span className="mono">amount (SOL)</span>
                  </div>
                  <UsdtAtomicField decimals={9} atomic={solSendLamports} onAtomic={(a) => setSolSendLamports(a)} placeholder="0.01" />
                </div>
                <div className="row">
                  <button
                    className="btn primary"
                    disabled={runBusy || !solSendTo.trim() || !String(solSendLamports || '').trim()}
                    onClick={async () => {
                      const to = solSendTo.trim();
                      const lamports = String(solSendLamports || '').trim();
                      if (toolRequiresApproval('intercomswap_sol_transfer_sol') && !autoApprove) {
                        const ok = window.confirm(`Send SOL now?\n\nto: ${to}\nlamports: ${lamports}`);
                        if (!ok) return;
	                      }
	                      try {
	                        const out = await runDirectToolOnce(
	                          'intercomswap_sol_transfer_sol',
	                          {
	                            to,
	                            lamports,
	                            ...(solCuLimit > 0 ? { cu_limit: solCuLimit } : {}),
	                            ...(solCuPrice > 0 ? { cu_price: solCuPrice } : {}),
	                          },
	                          { auto_approve: true }
	                        );
	                        const sig = String(out?.tx_sig || out?.sig || '').trim();
	                        pushToast('success', `SOL sent${sig ? ` (${sig.slice(0, 10)}…)` : ''}`);
	                        void refreshPreflight();
	                      } catch (e: any) {
                        pushToast('error', e?.message || String(e));
                      }
                    }}
                  >
                    Send SOL
                  </button>
                </div>
              </div>

              <div className="field">
                <div className="field-hd">
                  <span className="mono">Send USDT (SPL)</span>
                </div>
                <div className="muted small">Uses the mint above. Amount is entered in USDT (decimals=6).</div>
                <div className="row">
                  <input
                    className="input mono"
                    value={usdtSendToOwner}
                    onChange={(e) => setUsdtSendToOwner(e.target.value)}
                    placeholder="to owner pubkey (base58)"
                  />
                </div>
                <div className="field" style={{ marginTop: 8 }}>
                  <div className="field-hd">
                    <span className="mono">amount (USDT)</span>
                  </div>
                  <UsdtAtomicField decimals={6} atomic={usdtSendAtomic} onAtomic={(a) => setUsdtSendAtomic(a)} placeholder="10" />
                </div>
                <div className="row">
                  <button
                    className="btn primary"
                    disabled={runBusy || !walletUsdtMint.trim() || !usdtSendToOwner.trim() || !String(usdtSendAtomic || '').trim()}
                    onClick={async () => {
                      const mint = walletUsdtMint.trim();
                      const to_owner = usdtSendToOwner.trim();
                      const amount = String(usdtSendAtomic || '').trim();
                      if (toolRequiresApproval('intercomswap_sol_token_transfer') && !autoApprove) {
                        const ok = window.confirm(`Send USDT now?\n\nmint: ${mint}\nto_owner: ${to_owner}\namount: ${amount}`);
                        if (!ok) return;
	                      }
	                      try {
	                        const out = await runDirectToolOnce(
	                          'intercomswap_sol_token_transfer',
	                          {
	                            mint,
	                            to_owner,
	                            amount,
	                            create_ata: true,
	                            ...(solCuLimit > 0 ? { cu_limit: solCuLimit } : {}),
	                            ...(solCuPrice > 0 ? { cu_price: solCuPrice } : {}),
	                          },
	                          { auto_approve: true }
	                        );
	                        const sig = String(out?.tx_sig || out?.sig || '').trim();
	                        pushToast('success', `USDT sent${sig ? ` (${sig.slice(0, 10)}…)` : ''}`);
                        void refreshPreflight();
                      } catch (e: any) {
                        pushToast('error', e?.message || String(e));
                      }
                    }}
                  >
                    Send USDT
                  </button>
                </div>
              </div>
            </Panel>
	          </div>
	        ) : null}

	        {activeTab === 'settings' ? (
	          <Panel title="Settings">
	            <div className="row">
	              <label className="check">
	                <input type="checkbox" checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} />
	                auto_approve
	              </label>
	            </div>
	            <div className="field">
	              <div className="field-hd">
	                <span className="mono">Invites (Advanced)</span>
	              </div>
	              <div className="row">
	                <label className="check small">
	                  <input
	                    type="checkbox"
	                    checked={showExpiredInvites}
	                    onChange={(e) => setShowExpiredInvites(Boolean(e.target.checked))}
	                  />
	                  show expired invites
	                </label>
	                <label className="check small">
	                  <input
	                    type="checkbox"
	                    checked={showDismissedInvites}
	                    onChange={(e) => setShowDismissedInvites(Boolean(e.target.checked))}
	                  />
	                  show dismissed/done invites
	                </label>
	              </div>
	            </div>
		            <div className="field">
	              <div className="field-hd">
	                <span className="mono">Environment</span>
	                {envInfo?.env_kind === 'test' ? (
	                  <span className="chip hi">TEST</span>
	                ) : envInfo?.env_kind === 'mainnet' ? (
	                  <span className="chip danger">MAINNET</span>
	                ) : envInfo?.env_kind === 'mixed' ? (
	                  <span className="chip warn">MIXED</span>
	                ) : (
	                  <span className="chip">UNKNOWN</span>
	                )}
	              </div>
	              <div className="muted small">
	                LN: <span className="mono">{String(envInfo?.ln?.impl || '—')}</span> /{' '}
	                <span className="mono">{String(envInfo?.ln?.network || '—')}</span> · Solana:{' '}
	                <span className="mono">{String(envInfo?.solana?.classify?.kind || '—')}</span>
	              </div>
	              <div className="muted small">
	                Solana RPC:{' '}
	                <span className="mono">{String(Array.isArray(envInfo?.solana?.rpc_urls) ? envInfo.solana.rpc_urls[0] : '—')}</span>
	              </div>
	              <div className="muted small">
	                receipts.db: <span className="mono">{String(envInfo?.receipts?.db || '—')}</span>
	              </div>
	              <div className="muted small">
	                peer.keypair:{' '}
	                <span className="mono">{String(envInfo?.peer?.keypair || '—')}</span>{' '}
	                {envInfo?.peer?.exists === false ? <span className="chip warn">missing</span> : null}
	              </div>
	              {envErr ? <div className="alert bad">{String(envErr)}</div> : null}
	              <div className="row">
	                <button className="btn" onClick={refreshEnv} disabled={envBusy}>
	                  {envBusy ? 'Refreshing…' : 'Refresh env'}
	                </button>
	              </div>
	            </div>

	            <p className="muted small">
	              For external access: run promptd with <span className="mono">server.auth_token</span> + optional{' '}
	              <span className="mono">server.tls</span> in <span className="mono">onchain/prompt/setup.json</span>.
	            </p>
          </Panel>
        ) : null}

        {activeTab === 'console' ? (
          <div className="grid2">
            <Panel title="Console (Expert)">
              <div className="row">
                <button className="btn" onClick={refreshTools} disabled={!health?.ok}>
                  Reload tools
                </button>
                <label className="check small" title="Auto-approve tool runs that change state or can move funds.">
                  <input type="checkbox" checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} />
                  approve
                </label>
                <button className="btn" onClick={() => promptAbortRef.current?.abort()} disabled={!runBusy}>
                  Stop
                </button>
              </div>

              {runErr ? <div className="alert bad">Error: {runErr}</div> : null}

              <div className="row">
                <input
                  className="input"
                  value={toolFilter}
                  onChange={(e) => setToolFilter(e.target.value)}
                  placeholder="search tools…"
                />
                <label className="seg">
                  <input
                    type="radio"
                    name="toolinput"
                    checked={toolInputMode === 'form'}
                    onChange={() => {
                      setRunMode('tool');
                      setToolInputMode('form');
                      setToolArgsParseErr(null);
                    }}
                  />
                  <span>Form</span>
                </label>
                <label className="seg">
                  <input
                    type="radio"
                    name="toolinput"
                    checked={toolInputMode === 'json'}
                    onChange={() => {
                      setRunMode('tool');
                      setToolInputMode('json');
                      setToolArgsText(JSON.stringify(toolArgsObj || {}, null, 2));
                      setToolArgsParseErr(null);
                    }}
                  />
                  <span>JSON</span>
                </label>
              </div>

              {toolFilter.trim() ? (
                <div className="toolsearch-suggest">
                  {toolSuggestions.length > 0 ? (
                    <>
                      <div className="muted small">Suggestions</div>
                      <div className="toolsearch-list">
                        {toolSuggestions.map((t: any) => (
                          <button
                            key={String(t?.name || '')}
                            className="toolsearch-item"
                            onClick={() => {
                              const next = String(t?.name || '').trim();
                              if (!next) return;
                              setRunMode('tool');
                              setToolName(next);
                              setToolArgsBoth({});
                              setToolArgsParseErr(null);
                            }}
                            title={String(t?.description || '')}
                          >
                            <span className="mono">{toolShortName(String(t?.name || ''))}</span>
                            <span className="muted small">{String(t?.description || '')}</span>
                          </button>
                        ))}
                      </div>
                    </>
                  ) : (
                    <div className="muted small">No matching tools found by name/description.</div>
                  )}
                </div>
              ) : null}

              <div className="row">
                <select
                  className="select"
                  value={toolName}
                  onChange={(e) => {
                    setRunMode('tool');
                    setToolName(e.target.value);
                    setToolArgsBoth({});
                    setToolArgsParseErr(null);
                  }}
                >
                  {groupedTools.map((g: any) => (
                    <optgroup key={g.group} label={g.group}>
                      {g.tools.map((t: any) => (
                        <option key={t.name} value={t.name}>
                          {toolShortName(t.name)}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <button
                  className="btn primary"
                  onClick={onRun}
                  disabled={runBusy || !stackGate.ok}
                  title={
                    !stackGate.ok ? `Complete setup checklist first:\n${stackGate.reasons.map((r) => `- ${r}`).join('\n')}` : ''
                  }
                >
                  {runBusy ? 'Running…' : 'Run'}
                </button>
              </div>

              {activeTool ? (
                <div className="toolhelp">
                  <div className="row">
                    <span className="tag">{toolShortName(activeTool.name)}</span>
                    <span className="muted small">{activeTool.description || ''}</span>
                  </div>
                  {toolRequiresApproval(toolName) && !autoApprove ? (
                    <div className="muted small">
                      <span className="chip warn">requires approve</span> (this tool changes state or can move funds)
                    </div>
                  ) : (
                    <div className="muted small">
                      <span className="chip">read-only</span>
                    </div>
                  )}
                </div>
              ) : null}

              {toolInputMode === 'form' ? (
                <ToolForm tool={activeTool} args={toolArgsObj} setArgs={setToolArgsObj} knownChannels={knownChannelsForInputs} />
              ) : (
                <>
                  <textarea
                    className="textarea mono"
                    value={toolArgsText}
                    onChange={(e) => setToolArgsText(e.target.value)}
                    placeholder="{\n  ...\n}"
                  />
                  {toolArgsParseErr ? <div className="alert bad">{toolArgsParseErr}</div> : null}
                </>
              )}
            </Panel>

            <Panel title="Output">
              <div className="row">
                <span className="muted small">
                  session: <span className="mono">{sessionId || 'new'}</span>
                </span>
                <button className="btn" onClick={() => setConsoleEvents([])} disabled={runBusy}>
                  Clear output
                </button>
              </div>
              <VirtualList
                items={consoleEvents}
                itemKey={(e) =>
                  String(e?.type || '') + ':' + String(e?.ts || e?.started_at || '') + ':' + String(e?.name || '')
                }
                estimatePx={58}
                listRef={consoleListRef}
                render={(e) => <ConsoleEventRow evt={e} onSelect={() => setSelected({ type: 'console_event', evt: e })} />}
              />

              <details className="details">
                <summary className="muted small">Inspector</summary>
                <pre className="code">{JSON.stringify(selected, null, 2)}</pre>
              </details>

              <details className="details">
                <summary className="muted small">Audit (local)</summary>
                <div className="row" style={{ marginBottom: 8 }}>
                  <button className="btn small" onClick={() => setPromptEvents([])}>
                    Clear (memory only)
                  </button>
                </div>
                <VirtualList
                  items={promptEvents}
                  itemKey={(e) => String(e.db_id || '') + ':' + String(e.type || '') + ':' + String(e.ts || '')}
                  estimatePx={68}
                  listRef={promptListRef}
                  onScroll={onPromptScroll}
                  render={(e) => <ConsoleEventRow evt={e} onSelect={() => setSelected({ type: 'prompt_event', evt: e })} />}
                />
              </details>
            </Panel>
          </div>
      ) : null}
      </main>

      {selected && selected.type !== 'console_event' && selected.type !== 'prompt_event' ? (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          onMouseDown={() => setSelected(null)}
        >
          <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-hd">
              <div className="mono">
                {selected?.type || 'detail'}
              </div>
              <div className="row">
                <button
                  className="btn small"
                  onClick={() => copyToClipboard('json', JSON.stringify(selected, null, 2))}
                >
                  Copy JSON
                </button>
                <button className="iconbtn" onClick={() => setSelected(null)} aria-label="Close">
                  ×
                </button>
              </div>
            </div>
            <div className="modal-bd">
              <pre className="code" style={{ maxHeight: '60vh' }}>{JSON.stringify(selected, null, 2)}</pre>
            </div>
          </div>
        </div>
      ) : null}

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <div>
              <strong>{t.kind.toUpperCase()}</strong> <span className="muted">{new Date(t.ts).toLocaleTimeString()}</span>
              <div style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{t.message}</div>
            </div>
            <button className="x" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export default App

const READONLY_TOOLS = new Set<string>([
  // Setup / environment
  'intercomswap_env_get',

  // SC-Bridge
  'intercomswap_sc_info',
  'intercomswap_sc_stats',
  'intercomswap_sc_price_get',
  'intercomswap_sc_subscribe',
  'intercomswap_sc_wait_envelope',

  // Local supervisors
  'intercomswap_peer_status',
  'intercomswap_rfqbot_status',

	  // Wallet reads
	  'intercomswap_ln_docker_ps',
	  'intercomswap_ln_info',
	  'intercomswap_ln_listfunds',

	  // Solana reads
	  'intercomswap_sol_local_status',
	  'intercomswap_sol_signer_pubkey',
	  'intercomswap_sol_keypair_pubkey',
	  'intercomswap_sol_balance',
	  'intercomswap_sol_token_balance',
  'intercomswap_sol_escrow_get',
  'intercomswap_sol_config_get',
  'intercomswap_sol_trade_config_get',

  // Receipts reads
  'intercomswap_receipts_list',
  'intercomswap_receipts_show',
  'intercomswap_receipts_list_open_claims',
  'intercomswap_receipts_list_open_refunds',
]);

function toolRequiresApproval(name: string) {
  return !READONLY_TOOLS.has(String(name || '').trim());
}

function toolNeedsFullStack(name: string) {
  const n = String(name || '').trim();
  if (!n) return false;
  // Outbound network messaging and swap protocol actions should not run unless settlement is ready.
  if (n === 'intercomswap_sc_send_text' || n === 'intercomswap_sc_send_json' || n === 'intercomswap_sc_open') return true;
  const g = toolGroup(n);
  return g === 'RFQ Protocol' || g === 'RFQ Bots' || g === 'Swap Helpers';
}

function toolGroup(name: string) {
  const n = String(name || '');
  if (n.startsWith('intercomswap_sc_')) return 'SC-Bridge';
  if (n.startsWith('intercomswap_peer_')) return 'Peers';
  if (n.startsWith('intercomswap_rfqbot_')) return 'RFQ Bots';
  if (n.startsWith('intercomswap_offer_')) return 'RFQ Protocol';
  if (n.startsWith('intercomswap_rfq_') || n.startsWith('intercomswap_quote_') || n.startsWith('intercomswap_terms_')) return 'RFQ Protocol';
  if (n.startsWith('intercomswap_swap_')) return 'Swap Helpers';
  if (n.startsWith('intercomswap_ln_')) return 'Lightning';
  if (n.startsWith('intercomswap_sol_')) return 'Solana';
  if (n.startsWith('intercomswap_receipts_') || n.startsWith('intercomswap_swaprecover_')) return 'Receipts/Recovery';
  return 'Other';
}

function toolShortName(name: string) {
  return String(name || '').replace(/^intercomswap_/, '');
}

function NavButton({
  active,
  onClick,
  label,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  badge?: number;
}) {
  return (
    <button className={`navbtn ${active ? 'active' : ''}`} onClick={onClick}>
      <span>{label}</span>
      {typeof badge === 'number' && badge > 0 ? <span className="badge">{badge}</span> : null}
    </button>
  );
}

function Panel({ title, children }: { title: string; children: any }) {
  return (
    <section className="panel">
      <div className="panel-hd">
        <h2>{title}</h2>
      </div>
      <div className="panel-bd">{children}</div>
    </section>
  );
}

function pow10n(n: number) {
  let out = 1n;
  for (let i = 0; i < n; i += 1) out *= 10n;
  return out;
}

function decimalToAtomic(display: string, decimals: number) {
  const s = String(display || '').trim();
  if (!s) return null;
  const cleaned = s.replaceAll(',', '');
  const m = cleaned.match(/^([0-9]+)(?:\.([0-9]+))?$/);
  if (!m) return { ok: false as const, atomic: null, error: 'Invalid decimal format' };
  const intPart = m[1] || '0';
  const fracPart = m[2] || '';
  if (fracPart.length > decimals) return { ok: false as const, atomic: null, error: `Too many decimals (max ${decimals})` };
  const fracPadded = (fracPart + '0'.repeat(decimals)).slice(0, decimals);
  const atomic = BigInt(intPart) * pow10n(decimals) + BigInt(fracPadded || '0');
  return { ok: true as const, atomic: atomic.toString(), error: null };
}

function atomicToDecimal(atomic: string, decimals: number) {
  const s = String(atomic || '').trim();
  if (!s || !/^[0-9]+$/.test(s)) return '';
  const bi = BigInt(s);
  const base = pow10n(decimals);
  const whole = bi / base;
  const frac = bi % base;
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  return fracStr ? `${whole.toString()}.${fracStr}` : whole.toString();
}

function atomicToNumber(atomic: string, decimals: number): number | null {
  const s = String(atomic || '').trim();
  if (!s || !/^[0-9]+$/.test(s)) return null;
  try {
    const bi = BigInt(s);
    const base = pow10n(decimals);
    const whole = bi / base;
    const frac = bi % base;
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    if (whole > max) return null;
    const wholeNum = Number(whole);
    const fracNum = Number(frac) / Number(base);
    const out = wholeNum + fracNum;
    return Number.isFinite(out) ? out : null;
  } catch (_e) {
    return null;
  }
}

function parseAtomicBigInt(raw: any): bigint | null {
  const s = String(raw ?? '').trim();
  if (!s || !/^[0-9]+$/.test(s)) return null;
  try {
    return BigInt(s);
  } catch (_e) {
    return null;
  }
}

function applyBpsCeilAtomic(amountAtomic: bigint, bps: number): bigint {
  const n = Number.isFinite(bps) ? Math.max(0, Math.trunc(bps)) : 0;
  if (n <= 0) return amountAtomic;
  return (amountAtomic * BigInt(10_000 + n) + 9_999n) / 10_000n;
}

function btcDisplayToSats(display: string) {
  // BTC has 8 decimals.
  const r = decimalToAtomic(display, 8);
  if (!r || !r.ok) return r;
  const n = Number.parseInt(r.atomic, 10);
  if (!Number.isFinite(n) || !Number.isSafeInteger(n)) return { ok: false as const, atomic: null, error: 'BTC amount too large' };
  return { ok: true as const, atomic: n, error: null };
}

function satsToBtcDisplay(sats: number) {
  if (!Number.isFinite(sats) || sats < 0) return '';
  return atomicToDecimal(String(Math.trunc(sats)), 8);
}

function formatHumanNumber(value: number, { maxFractionDigits = 2 }: { maxFractionDigits?: number } = {}) {
  if (!Number.isFinite(value)) return '';
  try {
    return value.toLocaleString('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: Math.max(0, Math.trunc(maxFractionDigits)),
    });
  } catch (_e) {
    return String(value);
  }
}

function lamportsToSolDisplay(lamports: any) {
  const s = String(lamports ?? '').trim();
  if (!s || !/^[0-9]+$/.test(s)) return '';
  return atomicToDecimal(s, 9);
}

const USD_FMT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
function fmtUsd(n: number) {
  if (!Number.isFinite(n)) return '';
  try {
    return USD_FMT.format(n);
  } catch (_e) {
    return `$${n.toFixed(2)}`;
  }
}

function bpsToPctDisplay(bps: number) {
  if (!Number.isFinite(bps)) return '';
  return (bps / 100).toFixed(2).replace(/\.00$/, '');
}

function secToHuman(sec: number) {
  if (!Number.isFinite(sec) || sec < 0) return '';
  if (sec % 86400 === 0) return `${sec / 86400}d`;
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}

function msToUtcIso(ms: number) {
  if (!Number.isFinite(ms) || ms < 1) return '';
  try {
    return new Date(Math.trunc(ms)).toISOString();
  } catch (_e) {
    return '';
  }
}

function epochToMs(raw: any): number | null {
  // Accept seconds or milliseconds (number or numeric-string) and normalize to milliseconds.
  const n =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && /^[0-9]+$/.test(raw.trim())
        ? Number.parseInt(raw.trim(), 10)
        : null;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 1) return null;
  // Heuristic: < 1e12 is almost certainly seconds since epoch; >= 1e12 is ms.
  return n < 1e12 ? Math.trunc(n) * 1000 : Math.trunc(n);
}

function unixSecToUtcIso(sec: number) {
  if (!Number.isFinite(sec) || sec < 1) return '';
  return msToUtcIso(Math.trunc(sec) * 1000);
}

function pad2(n: number) {
  const s = String(Math.trunc(n));
  return s.length >= 2 ? s : `0${s}`;
}

function unixSecToDateTimeLocal(sec: number) {
  if (!Number.isFinite(sec) || sec < 1) return '';
  const d = new Date(Math.trunc(sec) * 1000);
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

function dateTimeLocalToUnixSec(value: string) {
  const s = String(value || '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const yyyy = Number.parseInt(m[1], 10);
  const mm = Number.parseInt(m[2], 10);
  const dd = Number.parseInt(m[3], 10);
  const hh = Number.parseInt(m[4], 10);
  const mi = Number.parseInt(m[5], 10);
  if (![yyyy, mm, dd, hh, mi].every((n) => Number.isFinite(n))) return null;
  const d = new Date(yyyy, mm - 1, dd, hh, mi, 0, 0);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

function parseLines(text: string) {
  return String(text || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function ConsoleEventRow({ evt, onSelect }: { evt: any; onSelect: () => void }) {
  const type = String(evt?.type || '');
  const tsRaw = evt?.ts ?? evt?.started_at ?? null;
  const ts = typeof tsRaw === 'number' ? new Date(tsRaw).toLocaleTimeString() : '';
  let summary = '';
  const toolErr = type === 'tool' && evt?.result && typeof evt.result === 'object' && evt.result.type === 'error' ? String(evt.result.error || '') : '';
  if (type === 'tool') summary = toolErr ? `${evt?.name || ''} -> ERROR: ${toolErr}` : `${evt?.name || ''}`;
  else if (type === 'final') summary = typeof evt?.content === 'string' ? evt.content : '';
  else if (type === 'error') summary = String(evt?.error || 'error');
  else if (type === 'run_start') summary = `session ${evt?.session_id || ''}`;
  else if (type === 'done') summary = `done (${evt?.session_id || ''})`;

  return (
    <div className={`rowitem ${type === 'error' || toolErr ? 'bad' : ''}`} onClick={onSelect} role="button">
      <div className="rowitem-top">
        {ts ? <span className="mono dim">{ts}</span> : null}
        {type ? <span className="mono chip">{type}</span> : null}
      </div>
      <div className="rowitem-mid">
        <span className="mono">{summary ? summary.slice(0, 180) : ''}</span>
      </div>
    </div>
  );
}

function ToolForm({
  tool,
  args,
  setArgs,
  knownChannels,
}: {
  tool: any | null;
  args: Record<string, any>;
  setArgs: (next: Record<string, any>) => void;
  knownChannels: string[];
}) {
  if (!tool) return <p className="muted small">No tool selected.</p>;
  const params = tool?.parameters;
  const props = params?.properties && typeof params.properties === 'object' ? params.properties : {};
  const required = new Set(Array.isArray(params?.required) ? params.required : []);
  const keys = Object.keys(props);
  keys.sort((a, b) => {
    const ar = required.has(a) ? 0 : 1;
    const br = required.has(b) ? 0 : 1;
    if (ar !== br) return ar - br;
    return a.localeCompare(b);
  });

  const update = (k: string, v: any) => {
    setArgs({ ...(args || {}), [k]: v });
  };
  const del = (k: string) => {
    const next = { ...(args || {}) };
    delete (next as any)[k];
    setArgs(next);
  };

  return (
    <div className="toolform">
      <datalist id="collin-channels">
        {knownChannels.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>

      {keys.map((k) => {
        const sch = props[k] || {};
        const isReq = required.has(k);
        const label = k.replaceAll('_', ' ');
        const desc = typeof sch.description === 'string' ? sch.description : '';
        const v = (args || {})[k];

        const isChannel = typeof sch.type === 'string' && sch.type === 'string' && (k === 'channel' || k.endsWith('_channel') || k.includes('channel'));
        const isBtcSats = k === 'btc_sats' || k === 'amount_sats';
        const isMsat = k === 'amount_msat';
        const isUsdt = k === 'usdt_amount';
        const isBps = sch?.type === 'integer' && (k.endsWith('_bps') || k.includes('bps'));
        const isSec = sch?.type === 'integer' && (k.endsWith('_sec') || k.includes('_sec'));
        const isAtomicDigits = sch?.type === 'string' && typeof sch?.pattern === 'string' && sch.pattern === '^[0-9]+$';
        const isGenericAtomic = isAtomicDigits && (k === 'amount' || k === 'lamports');
        const enumVals = Array.isArray(sch?.enum) ? sch.enum : null;

        return (
          <div key={k} className="field">
            <div className="field-hd">
              <span className="mono">{label}</span>
              {isReq ? <span className="chip hi">required</span> : <span className="chip">optional</span>}
            </div>
            {desc ? <div className="muted small">{desc}</div> : null}

            {isUsdt ? (
              <AtomicDisplayField
                name={`amt-${tool.name}-${k}`}
                atomic={typeof v === 'string' ? v : ''}
                decimals={6}
                symbol="USDT"
                onAtomic={(next) => (next === null ? del(k) : update(k, next))}
              />
            ) : isBtcSats ? (
              <BtcSatsField
                name={`sats-${tool.name}-${k}`}
                sats={typeof v === 'number' ? v : null}
                onSats={(next) => (next === null ? del(k) : update(k, next))}
              />
            ) : isMsat ? (
              <MsatField
                name={`msat-${tool.name}-${k}`}
                msat={typeof v === 'number' ? v : null}
                onMsat={(next) => (next === null ? del(k) : update(k, next))}
              />
            ) : isBps ? (
              <BpsField
                name={`bps-${tool.name}-${k}`}
                bps={typeof v === 'number' ? v : null}
                onBps={(next) => (next === null ? del(k) : update(k, next))}
              />
            ) : isSec ? (
              <DurationSecField
                name={`sec-${tool.name}-${k}`}
                sec={typeof v === 'number' ? v : null}
                onSec={(next) => (next === null ? del(k) : update(k, next))}
              />
            ) : isGenericAtomic ? (
              <AtomicDisplayField
                name={`amt-${tool.name}-${k}`}
                atomic={typeof v === 'string' ? v : ''}
                decimals={k === 'lamports' ? 9 : 6}
                symbol={k === 'lamports' ? 'SOL' : 'token'}
                onAtomic={(next) => (next === null ? del(k) : update(k, next))}
              />
            ) : enumVals && (sch?.type === 'string' || sch?.type === 'integer') ? (
              <select
                className="select"
                value={v === undefined || v === null ? '' : String(v)}
                onChange={(e) => {
                  const raw = e.target.value;
                  if (!raw) return isReq ? update(k, sch?.type === 'integer' ? 0 : '') : del(k);
                  if (sch?.type === 'integer') {
                    const n = Number.parseInt(raw, 10);
                    if (!Number.isFinite(n)) return;
                    update(k, n);
                    return;
                  }
                  update(k, raw);
                }}
              >
                {!isReq ? <option value="">(default)</option> : null}
                {enumVals.map((ev: any) => (
                  <option key={String(ev)} value={String(ev)}>
                    {String(ev)}
                  </option>
                ))}
              </select>
            ) : sch?.type === 'boolean' ? (
              isReq ? (
                <label className="check">
                  <input
                    type="checkbox"
                    checked={Boolean(v)}
                    onChange={(e) => update(k, e.target.checked)}
                  />
                  {k}
                </label>
              ) : (
                <select
                  className="select"
                  value={typeof v === 'boolean' ? (v ? 'true' : 'false') : ''}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (!raw) return del(k);
                    update(k, raw === 'true');
                  }}
                >
                  <option value="">(default)</option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              )
            ) : sch?.type === 'integer' ? (
              <input
                className="input mono"
                type="number"
                value={typeof v === 'number' ? String(v) : ''}
                placeholder={isReq ? 'required' : 'optional'}
                onChange={(e) => {
                  const raw = e.target.value;
                  if (!raw.trim()) return isReq ? update(k, 0) : del(k);
                  const n = Number.parseInt(raw, 10);
                  if (!Number.isFinite(n)) return;
                  update(k, n);
                }}
              />
            ) : sch?.type === 'string' ? (
              <input
                className="input mono"
                type="text"
                value={typeof v === 'string' ? v : ''}
                list={isChannel ? 'collin-channels' : undefined}
                placeholder={isReq ? 'required' : 'optional'}
                onChange={(e) => {
                  const raw = e.target.value;
                  if (!raw.trim()) return isReq ? update(k, '') : del(k);
                  update(k, raw);
                }}
              />
            ) : sch?.type === 'array' ? (
              (() => {
                const itemsType = (sch as any)?.items?.type;
                const isStringList = itemsType === 'string';
                const text = isStringList
                  ? Array.isArray(v)
                    ? v.map((x: any) => String(x ?? '')).join('\n')
                    : ''
                  : Array.isArray(v)
                    ? JSON.stringify(v, null, 2)
                    : v !== undefined && v !== null
                      ? JSON.stringify(v, null, 2)
                      : '';
                return (
                  <textarea
                    className="textarea mono"
                    value={text}
                    placeholder={isStringList ? (isReq ? 'one per line (required)' : 'one per line (optional)') : 'JSON array'}
                    onChange={(e) => {
                      const raw = e.target.value;
                      if (!raw.trim()) return isReq ? update(k, isStringList ? [] : []) : del(k);
                      if (isStringList) {
                        const lines = parseLines(raw);
                        if (lines.length === 0) return isReq ? update(k, []) : del(k);
                        update(k, lines);
                        return;
                      }
                      try {
                        const parsed = JSON.parse(raw);
                        if (!Array.isArray(parsed)) return;
                        update(k, parsed);
                      } catch (_e) {
                        // Ignore invalid JSON; keep previous value.
                      }
                    }}
                  />
                );
              })()
            ) : (
              <textarea
                className="textarea mono"
                value={typeof v === 'string' ? v : v !== undefined ? JSON.stringify(v, null, 2) : ''}
                placeholder="JSON"
                onChange={(e) => {
                  const raw = e.target.value;
                  if (!raw.trim()) return isReq ? update(k, {}) : del(k);
                  try {
                    update(k, JSON.parse(raw));
                  } catch (_e) {
                    // Keep raw string if it isn't JSON (useful for secret: handles).
                    update(k, raw);
                  }
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function AtomicDisplayField({
  name,
  atomic,
  decimals,
  symbol,
  onAtomic,
}: {
  name: string;
  atomic: string;
  decimals: number;
  symbol: string;
  onAtomic: (next: string | null) => void;
}) {
  const [mode, setMode] = useState<'display' | 'atomic'>('display');
  const [display, setDisplay] = useState('');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== 'display') return;
    setDisplay(atomicToDecimal(atomic, decimals));
  }, [atomic, decimals, mode]);

  return (
    <div className="amt">
      <div className="row">
        <label className="seg">
          <input type="radio" name={name} checked={mode === 'display'} onChange={() => setMode('display')} />
          <span>{symbol}</span>
        </label>
        <label className="seg">
          <input type="radio" name={name} checked={mode === 'atomic'} onChange={() => setMode('atomic')} />
          <span>atomic</span>
        </label>
      </div>
      {mode === 'display' ? (
        <>
          <input
            className="input mono"
            type="text"
            value={display}
            placeholder={`0.${'0'.repeat(Math.min(2, decimals))}`}
            onChange={(e) => {
              const raw = e.target.value;
              setDisplay(raw);
              if (!raw.trim()) {
                setErr(null);
                onAtomic(null);
                return;
              }
              const r = decimalToAtomic(raw, decimals);
              if (!r || !r.ok) {
                setErr(r ? r.error : 'invalid');
                return;
              }
              setErr(null);
              onAtomic(r.atomic);
            }}
          />
          <div className="muted small">
            atomic: <span className="mono">{atomic || '—'}</span>
          </div>
        </>
      ) : (
        <input
          className="input mono"
          type="text"
          value={atomic}
          placeholder="atomic digits"
          onChange={(e) => {
            const raw = e.target.value.trim();
            if (!raw) return onAtomic(null);
            if (!/^[0-9]+$/.test(raw)) {
              setErr('atomic must be digits');
              return;
            }
            setErr(null);
            onAtomic(raw);
          }}
        />
      )}
      {err ? <div className="alert bad">{err}</div> : null}
    </div>
  );
}

function BpsField({ name, bps, onBps }: { name: string; bps: number | null; onBps: (next: number | null) => void }) {
  const [unit, setUnit] = useState<'bps' | '%'>('%');
  const [display, setDisplay] = useState('');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (bps === null || bps === undefined) return;
    if (unit === 'bps') setDisplay(String(bps));
    else setDisplay(bpsToPctDisplay(bps));
  }, [bps, unit]);

  return (
    <div className="amt">
      <div className="row">
        <label className="seg">
          <input type="radio" name={name} checked={unit === '%'} onChange={() => setUnit('%')} />
          <span>%</span>
        </label>
        <label className="seg">
          <input type="radio" name={name} checked={unit === 'bps'} onChange={() => setUnit('bps')} />
          <span>bps</span>
        </label>
      </div>
      <input
        className="input mono"
        type="text"
        value={display}
        placeholder={unit === '%' ? '0.50' : '50'}
        onChange={(e) => {
          const raw = e.target.value.trim();
          setDisplay(raw);
          if (!raw) {
            setErr(null);
            onBps(null);
            return;
          }
          if (unit === 'bps') {
            if (!/^[0-9]+$/.test(raw)) {
              setErr('digits only');
              return;
            }
            const n = Number.parseInt(raw, 10);
            if (!Number.isFinite(n) || !Number.isSafeInteger(n)) {
              setErr('invalid bps');
              return;
            }
            setErr(null);
            onBps(n);
            return;
          }
          // Percent can be decimal.
          if (!/^[0-9]+(\.[0-9]+)?$/.test(raw)) {
            setErr('invalid %');
            return;
          }
          const pct = Number.parseFloat(raw);
          if (!Number.isFinite(pct)) {
            setErr('invalid %');
            return;
          }
          const out = Math.round(pct * 100);
          if (!Number.isSafeInteger(out) || out < 0) {
            setErr('invalid %');
            return;
          }
          setErr(null);
          onBps(out);
        }}
      />
      {typeof bps === 'number' ? (
        <div className="muted small">
          bps: <span className="mono">{bps}</span> ({bpsToPctDisplay(bps)}%)
        </div>
      ) : null}
      {err ? <div className="alert bad">{err}</div> : null}
    </div>
  );
}

function DurationSecField({ name, sec, onSec }: { name: string; sec: number | null; onSec: (next: number | null) => void }) {
  const [unit, setUnit] = useState<'sec' | 'min' | 'hour' | 'day'>('hour');
  const [display, setDisplay] = useState('');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (sec === null || sec === undefined) return;
    const s = Math.trunc(sec);
    if (unit === 'day') setDisplay(String(Math.trunc(s / 86400)));
    else if (unit === 'hour') setDisplay(String(Math.trunc(s / 3600)));
    else if (unit === 'min') setDisplay(String(Math.trunc(s / 60)));
    else setDisplay(String(s));
  }, [sec, unit]);

  return (
    <div className="amt">
      <div className="row">
        <label className="seg">
          <input type="radio" name={name} checked={unit === 'hour'} onChange={() => setUnit('hour')} />
          <span>hours</span>
        </label>
        <label className="seg">
          <input type="radio" name={name} checked={unit === 'day'} onChange={() => setUnit('day')} />
          <span>days</span>
        </label>
        <label className="seg">
          <input type="radio" name={name} checked={unit === 'min'} onChange={() => setUnit('min')} />
          <span>min</span>
        </label>
        <label className="seg">
          <input type="radio" name={name} checked={unit === 'sec'} onChange={() => setUnit('sec')} />
          <span>sec</span>
        </label>
      </div>
      <input
        className="input mono"
        type="text"
        value={display}
        placeholder={unit === 'hour' ? '72' : unit === 'day' ? '3' : unit === 'min' ? '60' : '3600'}
        onChange={(e) => {
          const raw = e.target.value.trim();
          setDisplay(raw);
          if (!raw) {
            setErr(null);
            onSec(null);
            return;
          }
          if (!/^[0-9]+$/.test(raw)) {
            setErr('digits only');
            return;
          }
          const n = Number.parseInt(raw, 10);
          if (!Number.isFinite(n) || !Number.isSafeInteger(n) || n < 0) {
            setErr('invalid number');
            return;
          }
          const factor = unit === 'day' ? 86400 : unit === 'hour' ? 3600 : unit === 'min' ? 60 : 1;
          const out = n * factor;
          if (!Number.isSafeInteger(out)) {
            setErr('too large');
            return;
          }
          setErr(null);
          onSec(out);
        }}
      />
      {typeof sec === 'number' ? (
        <div className="muted small">
          sec: <span className="mono">{Math.trunc(sec)}</span> ({secToHuman(Math.trunc(sec))})
        </div>
      ) : null}
      {err ? <div className="alert bad">{err}</div> : null}
    </div>
  );
}

function MsatField({ name, msat, onMsat }: { name: string; msat: number | null; onMsat: (next: number | null) => void }) {
  const [unit, setUnit] = useState<'msat' | 'sats'>('sats');
  const [display, setDisplay] = useState('');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (msat === null || msat === undefined) return;
    if (unit === 'msat') setDisplay(String(msat));
    else setDisplay(String(Math.trunc(msat / 1000)));
  }, [msat, unit]);

  return (
    <div className="amt">
      <div className="row">
        <label className="seg">
          <input type="radio" name={name} checked={unit === 'sats'} onChange={() => setUnit('sats')} />
          <span>sats</span>
        </label>
        <label className="seg">
          <input type="radio" name={name} checked={unit === 'msat'} onChange={() => setUnit('msat')} />
          <span>msat</span>
        </label>
      </div>
      <input
        className="input mono"
        type="text"
        value={display}
        placeholder={unit === 'sats' ? '10000' : '10000000'}
        onChange={(e) => {
          const raw = e.target.value.trim();
          setDisplay(raw);
          if (!raw) {
            setErr(null);
            onMsat(null);
            return;
          }
          if (!/^[0-9]+$/.test(raw)) {
            setErr('digits only');
            return;
          }
          const n = Number.parseInt(raw, 10);
          if (!Number.isFinite(n) || !Number.isSafeInteger(n)) {
            setErr('invalid number');
            return;
          }
          const out = unit === 'sats' ? n * 1000 : n;
          setErr(null);
          onMsat(out);
        }}
      />
      {err ? <div className="alert bad">{err}</div> : null}
    </div>
  );
}

function BtcSatsField({ name, sats, onSats }: { name: string; sats: number | null; onSats: (next: number | null) => void }) {
  const [unit, setUnit] = useState<'sats' | 'btc'>('sats');
  const [display, setDisplay] = useState('');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (sats === null || sats === undefined) return;
    if (unit === 'sats') setDisplay(String(Math.trunc(sats)));
    else setDisplay(satsToBtcDisplay(Math.trunc(sats)));
  }, [sats, unit]);

  return (
    <div className="amt">
      <div className="row">
        <label className="seg">
          <input type="radio" name={name} checked={unit === 'sats'} onChange={() => setUnit('sats')} />
          <span>sats</span>
        </label>
        <label className="seg">
          <input type="radio" name={name} checked={unit === 'btc'} onChange={() => setUnit('btc')} />
          <span>BTC</span>
        </label>
      </div>
      <input
        className="input mono"
        type="text"
        value={display}
        placeholder={unit === 'sats' ? '10000' : '0.0001'}
        onChange={(e) => {
          const raw = e.target.value.trim();
          setDisplay(raw);
          if (!raw) {
            setErr(null);
            onSats(null);
            return;
          }
          if (unit === 'sats') {
            if (!/^[0-9]+$/.test(raw)) {
              setErr('digits only');
              return;
            }
            const n = Number.parseInt(raw, 10);
            if (!Number.isFinite(n) || !Number.isSafeInteger(n) || n < 0) {
              setErr('invalid number');
              return;
            }
            setErr(null);
            onSats(n);
            return;
          }

          const r = btcDisplayToSats(raw);
          if (!r || !r.ok) {
            setErr(r?.error || 'invalid BTC amount');
            return;
          }
          const n = r.atomic;
          if (!Number.isFinite(n) || !Number.isSafeInteger(n) || n < 0) {
            setErr('invalid number');
            return;
          }
          setErr(null);
          onSats(n);
        }}
      />
      {typeof sats === 'number' ? (
        <div className="muted small">
          BTC: <span className="mono">{satsToBtcDisplay(Math.trunc(sats))}</span> (<span className="mono">{Math.trunc(sats)}</span> sats)
        </div>
      ) : null}
      {err ? <div className="alert bad">{err}</div> : null}
    </div>
  );
}

function UsdtAtomicField({
  decimals,
  atomic,
  onAtomic,
  placeholder,
}: {
  decimals: number;
  atomic: string | null;
  onAtomic: (next: string | null) => void;
  placeholder?: string;
}) {
  const [display, setDisplay] = useState('');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const a = String(atomic ?? '').trim();
    if (!a) {
      setDisplay('');
      return;
    }
    setDisplay(atomicToDecimal(a, decimals));
  }, [atomic, decimals]);

  return (
    <div className="amt">
      <input
        className="input mono"
        type="text"
        value={display}
        placeholder={placeholder || '10'}
        onChange={(e) => {
          let raw = e.target.value.trim();
          setDisplay(raw);
          if (!raw) {
            setErr(null);
            onAtomic(null);
            return;
          }
          // Allow "10." while typing.
          if (raw.endsWith('.')) raw = raw.slice(0, -1);
          const r = decimalToAtomic(raw, decimals);
          if (!r || !r.ok) {
            setErr(r?.error || 'invalid amount');
            return;
          }
          setErr(null);
          onAtomic(r.atomic);
        }}
      />
      {String(atomic || '').trim() ? (
        <div className="muted small">
          base units: <span className="mono">{String(atomic)}</span>
        </div>
      ) : null}
      {err ? <div className="alert bad">{err}</div> : null}
    </div>
  );
}

function PctBpsField({
  label,
  maxBps,
  bps,
  onBps,
}: {
  label: string;
  maxBps: number;
  bps: number | null;
  onBps: (next: number | null) => void;
}) {
  const [display, setDisplay] = useState('');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (bps === null || bps === undefined) return;
    setDisplay(bpsToPctDisplay(bps));
  }, [bps]);

  return (
    <div className="amt">
      <div className="muted small">
        {label} (%)
      </div>
      <input
        className="input mono"
        type="text"
        value={display}
        placeholder="0.50"
        onChange={(e) => {
          const raw = e.target.value.trim();
          setDisplay(raw);
          if (!raw) {
            setErr(null);
            onBps(0);
            return;
          }
          let v = raw;
          if (v.endsWith('.')) v = v.slice(0, -1);
          const r = decimalToAtomic(v, 2);
          if (!r || !r.ok) {
            setErr(r?.error || 'invalid percent');
            return;
          }
          const n = Number.parseInt(r.atomic, 10);
          if (!Number.isFinite(n) || !Number.isSafeInteger(n) || n < 0) {
            setErr('invalid percent');
            return;
          }
          if (n > maxBps) {
            setErr(`must be <= ${bpsToPctDisplay(maxBps)}%`);
            return;
          }
          setErr(null);
          onBps(n);
        }}
      />
      {typeof bps === 'number' ? (
        <div className="muted small">
          bps: <span className="mono">{bps}</span>
        </div>
      ) : null}
      {err ? <div className="alert bad">{err}</div> : null}
    </div>
  );
}

function EventRow({
  evt,
  onSelect,
  selected,
}: {
  evt: any;
  onSelect: () => void;
  selected: boolean;
}) {
  const ts = evt?.ts ? new Date(evt.ts).toLocaleTimeString() : '';
  const kind = evt?.kind ? String(evt.kind) : '';
  const channel = evt?.channel ? String(evt.channel) : '';
  const type = evt?.type ? String(evt.type) : '';
  const summary = kind ? `${kind} ${evt.trade_id ? `(${evt.trade_id})` : ''}` : type;

  return (
    <div className={`rowitem ${selected ? 'selected' : ''}`} onClick={onSelect} role="button">
      <div className="rowitem-top">
        <span className="mono dim">{ts}</span>
        {channel ? <span className="mono chip">{channel}</span> : null}
      </div>
      <div className="rowitem-mid">
        <span className="mono">{summary}</span>
      </div>
      <div className="rowitem-bot">
        <span className="muted small">{previewMessage(evt?.message)}</span>
      </div>
    </div>
  );
}

function QuoteRow({
  evt,
  oracle,
  onSelect,
  onAccept,
}: {
  evt: any;
  oracle?: OracleSummary;
  onSelect: () => void;
  onAccept: () => void;
}) {
  const body = evt?.message?.body;
  const btcSats = typeof body?.btc_sats === 'number' ? body.btc_sats : null;
  const usdtAtomic = typeof body?.usdt_amount === 'string' ? body.usdt_amount : '';
  const totalFee = (() => {
    const p = body?.platform_fee_bps;
    const t = body?.trade_fee_bps;
    return typeof p === 'number' && typeof t === 'number' ? p + t : null;
  })();
  const solWindow = body?.sol_refund_window_sec;
  const validUntil = body?.valid_until_unix;
  const validUntilIso = typeof validUntil === 'number' ? unixSecToUtcIso(validUntil) : '';
  const expired = typeof validUntil === 'number' ? validUntil <= Math.floor(Date.now() / 1000) : false;
  const oracleBtcUsd = oracle && typeof oracle.btc_usd === 'number' ? oracle.btc_usd : null;
  const btcUsd = btcSats !== null && oracleBtcUsd ? (btcSats / 1e8) * oracleBtcUsd : null;
  const usdtNum = usdtAtomic ? atomicToNumber(usdtAtomic, 6) : null;
  const btcBtc = btcSats !== null ? btcSats / 1e8 : null;
  const btcDisplay = btcBtc !== null ? formatHumanNumber(btcBtc, { maxFractionDigits: 8 }) : '?';
  const usdtDisplay =
    usdtNum !== null
      ? formatHumanNumber(usdtNum, { maxFractionDigits: 6 })
      : usdtAtomic
        ? atomicToDecimal(usdtAtomic, 6)
        : '?';
  const pricePerBtc = btcBtc !== null && btcBtc > 0 && usdtNum !== null ? usdtNum / btcBtc : null;
  const priceDisplay = pricePerBtc !== null ? formatHumanNumber(pricePerBtc, { maxFractionDigits: 2 }) : '?';
  return (
    <div className={`rowitem ${expired ? 'expired' : ''}`} role="button" onClick={onSelect}>
      <div className="rowitem-top">
        {expired ? <span className="mono chip warn">expired</span> : null}
        <span className="trade-activity-headline">
          Sell <span className="mono">{btcDisplay}</span> BTC → <span className="mono">{usdtDisplay}</span> USDT
        </span>
      </div>
      <div className="rowitem-mid">
        <span className="muted"><span className="mono">{priceDisplay}</span> USDT/BTC</span>
        {btcUsd !== null ? <span className="muted">≈ {fmtUsd(btcUsd)}</span> : null}
        {typeof totalFee === 'number' ? <span className="muted">fees {bpsToPctDisplay(totalFee)}%</span> : null}
        {typeof solWindow === 'number' ? <span className="muted">win {secToHuman(solWindow)}</span> : null}
        <span className="dim">{validUntilIso ? `exp ${validUntilIso}` : ''}</span>
      </div>
      {!expired ? (
        <div className="rowitem-bot">
          <button
            className="btn small primary"
            onClick={(e) => {
              e.stopPropagation();
              onAccept();
            }}
          >
            Accept
          </button>
        </div>
      ) : null}
    </div>
  );
}

function RfqRow({
  evt,
  oracle,
  onSelect,
  onQuote,
  showQuote = true,
}: {
  evt: any;
  oracle?: OracleSummary;
  onSelect: () => void;
  onQuote: () => void;
  showQuote?: boolean;
}) {
  const body = evt?.message?.body;
  const btcSats = typeof body?.btc_sats === 'number' ? body.btc_sats : null;
  const usdtAtomic = typeof body?.usdt_amount === 'string' ? body.usdt_amount : '';
  const maxTotal = body?.max_total_fee_bps;
  const minWin = body?.min_sol_refund_window_sec;
  const maxWin = body?.max_sol_refund_window_sec;
  const validUntil = body?.valid_until_unix;
  const validUntilIso = typeof validUntil === 'number' ? unixSecToUtcIso(validUntil) : '';
  const expired = typeof validUntil === 'number' ? validUntil <= Math.floor(Date.now() / 1000) : false;
  const oracleBtcUsd = oracle && typeof oracle.btc_usd === 'number' ? oracle.btc_usd : null;
  const btcUsd = btcSats !== null && oracleBtcUsd ? (btcSats / 1e8) * oracleBtcUsd : null;
  const usdtNum = usdtAtomic ? atomicToNumber(usdtAtomic, 6) : null;
  const btcBtc = btcSats !== null ? btcSats / 1e8 : null;
  const btcDisplay = btcBtc !== null ? formatHumanNumber(btcBtc, { maxFractionDigits: 8 }) : '?';
  const usdtDisplay =
    usdtNum !== null
      ? formatHumanNumber(usdtNum, { maxFractionDigits: 6 })
      : usdtAtomic
        ? atomicToDecimal(usdtAtomic, 6)
        : '?';
  const pricePerBtc = btcBtc !== null && btcBtc > 0 && usdtNum !== null ? usdtNum / btcBtc : null;
  const priceDisplay = pricePerBtc !== null ? formatHumanNumber(pricePerBtc, { maxFractionDigits: 2 }) : '?';
  return (
    <div className={`rowitem ${expired ? 'expired' : ''}`} role="button" onClick={onSelect}>
      <div className="rowitem-top">
        {expired ? <span className="mono chip warn">expired</span> : null}
        <span className="trade-activity-headline">
          Sell <span className="mono">{btcDisplay}</span> BTC → <span className="mono">{usdtDisplay}</span> USDT
        </span>
      </div>
      <div className="rowitem-mid">
        <span className="muted"><span className="mono">{priceDisplay}</span> USDT/BTC</span>
        {btcUsd !== null ? <span className="muted">≈ {fmtUsd(btcUsd)}</span> : null}
        <span className="muted">fees {typeof maxTotal === 'number' ? `${bpsToPctDisplay(maxTotal)}%` : '?'}</span>
        <span className="muted">win {typeof minWin === 'number' ? secToHuman(minWin) : '?'}–{typeof maxWin === 'number' ? secToHuman(maxWin) : '?'}</span>
        <span className="dim">{validUntilIso ? `exp ${validUntilIso}` : ''}</span>
      </div>
      {showQuote ? (
        <div className="rowitem-bot">
          <button
            className="btn small primary"
            disabled={expired}
            title={expired ? 'RFQ expired' : ''}
            onClick={(e) => {
              e.stopPropagation();
              onQuote();
            }}
          >
            Quote
          </button>
        </div>
      ) : null}
    </div>
  );
}

function OfferRow({
  evt,
  oracle,
  onSelect,
  onRespond,
  showRespond = true,
}: {
  evt: any;
  oracle?: OracleSummary;
  onSelect: () => void;
  onRespond: () => void;
  showRespond?: boolean;
}) {
  const body = evt?.message?.body;
  const offers = Array.isArray(body?.offers) ? body.offers : [];
  const o = offers[0] && typeof offers[0] === 'object' ? offers[0] : {};

  const btcSats = typeof o?.btc_sats === 'number' ? o.btc_sats : null;
  const usdtAtomic = typeof o?.usdt_amount === 'string' ? o.usdt_amount : '';
  const maxTotal = o?.max_total_fee_bps;
  const minWin = o?.min_sol_refund_window_sec;
  const maxWin = o?.max_sol_refund_window_sec;
  const validUntil = body?.valid_until_unix;
  const validUntilIso = typeof validUntil === 'number' ? unixSecToUtcIso(validUntil) : '';
  const expired = typeof validUntil === 'number' ? validUntil <= Math.floor(Date.now() / 1000) : false;
  const oracleBtcUsd = oracle && typeof oracle.btc_usd === 'number' ? oracle.btc_usd : null;
  const btcUsd = btcSats !== null && oracleBtcUsd ? (btcSats / 1e8) * oracleBtcUsd : null;
  const usdtNum = usdtAtomic ? atomicToNumber(usdtAtomic, 6) : null;
  const btcBtc = btcSats !== null ? btcSats / 1e8 : null;
  const btcDisplay = btcBtc !== null ? formatHumanNumber(btcBtc, { maxFractionDigits: 8 }) : '?';
  const usdtDisplay =
    usdtNum !== null
      ? formatHumanNumber(usdtNum, { maxFractionDigits: 6 })
      : usdtAtomic
        ? atomicToDecimal(usdtAtomic, 6)
        : '?';
  const pricePerBtc = btcBtc !== null && btcBtc > 0 && usdtNum !== null ? usdtNum / btcBtc : null;
  const priceDisplay = pricePerBtc !== null ? formatHumanNumber(pricePerBtc, { maxFractionDigits: 2 }) : '?';

  return (
    <div className={`rowitem ${expired ? 'expired' : ''}`} role="button" onClick={onSelect}>
      <div className="rowitem-top">
        {expired ? <span className="mono chip warn">expired</span> : null}
        {offers.length > 1 ? <span className="mono chip">{offers.length} lines</span> : null}
        <span className="trade-activity-headline">
          Sell <span className="mono">{usdtDisplay}</span> USDT → <span className="mono">{btcDisplay}</span> BTC
        </span>
      </div>
      <div className="rowitem-mid">
        <span className="muted"><span className="mono">{priceDisplay}</span> USDT/BTC</span>
        {btcUsd !== null ? <span className="muted">≈ {fmtUsd(btcUsd)}</span> : null}
        <span className="muted">fees {typeof maxTotal === 'number' ? `${bpsToPctDisplay(maxTotal)}%` : '?'}</span>
        <span className="muted">win {typeof minWin === 'number' ? secToHuman(minWin) : '?'}–{typeof maxWin === 'number' ? secToHuman(maxWin) : '?'}</span>
        <span className="dim">{validUntilIso ? `exp ${validUntilIso}` : ''}</span>
      </div>
      {showRespond ? (
        <div className="rowitem-bot">
          <button
            className="btn small primary"
            disabled={expired}
            title={expired ? 'Offer expired' : ''}
            onClick={(e) => {
              e.stopPropagation();
              onRespond();
            }}
          >
            Respond
          </button>
        </div>
      ) : null}
    </div>
  );
}

function InviteRow({
  evt,
  onSelect,
  onJoin,
  onWatch,
  onLeave,
  onReceipt,
  onDismiss,
  onUndismiss,
  watched,
  dismissed,
  joined,
  joinable,
  joinBlockReason,
}: {
  evt: any;
  onSelect: () => void;
  onJoin: () => void;
  onWatch: () => void;
  onLeave: () => void;
  onReceipt: () => void;
  onDismiss: () => void;
  onUndismiss: () => void;
  watched: boolean;
  dismissed: boolean;
  joined: boolean;
  joinable: boolean;
  joinBlockReason: string | null;
}) {
  const msg = evt?.message;
  const body = msg?.body;
  const swapChannel = String(body?.swap_channel || '').trim();
  const tradeId = String(evt?.trade_id || msg?.trade_id || '').trim();
  const expiresAtMs =
    typeof evt?._invite_expires_at_ms === 'number'
      ? (evt._invite_expires_at_ms as number)
      : epochToMs(body?.invite?.payload?.expiresAt);
  const expired = Boolean(evt?._invite_expired);
  const done = Boolean(evt?._invite_done);
  const expIso = expiresAtMs ? msToUtcIso(expiresAtMs) : '';

  return (
    <div className="rowitem" role="button" onClick={onSelect}>
      <div className="rowitem-top">
        <span className="mono chip">{evt.channel}</span>
        {swapChannel ? <span className="mono chip hi">{swapChannel}</span> : null}
        {done ? <span className="mono chip">done</span> : null}
        {expired ? <span className="mono chip warn">expired</span> : null}
        {watched ? <span className="mono chip">watched</span> : null}
        {joined ? <span className="mono chip">joined</span> : null}
        {!joinable ? <span className="mono chip warn">not joinable yet</span> : null}
        {dismissed ? <span className="mono chip dim">dismissed</span> : null}
      </div>
      <div className="rowitem-mid">
        <span className="mono">swap_invite</span>
        {tradeId ? <span className="mono dim">trade_id: {tradeId}</span> : null}
        {expIso ? <span className="mono dim">expires: {expIso}</span> : null}
      </div>
      <div className="rowitem-bot">
        <button
          className="btn small primary"
          disabled={joined || !joinable}
          title={!joinable ? (joinBlockReason || 'Invite not joinable yet') : ''}
          onClick={(e) => {
            e.stopPropagation();
            onJoin();
          }}
        >
          {joined ? 'Joined' : 'Join'}
        </button>
        {swapChannel ? (
          <button
            className="btn small"
            onClick={(e) => {
              e.stopPropagation();
              onWatch();
            }}
            disabled={watched}
            title={watched ? 'Already watched' : ''}
          >
            Watch
          </button>
        ) : null}
        {swapChannel ? (
          <button
            className="btn small"
            onClick={(e) => {
              e.stopPropagation();
              onLeave();
            }}
          >
            Leave
          </button>
        ) : null}
        {tradeId ? (
          <button
            className="btn small"
            onClick={(e) => {
              e.stopPropagation();
              onReceipt();
            }}
          >
            Receipt
          </button>
        ) : null}
        {tradeId ? (
          dismissed ? (
            <button
              className="btn small"
              onClick={(e) => {
                e.stopPropagation();
                onUndismiss();
              }}
            >
              Undismiss
            </button>
          ) : (
            <button
              className="btn small"
              onClick={(e) => {
                e.stopPropagation();
                onDismiss();
              }}
            >
              Dismiss
            </button>
          )
        ) : null}
      </div>
    </div>
  );
}

function TradeRow({
  trade,
  oracle,
  selected,
  onSelect,
  onRecoverClaim,
  onRecoverRefund,
}: {
  trade: any;
  oracle?: OracleSummary;
  selected: boolean;
  onSelect: () => void;
  onRecoverClaim: () => void;
  onRecoverRefund: () => void;
}) {
  const state = String(trade?.state || '').trim();
  const role = String(trade?.role || '').trim();
  const sats = typeof trade?.btc_sats === 'number' ? trade.btc_sats : null;
  const usdtAtomic = typeof trade?.usdt_amount === 'string' ? trade.usdt_amount : '';
  const oracleBtcUsd = oracle && typeof oracle.btc_usd === 'number' ? oracle.btc_usd : null;
  const btcUsd = sats !== null && oracleBtcUsd ? (sats / 1e8) * oracleBtcUsd : null;
  const usdtNum = usdtAtomic ? atomicToNumber(usdtAtomic, 6) : null;
  const btcBtc = sats !== null ? sats / 1e8 : null;
  const btcDisplay = btcBtc !== null ? formatHumanNumber(btcBtc, { maxFractionDigits: 8 }) : '?';
  const usdtDisplay = usdtNum !== null
    ? formatHumanNumber(usdtNum, { maxFractionDigits: 6 })
    : usdtAtomic ? atomicToDecimal(usdtAtomic, 6) : '?';
  const pricePerBtc = btcBtc !== null && btcBtc > 0 && usdtNum !== null ? usdtNum / btcBtc : null;
  const priceDisplay = pricePerBtc !== null ? formatHumanNumber(pricePerBtc, { maxFractionDigits: 2 }) : null;
  const expired = state === 'expired' || state === 'failed' || state === 'refunded';

  const canClaim = state === 'ln_paid' && Boolean(String(trade?.ln_preimage_hex || '').trim());
  const canRefund = state === 'escrow' && trade?.sol_refund_after_unix !== null && trade?.sol_refund_after_unix !== undefined;

  return (
    <div className={`rowitem ${selected ? 'selected' : ''} ${expired ? 'expired' : ''}`} role="button" onClick={onSelect}>
      <div className="rowitem-top">
        <span className="mono chip">{role || 'trade'}</span>
        <span className="mono chip hi">{state || '?'}</span>
        {expired ? <span className="mono chip warn">ended</span> : null}
        <span className="trade-activity-headline">
          <span className="mono">{btcDisplay}</span> BTC → <span className="mono">{usdtDisplay}</span> USDT
        </span>
      </div>
      <div className="rowitem-mid">
        {priceDisplay ? <span className="muted"><span className="mono">{priceDisplay}</span> USDT/BTC</span> : null}
        {btcUsd !== null ? <span className="muted">≈ {fmtUsd(btcUsd)}</span> : null}
      </div>
      <div className="rowitem-bot">
        <div className="row">
          <button
            className={`btn small ${canClaim ? 'primary' : ''}`}
            aria-disabled={!canClaim}
            title={canClaim ? 'Claim now' : 'Not claimable yet'}
            onClick={(e) => { e.stopPropagation(); onRecoverClaim(); }}
          >
            Claim
          </button>
          <button
            className={`btn small ${canRefund ? 'primary' : ''}`}
            aria-disabled={!canRefund}
            title={canRefund ? 'Refund now' : 'Not refundable yet'}
            onClick={(e) => { e.stopPropagation(); onRecoverRefund(); }}
          >
            Refund
          </button>
        </div>
      </div>
    </div>
  );
}

function previewMessage(msg: any) {
  if (msg === null || msg === undefined) return '';
  if (typeof msg === 'string') {
    const s = msg.replace(/\s+/g, ' ').trim();
    return s.length > 140 ? s.slice(0, 140) + '…' : s;
  }
  try {
    const s = JSON.stringify(msg);
    return s.length > 160 ? s.slice(0, 160) + '…' : s;
  } catch (_e) {
    return String(msg);
  }
}

function AnimatedLogo({ text, tagline }: { text: string; tagline: string }) {
  const [mode, setMode] = useState<'wave' | 'gradient' | 'sparkle' | 'typewriter'>('wave');
  const [waveIndex, setWaveIndex] = useState(0);
  const [sparkle, setSparkle] = useState<Set<number>>(new Set());

  const colors = useMemo(
    () => ['#22d3ee', '#84cc16', '#f97316', '#f43f5e', '#eab308'] as const,
    []
  );

  function randColor(exclude?: string) {
    const pool = exclude ? colors.filter((c) => c !== exclude) : colors;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  useEffect(() => {
    const interval = setInterval(() => {
      setMode((prev) => {
        const all = ['wave', 'gradient', 'sparkle', 'typewriter'] as const;
        const idx = all.indexOf(prev);
        return all[(idx + 1) % all.length];
      });
    }, 12000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (mode !== 'wave') return;
    const interval = setInterval(() => setWaveIndex((p) => (p + 1) % text.length), 90);
    return () => clearInterval(interval);
  }, [mode, text.length]);

  useEffect(() => {
    if (mode !== 'sparkle') return;
    const interval = setInterval(() => {
      const next = new Set<number>();
      const count = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < count; i++) next.add(Math.floor(Math.random() * text.length));
      setSparkle(next);
    }, 160);
    return () => clearInterval(interval);
  }, [mode, text.length]);

  const [typewriterIndex, setTypewriterIndex] = useState(0);
  const [typewriterColors, setTypewriterColors] = useState(() => text.split('').map(() => randColor()));
  const resetScheduled = useRef(false);
  useEffect(() => {
    if (mode !== 'typewriter') return;
    resetScheduled.current = false;
    const interval = setInterval(() => {
      setTypewriterIndex((prev) => {
        if (prev >= text.length) {
          if (!resetScheduled.current) {
            resetScheduled.current = true;
            setTimeout(() => {
              resetScheduled.current = false;
              setTypewriterColors(text.split('').map(() => randColor()));
              setTypewriterIndex(0);
            }, 900);
          }
          return prev;
        }
        return prev + 1;
      });
    }, 70);
    return () => clearInterval(interval);
  }, [mode, text]);

  const renderChar = (ch: string, idx: number) => {
    if (ch === ' ') return <span key={idx}>&nbsp;</span>;
    let style: React.CSSProperties = {};
    let className = 'logo-ch';

    if (mode === 'wave') {
      const dist = Math.abs(idx - waveIndex);
      const intensity = Math.max(0, 1 - dist * 0.18);
      const ci = (waveIndex + idx) % colors.length;
      const color = colors[ci];
      style = {
        color: intensity > 0.25 ? color : '#89b6c8',
        transform: intensity > 0.6 ? `translateY(${-2.5 * intensity}px)` : undefined,
        textShadow: intensity > 0.6 ? `0 0 ${10 * intensity}px ${color}` : undefined,
      };
      className += ' fast';
    } else if (mode === 'gradient') {
      style = { animationDelay: `${idx * 0.045}s` };
      className += ' gradient';
    } else if (mode === 'sparkle') {
      const isSparkle = sparkle.has(idx);
      const color = isSparkle ? randColor() : '#b2e3f3';
      style = {
        color,
        transform: isSparkle ? 'scale(1.08)' : undefined,
        textShadow: isSparkle ? `0 0 10px ${color}` : undefined,
      };
      className += ' med';
    } else if (mode === 'typewriter') {
      const isRevealed = idx < typewriterIndex;
      const color = typewriterColors[idx] || '#22d3ee';
      style = {
        color: isRevealed ? color : 'rgba(255,255,255,0.16)',
        textShadow: isRevealed ? `0 0 7px ${color}` : undefined,
      };
      className += ' med';
    }

    return (
      <span key={idx} className={className} style={style}>
        {ch}
      </span>
    );
  };

  return (
    <div className="logo-wrap">
      <div className="logo-text">{text.split('').map((c, i) => renderChar(c, i))}</div>
      <div className="logo-tag">{tagline}</div>
    </div>
  );
}

function VirtualList({
  items,
  render,
  estimatePx,
  itemKey,
  listRef,
  onScroll,
}: {
  items: any[];
  render: (item: any) => any;
  estimatePx: number;
  itemKey: (item: any) => string;
  listRef?: any;
  onScroll?: () => void;
}) {
  // Lightweight virtualization without extra deps beyond @tanstack/react-virtual.
  // We keep it local so each panel can set its own sizing and scroll container.
  const parentRef = useRef<HTMLDivElement | null>(null);
  const itemKeys = useMemo(() => {
    const out: string[] = new Array(items.length);
    const seen = new Map<string, number>();
    for (let i = 0; i < items.length; i += 1) {
      let base = '';
      try {
        base = String(itemKey(items[i]) || '').trim();
      } catch (_e) {
        base = '';
      }
      if (!base) base = `idx:${i}`;
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      out[i] = n === 1 ? base : `${base}#${n}`;
    }
    return out;
  }, [items, itemKey]);

  // Allow caller to receive the scroll element for “follow tail”.
  useEffect(() => {
    if (!listRef) return;
    listRef.current = parentRef.current;
  }, [listRef]);

  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => estimatePx,
    overscan: 8,
    getItemKey: (idx: number) => itemKeys[idx] || `idx:${idx}`,
  });

  // Re-measure all rows when container width changes (prevents overlap on resize).
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    let prevW = el.clientWidth;
    let prevH = el.clientHeight;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w !== prevW || h !== prevH) {
        prevW = w;
        prevH = h;
        rowVirtualizer.measure();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [rowVirtualizer]);

  // Recompute virtual row positions whenever the dataset shape changes.
  useEffect(() => {
    rowVirtualizer.measure();
  }, [rowVirtualizer, items.length, itemKeys[0], itemKeys[itemKeys.length - 1]]);

  const virtualItems = rowVirtualizer.getVirtualItems();
  const first = virtualItems[0];
  const last = virtualItems[virtualItems.length - 1];
  const padTop = first ? Math.max(0, first.start) : 0;
  const padBottom = last ? Math.max(0, rowVirtualizer.getTotalSize() - last.end) : 0;

  return (
    <div ref={parentRef} className="vlist" onScroll={onScroll}>
      <div className="vlist-inner">
        {padTop > 0 ? <div style={{ height: `${padTop}px` }} /> : null}
        {virtualItems.map((v: any) => {
          const item = items[v.index];
          return (
            <div
              key={v.key}
              data-index={v.index}
              // Dynamic row heights: measure actual DOM and let the virtualizer reflow.
              ref={rowVirtualizer.measureElement}
              className="vrow"
            >
              {render(item)}
            </div>
          );
        })}
        {padBottom > 0 ? <div style={{ height: `${padBottom}px` }} /> : null}
      </div>
    </div>
  );
}
