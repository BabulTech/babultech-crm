"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Spending over time as stacked bars, one colour per category or payer.
 *
 * Colours are the dataviz reference categorical palette, validated against
 * this app's light (#ffffff card) and dark (#0b111e) surfaces: all checks pass
 * in dark; in light three hues sit under 3:1 contrast, so identity never rests
 * on colour alone - every series is in the legend with its total, the tooltip
 * names each part, and the table view below gives the numbers.
 * "Other" is a neutral grey, never a ninth generated hue.
 */

export interface ChartSeries { key: string; label: string; total: number; count: number; slot: number }
export interface ChartBucket { start: string; end: string; label: string; total: number; count: number; parts: Record<string, { amount: number; count: number }> }

const H = 340;
const M = { top: 12, right: 12, bottom: 34, left: 64 };

const pkr = (n: number) => `PKR ${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
function short(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(n));
}
function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
const color = (slot: number) => (slot < 0 ? "var(--exp-other)" : `var(--exp-s${slot})`);

export function ExpenseChart({ buckets, series, linkBase }: { buckets: ChartBucket[]; series: ChartSeries[]; linkBase: string }) {
  const router = useRouter();
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(320, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const visible = series.filter((s) => !hidden.has(s.key));
  const totals = useMemo(() => buckets.map((b) => visible.reduce((t, s) => t + (b.parts[s.key]?.amount ?? 0), 0)), [buckets, visible]);
  const max = niceMax(Math.max(0, ...totals));
  const plotW = width - M.left - M.right;
  const plotH = H - M.top - M.bottom;
  const step = buckets.length ? plotW / buckets.length : plotW;
  const barW = Math.max(2, Math.min(56, step * 0.68));
  const y = (v: number) => M.top + plotH - (v / max) * plotH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);
  const labelEvery = Math.max(1, Math.ceil(buckets.length / Math.max(2, Math.floor(plotW / 70))));

  const toggle = (key: string) => setHidden((h) => { const n = new Set(h); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const open = (b: ChartBucket) => router.push(`${linkBase}${linkBase.includes("?") ? "&" : "?"}range=custom&from=${b.start}&to=${b.end}`);

  const hb = hover != null ? buckets[hover] : null;
  // Beside the hovered bar, never over it: right of it in the left half, left of it in the right half.
  const barX = hover != null ? M.left + hover * step + step / 2 : 0;
  const tipLeft = hover == null ? 0 : barX > width / 2 ? Math.max(0, barX - barW / 2 - 248) : Math.min(width - 240, barX + barW / 2 + 8);

  return (
    <div className="exp-chart">
      <style>{`
        .exp-chart{--exp-s0:#2a78d6;--exp-s1:#eb6834;--exp-s2:#1baf7a;--exp-s3:#eda100;--exp-s4:#e87ba4;--exp-s5:#008300;--exp-s6:#6250d6;--exp-s7:#e34948;--exp-other:#8b9096;--exp-gap:#ffffff}
        .dark .exp-chart{--exp-s0:#3987e5;--exp-s1:#d95926;--exp-s2:#199e70;--exp-s3:#c98500;--exp-s4:#d55181;--exp-s5:#0ca30c;--exp-s6:#9085e9;--exp-s7:#e66767;--exp-other:#6b7079;--exp-gap:#0b111e}
      `}</style>

      {/* Legend: always present, with each series' total; click to hide or show. */}
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-2" data-legend>
        {series.map((s) => (
          <button key={s.key} type="button" onClick={() => toggle(s.key)} aria-pressed={!hidden.has(s.key)}
            className={`flex items-center gap-2 rounded px-1 text-sm ${hidden.has(s.key) ? "opacity-40 line-through" : ""}`}>
            <span className="inline-block h-3 w-3 rounded-sm" style={{ background: color(s.slot) }} aria-hidden />
            <span className="text-foreground">{s.label}</span>
            <span className="tabular-nums text-muted-foreground">{pkr(s.total)}</span>
          </button>
        ))}
      </div>

      <div ref={wrap} className="relative w-full" onMouseLeave={() => setHover(null)}>
        <svg width={width} height={H} role="img" aria-label="Expenses over time, stacked by series" data-expense-chart>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} className="stroke-border" strokeWidth={1} strokeDasharray={t === 0 ? undefined : "2 4"} />
              <text x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[11px] tabular-nums">{short(t)}</text>
            </g>
          ))}
          {buckets.map((b, i) => {
            const cx = M.left + i * step + step / 2;
            let acc = 0;
            const segs = visible.map((s) => ({ s, v: b.parts[s.key]?.amount ?? 0 })).filter((x) => x.v > 0);
            return (
              <g key={b.start} opacity={hover == null || hover === i ? 1 : 0.55}>
                {segs.map(({ s, v }, j) => {
                  const y0 = y(acc); acc += v; const y1 = y(acc);
                  const top = j === segs.length - 1;
                  const h = Math.max(0, y0 - y1 - (j > 0 ? 2 : 0)); // 2px surface gap between stacked segments
                  const x = cx - barW / 2;
                  const r = top ? Math.min(4, barW / 2, h) : 0;
                  const yy = y1;
                  const d = r
                    ? `M${x},${yy + h} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + barW - r} Q${x + barW},${yy} ${x + barW},${yy + r} V${yy + h} Z`
                    : `M${x},${yy + h} V${yy} H${x + barW} V${yy + h} Z`;
                  return <path key={s.key} d={d} fill={color(s.slot)} />;
                })}
                {i % labelEvery === 0 && (
                  <text x={cx} y={H - M.bottom + 18} textAnchor="middle" className="fill-muted-foreground text-[11px]">{b.label}</text>
                )}
                {/* Hit target: the whole column, bigger than the bar. */}
                <rect x={M.left + i * step} y={M.top} width={step} height={plotH} fill="transparent" className="cursor-pointer"
                  onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onClick={() => open(b)} tabIndex={0}
                  onKeyDown={(e) => { if (e.key === "Enter") open(b); }} aria-label={`${b.label}: ${pkr(totals[i])}`} data-bucket={b.start} />
              </g>
            );
          })}
        </svg>

        {hb && (
          <div className="pointer-events-none absolute top-2 z-10 w-[240px] rounded-md border bg-popover p-3 text-sm shadow-md" style={{ left: tipLeft }} data-tooltip>
            <div className="font-medium text-foreground">{hb.start === hb.end || hb.start.endsWith("-01") && hb.end.slice(0, 7) === hb.start.slice(0, 7) && Number(hb.end.slice(8)) >= 28
                ? hb.label
                : `Week of ${hb.label}`}</div>
            <div className="mb-2 tabular-nums text-foreground">{pkr(totals[hover!])} · {hb.count} expense{hb.count === 1 ? "" : "s"}</div>
            {visible.filter((s) => hb.parts[s.key]).sort((a, b) => (hb.parts[b.key]?.amount ?? 0) - (hb.parts[a.key]?.amount ?? 0)).map((s) => (
              <div key={s.key} className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2"><span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: color(s.slot) }} /><span className="truncate text-muted-foreground">{s.label}</span></span>
                <span className="tabular-nums text-foreground">{short(hb.parts[s.key].amount)}</span>
              </div>
            ))}
            {hb.total > 0 && <div className="mt-2 text-xs text-muted-foreground">Click to open these expenses</div>}
          </div>
        )}
      </div>

      {/* Table view: the same numbers without relying on colour. */}
      <details className="mt-4">
        <summary className="cursor-pointer text-sm font-medium text-primary">Show as a table</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left text-sm" data-chart-table>
            <thead className="border-b text-xs uppercase tracking-wide text-muted-foreground">
              <tr><th className="py-2 pr-3">Period</th>{visible.map((s) => <th key={s.key} className="py-2 pr-3 text-right">{s.label}</th>)}<th className="py-2 text-right">Total</th></tr>
            </thead>
            <tbody className="divide-y">
              {buckets.filter((_, i) => totals[i] > 0).map((b) => (
                <tr key={b.start}>
                  <td className="py-1.5 pr-3">{b.label}</td>
                  {visible.map((s) => <td key={s.key} className="py-1.5 pr-3 text-right tabular-nums">{b.parts[s.key] ? short(b.parts[s.key].amount) : "—"}</td>)}
                  <td className="py-1.5 text-right font-medium tabular-nums">{pkr(visible.reduce((t, s) => t + (b.parts[s.key]?.amount ?? 0), 0))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
