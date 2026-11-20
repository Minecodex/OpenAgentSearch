import { acceptsProvider } from './endpoint-providers';
import {
  Adapter,
  AdapterOptions,
  Config,
  Endpoint,
  Kind,
  Lang,
  Project,
  ProxyNode,
  Pool,
  TimeRange,
} from './model';

export const ranges: TimeRange[] = ['day', 'month', 'year'];
export const languages: Lang[] = ['zh', 'en'];
export function isBrowser(a: Adapter) {
  return a === 'browser_search' || a === 'browser_reader';
}
export function defaultEndpointTimeout(kind: Kind) {
  return { search: 3000, reader: 8000, model: 15000 }[kind];
}
export function defaultOptions(a: Adapter): AdapterOptions {
  if (a === 'browser_search')
    return { engine: 'field-index', languages: [...languages], time_ranges: [...ranges] };
  if (a === 'http_search' || a === 'integrated_search')
    return { languages: [...languages], time_ranges: [...ranges] };
  if (a === 'chat_model')
    return {
      model: 'demo-model',
      tokenizer: 'demo-tokenizer',
      max_input_tokens: 8192,
      max_output_tokens: 1024,
    };
  return a === 'http_reader' ? { format: 'markdown' } : {};
}
type StoredEndpoint = Omit<Endpoint, 'options' | 'timeoutMs' | 'hasSecret' | 'version' | 'provider'> &
  Partial<Pick<Endpoint, 'options' | 'timeoutMs' | 'hasSecret' | 'version' | 'provider'>>;
type StoredProject = Pick<
  Project,
  'id' | 'name' | 'description' | 'model' | 'pool' | 'language' | 'version'
> &
  Partial<Project> & { search?: string; reader?: string; limit?: number };
export interface StoredConfig {
  projects: StoredProject[];
  endpoints: StoredEndpoint[];
  proxies: ProxyNode[];
  pools: Pool[];
  addons: Config['addons'];
  routes: Config['routes'];
  routesVersion?: number;
}
// Only infer identities that are explicit in the bundled fixtures or in the transport itself.
function storedProvider(e: StoredEndpoint): Endpoint['provider'] {
  const value =
    e.provider === undefined
      ? isBrowser(e.adapter)
        ? 'browser'
        : e.adapter === 'chat_model'
          ? 'openai_compatible'
          : (e.addon ?? (e.id === 'index' ? 'tavily' : e.id === 'reader' ? 'anysearch' : null))
      : e.provider;
  return value && acceptsProvider(e.kind, value, e.adapter) ? value : null;
}
export function hydrateConfig(raw: StoredConfig): Config {
  return {
    ...raw,
    routesVersion: raw.routesVersion ?? 1,
    proxies: raw.proxies.map((p) => ({ ...p, version: p.version ?? 1 })),
    pools: raw.pools.map((p) => ({ ...p, version: p.version ?? 1 })),
    endpoints: raw.endpoints.map((e) => ({
      ...e,
      provider: storedProvider(e),
      options: e.options ?? defaultOptions(e.adapter),
      address: e.address || (e.addon && !isBrowser(e.adapter) ? 'https://' + e.id + '.example.org' : ''),
      timeoutMs: e.timeoutMs ?? defaultEndpointTimeout(e.kind),
      version: e.version ?? 1,
      hasSecret: !!e.hasSecret,
    })),
    projects: raw.projects.map((p) => {
      const { id, name, description, model, pool, language, version, search, reader, limit } = p;
      return {
        id,
        name,
        description,
        model,
        pool,
        language,
        version,
        searchPools: p.searchPools ?? (search ? [[search]] : []),
        readerPools: p.readerPools ?? (reader ? [[reader]] : []),
        languages: p.languages ?? [...languages],
        searchLimit: p.searchLimit ?? 10,
        sourceLimit: p.sourceLimit ?? limit ?? 4,
        bodyLimit: p.bodyLimit ?? 40000,
        summaryLimit: p.summaryLimit ?? 1200,
        rewriteCount: p.rewriteCount ?? (p.id === 'coastal' ? 1 : 0),
        allowSnippets: p.allowSnippets ?? false,
      };
    }),
  };
}
export function wireId(value: string): string {
  if (/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(value)) return value;
  // Named fixtures retain readable local keys; request previews always use UUIDs.
  let h = 0x811c9dc5,
    h2 = 5381;
  for (const c of value) {
    h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    h2 = Math.imul(h2, 33) ^ c.charCodeAt(0);
  }
  return (
    '00000000-0000-4000-8000-' +
    (h >>> 0).toString(16).padStart(8, '0') +
    (h2 >>> 0).toString(16).padStart(8, '0').slice(-4)
  );
}
export function projectCommand(p: Project, name: string, expected?: number) {
  return {
    name,
    default_language: p.language,
    languages: p.languages,
    search_pools: p.searchPools.map((g) => g.map(wireId)),
    reader_pools: p.readerPools.map((g) => g.map(wireId)),
    model_endpoint_id: p.model ? wireId(p.model) : null,
    browser_proxy_pool_id: p.pool ? wireId(p.pool) : null,
    search_limit: p.searchLimit,
    source_limit: p.sourceLimit,
    body_limit: p.bodyLimit,
    summary_limit: p.summaryLimit,
    rewrite_count: p.rewriteCount,
    allow_snippets: p.allowSnippets,
    ...(expected === undefined ? {} : { expected_version: expected }),
  };
}
export function primaryResources(p: Project) {
  return { search: p.searchPools[0]?.[0] ?? '', reader: p.readerPools[0]?.[0] ?? '', model: p.model };
}
export function usesEndpoint(p: Project, id: string) {
  return (
    p.model === id || p.searchPools.some((g) => g.includes(id)) || p.readerPools.some((g) => g.includes(id))
  );
}
export function installed(cfg: Config, id: string) {
  const e = cfg.endpoints.find((x) => x.id === id);
  return !!e && acceptsProvider(e.kind, e.provider, e.adapter) && (!e.addon || cfg.addons[e.addon]);
}
export function livePool(cfg: Config, id: string) {
  return !!cfg.pools
    .find((p) => p.id === id)
    ?.members.some((m) => cfg.proxies.some((n) => n.id === m.id && n.enabled));
}
const pos = (x: number) => Number.isSafeInteger(x) && x > 0;
export type Problem = [string, string, string];
export function endpointProblem(e: Endpoint, action: string, key: string): Problem | undefined {
  if (typeof e.name !== 'string' || !e.name.trim() || [...e.name].length > 100)
    return ['name', '名称须为 1–100 个字符。', 'Use a name of 1–100 characters.'];
  if (!acceptsProvider(e.kind, e.provider, e.adapter))
    return ['provider', '请选择支持当前能力的服务商。', 'Select a provider for this capability.'];
  if (e.provider !== 'searxng' && e.options.engines !== undefined)
    return ['options.engines', '引擎列表仅适用于 SearXNG。', 'Engine lists apply to SearXNG.'];
  if (![e.timeoutMs, e.limit, e.rpm].every(pos))
    return [
      'timeout_ms / max_concurrency / rpm',
      '超时、并发和 RPM 必须是正整数（超时换算为毫秒）。',
      'Timeout in milliseconds, concurrency and RPM must be positive integers.',
    ];
  if (!isBrowser(e.adapter)) {
    try {
      const u = new URL(e.address);
      if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.search || u.hash)
        throw Error();
    } catch {
      return [
        'base_url',
        '请填写不含凭据、查询或片段的 HTTP(S) 基址。',
        'Use an HTTP(S) base URL without credentials, query or fragment.',
      ];
    }
  }
  if (!isBrowser(e.adapter) && action === 'replace' && !key.trim())
    return ['secret.api_key', '请填写新的示例 Key。', 'Enter a nonblank replacement sample key.'];
  const o = e.options;
  if (
    e.kind === 'search' &&
    (!o.languages?.length ||
      new Set(o.languages).size !== o.languages.length ||
      o.languages.some((k) => !languages.includes(k)) ||
      !Array.isArray(o.time_ranges) ||
      new Set(o.time_ranges).size !== o.time_ranges.length ||
      o.time_ranges.some((n) => !ranges.includes(n)))
  )
    return [
      'options',
      '请选择搜索语言与合法的时间能力。',
      'Choose supported languages and valid time capabilities.',
    ];
  if (e.adapter === 'browser_search' && !o.engine?.trim())
    return ['options.engine', '请输入已注册的搜索引擎标识。', 'Enter a registered engine ID.'];
  if (o.engines && (new Set(o.engines).size !== o.engines.length || o.engines.some((i) => !i.trim())))
    return ['options.engines', '引擎标识不能空白或重复。', 'Engine IDs must be nonblank and unique.'];
  if (
    e.kind === 'model' &&
    (!o.model?.trim() ||
      !o.tokenizer?.trim() ||
      !pos(o.max_input_tokens ?? 0) ||
      !pos(o.max_output_tokens ?? 0))
  )
    return [
      'options',
      '模型、分词器及正整数输入/输出 Token 上限均为必填。',
      'Specify the model, tokenizer and positive input/output token limits.',
    ];
  if (e.adapter === 'http_reader' && !['html', 'markdown'].includes(o.format ?? ''))
    return ['options.format', '请选择正文返回格式。', 'Choose an article format.'];
}
export function projectProblem(p: Project, cfg: Config): Problem | undefined {
  if (typeof p.name !== 'string' || !p.name.trim() || [...p.name].length > 100)
    return ['name', '项目名称须为 1–100 个字符。', 'Use a project name of 1–100 characters.'];
  if (
    !p.languages.length ||
    !p.languages.includes(p.language) ||
    new Set(p.languages).size !== p.languages.length
  )
    return [
      'default_language',
      '默认语言必须属于项目允许语言。',
      'Include the default language in the allowed set.',
    ];
  if (
    ![p.searchLimit, p.sourceLimit, p.bodyLimit, p.summaryLimit].every(pos) ||
    p.searchLimit > 10 ||
    p.sourceLimit > p.searchLimit
  )
    return [
      'limits',
      '所有上限须为正整数，来源数 ≤ 搜索数 ≤ 10。',
      'Use positive limits and keep sources ≤ search results ≤ 10.',
    ];
  if (!Number.isInteger(p.rewriteCount) || p.rewriteCount < 0 || p.rewriteCount > 3)
    return ['rewrite_count', '改写数量只能为 0–3。', 'Choose 0–3 query variants.'];
  let browser = false;
  for (const [kind, groups] of [
    ['search', p.searchPools],
    ['reader', p.readerPools],
  ] as const) {
    if (groups.some((g) => !g.length) || new Set(groups.flat()).size !== groups.flat().length)
      return [
        kind + '_pools',
        '池内必须有成员，同一能力的端点不能重复。',
        'Each pool needs members; an endpoint may appear only once per capability.',
      ];
    for (const id of groups.flat()) {
      const e = cfg.endpoints.find((x) => x.id === id);
      if (e?.kind !== kind || !installed(cfg, id))
        return [
          kind + '_pools',
          '请移除不可用或类型不匹配的成员。',
          'Remove unavailable or incompatible members.',
        ];
      browser ||= isBrowser(e.adapter);
    }
  }
  if (p.model && !cfg.endpoints.some((e) => e.id === p.model && e.kind === 'model' && installed(cfg, e.id)))
    return ['model_endpoint_id', '请选择可用模型。', 'Select an available model.'];
  if ((p.pool && !cfg.pools.some((g) => g.id === p.pool)) || (browser && !livePool(cfg, p.pool)))
    return [
      'browser_proxy_pool_id',
      '浏览器能力须绑定有可用出口的代理池。',
      'Bind a pool with enabled egress for browser capabilities.',
    ];
}
export function traceSnapshot(cfg: Config, p: Project, lang: Lang) {
  const name = (v: Endpoint['name']) => (typeof v === 'string' ? v : v[lang === 'zh' ? 0 : 1]);
  const ids = new Set([...p.searchPools.flat(), ...p.readerPools.flat(), p.model]);
  return {
    project: { ...projectCommand(p, name(p.name)), id: wireId(p.id), version: p.version },
    routes_version: cfg.routesVersion,
    endpoints: cfg.endpoints
      .filter((e) => ids.has(e.id))
      .map((e) => ({
        id: wireId(e.id),
        name: name(e.name),
        version: e.version,
        kind: e.kind,
        adapter: e.adapter,
        provider: e.provider,
        timeout_ms: e.timeoutMs,
        max_concurrency: e.limit,
        rpm: e.rpm,
      })),
  };
}
