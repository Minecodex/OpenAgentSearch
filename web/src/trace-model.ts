import type { Entity } from "./api";

export const stageGroupKey = (stage: string) =>
  stage === "source" || stage === "extract" ? "materials" : stage;

export function executionGroups(spans: Entity[]) {
  const groups = new Map<string, Entity[]>();
  for (const span of spans) {
    const key = stageGroupKey(span.stage);
    if (groups.has(key)) groups.get(key)!.push(span);
    else groups.set(key, [span]);
  }
  return groups;
}

export type MaterialPage = {
  id: string;
  root?: Entity;
  candidate?: Entity;
  attempts: Entity[];
  title: string;
  url: string;
  status: string;
  duration: number;
};

export function materialPages(spans: Entity[], calls: Entity[], candidates: Entity[], details: Entity[] = []) {
  const roots = spans.filter(span => span.stage === "source");
  const pages: MaterialPage[] = [];
  const full = (span: Entity) => ({...span, input: details.find(d => d.span?.span_id === span.span_id)?.input || span.input});
  const create = (root: Entity | undefined, attempts: Entity[]) => {
    const sample = full(root || attempts[0]);
    const candidate = stageCandidate(sample, calls, candidates, spans);
    const call = calls.find(call => attempts.some(span => span.span_id === call.span_id));
    const url = candidate?.url || sample.input?.url || call?.input_preview || "";
    const start = Math.min(...attempts.map(s => s.start_offset_ms || 0));
    const end = Math.max(...attempts.map(s => (s.start_offset_ms || 0) + (s.duration_ms || 0)));
    return {id: root?.span_id || attempts[0].span_id, root, attempts, candidate, url,
      title: candidate?.title || url,
      status: root?.status || groupStatus(attempts),
      duration: root?.duration_ms ?? Math.max(0, end - start)};
  };
  for (const root of roots) pages.push(create(root, spans.filter(s => s.stage === "extract" && s.parent_id === root.span_id)));
  const orphans = new Map<string, Entity[]>();
  for (const span of spans.filter(s => s.stage === "extract" && !roots.some(root => root.span_id === s.parent_id))) {
    const candidate = stageCandidate(full(span), calls, candidates, spans);
    const call = calls.find(call => call.span_id === span.span_id);
    const key = candidate?.candidate_id || full(span).input?.url || call?.input_preview || span.span_id;
    if (orphans.has(key)) orphans.get(key)!.push(span);
    else orphans.set(key, [span]);
  }
  for (const attempts of orphans.values()) pages.push(create(undefined, attempts));
  return pages;
}

export function preferredMaterialSpan(page: MaterialPage) {
  return page.attempts.find(span => span.status === "success") || page.attempts[0] || page.root!;
}

export function rankedCandidates(candidates: Entity[]) {
  return [...candidates].sort((a, b) =>
    Number(!!b.selected) - Number(!!a.selected) || (b.score ?? -1) - (a.score ?? -1));
}

export function groupStatus(spans: Entity[]) {
  const states = spans.map(span => span.status);
  if (states.includes("running")) return "running";
  if (states.includes("partial")) return "partial";
  const completed = states.some(state => state === "success" || state === "empty");
  if (states.some(state => state === "error" || state === "cancelled")) {
    return completed ? "partial" : states.includes("error") ? "error" : "cancelled";
  }
  return states.every(state => state === "empty") ? "empty" : completed ? "success" : "unknown";
}

export function preferredStage(spans: Entity[]) {
  return (spans[0]?.stage === "extract" && spans.find(span => span.status === "success")) || spans[0];
}

export function stageCandidate(span: Entity, calls: Entity[], candidates: Entity[], allSpans: Entity[] = []) {
  const id = span.span_id || span.span?.span_id;
  const relatedIds = new Set([id, ...allSpans.filter(item => item.parent_id === id).map(item => item.span_id)]);
  const related = calls.filter(call => relatedIds.has(call.span_id));
  const input = span.input || {};
  return candidates.find(candidate =>
    (input.candidate_id && candidate.candidate_id === input.candidate_id)
    || (input.source_id && candidate.source_id === input.source_id)
    || (input.url && candidate.url?.split("#")[0] === input.url.split("#")[0])
    || related.some(call => candidate.candidate_id === call.candidate_id
      || (candidate.source_id && candidate.source_id === call.source_id)
      || candidate.reader_call_ids?.includes(call.call_id)));
}
