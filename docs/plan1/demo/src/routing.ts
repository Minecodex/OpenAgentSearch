import { installed, isBrowser, languages, livePool, ranges } from './configuration';
import type { Config, Endpoint, Lang, Project, TimeRange } from './model';

export type PoolKind = 'search' | 'reader';
export const RISK_COOLDOWN_MS = 30 * 60 * 1000;

export interface RouteChoice {
  id: string;
  pool: number;
  startPool: number;
  reason: 'primary' | 'language' | 'fallback';
  eligible: string[];
  unavailable?: 'LANGUAGE_UNSUPPORTED' | 'TIME_RANGE_UNSUPPORTED' | 'PROXY_UNAVAILABLE';
}

export type EndpointOutcome = 'ok' | 'risk' | 'unavailable';
export interface DispatchAttempt {
  kind: PoolKind;
  target: string;
  endpoint: string;
  pool: number;
  reason: RouteChoice['reason'];
  outcome: EndpointOutcome;
}

// The live dispatcher owns these values. Previewing a route or reading diagnostics never advances rotation.
export class EndpointDispatch {
  private readonly lastMember = new Map<string, string>();
  private readonly cooldowns = new Map<string, number>();

  constructor(
    private readonly now = () => Date.now(),
    private readonly hasCapacity: (id: string) => boolean = () => true,
    private readonly riskStore?: { read: (id: string) => number; write: (id: string, until: number) => void },
  ) {}

  markRisk(endpoint: Endpoint, observedAt = this.now()) {
    if (isBrowser(endpoint.adapter)) return;
    const until = Math.max(this.blockedUntil(endpoint.id) ?? 0, observedAt + RISK_COOLDOWN_MS);
    this.cooldowns.set(endpoint.id, until);
    this.riskStore?.write(endpoint.id, until);
    return until;
  }

  blockedUntil(id: string) {
    const until = Math.max(this.cooldowns.get(id) ?? 0, this.riskStore?.read(id) ?? 0);
    if (until > this.now()) return until;
    this.cooldowns.delete(id);
    return undefined;
  }

  available(id: string) {
    return this.blockedUntil(id) === undefined && this.hasCapacity(id);
  }

  next(project: string, kind: PoolKind, pool: number, members: string[], eligible: string[]) {
    const last = this.lastMember.get(JSON.stringify([project, kind, pool]));
    const start = last ? members.indexOf(last) + 1 : 0;
    for (let offset = 0; offset < members.length; offset++) {
      const id = members[(start + offset) % members.length];
      if (eligible.includes(id)) return id;
    }
    return '';
  }

  dispatched(project: string, kind: PoolKind, choice: RouteChoice) {
    if (choice.id) this.lastMember.set(JSON.stringify([project, kind, choice.pool]), choice.id);
  }
}

export function firstLanguagePool(pools: string[][], preferred: readonly string[] = []) {
  return pools.findIndex((members) => members.some((id) => preferred.includes(id)));
}

export function routeChoice(
  cfg: Config,
  project: Project,
  kind: PoolKind,
  lang: Lang,
  range?: TimeRange,
  runtime?: EndpointDispatch,
  retry?: { pool: number; tried: ReadonlySet<string> },
): RouteChoice {
  const pools = kind === 'search' ? project.searchPools : project.readerPools;
  const preferred = kind === 'search' ? cfg.routes[lang] ?? [] : [];
  const endpoints = new Map(cfg.endpoints.map((e) => [e.id, e]));
  const languagePool = firstLanguagePool(pools, preferred.filter((id) => endpoints.get(id)?.kind === 'search'));
  const first = languagePool < 0 ? 0 : languagePool;
  let hasEndpoint = false;
  let hasLanguage = false;
  let hasTimeRange = false;
  let hasEgress = false;
  for (let pool = Math.max(first, retry?.pool ?? first); pool < pools.length; pool++) {
    const members = pools[pool];
    const reason = pool !== first ? 'fallback' : languagePool >= 0 ? 'language' : 'primary';
    const eligible = members.filter((id) => {
      const e = endpoints.get(id);
      if (e?.kind !== kind || !installed(cfg, id)) return false;
      hasEndpoint = true;
      if (kind === 'search' && !(e.options.languages ?? languages).includes(lang)) return false;
      hasLanguage = true;
      if (kind === 'search' && range && !(e.options.time_ranges ?? ranges).includes(range)) return false;
      hasTimeRange = true;
      if (isBrowser(e.adapter) && !livePool(cfg, project.pool)) return false;
      hasEgress = true;
      return !retry?.tried.has(id) && (!runtime || runtime.available(id));
    });
    if (eligible.length) {
      const id = runtime ? runtime.next(project.id, kind, pool, members, eligible) : eligible[0];
      return { id, pool, startPool: first, reason, eligible };
    }
  }
  let unavailable: RouteChoice['unavailable'];
  if (hasEndpoint && !hasLanguage) unavailable = 'LANGUAGE_UNSUPPORTED';
  else if (hasLanguage && !hasTimeRange) unavailable = 'TIME_RANGE_UNSUPPORTED';
  else if (hasTimeRange && !hasEgress) unavailable = 'PROXY_UNAVAILABLE';
  return {
    id: '',
    pool: -1,
    startPool: first,
    reason: languagePool >= 0 ? 'language' : 'primary',
    eligible: [],
    unavailable,
  };
}

// Reserved fixture hostnames stand in for adapter results. The demo never contacts these addresses.
export function offlineOutcome(e: Endpoint): EndpointOutcome {
  if (isBrowser(e.adapter) || !e.address) return 'ok';
  if (!URL.canParse(e.address)) return 'unavailable';
  const hostname = new URL(e.address).hostname;
  if (hostname === 'risk.example.invalid') return 'risk';
  return hostname.endsWith('.invalid') ? 'unavailable' : 'ok';
}

export function dispatchPool(
  cfg: Config,
  project: Project,
  kind: PoolKind,
  lang: Lang,
  range: TimeRange | undefined,
  runtime: EndpointDispatch,
  target: string,
  attempts: DispatchAttempt[],
  send: (endpoint: Endpoint) => EndpointOutcome = offlineOutcome,
) {
  const tried = new Set<string>();
  let choice = routeChoice(cfg, project, kind, lang, range, runtime);
  while (choice.id) {
    const e = cfg.endpoints.find((endpoint) => endpoint.id === choice.id)!;
    runtime.dispatched(project.id, kind, choice);
    const outcome = send(e);
    attempts.push({ kind, target, endpoint: e.id, pool: choice.pool, reason: choice.reason, outcome });
    if (outcome === 'ok') break;
    if (outcome === 'risk') runtime.markRisk(e);
    tried.add(e.id);
    choice = routeChoice(cfg, project, kind, lang, range, runtime, { pool: choice.pool, tried });
  }
  return choice;
}
