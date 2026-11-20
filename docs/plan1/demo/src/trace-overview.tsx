import { answerSources } from './display-values';
import type { ReactNode } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { useConsole } from './state';
import { StateChip } from './ui';
import { type Kind, type Log, digits } from './model';
import type { executionOverview, ExecutionSummary } from './execution-overview';
import { originOf } from './diagnostic-data';

function Metric({
  id,
  label,
  children,
  note,
  hint,
  open,
}: {
  id: string;
  label: string;
  children: ReactNode;
  note?: string;
  hint?: string;
  open?: { label: string; run: () => void };
}) {
  return (
    <div data-testid={'trace-fact-' + id}>
      <dt>{label}</dt>
      <dd>
        {open ? (
          <button
            type="button"
            className="trace-fact-link"
            onClick={open.run}
            title={hint ?? open.label}
            aria-label={open.label}
          >
            <span>{children}</span>
            <ArrowUpRight size={12} aria-hidden="true" />
          </button>
        ) : (
          <span className="trace-fact-value" title={hint}>
            {children}
          </span>
        )}
        {note && <small>{note}</small>}
      </dd>
    </div>
  );
}

const endpointLabels = {
  search: ['搜索接入点', 'Search endpoint'],
  reader: ['正文接入点', 'Reader endpoint'],
  model: ['模型接入点', 'Model endpoint'],
} as const;
const numberOrDash = (n: number | null) => (n === null ? '—' : digits(n));

export function TraceOverview({
  record,
  facts,
  complete,
  searchStage,
  sourceTotals,
  show,
}: {
  record: Log;
  facts: ReturnType<typeof executionOverview>;
  complete: boolean;
  searchStage?: string;
  sourceTotals?: { sources: number; passages: number };
  show: (section: string, stage?: string, kind?: Kind) => void;
}) {
  const { t, l } = useConsole();
  const { retrieval, score_batches: batches, answer_source: source, endpoints } = facts.summary;
  const test = originOf(record).endsWith('_test');
  const unknown = t('未记录', 'Not recorded'),
    na = t('不适用', 'Not applicable');
  const hasScore = !test && record.op === 'summary';
  const duration =
    record.duration < 1000 ? record.duration + ' ms' : (record.duration / 1000).toFixed(2) + ' s';
  const retrievalValue = retrieval
    ? [
        numberOrDash(retrieval.variant_count),
        ' · ',
        numberOrDash(retrieval.raw_candidates),
        ' → ',
        numberOrDash(retrieval.unique_candidates),
      ].join('')
    : na;
  const batchSizes = batches?.length ? batches.map((b) => numberOrDash(b.candidate_count)).join(' + ') : '';
  const originLabel = source === null ? (test ? na : unknown) : l(answerSources[source]);
  const openCalls = { label: t('查看全部上游调用', 'View all upstream calls'), run: () => show('endpoints') };
  const endpointCell = (kind: Kind, list: ExecutionSummary['endpoints'][Kind]) => {
    const label = l(endpointLabels[kind]);
    const names = list?.map((e) => e.endpoint_name ?? e.endpoint_id);
    return (
      <Metric
        key={kind}
        id={kind}
        label={label}
        hint={names?.join(' · ')}
        open={
          names?.length
            ? {
                label: t('查看', 'Inspect ') + label + t('的实际调用', ' calls'),
                run: () => show('endpoints', undefined, kind),
              }
            : undefined
        }
      >
        {names?.length ? (
          <>
            {names[0]}
            {names.length > 1 && <em>+{names.length - 1}</em>}
          </>
        ) : list === null ? (
          unknown
        ) : (
          t('未调用', 'Not called')
        )}
      </Metric>
    );
  };
  return (
    <section className="trace-overview" aria-label={t('请求执行概览', 'Request execution overview')}>
      <dl>
        <Metric id="status" label={t('业务状态', 'Business status')}>
          <StateChip value={record.status} />
        </Metric>
        <Metric id="duration" label={t('耗时', 'Duration')} hint={digits(record.duration) + ' ms'}>
          {duration}
        </Metric>
        <Metric
          id="calls"
          label={t('上游调用总数', 'Upstream calls')}
          note={t('其中模型 ', 'Model calls ') + digits(facts.model_calls)}
          open={facts.upstream_calls ? openCalls : undefined}
        >
          {digits(facts.upstream_calls)}
        </Metric>
        <Metric
          id="retrieval"
          label={t('检索变体 · 候选去重', 'Variants · deduplication')}
          note={retrieval ? t('变体 · 原始 → 唯一', 'Variants · raw → unique') : undefined}
          open={
            searchStage
              ? {
                  label: t('查看检索与去重依据', 'Inspect retrieval and deduplication'),
                  run: () => show('flow', searchStage),
                }
              : undefined
          }
        >
          {retrievalValue}
        </Metric>
        <Metric
          id="batches"
          label={t('评分批次', 'Scoring batches')}
          note={batchSizes ? t('各批候选 ', 'Batch sizes ') + batchSizes : undefined}
          open={
            batches?.length
              ? { label: t('查看评分批次', 'Inspect scoring batches'), run: () => show('flow', 'score') }
              : undefined
          }
        >
          {batches ? digits(batches.length) : hasScore ? unknown : na}
        </Metric>
        <Metric
          id="source"
          label={t('答案来源', 'Answer source')}
          note={
            sourceTotals
              ? sourceTotals.sources +
                t(' 来源 · ', ' sources · ') +
                sourceTotals.passages +
                t(' 段', ' passages')
              : undefined
          }
          open={
            source && source !== 'none'
              ? { label: t('查看答案与来源', 'Inspect answer and sources'), run: () => show('response') }
              : undefined
          }
        >
          {originLabel}
        </Metric>
        <Metric
          id="recording"
          label={t('记录信息', 'Recording')}
          open={{
            label: t('查看记录完整性', 'Inspect recording completeness'),
            run: () => show('recording'),
          }}
        >
          <span className={'trace-recording ' + (complete ? 'complete' : 'incomplete')}>
            <i aria-hidden="true" />
            {complete ? t('记录完整', 'Complete') : t('部分缺失', 'Incomplete')}
          </span>
        </Metric>
        {endpointCell('search', endpoints.search)}
        {endpointCell('reader', endpoints.reader)}
        {endpointCell('model', endpoints.model)}
      </dl>
    </section>
  );
}
