import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { useConsole } from './state';
import { Metric, Series, fmt, stamp, valueOf, Window } from './investigation';
import { endpointName } from './diagnostic-data';
const palette = ['--series-a', '--series-b', '--series-c', '--series-d', '--series-e'];
function seriesToken(id: string) {
  const known: Record<string, number> = { 'browser-s': 0, index: 1, 'browser-r': 0, reader: 1, model: 2 };
  let n = 0;
  for (const c of id) n = (31 * n + c.charCodeAt(0)) >>> 0;
  return palette[known[id] ?? n % palette.length];
}
export function seriesColor(id: string) {
  return 'var(' + seriesToken(id) + ')';
}
export function InsightChart({
  series,
  ids,
  metric,
  zone,
  drill,
}: {
  series: Series;
  ids: string[];
  metric: Metric;
  zone: string;
  drill: (w: Window) => void;
}) {
  const { lang, cfg, t, theme } = useConsole();
  const ref = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState(0),
    [active, focus] = useState<number | null>(null),
    [hidden, setHidden] = useState<string[]>([]);
  useEffect(() => {
    const n = ref.current;
    if (!n) return;
    const obs = new ResizeObserver(() => setSize((x) => x + 1));
    obs.observe(n);
    return () => obs.disconnect();
  }, []);
  const shown = ids.filter((id) => !hidden.includes(id));
  const visible = shown.length ? shown : ids;
  const pick = active === null ? null : Math.max(0, Math.min(series.length - 1, active));
  const unit = metric === 'quality' ? '%' : metric === 'latency' ? ' ms' : '';
  function indexAt(clientX: number) {
    const b = ref.current!.getBoundingClientRect();
    return Math.max(
      0,
      Math.min(
        series.length - 1,
        Math.round(((clientX - b.left - 43) / Math.max(1, b.width - 57)) * (series.length - 1)),
      ),
    );
  }
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !series.length) return;
    const box = canvas.getBoundingClientRect(),
      w = box.width,
      h = box.height;
    if (w < 32 || h < 32) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(h * ratio);
    const c = canvas.getContext('2d');
    if (!c) return;
    c.scale(ratio, ratio);
    const style = getComputedStyle(canvas);
    const grid = style.getPropertyValue('--line').trim(),
      muted = style.getPropertyValue('--muted').trim();
    const left = 43,
      right = 14,
      top = 16,
      bottom = 24,
      pw = w - left - right,
      ph = h - top - bottom;
    const rawMax = Math.max(
      1,
      ...series.flatMap((f) => visible.map((id) => valueOf(f.peers.get(id), metric) ?? 0)),
    );
    const rawStep = rawMax / 4,
      pow = 10 ** Math.floor(Math.log10(rawStep));
    const step = Math.ceil(rawStep / pow) * pow;
    const max = metric === 'quality' ? 100 : step * 4;
    const x = (i: number) => left + (series.length === 1 ? 0.5 : i / (series.length - 1)) * pw;
    const y = (v: number) => top + ph * (1 - v / max);
    c.font = '11px Geist, sans-serif';
    c.textBaseline = 'middle';
    for (let j = 0; j <= 4; j++) {
      const yy = top + (j * ph) / 4;
      c.setLineDash([3, 4]);
      c.lineWidth = 1;
      c.strokeStyle = grid;
      c.beginPath();
      c.moveTo(left, yy);
      c.lineTo(w - right, yy);
      c.stroke();
      c.fillStyle = muted;
      c.textAlign = 'right';
      c.fillText(Math.round(max * (1 - j / 4)) + (metric === 'quality' ? '%' : ''), left - 6, yy);
    }
    c.setLineDash([]);
    const labels = Math.min(w < 430 ? 4 : 6, series.length);
    for (let j = 0; j < labels; j++) {
      const i = Math.round((j / Math.max(1, labels - 1)) * (series.length - 1));
      const isHourly = series[series.length - 1].end - series[0].start <= 2 * 86400000;
      c.fillStyle = muted;
      c.textAlign = j === 0 ? 'left' : j === labels - 1 ? 'right' : 'center';
      c.fillText(
        isHourly ? stamp(series[i].start, zone, true) : stamp(series[i].start, zone).slice(0, 5),
        x(i),
        h - 7,
      );
    }
    for (const id of visible) {
      const idx = ids.indexOf(id),
        color = style.getPropertyValue(seriesToken(id)).trim();
      const vals = series.map((f) => valueOf(f.peers.get(id), metric));
      c.strokeStyle = color;
      c.fillStyle = color;
      c.lineWidth = 2.5;
      c.lineJoin = 'round';
      c.lineCap = 'round';
      let segment: { x: number; y: number }[] = [];
      const flush = () => {
        if (!segment.length) return;
        const line = new Path2D();
        line.moveTo(segment[0].x, segment[0].y);
        for (let j = 1; j < segment.length; j++) {
          const a = segment[j - 1],
            b = segment[j];
          const mid = (a.x + b.x) / 2;
          line.bezierCurveTo(mid, a.y, mid, b.y, b.x, b.y);
        }
        if (idx === 0 && segment.length > 1) {
          const fill = new Path2D(line);
          fill.lineTo(segment.at(-1)!.x, top + ph);
          fill.lineTo(segment[0].x, top + ph);
          fill.closePath();
          c.globalAlpha = 0.09;
          c.fill(fill);
          c.globalAlpha = 1;
        }
        c.stroke(line);
        if (segment.length === 1) {
          c.beginPath();
          c.arc(segment[0].x, segment[0].y, 3, 0, Math.PI * 2);
          c.fill();
        }
        segment = [];
      };
      vals.forEach((v, i) => {
        if (v === null) {
          flush();
          return;
        }
        segment.push({ x: x(i), y: y(v) });
      });
      flush();
    }
    if (pick !== null) {
      c.strokeStyle = muted;
      c.lineWidth = 1;
      c.setLineDash([3, 4]);
      c.beginPath();
      c.moveTo(x(pick), top);
      c.lineTo(x(pick), top + ph);
      c.stroke();
      c.setLineDash([]);
      for (const id of visible) {
        const v = valueOf(series[pick].peers.get(id), metric);
        if (v === null) continue;
        c.fillStyle = style.getPropertyValue(seriesToken(id)).trim();
        c.beginPath();
        c.arc(x(pick), y(v), 4, 0, Math.PI * 2);
        c.fill();
      }
    }
  }, [series, ids, metric, zone, theme, lang, size, hidden, pick]);
  return (
    <div className="insight-plot">
      <div className="plot-legend">
        {ids.map((id) => (
          <button
            key={id}
            aria-pressed={visible.includes(id)}
            onClick={() =>
              setHidden((all) => {
                const next = all.includes(id) ? all.filter((v) => v !== id) : [...all, id];
                return ids.some((k) => !next.includes(k)) ? next : all;
              })
            }
          >
            <i style={{ background: seriesColor(id) }} />
            {endpointName(id, cfg, lang)}
          </button>
        ))}
      </div>
      <div className="plot-area">
        <canvas
          ref={ref}
          tabIndex={0}
          role="button"
          aria-label={t(
            '调用趋势，左右键选择时间段，回车查看明细',
            'Call trend. Use arrow keys to choose a bucket and Enter to inspect calls.',
          )}
          data-testid="insight-trend"
          onMouseMove={(e) => focus(indexAt(e.clientX))}
          onMouseLeave={() => focus(null)}
          onBlur={() => focus(null)}
          onClick={(e) => drill(series[indexAt(e.clientX)])}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
              e.preventDefault();
              focus((v) =>
                Math.max(0, Math.min(series.length - 1, (v ?? 0) + (e.key === 'ArrowRight' ? 1 : -1))),
              );
            } else if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              drill(series[pick ?? 0]);
            }
          }}
        />
        {pick !== null && (
          <div role="status" className={'plot-readout ' + (pick > series.length / 2 ? 'left' : 'right')}>
            <strong>
              {stamp(series[pick].start, zone)} – {stamp(series[pick].end, zone, true)}
            </strong>
            {visible.map((id) => (
              <span key={id}>
                {endpointName(id, cfg, lang)} <b>{fmt(valueOf(series[pick].peers.get(id), metric), unit)}</b>
              </span>
            ))}
          </div>
        )}
      </div>
      <footer>
        <span>
          {t('按调用完成时间分桶', 'Bucketed by completion time')} · {zone}
        </span>
        <button
          className="text-link"
          disabled={!series.length}
          onClick={() => drill(series[pick ?? series.length - 1])}
        >
          {t('查看时段明细', 'Inspect time bucket')}
          <ArrowUpRight size={13} />
        </button>
      </footer>
    </div>
  );
}
