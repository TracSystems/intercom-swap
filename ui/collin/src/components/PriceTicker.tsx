import React, { useMemo } from 'react'
import type { TokenDef } from '../lib/tokenCatalog'
import { fmtMoney, fmtPct } from '../lib/format'

export type PricesMap = Record<string, { usd?: number; usd_24h_change?: number }>

export default function PriceTicker(props: { active: TokenDef; prices: PricesMap | null }) {
  const p = props.prices?.[props.active.coingeckoId]
  const usd = p?.usd ?? null
  const ch = p?.usd_24h_change ?? null

  const changeClass = useMemo(() => {
    if (typeof ch !== 'number') return 'chip'
    return ch >= 0 ? 'chip hi' : 'chip danger'
  }, [ch])

  return (
    <div className="field">
      <div className="field-hd">
        <span className="mono muted">Market Telemetry</span>
        <span className={props.active.isTracTask ? 'chip hi' : 'chip'}>{props.active.isTracTask ? 'TRAC TASK' : 'LIVE'}</span>
      </div>

      <div className="kpi-row">
        <div className="kpi">
          <div className="kpi-label">Asset</div>
          <div className="kpi-value mono">{props.active.symbol}</div>
        </div>

        <div className="kpi">
          <div className="kpi-label">Price</div>
          <div className="kpi-value mono">{usd === null ? '--' : fmtMoney(usd)}</div>
        </div>

        <div className="kpi">
          <div className="kpi-label">24H</div>
          <div className={`kpi-value mono ${changeClass}`}>{ch === null ? '--' : fmtPct(ch)}</div>
        </div>

        <div className="kpi">
          <div className="kpi-label">Source</div>
          <div className="kpi-value mono">CoinGecko</div>
        </div>
      </div>

      <div className="dim small">
        429 protection: server caches CoinGecko so UI stays stable.
      </div>
    </div>
  )
}
