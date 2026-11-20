import { callerTimeLabel } from './display-values';
import { opLabels, local, type Op, type Lang } from './model';
import {
  languageName,
  rangeNames,
  fieldLabels,
  amount,
  charUnit,
  pageUnit,
  resultUnit,
} from './display-values';
export type RequestDefaults = {
  useProjectDefaults?: boolean;
  language?: string;
  searchLimit?: number;
  sourceLimit?: number;
  bodyLimit?: number;
  summaryLimit?: number;
  rewriteCount?: number;
};
export type RequestInput = {
  query?: unknown;
  url?: unknown;
  language?: unknown;
  time_range?: unknown;
  count?: unknown;
  source_count?: unknown;
  max_chars?: unknown;
  region?: unknown;
  current_time?: unknown;
};
export function requestRows(
  op: Op,
  input: RequestInput,
  defaults: RequestDefaults,
  lang: Lang,
): [string, string][] {
  const t = (zh: string, en: string) => local([zh, en], lang);
  const label = (k: string) => local(fieldLabels[k], lang);
  const rows: [string, string][] = [
    [t('业务操作', 'Operation'), local(opLabels[op], lang)],
    [label(op === 'content' ? 'url' : 'query'), String((op === 'content' ? input.url : input.query) ?? '—')],
  ];
  if (op !== 'content') {
    const code = typeof input.language === 'string' ? input.language : defaults.language;
    rows.push([
      label('language'),
      code
        ? languageName(code, lang) +
          (input.language === undefined ? t('（项目默认）', ' (project default)') : '')
        : t('未记录', 'Not recorded'),
    ]);
    const range = input.time_range;
    rows.push([
      label('time_range'),
      range === 'day' || range === 'month' || range === 'year'
        ? local(rangeNames[range], lang)
        : t('不限', 'Any time'),
    ]);
  }
  function limit(title: string, value: unknown, fallback: number | undefined, unit: typeof charUnit) {
    const n = typeof value === 'number' ? value : fallback;
    rows.push([
      title,
      n === undefined
        ? defaults.useProjectDefaults
          ? t('采用项目默认值', 'Project default')
          : t('未记录', 'Not recorded')
        : amount(n, unit, lang) + (value === undefined ? t('（项目默认）', ' (project default)') : ''),
    ]);
  }
  if (op === 'list') limit(label('count'), input.count, defaults.searchLimit, resultUnit);
  if (op === 'content') limit(label('max_chars'), input.max_chars, defaults.bodyLimit, charUnit);
  if (op === 'summary') {
    limit(label('source_count'), input.source_count, defaults.sourceLimit, pageUnit);
    limit(t('整体总结上限', 'Summary character limit'), input.max_chars, defaults.summaryLimit, charUnit);
    if (typeof input.region === 'string' && input.region.length) rows.push([label('region'), input.region]);
    if (typeof input.current_time === 'string' && input.current_time.length)
      rows.push([label('current_time'), callerTimeLabel(input.current_time)]);
  }
  return rows;
}
