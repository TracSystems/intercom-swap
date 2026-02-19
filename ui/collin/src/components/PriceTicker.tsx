import React from 'react'
import type { TokenDef } from '../lib/tokenCatalog'
import { fmtMoney, fmtPct } from '../lib/format'

export type PricesMap = Record<string, { usd?: number; usd_24h_change?: number }>

export default function PriceTicker(props: { active: TokenDef; prices: PricesMap | null }) {
  const p = props.prices?.[props.active.coingeckoId]
  const usd = p?.usd ?? null
  const ch = p?.usd_24h_change ?? null

  const chColor = typeof ch === 'number' ? (ch >= 0 ? '#18f2a4' : '#ff4d6d') : '#e8f0ff'

  return (
    <div className="panel railCard">
      <div className="railHead">
        <div className="railTitle">Market Telemetry</div>
        {props.active.isTracTask ? <span className="pill pillTrac">TRAC TASK</span> : <span className="pill">LIVE</span>}
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <div
          style={{
            fontSize: 12,
            letterSpacing: '.18em',
            textTransform: 'uppercase',
            color: 'rgba(155,176,214,.85)',
            fontWeight: 900
          }}
        >
          {props.active.symbol}
        </div>
        <div style={{ fontSize: 28, fontWeight: 950, lineHeight: 1 }}>{fmtMoney(usd ?? undefined)}</div>
      </div>

      <div style={{ height: 1, background: 'rgba(60,95,190,.18)', margin: '12px 0' }} />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div
          style={{
            padding: 10,
            borderRadius: 14,
            border: '1px solid rgba(60,95,190,.18)',
            background: 'rgba(5,7,13,.35)'
          }}
        >
          <div
            style={{
              fontSize: 11,
              letterSpacing: '.10em',
              textTransform: 'uppercase',
              color: 'rgba(155,176,214,.85)',
              marginBottom: 6
            }}
          >
            24H
          </div>
          <div style={{ fontSize: 13, fontWeight: 900, color: chColor }}>{fmtPct(ch ?? undefined)}</div>
        </div>

        <div
          style={{
            padding: 10,
            borderRadius: 14,
            border: '1px solid rgba(60,95,190,.18)',
            background: 'rgba(5,7,13,.35)'
          }}
        >
          <div
            style={{
              fontSize: 11,
              letterSpacing: '.10em',
              textTransform: 'uppercase',
              color: 'rgba(155,176,214,.85)',
              marginBottom: 6
            }}
          >
            SOURCE
          </div>
          <div style={{ fontSize: 13, fontWeight: 900 }}>CoinGecko</div>
        </div>
      </div>

      <div style={{ marginTop: 12, fontSize: 12, color: 'rgba(155,176,214,.85)' }}>
        429 protection: server caches CoinGecko so UI stays stable.
      </div>
    </div>
  )
}
