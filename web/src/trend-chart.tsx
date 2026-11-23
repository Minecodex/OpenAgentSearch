import { useId, useState } from "react";
import { useApp } from "./state";
import { chartMaximum } from "./chart-data";

export interface TrendBucket {
  from: string;
  to?: string;
  values: (number | null)[];
}
export interface TrendSeries {
  id: string;
  name: string;
  color: string;
}
export function TrendChart({
  buckets,
  series,
  select,
  from,
  to,
  dark = false,
  unit = "",
  timezone,
}: {
  buckets: TrendBucket[];
  series: TrendSeries[];
  select: (from: string, to: string) => void;
  from?: string;
  to?: string;
  dark?: boolean;
  unit?: string;
  timezone?: string;
}) {
  const { t, language } = useApp();
  const [hidden, setHidden] = useState<string[]>([]),
    [point, setPoint] = useState<number | null>(null);
  const id = useId().replaceAll(":", "");
  const active = series
    .map((s, i) => ({ ...s, index: i }))
    .filter((s) => !hidden.includes(s.id));
  const known = buckets.flatMap((b) =>
    active.map((s) => b.values[s.index]).filter((v): v is number => v != null),
  );
  const hasData = buckets.some((b) => b.values.some((value) => value != null));
  const max = chartMaximum(known, unit === "");
  const width = 720,
    height = 206,
    top = 10,
    bottom = height - 10;
  const start = Date.parse(
      from || buckets[0]?.from || new Date().toISOString(),
    ),
    end = Math.max(
      start + 1,
      Date.parse(
        to || buckets.at(-1)?.to || new Date(start + 3600000).toISOString(),
      ),
    );
  const x = (b: TrendBucket) =>
    Math.max(
      0,
      Math.min(width, ((Date.parse(b.from) - start) / (end - start)) * width),
    );
  const y = (v: number) => bottom - (v / max) * (bottom - top);
  const date = (value: number, short = false) =>
    new Date(value).toLocaleString(language === "zh" ? "zh-CN" : "en-US", {
      ...(short
        ? { hour: "2-digit", minute: "2-digit" }
        : {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          }),
      ...(timezone ? { timeZone: timezone } : {}),
      hour12: false,
    });
  const bucket = point == null ? null : buckets[point];
  function open(index: number) {
    const selected = buckets[index];
    if (selected)
      select(
        selected.from,
        selected.to ||
          new Date(
            Math.min(Date.parse(selected.from) + 3600000, end),
          ).toISOString(),
      );
  }
  function path(index: number) {
    let output = "",
      previous: TrendBucket | null = null;
    for (const b of buckets) {
      const v = b.values[index];
      if (v == null) {
        previous = null;
        continue;
      }
      const px = x(b),
        py = y(v);
      if (!previous) output += `M ${px} ${py}`;
      else {
        const middle = (x(previous) + px) / 2;
        output += ` C ${middle} ${y(previous.values[index]!)} ${middle} ${py} ${px} ${py}`;
      }
      previous = b;
    }
    return output;
  }
  return (
    <section className={"trend-chart" + (dark ? " trend-chart--dark" : "")}>
      <div className="trend-chart__legend">
        {series.map((s) => (
          <button
            key={s.id}
            aria-pressed={!hidden.includes(s.id)}
            onClick={() =>
              setHidden((v) =>
                v.includes(s.id) ? v.filter((id) => id !== s.id) : [...v, s.id],
              )
            }
          >
            <i style={{ background: s.color }} />
            {s.name}
          </button>
        ))}
      </div>
      <div className="trend-chart__body">
        <div className="trend-chart__scale" aria-hidden="true">
          {Array.from({ length: 5 }, (_, i) => (
            <span key={i}>
              {new Intl.NumberFormat(language, {
                maximumFractionDigits: 1,
                notation: "compact",
              }).format((max * (4 - i)) / 4)}
              {unit}
            </span>
          ))}
        </div>
        <button
          className="trend-chart__plot"
          aria-label={t(
            "趋势图，方向键选择时段，回车查看请求",
            "Trend chart. Use arrow keys to choose a time, and Enter to inspect requests",
          )}
          aria-disabled={!known.length || !active.length}
          onPointerLeave={() => setPoint(null)}
          onPointerMove={(event) => {
            if (!buckets.length || !known.length) {
              setPoint(null);
              return;
            }
            const box = event.currentTarget.getBoundingClientRect();
            const time =
              start + ((event.clientX - box.left) / box.width) * (end - start);
            setPoint(
              buckets.reduce(
                (best, b, i) =>
                  Math.abs(Date.parse(b.from) - time) <
                  Math.abs(Date.parse(buckets[best].from) - time)
                    ? i
                    : best,
                0,
              ),
            );
          }}
          onClick={() => {
            if (known.length && active.length)
              open(point ?? buckets.length - 1);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              setPoint((p) =>
                Math.max(
                  0,
                  Math.min(
                    buckets.length - 1,
                    (p ?? 0) + (event.key === "ArrowRight" ? 1 : -1),
                  ),
                ),
              );
            } else if (
              event.key === "Enter" &&
              point != null &&
              known.length > 0
            ) {
              event.preventDefault();
              open(point);
            }
          }}
        >
          <svg
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
                <stop
                  offset="0%"
                  stopColor={active[0]?.color || "var(--accent)"}
                  stopOpacity=".2"
                />
                <stop
                  offset="100%"
                  stopColor={active[0]?.color || "var(--accent)"}
                  stopOpacity="0"
                />
              </linearGradient>
            </defs>
            {Array.from({ length: 5 }, (_, i) => (
              <line
                key={i}
                x1="0"
                y1={top + ((bottom - top) * i) / 4}
                x2={width}
                y2={top + ((bottom - top) * i) / 4}
                stroke="currentColor"
                strokeOpacity=".14"
                strokeDasharray="3 5"
              />
            ))}
            {active.map((s, i) => {
              const d = path(s.index);
              return (
                <g key={s.id}>
                  {i === 0 &&
                    d &&
                    buckets.every((b) => b.values[s.index] != null) && (
                      <path
                        d={`${d} L ${x(buckets.at(-1)!)} ${bottom} L ${x(buckets[0])} ${bottom} Z`}
                        fill={`url(#${id})`}
                      />
                    )}
                  <path
                    d={d}
                    fill="none"
                    stroke={s.color}
                    strokeWidth={i === 0 ? 2.6 : 2}
                    vectorEffect="non-scaling-stroke"
                  />
                  {buckets.length === 1 &&
                    buckets[0].values[s.index] != null && (
                      <circle
                        cx={x(buckets[0])}
                        cy={y(buckets[0].values[s.index]!)}
                        r="3"
                        fill={s.color}
                      />
                    )}
                </g>
              );
            })}
            {bucket && (
              <>
                <line
                  x1={x(bucket)}
                  y1={top}
                  x2={x(bucket)}
                  y2={bottom}
                  stroke="currentColor"
                  strokeOpacity=".5"
                  strokeDasharray="3 4"
                />
                {active.map(
                  (s) =>
                    bucket.values[s.index] != null && (
                      <circle
                        key={s.id}
                        cx={x(bucket)}
                        cy={y(bucket.values[s.index]!)}
                        r="3.5"
                        fill={s.color}
                      />
                    ),
                )}
              </>
            )}
          </svg>
          {(!hasData || (active.length > 0 && !known.length)) && (
            <span className="trend-chart__empty">
              {t("当前时段暂无数据", "No data in this time window")}
            </span>
          )}
          {hasData && !active.length && (
            <span className="trend-chart__empty">
              {t("选择图例以显示趋势", "Choose a legend to display the trend")}
            </span>
          )}
        </button>
        {bucket && (
          <div className="trend-chart__tooltip" role="status">
            <strong>{date(Date.parse(bucket.from))}</strong>
            {active.map((s) => (
              <span key={s.id}>
                <i style={{ background: s.color }} />
                {s.name}
                <b>
                  {bucket.values[s.index]?.toLocaleString() ?? "—"}
                  {unit}
                </b>
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="trend-chart__times" aria-hidden="true">
        {Array.from({ length: 5 }, (_, i) => (
          <span key={i}>
            {date(start + ((end - start) * i) / 4, end - start <= 86400000)}
          </span>
        ))}
      </div>
    </section>
  );
}
