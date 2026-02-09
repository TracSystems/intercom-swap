import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import './app.css';
import { promptAdd, promptListBefore, promptListLatest, scAdd, scListBefore, scListLatest } from './lib/db';

function App() {
  const [activeTab, setActiveTab] = useState<
    'overview' | 'rendezvous' | 'rfqs' | 'invites' | 'swaps' | 'refunds' | 'wallets' | 'peers' | 'audit' | 'settings'
  >('overview');

  const [promptOpen, setPromptOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [navOpen, setNavOpen] = useState(true);

  const [health, setHealth] = useState<{ ok: boolean; ts: number } | null>(null);
  const [tools, setTools] = useState<Array<any> | null>(null);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [autoApprove, setAutoApprove] = useState(false);
  const [runMode, setRunMode] = useState<'tool' | 'llm'>('tool');

  const [scConnected, setScConnected] = useState(false);
  const [scStreamErr, setScStreamErr] = useState<string | null>(null);
  const [scFollowTail, setScFollowTail] = useState(true);
  const [scChannels, setScChannels] = useState<string>('0000intercomswapbtcusdt');
  const [scFilter, setScFilter] = useState<{ channel: string; kind: string }>({ channel: '', kind: '' });

  const [selected, setSelected] = useState<any>(null);

  const [promptInput, setPromptInput] = useState('');
  const [toolFilter, setToolFilter] = useState('');
  const [toolName, setToolName] = useState('');
  const [toolArgsText, setToolArgsText] = useState('{\n  \n}');
  const [toolInputMode, setToolInputMode] = useState<'form' | 'json'>('form');
  const [toolArgsObj, setToolArgsObj] = useState<Record<string, any>>({});
  const [toolArgsParseErr, setToolArgsParseErr] = useState<string | null>(null);

  const [promptEvents, setPromptEvents] = useState<any[]>([]);
  const [scEvents, setScEvents] = useState<any[]>([]);
  const scEventsMax = 3000;
  const promptEventsMax = 3000;

  const [runBusy, setRunBusy] = useState(false);
  const [runErr, setRunErr] = useState<string | null>(null);
  const [consoleEvents, setConsoleEvents] = useState<any[]>([]);
  const consoleEventsMax = 500;
  const consoleListRef = useRef<HTMLDivElement | null>(null);
  const [consoleFollowTail, setConsoleFollowTail] = useState(true);

  const [preflight, setPreflight] = useState<any>(null);
  const [preflightBusy, setPreflightBusy] = useState(false);
  const [envInfo, setEnvInfo] = useState<any>(null);
  const [envBusy, setEnvBusy] = useState(false);
  const [envErr, setEnvErr] = useState<string | null>(null);

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

  const [peerStatus, setPeerStatus] = useState<any>(null);
  const [peerStatusBusy, setPeerStatusBusy] = useState(false);
  const [rfqbotStatus, setRfqbotStatus] = useState<any>(null);
  const [rfqbotStatusBusy, setRfqbotStatusBusy] = useState(false);

  const scAbortRef = useRef<AbortController | null>(null);
  const promptAbortRef = useRef<AbortController | null>(null);

  const scListRef = useRef<HTMLDivElement | null>(null);
  const promptListRef = useRef<HTMLDivElement | null>(null);

  const scLoadingOlderRef = useRef(false);
  const promptLoadingOlderRef = useRef(false);

  const scFollowTailRef = useRef(scFollowTail);
  useEffect(() => {
    scFollowTailRef.current = scFollowTail;
  }, [scFollowTail]);

  const promptFollowTailRef = useRef(true);
  const [promptFollowTail, setPromptFollowTail] = useState(true);
  useEffect(() => {
    promptFollowTailRef.current = promptFollowTail;
  }, [promptFollowTail]);

  const filteredScEvents = useMemo(() => {
    const chan = scFilter.channel.trim();
    const kind = scFilter.kind.trim();
    return scEvents.filter((e) => {
      if (chan && String(e.channel || '') !== chan) return false;
      if (kind && String(e.kind || '') !== kind) return false;
      return true;
    });
  }, [scEvents, scFilter]);

  const rfqEvents = useMemo(() => {
    return filteredScEvents.filter((e) => String(e.kind || '') === 'swap.rfq');
  }, [filteredScEvents]);

  const inviteEvents = useMemo(() => {
    return filteredScEvents.filter((e) => String(e.kind || '') === 'swap.swap_invite');
  }, [filteredScEvents]);

  const knownChannels = useMemo(() => {
    const set = new Set<string>();
    for (const e of scEvents) {
      const c = String((e as any)?.channel || '').trim();
      if (c) set.add(c);
    }
    for (const c of scChannels.split(',').map((s) => s.trim()).filter(Boolean)) set.add(c);
    return Array.from(set).sort();
  }, [scEvents, scChannels]);

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
    const el = scListRef.current;
    const prevHeight = el ? el.scrollHeight : 0;
    const prevTop = el ? el.scrollTop : 0;
    try {
      const older = await scListBefore({ beforeId, limit });
      if (!older || older.length === 0) return;
      const mapped = older.map((r) => ({ ...(r.evt || {}), db_id: r.id }));
      setScEvents((prev) => {
        const seen = new Set(prev.map((e) => e?.db_id).filter((n) => typeof n === 'number'));
        const toAdd = mapped.filter((e) => typeof e?.db_id === 'number' && !seen.has(e.db_id));
        const next = toAdd.concat(prev);
        if (next.length <= scEventsMax) return next;
        // If we’re scrolling back, keep older window and drop the newest.
        return next.slice(0, scEventsMax);
      });
      requestAnimationFrame(() => {
        const el2 = scListRef.current;
        if (!el2) return;
        const delta = el2.scrollHeight - prevHeight;
        if (delta > 0) el2.scrollTop = prevTop + delta;
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
    const el = promptListRef.current;
    const prevHeight = el ? el.scrollHeight : 0;
    const prevTop = el ? el.scrollTop : 0;
    try {
      const older = await promptListBefore({ beforeId, limit });
      if (!older || older.length === 0) return;
      const mapped = older.map((r) => ({ ...(r.evt || {}), db_id: r.id }));
      setPromptEvents((prev) => {
        const seen = new Set(prev.map((e) => e?.db_id).filter((n) => typeof n === 'number'));
        const toAdd = mapped.filter((e) => typeof e?.db_id === 'number' && !seen.has(e.db_id));
        const next = toAdd.concat(prev);
        if (next.length <= promptEventsMax) return next;
        return next.slice(0, promptEventsMax);
      });
      requestAnimationFrame(() => {
        const el2 = promptListRef.current;
        if (!el2) return;
        const delta = el2.scrollHeight - prevHeight;
        if (delta > 0) el2.scrollTop = prevTop + delta;
      });
    } finally {
      promptLoadingOlderRef.current = false;
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

  const groupedTools = useMemo(() => {
    const list = tools || [];
    const q = toolFilter.trim().toLowerCase();
    const groups: Record<string, any[]> = {};
    for (const t of list) {
      const name = String((t as any)?.name || '');
      const desc = String((t as any)?.description || '');
      const g = toolGroup(name);
      if (q) {
        const hay = (name + ' ' + desc).toLowerCase();
        if (!hay.includes(q)) continue;
      }
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
  }, [tools, toolFilter]);

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

  function summarizeLn(listfunds: any) {
    try {
      if (!listfunds || typeof listfunds !== 'object') return { ok: false, channels: 0 };
      // CLN: { channels: [...] }
      if (Array.isArray((listfunds as any).channels)) {
        return { ok: true, channels: (listfunds as any).channels.length };
      }
      // LND wrapper: { channels: { channels: [...] } }
      const ch = (listfunds as any).channels;
      if (ch && typeof ch === 'object' && Array.isArray(ch.channels)) {
        return { ok: true, channels: ch.channels.length };
      }
      return { ok: true, channels: 0 };
    } catch (_e) {
      return { ok: false, channels: 0 };
    }
  }

  async function refreshPreflight() {
    setPreflightBusy(true);
    const out: any = { ts: Date.now() };
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
      out.ln_info = await runDirectToolOnce('intercomswap_ln_info', {}, { auto_approve: false });
    } catch (e: any) {
      out.ln_info_error = e?.message || String(e);
    }
    try {
      out.ln_listfunds = await runDirectToolOnce('intercomswap_ln_listfunds', {}, { auto_approve: false });
      out.ln_summary = summarizeLn(out.ln_listfunds);
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

    setPreflight(out);
    setPreflightBusy(false);
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

  async function refreshPeersAndBots() {
    setPeerStatusBusy(true);
    try {
      setPeerStatus(await runDirectToolOnce('intercomswap_peer_status', {}, { auto_approve: false }));
    } catch (e: any) {
      setPeerStatus({ type: 'error', error: e?.message || String(e) });
    } finally {
      setPeerStatusBusy(false);
    }

    setRfqbotStatusBusy(true);
    try {
      setRfqbotStatus(await runDirectToolOnce('intercomswap_rfqbot_status', {}, { auto_approve: false }));
    } catch (e: any) {
      setRfqbotStatus({ type: 'error', error: e?.message || String(e) });
    } finally {
      setRfqbotStatusBusy(false);
    }
  }

  async function loadTradesPage({ reset = false } = {}) {
    if (tradesLoading) return;
    setTradesLoading(true);
    try {
      const offset = reset ? 0 : tradesOffset;
      const page = await runDirectToolOnce('intercomswap_receipts_list', { limit: tradesLimit, offset }, { auto_approve: false });
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
        { limit: openRefundsLimit, offset },
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
        { limit: openClaimsLimit, offset },
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
    setPromptEvents((prev) => {
      const next = prev.concat([{ ...normalized, db_id: dbId }]);
      if (next.length <= promptEventsMax) return next;
      return next.slice(next.length - promptEventsMax);
    });
  }

  async function appendScEvent(evt: any, { persist = true } = {}) {
    const e = evt && typeof evt === 'object' ? evt : { type: 'event', evt };
    const msgTs = e?.message && typeof e.message.ts === 'number' ? e.message.ts : null;
    const ts = typeof e.ts === 'number' ? e.ts : msgTs !== null ? msgTs : Date.now();
    const normalized = { ...e, ts };
    const channel = String(e.channel || '');
    const kind = String(e.kind || '');
    const trade_id = String(e.trade_id || '');
    const seq = typeof e.seq === 'number' ? e.seq : null;
    let dbId: number | null = null;
    if (persist && normalized.type === 'sc_event') {
      try {
        dbId = await scAdd({ ts, channel, kind, trade_id, seq, evt: normalized });
      } catch (_e) {}
    }
    setScEvents((prev) => {
      const next = prev.concat([{ ...normalized, db_id: dbId }]);
      if (next.length <= scEventsMax) return next;
      return next.slice(next.length - scEventsMax);
    });
  }

  function deriveKindTrade(msg: any) {
    if (!msg || typeof msg !== 'object') return { kind: '', trade_id: '' };
    const kind = typeof msg.kind === 'string' ? msg.kind : '';
    const trade_id = typeof msg.trade_id === 'string' ? msg.trade_id : '';
    return { kind, trade_id };
  }

	async function startScStream() {
		if (scAbortRef.current) scAbortRef.current.abort();
		const ac = new AbortController();
		scAbortRef.current = ac;
		let sawOpen = false;
		let hadError = false;

		const channels = scChannels
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean)
      .slice(0, 50);
    const url = new URL('/v1/sc/stream', window.location.origin);
    if (channels.length > 0) url.searchParams.set('channels', channels.join(','));
    url.searchParams.set('backlog', '250');

    setScConnected(true);
    setScStreamErr(null);
    await appendScEvent({ type: 'ui', ts: Date.now(), message: `sc/stream connecting (${channels.length || 'all'})...` }, { persist: false });

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
						await appendScEvent({ type: 'parse_error', ts: Date.now(), line }, { persist: false });
						continue;
					}
						if (obj.type === 'sc_stream_open') sawOpen = true;
            // Heartbeats are transport-level keepalives; don’t pollute the operator log.
            if (obj.type === 'heartbeat') continue;
						if (obj.type === 'sc_event') {
							const msg = obj.message;
							const d = deriveKindTrade(msg);
							await appendScEvent({ ...obj, ...d }, { persist: true });
					} else if (obj.type === 'error') {
						const errMsg = String(obj?.error || 'sc/stream error');
						hadError = true;
						setScStreamErr(errMsg);
						await appendScEvent(obj, { persist: false });
					} else {
						await appendScEvent(obj, { persist: false });
					}
				}
			}
		} catch (err: any) {
			hadError = true;
			const msg = err?.message || String(err);
			setScStreamErr(msg);
			await appendScEvent({ type: 'error', ts: Date.now(), error: msg }, { persist: false });
		} finally {
			// If the stream ends without an explicit error (eg, peer not running / SC-Bridge unreachable),
			// surface that as a visible error so operators aren’t left guessing.
			if (!ac.signal.aborted && !hadError && !sawOpen) {
				const msg = 'sc/stream ended before open (peer/SC-Bridge not ready?)';
				setScStreamErr(msg);
				await appendScEvent({ type: 'error', ts: Date.now(), error: msg }, { persist: false });
			}
			setScConnected(false);
		}
	}

  function stopScStream() {
    if (scAbortRef.current) scAbortRef.current.abort();
    scAbortRef.current = null;
    setScConnected(false);
    void appendScEvent({ type: 'ui', ts: Date.now(), message: 'sc/stream stopped' }, { persist: false });
  }

  async function runPromptStream(payload: any) {
    if (promptAbortRef.current) promptAbortRef.current.abort();
    const ac = new AbortController();
    promptAbortRef.current = ac;

    setRunBusy(true);
    setRunErr(null);
    setConsoleEvents([]);

    await appendPromptEvent({ type: 'ui', ts: Date.now(), message: 'run starting...' }, { persist: false });

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
          if (obj.type === 'run_start' && obj.session_id) setSessionId(String(obj.session_id));
          if (obj.type === 'error') setRunErr(String(obj.error || 'error'));
          if (obj.type === 'tool' && obj.result && typeof obj.result === 'object' && obj.result.type === 'error') {
            const msg = String(obj?.result?.error || `${obj?.name || 'tool'} failed`);
            setRunErr(msg);
          }
          if (obj.type === 'done') setRunBusy(false);
          setConsoleEvents((prev) => {
            const next = prev.concat([obj]);
            if (next.length <= consoleEventsMax) return next;
            return next.slice(next.length - consoleEventsMax);
          });
          await appendPromptEvent(obj, { persist: true });
        }
      }
    } catch (err: any) {
      const msg = err?.message || String(err);
      setRunErr(msg);
      setConsoleEvents((prev) => {
        const next = prev.concat([{ type: 'error', ts: Date.now(), error: msg }]);
        if (next.length <= consoleEventsMax) return next;
        return next.slice(next.length - consoleEventsMax);
      });
      await appendPromptEvent({ type: 'error', ts: Date.now(), error: msg }, { persist: false });
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
    const t = setInterval(refreshHealth, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Lazy load tab-specific data.
  useEffect(() => {
    if (activeTab === 'swaps' && trades.length === 0) void loadTradesPage({ reset: true });
    if (activeTab === 'refunds' && (openRefunds.length === 0 || openClaims.length === 0)) {
      if (openRefunds.length === 0) void loadOpenRefundsPage({ reset: true });
      if (openClaims.length === 0) void loadOpenClaimsPage({ reset: true });
    }
    if (activeTab === 'peers' && (!peerStatus || !rfqbotStatus)) void refreshPeersAndBots();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // Load recent history from local IndexedDB (memory-safe; DOM is virtualized).
  useEffect(() => {
    (async () => {
      try {
        const sc = await scListLatest({ limit: 400 });
        setScEvents(sc.map((r) => ({ ...(r.evt || {}), db_id: r.id })));
      } catch (_e) {}
      try {
        const pe = await promptListLatest({ limit: 300 });
        setPromptEvents(pe.map((r) => ({ ...(r.evt || {}), db_id: r.id })));
      } catch (_e) {}
    })();
  }, []);

  useEffect(() => {
    if (!scFollowTail) return;
    const el = scListRef.current;
    if (!el) return;
    // Scroll to bottom when new events append. Use rAF so virtualization has laid out.
    requestAnimationFrame(() => {
      try {
        el.scrollTop = el.scrollHeight;
      } catch (_e) {}
    });
  }, [scEvents, scFollowTail]);

  useEffect(() => {
    if (!promptFollowTail) return;
    const el = promptListRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      try {
        el.scrollTop = el.scrollHeight;
      } catch (_e) {}
    });
  }, [promptEvents, promptFollowTail]);

  useEffect(() => {
    if (!consoleFollowTail) return;
    const el = consoleListRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      try {
        el.scrollTop = el.scrollHeight;
      } catch (_e) {}
    });
  }, [consoleEvents, consoleFollowTail]);

  const onScScroll = () => {
    const cur = scListRef.current;
    if (!cur) return;
    const atBottom = cur.scrollHeight - cur.scrollTop - cur.clientHeight < 120;
    if (!atBottom && scFollowTailRef.current) setScFollowTail(false);
    if (cur.scrollTop < 140) void loadOlderScEvents({ limit: 250 });
  };

  const onPromptScroll = () => {
    const cur = promptListRef.current;
    if (!cur) return;
    const atBottom = cur.scrollHeight - cur.scrollTop - cur.clientHeight < 120;
    if (!atBottom && promptFollowTailRef.current) setPromptFollowTail(false);
    if (cur.scrollTop < 140) void loadOlderPromptEvents({ limit: 250 });
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

  return (
    <div
      className={`shell ${promptOpen ? 'prompt-open' : 'prompt-closed'} ${navOpen ? 'nav-open' : 'nav-closed'} ${
        inspectorOpen ? 'inspector-open' : 'inspector-closed'
      }`}
    >
      <header className="topbar">
        <div className="topbar-left">
          <button className="iconbtn" onClick={() => setNavOpen((v) => !v)} aria-label="Toggle navigation">
            ☰
          </button>
          <div className="logo">
            <AnimatedLogo text="Collin" tagline="control center" />
          </div>
        </div>
        <div className="topbar-mid">
          <div className="statusline">
            <StatusPill
              label="env"
              state={
                envInfo?.env_kind === 'test'
                  ? 'ok'
                  : envInfo?.env_kind === 'mainnet'
                    ? 'bad'
                    : envInfo?.env_kind === 'mixed'
                      ? 'neutral'
                      : 'idle'
              }
              value={
                envInfo?.env_kind
                  ? String(envInfo.env_kind).toUpperCase()
                  : envErr
                    ? 'ERR'
                    : 'UNKNOWN'
              }
            />
            <StatusPill label="promptd" state={health?.ok ? 'ok' : 'bad'} />
            <StatusPill label="sc/stream" state={scConnected ? 'ok' : scStreamErr ? 'bad' : 'idle'} value={scStreamErr ? 'ERR' : ''} />
            <StatusPill label="run" state={runBusy ? 'neutral' : runErr ? 'bad' : 'idle'} value={runBusy ? 'RUNNING' : runErr ? 'ERR' : ''} />
            <StatusPill label="mode" state="neutral" value={runMode.toUpperCase()} />
            <span className="muted small">{health ? new Date(health.ts).toLocaleTimeString() : '...'}</span>
          </div>
          <div className="quick">
            <button className="btn" onClick={refreshTools}>
              Reload tools
            </button>
            <button className="btn" onClick={() => setInspectorOpen((v) => !v)}>
              {inspectorOpen ? 'Hide' : 'Show'} inspector
            </button>
          </div>
        </div>
        <div className="topbar-right">
          <button className="btn primary" onClick={() => setPromptOpen((v) => !v)}>
            {promptOpen ? 'Collapse' : 'Open'} console
          </button>
        </div>
      </header>

      {navOpen ? (
        <aside className="nav">
          <nav className="nav-inner">
            <NavButton active={activeTab === 'overview'} onClick={() => setActiveTab('overview')} label="Overview" />
            <NavButton
              active={activeTab === 'rendezvous'}
              onClick={() => setActiveTab('rendezvous')}
              label="Rendezvous"
            />
            <NavButton active={activeTab === 'rfqs'} onClick={() => setActiveTab('rfqs')} label="RFQs" badge={rfqEvents.length} />
            <NavButton
              active={activeTab === 'invites'}
              onClick={() => setActiveTab('invites')}
              label="Invites"
              badge={inviteEvents.length}
            />
            <NavButton active={activeTab === 'swaps'} onClick={() => setActiveTab('swaps')} label="Swaps" />
            <NavButton active={activeTab === 'refunds'} onClick={() => setActiveTab('refunds')} label="Refunds" />
            <NavButton active={activeTab === 'wallets'} onClick={() => setActiveTab('wallets')} label="Wallets" />
            <NavButton active={activeTab === 'peers'} onClick={() => setActiveTab('peers')} label="Peers" />
            <NavButton active={activeTab === 'audit'} onClick={() => setActiveTab('audit')} label="Audit" />
            <NavButton active={activeTab === 'settings'} onClick={() => setActiveTab('settings')} label="Settings" />
          </nav>
        </aside>
      ) : null}

      <main className="main">
        {activeTab === 'overview' ? (
          <div className="grid2">
					<Panel title="Getting Started">
						<p className="muted">
							Linear checklist for posting RFQs and running swaps. Use the buttons to prepare tool calls (and run them
							from the console).
						</p>
						<div className="alert warn">
							Intercomswap assumes the <b>full stack</b> is running: peer+SC-Bridge, Lightning, Solana, and receipts.
							Post RFQs only when you are ready to settle.
						</div>
					<div className="row">
						<button className="btn primary" onClick={refreshPreflight} disabled={preflightBusy}>
							{preflightBusy ? 'Checking…' : 'Refresh checklist'}
						</button>
                {preflight?.ts ? <span className="muted small">last: {new Date(preflight.ts).toLocaleTimeString()}</span> : null}
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
                <div className="muted small">
                  Tip: keep test and mainnet as separate instances (different promptd ports + different receipts DB paths).
                </div>
                {envErr ? <div className="alert bad">{String(envErr)}</div> : null}
                <div className="row">
                  <button className="btn" onClick={refreshEnv} disabled={envBusy}>
                    {envBusy ? 'Refreshing…' : 'Refresh env'}
                  </button>
                </div>
              </div>

						<div className="field">
							<div className="field-hd">
								<span className="mono">1) Peer + SC-Bridge</span>
                  {preflight?.peer_status?.peers?.some?.((p: any) => p?.alive) ? (
                    <span className="chip hi">running</span>
                  ) : (
                    <span className="chip">not running</span>
                  )}
                </div>
                <div className="muted small">
                  Collin’s live stream needs a peer with SC-Bridge enabled (default port <span className="mono">49222</span>).
                </div>
                {preflight?.peer_status_error ? <div className="alert bad">{String(preflight.peer_status_error)}</div> : null}
                <div className="row">
                  <button
                    className="btn"
                    onClick={() => {
                      setToolInputMode('form');
                      setToolArgsParseErr(null);
                      setRunMode('tool');
                      setToolName('intercomswap_peer_start');
                      setToolArgsBoth({
                        name: 'swap-maker-peer',
                        store: 'swap-maker',
                        sc_port: 49222,
                        sidechannels: scChannels.split(',').map((s) => s.trim()).filter(Boolean),
                        pow_enabled: true,
                        pow_difficulty: 12,
                        invite_required: true,
                        welcome_required: false,
                        invite_prefixes: ['swap:'],
                      });
                      setPromptOpen(true);
                    }}
                  >
                    Prepare peer_start (swap-maker)
                  </button>
                  <button
                    className="btn primary"
                    disabled={runBusy}
                    onClick={async () => {
                      const args = {
                        name: 'swap-maker-peer',
                        store: 'swap-maker',
                        sc_port: 49222,
                        sidechannels: scChannels.split(',').map((s) => s.trim()).filter(Boolean),
                        pow_enabled: true,
                        pow_difficulty: 12,
                        invite_required: true,
                        welcome_required: false,
                        invite_prefixes: ['swap:'],
                      };
                      setToolInputMode('form');
                      setToolArgsParseErr(null);
                      setRunMode('tool');
                      setToolName('intercomswap_peer_start');
                      setToolArgsBoth(args);
                      setPromptOpen(true);
                      const ok =
                        autoApprove ||
                        window.confirm(
                          `Start swap-maker peer now?\n\nThis will spawn a detached pear process using store "swap-maker" and SC-Bridge port 49222.`
                        );
                      if (!ok) return;
                      await runPromptStream({
                        prompt: JSON.stringify({ type: 'tool', name: 'intercomswap_peer_start', arguments: args }),
                        session_id: sessionId,
                        auto_approve: true,
                        dry_run: false,
                      });
                    }}
                  >
                    Start peer now
                  </button>
                  <button
                    className="btn"
                    onClick={() => {
                      setRunMode('tool');
                      setToolName('intercomswap_peer_status');
                      setToolArgsBoth({});
                      setPromptOpen(true);
                    }}
                  >
                    peer_status
                  </button>
                </div>
						</div>

						<div className="field">
							<div className="field-hd">
								<span className="mono">2) Sidechannel stream (recommended)</span>
								{scConnected ? <span className="chip hi">connected</span> : <span className="chip">disconnected</span>}
							</div>
							{scStreamErr ? <div className="alert bad">{String(scStreamErr)}</div> : null}
							{preflight?.sc_info_error ? <div className="alert bad">{String(preflight.sc_info_error)}</div> : null}
							<div className="row">
								{!scConnected ? (
									<button className="btn primary" onClick={startScStream}>
										Connect sc/stream
                    </button>
                  ) : (
                    <button className="btn" onClick={stopScStream}>
                      Stop sc/stream
                    </button>
                  )}
                  <button
                    className="btn"
                    onClick={() => {
                      const chans = scChannels.split(',').map((s) => s.trim()).filter(Boolean);
                      if (chans.length === 0) return;
                      setRunMode('tool');
                      setToolName('intercomswap_sc_subscribe');
                      setToolArgsBoth({ channels: chans });
                      setPromptOpen(true);
                    }}
                  >
                    Prepare subscribe
                  </button>
                </div>
						</div>

						<div className="field">
							<div className="field-hd">
								<span className="mono">3) Post an RFQ (request)</span>
								<span className="chip">tool: rfq_post</span>
							</div>
							<div className="muted small">
								This posts a <b>signed</b> RFQ envelope into the rendezvous channel.
							</div>
							<div className="row">
								<button
									className="btn"
									onClick={() => {
										const chans = scChannels.split(',').map((s) => s.trim()).filter(Boolean);
										const rendezvous = chans[0] || '0000intercomswapbtcusdt';
										const now = Date.now();
										setToolInputMode('form');
										setToolArgsParseErr(null);
										setRunMode('tool');
										setToolName('intercomswap_rfq_post');
										setToolArgsBoth({
											channel: rendezvous,
											trade_id: `rfq-${now}`,
											btc_sats: 10_000,
											usdt_amount: '1000000',
											max_platform_fee_bps: 50,
											max_trade_fee_bps: 50,
											max_total_fee_bps: 100,
											min_sol_refund_window_sec: 72 * 3600,
											max_sol_refund_window_sec: 7 * 24 * 3600,
											valid_until_unix: Math.floor(now / 1000) + 10 * 60,
										});
										setPromptOpen(true);
									}}
								>
									Prepare rfq_post
								</button>
								<button
									className="btn primary"
									disabled={runBusy}
									onClick={async () => {
										const chans = scChannels.split(',').map((s) => s.trim()).filter(Boolean);
										const rendezvous = chans[0] || '0000intercomswapbtcusdt';
										const now = Date.now();
										const args = {
											channel: rendezvous,
											trade_id: `rfq-${now}`,
											btc_sats: 10_000,
											usdt_amount: '1000000',
											max_platform_fee_bps: 50,
											max_trade_fee_bps: 50,
											max_total_fee_bps: 100,
											min_sol_refund_window_sec: 72 * 3600,
											max_sol_refund_window_sec: 7 * 24 * 3600,
											valid_until_unix: Math.floor(now / 1000) + 10 * 60,
										};
										setToolInputMode('form');
										setToolArgsParseErr(null);
										setRunMode('tool');
										setToolName('intercomswap_rfq_post');
										setToolArgsBoth(args);
										setPromptOpen(true);
										const ok =
											autoApprove ||
											window.confirm(
												`Post RFQ now?\n\nChannel: ${rendezvous}\nBTC: 0.00010000 (10,000 sats)\nUSDT: 1.0\nMax fees: 0.5% platform + 0.5% trade (1.0% total)`
										);
										if (!ok) return;
										await runPromptStream({
											prompt: JSON.stringify({ type: 'tool', name: 'intercomswap_rfq_post', arguments: args }),
											session_id: sessionId,
											auto_approve: true,
											dry_run: false,
										});
									}}
								>
									Post RFQ now
								</button>
							</div>
						</div>

						<div className="field">
							<div className="field-hd">
								<span className="mono">4) Lightning readiness (settlement)</span>
								{preflight?.ln_summary?.channels > 0 ? (
									<span className="chip hi">{preflight.ln_summary.channels} channel(s)</span>
								) : (
									<span className="chip">no channels</span>
								)}
	                </div>
		                <div className="muted small">
		                  Swaps can route over the LN network, but you still need an LN node with funds and typically at least one channel for paying invoices.
		                </div>
		                {preflight?.ln_listfunds_error ? <div className="alert bad">{String(preflight.ln_listfunds_error)}</div> : null}
		                {String(envInfo?.ln?.backend || '') === 'docker' ? (
		                  <>
		                    {preflight?.ln_docker_ps_error ? (
		                      <div className="alert bad">docker: {String(preflight.ln_docker_ps_error)}</div>
		                    ) : null}
		                    {Array.isArray(preflight?.ln_docker_ps?.services) ? (
		                      <div className="muted small">
		                        docker:{' '}
		                        {preflight.ln_docker_ps.services.length === 0
		                          ? 'down'
		                          : preflight.ln_docker_ps.services
		                              .map((s: any) => `${String(s?.service || 'svc')}:${String(s?.state || 'unknown')}`)
		                              .join(' · ')}
		                      </div>
		                    ) : null}
		                  </>
		                ) : null}
		                <div className="row">
		                  {String(envInfo?.ln?.backend || '') === 'docker' ? (
		                    <>
		                      <button
	                        className="btn primary"
	                        disabled={runBusy}
	                        onClick={async () => {
	                          const args = {};
	                          setToolInputMode('form');
	                          setToolArgsParseErr(null);
	                          setRunMode('tool');
	                          setToolName('intercomswap_ln_docker_up');
	                          setToolArgsBoth(args);
	                          setPromptOpen(true);
	                          const ok =
	                            autoApprove ||
	                            window.confirm(
	                              'Start LN docker services now?\n\nThis runs: docker compose up -d (for the compose file configured in onchain/prompt/setup.json).'
	                            );
	                          if (!ok) return;
	                          await runPromptStream({
	                            prompt: JSON.stringify({ type: 'tool', name: 'intercomswap_ln_docker_up', arguments: args }),
	                            session_id: sessionId,
	                            auto_approve: true,
	                            dry_run: false,
	                          });
	                        }}
	                      >
	                        Start LN (docker)
	                      </button>
	                      <button
	                        className="btn"
	                        onClick={() => {
	                          setRunMode('tool');
	                          setToolName('intercomswap_ln_docker_ps');
	                          setToolArgsBoth({});
	                          setPromptOpen(true);
	                        }}
	                      >
	                        ln_docker_ps
	                      </button>
	                    </>
	                  ) : null}
	                  <button
	                    className="btn"
	                    onClick={() => {
	                      setRunMode('tool');
	                      setToolName('intercomswap_ln_listfunds');
                      setToolArgsBoth({});
                      setPromptOpen(true);
                    }}
                  >
                    ln_listfunds
                  </button>
                </div>
						</div>

							<div className="field">
								<div className="field-hd">
									<span className="mono">5) Solana readiness (settlement)</span>
									<div className="row">
										{String(envInfo?.solana?.classify?.kind || '') === 'local' ? (
											preflight?.sol_local_status?.rpc_listening ? (
												<span className="chip hi">rpc up</span>
											) : (
												<span className="chip warn">rpc down</span>
											)
										) : null}
										{preflight?.sol_signer?.pubkey ? <span className="chip hi">signer ok</span> : <span className="chip">signer?</span>}
									</div>
								</div>
								{String(envInfo?.solana?.classify?.kind || '') === 'local' ? (
									<>
										{preflight?.sol_local_status_error ? (
											<div className="alert bad">{String(preflight.sol_local_status_error)}</div>
										) : null}
										{preflight?.sol_local_status ? (
											<div className="muted small">
												local validator:{' '}
												{preflight.sol_local_status.rpc_listening ? 'listening' : 'down'}
												{preflight.sol_local_status.pid ? ` · pid ${preflight.sol_local_status.pid}` : ''}
											</div>
										) : null}
										<div className="row">
											{!preflight?.sol_local_status?.rpc_listening ? (
												<button
													className="btn primary"
													disabled={runBusy}
													onClick={async () => {
														const args = {};
														setToolInputMode('form');
														setToolArgsParseErr(null);
														setRunMode('tool');
														setToolName('intercomswap_sol_local_start');
														setToolArgsBoth(args);
														setPromptOpen(true);
														const ok =
															autoApprove ||
															window.confirm(
																'Start local Solana validator now?\n\nThis starts solana-test-validator on localhost and loads the escrow program. Ledger + logs are stored under onchain/ (gitignored).'
															);
														if (!ok) return;
														await runPromptStream({
															prompt: JSON.stringify({ type: 'tool', name: 'intercomswap_sol_local_start', arguments: args }),
															session_id: sessionId,
															auto_approve: true,
															dry_run: false,
														});
													}}
												>
													Start Solana (local)
												</button>
											) : (
												<button
													className="btn"
													disabled={runBusy}
													onClick={async () => {
														const args = {};
														setToolInputMode('form');
														setToolArgsParseErr(null);
														setRunMode('tool');
														setToolName('intercomswap_sol_local_stop');
														setToolArgsBoth(args);
														setPromptOpen(true);
														const ok =
															autoApprove ||
															window.confirm(
																'Stop local Solana validator now?\n\nThis stops the managed solana-test-validator process. Ledger data is kept under onchain/.'
															);
														if (!ok) return;
														await runPromptStream({
															prompt: JSON.stringify({ type: 'tool', name: 'intercomswap_sol_local_stop', arguments: args }),
															session_id: sessionId,
															auto_approve: true,
															dry_run: false,
														});
													}}
												>
													Stop Solana (local)
												</button>
											)}
											<button
												className="btn"
												onClick={() => {
													setRunMode('tool');
													setToolName('intercomswap_sol_local_status');
													setToolArgsBoth({});
													setPromptOpen(true);
												}}
											>
												sol_local_status
											</button>
										</div>
									</>
								) : (
									<div className="muted small">Solana RPC is remote; local validator controls are disabled.</div>
								)}
	                {preflight?.sol_signer_error ? <div className="alert bad">{String(preflight.sol_signer_error)}</div> : null}
	                {preflight?.sol_config_error ? <div className="alert bad">{String(preflight.sol_config_error)}</div> : null}
	                <div className="row">
	                  <button
	                    className="btn"
                    onClick={() => {
                      setRunMode('tool');
                      setToolName('intercomswap_sol_signer_pubkey');
                      setToolArgsBoth({});
                      setPromptOpen(true);
                    }}
                  >
                    sol_signer_pubkey
                  </button>
                  <button
                    className="btn"
                    onClick={() => {
                      setRunMode('tool');
                      setToolName('intercomswap_sol_config_get');
                      setToolArgsBoth({});
                      setPromptOpen(true);
                    }}
                  >
                    sol_config_get
                  </button>
                </div>
              </div>

              <div className="field">
                <div className="field-hd">
                  <span className="mono">App binding</span>
                  {preflight?.app?.app_hash ? <span className="chip hi">bound</span> : <span className="chip">unknown</span>}
                </div>
                <div className="muted small">
                  RFQs/quotes include an <span className="mono">app_hash</span> so forks using different programs/tickers don’t mix in the same channels.
                </div>
                {preflight?.app_error ? <div className="alert bad">{String(preflight.app_error)}</div> : null}
                {preflight?.app?.app_hash ? (
                  <div className="muted small">
                    app_hash: <span className="mono">{String(preflight.app.app_hash).slice(0, 32)}…</span>
                  </div>
                ) : null}
              </div>
            </Panel>

            <Panel title="Live Stream (virtualized)">
              <div className="row">
                <input
                  className="input"
                  value={scChannels}
                  onChange={(e) => setScChannels(e.target.value)}
                  placeholder="channels (csv)"
                />
                {!scConnected ? (
                  <button className="btn primary" onClick={startScStream}>
                    Connect
                  </button>
                ) : (
                  <button className="btn" onClick={stopScStream}>
                    Stop
                  </button>
                )}
              </div>
              {scStreamErr ? <div className="alert bad">sc/stream: {scStreamErr}</div> : null}
              <div className="row">
                <label className="check">
                  <input type="checkbox" checked={scFollowTail} onChange={(e) => setScFollowTail(e.target.checked)} />
                  follow tail
                </label>
                <input
                  className="input"
                  value={scFilter.channel}
                  onChange={(e) => setScFilter((p) => ({ ...p, channel: e.target.value }))}
                  placeholder="filter channel"
                />
                <input
                  className="input"
                  value={scFilter.kind}
                  onChange={(e) => setScFilter((p) => ({ ...p, kind: e.target.value }))}
                  placeholder="filter kind"
                />
              </div>
              <VirtualList
                listRef={scListRef}
                items={filteredScEvents}
                itemKey={(e) => String(e.db_id || e.seq || e.id || e.ts || Math.random())}
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
          </div>
        ) : null}

        {activeTab === 'rendezvous' ? (
          <div className="grid2">
            <Panel title="Join / Subscribe">
              <p className="muted">
                This UI uses Intercom’s invite system as-is. Joining rendezvous channels is public; swap channels can be
                invite-only.
              </p>
              <div className="row">
                <input
                  className="input"
                  value={scChannels}
                  onChange={(e) => setScChannels(e.target.value)}
                  placeholder="rendezvous channels (csv)"
                />
                {!scConnected ? (
                  <button className="btn primary" onClick={startScStream}>
                    Connect stream
                  </button>
                ) : (
                  <button className="btn" onClick={stopScStream}>
                    Stop stream
                  </button>
                )}
              </div>
              {scStreamErr ? <div className="alert bad">sc/stream: {scStreamErr}</div> : null}
              <div className="row">
                <button
                  className="btn"
                  onClick={() => {
                    const chans = scChannels
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean);
                    if (chans.length === 0) return;
                    setRunMode('tool');
                    setToolName('intercomswap_sc_subscribe');
                    setToolArgsBoth({ channels: chans });
                    setPromptOpen(true);
                  }}
                >
                  Prepare subscribe tool-call
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    const first = scChannels
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean)[0];
                    if (!first) return;
                    setRunMode('tool');
                    setToolName('intercomswap_sc_join');
                    setToolArgsBoth({ channel: first });
                    setPromptOpen(true);
                  }}
                >
                  Prepare join tool-call
                </button>
              </div>
            </Panel>
            <Panel title="Recent Messages">
              <VirtualList
                listRef={scListRef}
                items={filteredScEvents}
                itemKey={(e) => String(e.db_id || e.seq || e.id || e.ts || Math.random())}
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
          </div>
        ) : null}

        {activeTab === 'rfqs' ? (
          <div className="grid2">
            <Panel title="RFQ Inbox">
              <p className="muted">
                RFQ = Request For Quote. All actions below are structured tool-calls (safe by default).
              </p>
              <VirtualList
                items={rfqEvents}
                itemKey={(e) => String(e.db_id || e.seq || e.ts || Math.random())}
                estimatePx={88}
                render={(e) => (
                  <RfqRow
                    evt={e}
                    onSelect={() => setSelected({ type: 'rfq', evt: e })}
                    onQuote={() => {
                      setRunMode('tool');
                      setToolName('intercomswap_quote_post_from_rfq');
                      setToolArgsBoth({
                        channel: e.channel,
                        rfq_envelope: e.message,
                        // Defaults (editable): 0.5% + 0.5% and 72h Solana refund window.
                        platform_fee_bps: 50,
                        trade_fee_bps: 50,
                        trade_fee_collector: String(preflight?.sol_signer?.pubkey || '...'),
                        sol_refund_window_sec: 72 * 3600,
                        valid_for_sec: 60,
                      });
                      setPromptOpen(true);
                    }}
                  />
                )}
              />
            </Panel>
            <Panel title="Prompt Console Shortcuts">
              <button
                className="btn primary"
                onClick={() => {
                  setRunMode('tool');
                  setToolName('intercomswap_rfq_post');
                  setToolArgsBoth({
                    channel: scChannels.split(',')[0]?.trim() || '0000intercomswapbtcusdt',
                    trade_id: `rfq-${Date.now()}`,
                    btc_sats: 10000,
                    usdt_amount: '1000000',
                    // Defaults (editable): accept up to protocol caps; prefer a long Solana refund window.
                    max_platform_fee_bps: 500,
                    max_trade_fee_bps: 1000,
                    max_total_fee_bps: 1500,
                    min_sol_refund_window_sec: 72 * 3600,
                    max_sol_refund_window_sec: 7 * 24 * 3600,
                    valid_until_unix: Math.floor(Date.now() / 1000) + 600,
                  });
                  setPromptOpen(true);
                }}
              >
                New RFQ tool-call
              </button>
              <p className="muted small">
                Note: avoid free-form “have/want” text in prompts. Use the structured RFQ/QUOTE tools.
              </p>
            </Panel>
          </div>
        ) : null}

        {activeTab === 'invites' ? (
          <div className="grid2">
            <Panel title="Swap Invites">
              <VirtualList
                items={inviteEvents}
                itemKey={(e) => String(e.db_id || e.seq || e.ts || Math.random())}
                estimatePx={92}
                render={(e) => (
                  <InviteRow
                    evt={e}
                    onSelect={() => setSelected({ type: 'invite', evt: e })}
                    onJoin={() => {
                      setRunMode('tool');
                      setToolName('intercomswap_join_from_swap_invite');
                      setToolArgsBoth({ swap_invite_envelope: e.message });
                      setPromptOpen(true);
                    }}
                  />
                )}
              />
            </Panel>
            <Panel title="Channel Hygiene">
              <button
                className="btn"
                onClick={() => {
                  setRunMode('tool');
                  setToolName('intercomswap_sc_leave');
                  setToolArgsBoth({ channel: 'swap:...' });
                  setPromptOpen(true);
                }}
              >
                Prepare leave tool-call
              </button>
              <p className="muted small">Leave channels after trade completion/timeout to keep memory bounded.</p>
            </Panel>
          </div>
        ) : null}

        {activeTab === 'swaps' ? (
          <div className="grid2">
            <Panel title="Trade Receipts (local, paginated)">
              <p className="muted">
                This view is powered by the local receipts DB configured in <span className="mono">onchain/prompt/setup.json</span>.
              </p>
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
                <button
                  className="btn"
                  onClick={() => {
                    setRunMode('tool');
                    setToolName('intercomswap_receipts_list');
                    setToolArgsBoth({ limit: tradesLimit, offset: 0 });
                    setPromptOpen(true);
                  }}
                >
                  Prepare receipts_list tool-call
                </button>
                {!tradesHasMore ? <span className="muted small">end</span> : null}
              </div>

              <VirtualList
                listRef={tradesListRef}
                items={trades}
                itemKey={(t) => String(t?.trade_id || t?.updated_at || Math.random())}
                estimatePx={92}
                onScroll={onTradesScroll}
                render={(t) => (
                  <TradeRow
                    trade={t}
                    selected={selected?.type === 'trade' && selected?.trade?.trade_id === t?.trade_id}
                    onSelect={() => setSelected({ type: 'trade', trade: t })}
                    onRecoverClaim={() => {
                      setRunMode('tool');
                      setToolName('intercomswap_swaprecover_claim');
                      setToolArgsBoth({ trade_id: t.trade_id });
                      setPromptOpen(true);
                    }}
                    onRecoverRefund={() => {
                      setRunMode('tool');
                      setToolName('intercomswap_swaprecover_refund');
                      setToolArgsBoth({ trade_id: t.trade_id });
                      setPromptOpen(true);
                    }}
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
                  <div className="row">
                    <button
                      className="btn"
                      onClick={() => {
                        setRunMode('tool');
                        setToolName('intercomswap_receipts_show');
                        setToolArgsBoth({ trade_id: selected.trade.trade_id });
                        setPromptOpen(true);
                      }}
                    >
                      Prepare receipts_show
                    </button>
                    <button
                      className="btn"
                      onClick={() => {
                        const ch = String(selected?.trade?.swap_channel || '').trim();
                        if (!ch) return;
                        setRunMode('tool');
                        setToolName('intercomswap_sc_join');
                        setToolArgsBoth({ channel: ch });
                        setPromptOpen(true);
                      }}
                    >
                      Prepare join swap_channel
                    </button>
                    <button
                      className="btn"
                      onClick={() => {
                        const ch = String(selected?.trade?.swap_channel || '').trim();
                        if (!ch) return;
                        setRunMode('tool');
                        setToolName('intercomswap_sc_leave');
                        setToolArgsBoth({ channel: ch });
                        setPromptOpen(true);
                      }}
                    >
                      Prepare leave swap_channel
                    </button>
                  </div>
                  <div className="row">
                    <button
                      className="btn"
                      onClick={() => {
                        setRunMode('tool');
                        setToolName('intercomswap_swaprecover_claim');
                        setToolArgsBoth({ trade_id: selected.trade.trade_id });
                        setPromptOpen(true);
                      }}
                    >
                      Prepare swaprecover_claim
                    </button>
                    <button
                      className="btn"
                      onClick={() => {
                        setRunMode('tool');
                        setToolName('intercomswap_swaprecover_refund');
                        setToolArgsBoth({ trade_id: selected.trade.trade_id });
                        setPromptOpen(true);
                      }}
                    >
                      Prepare swaprecover_refund
                    </button>
                  </div>
                </>
              ) : (
                <p className="muted">Select a trade receipt to see one-click tool-call templates.</p>
              )}
            </Panel>
          </div>
        ) : null}

        {activeTab === 'refunds' ? (
          <div className="grid2">
            <Panel title="Open Refunds (receipts)">
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
                <button
                  className="btn"
                  onClick={() => {
                    setRunMode('tool');
                    setToolName('intercomswap_receipts_list_open_refunds');
                    setToolArgsBoth({ limit: openRefundsLimit, offset: 0 });
                    setPromptOpen(true);
                  }}
                >
                  Prepare list_open_refunds
                </button>
                {!openRefundsHasMore ? <span className="muted small">end</span> : null}
              </div>
              <VirtualList
                listRef={openRefundsListRef}
                items={openRefunds}
                itemKey={(t) => String(t?.trade_id || t?.updated_at || Math.random())}
                estimatePx={92}
                onScroll={onOpenRefundsScroll}
                render={(t) => (
                  <TradeRow
                    trade={t}
                    selected={selected?.type === 'trade' && selected?.trade?.trade_id === t?.trade_id}
                    onSelect={() => setSelected({ type: 'trade', trade: t })}
                    onRecoverClaim={() => {
                      setRunMode('tool');
                      setToolName('intercomswap_swaprecover_claim');
                      setToolArgsBoth({ trade_id: t.trade_id });
                      setPromptOpen(true);
                    }}
                    onRecoverRefund={() => {
                      setRunMode('tool');
                      setToolName('intercomswap_swaprecover_refund');
                      setToolArgsBoth({ trade_id: t.trade_id });
                      setPromptOpen(true);
                    }}
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
                <button
                  className="btn"
                  onClick={() => {
                    setRunMode('tool');
                    setToolName('intercomswap_receipts_list_open_claims');
                    setToolArgsBoth({ limit: openClaimsLimit, offset: 0 });
                    setPromptOpen(true);
                  }}
                >
                  Prepare list_open_claims
                </button>
                {!openClaimsHasMore ? <span className="muted small">end</span> : null}
              </div>
              <VirtualList
                listRef={openClaimsListRef}
                items={openClaims}
                itemKey={(t) => String(t?.trade_id || t?.updated_at || Math.random())}
                estimatePx={92}
                onScroll={onOpenClaimsScroll}
                render={(t) => (
                  <TradeRow
                    trade={t}
                    selected={selected?.type === 'trade' && selected?.trade?.trade_id === t?.trade_id}
                    onSelect={() => setSelected({ type: 'trade', trade: t })}
                    onRecoverClaim={() => {
                      setRunMode('tool');
                      setToolName('intercomswap_swaprecover_claim');
                      setToolArgsBoth({ trade_id: t.trade_id });
                      setPromptOpen(true);
                    }}
                    onRecoverRefund={() => {
                      setRunMode('tool');
                      setToolName('intercomswap_swaprecover_refund');
                      setToolArgsBoth({ trade_id: t.trade_id });
                      setPromptOpen(true);
                    }}
                  />
                )}
              />
            </Panel>
          </div>
        ) : null}

        {activeTab === 'wallets' ? (
          <div className="grid2">
            <Panel title="Lightning">
              <button
                className="btn primary"
                onClick={() => {
                  setRunMode('tool');
                  setToolName('intercomswap_ln_info');
                  setToolArgsBoth({});
                  setPromptOpen(true);
                }}
              >
                ln_info
              </button>
              <button
                className="btn"
                onClick={() => {
                  setRunMode('tool');
                  setToolName('intercomswap_ln_listfunds');
                  setToolArgsBoth({});
                  setPromptOpen(true);
                }}
              >
                ln_listfunds
              </button>
              <button
                className="btn"
                onClick={() => {
                  setRunMode('tool');
                  setToolName('intercomswap_ln_newaddr');
                  setToolArgsBoth({});
                  setPromptOpen(true);
                }}
              >
                ln_newaddr
              </button>
            </Panel>
            <Panel title="Solana">
              <button
                className="btn primary"
                onClick={() => {
                  setRunMode('tool');
                  setToolName('intercomswap_sol_config_get');
                  setToolArgsBoth({});
                  setPromptOpen(true);
                }}
              >
                sol_config_get
              </button>
              <button
                className="btn"
                onClick={() => {
                  setRunMode('tool');
                  setToolName('intercomswap_sol_balance');
                  setToolArgsBoth({ pubkey: '...' });
                  setPromptOpen(true);
                }}
              >
                sol_balance
              </button>
            </Panel>
          </div>
        ) : null}

        {activeTab === 'peers' ? (
          <div className="grid2">
            <Panel title="Peer Instances">
              <div className="row">
                <button className="btn primary" onClick={refreshPeersAndBots} disabled={peerStatusBusy || rfqbotStatusBusy}>
                  {peerStatusBusy || rfqbotStatusBusy ? 'Refreshing…' : 'Refresh'}
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    setToolInputMode('form');
                    setToolArgsParseErr(null);
                    setRunMode('tool');
                    setToolName('intercomswap_peer_start');
                    setToolArgsBoth({
                      name: 'swap-maker-peer',
                      store: 'swap-maker',
                      sc_port: 49222,
                      sidechannels: scChannels.split(',').map((s) => s.trim()).filter(Boolean),
                      pow_enabled: true,
                      pow_difficulty: 12,
                      invite_required: true,
                      welcome_required: false,
                      invite_prefixes: ['swap:'],
                    });
                    setPromptOpen(true);
                  }}
                >
                  Prepare peer_start (swap-maker)
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    setRunMode('tool');
                    setToolName('intercomswap_peer_status');
                    setToolArgsBoth({});
                    setPromptOpen(true);
                  }}
                >
                  Prepare peer_status
                </button>
              </div>
              <p className="muted small">Note: never run the same store twice (single-store guard enforced).</p>

              <VirtualList
                items={Array.isArray(peerStatus?.peers) ? peerStatus.peers : []}
                itemKey={(p) => String(p?.name || '')}
                estimatePx={86}
                render={(p) => (
                  <PeerRow
                    peer={p}
                    onSelect={() => setSelected({ type: 'peer', peer: p })}
                    onStop={() => {
                      setRunMode('tool');
                      setToolName('intercomswap_peer_stop');
                      setToolArgsBoth({ name: p.name });
                      setPromptOpen(true);
                    }}
                    onRestart={() => {
                      setRunMode('tool');
                      setToolName('intercomswap_peer_restart');
                      setToolArgsBoth({ name: p.name });
                      setPromptOpen(true);
                    }}
                  />
                )}
              />
              {peerStatus?.type === 'error' ? <div className="alert bad">{String(peerStatus.error || 'peer_status failed')}</div> : null}
            </Panel>
            <Panel title="RFQ Bots">
              <div className="row">
                <button className="btn primary" onClick={refreshPeersAndBots} disabled={peerStatusBusy || rfqbotStatusBusy}>
                  {peerStatusBusy || rfqbotStatusBusy ? 'Refreshing…' : 'Refresh'}
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    setRunMode('tool');
                    setToolName('intercomswap_rfqbot_start_maker');
                    setToolArgsBoth({ name: 'maker1', store: 'swap-maker', sc_port: 49222, argv: [] });
                    setPromptOpen(true);
                  }}
                >
                  Prepare start_maker
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    setRunMode('tool');
                    setToolName('intercomswap_rfqbot_start_taker');
                    setToolArgsBoth({ name: 'taker1', store: 'swap-taker', sc_port: 49223, argv: [] });
                    setPromptOpen(true);
                  }}
                >
                  Prepare start_taker
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    setRunMode('tool');
                    setToolName('intercomswap_rfqbot_status');
                    setToolArgsBoth({});
                    setPromptOpen(true);
                  }}
                >
                  Prepare rfqbot_status
                </button>
              </div>

              <VirtualList
                items={Array.isArray(rfqbotStatus?.bots) ? rfqbotStatus.bots : []}
                itemKey={(b) => String(b?.name || '')}
                estimatePx={92}
                render={(b) => (
                  <BotRow
                    bot={b}
                    onSelect={() => setSelected({ type: 'bot', bot: b })}
                    onStop={() => {
                      setRunMode('tool');
                      setToolName('intercomswap_rfqbot_stop');
                      setToolArgsBoth({ name: b.name });
                      setPromptOpen(true);
                    }}
                    onRestart={() => {
                      setRunMode('tool');
                      setToolName('intercomswap_rfqbot_restart');
                      setToolArgsBoth({ name: b.name });
                      setPromptOpen(true);
                    }}
                  />
                )}
              />
              {rfqbotStatus?.type === 'error' ? <div className="alert bad">{String(rfqbotStatus.error || 'rfqbot_status failed')}</div> : null}
            </Panel>
          </div>
        ) : null}

        {activeTab === 'audit' ? (
          <Panel title="Prompt History (local)">
            <div className="row">
              <label className="check small">
                <input type="checkbox" checked={promptFollowTail} onChange={(e) => setPromptFollowTail(e.target.checked)} />
                follow tail
              </label>
              <button className="btn" onClick={() => setPromptEvents([])}>
                Clear (memory only)
              </button>
            </div>
            <VirtualList
              items={promptEvents}
              itemKey={(e) => String(e.db_id || '') + ':' + String(e.type || '') + ':' + String(e.ts || '')}
              estimatePx={68}
              listRef={promptListRef}
              onScroll={onPromptScroll}
              render={(e) => (
                <ConsoleEventRow evt={e} onSelect={() => setSelected({ type: 'prompt_event', evt: e })} />
              )}
            />
          </Panel>
        ) : null}

        {activeTab === 'settings' ? (
          <Panel title="Settings">
            <div className="row">
              <label className="check">
                <input type="checkbox" checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} />
                auto_approve
              </label>
              <label className="check">
                <input type="checkbox" checked={promptOpen} onChange={(e) => setPromptOpen(e.target.checked)} />
                console open
              </label>
            </div>
            <p className="muted small">
              For external access: run promptd with `server.auth_token` + optional `server.tls` in
              `onchain/prompt/setup.json`.
            </p>
          </Panel>
        ) : null}
      </main>

      {inspectorOpen ? (
        <aside className="inspector">
          <Panel title="Inspector">
            {!selected ? (
              <p className="muted">Select an event to inspect.</p>
            ) : (
              <>
                <pre className="code">{JSON.stringify(selected, null, 2)}</pre>
                <button
                  className="btn"
                  onClick={() => {
                    if (selected?.type === 'sc_event') {
                      setRunMode('tool');
                      setToolName('intercomswap_sc_send_json');
                      setToolArgsBoth({ channel: selected.evt.channel, json: { ack: true } });
                      setPromptOpen(true);
                    }
                  }}
                >
                  Prepare reply tool-call
                </button>
              </>
            )}
          </Panel>
        </aside>
      ) : null}

      <section className={`prompt ${promptOpen ? 'open' : 'closed'}`}>
        <div className="promptbar">
          <div className="promptbar-left">
            <span className="tag">console</span>
            <span className="muted small">session:</span>
            <span className="mono small">{sessionId || 'new'}</span>
          </div>
          <div className="promptbar-right">
            <label className="check small">
              <input type="checkbox" checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} />
              approve
            </label>
            <label className="seg">
              <input type="radio" name="mode" checked={runMode === 'tool'} onChange={() => setRunMode('tool')} />
              <span>Tool</span>
            </label>
            <label className="seg">
              <input type="radio" name="mode" checked={runMode === 'llm'} onChange={() => setRunMode('llm')} />
              <span>LLM</span>
            </label>
            <button className="btn" onClick={() => promptAbortRef.current?.abort()}>
              Stop
            </button>
          </div>
        </div>

        <div className="promptbody">
          {runErr ? <div className="alert bad">Error: {runErr}</div> : null}

          {runMode === 'tool' ? (
            <div className="toolrun">
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
                      setToolInputMode('json');
                      setToolArgsText(JSON.stringify(toolArgsObj || {}, null, 2));
                      setToolArgsParseErr(null);
                    }}
                  />
                  <span>JSON</span>
                </label>
              </div>

              <div className="row">
                <select
                  className="select"
                  value={toolName}
                  onChange={(e) => {
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
                  className="btn"
                  onClick={() => {
                    setToolArgsBoth({});
                    setToolArgsParseErr(null);
                  }}
                  disabled={runBusy}
                >
                  Reset
                </button>
                <button
                  className="btn primary"
                  onClick={onRun}
                  disabled={runBusy}
                  title={toolRequiresApproval(toolName) && !autoApprove ? 'Will ask for one-time approval' : ''}
                >
                  {runBusy ? 'Running…' : toolRequiresApproval(toolName) && !autoApprove ? 'Approve + Run' : 'Run'}
                </button>
              </div>

              {activeTool ? (
                <div className="toolhelp">
                  <div className="muted small">{activeTool.description}</div>
                  {toolRequiresApproval(activeTool.name) ? (
                    <div className="muted small">
                      <span className="chip hi">requires approve</span> (this tool changes state or can move funds)
                    </div>
                  ) : (
                    <div className="muted small">
                      <span className="chip">read-only</span>
                    </div>
                  )}
                </div>
              ) : null}

              {toolRequiresApproval(toolName) && !autoApprove ? (
                <div className="alert warn">
                  This tool changes state (or can move funds). It will ask for a one-time approval unless you enable{' '}
                  <span className="mono">approve</span>.
                </div>
              ) : null}

              {toolInputMode === 'form' ? (
                <ToolForm tool={activeTool} args={toolArgsObj} setArgs={setToolArgsObj} knownChannels={knownChannels} />
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

              <details className="details">
                <summary className="muted small">Args preview</summary>
                <pre className="code">{JSON.stringify(toolArgsObj || {}, null, 2)}</pre>
              </details>

              <p className="muted small">
                Tool mode executes structured tool calls only (no arbitrary shell) and does not expose network text to an
                LLM by default.
              </p>
            </div>
          ) : (
            <div className="llmrun">
              <textarea
                className="textarea"
                value={promptInput}
                onChange={(e) => setPromptInput(e.target.value)}
                placeholder="Natural-language prompt (advanced). Avoid pasting untrusted peer content."
              />
              <div className="row">
                <button className="btn primary" onClick={onRun}>
                  {runBusy ? 'Running…' : 'Run'}
                </button>
                <button className="btn" onClick={() => setPromptInput('')}>
                  Clear
                </button>
              </div>
            </div>
          )}

          <div className="consoleout">
            <div className="row">
              <label className="check small">
                <input type="checkbox" checked={consoleFollowTail} onChange={(e) => setConsoleFollowTail(e.target.checked)} />
                follow tail
              </label>
              <button className="btn" onClick={() => setConsoleEvents([])} disabled={runBusy}>
                Clear output
              </button>
            </div>
            <VirtualList
              items={consoleEvents}
              itemKey={(e) => String(e?.type || '') + ':' + String(e?.ts || e?.started_at || '') + ':' + String(e?.name || '')}
              estimatePx={58}
              listRef={consoleListRef}
              render={(e) => <ConsoleEventRow evt={e} onSelect={() => setSelected({ type: 'console_event', evt: e })} />}
            />
          </div>
        </div>
      </section>
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

function toolGroup(name: string) {
  const n = String(name || '');
  if (n.startsWith('intercomswap_sc_')) return 'SC-Bridge';
  if (n.startsWith('intercomswap_peer_')) return 'Peers';
  if (n.startsWith('intercomswap_rfqbot_')) return 'RFQ Bots';
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

function StatusPill({ label, state, value }: { label: string; state: 'ok' | 'bad' | 'idle' | 'neutral'; value?: string }) {
  return (
    <span className={`pill ${state}`}>
      <span className="pill-dot" />
      <span className="pill-label">{label}</span>
      {value ? <span className="pill-value">{value}</span> : null}
    </span>
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
              <textarea
                className="textarea mono"
                value={Array.isArray(v) ? v.join('\n') : ''}
                placeholder={isReq ? 'one per line (required)' : 'one per line (optional)'}
                onChange={(e) => {
                  const lines = parseLines(e.target.value);
                  if (lines.length === 0) return isReq ? update(k, []) : del(k);
                  update(k, lines);
                }}
              />
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

function BtcSatsField({ name, sats, onSats }: { name: string; sats: number | null; onSats: (next: number | null) => void }) {
  const [unit, setUnit] = useState<'BTC' | 'sats'>('BTC');
  const [display, setDisplay] = useState('');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (sats === null || sats === undefined) return;
    if (unit === 'BTC') setDisplay(satsToBtcDisplay(sats));
    else setDisplay(String(sats));
  }, [sats, unit]);

  return (
    <div className="amt">
      <div className="row">
        <label className="seg">
          <input type="radio" name={name} checked={unit === 'BTC'} onChange={() => setUnit('BTC')} />
          <span>BTC</span>
        </label>
        <label className="seg">
          <input type="radio" name={name} checked={unit === 'sats'} onChange={() => setUnit('sats')} />
          <span>sats</span>
        </label>
      </div>
      <input
        className="input mono"
        type="text"
        value={display}
        placeholder={unit === 'BTC' ? '0.001' : '10000'}
        onChange={(e) => {
          const raw = e.target.value;
          setDisplay(raw);
          if (!raw.trim()) {
            setErr(null);
            onSats(null);
            return;
          }
          if (unit === 'sats') {
            if (!/^[0-9]+$/.test(raw.trim())) {
              setErr('sats must be digits');
              return;
            }
            const n = Number.parseInt(raw.trim(), 10);
            if (!Number.isFinite(n) || !Number.isSafeInteger(n)) {
              setErr('invalid sats');
              return;
            }
            setErr(null);
            onSats(n);
            return;
          }
          const r = btcDisplayToSats(raw);
          if (!r || !r.ok) {
            setErr(r ? r.error : 'invalid');
            return;
          }
          setErr(null);
          onSats(r.atomic);
        }}
      />
      {typeof sats === 'number' ? (
        <div className="muted small">
          sats: <span className="mono">{sats}</span>
        </div>
      ) : null}
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

function RfqRow({ evt, onSelect, onQuote }: { evt: any; onSelect: () => void; onQuote: () => void }) {
  const body = evt?.message?.body;
  const btcSats = typeof body?.btc_sats === 'number' ? body.btc_sats : null;
  const usdtAtomic = typeof body?.usdt_amount === 'string' ? body.usdt_amount : '';
  const maxPlatform = body?.max_platform_fee_bps;
  const maxTrade = body?.max_trade_fee_bps;
  const maxTotal = body?.max_total_fee_bps;
  const minWin = body?.min_sol_refund_window_sec;
  const maxWin = body?.max_sol_refund_window_sec;
  const validUntil = body?.valid_until_unix;
  return (
    <div className="rowitem" role="button" onClick={onSelect}>
      <div className="rowitem-top">
        <span className="mono chip">{evt.channel}</span>
        <span className="mono dim">{evt.trade_id || evt?.message?.trade_id || ''}</span>
      </div>
      <div className="rowitem-mid">
        <span className="mono">BTC: {btcSats !== null ? `${satsToBtcDisplay(btcSats)} (${btcSats} sats)` : '?'}</span>
        <span className="mono">
          USDT: {usdtAtomic ? `${atomicToDecimal(usdtAtomic, 6)} (${usdtAtomic})` : '?'}
        </span>
        <span className="mono">
          fee caps:{' '}
          {typeof maxPlatform === 'number' ? `${maxPlatform} bps (${bpsToPctDisplay(maxPlatform)}%)` : '?'} platform,{' '}
          {typeof maxTrade === 'number' ? `${maxTrade} bps (${bpsToPctDisplay(maxTrade)}%)` : '?'} trade,{' '}
          {typeof maxTotal === 'number' ? `${maxTotal} bps (${bpsToPctDisplay(maxTotal)}%)` : '?'} total
        </span>
        <span className="mono">
          sol window: {typeof minWin === 'number' ? `${secToHuman(minWin)} (${minWin}s)` : '?'}-
          {typeof maxWin === 'number' ? `${secToHuman(maxWin)} (${maxWin}s)` : '?'}
        </span>
        <span className="mono">
          valid_until: {validUntil ?? '?'}
        </span>
      </div>
      <div className="rowitem-bot">
        <button className="btn small primary" onClick={(e) => { e.stopPropagation(); onQuote(); }}>
          Quote
        </button>
      </div>
    </div>
  );
}

function InviteRow({ evt, onSelect, onJoin }: { evt: any; onSelect: () => void; onJoin: () => void }) {
  const body = evt?.message?.body;
  const swapChannel = body?.swap_channel;
  return (
    <div className="rowitem" role="button" onClick={onSelect}>
      <div className="rowitem-top">
        <span className="mono chip">{evt.channel}</span>
        {swapChannel ? <span className="mono chip hi">{swapChannel}</span> : null}
      </div>
      <div className="rowitem-mid">
        <span className="mono">swap_invite</span>
      </div>
      <div className="rowitem-bot">
        <button className="btn small primary" onClick={(e) => { e.stopPropagation(); onJoin(); }}>
          Join
        </button>
      </div>
    </div>
  );
}

function TradeRow({
  trade,
  selected,
  onSelect,
  onRecoverClaim,
  onRecoverRefund,
}: {
  trade: any;
  selected: boolean;
  onSelect: () => void;
  onRecoverClaim: () => void;
  onRecoverRefund: () => void;
}) {
  const id = String(trade?.trade_id || '').trim();
  const state = String(trade?.state || '').trim();
  const role = String(trade?.role || '').trim();
  const updated = typeof trade?.updated_at === 'number' ? new Date(trade.updated_at).toLocaleString() : '';
  const sats = typeof trade?.btc_sats === 'number' ? trade.btc_sats : null;
  const usdtAtomic = typeof trade?.usdt_amount === 'string' ? trade.usdt_amount : '';
  const swapChannel = String(trade?.swap_channel || '').trim();

  const canClaim = state === 'ln_paid' && Boolean(String(trade?.ln_preimage_hex || '').trim());
  // The list_open_refunds tool already filters by refund_after_unix <= now, so treat escrow+refund_after as actionable.
  const canRefund = state === 'escrow' && trade?.sol_refund_after_unix !== null && trade?.sol_refund_after_unix !== undefined;

  return (
    <div className={`rowitem ${selected ? 'selected' : ''}`} role="button" onClick={onSelect}>
      <div className="rowitem-top">
        <span className="mono chip">{role || 'trade'}</span>
        <span className="mono dim">{id || '(no trade_id)'}</span>
        {swapChannel ? <span className="mono chip hi">{swapChannel}</span> : null}
      </div>
      <div className="rowitem-mid">
        <span className="mono">state: {state || '?'}</span>
        <span className="mono">
          BTC: {sats !== null ? `${satsToBtcDisplay(sats)} (${sats} sats)` : '?'}
        </span>
        <span className="mono">
          USDT: {usdtAtomic ? `${atomicToDecimal(usdtAtomic, 6)} (${usdtAtomic})` : '?'}
        </span>
      </div>
      <div className="rowitem-bot">
        <span className="muted small">{updated}</span>
        <div className="row">
          <button className={`btn small ${canClaim ? 'primary' : ''}`} disabled={!canClaim} onClick={(e) => { e.stopPropagation(); onRecoverClaim(); }}>
            Claim
          </button>
          <button className={`btn small ${canRefund ? 'primary' : ''}`} disabled={!canRefund} onClick={(e) => { e.stopPropagation(); onRecoverRefund(); }}>
            Refund
          </button>
        </div>
      </div>
    </div>
  );
}

function PeerRow({
  peer,
  onSelect,
  onStop,
  onRestart,
}: {
  peer: any;
  onSelect: () => void;
  onStop: () => void;
  onRestart: () => void;
}) {
  const alive = Boolean(peer?.alive);
  const sc = peer?.sc_bridge;
  const port = sc?.port ?? sc?.sc_port ?? null;
  return (
    <div className="rowitem" role="button" onClick={onSelect}>
      <div className="rowitem-top">
        <span className="mono chip">{String(peer?.name || '')}</span>
        <span className="mono dim">{String(peer?.store || '')}</span>
        {alive ? <span className="chip hi">alive</span> : <span className="chip">down</span>}
      </div>
      <div className="rowitem-mid">
        <span className="mono">pid: {peer?.pid ?? '—'}</span>
        <span className="mono">sc: {port ?? '—'}</span>
      </div>
      <div className="rowitem-bot">
        <div className="row">
          <button className="btn small" disabled={!alive} onClick={(e) => { e.stopPropagation(); onStop(); }}>
            Stop
          </button>
          <button className="btn small" onClick={(e) => { e.stopPropagation(); onRestart(); }}>
            Restart
          </button>
        </div>
      </div>
    </div>
  );
}

function BotRow({
  bot,
  onSelect,
  onStop,
  onRestart,
}: {
  bot: any;
  onSelect: () => void;
  onStop: () => void;
  onRestart: () => void;
}) {
  const alive = Boolean(bot?.alive);
  return (
    <div className="rowitem" role="button" onClick={onSelect}>
      <div className="rowitem-top">
        <span className="mono chip">{String(bot?.name || '')}</span>
        <span className="mono dim">{String(bot?.role || '')}</span>
        {alive ? <span className="chip hi">alive</span> : <span className="chip">down</span>}
      </div>
      <div className="rowitem-mid">
        <span className="mono">store: {String(bot?.store || '')}</span>
        <span className="mono">sc: {bot?.sc_port ?? '—'}</span>
        <span className="mono">pid: {bot?.pid ?? '—'}</span>
      </div>
      <div className="rowitem-bot">
        <div className="row">
          <button className="btn small" disabled={!alive} onClick={(e) => { e.stopPropagation(); onStop(); }}>
            Stop
          </button>
          <button className="btn small" onClick={(e) => { e.stopPropagation(); onRestart(); }}>
            Restart
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
    getItemKey: (idx: number) => itemKey(items[idx]),
  });

  return (
    <div ref={parentRef} className="vlist" onScroll={onScroll}>
      <div className="vlist-inner" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
        {rowVirtualizer.getVirtualItems().map((v: any) => {
          const item = items[v.index];
          return (
            <div
              key={v.key}
              data-index={v.index}
              // Dynamic row heights: measure actual DOM and let the virtualizer reflow.
              ref={rowVirtualizer.measureElement}
              className="vrow"
              style={{ transform: `translateY(${v.start}px)` }}
            >
              {render(item)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
