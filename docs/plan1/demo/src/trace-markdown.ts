import type { buildTraceExport } from './trace-export';
import { local, kinds, opLabels, statusLabels, type Lang, type Op } from './model';
import { originNames, phaseNames, reasonNames } from './diagnostic-data';
import { requestRows } from './request-values';
import { languageName, testReason, answerSources } from './display-values';
import { selectionLabels } from './evidence';
import { browserPhaseLabels } from './browser-diagnostics';

// Protect table boundaries and keep captured page text from becoming active Markdown or HTML.
function md(value: unknown) {
  return String(value ?? '—')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\|\[\]_*~`])/g, '\\$1')
    .replace(/\r?\n/g, ' ');
}
export function traceMarkdown(view: ReturnType<typeof buildTraceExport>, lang: Lang): string {
  const t = (zh: string, en: string) => local([zh, en], lang),
    r = view.request,
    m = r.metadata,
    x = r.execution_summary,
    res = r.response_payload,
    project = r.snapshot?.project,
    unknown = t('未记录', 'Not recorded'),
    none = t('无', 'None');
  const op = m.operation as Op,
    business = Object.hasOwn(opLabels, op);
  const lines = ['# ' + t('请求记录', 'Request record') + ' · ' + md(m.request_id), ''];
  function heading(title: string) {
    lines.push('## ' + title, '');
  }
  function table(headers: string[], rows: unknown[][]) {
    lines.push(
      '| ' + headers.map(md).join(' | ') + ' |',
      '| ' + headers.map(() => '---').join(' | ') + ' |',
      ...rows.map((row) => '| ' + row.map(md).join(' | ') + ' |'),
      '',
    );
  }
  function facts(rows: unknown[][]) {
    table([t('项目', 'Item'), t('内容', 'Value')], rows);
  }
  const phase = (id: string) => (phaseNames[id] ? local(phaseNames[id], lang) : unknown);
  const label = (status: string) =>
    Object.hasOwn(statusLabels, status)
      ? local(statusLabels[status as keyof typeof statusLabels], lang)
      : unknown;
  facts([
    [t('业务操作', 'Operation'), business ? local(opLabels[op], lang) : local(originNames[m.origin], lang)],
    [t('项目名称', 'Project'), m.project_name ?? '—'],
    [t('状态', 'Status'), label(m.status)],
    [t('开始时间', 'Started'), m.started_at],
    [t('耗时', 'Duration'), m.duration_ms + ' ms'],
    [
      t('上游调用（其中模型）', 'Upstream calls (including model)'),
      m.upstream_calls + ' (' + m.model_calls + ')',
    ],
    [t('记录完整性', 'Recording'), m.incomplete ? t('部分载荷缺失', 'Incomplete') : t('完整', 'Complete')],
  ]);
  if (x.retrieval || x.score_batches?.length || x.answer_source) {
    const rows: unknown[][] = [];
    if (x.retrieval)
      rows.push(
        [t('检索变体', 'Queries searched'), x.retrieval.variant_count],
        [
          t('原始命中 → 唯一候选', 'Hits → unique candidates'),
          (x.retrieval.raw_candidates ?? '—') + ' → ' + (x.retrieval.unique_candidates ?? '—'),
        ],
      );
    if (x.score_batches)
      rows.push([
        t('评分批次', 'Scoring batches'),
        x.score_batches.map((b) => b.batch_id + ' (' + (b.candidate_count ?? '—') + ')').join(' / ') || none,
      ]);
    if (x.answer_source)
      rows.push([t('答案来源', 'Answer source'), local(answerSources[x.answer_source], lang)]);
    facts(rows);
  }
  if (business && r.request_payload) {
    heading(t('请求参数', 'Request parameters'));
    facts(
      requestRows(
        op,
        r.request_payload,
        {
          language: project?.default_language ?? m.language,
          sourceLimit: project?.source_limit,
          searchLimit: project?.search_limit,
          bodyLimit: project?.body_limit,
          summaryLimit: project?.summary_limit,
        },
        lang,
      ),
    );
  } else if (m.query_preview) {
    heading(t('请求内容', 'Request input'));
    lines.push(md(m.query_preview), '');
  }
  heading(t('结果', 'Result'));
  if (!res) lines.push(unknown, '');
  else if (res.error) lines.push(md(res.error.message), '');
  else if (!business)
    lines.push(md(res.data?.status === 'error' ? testReason(res.data.reason, lang) : m.response_preview), '');
  else if (op === 'list' && res.data?.items?.length)
    table(
      [t('标题', 'Title'), t('网页地址', 'URL'), t('简介', 'Snippet')],
      res.data.items.map((i: { title: string; url: string; snippet: string }) => [i.title, i.url, i.snippet]),
    );
  else if (op === 'content' && res.data?.text)
    lines.push(
      md(res.data.title),
      '',
      md(res.data.url),
      '',
      ...String(res.data.text)
        .split(/\n\s*\n/)
        .map(md),
      '',
    );
  else lines.push(md(res.data?.summary ?? m.response_preview ?? none), '');
  for (const w of res?.warnings ?? []) lines.push('- ' + md(w.message));
  if (view.evidence.variants.length) {
    lines.push('');
    heading(t('检索与选材', 'Retrieval and selection'));
    table(
      [t('变体', 'Variant'), t('检索内容', 'Query')],
      view.evidence.variants.map((g) => [g.variant_id, g.query]),
    );
    if (view.evidence.candidates.length)
      table(
        [
          t('候选网页', 'Candidate'),
          t('命中变体与排名', 'Variants and ranks'),
          t('评分', 'Score'),
          t('批次', 'Batch'),
          t('选材结果', 'Selection'),
        ],
        view.evidence.candidates.map((c) => [
          c.title,
          c.hits.map((h) => h.variant_id + ' #' + h.rank).join(' / '),
          c.score,
          c.score_batch_id,
          local(selectionLabels[c.selection_reason], lang),
        ]),
      );
  }
  if (view.evidence.sources.length) {
    heading(t('来源、分段与引用', 'Sources, passages and citations'));
    for (const s of view.evidence.sources) {
      lines.push('### ' + md(s.source_id) + ' · ' + md(s.title), '', md(s.url), '');
      for (const seg of view.evidence.segments.filter((p) => p.source_id === s.source_id)) {
        lines.push(
          '- ' +
            md(seg.segment_id) +
            ' · ' +
            (seg.cited ? t('回答已引用', 'Cited in answer') : t('已保留', 'Retained')) +
            ' · [' +
            seg.start_char +
            ', ' +
            seg.end_char +
            ')',
          '  ' + md(seg.summary),
        );
        if (seg.text_preview && seg.text_preview !== seg.summary) lines.push('  > ' + md(seg.text_preview));
      }
      lines.push('');
    }
  }
  heading(t('执行阶段', 'Execution stages'));
  table(
    [t('阶段', 'Stage'), t('开始偏移', 'Start offset'), t('耗时', 'Duration'), t('状态', 'Status')],
    r.spans.map((s) => [phase(s.stage), s.start_offset_ms + ' ms', s.duration_ms + ' ms', label(s.status)]),
  );
  if (project) {
    const names = new Map(r.snapshot?.endpoints.map((e) => [e.id, e.name]));
    const pools = (groups: string[][]) =>
      groups
        .map((ids, i) => i + 1 + '. ' + ids.map((id) => names.get(id) ?? unknown).join(' + '))
        .join(' → ') || none;
    heading(t('执行时的配置', 'Configuration at execution'));
    facts([
      [t('项目版本', 'Project version'), 'v' + project.version],
      [t('默认语言', 'Default language'), languageName(project.default_language, lang)],
      [t('搜索接入点池', 'Search pools'), pools(project.search_pools)],
      [t('正文接入点池', 'Reader pools'), pools(project.reader_pools)],
      [
        t('生成模型', 'Model'),
        project.model_endpoint_id ? (names.get(project.model_endpoint_id) ?? unknown) : none,
      ],
      [t('额外改写数量', 'Extra queries'), project.rewrite_count],
    ]);
  }
  if (view.calls.length) {
    heading(t('上游调用', 'Upstream calls'));
    table(
      [
        t('接入点', 'Endpoint'),
        t('能力', 'Capability'),
        t('阶段', 'Stage'),
        t('排队', 'Queued'),
        t('执行', 'Execution'),
        t('状态', 'Status'),
        t('选择原因', 'Route decision'),
      ],
      view.calls.map((c) => [
        c.endpoint_name,
        local(kinds[c.kind], lang),
        phase(c.span_id),
        c.queue_ms + ' ms',
        c.execution_ms + ' ms',
        label(c.status),
        [
          local(reasonNames[c.reason], lang),
          c.pool_priority && t('池 ', 'Pool ') + c.pool_priority,
          c.endpoint_failure === 'risk' && t('接入点风控', 'Endpoint risk restriction'),
          c.endpoint_failure === 'unavailable' && t('暂时不可用', 'Temporarily unavailable'),
        ].filter(Boolean).join(' · '),
      ]),
    );
    for (const c of view.calls) {
      const j = c.browser_job;
      if (!j) continue;
      lines.push(
        '### ' + md(c.endpoint_name) + ' · ' + md(c.call_id),
        '',
        md(j.pool_name) + ' → ' + md(j.proxy_name) + ' · ' + md(j.scheme.toUpperCase()),
        '',
      );
      table(
        [t('浏览器阶段', 'Browser stage'), t('耗时', 'Duration'), t('状态', 'Status')],
        j.phases.map((p) => [
          local(browserPhaseLabels[p.stage], lang),
          p.duration_ms + ' ms',
          label(p.status),
        ]),
      );
    }
  }
  return lines.join('\n').trimEnd() + '\n';
}
