import { stagesFor, recordedScope, buildTraceExport } from './trace-export';
import { traceMarkdown } from './trace-markdown';
import { RequestFacts } from './request-facts';
import { languageName, testReason } from './display-values';
import { executionOverview } from './execution-overview';
import { TraceOverview } from './trace-overview';
import { CandidateSheet } from './candidate-sheet';
import { useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowLeft, ArrowUpRight, Clipboard, FileText, Search } from 'lucide-react';
import { useConsole } from './state';
import { articles } from './fixtures';
import { type Kind, digits, endpointPath, kinds, opLabels } from './model';
import {
  attempts,
  endpointName,
  languageOf,
  originNames,
  originOf,
  phaseNames,
  previewOf,
  projectOf,
  sampleConfig,
  projectLabel,
  queryText,
  recordingComplete,
  reasonNames,
  responseFor,
  resultCode,
  retrievalGroups,
  rewriteGroups,
} from './diagnostic-data';
import { stamp } from './investigation';
import { Btn, Caption, Empty, PageHead, Panel, Segments, download, useCopy, IconBtn } from './ui';
import { KeyValues } from './diagnostic-ui';
import { ResultView } from './playground';
import { StageEvidence } from './stage-evidence';
export function RequestDetail() {
  const { id, t, l, lang, cfg, logs, query, updateQuery, go } = useConsole();
  const r = useMemo(() => logs.find((x) => x.id === id), [logs, id]);
  const params = useMemo(() => new URLSearchParams(query), [query]);
  const tab = params.get('section') || 'flow';
  const variant = params.get('variant') || '';
  const candidate = params.get('candidate') || '';
  function setCandidate(id: string, segment?: string) {
    updateQuery({ candidate: id || null, segment: segment || null });
  }
  const [answer, setAnswer] = useState(false);
  const copy = useCopy();
  const workbench = useRef<HTMLDivElement>(null);
  const res = useMemo(() => (r ? responseFor(r, lang) : null), [r, lang]);
  const stages = useMemo(() => (r ? stagesFor(r) : []), [r]);
  function back() {
    const parent = params.get('back');
    if (parent === 'playground' || parent === 'endpoints' || parent === 'proxies') {
      go(parent, '', params.get('returnQuery') || '');
      return;
    }
    if (params.get('back') === 'overview') {
      go('overview');
      return;
    }
    if (params.get('back') === 'observability') go('observability', '', params.get('returnQuery') || '');
    else {
      const q = new URLSearchParams(params);
      for (const k of [
        'section',
        'format',
        'stage',
        'variant',
        'epKind',
        'candidate',
        'segment',
        'back',
        'returnQuery',
      ])
        q.delete(k);
      go('requests', '', q.toString());
    }
  }
  const backText =
    params.get('back') === 'playground'
      ? t('返回调试台', 'Back to playground')
      : params.get('back') === 'proxies'
        ? t('返回代理列表', 'Back to proxies')
        : params.get('back') === 'endpoints'
          ? t('返回接入点', 'Back to endpoints')
          : params.get('back') === 'overview'
            ? t('返回运行总览', 'Back to overview')
            : params.get('back') === 'observability'
              ? t('返回调用明细', 'Back to calls')
              : t('返回请求列表', 'Back to requests');
  const backBtn = (
    <button className="back-diag" data-testid="trace-back" onClick={back}>
      <ArrowLeft size={14} />
      {backText}
    </button>
  );
  if (!r || !res)
    return (
      <>
        {backBtn}
        <Panel>
          <Empty text={t('该请求记录不可用。', 'This request record is unavailable.')} />
        </Panel>
      </>
    );
  const step = stages.find((x) => x.key === params.get('stage')) ?? stages[0],
    calls = attempts(r);
  const origin = originOf(r),
    isTest = origin.endsWith('_test'),
    complete = recordingComplete(r),
    project = projectOf(r);
  const title = queryText(r),
    responsePreview = previewOf(r, lang);
  const sources = res.data?.sources || [];
  const command =
    r.input ?? (r.op === 'content' ? { url: title } : { query: title, language: languageOf(r) });
  const windowZone = zonesFromBack(params);
  const scope = recordedScope(r);
  const defaults = {
    ...scope,
    language: scope?.wire?.project.default_language ?? (!r.generated ? project.language : languageOf(r)),
  };
  const groups = retrievalGroups(r);
  const overview = executionOverview(r, res, calls, groups, complete, lang);
  const kindParam = params.get('epKind');
  const callKind = kindParam && Object.hasOwn(kinds, kindParam) ? (kindParam as Kind) : null;
  const displayedCalls = calls.filter((c) => c.sent && (!callKind || c.kind === callKind));
  const selected = articles.find((a) => a.id === candidate);
  function saveRecord() {
    if (r) download(r.id + '.md', traceMarkdown(buildTraceExport(r, cfg, lang), lang));
  }
  const sourceTotals =
    r.op === 'summary' && !isTest && complete && Array.isArray(res.data?.sources)
      ? {
          sources: sources.length,
          passages: sources.reduce((n: number, s: { segments: unknown[] }) => n + s.segments.length, 0),
        }
      : undefined;
  const searchStage = stages.find((s) => s.key === 'dedup') ?? stages.find((s) => s.key === 'search');
  function inspect(section: string, stage?: string, kind?: Kind) {
    updateQuery({
      section,
      stage: stage ?? null,
      epKind: kind ?? null,
      format: null,
      candidate: null,
      segment: null,
    });
    requestAnimationFrame(() => {
      workbench.current?.focus({ preventScroll: true });
      workbench.current?.scrollIntoView({ block: 'nearest' });
    });
  }
  const sumPanel = (
    <div className="trace-summary-grid">
      <section>
        <span className="section-label">
          <Search size={15} />
          {r.op === 'content' ? t('网页地址', 'Article URL') : t('输入问题', 'Input question')}
        </span>
        <div className="trace-question">
          <h2>{title}</h2>
          <IconBtn
            icon={Clipboard}
            label={t('复制请求内容', 'Copy request input')}
            onPress={() => void copy(title)}
          />
        </div>
        <small className="row-sub">
          <code>{r.id}</code> · {l(originNames[origin])} · {stamp(r.time, windowZone)}
        </small>
        {complete && groups.length > 1 && (
          <div className="query-variants">
            {groups.slice(1).map((g) => (
              <button
                key={g.id}
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
                <b>{g.id}</b> {g.query}
              </button>
            ))}
          </div>
        )}
      </section>
      <section>
        <span className="section-label">
          <FileText size={15} />
          {t('结果摘要', 'Result preview')}
          {complete && res.data?.summary && (
            <small>
              {[...res.data.summary].length} {t('字符', 'characters')}
            </small>
          )}
        </span>
        <p className={answer ? '' : 'clamped'}>
          {complete
            ? responsePreview
            : t(
                '已记录状态，详细响应载荷未保存。',
                'Outcome recorded; detailed response payload was not saved.',
              )}
        </p>
        {complete && responsePreview.length > 90 && (
          <button className="text-link" onClick={() => setAnswer(!answer)}>
            {answer ? t('收起', 'Collapse') : t('展开全文', 'Expand answer')}
          </button>
        )}
      </section>
    </div>
  );
  const detailTab = (section: string) => updateQuery({ section, stage: null, variant: null, epKind: null });
  return (
    <div className="trace-detail trace-dossier">
      {backBtn}
      <PageHead
        title={isTest ? l(originNames[origin]) : l(opLabels[r.op])}
        sub={
          (isTest ? t('功能测试', 'Capability test') : 'POST ' + endpointPath(r.op)) +
          ' · ' +
          projectLabel(r, cfg, lang)
        }
      >
        <Btn onPress={saveRecord}>
          <ArrowDownToLine size={15} />
          {t('导出记录', 'Export trace')}
        </Btn>
      </PageHead>
      <Panel className="dossier-head">
        {sumPanel}
        <TraceOverview
          record={r}
          facts={overview}
          complete={complete}
          searchStage={searchStage?.key}
          sourceTotals={sourceTotals}
          show={inspect}
        />
      </Panel>
      {!complete && (
        <div className="diag-warning">
          {t(
            '记录包含缺失的载荷。保留的阶段和上游明细仍可查看。',
            'Some payloads are missing. Recorded stages and upstream calls remain available.',
          )}
        </div>
      )}
      <div className="dossier-toolbar" ref={workbench} tabIndex={-1}>
        <Segments
          label={t('请求详情', 'Request detail')}
          value={tab}
          change={detailTab}
          items={[
            { id: 'flow', label: t('执行过程', 'Execution') },
            { id: 'response', label: t('请求与结果', 'Request and result') },
            { id: 'snapshot', label: t('配置快照', 'Configuration') },
            { id: 'recording', label: t('记录信息', 'Recording') },
            { id: 'endpoints', label: t('接入点', 'Endpoints') },
          ]}
        />
      </div>
      {tab === 'flow' ? (
        <Panel className="stage-board waterfall">
          <div className="stage-list">
            <h3>{t('执行阶段', 'Execution stages')}</h3>
            {stages.map((s) => (
              <button
                className={'water-row step-pick ' + (s.key === step.key ? 'chosen' : '')}
                key={s.key}
                data-testid={'stage-' + s.key}
                onClick={() => updateQuery({ stage: s.key, variant: null })}
                aria-pressed={s.key === step.key}
              >
                <i className={'stage-point ' + s.status} />
                <span className="step-label">
                  <b>{l(phaseNames[s.key])}</b>
                  {complete && s.key === 'rewrite' && (
                    <span>
                      {t('扩展查询', 'Additional queries')} ·{' '}
                      {rewriteGroups(r, groups).filter((g) => g.id !== 'Q0').length}
                    </span>
                  )}
                  {complete && s.key === 'search' && overview.summary.retrieval && (
                    <span>
                      {overview.summary.retrieval.variant_count ?? '—'} {t('条查询', 'queries')} ·{' '}
                      {overview.summary.retrieval.raw_candidates ?? '—'} {t('条命中', 'hits')}
                    </span>
                  )}
                </span>
                <small>{s.duration} ms</small>
              </button>
            ))}
          </div>
          <div className="stage-inspect">
            <div className="stage-heading">
              <h2>{l(phaseNames[step.key])}</h2>
              <span className="mono">
                {step.start}–{step.start + step.duration} ms
              </span>
            </div>
            <div className="stage-duration">
              <i
                style={{
                  left: (100 * step.start) / Math.max(1, r.duration) + '%',
                  width: Math.max(1, (100 * step.duration) / Math.max(1, r.duration)) + '%',
                }}
              />
            </div>
            <>
              {step.key === 'admit' && complete && !isTest ? (
                <RequestFacts op={r.op} input={command} defaults={defaults} />
              ) : step.key === 'admit' ? (
                <KeyValues
                  items={[
                    [t('业务操作', 'Operation'), isTest ? l(originNames[origin]) : l(opLabels[r.op])],
                    [t('业务语言', 'Language'), languageName(languageOf(r), lang)],
                    [t('项目', 'Project'), projectLabel(r, cfg, lang)],
                    [t('请求 ID', 'Request ID'), r.id],
                  ]}
                />
              ) : complete && !isTest ? (
                <StageEvidence
                  phase={step.key}
                  record={r}
                  result={res}
                  groups={groups}
                  retrieval={overview.summary.retrieval}
                  calls={step.calls}
                  variant={variant}
                  pick={setCandidate}
                />
              ) : (
                <KeyValues
                  items={[
                    [t('阶段', 'Stage'), l(phaseNames[step.key])],
                    [
                      t('记录载荷', 'Captured payload'),
                      complete ? t('功能测试', 'Capability test') : t('不可用', 'Unavailable'),
                    ],
                    [t('本阶段调用', 'Stage calls'), digits(step.calls.length)],
                  ]}
                />
              )}

              {step.calls.length > 0 && (
                <div className="stage-endpoints">
                  <span>{t('本阶段接入点', 'Endpoints in this stage')}</span>
                  {[...new Set(step.calls.map((c) => c.endpoint))].map((k) => (
                    <button key={k} onClick={() => detailTab('endpoints')}>
                      {endpointName(k, cfg, lang, r)}
                      <ArrowUpRight size={12} />
                    </button>
                  ))}
                </div>
              )}
            </>
          </div>
        </Panel>
      ) : (
        <Panel className={'trace-tab-panel ' + (tab === 'response' ? 'response-tab' : '')}>
          {tab === 'response' ? (
            complete ? (
              isTest ? (
                <KeyValues
                  items={[
                    [t('测试对象', 'Resource'), r.testTarget ? l(r.testTarget.name) : title],
                    [
                      t('测试结果', 'Test result'),
                      r.status === 'error' ? t('测试失败', 'Test failed') : responsePreview,
                    ],
                    [
                      t('资源版本', 'Resource version'),
                      String(res.data?.resource_version ?? r.testTarget?.version ?? '—'),
                    ],
                    [t('执行时间', 'Elapsed time'), String(res.data?.elapsed_ms ?? r.duration) + ' ms'],
                    [t('原因', 'Reason'), testReason(res.data?.reason ?? res.error?.code, lang)],
                    [t('关联请求', 'Request ID'), r.id],
                  ]}
                />
              ) : (
                <>
                  <details className="read-request-input">
                    <summary>{t('请求参数', 'Request parameters')}</summary>
                    <RequestFacts op={r.op} input={command} defaults={defaults} />
                  </details>
                  <ResultView response={res} op={r.op} inspect={setCandidate} />
                </>
              )
            ) : (
              <Empty text={t('该次响应载荷不可用', 'Response payload is unavailable')} />
            )
          ) : tab === 'snapshot' ? (
            scope ? (
              <KeyValues
                items={[
                  [t('配置版本', 'Config version'), 'v' + scope.version],
                  [t('搜索接入点', 'Search endpoint'), endpointName(scope.search, cfg, lang, r)],
                  [t('正文接入点', 'Reader endpoint'), endpointName(scope.reader, cfg, lang, r)],
                  [t('模型', 'Model'), endpointName(scope.model, cfg, lang, r)],
                  [
                    t('代理池', 'Proxy pool'),
                    scope.pool
                      ? r.snapshot?.egress
                        ? l(r.snapshot.egress.poolName)
                        : !r.generated
                          ? l(sampleConfig.pools.find((p) => p.id === scope.pool)?.name ?? '—')
                          : t('未记录', 'Not recorded')
                      : t('未绑定', 'Unbound'),
                  ],
                  [
                    t('默认业务语言', 'Default language'),
                    scope.wire?.project.default_language
                      ? languageName(scope.wire.project.default_language, lang)
                      : !r.generated
                        ? languageName(project.language, lang)
                        : t('未记录', 'Not recorded'),
                  ],
                  [
                    t('搜索 / 来源上限', 'Search / source limits'),
                    (scope.searchLimit ?? '—') + ' / ' + scope.sourceLimit,
                  ],
                  [
                    t('正文 / 总结字数上限', 'Article / summary character limits'),
                    (scope.bodyLimit ?? '—') + ' / ' + (scope.summaryLimit ?? '—'),
                  ],
                  [t('改写数量', 'Rewrite count'), String(scope.rewriteCount ?? '—')],
                  [
                    t('允许简介', 'Allow snippets'),
                    scope.allowSnippets === undefined
                      ? '—'
                      : scope.allowSnippets
                        ? t('是', 'Yes')
                        : t('否', 'No'),
                  ],
                  [
                    t('搜索池', 'Search pools'),
                    scope.searchPools
                      ?.map((g) => g.map((id) => endpointName(id, cfg, lang, r)).join(' + '))
                      .join(' → ') || '—',
                  ],
                  [
                    t('正文池', 'Reader pools'),
                    scope.readerPools
                      ?.map((g) => g.map((id) => endpointName(id, cfg, lang, r)).join(' + '))
                      .join(' → ') || '—',
                  ],
                  [
                    t('路由版本 / 选择原因', 'Route version / decision'),
                    (r.snapshot?.routesVersion ?? '—') +
                      ' / ' +
                      (r.snapshot?.routeReason && Object.hasOwn(reasonNames, r.snapshot.routeReason)
                        ? l(reasonNames[r.snapshot.routeReason as keyof typeof reasonNames])
                        : '—'),
                  ],
                ]}
              />
            ) : (
              <Empty text={t('此次记录未采集配置快照', 'No configuration snapshot was captured')} />
            )
          ) : tab === 'recording' ? (
            <KeyValues
              items={[
                [
                  t('完整性', 'Completeness'),
                  complete ? t('记录完整', 'Complete') : t('部分载荷缺失', 'Incomplete'),
                ],
                ['HTTP', String(resultCode(r, lang) || '—')],
                [t('开始时间', 'Started'), stamp(r.time, windowZone)],
                [t('完成时间', 'Finished'), stamp(r.time + r.duration, windowZone)],
                [t('警告', 'Warnings'), res.warnings.map((w) => w.message).join(' · ') || t('无', 'None')],
              ]}
            />
          ) : (
            <>
              <Caption title={t('实际调用的接入点', 'Endpoints called')}>
                <Segments
                  label={t('调用能力', 'Call capability')}
                  value={callKind ?? 'all'}
                  change={(value) => updateQuery({ epKind: value === 'all' ? null : value })}
                  items={[
                    { id: 'all', label: t('全部', 'All') },
                    ...Object.entries(kinds).map(([id, label]) => ({ id, label: l(label) })),
                  ]}
                />
              </Caption>
              {displayedCalls.length ? (
                <div className="table-scroll">
                  <table className="data-table">
                    <thead>
                      <tr>
                        {[
                          t('接入点', 'Endpoint'),
                          t('阶段', 'Stage'),
                          t('执行', 'Execution'),
                          t('排队', 'Queue'),
                          t('调用详情', 'Call detail'),
                        ].map((v) => (
                          <th key={v}>{v}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {displayedCalls.map((c) => (
                        <tr key={c.id}>
                          <td>{endpointName(c.endpoint, cfg, lang, r)}</td>
                          <td>{l(phaseNames[c.phase])}</td>
                          <td>{c.duration} ms</td>
                          <td>{c.queue} ms</td>
                          <td>
                            <button
                              className="text-link"
                              onClick={() =>
                                go(
                                  'observability',
                                  '',

                                  new URLSearchParams({
                                    view: 'calls',
                                    origin: c.origin,
                                    kind: c.kind,
                                    ep: c.endpoint,
                                    from: String(r.time - 1),
                                    to: String(r.time + r.duration + 1),
                                    call: c.id,
                                    zone: windowZone,
                                  }).toString(),
                                )
                              }
                            >
                              {t('查看调用', 'Inspect call')}
                              <ArrowUpRight size={13} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty
                  text={
                    callKind
                      ? t('此请求未调用该类接入点', 'No calls to this capability in this request')
                      : t('此请求没有上游调用', 'No upstream attempts in this request')
                  }
                />
              )}
            </>
          )}
        </Panel>
      )}
      {selected && complete && (
        <CandidateSheet
          article={selected}
          record={r}
          result={res}
          groups={groups}
          segment={params.get('segment') ?? undefined}
          close={() => setCandidate('')}
          jump={(stage) => {
            updateQuery({ section: 'flow', format: null, stage, candidate: null, segment: null });
          }}
        />
      )}
    </div>
  );
}
function zonesFromBack(p: URLSearchParams) {
  const v = new URLSearchParams(p.get('returnQuery') || '').get('zone');
  return v && ['Asia/Shanghai', 'UTC', 'America/New_York'].includes(v) ? v : 'Asia/Shanghai';
}
