import React, { useEffect, useMemo, useRef } from 'react';
import { createChart, type IChartApi, type ISeriesApi, type LineData } from 'lightweight-charts';
import type { TokenDef } from '../lib/tokenCatalog';

type MarketChartResp = {
  prices?: [number, number][];
};

function toLineData(prices: [number, number][]): LineData[] {
  return prices
    .filter(p => Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number')
    .map(p => ({ time: Math.floor(p[0] / 1000), value: p[1] }));
}

export default function MarketChart(props: {
  token: TokenDef;
  days: number;
  data: MarketChartResp | null;
  loading: boolean;
  error: string | null;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Line'> | null>(null);

  const line = useMemo(() => {
    const prices = props.data?.prices ?? [];
    return toLineData(prices);
  }, [props.data]);

  useEffect(() => {
    if (!wrapRef.current) return;

    const el = wrapRef.current;
    const chart = createChart(el, {
      width: el.clientWidth,
      height: 300,
      layout: {
        background: { color: 'transparent' },
        textColor: '#9AA6C6'
      },
      grid: {
        vertLines: { color: 'rgba(27,42,82,0.35)' },
        horzLines: { color: 'rgba(27,42,82,0.35)' }
      },
      rightPriceScale: {
        borderColor: 'rgba(27,42,82,0.6)'
      },
      timeScale: {
        borderColor: 'rgba(27,42,82,0.6)',
        timeVisible: true
      },
      crosshair: {
        vertLine: { color: 'rgba(56,189,248,0.35)' },
        horzLine: { color: 'rgba(56,189,248,0.25)' }
      }
    });

    const series = chart.addLineSeries({
      lineWidth: 2
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: el.clientWidth });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!seriesRef.current) return;
    seriesRef.current.setData(line);
    chartRef.current?.timeScale().fitContent();
  }, [line, props.token.key, props.days]);

  return (
    <div className="panel mainCard">
      <div className="cardHead">
        <div className="cardTitle">
          <span className="dot dotViolet" />
          CoinGecko Chart
        </div>
        <div className="cardSub">
          {props.token.name} • {props.days}D • USD
        </div>
      </div>

      <div className="chartWrap" ref={wrapRef} />

      <div className="cardFoot">
        {props.loading ? (
          <span className="muted">Loading chart…</span>
        ) : props.error ? (
          <span className="bad">Error: {props.error}</span>
        ) : (
          <span className="muted">Source: CoinGecko market_chart</span>
        )}
      </div>
    </div>
  );
}
