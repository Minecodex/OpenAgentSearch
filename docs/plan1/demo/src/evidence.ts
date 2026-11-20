import { Article, Envelope, Lang, Log, local } from './model';
import { attempts, languageOf, QueryGroup, uniqueHits } from './diagnostic-data';
import { articleData, capturedPassages } from './engine';

export function candidateFacts(a: Article, r: Log, result: Envelope, groups: QueryGroup[]) {
  const language = languageOf(r),
    calls = attempts(r);
  const hits = groups.flatMap((g) =>
    g.hits
      .filter((h) => h.article.id === a.id)
      .map((h) => ({
        g,
        h,
        call: calls.find((c) => c.sent && c.variantId === g.id && c.status === 'success'),
      })),
  );
  const score = hits.find((x) => x.h.score !== null)?.h ?? hits[0]?.h;
  const read = calls.find((c) => c.phase === 'extract' && c.target === a.url),
    scoring = calls.find((c) => c.sent && c.scoreBatch?.candidateIds.includes(a.id));
  const source = result.data?.sources?.find((s: { url: string }) => s.url === a.url);
  const usedInList = !!result.data?.items?.some((s: { url: string }) => s.url === a.url);
  const usedInRead = r.op === 'content' && result.data?.url === a.url;
  const inline =
    source?.kind === 'body' &&
    r.snapshot?.endpoints?.[r.resources?.search ?? '']?.adapter === 'integrated_search';
  const limit =
    r.op === 'content'
      ? Number(r.input?.max_chars ?? r.snapshot?.bodyLimit ?? 40000)
      : (r.snapshot?.bodyLimit ?? 40000);
  const body = (read?.status === 'success' || inline) && !a.snippetOnly ? articleData(a, limit) : null;
  const material = source ? capturedPassages(a, limit, language, source.kind) : [];
  const cited = new Set<string>(
    (result.data?.citations ?? [])
      .filter((c: { source_id: string }) => c.source_id === source?.id)
      .map((c: { segment_id: string }) => c.segment_id),
  );
  const selected = !!read || !!source || usedInList || usedInRead;
  const reason =
    source || usedInList || usedInRead
      ? 'used'
      : read
        ? 'material_lost'
        : score?.relevant === false
          ? 'irrelevant'
          : score?.relevant === true
            ? 'source_limit'
            : 'unscored';
  return {
    hits,
    score,
    read,
    scoring,
    source,
    usedInList,
    usedInRead,
    inline,
    body,
    material,
    cited,
    selected,
    reason,
  };
}
export const selectionLabels: Record<string, [string, string]> = {
  used: ['已进入结果', 'Used in result'],
  material_lost: ['材料未取得', 'Material unavailable'],
  irrelevant: ['不相关', 'Irrelevant'],
  source_limit: ['超过来源上限', 'Outside source limit'],
  unscored: ['未取得合法评分', 'Missing valid score'],
};

export function evidenceView(r: Log, res: Envelope, groups: QueryGroup[], lang: Lang) {
  const facts = uniqueHits(groups).map(({ article: a }) => ({ a, f: candidateFacts(a, r, res, groups) }));
  return {
    variants: groups.map((g) => ({ variant_id: g.id, query: g.query })),
    candidates: facts.map(({ a, f }) => ({
      candidate_id: a.id,
      url: a.url,
      title: local(a.name, lang),
      snippet_preview: local(a.points[0], lang),
      hits: f.hits.flatMap(({ g, h, call }) =>
        call ? [{ variant_id: g.id, call_id: call.id, url: h.url, rank: h.rank }] : [],
      ),
      relevant: f.score?.relevant ?? null,
      score: f.score?.score ?? null,
      score_batch_id: f.scoring?.scoreBatch?.id ?? null,
      score_call_id: f.scoring?.id ?? null,
      selected: f.selected,
      selection_reason: f.reason,
      source_id: f.source?.id ?? null,
      material: f.inline
        ? 'inline_body'
        : f.source?.kind === 'body'
          ? 'reader_body'
          : f.source?.kind === 'snippet' || f.usedInList
            ? 'snippet'
            : null,
      reader_call_ids: f.read ? [f.read.id] : [],
      article_preview: f.body?.text ?? null,
      ...(f.body ? { lengths: f.body.lengths } : {}),
    })),
    sources: facts.flatMap(({ a, f }) =>
      f.source
        ? [
            {
              source_id: f.source.id,
              url: a.url,
              title: f.source.title,
              ranks: f.hits.map((x) => x.h.rank),
              variant_ids: f.hits.map((x) => x.g.id),
              score: f.source.score,
            },
          ]
        : [],
    ),
    segments: facts.flatMap(({ f }) =>
      f.source
        ? f.material.map((m) => ({
            source_id: f.source.id,
            segment_id: m.id,
            start_char: m.start,
            end_char: m.end,
            summary: m.summary,
            cited: f.cited.has(m.id),
            text_preview: m.text,
          }))
        : [],
    ),
  };
}
