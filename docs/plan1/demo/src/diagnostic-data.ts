import { testReason } from './display-values';
import { primaryResources, wireId } from './configuration';
import { initialConfig, articles } from './fixtures';
import { runDemo, rankArticles, mergedMatches, articleData, type Command, httpOf } from './engine';
import { Config, Envelope, Kind, Lang, Log, Origin, local } from './model';
import type { DispatchAttempt } from './routing';

export const sampleConfig = initialConfig();
export const originNames: Record<Origin, [string, string]> = {
  business: ['业务', 'Business'],
  debug: ['管理调试', 'Debug'],
  endpoint_test: ['接入点测试', 'Endpoint test'],
  proxy_test: ['代理测试', 'Proxy test'],
};
export const phaseNames: Record<string, [string, string]> = {
  admit: ['入口校验', 'Admission'],
  rewrite: ['查询改写', 'Query expansion'],
  search: ['候选检索', 'Search'],
  dedup: ['候选去重', 'Deduplication'],
  score: ['相关性评分', 'Scoring'],
  extract: ['正文提取', 'Article extraction'],
  segments: ['分段摘要', 'Passage summaries'],
  synthesis: ['整体总结', 'Synthesis'],
  render: ['双格式渲染', 'Rendering'],
  test: ['功能测试', 'Capability test'],
};
export const reasonNames = {
  primary: ['项目首池', 'First project pool'],
  direct: ['指定端点', 'Direct'],
  language: ['语言优先', 'Language preference'],
  fallback: ['备用池', 'Fallback pool'],
} as const;
export const evaluationNames = {
  complete: ['完整评分', 'Complete scores'],
  incomplete: ['部分评分', 'Incomplete scores'],
  unscored: ['未评分', 'Unscored'],
  no_candidates: ['无候选', 'No candidates'],
  received: ['已取得正文', 'Article received'],
  missing: ['未取得正文', 'Article missing'],
  model: ['模型输出', 'Model output'],
} as const;
export function originOf(r: Log): Origin {
  return r.origin ?? (r.generated ? 'debug' : 'business');
}
export function languageOf(r: Log): Lang {
  return r.language ?? (r.input?.language === 'en' ? 'en' : r.project === 'field' ? 'en' : 'zh');
}
export function projectOf(r: Log) {
  return sampleConfig.projects.find((p) => p.id === r.project) ?? sampleConfig.projects[0];
}
export function projectLabel(r: Log, cfg: Config, lang: Lang) {
  if (!r.project) return '—';
  const recorded =
    r.snapshot?.projectName ??
    (!r.generated ? sampleConfig.projects.find((p) => p.id === r.project)?.name : undefined);
  return local(recorded ?? cfg.projects.find((p) => p.id === r.project)?.name ?? r.project, lang);
}
export function boundResources(r: Log) {
  return r.resources ?? primaryResources(projectOf(r));
}
export function recordedEndpointName(r: Log, id: string, lang: Lang): string | null {
  const recorded =
    (r.testTarget?.id === id ? r.testTarget.name : undefined) ??
    r.snapshot?.names?.[id] ??
    r.snapshot?.wire?.endpoints.find((e) => e.id === wireId(id))?.name ??
    (!r.generated ? sampleConfig.endpoints.find((e) => e.id === id)?.name : undefined);
  return recorded ? local(recorded, lang) : null;
}
export function endpointName(id: string, cfg: Config, lang: Lang, r?: Log) {
  if (r) return recordedEndpointName(r, id, lang) ?? (id ? wireId(id) : '—');
  return local(
    sampleConfig.endpoints.find((e) => e.id === id)?.name ??
      cfg.endpoints.find((e) => e.id === id)?.name ??
      id,
    lang,
  );
}
export function queryText(r: Log) {
  return local(r.query, languageOf(r));
}
export function responseFor(r: Log, lang: Lang): Envelope {
  if (r.response) return r.response;
  const project = projectOf(r),
    q = queryText(r);
  const res = runDemo(
    r.op,
    r.op === 'content' ? { url: q } : { query: q, language: languageOf(r) },
    project,
    sampleConfig,
    r.id,
    lang,
  );
  if (originOf(r) === 'endpoint_test') {
    return {
      ...res,
      status: r.status === 'error' ? 'error' : 'success',
      data:
        r.status === 'error'
          ? null
          : {
              tested: true,
              endpoint_id:
                boundResources(r)[r.op === 'content' ? 'reader' : r.op === 'summary' ? 'model' : 'search'],
            },
      error:
        r.status === 'error'
          ? {
              code: 'SERVICE_UNAVAILABLE',
              message: lang === 'zh' ? '接入点测试失败。' : 'Endpoint test failed.',
              details: null,
            }
          : null,
      warnings: [],
    };
  }
  if (r.status === 'cancelled') return { ...res, status: 'cancelled', data: null, error: null, warnings: [] };
  if (r.status === 'error')
    return {
      ...res,
      status: 'error',
      data: null,
      warnings: [],
      error: {
        code: r.op === 'content' ? 'CONTENT_UNAVAILABLE' : 'SEARCH_FAILED',
        message:
          lang === 'zh'
            ? '上游未在阶段截止前返回有效内容。'
            : 'The provider did not return usable content before the deadline.',
        details: { stage: r.op === 'content' ? 'extract' : 'search' },
      },
    };
  if (r.status === 'empty')
    return {
      ...res,
      status: 'empty',
      error: null,
      warnings: [],
      data: r.op === 'list' ? { items: [] } : { summary: '', sources: [], citations: [] },
    };
  if (r.status === 'partial') {
    if (r.op === 'summary' && res.data?.sources?.length > 1) {
      const kept = res.data.sources.slice(0, -1);
      res.data = {
        summary: kept.map((s: any) => s.segments[0].summary).join(languageOf(r) === 'zh' ? '' : ' '),
        sources: kept,
        citations: kept.map((s: any) => ({ source_id: s.id, segment_id: s.segments[0].id })),
      };
    }
    res.status = 'partial';
    res.warnings = [
      {
        code: 'source_incomplete',
        message:
          lang === 'zh'
            ? '部分材料未完成，已保留有效结果。'
            : 'Some material was incomplete; usable results were retained.',
        details: null,
      },
    ];
  }
  return res;
}
export function previewOf(r: Log, lang: Lang) {
  const result = responseFor(r, lang);
  const d = result.data;
  if (result.error) return result.error.message;
  if (r.status === 'cancelled') return lang === 'zh' ? '调用方已取消请求' : 'Cancelled by caller';
  if (r.status === 'empty') return lang === 'zh' ? '未找到相关材料' : 'No matching material';
  if (originOf(r).endsWith('_test') && d?.status)
    return d.status === 'error'
      ? testReason(d.reason, lang)
      : lang === 'zh'
        ? '功能测试通过'
        : 'Capability test passed';
  if (d?.tested) return lang === 'zh' ? '能力测试通过' : 'Capability check passed';
  return d?.summary || d?.text || d?.items?.[0]?.snippet || '—';
}
export function recordingComplete(r: Log) {
  return !!r.generated || !/^req_/.test(r.id) || parseInt(r.id.slice(4), 16) % 97 !== 0;
}
export type CallStatus = 'success' | 'empty' | 'error' | 'cancelled';
export type Evaluation = keyof typeof evaluationNames;
export interface Attempt {
  id: string;
  requestId: string;
  project: string;
  endpoint: string;
  kind: Kind;
  phase: string;
  time: number;
  started: number;
  duration: number;
  queue: number;
  origin: Origin;
  language: Lang;
  status: CallStatus;
  reason: keyof typeof reasonNames;
  dispatch?: DispatchAttempt;
  evaluation: Evaluation;
  sent: boolean;
  candidates: number;
  evaluated: number;
  relevant: number;
  chars: number | null;
  target: string;
  span: string;
  variantId?: string;
  scoreBatch?: { id: string; candidateIds: string[] };
}
function smallHash(s: string) {
  let n = 0;
  for (const c of s) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return n;
}
const projected = new WeakMap<Log, Attempt[]>();
// A request owns immutable diagnostic samples. Multiple panels read the same attempts.
export function attempts(r: Log): Attempt[] {
  const prior = projected.get(r);
  if (prior) return prior;
  const built = projectAttempts(r);
  projected.set(r, built);
  return built;
}
export function screenedOut(r: Log, kept: string[]) {
  if (
    r.generated ||
    r.op !== 'summary' ||
    !['success', 'partial'].includes(r.status) ||
    originOf(r) === 'endpoint_test'
  )
    return [];
  const endpoint = boundResources(r).search;
  const count = smallHash(r.id) % (endpoint === 'browser-s' ? 3 : 2);
  return articles.filter((a) => !kept.includes(a.id)).slice(0, count);
}
export interface HitFact {
  article: (typeof articles)[number];
  url: string;
  rank: number;
  relevant: boolean | null;
  score: number | null;
}
export interface QueryGroup {
  id: string;
  query: string;
  hits: HitFact[];
}
// The candidate ID is shared by all hits for the same canonical page in a request.
export function uniqueHits(groups: QueryGroup[]) {
  const candidates = new Map<string, HitFact>();
  for (const group of groups)
    for (const hit of group.hits) {
      if (!candidates.has(hit.article.id)) candidates.set(hit.article.id, hit);
    }
  return [...candidates.values()];
}
function rejectedBeforeDispatch(r: Log) {
  return (
    !r.testTarget &&
    !r.dispatches?.length &&
    !!r.response?.error &&
    [
      'INVALID_ARGUMENT',
      'LIMIT_EXCEEDED',
      'URL_NOT_ALLOWED',
      'TIME_RANGE_UNSUPPORTED',
      'LANGUAGE_UNSUPPORTED',
      'PROXY_UNAVAILABLE',
      'SERVICE_UNAVAILABLE',
    ].includes(r.response.error.code)
  );
}
export function retrievalGroups(r: Log): QueryGroup[] {
  if (
    r.op === 'content' ||
    originOf(r).endsWith('_test') ||
    r.status === 'cancelled' ||
    rejectedBeforeDispatch(r)
  )
    return [];
  const title = queryText(r),
    matched =
      ['success', 'partial'].includes(r.status) ||
      (r.generated && r.op === 'summary' && r.response?.error?.code === 'CONTENT_UNAVAILABLE')
        ? rankArticles(title, r.input?.time_range as Command['time_range'])
        : [];
  const merged = mergedMatches(
    [title, ...(r.rewrites ?? [])],
    r.input?.time_range as Command['time_range'],
    r.snapshot?.searchLimit ?? 10,
  );
  const selected =
    r.op === 'list'
      ? matched.slice(0, Number(r.input?.count ?? r.snapshot?.searchLimit ?? 10))
      : matched.slice(0, r.snapshot?.searchLimit ?? 10);
  const lost = screenedOut(
    r,
    selected.map((x) => x.article.id),
  );
  const unknown = r.status === 'partial' && lost.length > 0 && smallHash(r.id) % 3 === 0;
  const ranked: HitFact[] = selected.map(({ article, match }, i) => ({
    article,
    url: article.url,
    rank: i + 1,
    relevant: r.op === 'summary' ? true : null,
    score:
      r.op === 'summary'
        ? Math.min(
            98,
            83 + match * 3 - (r.generated ? merged.findIndex((h) => h.article.id === article.id) : i),
          )
        : null,
  }));
  lost.forEach((article, i) => {
    const ungraded = unknown && i === lost.length - 1;
    ranked.push({
      article,
      url: article.url,
      rank: ranked.length + 1,
      relevant: ungraded ? null : false,
      score: ungraded ? null : 18 - i,
    });
  });
  const groups = [{ id: 'Q0', query: title, hits: ranked }];
  if (!r.generated && r.project === 'coastal' && r.op === 'summary' && selected.length > 1) {
    const alternate = ranked
      .filter((_, i) => i % 2 === 0)
      .slice(0, 3)
      .map((h, i) => ({ ...h, url: h.url + '#overview', rank: i + 1 }));
    groups.push({ id: 'Q1', query: local(selected[0].article.name, languageOf(r)), hits: alternate });
  }
  if (
    r.generated &&
    r.rewrites?.length &&
    (!r.response?.error || r.response.error.code === 'CONTENT_UNAVAILABLE')
  ) {
    r.rewrites.forEach((query, i) => {
      const found = rankArticles(query, r.input?.time_range as Command['time_range']).slice(
        0,
        r.snapshot?.searchLimit ?? 10,
      );
      groups.push({
        id: 'Q' + (i + 1),
        query,
        hits: found.map(({ article }, j) => {
          const index = merged.findIndex((h) => h.article.id === article.id);
          return {
            article,
            url: article.url,
            rank: j + 1,
            relevant: true,
            score: Math.min(98, 83 + merged[index].match * 3 - index),
          };
        }),
      });
    });
  }
  return groups;
}
export function rewriteGroups(r: Log, searched: QueryGroup[]): QueryGroup[] {
  if (!r.rewrites) return searched;
  return [queryText(r), ...r.rewrites].map((query, i) => {
    const id = 'Q' + i;
    return { id, query, hits: searched.find((g) => g.id === id && g.query === query)?.hits ?? [] };
  });
}
function projectAttempts(r: Log): Attempt[] {
  const origin = originOf(r),
    res = boundResources(r),
    language = languageOf(r),
    seed = smallHash(r.id);
  if (origin === 'proxy_test' || r.status === 'cancelled' || rejectedBeforeDispatch(r)) return [];
  const q = local(r.query, language),
    range = r.input?.time_range as Command['time_range'];
  const matched =
    r.op === 'content' || origin === 'endpoint_test'
      ? []
      : mergedMatches([q, ...(r.rewrites ?? [])], range, r.snapshot?.searchLimit ?? 10);
  const sourceLimit = Number(r.input?.source_count ?? r.snapshot?.sourceLimit ?? projectOf(r).sourceLimit);
  const selected = r.op === 'summary' ? matched.slice(0, sourceLimit) : [];
  const groups = retrievalGroups(r);
  const missingLast = !r.generated && r.status === 'partial' && selected.length > 1;
  type Step = {
    kind: Kind;
    phase: string;
    weight: number;
    target: string;
    state: CallStatus;
    dispatch?: DispatchAttempt;
    group?: QueryGroup;
    scoreBatch?: Attempt['scoreBatch'];
  };
  let steps: Step[] = [];
  const step = (
    kind: Kind,
    phase: string,
    weight: number,
    target = q,
    state: CallStatus = 'success',
  ): Step => ({ kind, phase, weight, target, state });
  if (origin === 'endpoint_test') {
    const k = r.testTarget?.kind ?? (r.op === 'content' ? 'reader' : r.op === 'summary' ? 'model' : 'search');
    if (k === 'proxy') return [];
    steps = [step(k, 'test', 1, q, r.status === 'error' ? 'error' : 'success')];
  } else if (r.op === 'content')
    steps = [step('reader', 'extract', 1, q, r.status === 'error' ? 'error' : 'success')];
  else {
    const searchState =
      r.status === 'error' && r.response?.error?.code !== 'CONTENT_UNAVAILABLE'
        ? 'error'
        : r.status === 'empty'
          ? 'empty'
          : 'success';
    steps = groups.map((group) => ({
      ...step('search', 'search', 0.25 / Math.max(1, groups.length), group.query, searchState),
      group,
    }));
    if (groups.length > 1 || (r.generated && r.op === 'summary' && (r.snapshot?.rewriteCount ?? 0) > 0))
      steps.unshift(step('model', 'rewrite', 0.07));
    if (r.op === 'summary' && searchState === 'success' && selected.length) {
      steps.push({
        ...step('model', 'score', 0.12),
        scoreBatch: { id: 'B1', candidateIds: uniqueHits(groups).map((h) => h.article.id) },
      });
      selected.forEach((s, i) => {
        if (
          r.snapshot?.endpoints?.[res.search]?.adapter === 'integrated_search' &&
          (!s.article.snippetOnly || !res.reader)
        )
          return;
        steps.push(
          step(
            'reader',
            'extract',
            0.32 / selected.length,
            s.article.url,
            s.article.snippetOnly || (missingLast && i === selected.length - 1) ? 'error' : 'success',
          ),
        );
      });
      const kept = selected.filter((s, i) =>
        r.generated
          ? r.response?.data?.sources?.some((v: { url: string }) => v.url === s.article.url)
          : !missingLast || i !== selected.length - 1,
      );
      kept.forEach((s) => steps.push(step('model', 'segments', 0.17 / kept.length, s.article.url)));
      if (kept.length) steps.push(step('model', 'synthesis', 0.14));
    }
  }
  if (r.dispatches) {
    for (const kind of ['search', 'reader'] as const) {
      const recorded = r.dispatches.filter((d) => d.kind === kind);
      const templates = steps.filter((s) => s.kind === kind);
      const replacements = recorded.map((d) => {
        const template = templates.find((s) => s.target === d.target) ??
          step(kind, kind === 'search' ? 'search' : 'extract', 0.1, d.target);
        return { ...template, state: d.outcome === 'ok' ? template.state : 'error' as const, dispatch: d };
      });
      let insertion = steps.findIndex((s) => s.kind === kind);
      if (insertion < 0) {
        insertion = kind === 'search' ? steps.findIndex((s) => s.phase !== 'rewrite')
          : steps.findIndex((s) => s.phase === 'segments' || s.phase === 'synthesis');
      }
      steps.splice(insertion < 0 ? steps.length : insertion, templates.length, ...replacements);
    }
  }
  const totalWeight = steps.reduce((a, s) => a + s.weight, 0),
    budget = Math.max(0, Math.floor(r.duration * 0.92));
  const hasDedup = steps.some((s) => s.phase === 'search' && s.state === 'success' && s.group);
  const localParts =
    1 + Number(hasDedup) + Number(r.op === 'content' && r.status === 'success' && origin !== 'endpoint_test');
  const reserve = r.duration - budget;
  let fraction = 0,
    spent = 0,
    localTime = Math.floor(reserve / localParts);
  return steps.map((s, i) => {
    fraction += s.weight;
    const end = Math.round((budget * fraction) / totalWeight);
    const slot = end - spent,
      queue = Math.floor(slot * (((seed % 5) + 2) / 100)),
      duration = slot - queue;
    const started = r.time + spent + localTime;
    spent = end;
    if (hasDedup && s.phase === 'search' && steps[i + 1]?.phase !== 'search')
      localTime = Math.floor((reserve * 2) / localParts);
    const isSearch = s.kind === 'search',
      isReader = s.kind === 'reader';
    const items = s.group?.hits ?? [];
    const candidateCount =
      isSearch && s.state === 'success' ? (origin === 'endpoint_test' ? 1 : items.length) : 0;
    const eligible =
      isSearch &&
      r.op === 'summary' &&
      origin !== 'endpoint_test' &&
      s.state === 'success' &&
      candidateCount > 0;
    const evaluated = eligible ? items.filter((h) => h.relevant !== null).length : 0;
    const incomplete = eligible && evaluated < candidateCount;
    const relevant = eligible ? items.filter((h) => h.relevant === true).length : 0;
    const article = articles.find((a) => a.url === s.target);
    const chars =
      isReader && s.state === 'success'
        ? r.op === 'content' && r.response?.data?.lengths
          ? r.response.data.lengths.text.retained
          : article
            ? articleData(article, r.snapshot?.bodyLimit ?? 40000).lengths.text.retained
            : null
        : null;
    const evaluation: Evaluation = isReader
      ? s.state === 'success'
        ? 'received'
        : 'missing'
      : isSearch
        ? s.state === 'empty'
          ? 'no_candidates'
          : eligible
            ? incomplete
              ? 'incomplete'
              : 'complete'
            : 'unscored'
        : 'model';
    return {
      id: r.id + '/c' + (i + 1),
      requestId: r.id,
      project: r.project,
      endpoint: s.dispatch?.endpoint ?? r.testTarget?.id ?? res[s.kind],
      kind: s.kind,
      phase: s.phase,
      time: started + slot,
      started,
      duration,
      queue,
      origin,
      language,
      status: s.state,
      reason: s.dispatch?.reason ?? (origin === 'endpoint_test' || s.kind === 'model' ? 'direct' : 'primary'),
      dispatch: s.dispatch,
      evaluation,
      sent: true,
      candidates: candidateCount,
      evaluated,
      relevant,
      chars,
      target: s.target,
      span: s.phase,
      ...(s.group ? { variantId: s.group.id } : {}),
      ...(s.scoreBatch ? { scoreBatch: s.scoreBatch } : {}),
    };
  });
}
export function resourceTestLog(
  target: { id: string; name: import('./model').Local; kind: Kind | 'proxy'; version?: number },
  language: Lang,
): Log {
  const origin = target.kind === 'proxy' ? 'proxy_test' : 'endpoint_test';
  const id = 'test_' + crypto.randomUUID().slice(0, 12);
  const duration = target.kind === 'model' ? 136 : target.kind === 'proxy' ? 44 : 82;
  return {
    id,
    op:
      target.kind === 'reader' || target.kind === 'proxy'
        ? 'content'
        : target.kind === 'model'
          ? 'summary'
          : 'list',
    origin,
    language,
    testTarget: target,
    project: '',
    query: target.name,
    time: Date.now() - duration,
    duration,
    status: 'success',
    generated: true,
    response: {
      request_id: id,
      status: 'success',
      data: { tested: true, resource_id: target.id, elapsed_ms: duration },
      warnings: [],
      error: null,
    },
  };
}
export function resultCode(r: Log, lang: Lang) {
  return httpOf(responseFor(r, lang));
}
