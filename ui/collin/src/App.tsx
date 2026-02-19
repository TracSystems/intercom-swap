import React, { useEffect, useMemo, useRef, useState } from 'react'
import './app.css'

import MarketChart from './components/MarketChart'
import PriceTicker, { type PricesMap } from './components/PriceTicker'
import DexScanner from './components/DexScanner'
import { TOKENS, type TokenKey, tokenByKey } from './lib/tokenCatalog'

const DAYS_PRESETS = [7, 30, 90] as const

function useInterval(fn: () => void, ms: number) {
  const fnRef = useRef(fn)
  fnRef.current = fn
  useEffect(() => {
    const t = setInterval(() => fnRef.current(), ms)
    return () => clearInterval(t)
  }, [ms])
}

export default function App() {
  const [navOpen, setNavOpen] = useState(false)

  const [activeKey, setActiveKey] = useState<TokenKey>('TNK')
  const active = useMemo(() => tokenByKey(activeKey), [activeKey])

  const [days, setDays] = useState<(typeof DAYS_PRESETS)[number]>(7)
  const [prices, setPrices] = useState<PricesMap | null>(null)

  const [chart, setChart] = useState<any>(null)
  const [loadingChart, setLoadingChart] = useState(false)
  const [chartErr, setChartErr] = useState<string | null>(null)

  const [toast, setToast] = useState<string | null>(null)

  const idsCsv = useMemo(() => TOKENS.map((t) => t.coingeckoId).join(','), [])

  async function loadPrices() {
    try {
      const r = await fetch(`/api/coingecko/simple_price?ids=${encodeURIComponent(idsCsv)}&vs=usd`)
      const j = await r.json()
      if (!j.ok) throw new Error(j.error || 'price fetch failed')
      setPrices(j.data as PricesMap)
    } catch {
      setToast('Price feed delayed (retrying)…')
      window.setTimeout(() => setToast(null), 2200)
    }
  }

  async function loadChart() {
    setLoadingChart(true)
    setChartErr(null)
    try {
      const r = await fetch(
        `/api/coingecko/market_chart?id=${encodeURIComponent(active.coingeckoId)}&vs=usd&days=${encodeURIComponent(
          String(days)
        )}`
      )
      const j = await r.json()
      if (!j.ok) throw new Error(j.error || 'chart fetch failed')

      setChart(j.data)
      if (j.cached === 'stale') {
        setToast('CoinGecko limited → using cached chart')
        window.setTimeout(() => setToast(null), 2400)
      }
    } catch (e: any) {
      setChart(null)
      setChartErr(String(e?.message || e))
    } finally {
      setLoadingChart(false)
    }
  }

  useEffect(() => {
    loadPrices()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useInterval(loadPrices, 18_000)

  useEffect(() => {
    loadChart()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.coingeckoId, days])

  const activePriceUsd = prices?.[active.coingeckoId]?.usd ?? null

  return (
    <div className={`shell ${navOpen ? 'nav-open' : 'nav-closed'}`}>
      {/* TOPBAR */}
      <div className="topbar">
        <div className="topbar-left">
          <button className="iconbtn" title="Menu" onClick={() => setNavOpen((v) => !v)} aria-label="Toggle menu">
            ☰
          </button>

          <div className="logo-wrap">
            <div className="logo-text">
              {'SC-BRIDGE TERMINAL'.split('').map((ch, i) => (
                <span key={i} className={`logo-ch ${i % 3 === 0 ? 'gradient' : ''}`}>
                  {ch}
                </span>
              ))}
            </div>
            <div className="logo-tag">Ops console • market telemetry • Dex scanner</div>
          </div>
        </div>

        <div className="topbar-mid">
          <div className="statusline">
            <span className={`pill ${active.isTracTask ? 'ok' : 'neutral'}`}>
              <span className="pill-dot" />
              <span className="pill-label">Mode</span>
              <span className="pill-value">{active.isTracTask ? 'TRAC TASK' : 'MARKET'}</span>
            </span>

            <span className="pill neutral">
              <span className="pill-dot" />
              <span className="pill-label">Active</span>
              <span className="pill-value">{active.symbol}</span>
            </span>

            <span className={`pill ${activePriceUsd ? 'ok' : 'idle'}`}>
              <span className="pill-dot" />
              <span className="pill-label">Price</span>
              <span className="pill-value">{activePriceUsd ? `$${Number(activePriceUsd).toFixed(6)}` : '--'}</span>
            </span>

            <span className="pill idle">
              <span className="pill-dot" />
              <span className="pill-label">Charts</span>
              <span className="pill-value">Cached</span>
            </span>
          </div>

          <div className="quick">
            <a className="btn small" href="/api/health" target="_blank" rel="noreferrer">
              /api/health
            </a>
            <button className="btn small" onClick={() => loadPrices()}>
              Refresh prices
            </button>
          </div>
        </div>

        <div className="topbar-right">
          <span className="tag">localhost</span>
          <span className="tag">5173</span>
        </div>
      </div>

      {/* NAV */}
      <aside className="nav">
        <div className="nav-inner">
          <button className="navbtn active" onClick={() => setNavOpen(false)}>
            <span>Dashboard</span>
            <span className="badge">LIVE</span>
          </button>

          <button className="navbtn" onClick={() => setNavOpen(false)}>
            <span>Dex Scanner</span>
            <span className="badge">DEX</span>
          </button>

          <button className="navbtn" onClick={() => setNavOpen(false)}>
            <span>Telemetry</span>
            <span className="badge">CG</span>
          </button>

          <div style={{ height: 8 }} />

          <div className="alert">
            <strong className="mono">429 protection</strong>
            <div className="dim" style={{ marginTop: 6 }}>
              If CoinGecko rate-limits, the server serves cached data so the UI stays stable.
            </div>
          </div>

          <div className="alert" style={{ marginTop: 8 }}>
            <div className="mono">Focus</div>
            <div className="dim" style={{ marginTop: 6 }}>
              {active.isTracTask ? 'TNK / Trac Network' : 'Market baseline'}
            </div>
          </div>
        </div>
      </aside>

      {/* MAIN */}
      <main className="main">
        <div className="grid2">
          {/* LEFT COLUMN */}
          <section className="panel">
            <div className="panel-hd">
              <h2>Control</h2>
              <span className="chip hi">{active.isTracTask ? 'TRAC TASK' : 'MARKET'}</span>
            </div>

            <div className="panel-bd">
              {toast ? <div className="toastbar">{toast}</div> : null}

              <div className="field">
                <div className="field-hd">
                  <span className="mono muted">Token Selector</span>
                  <span className="chip">{active.isTracTask ? '⭐ pinned' : 'free'}</span>
                </div>

                <div className="row">
                  <select className="select" value={activeKey} onChange={(e) => setActiveKey(e.target.value as TokenKey)}>
                    {TOKENS.map((t) => (
                      <option key={t.key} value={t.key}>
                        {t.isTracTask ? `⭐ ${t.symbol}` : t.symbol} • {t.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="dim small">
                  {active.isTracTask
                    ? 'TNK focus enabled for Trac Systems submission.'
                    : 'Switch token to refresh chart & telemetry.'}
                </div>
              </div>

              <div className="field">
                <div className="field-hd">
                  <span className="mono muted">Chart Window</span>
                  <span className="chip">{days}D</span>
                </div>

                <div className="row">
                  {DAYS_PRESETS.map((d) => (
                    <button key={d} className={`btn small ${days === d ? 'primary' : ''}`} onClick={() => setDays(d)}>
                      {d}D
                    </button>
                  ))}
                  <button className="btn small" onClick={() => loadChart()}>
                    Reload chart
                  </button>
                </div>

                <div className="dim small">CoinGecko chart is cached server-side to avoid rate limits.</div>
              </div>

              <PriceTicker active={active} prices={prices} />
            </div>
          </section>

          {/* RIGHT COLUMN */}
          <section className="panel">
            <div className="panel-hd">
              <h2>CoinGecko Chart</h2>
              <span className="chip">{active.symbol}</span>
            </div>

            <div className="panel-bd" style={{ padding: 10 }}>
              <MarketChart token={active} days={days} data={chart} loading={loadingChart} error={chartErr} />
            </div>
          </section>

          {/* FULL WIDTH */}
          <section className="panel" style={{ gridColumn: 'span 2' }}>
            <div className="panel-hd">
              <h2>DexScreener CA Scanner</h2>
              <span className="chip warn">live polling</span>
            </div>
            <div className="panel-bd">
              <DexScanner />
            </div>
          </section>
        </div>
      </main>
    </div>
  )
}
