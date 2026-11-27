import type { Entity } from "./api";

export function recordedSearchHits(hits: Entity[], candidates: Entity[]) {
  const pages = new Map<string, Entity>();
  for (const candidate of candidates) {
    for (const url of [candidate.url, ...(candidate.hits || []).map((hit: Entity) => hit.url)]) {
      if (url && !pages.has(url.split("#")[0])) pages.set(url.split("#")[0], candidate);
    }
  }
  return hits.map(hit => {
    const candidate = hit.url ? pages.get(hit.url.split("#")[0]) : undefined;
    return { ...hit, candidate_id: candidate?.candidate_id };
  });
}

export function cacheLookupView(span: Entity, evidence: Entity) {
  const archived = (evidence.cache_lookups || []).find((row: Entity) =>
    (span.output?.lookup_id && row.lookup_id === span.output.lookup_id) ||
    (span.span?.span_id && row.span_id === span.span.span_id));
  const output = { ...archived, ...span.output };
  const lookup = output.lookup_id;
  const candidates: Entity[] = evidence.candidates || [];
  const variant = lookup && (evidence.variants || []).find((v: Entity) =>
    v.cache_lookup_id === lookup || v.hits?.some((h: Entity) => h.cache?.lookup_id === lookup));
  const query = span.input?.query || output.query || variant?.query;
  const recorded = Array.isArray(variant?.hits);
  const raw: Entity[] = recorded
    ? variant.hits.filter((h: Entity) => h.cache?.lookup_id === lookup || (!h.cache?.lookup_id && variant.cache_lookup_id === lookup))
    : [];
  if (!recorded && lookup) {
    for (const candidate of candidates) {
      for (const hit of candidate.hits || []) {
        if (hit.cache?.lookup_id === lookup) raw.push({ ...hit, url: hit.url || candidate.url, title: candidate.title, snippet: candidate.snippet_preview });
      }
    }
    raw.sort((a, b) => a.rank - b.rank);
  }

  const questions: string[] = output.questions || [];
  // Older single-source lookups required a background search for every non-exact match.
  const legacyExact = output.hit === true && questions.length === 1 && output.search_needed === false;
  const snapshots: Entity[] = output.matched_snapshots ?? (output.snapshot_ids || []).map((id: string) => {
    const origin = raw.find(hit => hit.cache?.snapshot_id === id)?.cache;
    return { snapshot_id: id, source: origin?.source, collected_at: origin?.collected_at,
      query: legacyExact ? query : undefined, exact: legacyExact };
  });
  const verification = output.verification;
  const decisions: Entity[] = verification?.decisions || [];
  const reviewed = (verification?.shortlisted_question_ids ?? decisions.map(d => d.question_id)).map((id: string) => ({
    id, question: verification?.question_texts?.[id] || snapshots.find(s => s.question_id === id)?.query,
    decision: decisions.find(d => d.question_id === id),
    selected: questions.includes(id),
  }));
  return { output, query, variant, snapshots, reviewed, recorded, hits: recordedSearchHits(raw, candidates),
    exact: snapshots.some(s => s.exact) || legacyExact };
}
