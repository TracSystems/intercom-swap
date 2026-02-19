import React, { useEffect, useMemo, useRef } from 'react'
import { createChart, type LineData } from 'lightweight-charts'
import type { TokenDef } from '../lib/tokenCatalog'

type MarketChartResp = { prices?: [number, number][] }

function toLineData(prices: [number, number][]): LineData[] {
  return prices
    .filter((p) => Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number')
    .map((p) => ({ time: Math.floor(p[0] / 1000), value: p[1] }))
}

export default function MarketChart(props: {
  token: TokenDef
  days: number
  data: MarketChartResp | null
  loading: boolean
  error: string | null
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<ReturnType<typeof createChart> | null>(null)
  const seriesRef = useRef<any>(null)

  const line = useMemo(() => {
    const prices = props.data?.prices ?? []
    return toLineData(prices)
  }, [props.data])

  useEffect(() => {
    if (!wrapRef.current) return
    const el = wrapRef.current

    const chart = createChart(el, {
      width: el.clientWidth,
      height: 360,
      layout: { background: { color: 'transparent' }, textColor: '#9bb0d6' },
      grid: {
        vertLines: { color: 'rgba(60,95,190,0.18)' },
        horzLines: { color: 'rgba(60,95,190,0.18)' }
      },
      rightPriceScale: { borderColor: 'rgba(60,95,190,0.20)' },
      timeScale: { borderColor: 'rgba(60,95,190,0.20)', timeVisible: true },
      crosshair: {
        vertLine: { color: 'rgba(56,189,248,0.30)' },
        horzLine: { color: 'rgba(56,189,248,0.20)' }
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

  useEffect(() => {
    if (!seriesRef.current) return
    seriesRef.current.setData(line)
    chartRef.current?.timeScale().fitContent()
  }, [line, props.token.key, props.days])

  const statusText = props.loading
    ? 'Loading chart…'
    : props.error
      ? `Chart delayed: ${props.error}`
      : 'Source: CoinGecko market_chart (server cached)'

  return (
    <div className="chart-wrap">
      <div className="chart-head">
        <div className="mono muted small">
          {props.token.name} • {props.days}D • USD
        </div>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="chip">{props.token.isTracTask ? 'TNK / TRAC' : props.token.symbol}</span>
          <span className="chip warn">CACHED</span>
        </div>
      </div>

      <div className="chart-canvas" ref={wrapRef} />

      <div className="dim small" style={{ marginTop: 8 }}>
        {statusText}
      </div>
    </div>
  )
}
