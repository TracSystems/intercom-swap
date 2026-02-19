import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createChart, type IChartApi, type ISeriesApi, type LineData } from 'lightweight-charts'
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
  // prioritize: highest liquidity, then volume
  return [...list].sort((a, b) => {
    const la = a.liquidity?.usd ?? 0
    const lb = b.liquidity?.usd ?? 0
    if (lb !== la) return lb - la
    const va = a.volume?.h24 ?? 0
    const vb = b.volume?.h24 ?? 0
    return vb - va
  })
}

export default function DexScanner() {
  const [chain, setChain] = useState('solana')
  const [address, setAddress] = useState('')
  const [pairs, setPairs] = useState<DexPair[]>([])
  const [selectedPair, setSelectedPair] = useState<DexPair | null>(null)
  const [status, setStatus] = useState<string>('Idle')

  const wrapRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Line'> | null>(null)
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

          // merge latest stats
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
    <div className="panel" style={{ padding: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 12, letterSpacing: '.12em', textTransform: 'uppercase', fontWeight: 950 }}>
            DexScreener CA Scanner
          </div>
          <div style={{ marginTop: 4, fontSize: 12, color: 'rgba(155,176,214,.85)' }}>
            Paste CA/Mint → pick pair → live polling chart
          </div>
        </div>
        <span className="pill">DEX</span>
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
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

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 220 }}>
          <div className="label">CA / Mint</div>
          <input
            className="input"
            placeholder="Paste contract address / mint"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
        </div>

        <button className="seg on" style={{ flex: '0 0 auto', padding: '10px 14px', height: 42 }} onClick={scan}>
          Scan
        </button>
      </div>

      <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '360px minmax(0,1fr)', gap: 12 }}>
        {/* left: pair list + stats */}
        <div
          style={{
            padding: 10,
            borderRadius: 16,
            border: '1px solid rgba(60,95,190,.20)',
            background: 'rgba(5,7,13,.25)'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}>
            <div style={{ fontSize: 12, letterSpacing: '.12em', textTransform: 'uppercase', fontWeight: 900 }}>Pairs</div>
            <div style={{ fontSize: 12, color: 'rgba(155,176,214,.85)' }}>{clampStr(status, 40)}</div>
          </div>

          {topPairs.length ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {topPairs.map((p, idx) => {
                const b = p.baseToken?.symbol || 'BASE'
                const q = p.quoteToken?.symbol || 'QUOTE'
                const label = `${b}/${q}`
                const liq = p.liquidity?.usd ?? 0
                const isOn = p.pairAddress && selectedPair?.pairAddress && p.pairAddress === selectedPair.pairAddress

                return (
                  <button
                    key={`${p.pairAddress || 'pair'}:${idx}`}
                    className={`seg ${isOn ? 'on' : ''}`}
                    style={{
                      padding: '10px 12px',
                      textAlign: 'left',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 10
                    }}
                    onClick={() => setSelectedPair(p)}
                  >
                    <span style={{ fontWeight: 900 }}>{label}</span>
                    <span style={{ fontSize: 12, color: isOn ? '#e8f0ff' : 'rgba(155,176,214,.85)' }}>
                      Liq {fmtMoney(liq)}
                    </span>
                  </button>
                )
              })}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: 'rgba(155,176,214,.85)', lineHeight: 1.45 }}>
              Paste a token contract/mint and hit <b>Scan</b>. We will fetch pairs from DexScreener and start live polling.
            </div>
          )}

          <div style={{ height: 1, background: 'rgba(60,95,190,.18)', margin: '12px 0' }} />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div style={{ padding: 10, borderRadius: 14, border: '1px solid rgba(60,95,190,.18)', background: 'rgba(5,7,13,.35)' }}>
              <div style={{ fontSize: 11, letterSpacing: '.10em', textTransform: 'uppercase', color: 'rgba(155,176,214,.85)', marginBottom: 6 }}>
                Selected
              </div>
              <div style={{ fontSize: 13, fontWeight: 950 }}>{pairLabel}</div>
            </div>

            <div style={{ padding: 10, borderRadius: 14, border: '1px solid rgba(60,95,190,.18)', background: 'rgba(5,7,13,.35)' }}>
              <div style={{ fontSize: 11, letterSpacing: '.10em', textTransform: 'uppercase', color: 'rgba(155,176,214,.85)', marginBottom: 6 }}>
                Price
              </div>
              <div style={{ fontSize: 13, fontWeight: 950 }}>{selectedPrice === null ? '--' : fmtMoney(selectedPrice)}</div>
            </div>

            <div style={{ padding: 10, borderRadius: 14, border: '1px solid rgba(60,95,190,.18)', background: 'rgba(5,7,13,.35)' }}>
              <div style={{ fontSize: 11, letterSpacing: '.10em', textTransform: 'uppercase', color: 'rgba(155,176,214,.85)', marginBottom: 6 }}>
                Liquidity
              </div>
              <div style={{ fontSize: 13, fontWeight: 950 }}>{liquidityUsd === null ? '--' : fmtMoney(liquidityUsd)}</div>
            </div>

            <div style={{ padding: 10, borderRadius: 14, border: '1px solid rgba(60,95,190,.18)', background: 'rgba(5,7,13,.35)' }}>
              <div style={{ fontSize: 11, letterSpacing: '.10em', textTransform: 'uppercase', color: 'rgba(155,176,214,.85)', marginBottom: 6 }}>
                Vol 24H
              </div>
              <div style={{ fontSize: 13, fontWeight: 950 }}>{vol24 === null ? '--' : fmtMoney(vol24)}</div>
            </div>
          </div>

          <div style={{ marginTop: 10, fontSize: 12, color: 'rgba(155,176,214,.85)' }}>
            1H txns: <b>{buys1h ?? '--'}</b> buys / <b>{sells1h ?? '--'}</b> sells
          </div>

          {selectedPair?.url ? (
            <div style={{ marginTop: 8, fontSize: 12 }}>
              <a className="link" href={selectedPair.url} target="_blank" rel="noreferrer">
                Open on DexScreener
              </a>
            </div>
          ) : null}
        </div>

        {/* right: live chart */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
            <div>
              <div style={{ fontSize: 12, letterSpacing: '.12em', textTransform: 'uppercase', fontWeight: 900 }}>DEX Live Chart</div>
              <div style={{ marginTop: 4, fontSize: 12, color: 'rgba(155,176,214,.85)' }}>
                {pairLabel} • polling ~3.5s • USD
              </div>
            </div>
            <span className="pill">LIVE</span>
          </div>

          <div
            ref={wrapRef}
            style={{
              height: 260,
              borderRadius: 16,
              border: '1px solid rgba(60,95,190,.20)',
              background: 'rgba(5,7,13,.35)',
              overflow: 'hidden'
            }}
          />

          <div style={{ marginTop: 10, fontSize: 12, color: 'rgba(155,176,214,.85)' }}>
            Tip: pick the pair with highest liquidity for best signal.
          </div>
        </div>
      </div>
    </div>
  )
}
