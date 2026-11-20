import { validCallerTime } from './rewrite';
import type { Adapter, Lang, Local, TimeRange } from './model';
import { local } from './model';
export const adapterNames: Record<Adapter, Local> = {
  browser_search: ['浏览器搜索', 'Browser search'],
  http_search: ['HTTP 搜索服务', 'HTTP search service'],
  integrated_search: ['附带正文的搜索服务', 'Search with article content'],
  browser_reader: ['浏览器正文提取', 'Browser article reader'],
  http_reader: ['HTTP 正文服务', 'HTTP article reader'],
  chat_model: ['对话模型', 'Chat model'],
};
export const rangeNames: Record<TimeRange, Local> = {
  day: ['近一天', 'Last day'],
  month: ['近一月', 'Last month'],
  year: ['近一年', 'Last year'],
};
export function languageName(code: string, lang: Lang) {
  if (code === 'zh') return local(['中文', 'Chinese'], lang);
  if (code === 'en') return local(['英语', 'English'], lang);
  return code;
}
export function amount(value: number, unit: Local, lang: Lang) {
  return (
    value.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US') + (lang === 'zh' ? '' : ' ') + local(unit, lang)
  );
}
export const charUnit: Local = [' 字符', 'characters'];
export const resultUnit: Local = [' 条', 'results'];
export const pageUnit: Local = [' 页', 'pages'];
export const fieldLabels: Record<string, Local> = {
  query: ['检索问题', 'Search query'],
  url: ['网页地址', 'Article URL'],
  region: ['地区', 'Region'],
  current_time: ['调用方当地时间', 'Caller local time'],
  count: ['结果数量', 'Result count'],
  source_count: ['来源上限', 'Source limit'],
  max_chars: ['字符上限', 'Character limit'],
  language: ['业务语言', 'Content language'],
  time_range: ['检索时间范围', 'Search window'],
  search: ['搜索接入点', 'Search endpoint'],
  reader: ['正文接入点', 'Reader endpoint'],
  model: ['生成模型', 'Generation model'],
};
export function testReason(reason: string | null | undefined, lang: Lang) {
  if (!reason) return '—';
  if (reason === 'ENDPOINT_RISK_CONTROL')
    return local(['接入点触发风控', 'Endpoint reported a risk restriction'], lang);
  if (reason === 'UPSTREAM_UNREACHABLE')
    return local(['无法连接到上游服务', 'Could not reach the upstream service'], lang);
  return local(['测试未通过', 'Test failed'], lang);
}
export const answerSources = {
  body: ['网页正文', 'Article body'],
  snippet: ['搜索简介', 'Search snippet'],
  mixed: ['正文与简介', 'Body and snippet'],
  search_results: ['搜索结果', 'Search results'],
  none: ['无结果', 'No result'],
} as const;
export function callerTimeLabel(value: string) {
  if (!validCallerTime(value)) return value;
  const offset = value.endsWith('Z') ? 'Z' : value.slice(-6);
  return value.slice(0, -offset.length).replace('T', ' ') + ' (UTC' + (offset === 'Z' ? '' : offset) + ')';
}
