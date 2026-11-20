import { installed } from './configuration';
import { routeChoice, type EndpointDispatch } from './routing';
import { checkRewriteContext, rewriteJob, sampleVariants, type RewriteContext } from './rewrite';
import { articles } from './fixtures';
import { Article, Config, Envelope, Lang, Op, Project, charCount, local } from './model';
export interface Command extends RewriteContext {
  query?: string;
  url?: string;
  language?: Lang;
  count?: number;
  source_count?: number;
  max_chars?: number;
  time_range?: 'day' | 'month' | 'year';
}
export { installed as available, livePool as poolReady } from './configuration';
export function executionRoute(project: Project, cfg: Config, input: Command, runtime?: EndpointDispatch) {
  const language = input.language ?? project.language;
  const search = routeChoice(cfg, project, 'search', language, input.time_range, runtime);
  const reader = routeChoice(cfg, project, 'reader', language, undefined, runtime);
  const model = runtime && !runtime.available(project.model) ? '' : project.model;
  return { search, reader, resources: { search: search.id, reader: reader.id, model } };
}
export function findArticle(url: string) {
  return articles.find((a) => a.url === url.split('#')[0].replace(/\/$/, ''));
}
export function bodyOf(a: Article, lang: Lang) {
  const title = local(a.name, lang);
  const paragraphs = a.points.map((p) => local(p, lang));
  const text = [title, ...paragraphs].join('\n\n');
  return { text, markdown: '# ' + text };
}
export function articleData(a: Article, limit: number) {
  const language = a.sourceLanguage ?? 'zh';
  const full = bodyOf(a, language);
  let { text, markdown } = full;
  const truncated = charCount(markdown) > limit;
  if (truncated) {
    const prefix = limit > 2 ? '# ' : '';
    text = Array.from(text)
      .slice(0, limit - prefix.length)
      .join('');
    markdown = prefix + text;
  }
  return {
    url: a.url,
    title: local(a.name, language),
    markdown,
    text,
    truncated,
    lengths: {
      markdown: { original: charCount(full.markdown), retained: charCount(markdown) },
      text: { original: charCount(full.text), retained: charCount(text) },
    },
  };
}
export function capturedPassages(a: Article, limit: number, lang: Lang, kind: 'body' | 'snippet' = 'body') {
  const language = a.sourceLanguage ?? 'zh';
  let start = kind === 'body' ? charCount(local(a.name, language)) + 2 : 0;
  const retained =
    kind === 'body'
      ? articleData(a, limit).lengths.text.retained
      : Math.min(charCount(local(a.points[0], language)), limit);
  return (kind === 'body' ? a.points : a.points.slice(0, 1)).flatMap((p, i) => {
    const raw = local(p, language);
    const end = Math.min(retained, start + charCount(raw));
    const offset = start;
    start += charCount(raw) + 2;
    if (end <= offset) return [];
    const text = Array.from(raw)
      .slice(0, end - offset)
      .join('');
    return [{ id: 'p' + (i + 1), start: offset, end, text, summary: text === raw ? local(p, lang) : text }];
  });
}
export function rankArticles(query: string, range?: Command['time_range']) {
  const q = query.trim().toLowerCase();
  const days = range ? { day: 1, month: 30, year: 365 }[range] : Infinity;
  return articles
    .filter((a) => a.ageDays < days)
    .map((article, rank) => ({ article, rank, match: article.words.filter((w) => q.includes(w)).length }))
    .filter((r) => r.match)
    .sort((a, b) => b.match - a.match || a.rank - b.rank);
}
export function mergedMatches(queries: string[], range: Command['time_range'], limit: number) {
  const matches = new Map<string, ReturnType<typeof rankArticles>[number]>();
  for (const query of queries) {
    for (const hit of rankArticles(query, range).slice(0, limit)) {
      if (!matches.has(hit.article.id)) matches.set(hit.article.id, hit);
    }
  }
  return [...matches.values()].sort((a, b) => b.match - a.match);
}
export function runDemo(
  op: Op,
  input: Command,
  project: Project,
  cfg: Config,
  id: string,
  uiLang: Lang,
  route = executionRoute(project, cfg, input),
  unavailableBodies?: ReadonlySet<string>,
): Envelope {
  const message = (zh: string, en: string) => (uiLang === 'zh' ? zh : en);
  const good = (data: any, status: Envelope['status'] = 'success'): Envelope => ({
    request_id: id,
    status,
    data,
    warnings: [],
    error: null,
  });
  const fail = (code: string, zh: string, en: string, details: any = null): Envelope => ({
    request_id: id,
    status: 'error',
    data: null,
    warnings: [],
    error: { code, message: message(zh, en), details },
  });
  const allowed =
    op === 'summary'
      ? ['query', 'language', 'time_range', 'source_count', 'max_chars', 'region', 'current_time']
      : op === 'list'
        ? ['query', 'language', 'time_range', 'count']
        : ['url', 'max_chars'];
  const foreign = Object.keys(input).find((k) => !allowed.includes(k));
  if (foreign)
    return fail(
      'INVALID_ARGUMENT',
      '请求包含该操作不支持的字段。',
      'This field is not accepted by the operation.',
      { field: foreign },
    );
  const context = checkRewriteContext(input);
  if (!context.ok)
    return fail(
      'INVALID_ARGUMENT',
      context.field === 'region'
        ? '地区须为 1–128 个字符的非空单行文本。'
        : '时间须为有效的带偏移 RFC 3339 日期时间。',
      context.field === 'region'
        ? 'Use a nonblank single-line region of 1–128 characters.'
        : 'Enter a valid RFC 3339 timestamp with a known offset.',
      { field: context.field },
    );
  const lang = input.language ?? project.language;
  if (Object.hasOwn(input, 'language') && !project.languages.includes(input.language!))
    return fail(
      'LANGUAGE_UNSUPPORTED',
      '该项目未启用此业务语言。',
      'The project does not enable this language.',
      { field: 'language' },
    );
  if (Object.hasOwn(input, 'time_range') && !['day', 'month', 'year'].includes(input.time_range!))
    return fail('INVALID_ARGUMENT', '时间范围无效。', 'Invalid search time range.', { field: 'time_range' });
  for (const [key, limit] of Object.entries({
    count: project.searchLimit,
    source_count: project.sourceLimit,
    max_chars: op === 'content' ? project.bodyLimit : project.summaryLimit,
  })) {
    const n = input[key as keyof Command];
    if (n !== undefined && (!Number.isInteger(n) || Number(n) < 1 || Number(n) > limit))
      return fail('LIMIT_EXCEEDED', '参数超出项目限制。', 'The parameter exceeds the project limit.', {
        field: key,
        limit,
        received: n,
      });
  }
  const q = typeof input.query === 'string' ? input.query.trim() : '';
  let url: URL | undefined;
  if (op === 'content') {
    try {
      if (typeof input.url !== 'string') throw Error();
      url = new URL(input.url);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw Error();
    } catch {
      return fail(
        'URL_NOT_ALLOWED',
        '请输入有效的 HTTP(S) 网页地址。',
        'Enter a valid HTTP(S) article URL.',
        { field: 'url' },
      );
    }
  } else if (!q || charCount(q) > 2048)
    return fail(
      'INVALID_ARGUMENT',
      '请输入 1 至 2048 个字符的问题。',
      'Enter a question between 1 and 2048 characters.',
      { field: 'query' },
    );
  if (op !== 'content' && route.search.unavailable === 'TIME_RANGE_UNSUPPORTED')
    return fail(
      'TIME_RANGE_UNSUPPORTED',
      '可用搜索源不支持此时间范围。',
      'Available search sources do not support this time range.',
      { field: 'time_range' },
    );
  if (op !== 'content' && route.search.unavailable === 'LANGUAGE_UNSUPPORTED')
    return fail(
      'LANGUAGE_UNSUPPORTED',
      '可用搜索源未声明支持该语言。',
      'No available search source supports this language.',
      { field: 'language' },
    );
  const inline =
    op === 'summary' && cfg.endpoints.find((e) => e.id === route.search.id)?.adapter === 'integrated_search';
  const capabilities: ('search' | 'reader' | 'model')[] =
    op === 'summary'
      ? inline
        ? ['search', 'model']
        : ['search', 'reader', 'model']
      : [op === 'list' ? 'search' : 'reader'];
  const missing = capabilities.find((k) => !installed(cfg, route.resources[k]));
  if (missing && missing !== 'model' && route[missing].unavailable === 'PROXY_UNAVAILABLE')
    return fail(
      'PROXY_UNAVAILABLE',
      '项目没有可用的浏览器代理出口。',
      'The project has no enabled browser egress.',
    );
  if (missing)
    return fail(
      'SERVICE_UNAVAILABLE',
      '该项目缺少此次操作需要的可用接入点。',
      'A required endpoint is unavailable for this operation.',
      { capability: missing },
    );
  if (op === 'content' && url) {
    const a = findArticle(url.href);
    if (!a)
      return fail(
        'CONTENT_UNAVAILABLE',
        '离线样本没有这个页面，请选择样例 URL。',
        'This page is outside the offline collection. Select a sample URL.',
      );
    if (a.snippetOnly)
      return fail(
        'CONTENT_UNAVAILABLE',
        '该示例网页没有可用正文。',
        'This sample page has no retrievable article.',
      );
    const data = articleData(a, input.max_chars ?? project.bodyLimit),
      truncated = data.truncated;
    const response = good(data);
    if (truncated)
      response.warnings.push({
        code: 'content_truncated',
        message: message('正文已按字符上限截取。', 'Article truncated to the requested length.'),
        details: null,
      });
    return response;
  }
  const job = op === 'summary' ? rewriteJob(q, lang, project.rewriteCount, context.value) : undefined;
  const ranked = mergedMatches([q, ...sampleVariants(job)], input.time_range, project.searchLimit);
  if (op === 'list')
    return good(
      {
        items: ranked.slice(0, input.count ?? project.searchLimit).map(({ article: a }) => ({
          url: a.url,
          title: local(a.name, lang),
          snippet: local(a.points[0], lang),
        })),
      },
      ranked.length ? 'success' : 'empty',
    );
  const picked = ranked.slice(0, input.source_count ?? project.sourceLimit);
  let loss = false,
    usedSnippet = false;
  const sources = picked.flatMap(({ article: a, match }, i) => {
    const missingBody = a.snippetOnly || unavailableBodies?.has(a.url);
    if (missingBody && !project.allowSnippets) {
      loss = true;
      return [];
    }
    const kind = missingBody ? 'snippet' : 'body';
    const segments = capturedPassages(a, project.bodyLimit, lang, kind).map(({ id, summary }) => ({
      id,
      summary,
    }));
    if (!segments.length) {
      loss = true;
      return [];
    }
    if (kind === 'snippet') usedSnippet = true;
    if (kind === 'body' && articleData(a, project.bodyLimit).truncated) loss = true;
    return [
      {
        id: 's' + (i + 1),
        url: a.url,
        title: local(a.name, lang),
        score: Math.min(98, 83 + match * 3 - i),
        kind,
        segments,
      },
    ];
  });
  if (picked.length && !sources.length)
    return fail(
      'CONTENT_UNAVAILABLE',
      '已选择候选但未取得可用于总结的材料。',
      'No usable material could be recovered from the selected candidates.',
    );
  let summary = '';
  const citations = [];
  const limit = input.max_chars ?? project.summaryLimit;
  for (const source of sources) {
    const separator = summary && lang !== 'zh' ? ' ' : '';
    const remaining = limit - charCount(summary) - separator.length;
    if (remaining < 1) break;
    const segment = source.segments[0];
    summary += separator + Array.from(segment.summary).slice(0, remaining).join('');
    citations.push({ source_id: source.id, segment_id: segment.id });
  }
  const response = good(
    { summary, sources, citations },
    !sources.length ? 'empty' : loss || usedSnippet ? 'partial' : 'success',
  );
  if (loss || usedSnippet)
    response.warnings.push({
      code: usedSnippet ? 'snippet_used' : 'source_incomplete',
      message: usedSnippet
        ? message('一项来源使用搜索简介。', 'A source uses its search snippet.')
        : message('部分材料未完整用于总结。', 'Some source material was incomplete.'),
      details: null,
    });
  return response;
}
export function httpOf(r: Envelope) {
  if (r.status === 'cancelled') return 0;
  if (!r.error) return 200;
  if (
    [
      'LIMIT_EXCEEDED',
      'INVALID_ARGUMENT',
      'URL_NOT_ALLOWED',
      'TIME_RANGE_UNSUPPORTED',
      'LANGUAGE_UNSUPPORTED',
    ].includes(r.error.code)
  )
    return 400;
  return ['SERVICE_UNAVAILABLE', 'PROXY_UNAVAILABLE'].includes(r.error.code) ? 503 : 502;
}
