import { SourceLink } from './ui';
import { candidateFacts, selectionLabels } from './evidence';
import { ArrowUpRight } from 'lucide-react';
import { Article, Envelope, Log, local } from './model';
import { languageOf, QueryGroup } from './diagnostic-data';
import { useConsole } from './state';
import { KeyValues, SideSheet } from './diagnostic-ui';
export function CandidateSheet({
  article: a,
  record: r,
  result,
  groups,
  close,
  jump,
  segment,
}: {
  article: Article;
  record: Log;
  result: Envelope;
  groups: QueryGroup[];
  close: () => void;
  jump: (key: string) => void;
  segment?: string;
}) {
  const { t, lang } = useConsole(),
    language = languageOf(r);
  const {
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
  } = candidateFacts(a, r, result, groups);
  const sections = [
    ...(hits.length ? [['search', t('检索', 'Search')]] : []),
    ...(scoring ? [['score', t('评分', 'Score')]] : []),
    ...(read ? [['extract', t('正文', 'Article')]] : []),
    ...(source ? [['segments', t('分段', 'Passages')]] : []),
  ];
  return (
    <SideSheet title={t('候选材料', 'Candidate evidence')} close={close}>
      <h3>{local(a.name, language)}</h3>
      <SourceLink url={a.url} />
      <div className="stage-shortcuts">
        {sections.map(([k, lab]) => (
          <button key={k} className="text-link" onClick={() => jump(k)}>
            {lab}
            <ArrowUpRight size={12} />
          </button>
        ))}
      </div>
      <KeyValues
        items={[
          [t('候选 / 来源 ID', 'Candidate / source ID'), a.id + ' / ' + (source?.id ?? '—')],
          [
            t('是否进入处理', 'Selected for processing'),
            selected ? t('已选择', 'Selected') : t('未选择', 'Not selected'),
          ],
          [
            t('是否用于结果', 'Used in result'),
            source || usedInList || usedInRead ? t('已采用', 'Used') : t('未采用', 'Unused'),
          ],
          [
            t('相关性 / 评分', 'Relevance / score'),
            (score?.relevant == null
              ? t('未知', 'Unknown')
              : score.relevant
                ? t('相关', 'Relevant')
                : t('不相关', 'Irrelevant')) +
              ' / ' +
              (score?.score ?? '—'),
          ],
          [t('选材结果', 'Selection outcome'), local(selectionLabels[reason], lang)],
          [
            t('评分批次 / 调用', 'Batch / model call'),
            scoring?.scoreBatch ? scoring.scoreBatch.id + ' · ' + scoring.id : '—',
          ],
          [
            t('材料来源', 'Material source'),
            source?.kind === 'snippet' || usedInList
              ? t('搜索简介', 'Search snippet')
              : source?.kind === 'body' || usedInRead
                ? t('网页正文', 'Article body')
                : '—',
          ],
        ]}
      />
      <section>
        <h3>{t('命中与去重', 'Hits and deduplication')}</h3>
        {hits.map(({ g, h, call }) => (
          <div key={g.id} className="candidate-passage">
            <b>
              {g.id} · {t('上游排名', 'Upstream rank')} {h.rank}
            </b>
            <p>{g.query}</p>
            {call && <small className="row-sub mono">{call.id}</small>}
            <code className="wrap-code">{h.url}</code>
          </div>
        ))}
        <p className="panel-help">
          {t('规范 URL', 'Canonical URL')} · {a.url}
        </p>
      </section>
      <section>
        <h3>{t('搜索简介', 'Search snippet')}</h3>
        <p>{local(a.points[0], language)}</p>
      </section>
      <section>
        <h3>{t('正文获取', 'Article retrieval')}</h3>
        {read || inline ? (
          <>
            <KeyValues
              items={[
                [t('调用 ID', 'Call ID'), read?.id ?? t('搜索随附正文', 'Inline search material')],
                [
                  t('执行 / 排队', 'Execution / queue'),
                  read ? read.duration + ' / ' + read.queue + ' ms' : '—',
                ],
                [
                  t('结果', 'Outcome'),
                  inline || read?.status === 'success'
                    ? t('取得正文', 'Received')
                    : t('提取失败', 'Retrieval failed'),
                ],
                [
                  t('正文原长 / 保留', 'Plain text original / retained'),
                  body ? body.lengths.text.original + ' / ' + body.lengths.text.retained : '—',
                ],
                [
                  t('Markdown 原长 / 保留', 'Markdown original / retained'),
                  body ? body.lengths.markdown.original + ' / ' + body.lengths.markdown.retained : '—',
                ],
              ]}
            />
            {body && (
              <details className="raw-facts">
                <summary>{t('展开采集的原文', 'Show captured article')}</summary>
                <pre className="code-box">{body.text}</pre>
              </details>
            )}
          </>
        ) : (
          <p className="panel-help">
            {t('未记录该候选的正文调用。', 'No article attempt was recorded for this candidate.')}
          </p>
        )}
      </section>
      {source && (
        <section>
          <h3>{t('被采用的分段', 'Saved passages')}</h3>
          {source.segments.map((seg: { id: string; summary: string }) => {
            const evidence = material.find((x) => x.id === seg.id);
            return (
              <div
                key={seg.id}
                className={'candidate-passage' + (segment === seg.id ? ' focused-passage' : '')}
                ref={(el) => {
                  if (el && seg.id === segment) el.scrollIntoView({ block: 'nearest' });
                }}
              >
                <code>
                  {source.id}/{seg.id} ·{' '}
                  {cited.has(seg.id) ? t('整体总结已引用', 'Cited in synthesis') : t('已保留', 'Retained')}
                </code>
                <p>{seg.summary}</p>
                {evidence && (
                  <details className="raw-facts" open={segment === seg.id || undefined}>
                    <summary>
                      {t('文内范围', 'Character range')} [{evidence.start}, {evidence.end})
                    </summary>
                    <p>{evidence.text}</p>
                  </details>
                )}
              </div>
            );
          })}
        </section>
      )}
    </SideSheet>
  );
}
