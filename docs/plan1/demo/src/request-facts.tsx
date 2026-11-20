import { callerTimeLabel } from './display-values';
import { requestRows, type RequestInput, type RequestDefaults } from './request-values';
import { useConsole } from './state';
import { KeyValues } from './diagnostic-ui';
import { type Op, type Envelope } from './model';
import { languageName, fieldLabels } from './display-values';
import type { RewriteJob } from './rewrite';
export function RequestFacts({
  op,
  input,
  defaults,
}: {
  op: Op;
  input: RequestInput;
  defaults: RequestDefaults;
}) {
  const { lang } = useConsole();
  return (
    <div className="request-facts" data-testid="request-facts">
      <KeyValues items={requestRows(op, input, defaults, lang)} />
    </div>
  );
}
export function RewriteFacts({ job }: { job: RewriteJob }) {
  const { t, lang } = useConsole();
  const { region, current_time, rewrite_count, language } = job.user;
  const rows: [string, string][] = [
    [t('生成语言', 'Query language'), languageName(language, lang)],
    [t('额外查询上限', 'Additional query limit'), String(rewrite_count)],
  ];
  if (region !== undefined) rows.push([t('地点参照', 'Location reference'), region]);
  if (current_time !== undefined)
    rows.push([t('当地日期参照', 'Local date reference'), callerTimeLabel(current_time)]);
  return (
    <section className="read-section" data-testid="rewrite-facts">
      <h3>{t('问题改写依据', 'Query rewrite context')}</h3>
      <KeyValues items={rows} />
    </section>
  );
}
export function FailureFacts({ error, op }: { error: NonNullable<Envelope['error']>; op: Op }) {
  const { t, l } = useConsole(),
    d = error.details;
  const rows: [string, string][] = [];
  if (d && typeof d === 'object') {
    if (typeof d.field === 'string' && fieldLabels[d.field])
      rows.push([
        t('需要检查', 'Check this field'),
        d.field === 'max_chars' && op === 'summary'
          ? t('总结字数', 'Summary length')
          : l(fieldLabels[d.field]),
      ]);
    if (typeof d.capability === 'string' && fieldLabels[d.capability])
      rows.push([t('所需能力', 'Required capability'), l(fieldLabels[d.capability])]);
    if (typeof d.limit === 'number') rows.push([t('项目上限', 'Project limit'), String(d.limit)]);
    if (typeof d.received === 'number') rows.push([t('当前填写值', 'Entered value'), String(d.received)]);
  }
  return (
    <div className="result-message fault" role="alert">
      <strong>{error.message}</strong>
      {rows.length > 0 && <KeyValues items={rows} />}
    </div>
  );
}
