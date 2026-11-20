import { useEffect, useRef } from 'react';
import { ArrowRight, ChevronRight } from 'lucide-react';
import { useConsole } from './state';
import {
  attempts,
  endpointName,
  languageOf,
  reasonNames,
  rewriteGroups,
  type Attempt,
  type QueryGroup,
} from './diagnostic-data';
import { local, statusLabels, type Log } from './model';
import { type ExecutionSummary } from './execution-overview';
import { type RewriteJob } from './rewrite';
import { RewriteFacts } from './request-facts';
import { StateChip } from './ui';

function StageNumbers({ items }: { items: [string, string | number | null][] }) {
  return (
    <dl className="query-stage-numbers">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}
function AttemptDetails({ calls, record, label }: { calls: Attempt[]; record: Log; label: string }) {
  const { l, t, lang, cfg } = useConsole();
  if (!calls.length) return null;
  return (
    <details className="query-attempts">
      <summary>{label}</summary>
      {calls.map((c) => (
        <div className="query-attempt" key={c.id}>
          <div>
            <b>{endpointName(c.endpoint, cfg, lang, record)}</b>
            <small>
              {l(reasonNames[c.reason])} · {l(statusLabels[c.status])}
            </small>
          </div>
          <span>
            {t('排队', 'Queue')} {c.queue} ms · {t('执行', 'Execution')} {c.duration} ms
          </span>
          <code>{c.id}</code>
        </div>
      ))}
    </details>
  );
}
export function QueryStages({
  phase,
  record,
  groups,
  stageCalls,
  retrieval,
  job,
  focused,
  pick,
}: {
  phase: 'rewrite' | 'search';
  record: Log;
  groups: QueryGroup[];
  stageCalls: Attempt[];
  retrieval: ExecutionSummary['retrieval'];
  job?: RewriteJob;
  focused?: string;
  pick: (id: string) => void;
}) {
  const { t, lang, cfg, updateQuery } = useConsole(),
    language = languageOf(record),
    rewrite = phase === 'rewrite';
  const selected = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focused && phase === 'search') {
      selected.current?.focus({ preventScroll: true });
      selected.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [focused, phase, record.id]);
  const searchCalls = attempts(record).filter((c) => c.phase === 'search' && c.sent);
  const displayed = rewrite ? rewriteGroups(record, groups) : groups;
  const expanded = displayed.filter((g) => g.id !== 'Q0').length;
  const models = [
    ...new Set(
      stageCalls
        .filter((c) => c.kind === 'model' && c.sent)
        .map((c) => endpointName(c.endpoint, cfg, lang, record)),
    ),
  ];
  const duplicateCount =
    retrieval?.raw_candidates != null && retrieval.unique_candidates != null
      ? retrieval.raw_candidates - retrieval.unique_candidates
      : null;
  const count = (n: number | null | undefined) => n ?? null;
  return (
    <div className="query-stage" data-testid={'query-stage-' + phase}>
      <StageNumbers
        items={
          rewrite
            ? [
                [t('执行模型', 'Model used'), models.join(' / ') || '—'],
                [t('实际扩展', 'Additional queries'), expanded],
                [t('参与检索', 'Queries searched'), count(retrieval?.variant_count)],
              ]
            : [
                [t('执行查询', 'Queries searched'), count(retrieval?.variant_count)],
                [t('原始命中', 'Raw hits'), count(retrieval?.raw_candidates)],
                [t('唯一网页', 'Unique pages'), count(retrieval?.unique_candidates)],
                [t('重复命中', 'Duplicate hits'), duplicateCount],
              ]
        }
      />
      {rewrite && (
        <AttemptDetails
          calls={stageCalls.filter((c) => c.sent)}
          record={record}
          label={t('模型调用明细', 'Model call details')}
        />
      )}
      <div className="stage-groups">
        {displayed.map((g) => {
          const calls = searchCalls.filter((c) => c.variantId === g.id);
          const accepted = calls.filter((c) => c.status === 'success' || c.status === 'empty').at(-1);
          const outcome = accepted ?? calls.at(-1);
          const names = [...new Set(calls.map((c) => endpointName(c.endpoint, cfg, lang, record)))];
          return (
            <section
              className={'variant-fact' + (focused === g.id ? ' variant-focused' : '')}
              key={g.id}
              aria-label={g.id + ' ' + g.query}
            >
              <header tabIndex={-1} ref={focused === g.id ? selected : undefined}>
                <span className="query-kind">
                  <code>{g.id}</code>
                  <strong>
                    {g.id === 'Q0' ? t('原始查询', 'Original query') : t('扩展查询', 'Expanded query')}
                  </strong>
                </span>
                {rewrite ? (
                  <span className="query-state">
                    {calls.length ? t('已参与检索', 'Searched') : t('未派发', 'Not dispatched')}
                  </span>
                ) : outcome ? (
                  <StateChip value={outcome.status} />
                ) : (
                  <span className="query-state">{t('未派发', 'Not dispatched')}</span>
                )}
              </header>
              <p className="query-text">{g.query}</p>
              {rewrite ? (
                calls.length > 0 && (
                  <button
                    className="query-jump text-link"
                    onClick={() =>
                      updateQuery({
                        section: 'flow',
                        stage: 'search',
                        variant: g.id,
                        candidate: null,
                        segment: null,
                      })
                    }
                  >
                    {t('查看本条检索', 'Inspect this search')}
                    <ArrowRight size={13} />
                  </button>
                )
              ) : (
                <>
                  <dl className="query-dispatch">
                    <div>
                      <dt>{t('搜索接入点', 'Search endpoint')}</dt>
                      <dd>{names.join(' / ') || t('未调用', 'Not called')}</dd>
                    </div>
                    <div>
                      <dt>{t('已派发调用', 'Dispatched calls')}</dt>
                      <dd>{calls.length}</dd>
                    </div>
                    <div>
                      <dt>{t('命中网页', 'Page hits')}</dt>
                      <dd>{accepted ? g.hits.length : '—'}</dd>
                    </div>
                  </dl>
                  <AttemptDetails calls={calls} record={record} label={t('调用与耗时', 'Calls and timing')} />
                  {g.hits.length > 0 && accepted ? (
                    <details className="query-hits" open={focused ? focused === g.id : g.id === 'Q0'}>
                      <summary>
                        {t('候选网页', 'Candidate pages')} <b>{g.hits.length}</b>
                      </summary>
                      <ol>
                        {g.hits.map((h) => (
                          <li key={h.rank + '-' + h.article.id}>
                            <button onClick={() => pick(h.article.id)}>
                              <span className="hit-rank">{h.rank}</span>
                              <span className="hit-copy">
                                <strong>{local(h.article.name, language)}</strong>
                                <small>{new URL(h.article.url).hostname}</small>
                                <span>{local(h.article.points[0], language)}</span>
                              </span>
                              <ChevronRight size={15} />
                            </button>
                          </li>
                        ))}
                      </ol>
                    </details>
                  ) : (
                    <p className="query-empty">
                      {accepted
                        ? t('本条查询没有命中网页。', 'This query returned no pages.')
                        : outcome
                          ? t('此次调用未取得候选结果。', 'No candidate results were received.')
                          : t('没有已派发的检索调用。', 'No search call was dispatched.')}
                    </p>
                  )}
                </>
              )}
            </section>
          );
        })}
      </div>
      {rewrite && job && <RewriteFacts job={job} />}
      {rewrite && !expanded && searchCalls.length > 0 && (
        <p className="query-empty">{t('本次检索使用了原问题。', 'The search used the original question.')}</p>
      )}
    </div>
  );
}
