import { DAY } from './fixtures';
import { Attempt } from './diagnostic-data';
import { Kind, Lang } from './model';
export type Grain = 'hour' | 'day' | 'week' | 'month';
export type Metric = 'volume' | 'latency' | 'quality';
export interface Window {
  start: number;
  end: number;
}
export const zones = ['Asia/Shanghai', 'UTC', 'America/New_York'];
const clocks = new Map<string, Intl.DateTimeFormat>();
function clockFor(zone: string) {
  let fmt = clocks.get(zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    clocks.set(zone, fmt);
  }
  return fmt;
}
function parts(time: number, zone: string) {
  const p: Record<string, number> = {};
  for (const x of clockFor(zone).formatToParts(time)) if (x.type !== 'literal') p[x.type] = Number(x.value);
  return p;
}
const two = (n: number) => String(n).padStart(2, '0');
export function localInput(time: number, zone: string) {
  const p = parts(time, zone);
  return p.year + '-' + two(p.month) + '-' + two(p.day) + 'T' + two(p.hour) + ':' + two(p.minute);
}
export function stamp(time: number, zone: string, short = false) {
  const p = parts(time, zone);
  return (
    (short ? '' : two(p.month) + '/' + two(p.day) + ' ') +
    two(p.hour) +
    ':' +
    two(p.minute) +
    (short ? '' : ':' + two(p.second))
  );
}
function localToMs(y: number, m: number, d: number, h: number, i: number, zone: string) {
  const want = Date.UTC(y, m - 1, d, h, i);
  let guess = want;
  for (let n = 0; n < 4; n++) {
    const p = parts(guess, zone);
    const diff = want - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    if (!diff) break;
    guess += diff;
  }
  return guess;
}
export function parseLocal(input: string, zone: string) {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)$/.exec(input);
  if (!m) return NaN;
  const ms = localToMs(+m[1], +m[2], +m[3], +m[4], +m[5], zone);
  return localInput(ms, zone) === input ? ms : NaN;
}
export function getWindow(params: URLSearchParams, now: number, defaultHours = 24): Window {
  const start = Number(params.get('from')),
    end = Number(params.get('to'));
  if (start > 0 && end > start && Number.isFinite(end) && end < 8.64e15 && end - start <= 31 * DAY)
    return { start, end };
  const hours = Number(params.get('hours')) || defaultHours,
    anchor = Number(params.get('anchor'));
  const endTime = anchor > 0 && anchor < 8.64e15 ? anchor : now;
  return { start: endTime - (hours > 0 && hours <= 720 ? hours : defaultHours) * 3600000, end: endTime };
}
export function frameBounds(w: Window, grain: Grain, zone: string): Window[] {
  const out: Window[] = [];
  const unit = 3600000;
  const p = parts(w.start, zone);
  let calendar = new Date(Date.UTC(p.year, p.month - 1, p.day));
  if (grain === 'week') calendar.setUTCDate(calendar.getUTCDate() - ((calendar.getUTCDay() + 6) % 7));
  if (grain === 'month') calendar.setUTCDate(1);
  let cursor =
    grain === 'hour'
      ? Math.floor(w.start / unit) * unit
      : localToMs(calendar.getUTCFullYear(), calendar.getUTCMonth() + 1, calendar.getUTCDate(), 0, 0, zone);
  while (cursor < w.end) {
    if (grain === 'month') calendar.setUTCMonth(calendar.getUTCMonth() + 1);
    else if (grain !== 'hour') calendar.setUTCDate(calendar.getUTCDate() + (grain === 'week' ? 7 : 1));
    const next =
      grain === 'hour'
        ? cursor + unit
        : localToMs(calendar.getUTCFullYear(), calendar.getUTCMonth() + 1, calendar.getUTCDate(), 0, 0, zone);
    out.push({ start: Math.max(w.start, cursor), end: Math.min(w.end, next) });
    cursor = next;
  }
  return out;
}
export function effectiveGrain(w: Window, chosen: string): Grain {
  const grain = (['hour', 'day', 'week', 'month'].includes(chosen) ? chosen : 'hour') as Grain;
  return grain === 'hour' && Math.floor((w.end - 1) / 3600000) - Math.floor(w.start / 3600000) + 1 > 500
    ? 'day'
    : grain;
}
export interface Aggregate {
  n: number;
  ok: number;
  empty: number;
  failed: number;
  duration: number;
  queue: number;
  speeds: number[];
  numerator: number;
  denominator: number;
  samples: number;
  latest: number;
}
export function aggregate(): Aggregate {
  return {
    n: 0,
    ok: 0,
    empty: 0,
    failed: 0,
    duration: 0,
    queue: 0,
    speeds: [],
    numerator: 0,
    denominator: 0,
    samples: 0,
    latest: 0,
  };
}
function add(a: Aggregate, c: Attempt) {
  a.n++;
  a.queue += c.queue;
  a.latest = Math.max(a.latest, c.time);
  if (c.status === 'success') {
    a.ok++;
    a.duration += c.duration;
    a.speeds.push(c.duration);
  } else if (c.status === 'empty') a.empty++;
  else if (c.status === 'error') a.failed++;
  if (c.kind === 'search' && c.evaluation === 'complete' && c.candidates > 0) {
    a.numerator += c.relevant;
    a.denominator += c.candidates;
    a.samples++;
  }
  if (c.kind === 'reader' && c.sent && c.status !== 'cancelled') {
    a.numerator += Number(c.chars !== null && c.chars > 0);
    a.denominator++;
    a.samples++;
  }
}
export function percentage(n: number, d: number) {
  return d ? (100 * n) / d : null;
}
export function quality(a: Aggregate) {
  return percentage(a.numerator, a.denominator);
}
export function latency(a: Aggregate) {
  return a.speeds.length ? a.duration / a.speeds.length : null;
}
export function percentile(a: Aggregate) {
  if (!a.speeds.length) return null;
  const sorted = [...a.speeds].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}
export function valueOf(a: Aggregate | undefined, metric: Metric) {
  if (!a) return metric === 'volume' ? 0 : null;
  return metric === 'volume' ? a.n : metric === 'quality' ? quality(a) : latency(a);
}
export function fmt(v: number | null, unit = '') {
  return v === null
    ? '—'
    : (unit === '%' ? v.toFixed(1) : new Intl.NumberFormat('en-US').format(Math.round(v))) + unit;
}
export function qualityName(kind: Kind, lang: Lang) {
  return kind === 'search'
    ? lang === 'zh'
      ? '搜索相关率'
      : 'Search relevance'
    : kind === 'reader'
      ? lang === 'zh'
        ? '正文获取率'
        : 'Article yield'
      : lang === 'zh'
        ? '质量样本'
        : 'Quality samples';
}
export function rollup(calls: Attempt[], frames: Window[]) {
  const all = aggregate(),
    peers = new Map<string, Aggregate>();
  const series = frames.map((window) => ({
    ...window,
    total: aggregate(),
    peers: new Map<string, Aggregate>(),
  }));
  for (const c of calls) {
    let lo = 0,
      hi = frames.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (frames[mid].end <= c.time) lo = mid + 1;
      else hi = mid;
    }
    const f = series[lo];
    if (!f || c.time < f.start) continue;
    if (!peers.has(c.endpoint)) peers.set(c.endpoint, aggregate());
    if (!f.peers.has(c.endpoint)) f.peers.set(c.endpoint, aggregate());
    add(all, c);
    add(peers.get(c.endpoint)!, c);
    add(f.total, c);
    add(f.peers.get(c.endpoint)!, c);
  }
  return { all, peers, series };
}
export type Series = ReturnType<typeof rollup>['series'];
