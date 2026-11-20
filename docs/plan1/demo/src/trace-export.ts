import { browserDiagnostics } from './browser-diagnostics';
import { evidenceView } from './evidence';
import { executionOverview } from './execution-overview';
import { primaryResources, traceSnapshot, wireId } from './configuration';
import { checkRewriteContext, rewriteJob } from './rewrite';
import type { Log, Config, Lang } from './model';
import {
  attempts,
  endpointName,
  languageOf,
  originOf,
  previewOf,
  projectOf,
  sampleConfig,
  projectLabel,
  queryText,
  recordingComplete,
  responseFor,
  retrievalGroups,
  rewriteGroups,
  uniqueHits,
} from './diagnostic-data';
function scrub(value: unknown): unknown {
  if (typeof value === 'string')
    return value
      .replace(/(https?:\/\/)[^/\s@]+@/gi, '$1•••@')
      .replace(/([?&](?:token|key|password|secret|api_key)=)[^&\s]*/gi, '$1•••')
      .replace(/\bBearer\s+\S+/gi, 'Bearer •••');
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /^(?:secret|password|authorization|api_key)$/i.test(k) ? '•••' : scrub(v),
      ]),
    );
  return value;
}
export function stagesFor(r: Log) {
  const calls = attempts(r),
    keys = ['admit'];
  for (const c of calls) {
    if (!keys.includes(c.phase)) keys.push(c.phase);
    if (
      c.phase === 'search' &&
      c.status === 'success' &&
      r.op !== 'list' &&
      r.op !== 'content' &&
      !keys.includes('dedup')
    )
      keys.push('dedup');
  }
  if (r.op === 'list' && ['success', 'partial'].includes(r.status) && !originOf(r).endsWith('_test'))
    keys.push('dedup');
  if (r.op === 'content' && r.status === 'success' && !originOf(r).endsWith('_test')) keys.push('render');
  if (originOf(r) === 'proxy_test') keys.push('test');
  const localBudget = Math.max(0, r.duration - calls.reduce((a, c) => a + c.duration + c.queue, 0));
  const localKeys = keys.filter((k) => !calls.some((c) => c.phase === k));
  let offset = 0;
  return keys.map((key, i) => {
    const matched = calls.filter((c) => c.phase === key);
    const localIndex = localKeys.indexOf(key);
    const elapsed = matched.length
      ? matched.reduce((n, c) => n + c.duration + c.queue, 0)
      : Math.floor(((localIndex + 1) * localBudget) / localKeys.length) -
        Math.floor((localIndex * localBudget) / localKeys.length);
    const stage = {
      key,
      duration: elapsed,
      start: offset,
      calls: matched,
      status:
        originOf(r) === 'proxy_test'
          ? key === 'test'
            ? r.status
            : 'success'
          : matched.some((c) => c.status === 'error')
            ? 'error'
            : matched.some((c) => c.status === 'empty')
              ? 'empty'
              : i === 0 && calls.length === 0
                ? r.status
                : 'success',
    };
    offset += elapsed;
    return stage;
  });
}
export function recordedScope(r: Log): Log['snapshot'] {
  if (r.snapshot) return r.snapshot;
  if (r.generated || !r.project) return undefined;
  const project = projectOf(r);
  return {
    version: project.version,
    sourceLimit: project.sourceLimit,
    searchLimit: project.searchLimit,
    bodyLimit: project.bodyLimit,
    summaryLimit: project.summaryLimit,
    rewriteCount: project.rewriteCount,
    allowSnippets: project.allowSnippets,
    searchPools: project.searchPools,
    readerPools: project.readerPools,
    pool: project.pool,
    ...primaryResources(project),
  };
}
export function buildTraceExport(r: Log, cfg: Config, lang: Lang) {
  const res = responseFor(r, lang),
    stages = stagesFor(r),
    calls = attempts(r),
    groups = retrievalGroups(r),
    hits = uniqueHits(groups),
    scope = recordedScope(r);
  const origin = originOf(r),
    isTest = origin.endsWith('_test'),
    complete = recordingComplete(r),
    title = queryText(r),
    responsePreview = previewOf(r, lang),
    sources = res.data?.sources ?? [];
  const command =
    r.input ?? (r.op === 'content' ? { url: title } : { query: title, language: languageOf(r) });
  const overview = executionOverview(r, res, calls, groups, complete, lang);
  const context = checkRewriteContext(r.input ?? {}),
    rewrite =
      scope?.rewriteCount && context.ok
        ? rewriteJob(title, languageOf(r), scope.rewriteCount, context.value)
        : undefined;
  const wireScope =
    r.snapshot?.wire ??
    (!r.generated && r.project ? traceSnapshot(sampleConfig, projectOf(r), languageOf(r)) : null);
  const factsFor = (step: (typeof stages)[number]) =>
    step.key === 'admit'
      ? command
      : step.key === 'rewrite'
        ? {
            model_input: rewrite,
            queries: rewriteGroups(r, groups).map((g) => ({ id: g.id, query: g.query })),
          }
        : step.key === 'search'
          ? groups.map((g) => ({ variant: g.id, hits: g.hits.map((h) => ({ rank: h.rank, url: h.url })) }))
          : step.key === 'dedup'
            ? hits.map((h) => ({
                url: h.article.url,
                variants: groups
                  .filter((g) => g.hits.some((x) => x.article.id === h.article.id))
                  .map((g) => g.id),
              }))
            : step.key === 'score'
              ? hits.map((h) => ({ id: h.article.id, score: h.score, relevant: h.relevant }))
              : step.key === 'segments'
                ? sources
                : step.key === 'render' || step.key === 'synthesis'
                  ? res.data
                  : step.calls;
  const request = r,
    spans = stages.map((s) => ({
      span_id: s.key,
      parent_id: null,
      stage: s.key,
      status: s.status,
      start_offset_ms: s.start,
      duration_ms: s.duration,
    }));
  const view = {
    request: {
      metadata: {
        request_id: request.id,
        project_id: request.project ? wireId(request.project) : null,
        project_name: request.project ? projectLabel(request, cfg, lang) : null,
        operation: isTest ? origin : request.op,
        origin,
        language: languageOf(request),
        query_preview: title,
        response_preview: complete ? responsePreview : null,
        status: request.status,
        started_at: new Date(request.time).toISOString(),
        duration_ms: request.duration,
        upstream_calls: overview.upstream_calls,
        model_calls: overview.model_calls,
        incomplete: !complete,
      },
      spans,
      config_version: scope?.version ?? null,
      snapshot: wireScope,
      execution_summary: overview.summary,
      request_payload: complete ? command : null,
      response_payload: complete ? res : null,
      incomplete_reasons: complete ? [] : ['payload_unavailable'],
    },
    evidence: complete
      ? evidenceView(request, res, groups, languageOf(request))
      : { variants: [], candidates: [], sources: [], segments: [] },
    payloads: stages.map((s, i) => ({
      span: spans[i],
      input: complete ? (s.key === 'admit' ? command : s.key === 'rewrite' ? (rewrite ?? null) : null) : null,
      output: complete ? factsFor(s) : null,
      diagnostics: { call_ids: s.calls.map((c) => c.id) },
    })),
    calls: calls.map((c) => {
      const job = browserDiagnostics(request, c, lang);
      return {
        call_id: c.id,
        ...(job ? { browser_job: job, proxy_id: job.proxy_id } : {}),
        request_id: request.id,
        endpoint_id: wireId(c.endpoint),
        endpoint_version:
          request.snapshot?.endpoints?.[c.endpoint]?.version ??
          request.testTarget?.version ??
          wireScope?.endpoints.find((e) => e.id === wireId(c.endpoint))?.version ??
          null,
        operation: isTest ? origin : request.op,
        origin,
        kind: c.kind,
        span_id: c.span,
        ...(c.variantId ? { variant_id: c.variantId } : {}),
        ...(c.scoreBatch ? { score_batch_id: c.scoreBatch.id } : {}),
        project_id: c.project ? wireId(c.project) : null,
        endpoint_name: endpointName(c.endpoint, cfg, lang, request),
        language: c.language,
        started_at: new Date(c.started).toISOString(),
        finished_at: new Date(c.time).toISOString(),
        input_preview: c.target,
        evaluation: c.evaluation,
        candidates: c.kind === 'search' ? c.candidates : null,
        evaluated: c.kind === 'search' ? c.evaluated : null,
        relevant: c.kind === 'search' ? c.relevant : null,
        retained_chars: c.chars,
        queue_ms: c.queue,
        execution_ms: c.duration,
        sent: c.sent,
        status: c.status,
        reason: c.reason,
        ...(c.dispatch ? { pool_priority: c.dispatch.pool + 1 } : {}),
        ...(c.dispatch && c.dispatch.outcome !== 'ok' ? { endpoint_failure: c.dispatch.outcome } : {}),
      };
    }),
  };
  return scrub(view) as typeof view;
}
