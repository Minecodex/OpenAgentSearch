import { QueryStages } from './query-stages';
import { recordedScope } from './trace-export';
import type { ExecutionSummary } from './execution-overview';
import { candidateFacts, selectionLabels } from './evidence';
import { checkRewriteContext, rewriteJob } from './rewrite';
import { ChevronRight } from 'lucide-react';
import { useConsole } from './state';
import { Attempt, QueryGroup, languageOf, queryText, uniqueHits } from './diagnostic-data';
import { scoringBatches } from './execution-overview';
import { Envelope, Log, local } from './model';
import { articles } from './fixtures';
import { KeyValues } from './diagnostic-ui';
import { ResultView } from './playground';
export function StageEvidence({
  phase,
  record,
  result,
  groups,
  calls,
  pick,
  variant,
  retrieval,
}: {
  phase: string;
  record: Log;
  result: Envelope;
  groups: QueryGroup[];
  calls: Attempt[];
  pick: (id: string, segment?: string) => void;
  variant?: string;
  retrieval: ExecutionSummary['retrieval'];
}) {
  const { t, lang } = useConsole(),
    language = languageOf(record);
  const all = groups.flatMap((g) => g.hits);
  const candidates = uniqueHits(groups);
  const sources = result.data?.sources ?? [];
  if (phase === 'rewrite' || phase === 'search') {
    const context = checkRewriteContext(record.input ?? {}),
      limit = recordedScope(record)?.rewriteCount;
    const job =
      phase === 'rewrite' && context.ok && limit !== undefined
        ? rewriteJob(queryText(record), language, limit, context.value)
        : undefined;
    return (
      <QueryStages
        phase={phase}
        record={record}
        groups={groups}
        stageCalls={calls}
        retrieval={retrieval}
        job={job}
        focused={variant}
        pick={pick}
      />
    );
  }
  if (phase === 'dedup')
    return (
      <>
        <div className="stage-facts">
          <b>
            {all.length} → {candidates.length}
          </b>
          <span>{t('原始命中 → 唯一网页', 'Raw hits → unique pages')}</span>
        </div>
        <div className="candidate-rows">
          {candidates.map((h) => (
            <button key={h.article.id} onClick={() => pick(h.article.id)}>
              <span>
                <b>{local(h.article.name, language)}</b>
                <small>{h.article.url}</small>
              </span>
              <em>
                {groups
                  .filter((g) => g.hits.some((x) => x.article.id === h.article.id))
                  .map((g) => g.id)
                  .join(' + ')}
              </em>
              <ChevronRight size={14} />
            </button>
          ))}
        </div>
      </>
    );
  if (phase === 'score')
    return (
      <>
        <div className="stage-facts">
          <b>
            {t('评分批次', 'Score batches')} ·{' '}
            {scoringBatches(calls, true)
              ?.map((b) => b.batch_id)
              .join(' / ') || '—'}
          </b>
          <span>
            {candidates.length} {t('个候选', 'candidates')} ·{' '}
            {candidates.filter((h) => h.relevant === true).length} {t('个相关', 'relevant')} ·{' '}
            {t('来源上限', 'Source limit')}{' '}
            {Number(record.input?.source_count ?? record.snapshot?.sourceLimit ?? 4)}
          </span>
        </div>
        <div className="candidate-rows">
          {candidates.map((h) => (
            <button key={h.article.id} onClick={() => pick(h.article.id)}>
              <span>
                <b>{local(h.article.name, language)}</b>
                <small>
                  {new URL(h.article.url).hostname} ·{' '}
                  {local(selectionLabels[candidateFacts(h.article, record, result, groups).reason], lang)}
                </small>
              </span>
              <code>{h.score ?? '—'}</code>
              <em>
                {h.relevant === null
                  ? t('未评分', 'Unscored')
                  : h.relevant
                    ? t('相关', 'Relevant')
                    : t('不相关', 'Irrelevant')}
              </em>
              <ChevronRight size={14} />
            </button>
          ))}
        </div>
      </>
    );
  if (phase === 'extract')
    return (
      <div className="candidate-rows">
        {calls.map((c) => {
          const a = articles.find((x) => x.url === c.target);
          return (
            <button
              key={c.id}
              onClick={() => {
                if (a) pick(a.id);
              }}
              disabled={!a}
            >
              <span>
                <b>{a ? local(a.name, language) : c.target}</b>
                <small>{c.target}</small>
              </span>
              <em>{c.chars === null ? t('取文失败', 'No body') : c.chars + ' ' + t('字符', 'chars')}</em>
              <code>{c.duration} ms</code>
              <ChevronRight size={14} />
            </button>
          );
        })}
      </div>
    );
  if (phase === 'segments') {
    const citations = result.data?.citations ?? [];
    return (
      <div className="candidate-rows segment-rows">
        {sources.map(
          (source: {
            id: string;
            title: string;
            url: string;
            kind: string;
            segments: { id: string; summary: string }[];
          }) => {
            const cited = new Set(
              citations
                .filter((c: { source_id: string }) => c.source_id === source.id)
                .map((c: { segment_id: string }) => c.segment_id),
            );
            const article = articles.find((a) => a.url === source.url);
            return (
              <button key={source.id} disabled={!article} onClick={() => article && pick(article.id)}>
                <span>
                  <b>{source.title}</b>
                  <small>{source.segments[0]?.summary}</small>
                  <span className="segment-meta">
                    {source.kind === 'snippet'
                      ? t('搜索简介', 'Search snippet')
                      : t('网页正文', 'Article body')}{' '}
                    · {source.segments.length} {t('段', 'passages')} · {cited.size} {t('段被引用', 'cited')}
                  </span>
                </span>
                <code>{source.id}</code>
                <ChevronRight size={14} />
              </button>
            );
          },
        )}
      </div>
    );
  }
  if (phase === 'synthesis' || phase === 'render')
    return <ResultView op={record.op} response={result} inspect={pick} />;
  return (
    <KeyValues
      items={[
        [t('输入', 'Input'), queryText(record)],
        [t('本阶段上游调用', 'Upstream attempts'), String(calls.length)],
        [t('状态', 'Outcome'), result.error?.code ?? record.status],
      ]}
    />
  );
}
