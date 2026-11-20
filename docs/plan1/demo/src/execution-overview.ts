import { wireId } from './configuration';
import { type Attempt, type QueryGroup, originOf, recordedEndpointName, uniqueHits } from './diagnostic-data';
import type { Envelope, Kind, Lang, Log } from './model';

export interface EndpointUse {
  endpoint_id: string;
  endpoint_name: string | null;
}
type AnswerSource = 'body' | 'snippet' | 'mixed' | 'search_results' | 'none';
type Batch = { batch_id: string; candidate_count: number | null };
export interface ExecutionSummary {
  retrieval: {
    variant_count: number | null;
    raw_candidates: number | null;
    unique_candidates: number | null;
  } | null;
  score_batches: Batch[] | null;
  answer_source: AnswerSource | null;
  endpoints: Record<Kind, EndpointUse[] | null>;
}

function retrievalCounts(sent: Attempt[], groups: QueryGroup[], complete: boolean) {
  const search = sent.filter((c) => c.phase === 'search');
  if (!search.length) return { variant_count: 0, raw_candidates: 0, unique_candidates: 0 };
  const ids = new Set(search.map((c) => c.variantId));
  const knownIds = !ids.has(undefined);
  const returned = search.filter((c) => c.status === 'success' || c.status === 'empty');
  const accepted = new Set(returned.map((c) => c.variantId));
  const material = groups.filter((g) => accepted.has(g.id));
  // Multiple dispatches of one variant share its accepted result set.
  const haveHits =
    complete && returned.length > 0 && !accepted.has(undefined) && material.length === accepted.size;
  return {
    variant_count: knownIds ? ids.size : null,
    raw_candidates: haveHits ? material.reduce((n, g) => n + g.hits.length, 0) : null,
    unique_candidates: haveHits ? uniqueHits(material).length : null,
  };
}

export function scoringBatches(calls: Attempt[], complete: boolean): Batch[] | null {
  const batches = new Map<string, Set<string>>();
  for (const c of calls) {
    if (!c.sent || c.phase !== 'score') continue;
    if (!c.scoreBatch) return null;
    const { id, candidateIds } = c.scoreBatch;
    const members = batches.get(id) ?? new Set<string>();
    for (const candidate of candidateIds) members.add(candidate);
    batches.set(id, members);
  }
  return [...batches].map(([batch_id, ids]) => ({ batch_id, candidate_count: complete ? ids.size : null }));
}

function answerSource(r: Log, res: Envelope, complete: boolean): AnswerSource | null {
  if (originOf(r).endsWith('_test')) return null;
  if (r.status === 'empty' || r.status === 'error' || r.status === 'cancelled') return 'none';
  if (!complete || !res.data) return null;
  if (r.op === 'list') return res.data.items?.length ? 'search_results' : null;
  if (r.op === 'content') return res.data.text || res.data.markdown ? 'body' : null;
  if (!res.data.citations?.length || !Array.isArray(res.data.sources)) return null;
  const kinds = new Set<'body' | 'snippet'>();
  for (const ref of res.data.citations) {
    const source = res.data.sources.find((s: { id: string }) => s.id === ref.source_id);
    if (!source?.segments?.some((s: { id: string }) => s.id === ref.segment_id)) return null;
    if (source.kind !== 'body' && source.kind !== 'snippet') return null;
    kinds.add(source.kind);
  }
  return kinds.size === 2 ? 'mixed' : kinds.has('body') ? 'body' : 'snippet';
}

export function executionOverview(
  r: Log,
  res: Envelope,
  calls: Attempt[],
  groups: QueryGroup[],
  complete: boolean,
  lang: Lang,
) {
  const sent = calls.filter((c) => c.sent);
  const endpoints: ExecutionSummary['endpoints'] = { search: [], reader: [], model: [] };
  for (const kind of ['search', 'reader', 'model'] as const) {
    const ids = new Set(sent.filter((c) => c.kind === kind).map((c) => c.endpoint));
    endpoints[kind] = ids.has('')
      ? null
      : [...ids].map((id) => ({
          endpoint_id: wireId(id),
          endpoint_name: recordedEndpointName(r, id, lang),
        }));
  }
  const business = !originOf(r).endsWith('_test');
  const summary: ExecutionSummary = {
    retrieval: business && r.op !== 'content' ? retrievalCounts(sent, groups, complete) : null,
    score_batches: business && r.op === 'summary' ? scoringBatches(sent, complete) : null,
    answer_source: answerSource(r, res, complete),
    endpoints,
  };
  return { upstream_calls: sent.length, model_calls: sent.filter((c) => c.kind === 'model').length, summary };
}
