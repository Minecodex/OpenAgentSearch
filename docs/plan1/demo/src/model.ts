export type Lang = 'zh' | 'en';
export type Local = string | readonly [string, string];
export type Origin = 'business' | 'debug' | 'endpoint_test' | 'proxy_test';
export type Page =
  | 'overview'
  | 'projects'
  | 'endpoints'
  | 'proxies'
  | 'languages'
  | 'playground'
  | 'requests'
  | 'observability'
  | 'api';
export type Op = 'list' | 'content' | 'summary';
export type Status = 'success' | 'partial' | 'empty' | 'error' | 'cancelled';
export const ops: Op[] = ['list', 'content', 'summary'];
export const opLabels: Record<Op, [string, string]> = {
  list: ['搜索列表', 'Search list'],
  content: ['网页正文', 'Read content'],
  summary: ['综合总结', 'Synthesis'],
};
export const statusLabels: Record<Status, [string, string]> = {
  success: ['成功', 'Success'],
  partial: ['部分完成', 'Partial'],
  empty: ['无结果', 'Empty'],
  error: ['失败', 'Error'],
  cancelled: ['已取消', 'Cancelled'],
};
export const navLabels: Record<Page, [string, string]> = {
  overview: ['运行总览', 'Overview'],
  projects: ['项目', 'Projects'],
  endpoints: ['接入点', 'Endpoints'],
  proxies: ['VPN 代理', 'VPN proxies'],
  languages: ['语言路由', 'Language routes'],
  playground: ['检索调试', 'Playground'],
  requests: ['请求记录', 'Request log'],
  observability: ['运行观测', 'Observability'],
  api: ['API 文档', 'API reference'],
};
export function local(value: Local, lang: Lang) {
  return typeof value === 'string' ? value : value[lang === 'zh' ? 0 : 1];
}
export function endpointPath(op: Op) {
  return '/v1/search/' + op;
}
export type Kind = 'search' | 'reader' | 'model';
export const kinds: Record<Kind, [string, string]> = {
  search: ['搜索', 'Search'],
  reader: ['正文', 'Reader'],
  model: ['模型', 'Model'],
};
export type EndpointProvider =
  'browser' | 'tavily' | 'searxng' | 'anysearch' | 'deepseek' | 'crawl4ai' | 'openai_compatible';
export type Adapter =
  'http_search' | 'integrated_search' | 'browser_search' | 'http_reader' | 'browser_reader' | 'chat_model';
export type TimeRange = 'day' | 'month' | 'year';
export interface AdapterOptions {
  engine?: string;
  engines?: string[];
  languages?: Lang[];
  time_ranges?: TimeRange[];
  format?: 'html' | 'markdown';
  model?: string;
  tokenizer?: string;
  max_input_tokens?: number;
  max_output_tokens?: number;
}
export interface EndpointTest {
  started?: number;
  version: number;
  status: 'success' | 'error';
  at: number;
  elapsed: number;
  reason: string | null;
  requestId?: string;
}
export interface Endpoint {
  id: string;
  name: Local;
  kind: Kind;
  provider: EndpointProvider | null;
  adapter: Adapter;
  options: AdapterOptions;
  timeoutMs: number;
  version: number;
  hasSecret: boolean;
  builtin?: boolean;
  addon?: 'searxng' | 'crawl4ai';
  limit: number;
  rpm: number;
  address: string;
  lastTest?: EndpointTest;
}
export interface ProxyNode {
  id: string;
  name: Local;
  scheme: 'socks5' | 'https';
  host: string;
  port: number;
  limit: number;
  enabled: boolean;
  auth: boolean;
  tested?: number;
  version?: number;
  lastTest?: EndpointTest;
}
export interface Pool {
  version?: number;
  id: string;
  name: Local;
  members: { id: string; weight: number }[];
}
export interface Project {
  id: string;
  name: Local;
  description: Local;
  searchPools: string[][];
  readerPools: string[][];
  model: string;
  pool: string;
  language: Lang;
  languages: Lang[];
  searchLimit: number;
  sourceLimit: number;
  bodyLimit: number;
  summaryLimit: number;
  rewriteCount: number;
  allowSnippets: boolean;
  version: number;
}
export interface Config {
  projects: Project[];
  endpoints: Endpoint[];
  proxies: ProxyNode[];
  pools: Pool[];
  addons: Record<'searxng' | 'crawl4ai', boolean>;
  routes: Partial<Record<Lang, string[]>>;
  routesVersion: number;
}
export interface Log {
  id: string;
  op: Op;
  project: string;
  query: Local;
  time: number;
  duration: number;
  status: Status;
  generated?: boolean;
  origin?: Origin;
  language?: Lang;
  testTarget?: { id: string; name: Local; kind: Kind | 'proxy'; version?: number };
  dispatches?: import('./routing').DispatchAttempt[];
  snapshot?: {
    wire?: ReturnType<typeof import('./configuration').traceSnapshot>;
    egress?: import('./browser-diagnostics').EgressSnapshot;
    projectName?: Local;
    version: number;
    sourceLimit: number;
    searchLimit?: number;
    bodyLimit?: number;
    summaryLimit?: number;
    rewriteCount?: number;
    allowSnippets?: boolean;
    searchPools?: string[][];
    readerPools?: string[][];
    routeReason?: import('./routing').RouteChoice['reason'];
    readerRouteReason?: import('./routing').RouteChoice['reason'];
    routesVersion?: number;
    endpoints?: Record<
      string,
      {
        version: number;
        adapter: string;
        provider?: EndpointProvider | null;
        timeout_ms: number;
        max_concurrency: number;
        rpm: number;
      }
    >;
    pool: string;
    model: string;
    search: string;
    reader: string;
    names?: Record<string, Local>;
  };

  resources?: Record<Kind, string>;
  rewrites?: string[];
  response?: Envelope;
  input?: Record<string, unknown>;
}
export interface Article {
  id: string;
  name: [string, string];
  publisher: [string, string];
  url: string;
  ageDays: number;
  sourceLanguage?: Lang;
  snippetOnly?: boolean;
  words: string[];
  points: [string, string][];
}
export interface Envelope {
  request_id: string;
  status: Status;
  data: any;
  warnings: { code: string; message: string; details: any }[];
  error: { code: string; message: string; details: any } | null;
}
export const uid = (prefix: string) => prefix + '-' + Math.random().toString(36).slice(2, 10);
export const digits = (x: number) => new Intl.NumberFormat('en-US').format(x);
export const clock = (n: number, seconds = false) =>
  new Date(n).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    ...(seconds ? { second: '2-digit' } : {}),
  });
export const date = (n: number, lang: Lang) =>
  new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-GB', { month: 'short', day: 'numeric' }).format(n);
export const charCount = (s: string) => Array.from(s).length;
