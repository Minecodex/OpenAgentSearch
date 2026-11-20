import { DAY, anchorTime } from './fixtures';
import { Log } from './model';
export function periodLogs(logs: Log[], days: number, offset = 0) {
  const end = anchorTime - offset * days * DAY;
  return logs.filter((r) => r.time >= end - days * DAY && (offset === 0 || r.time < end));
}
export function stats(logs: Log[]) {
  const counts = { list: 0, content: 0, summary: 0 };
  let successful = 0,
    total = 0;
  for (const l of logs) {
    counts[l.op]++;
    if (!['error', 'cancelled'].includes(l.status)) successful++;
    total += l.duration;
  }
  return {
    count: logs.length,
    counts,
    rate: logs.length ? (successful / logs.length) * 100 : 0,
    latency: logs.length ? Math.round(total / logs.length) : 0,
  };
}
export function buckets(logs: Log[], days: number) {
  const n = days === 1 ? 24 : days === 7 ? 28 : 30;
  const start = anchorTime - DAY * days;
  const span = (DAY * days) / n;
  const out = Array.from({ length: n }, (_, i) => ({
    time: start + (i + 0.5) * span,
    list: 0,
    content: 0,
    summary: 0,
  }));
  for (const l of logs) {
    const i = Math.max(0, Math.min(n - 1, Math.floor((l.time - start) / span)));
    out[i][l.op]++;
  }
  return out;
}
