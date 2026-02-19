import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createChart, type LineData } from 'lightweight-charts'
import { clampStr, fmtMoney } from '../lib/format'

type DexPair = {
  chainId?: string
  dexId?: string
  url?: string
  pairAddress?: string
  baseToken?: { symbol?: string; name?: string; address?: string }
  quoteToken?: { symbol?: string; name?: string; address?: string }
  priceUsd?: string
  liquidity?: { usd?: number }
  volume?: { h24?: number; h6?: number; h1?: number; m5?: number }
  txns?: {
    h24?: { buys?: number; sells?: number }
    h1?: { buys?: number; sells?: number }
    m5?: { buys?: number; sells?: number }
  }
}

type DexTokenPairsResp = DexPair[]

function safeNum(s: unknown): number | null {
  const n = typeof s === 'string' ? Number(s) : typeof s === 'number' ? s : NaN
  if (!Number.isFinite(n)) return null
  return n
}

function pickTopPairs(list: DexPair[]): DexPair[] {
  return [...list].sort((a, b) => {
    const la = a.liquidity?.usd ?? 0
    const lb = b.liquidity?.usd ?? 0
    if (lb !== la) return lb - la
    const va = a.volume?.h24 ?? 0
    const vb = b.volume?.h24 ?? 0
    return vb - va
  })
}

const CHAINS = ['solana', 'ethereum', 'bsc', 'base', 'arbitrum', 'polygon'] as const

export default function DexScanner() {
  const [chain, setChain] = useState<(typeof CHAINS)[number]>('solana')
  const [address, setAddress] = useState('')
  const [pairs, setPairs] = useState<DexPair[]>([])
  const [selectedPair, setSelectedPair] = useState<DexPair | null>(null)
  const [status, setStatus] = useState('Idle')

  const wrapRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<ReturnType<typeof createChart> | null>(null)
  const seriesRef = useRef<any>(null)
  const bufRef = useRef<LineData[]>([])

  const pairLabel = useMemo(() => {
    if (!selectedPair) return '--'
    const b = selectedPair.baseToken?.symbol || 'BASE'
    const q = selectedPair.quoteToken?.symbol || 'QUOTE'
    return `${b}/${q}`
  }, [selectedPair])

  const selectedPrice = useMemo(() => safeNum(selectedPair?.priceUsd), [selectedPair?.priceUsd])

  useEffect(() => {
    if (!wrapRef.current) return
    const el = wrapRef.current

    const chart = createChart(el, {
      width: el.clientWidth,
      height: 260,
      layout: { background: { color: 'transparent' }, textColor: '#9bb0d6' },
      grid: {
        vertLines: { color: 'rgba(60,95,190,0.18)' },
        horzLines: { color: 'rgba(60,95,190,0.18)' }
      },
      rightPriceScale: { borderColor: 'rgba(60,95,190,0.20)' },
      timeScale: { borderColor: 'rgba(60,95,190,0.20)', timeVisible: true },
      crosshair: {
        vertLine: { color: 'rgba(24,242,164,0.25)' },
        horzLine: { color: 'rgba(24,242,164,0.18)' }
      }
    })

    const series = chart.addLineSeries({ lineWidth: 2 })
    chartRef.current = chart
    seriesRef.current = series

    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth }))
    ro.observe(el)

    return () => {
      ro.disconnect()
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
    }
  }, [])

  async function scan() {
    const a = address.trim()
    if (!a) return

    setStatus('Scanning DexScreener…')
    try {
      const r = await fetch(`/api/dex/token_pairs?chain=${encodeURIComponent(chain)}&address=${encodeURIComponent(a)}`)
      const j = await r.json()
      if (!j.ok) throw new Error(j.error || 'Dex error')
      const list = pickTopPairs((j.data || []) as DexTokenPairsResp)

      setPairs(list)
      setSelectedPair(list?.[0] || null)
      setStatus(`Found ${list.length} pair(s)`)
    } catch (e: any) {
      setPairs([])
      setSelectedPair(null)
      setStatus(`Error: ${String(e?.message || e)}`)
    }
  }

  // reset micro chart when pair changes
  useEffect(() => {
    bufRef.current = []
    seriesRef.current?.setData([])
    chartRef.current?.timeScale().fitContent()
  }, [selectedPair?.pairAddress])

  // live polling snapshot -> build a tiny "live" line
  useEffect(() => {
    let t: any = null
    let stopped = false

    async function tick() {
      if (!selectedPair?.pairAddress) return
      try {
        const r = await fetch(
          `/api/dex/pair?chain=${encodeURIComponent(selectedPair.chainId || chain)}&pair=${encodeURIComponent(
            selectedPair.pairAddress
          )}`
        )
        const j = await r.json()
        if (!j.ok) return

        const pairsArr = j.data?.pairs || []
        const p0 = (Array.isArray(pairsArr) ? pairsArr[0] : null) as DexPair | null
        const price = safeNum(p0?.priceUsd)

        if (price !== null && seriesRef.current) {
          const now = Math.floor(Date.now() / 1000)
          const buf = bufRef.current
          buf.push({ time: now, value: price })
          if (buf.length > 320) buf.splice(0, buf.length - 320)
          seriesRef.current.setData(buf)
          chartRef.current?.timeScale().fitContent()

          setSelectedPair((prev) => (prev ? { ...prev, ...p0 } : p0))
        }
      } catch {
        // ignore
      }
    }

    function loop() {
      if (stopped) return
      tick().finally(() => {
        t = setTimeout(loop, 3500)
      })
    }

    loop()
    return () => {
      stopped = true
      if (t) clearTimeout(t)
    }
  }, [selectedPair?.pairAddress, chain])

  const topPairs = useMemo(() => pairs.slice(0, 12), [pairs])

  const liquidityUsd = selectedPair?.liquidity?.usd ?? null
  const vol24 = selectedPair?.volume?.h24 ?? null
  const buys1h = selectedPair?.txns?.h1?.buys ?? null
  const sells1h = selectedPair?.txns?.h1?.sells ?? null

  return (
    <div className="dex-root">
      <div className="dex-controls">
        <div className="field" style={{ margin: 0 }}>
          <div className="field-hd">
            <span className="mono muted">DEX</span>
            <span className="chip warn">{clampStr(status, 42)}</span>
          </div>

          <div className="dex-form">
            <div className="field" style={{ margin: 0 }}>
              <div className="field-hd">
                <span className="mono muted">Chain</span>
              </div>
              <select className="select" value={chain} onChange={(e) => setChain(e.target.value as any)}>
                {CHAINS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>

            <div className="field" style={{ margin: 0 }}>
              <div className="field-hd">
                <span className="mono muted">CA / Mint</span>
              </div>
              <input
                className="input"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Paste contract address / mint"
              />
            </div>

            <button className="btn primary" onClick={scan}>
              Scan
            </button>
          </div>

          <div className="dim small">Paste CA/Mint → pick pair → live polling chart</div>
        </div>
      </div>

      <div className="dex-grid">
        {/* LEFT */}
        <div className="dex-left">
          <div className="field">
            <div className="field-hd">
              <span className="mono muted">Pairs</span>
              <span className="chip">{topPairs.length ? `${topPairs.length}/${pairs.length}` : '--'}</span>
            </div>

            {topPairs.length ? (
              <div className="pairlist">
                {topPairs.map((p, idx) => {
                  const b = p.baseToken?.symbol || 'BASE'
                  const q = p.quoteToken?.symbol || 'QUOTE'
                  const label = `${b}/${q}`
                  const liq = p.liquidity?.usd ?? 0
                  const isOn = !!(p.pairAddress && selectedPair?.pairAddress && p.pairAddress === selectedPair.pairAddress)

                  return (
                    <button
                      key={`${p.pairAddress || idx}`}
                      className={`pairbtn ${isOn ? 'on' : ''}`}
                      onClick={() => setSelectedPair(p)}
                    >
                      <span className="mono">{label}</span>
                      <span className="dim small">Liq {fmtMoney(liq)}</span>
                    </button>
                  )
                })}
              </div>
            ) : (
              <div className="dim small">
                Paste a token contract/mint and hit Scan. We will fetch pairs from DexScreener and start live polling.
              </div>
            )}
          </div>

          <div className="field">
            <div className="field-hd">
              <span className="mono muted">Selected</span>
              <span className="chip">{pairLabel}</span>
            </div>

            <div className="kpi-row">
              <div className="kpi">
                <div className="kpi-label">Price</div>
                <div className="kpi-value mono">{selectedPrice === null ? '--' : fmtMoney(selectedPrice)}</div>
              </div>

              <div className="kpi">
                <div className="kpi-label">Liquidity</div>
                <div className="kpi-value mono">{liquidityUsd === null ? '--' : fmtMoney(liquidityUsd)}</div>
              </div>

              <div className="kpi">
                <div className="kpi-label">Vol 24H</div>
                <div className="kpi-value mono">{vol24 === null ? '--' : fmtMoney(vol24)}</div>
              </div>

              <div className="kpi">
                <div className="kpi-label">1H txns</div>
                <div className="kpi-value mono">
                  {buys1h ?? '--'} buys / {sells1h ?? '--'} sells
                </div>
              </div>
            </div>

            {selectedPair?.url ? (
              <a className="btn small" href={selectedPair.url} target="_blank" rel="noreferrer">
                Open on DexScreener
              </a>
            ) : null}
          </div>
        </div>

        {/* RIGHT */}
        <div className="dex-right">
          <div className="field">
            <div className="field-hd">
              <span className="mono muted">DEX Live Chart</span>
              <span className="chip warn">LIVE</span>
            </div>

            <div className="dim small" style={{ marginBottom: 8 }}>
              {pairLabel} • polling ~3.5s • USD
            </div>

            <div className="chart-canvas" ref={wrapRef} style={{ height: 260 }} />

            <div className="dim small" style={{ marginTop: 8 }}>
              Tip: pick the pair with highest liquidity for best signal.
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
