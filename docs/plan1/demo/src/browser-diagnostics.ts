import type { Config, Lang, Local, Log } from './model';
import { local } from './model';
import { articles } from './fixtures';
import { wireId } from './configuration';
import { sampleConfig, projectOf, type Attempt } from './diagnostic-data';

export interface EgressSnapshot {
  poolId: string;
  poolName: Local;
  members: { id: string; name: Local; scheme: 'socks5' | 'https'; weight: number }[];
}
export function captureEgress(cfg: Config, id: string): EgressSnapshot | undefined {
  const pool = cfg.pools.find((p) => p.id === id);
  if (!pool) return undefined;
  return {
    poolId: pool.id,
    poolName: pool.name,
    members: pool.members.flatMap((m) => {
      const node = cfg.proxies.find((p) => p.id === m.id && p.enabled);
      return node ? [{ id: node.id, name: node.name, scheme: node.scheme, weight: m.weight }] : [];
    }),
  };
}

export const browserPhaseLabels = {
  allocate: ['分配槽位与代理', 'Allocate slot and proxy'],
  context: ['准备浏览器上下文', 'Prepare context'],
  navigate: ['加载网页', 'Navigate'],
  extract: ['提取结果', 'Extract result'],
  cleanup: ['回收上下文与租约', 'Release context and lease'],
} as const;
export function browserDiagnostics(r: Log, c: Attempt, lang: Lang) {
  const endpoint =
    r.snapshot?.endpoints?.[c.endpoint] ??
    (!r.generated ? sampleConfig.endpoints.find((e) => e.id === c.endpoint) : undefined);
  if (!r.project || !endpoint?.adapter.startsWith('browser_') || !c.sent) return null;
  const pool =
    r.snapshot?.egress ?? (!r.generated ? captureEgress(sampleConfig, projectOf(r).pool) : undefined);
  if (!pool?.members.length) return null;
  // Synthetic browser jobs preserve their sampled egress and stage durations on every read.
  const weight = pool.members.reduce((n, m) => n + m.weight, 0);
  let slot = [...c.id].reduce((n, k) => (Math.imul(n, 31) + k.charCodeAt(0)) >>> 0, 0) % weight;
  const node = pool.members.find((m) => {
    slot -= m.weight;
    return slot < 0;
  })!;
  const failed = c.status === 'error';
  const fault = failed
    ? articles.some((a) => a.url === c.target && a.snippetOnly)
      ? 'extract'
      : 'navigate'
    : null;
  const parts: ReadonlyArray<readonly [keyof typeof browserPhaseLabels, number]> = [
    ['allocate', 6],
    ['context', 12],
    ['navigate', fault === 'navigate' ? 73 : 63],
    ...(fault === 'navigate' ? [] : [['extract', 10] as const]),
    ['cleanup', 9],
  ];
  let elapsed = 0,
    total = 0;
  return {
    job_id: 'job-' + c.id,
    pool_id: wireId(pool.poolId),
    pool_name: local(pool.poolName, lang),
    proxy_id: wireId(node.id),
    proxy_name: local(node.name, lang),
    scheme: node.scheme,
    phases: parts.map(([stage, share]) => {
      total += share;
      const end = Math.round((c.duration * total) / 100);
      const p = {
        stage,
        start_offset_ms: elapsed,
        duration_ms: end - elapsed,
        status: stage === fault ? 'error' : 'success',
      };
      elapsed = end;
      return p;
    }),
  };
}
