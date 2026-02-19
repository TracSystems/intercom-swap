import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createChart, type IChartApi, type ISeriesApi, type LineData } from 'lightweight-charts';
import { clampStr, fmtMoney } from '../lib/format';

type DexPair = {
  chainId?: string;
  dexId?: string;
  url?: string;
  pairAddress?: string;
  baseToken?: { symbol?: string; name?: string; address?: string };
  quoteToken?: { symbol?: string; name?: string; address?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number; h6?: number; h1?: number; m5?: number };
  txns?: { h24?: { buys?: number; sells?: number }; h1?: { buys?: number; sells?: number }; m5?: { buys?: number; sells?: number } };
};

type DexTokenPairsResp = DexPair[]; // DexScreener token-pairs returns array

function safeNum(s: unknown): number | null {
  const n = typeof s === 'string' ? Number(s) : typeof s === 'number' ? s : NaN;
  if (!Number.isFinite(n)) return null;
  return n;
}

export default function DexScanner() {
  const [chain, setChain] = useState('solana');
  const [address, setAddress] = useState('');
  const [pairs, setPairs] = useState<DexPair[]>([]);
  const [selectedPair, setSelectedPair] = useState<DexPair | null>(null);
  const [status, setStatus] = useState<string>('Idle');

  // live chart from polling selected pair priceUsd
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bufRef = useRef<LineData[]>([]);

  const pairLabel = useMemo(() => {
    if (!selectedPair) return '--';
    const b = selectedPair.baseToken?.symbol || 'BASE';
    const q = selectedPair.quoteToken?.symbol || 'QUOTE';
    return `${b}/${q}`;
  }, [selectedPair]);

  useEffect(() => {
    if (!wrapRef.current) return;
    const el = wrapRef.current;

    const chart = createChart(el, {
      width: el.clientWidth,
      height: 240,
      layout: { background: { color: 'transparent' }, textColor: '#9AA6C6' },
      grid: {
        vertLines: { color: 'rgba(27,42,82,0.35)' },
        horzLines: { color: 'rgba(27,42,82,0.35)' }
      },
      rightPriceScale: { borderColor: 'rgba(27,42,82,0.6)' },
      timeScale: { borderColor: 'rgba(27,42,82,0.6)', timeVisible: true },
      crosshair: {
        vertLine: { color: 'rgba(24,242,164,0.25)' },
        horzLine: { color: 'rgba(24,242,164,0.18)' }
      }
    });

    const series = chart.addLineSeries({ lineWidth: 2 });
    chartRef.current = chart;
    seriesRef.current = series;

    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth }));
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  async function scan() {
    const a = address.trim();
    if (!a) return;
    setStatus('Scanning DexScreener…');

    try {
      const r = await fetch(`/api/dex/token_pairs?chain=${encodeURIComponent(chain)}&address=${encodeURIComponent(a)}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'Dex error');
      const list = (j.data || []) as DexTokenPairsResp;
      setPairs(list);
      setSelectedPair(list?.[0] || null);
      setStatus(`Found ${list.length} pair(s)`);
    } catch (e: any) {
      setPairs([]);
      setSelectedPair(null);
      setStatus(`Error: ${String(e?.message || e)}`);
    }
  }

  useEffect(() => {
    // reset buffer on pair change
    bufRef.current = [];
    seriesRef.current?.setData([]);
    chartRef.current?.timeScale().fitContent();
  }, [selectedPair?.pairAddress]);

  useEffect(() => {
    let t: any = null;
    let stopped = false;

    async function tick() {
      if (!selectedPair?.pairAddress) return;
      try {
        const r = await fetch(
          `/api/dex/pair?chain=${encodeURIComponent(selectedPair.chainId || chain)}&pair=${encodeURIComponent(selectedPair.pairAddress)}`
        );
        const j = await r.json();
        if (!j.ok) return;

        const pairsArr = j.data?.pairs || [];
        const p0 = (Array.isArray(pairsArr) ? pairsArr[0] : null) as DexPair | null;
        const price = safeNum(p0?.priceUsd);

        if (price !== null && seriesRef.current) {
          const now = Math.floor(Date.now() / 1000);
          const buf = bufRef.current;
          buf.push({ time: now, value: price });

          // keep last 320 points
          if (buf.length > 320) buf.splice(0, buf.length - 320);

          seriesRef.current.setData(buf);
          chartRef.current?.timeScale().fitContent();

          // update snapshot info
          setSelectedPair(prev => (prev ? { ...prev, ...p0 } : p0));
        }
      } catch {
        // ignore
      }
    }

    function loop() {
      if (stopped) return;
      tick().finally(() => {
        t = setTimeout(loop, 3500);
      });
    }

    loop();
    return () => {
      stopped = true;
      if (t) clearTimeout(t);
    };
  }, [selectedPair?.pairAddress, chain]);

  return (
    <div className="panel mainCard">
      <div className="cardHead">
        <div className="cardTitle">
          <span className="dot dotGreen" />
          DexScreener CA Scanner
        </div>
        <div className="cardSub">Paste CA/Mint → pairs → live price polling chart</div>
      </div>

      <div className="dexControls">
        <div className="field">
          <div className="label">Chain</div>
          <select className="select" value={chain} onChange={(e) => setChain(e.target.value)}>
            <option value="solana">solana</option>
            <option value="ethereum">ethereum</option>
            <option value="bsc">bsc</option>
            <option value="base">base</option>
            <option value="arbitrum">arbitrum</option>
            <option value="polygon">polygon</option>
          </select>
        </div>

        <div className="field grow">
          <div className="label">CA / Mint</div>
          <input
            className="input"
            placeholder="Paste contract address / mint"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
        </div>

        <button className="btn" onClick={scan}>
          Scan
        </button>
      </div>

      <div className="dexGrid">
        <div className="dexLeft">
          <div className="miniTitle">Pairs</div>
          <div className="pairList">
            {pairs.length === 0 ? (
              <div className="muted small">No pairs loaded. Paste CA/Mint then scan.</div>
            ) : (
              pairs.slice(0, 20).map((p) => {
                const label = `${p.baseToken?.symbol || 'BASE'}/${p.quoteToken?.symbol || 'QUOTE'}`;
                const liq = p.liquidity?.usd ?? null;
                const vol = p.volume?.h24 ?? null;
                const active = selectedPair?.pairAddress === p.pairAddress;
                return (
                  <button
                    key={p.pairAddress || label + Math.random()}
                    className={`pairItem ${active ? 'active' : ''}`}
                    onClick={() => setSelectedPair(p)}
                    title={p.url || ''}
                  >
                    <div className="row">
                      <div className="pairSym">{label}</div>
                      <div className="pairDex">{clampStr(p.dexId || 'dex', 10)}</div>
                    </div>
                    <div className="row muted small">
                      <span>Liq: {liq ? fmtMoney(liq) : '--'}</span>
                      <span>Vol24h: {vol ? fmtMoney(vol) : '--'}</span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
          <div className="dexStatus">{status}</div>
        </div>

        <div className="dexRight">
          <div className="miniTitle">Live Chart • {pairLabel}</div>
          <div className="chartWrapSmall" ref={wrapRef} />
          <div className="dexMeta">
            <div className="kv">
              <div className="k">Price</div>
              <div className="v">{fmtMoney(safeNum(selectedPair?.priceUsd) ?? undefined)}</div>
            </div>
            <div className="kv">
              <div className="k">Liquidity</div>
              <div className="v">{fmtMoney(selectedPair?.liquidity?.usd ?? undefined)}</div>
            </div>
            <div className="kv">
              <div className="k">Vol 24h</div>
              <div className="v">{fmtMoney(selectedPair?.volume?.h24 ?? undefined)}</div>
            </div>
            <div className="kv">
              <div className="k">URL</div>
              <div className="v">{selectedPair?.url ? <a className="link" href={selectedPair.url} target="_blank">DexScreener</a> : '--'}</div>
            </div>
          </div>
          <div className="cardFoot">
            <span className="muted">Source: DexScreener token-pairs + pair snapshot polling</span>
          </div>
        </div>
      </div>
    </div>
  );
}
