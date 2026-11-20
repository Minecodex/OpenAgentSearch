import { languageName } from './display-values';
import { apiExample } from './api-example';
import { RequestFacts, RewriteFacts, FailureFacts } from './request-facts';
import { captureEgress } from './browser-diagnostics';
import { executeDemo } from './demo-dispatch';
import { traceSnapshot } from './configuration';
import { checkRewriteContext, contextualQuery, rewriteJob, sampleVariants } from './rewrite';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  BookOpen,
  ChevronDown,
  Clipboard,
  FlaskConical,
  Play,
  SlidersHorizontal,
  Square,
} from 'lucide-react';
import { articles, samples, missingBodySample } from './fixtures';
import { Command, executionRoute, httpOf } from './engine';
import { useConsole } from './state';
import { Envelope, Lang, Log, Op, endpointPath, local, opLabels, ops, uid } from './model';
import {
  Btn,
  Choice,
  Field,
  IconBtn,
  PageHead,
  Panel,
  Segments,
  SelectField,
  StateChip,
  opIcons,
  useCopy,
  SourceLink,
} from './ui';
export function ResultView({
  response,
  op,
  inspect,
}: {
  response: Envelope;
  op: Op;
  inspect?: (candidate: string, segment?: string) => void;
}) {
  const { t } = useConsole();
  const [format, setFormat] = useState('preview');
  const [evidence, setEvidence] = useState(''),
    [focus, setFocus] = useState('');
  const copy = useCopy();
  useEffect(() => {
    setFormat('preview');
    setEvidence('');
    setFocus('');
  }, [response.request_id, op]);
  const data = response.data;
  if (response.error) return <FailureFacts error={response.error} op={op} />;
  if (response.status === 'cancelled')
    return <div className="empty-state">{t('请求已取消。', 'The request was cancelled.')}</div>;
  if (response.status === 'empty')
    return (
      <div className="empty-state">
        <BookOpen size={26} />
        <p>{t('示例资料中没有相关证据。', 'No relevant evidence in the sample collection.')}</p>
      </div>
    );
  if (!data) return null;
  if (op === 'content')
    return (
      <div className="read-result">
        <div className="compact-actions">
          <Segments
            label={t('正文格式', 'Article format')}
            value={format}
            change={setFormat}
            items={[
              { id: 'preview', label: t('预览', 'Preview') },
              { id: 'markdown', label: 'Markdown' },
              { id: 'text', label: t('纯文本', 'Plain text') },
            ]}
          />
          <IconBtn
            icon={Clipboard}
            label={t('复制正文', 'Copy article')}
            onPress={() => void copy(format === 'text' ? data.text : data.markdown)}
          />
        </div>
        {format === 'preview' ? (
          <article className="article">
            <h3>{data.title}</h3>
            {data.text
              .split('\n\n')
              .slice(1)
              .map((p: string, i: number) => (
                <p key={i}>{p}</p>
              ))}
            {!data.text.includes('\n\n') && <p>{data.text}</p>}
          </article>
        ) : (
          <pre className="code-box">{data[format]}</pre>
        )}
        <p className="source-address">
          <SourceLink url={data.url} />
        </p>
        <div className="result-meta">
          {data.truncated && <b>{t('已截断', 'Truncated')} · </b>}
          {t('保留字符', 'Retained characters')} · Markdown {data.lengths.markdown.retained} /{' '}
          {data.lengths.markdown.original} · {t('纯文本', 'Text')} {data.lengths.text.retained} /{' '}
          {data.lengths.text.original}
        </div>
      </div>
    );
  if (op === 'list')
    return (
      <div className="hit-list">
        {data.items.map((a: any, i: number) => (
          <div key={a.url} className="hit">
            <span className="rank">{String(i + 1).padStart(2, '0')}</span>
            <div>
              <strong>{a.title}</strong>
              <p>{a.snippet}</p>
              <SourceLink url={a.url} />
            </div>
          </div>
        ))}
      </div>
    );
  const focused = data.sources.find((s: any) => s.id === evidence);
  return (
    <div className="synthesis">
      <article className="answer">
        <div className="answer-label">
          <BookOpen size={16} />
          {t('整体总结', 'Synthesis')}
        </div>
        <p>{data.summary}</p>
        <div className="cite-row">
          <span>{t('引用', 'Citations')}</span>
          {data.citations.map((c: any, i: number) => (
            <button
              key={c.source_id + c.segment_id}
              onClick={() => {
                setEvidence(c.source_id);
                setFocus(c.segment_id);
              }}
              aria-pressed={evidence === c.source_id && focus === c.segment_id}
              data-testid={'cite-' + i}
            >
              [{i + 1}]
            </button>
          ))}
        </div>
      </article>
      <section className="evidence">
        <h3>
          {t('来源与分段', 'Sources & passages')} <small>{data.sources.length}</small>
        </h3>
        {data.sources.map((s: any, i: number) => (
          <div className={'source-item ' + (focused?.id === s.id ? 'expanded' : '')} key={s.id}>
            <button
              onClick={() => {
                setEvidence(evidence === s.id ? '' : s.id);
                setFocus('');
              }}
              aria-expanded={evidence === s.id}
            >
              <span className="source-index">{String(i + 1).padStart(2, '0')}</span>
              <span className="source-name">
                <strong>{s.title}</strong>
                <small>
                  {new URL(s.url).hostname} ·{' '}
                  {s.kind === 'snippet' ? t('搜索简介', 'Search snippet') : t('网页正文', 'Article body')}
                </small>
              </span>
              <b>{s.score}</b>
              <ChevronDown size={14} />
            </button>
            {evidence === s.id && (
              <div className="passages">
                <SourceLink url={s.url}>{t('打开来源网页', 'Open source page')} ↗</SourceLink>
                {s.segments.map((p: any) => (
                  <p key={p.id} className={focus === p.id ? 'focused-passage' : undefined}>
                    <code>
                      {s.id}/{p.id}
                    </code>
                    {p.summary}
                    {inspect && (
                      <button
                        className="text-link passage-link"
                        onClick={() => {
                          const a = articles.find((x) => x.url === s.url);
                          if (a) inspect(a.id, p.id);
                        }}
                      >
                        {t('查看原文范围', 'Inspect source range')} ↗
                      </button>
                    )}
                  </p>
                ))}
              </div>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}
interface Draft {
  value?: string;
  language?: Lang | '';
  range?: string;
  limit?: string;
  summaryMax?: string;
  region?: string;
  currentTime?: string;
}
export interface DebugMemory {
  project: string;
  op: Op;
  drafts: Record<string, Draft>;
  advanced: boolean;
  response: Envelope | null;
  elapsed: number;
  tab: string;
}
export function Playground() {
  const {
    t,
    l,
    lang,
    id,
    cfg,
    dispatcher,
    project,
    selectProject,
    addLog,
    go,
    open,
    dialog,
    logs,
    debugMemory,
    query: location,
    updateQuery,
  } = useConsole();
  const saved = debugMemory.current;
  const resume = saved?.project === project.id && (!id || id === saved.op) ? saved : null;
  const [op, setOp] = useState<Op>(ops.includes(id as Op) ? (id as Op) : (resume?.op ?? 'summary')),
    [drafts, storeDraft] = useState<Record<string, Draft>>(saved?.drafts ?? {});
  const [advanced, setAdvanced] = useState(saved?.advanced ?? false),
    [response, setResponse] = useState<Envelope | null>(resume?.response ?? null),
    [running, setRunning] = useState(false),
    [elapsed, setElapsed] = useState(resume?.elapsed ?? 0),
    [tab, setTab] = useState(resume?.tab === 'request' ? 'request' : 'result');
  const job = useRef<{ timer: ReturnType<typeof setTimeout>; log: Log } | null>(null);
  const copy = useCopy();
  const draftKey = project.id + '/' + op,
    d = drafts[draftKey] ?? {},
    read = op === 'content',
    summary = op === 'summary',
    contentLang = d.language || project.language;
  const question = d.value ?? (read ? articles[0].url : local(samples[0], contentLang));
  const cmd: Command = read ? { url: question.trim() } : { query: question.trim() };
  if (!read && d.language) cmd.language = d.language;
  if (!read && d.range) cmd.time_range = d.range as Command['time_range'];
  if (d.limit) {
    if (read) cmd.max_chars = Number(d.limit);
    else if (summary) cmd.source_count = Number(d.limit);
    else cmd.count = Number(d.limit);
  }
  if (summary) {
    if (d.summaryMax) cmd.max_chars = Number(d.summaryMax);
    if (d.region !== undefined && d.region !== '') cmd.region = d.region;
    if (d.currentTime !== undefined && d.currentTime !== '') cmd.current_time = d.currentTime;
  }
  const route = executionRoute(project, cfg, cmd, dispatcher);
  const context = checkRewriteContext(cmd);
  const rewrite =
    summary && context.ok && cmd.query
      ? rewriteJob(cmd.query, contentLang, project.rewriteCount, context.value)
      : undefined;
  const caps = (eid: string) => l(cfg.endpoints.find((e) => e.id === eid)?.name || '—');
  const finished = response ? logs.find((log) => log.id === response.request_id) : undefined;
  const displayedInput = finished?.input ?? cmd;
  const displayedProject = finished?.snapshot
    ? {
        ...finished.snapshot,
        language: finished.snapshot.wire?.project.default_language ?? finished.language,
      }
    : project;
  const displayedContext = checkRewriteContext(displayedInput);
  const displayedRewrite = finished
    ? summary && displayedContext.ok && typeof displayedInput.query === 'string'
      ? rewriteJob(
          displayedInput.query,
          finished.language ?? project.language,
          finished.snapshot?.rewriteCount ?? 0,
          displayedContext.value,
        )
      : undefined
    : rewrite;
  const demoQueries = summary
    ? [...samples, [contextualQuery.zh, contextualQuery.en] as [string, string], missingBodySample]
    : samples;
  function cancel(visible = true) {
    const j = job.current;
    if (!j) return;
    clearTimeout(j.timer);
    job.current = null;
    const stopped: Envelope = {
      request_id: j.log.id,
      status: 'cancelled',
      data: null,
      warnings: [],
      error: null,
    };
    const duration = Math.max(1, Date.now() - j.log.time);
    addLog({ ...j.log, duration, status: 'cancelled', response: stopped });
    if (visible) {
      setRunning(false);
      setElapsed(duration);
      setResponse(stopped);
    }
  }
  const lastProject = useRef(project.id);
  useEffect(() => {
    if (lastProject.current !== project.id) {
      setRunning(false);
      setResponse(null);
      setElapsed(0);
      setTab('result');
      lastProject.current = project.id;
    }
    return () => cancel(false);
  }, [project.id]);
  useEffect(() => {
    debugMemory.current = { project: project.id, op, drafts, advanced, response, elapsed, tab };
  }, [project.id, op, drafts, advanced, response, elapsed, tab]);
  useEffect(() => {
    if (ops.includes(id as Op) && id !== op) switchOp(id as Op);
  }, [id]);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      if (job.current) setElapsed(Date.now() - job.current.log.time);
    }, 90);
    return () => clearInterval(timer);
  }, [running]);
  const fromReference = new URLSearchParams(location).get('sample') === 'api';
  useEffect(() => {
    if (!fromReference || !ops.includes(id as Op)) return;
    const nextOp = id as Op,
      ex = apiExample(nextOp, lang);
    cancel(false);
    setRunning(false);
    setResponse(null);
    setElapsed(0);
    setTab('result');
    setOp(nextOp);
    setAdvanced(true);
    storeDraft((old) => ({
      ...old,
      [project.id + '/' + nextOp]: {
        value: ex.url ?? ex.query,
        language: ex.language,
        limit:
          ex.count !== undefined
            ? String(ex.count)
            : ex.source_count !== undefined
              ? String(ex.source_count)
              : undefined,
        summaryMax: ex.max_chars !== undefined ? String(ex.max_chars) : undefined,
        region: ex.region,
        currentTime: ex.current_time,
      },
    }));
    updateQuery({ sample: null });
  }, [fromReference, id, project.id, lang]);
  function switchOp(v: Op) {
    cancel(false);
    setRunning(false);
    setOp(v);
    setResponse(null);
    setTab('result');
    setElapsed(0);
  }
  function set(v: Partial<Draft>) {
    storeDraft((old) => ({ ...old, [draftKey]: { ...old[draftKey], ...v } }));
    setResponse(null);
    setElapsed(0);
  }
  function execute() {
    if (job.current || dialog) return;
    const start = Date.now(),
      rid = uid('req'),
      input = { ...cmd },
      resources = route.resources;
    const selected = new Set([...project.searchPools.flat(), ...project.readerPools.flat(), project.model]);
    const log: Log = {
      id: rid,
      op,
      project: project.id,
      query: question,
      time: start,
      duration: 0,
      status: 'success',
      generated: true,
      origin: 'debug',
      resources,
      language: contentLang,
      input,
      rewrites: sampleVariants(rewrite),
      snapshot: {
        projectName: project.name,
        wire: traceSnapshot(cfg, project, lang),
        egress: captureEgress(cfg, project.pool),
        version: project.version,
        searchLimit: project.searchLimit,
        sourceLimit: project.sourceLimit,
        bodyLimit: project.bodyLimit,
        summaryLimit: project.summaryLimit,
        rewriteCount: project.rewriteCount,
        allowSnippets: project.allowSnippets,
        pool: project.pool,
        ...resources,
        searchPools: structuredClone(project.searchPools),
        readerPools: structuredClone(project.readerPools),
        routesVersion: cfg.routesVersion,
        endpoints: Object.fromEntries(
          cfg.endpoints
            .filter((e) => selected.has(e.id))
            .map((e) => [
              e.id,
              {
                version: e.version,
                adapter: e.adapter,
                provider: e.provider,
                timeout_ms: e.timeoutMs,
                max_concurrency: e.limit,
                rpm: e.rpm,
              },
            ]),
        ),
        names: Object.fromEntries(cfg.endpoints.map((e) => [e.id, e.name])),
      },
    };
    setRunning(true);
    setResponse(null);
    setTab('result');
    setElapsed(0);
    const timer = setTimeout(
      () => {
        const execution = executeDemo(op, input, project, cfg, rid, lang, dispatcher);
        const { response: value, route: actual } = execution;
        const duration = Date.now() - start;
        job.current = null;
        addLog({
          ...log, status: value.status, duration, response: value,
          resources: actual.resources, dispatches: execution.attempts,
          snapshot: {
            ...log.snapshot!, ...actual.resources,
            routeReason: op === 'content' ? actual.reader.reason : actual.search.reason,
            readerRouteReason: actual.reader.reason,
          },
        });
        setResponse(value);
        setElapsed(duration);
        setRunning(false);
      },
      summary ? 850 : 350,
    );
    job.current = { timer, log };
  }
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        execute();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  return (
    <>
      <PageHead
        title={t('检索调试', 'Search playground')}
        sub={t(
          '按项目调试业务接口，检查实际参数、结果和请求链路。',
          'Inspect project-scoped inputs, results and request traces.',
        )}
      >
        <Choice
          label={t('调试项目', 'Playground project')}
          value={project.id}
          onChange={(id) => {
            cancel(false);
            selectProject(cfg.projects.find((p) => p.id === id)!);
          }}
          options={cfg.projects.map((p) => ({ value: p.id, label: l(p.name) + ' · v' + p.version }))}
          test="debug-project"
        />
      </PageHead>
      <div className="debug-project">
        <span className="code-chip">v{project.version}</span>
        <b>{l(project.name)}</b>
        <span>
          {t('搜索', 'Search')} · {caps(route.search.id)}
        </span>
        <span>
          {t('正文', 'Reader')} · {caps(route.reader.id)}
        </span>
        <span>
          {t('模型', 'Model')} · {caps(project.model)}
        </span>
        <button className="text-link" onClick={() => open('project-info', project.id)}>
          {t('项目配置', 'Project settings')} ↗
        </button>
      </div>
      <div className="debug-split">
        <Panel className="composer">
          <div className="compose-head">
            <Segments
              label={t('业务操作', 'Operation')}
              value={op}
              change={(v) => switchOp(v as Op)}
              items={ops.map((k) => ({ id: k, label: l(opLabels[k]), icon: opIcons[k] }))}
            />
          </div>
          <div className="editor-label">
            <label htmlFor="command-input">
              {read ? t('网页 URL', 'Article URL') : t('检索问题', 'Search query')}
            </label>
            <code>POST {endpointPath(op)}</code>
          </div>
          <textarea
            id="command-input"
            data-testid="command"
            disabled={running}
            value={question}
            onChange={(e) => set({ value: e.target.value })}
            rows={3}
            spellCheck={false}
          />
          <div className="compose-actions">
            <div>
              <button className="text-link" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>
                <SlidersHorizontal size={15} />
                {t('参数', 'Parameters')}
              </button>
              <Choice
                label={t('载入样例', 'Load sample')}
                value=""
                onChange={(s) => {
                  if (s) {
                    cancel();
                    set({ value: read ? articles[+s - 1].url : local(demoQueries[+s - 1], contentLang) });
                  }
                }}
                options={[
                  { value: '', label: t('载入样例', 'Load sample') },
                  ...(read
                    ? articles.map((a) => l(a.name))
                    : demoQueries.map((q) => local(q, contentLang))
                  ).map((label, i) => ({ value: String(i + 1), label })),
                ]}
              />
            </div>
            {running ? (
              <Btn test="cancel" onPress={() => cancel()}>
                <Square size={14} />
                {t('取消请求', 'Cancel request')}
              </Btn>
            ) : (
              <Btn primary onPress={execute} test="run">
                <Play size={15} />
                {t('运行请求', 'Run request')}
              </Btn>
            )}
          </div>
          {advanced && (
            <fieldset disabled={running} className="debug-parameters">
              <div className="param-grid">
                {!read && (
                  <SelectField
                    label={t('输出语言', 'Output language')}
                    value={d.language ?? ''}
                    onChange={(v) => set({ language: v as Lang | '' })}
                    options={[
                      {
                        value: '',
                        label:
                          t('项目默认', 'Project default') + ' · ' + languageName(project.language, lang),
                      },
                      ...project.languages.map((value) => ({
                        value,
                        label: languageName(value, lang),
                      })),
                    ]}
                  />
                )}
                <Field
                  label={
                    read
                      ? t('字符上限', 'Character limit')
                      : summary
                        ? t('来源上限', 'Source limit')
                        : t('结果数', 'Result count')
                  }
                  type="number"
                  value={d.limit ?? ''}
                  change={(limit) => set({ limit })}
                  placeholder={String(
                    read ? project.bodyLimit : summary ? project.sourceLimit : project.searchLimit,
                  )}
                />
                {summary && (
                  <Field
                    label={t('总结字数', 'Summary characters')}
                    type="number"
                    value={d.summaryMax ?? ''}
                    placeholder={String(project.summaryLimit)}
                    change={(summaryMax) => set({ summaryMax })}
                  />
                )}
                {!read && (
                  <SelectField
                    label={t('检索时间', 'Search window')}
                    value={d.range ?? ''}
                    onChange={(range) => set({ range })}
                    options={[
                      { value: '', label: t('不限', 'Any time') },
                      { value: 'day', label: t('近一天', 'Last day') },
                      { value: 'month', label: t('近一月', 'Last month') },
                      { value: 'year', label: t('近一年', 'Last year') },
                    ]}
                  />
                )}
              </div>
              {summary && (
                <section className="rewrite-fields">
                  <h3>{t('改写上下文（可选）', 'Optional rewrite context')}</h3>
                  <Field
                    label={t('地区', 'Region')}
                    value={d.region ?? ''}
                    change={(region) => set({ region })}
                    placeholder={t('例如：上海市浦东新区', 'e.g. Porto, Portugal')}
                    test="context-region"
                  />
                  <Field
                    label={t('调用方当地时间', 'Caller local time')}
                    value={d.currentTime ?? ''}
                    change={(currentTime) => set({ currentTime })}
                    placeholder="2026-05-01T00:30:00+08:00"
                    test="context-time"
                  />
                  <p>
                    {t(
                      '使用 RFC 3339，带 Z 或数字偏移。留空的字段会从改写输入中省略。',
                      'Use RFC 3339 with Z or a numeric offset. Blank fields are omitted from rewrite inputs.',
                    )}
                  </p>
                  {!context.ok && (
                    <p className="form-error" role="alert">
                      {context.field === 'region'
                        ? t(
                            '请输入 1–128 个字符的非空单行地区。',
                            'Enter a nonblank region of 1–128 characters.',
                          )
                        : t('请填写有效日期、时间和时区偏移。', 'Enter a valid date, time and offset.')}
                    </p>
                  )}
                </section>
              )}
            </fieldset>
          )}
        </Panel>
        <Panel className="result-panel debug-result">
          <div className="result-heading">
            <h2>{t('响应', 'Response')}</h2>
            <Segments
              label={t('响应视图', 'Response view')}
              value={tab}
              change={setTab}
              items={[
                { id: 'result', label: t('结果', 'Result') },
                { id: 'request', label: t('请求参数', 'Request parameters') },
              ]}
            />
          </div>
          {tab === 'request' ? (
            <>
              <RequestFacts op={op} input={displayedInput} defaults={displayedProject} />
              {displayedRewrite && <RewriteFacts job={displayedRewrite} />}
              {summary && displayedProject.rewriteCount === 0 && (
                <p className="panel-help">
                  {t('此项目只检索原问题。', 'This project searches only the original query.')}
                </p>
              )}
            </>
          ) : running ? (
            <div className="busy" role="status">
              <i className="spinner" />
              {t('运行本地请求', 'Running local request')} · {(elapsed / 1000).toFixed(1)} s
            </div>
          ) : response ? (
            <>
              <div className="response-bar">
                <StateChip value={response.status} />
                <code>{response.status === 'cancelled' ? '—' : 'HTTP ' + httpOf(response)}</code>
                <code>{elapsed} ms</code>
                <button
                  className="text-link"
                  onClick={() => go('requests', response.request_id, 'back=playground')}
                >
                  {t('请求记录', 'Trace')}
                  <ArrowRight size={13} />
                </button>
              </div>
              <div className="debug-request-id">
                <code>{response.request_id}</code>
                <IconBtn
                  icon={Clipboard}
                  label={t('复制请求 ID', 'Copy request ID')}
                  onPress={() => void copy(response.request_id)}
                />
              </div>
              {response.warnings.map((w) => (
                <p key={w.code} className="diag-warning">
                  {w.message}
                </p>
              ))}
              <ResultView
                op={op}
                response={response}
                inspect={(candidate, segment) =>
                  go(
                    'requests',
                    response.request_id,
                    new URLSearchParams({
                      back: 'playground',
                      section: 'response',
                      candidate,
                      ...(segment ? { segment } : {}),
                    }).toString(),
                  )
                }
              />
            </>
          ) : (
            <div className="empty-state">
              <FlaskConical size={24} />
              <p>{t('运行请求后在这里查看结果。', 'Run a request to see its result here.')}</p>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
