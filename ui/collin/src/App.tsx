import React, { useEffect, useMemo, useRef, useState } from 'react'
import MarketChart from './components/MarketChart'
import PriceTicker, { type PricesMap } from './components/PriceTicker'
import DexScanner from './components/DexScanner'
import { TOKENS, type TokenKey, tokenByKey } from './lib/tokenCatalog'
import { fmtMoney } from './lib/format'

type MarketChartData = {
  prices?: [number, number][]
}

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
  const [activeKey, setActiveKey] = useState<TokenKey>('TNK')
  const active = useMemo(() => tokenByKey(activeKey), [activeKey])

  const [days, setDays] = useState<(typeof DAYS_PRESETS)[number]>(7)
  const [prices, setPrices] = useState<PricesMap | null>(null)

  const [chart, setChart] = useState<MarketChartData | null>(null)
  const [loadingChart, setLoadingChart] = useState(false)
  const [chartErr, setChartErr] = useState<string | null>(null)

  const [topToast, setTopToast] = useState<string | null>(null)

  const idsCsv = useMemo(() => TOKENS.map(t => t.coingeckoId).join(','), [])

  async function loadPrices() {
    try {
      const r = await fetch(`/api/coingecko/simple_price?ids=${encodeURIComponent(idsCsv)}&vs=usd`)
      const j = await r.json()
      if (!j.ok) throw new Error(j.error || 'price fetch failed')
      setPrices(j.data as PricesMap)
    } catch {
      setTopToast(`Price feed delayed (retrying)…`)
      window.setTimeout(() => setTopToast(null), 2200)
    }
  }

  async function loadChart() {
    setLoadingChart(true)
    setChartErr(null)
    try {
      const r = await fetch(
        `/api/coingecko/market_chart?id=${encodeURIComponent(active.coingeckoId)}&vs=usd&days=${encodeURIComponent(String(days))}`
      )
      const j = await r.json()
      if (!j.ok) throw new Error(j.error || 'chart fetch failed')
      setChart(j.data as MarketChartData)

      if (j.cached === 'stale') {
        setTopToast(`CoinGecko limited → using cached chart`)
        window.setTimeout(() => setTopToast(null), 2400)
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

  const activePrice = prices?.[active.coingeckoId]?.usd ?? null

  return (
    <div className="app">
      <div className="topbar">
        <div className="topbarLeft">
          <div className="logo">
            <div className="logoMark">SC</div>
            <div className="logoText">
              <div className="logoTitle">SC-BRIDGE TERMINAL</div>
              <div className="logoSub">Ops console + market telemetry for Trac Systems (Intercom)</div>
            </div>
          </div>
        </div>

        <div className="topbarRight">
          <div className="chip chipLive">
            <span className="dot dotLive" />
            LIVE
          </div>
          <div className={`chip ${active.isTracTask ? 'chipTrac' : ''}`}>
            <span className="chipK">Active</span>
            <span className="chipV">{active.symbol}</span>
          </div>
          <div className="chip">
            <span className="chipK">Price</span>
            <span className="chipV">{activePrice ? fmtMoney(activePrice) : '--'}</span>
          </div>
        </div>
      </div>

      {topToast ? <div className="toast">{topToast}</div> : null}

      <div className="grid">
        <aside className="panel sidebar">
          <div className="sectionTitle">Control</div>

          <div className="card">
            <div className="cardTitleRow">
              <div className="cardTitle">Token Selector</div>
              {active.isTracTask ? <div className="pill pillTrac">TRAC TASK</div> : <div className="pill">MARKET</div>}
            </div>

            <label className="label">Active Token</label>
            <select className="select" value={activeKey} onChange={(e) => setActiveKey(e.target.value as TokenKey)}>
              {TOKENS.map(t => {
                const p = prices?.[t.coingeckoId]?.usd ?? null
                const label = p ? `${t.symbol} • ${fmtMoney(p)}` : `${t.symbol}`
                return (
                  <option key={t.key} value={t.key}>
                    {t.isTracTask ? `⭐ ${label}` : label}
                  </option>
                )
              })}
            </select>

            <div className="hint">
              {active.isTracTask ? (
                <span className="good">TNK focus enabled for Trac Systems submission.</span>
              ) : (
                <span className="muted">Switch token to refresh chart & telemetry.</span>
              )}
            </div>
          </div>

          <div className="card">
            <div className="cardTitle">Chart Window</div>
            <div className="segRow">
              {DAYS_PRESETS.map(d => (
                <button key={d} className={`seg ${days === d ? 'on' : ''}`} onClick={() => setDays(d)}>
                  {d}D
                </button>
              ))}
            </div>
            <div className="hint muted">CoinGecko chart is cached server-side to avoid rate limits.</div>
          </div>

          <div className="card">
            <div className="cardTitle">Quick Checks</div>
            <div className="kv">
              <div className="k">API</div>
              <div className="v">
                <a className="link" href="/api/health" target="_blank" rel="noreferrer">
                  /api/health
                </a>
              </div>
            </div>
            <div className="kv">
              <div className="k">Dex Scanner</div>
              <div className="v">Paste CA/Mint → pick pair</div>
            </div>
          </div>

          <div className="footer">
            <div className="footerLine">SC-Bridge Terminal • Web-Only</div>
            <div className="footerLine muted">CoinGecko + DexScreener telemetry</div>
          </div>
        </aside>

        <main className="main">
          <MarketChart token={active} days={days} data={chart} loading={loadingChart} error={chartErr} />
          <DexScanner />
        </main>

        <section className="rail">
          <PriceTicker active={active} prices={prices} />

          <div className="panel railCard">
            <div className="railHead">
              <div className="railTitle">Bridge Status</div>
              <div className="pill">OPS</div>
            </div>

            <div className="statusGrid">
              <div className="statusItem">
                <div className="statusK">Mode</div>
                <div className="statusV">Web Telemetry</div>
              </div>
              <div className="statusItem">
                <div className="statusK">Charts</div>
                <div className="statusV">CoinGecko (cached)</div>
              </div>
              <div className="statusItem">
                <div className="statusK">DEX</div>
                <div className="statusV">DexScreener (live polling)</div>
              </div>
              <div className="statusItem">
                <div className="statusK">Focus</div>
                <div className="statusV">{active.isTracTask ? 'TNK / Trac Network' : 'Market baseline'}</div>
              </div>
            </div>

            <div className="divider" />

            <div className="note">
              <div className="noteH">429 protection</div>
              <div className="noteB">
                If CoinGecko rate-limits, the server auto-serves cached data so the UI stays stable.
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
