import React, { useEffect, useMemo, useState } from 'react';
import MarketChart from './components/MarketChart';
import PriceTicker, { type PricesMap } from './components/PriceTicker';
import DexScanner from './components/DexScanner';
import { TOKENS, type TokenKey, tokenByKey } from './lib/tokenCatalog';
import { fmtMoney } from './lib/format';

type MarketChartData = {
  prices?: [number, number][];
};

const DAYS_PRESETS = [7, 30, 90] as const;

export default function App() {
  const [activeKey, setActiveKey] = useState<TokenKey>('TNK');
  const active = useMemo(() => tokenByKey(activeKey), [activeKey]);

  const [days, setDays] = useState<(typeof DAYS_PRESETS)[number]>(7);
  const [prices, setPrices] = useState<PricesMap | null>(null);

  const [chart, setChart] = useState<MarketChartData | null>(null);
  const [loadingChart, setLoadingChart] = useState(false);
  const [chartErr, setChartErr] = useState<string | null>(null);

  const idsCsv = useMemo(() => TOKENS.map(t => t.coingeckoId).join(','), []);

  async function loadPrices() {
    try {
      const r = await fetch(`/api/coingecko/simple_price?ids=${encodeURIComponent(idsCsv)}&vs=usd`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'price fetch failed');
      setPrices(j.data as PricesMap);
    } catch {
      // keep last prices if any
    }
  }

  async function loadChart() {
    setLoadingChart(true);
    setChartErr(null);
    try {
      const r = await fetch(`/api/coingecko/market_chart?id=${encodeURIComponent(active.coingeckoId)}&vs=usd&days=${encodeURIComponent(String(days))}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'chart fetch failed');
      setChart(j.data as MarketChartData);
    } catch (e: any) {
      setChart(null);
      setChartErr(String(e?.message || e));
    } finally {
      setLoadingChart(false);
    }
  }

  useEffect(() => {
    loadPrices();
    const t = setInterval(loadPrices, 12_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadChart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.coingeckoId, days]);

  const activePrice = prices?.[active.coingeckoId]?.usd ?? null;

  return (
    <div className="container">
      {/* LEFT */}
      <aside className="panel sidebar">
        <div className="brand">
          <h1>SC-BRIDGE TERMINAL</h1>
          <p>Ops console + market telemetry for Trac Systems (Intercom).</p>
          <div className="badgeRow">
            <span className="badge">WEB ONLY</span>
            <span className="badge">COINGECKO CHART</span>
            <span className="badge">DEXSCREENER SCAN</span>
          </div>
        </div>

        <div className="menuCard">
          <div className="menuTitle">Active Token</div>

          <select className="select full" value={activeKey} onChange={(e) => setActiveKey(e.target.value as TokenKey)}>
            {TOKENS.map(t => {
              const p = prices?.[t.coingeckoId]?.usd ?? null;
              const label = p ? `${t.symbol} • ${fmtMoney(p)}` : `${t.symbol}`;
              return (
                <option key={t.key} value={t.key}>
                  {t.isTracTask ? `⭐ ${label}` : label}
                </option>
              );
            })}
          </select>

          <div className="menuHint">
            {active.isTracTask ? (
              <span className="good">Trac task focus: TNK realtime telemetry enabled.</span>
            ) : (
              <span className="muted">Switch token to refresh chart & price rail.</span>
            )}
          </div>
        </div>

        <div className="menuCard">
          <div className="menuTitle">Chart Window</div>
          <div className="segRow">
            {DAYS_PRESETS.map(d => (
              <button key={d} className={`seg ${days === d ? 'on' : ''}`} onClick={() => setDays(d)}>
                {d}D
              </button>
            ))}
          </div>
          <div className="menuHint muted">
            Chart source is CoinGecko market_chart (historical). Dex chart is live polling.
          </div>
        </div>

        <div className="footerCard">
          <div className="kv">
            <div className="k">Active</div>
            <div className="v">{active.symbol}</div>
          </div>
          <div className="kv">
            <div className="k">Price</div>
            <div className="v">{activePrice ? fmtMoney(activePrice) : '--'}</div>
          </div>
        </div>
      </aside>

      {/* CENTER */}
      <main className="centerCol">
        <MarketChart token={active} days={days} data={chart} loading={loadingChart} error={chartErr} />
        <DexScanner />
      </main>

      {/* RIGHT */}
      <section className="rightCol">
        <PriceTicker active={active} prices={prices} />

        <div className="panel railCard">
          <div className="railTop">
            <div className="railTitle">
              <span className="dot dotWarn" />
              Bridge Notes
            </div>
            <span className="pill">OPS</span>
          </div>

          <div className="noteList">
            <div className="note">
              <div className="noteHead">Why BTC/ETH/SOL + TNK?</div>
              <div className="noteBody">
                BTC/ETH/SOL for baseline market telemetry. TNK is Trac Network focus for Trac Systems task.
              </div>
            </div>

            <div className="note">
              <div className="noteHead">DexScreener mode</div>
              <div className="noteBody">
                Paste CA/Mint → select pair → live polling chart. Best for DEX tokens and on-chain pairs.
              </div>
            </div>

            <div className="note">
              <div className="noteHead">Rate limits</div>
              <div className="noteBody">
                If CoinGecko returns 429, UI will keep last known values and retry automatically.
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
