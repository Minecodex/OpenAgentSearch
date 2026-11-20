import { wireId } from './configuration';
import { languageName } from './display-values';
import { browserDiagnostics, browserPhaseLabels } from './browser-diagnostics';
import { ArrowRight, Clock3, CornerDownRight, Network } from 'lucide-react';
import { useConsole } from './state';
import {
  Attempt,
  endpointName,
  evaluationNames,
  originNames,
  projectLabel,
  reasonNames,
  phaseNames,
  sampleConfig,
} from './diagnostic-data';
import { fmt, percentage, stamp } from './investigation';
import { Btn, StateChip } from './ui';
import { KeyValues, SideSheet } from './diagnostic-ui';
import { Log, local } from './model';
export function CallSheet({
  call,
  request,
  zone,
  close,
  trace,
}: {
  call: Attempt;
  request: Log;
  zone: string;
  close: () => void;
  trace: () => void;
}) {
  const { t, lang, cfg } = useConsole(),
    c = call;
  const version =
    request.snapshot?.endpoints?.[c.endpoint]?.version ??
    request.testTarget?.version ??
    (!request.generated ? sampleConfig.endpoints.find((e) => e.id === c.endpoint)?.version : undefined);
  const browser = browserDiagnostics(request, c, lang);
  const value =
    c.kind === 'search'
      ? fmt(percentage(c.relevant, c.candidates), '%')
      : c.kind === 'reader'
        ? c.chars === null
          ? '—'
          : c.chars + ' ' + t('字符', 'chars')
        : '—';
  return (
    <SideSheet title={t('调用详情', 'Call detail')} close={close}>
      <div className="sheet-identity">
        <span className="tile-icon">
          <Network size={20} />
        </span>
        <div>
          <strong>{endpointName(c.endpoint, cfg, lang, request)}</strong>
          <code>{c.id}</code>
        </div>
        <StateChip value={c.status} />
      </div>
      <div className="sheet-query">
        <small>{c.kind === 'reader' ? t('目标 URL', 'Target URL') : t('输入', 'Input')}</small>
        <p>{c.target}</p>
      </div>
      <KeyValues
        items={[
          [t('项目', 'Project'), projectLabel(request, cfg, lang)],
          [t('来源', 'Origin'), local(originNames[c.origin], lang)],
          [t('请求 ID', 'Request ID'), c.requestId],
          [t('业务语言', 'Language'), languageName(c.language, lang)],
        ]}
      />
      <section>
        <h3>
          <Clock3 size={16} />
          {t('时间分解', 'Timing breakdown')}
        </h3>
        <div className="timing-scale">
          <i style={{ width: (100 * c.queue) / Math.max(1, c.duration + c.queue) + '%' }} />
          <b />
        </div>
        <KeyValues
          items={[
            [t('排队 / 执行', 'Queued / executing'), c.queue + ' ms / ' + c.duration + ' ms'],
            [t('总尝试耗时', 'Total attempt'), c.queue + c.duration + ' ms'],
            [t('开始', 'Started'), stamp(c.started, zone)],
            [t('完成', 'Finished'), stamp(c.time, zone) + ' · ' + zone],
          ]}
        />
      </section>
      <section>
        <h3>{t('结果与评价', 'Result and evaluation')}</h3>
        <KeyValues
          items={[
            [t('评价状态', 'Evaluation'), local(evaluationNames[c.evaluation], lang)],
            ...(c.kind === 'search'
              ? [
                  [
                    t('候选 / 已评 / 相关', 'Candidates / scored / relevant'),
                    c.candidates + ' / ' + c.evaluated + ' / ' + c.relevant,
                  ] as [string, string],
                ]
              : []),
            [
              c.kind === 'reader' ? t('正文字数', 'Article length') : t('单次质量', 'Quality'),
              c.kind === 'search' && c.evaluation !== 'complete' ? '—' : value,
            ],
            [t('已发送', 'Dispatched'), c.sent ? t('是', 'Yes') : t('否', 'No')],
          ]}
        />
      </section>
      <section>
        <h3>{t('路由决策', 'Routing decision')}</h3>
        <KeyValues
          items={[
            [t('原因', 'Reason'), local(reasonNames[c.reason], lang)],
            ...(c.dispatch ? [[t('项目池优先级', 'Project pool priority'), String(c.dispatch.pool + 1)] as [string, string]] : []),
            ...(c.dispatch && c.dispatch.outcome !== 'ok' ? [[
              t('接入点结果', 'Endpoint outcome'),
              c.dispatch.outcome === 'risk' ? t('接入点风控', 'Endpoint risk restriction') : t('暂时不可用', 'Temporarily unavailable'),
            ] as [string, string]] : []),
            [t('接入点 ID', 'Endpoint ID'), wireId(c.endpoint)],
            [
              t('执行时的端点版本', 'Endpoint version at dispatch'),
              version === undefined ? '—' : 'v' + version,
            ],
            [t('关联阶段', 'Trace stage'), local(phaseNames[c.phase], lang)],
          ]}
        />
      </section>
      {browser && (
        <section className="browser-job">
          <h3>{t('浏览器任务与出口', 'Browser job and egress')}</h3>
          <KeyValues
            items={[
              [t('任务 ID', 'Job ID'), browser.job_id],
              [t('项目代理池', 'Project proxy pool'), browser.pool_name],
              [t('分配的代理', 'Assigned proxy'), browser.proxy_name + ' · ' + browser.scheme.toUpperCase()],
              [t('代理 ID', 'Proxy ID'), browser.proxy_id],
            ]}
          />
          <ol>
            {browser.phases.map((p) => (
              <li key={p.stage}>
                <span className={'phase-dot ' + (p.status === 'error' ? 'failed' : '')} />
                <span>{local(browserPhaseLabels[p.stage], lang)}</span>
                <small>{p.status === 'error' ? t('失败', 'Failed') : ''}</small>
                <code>{p.duration_ms} ms</code>
              </li>
            ))}
          </ol>
        </section>
      )}
      <div className="sheet-actions">
        <Btn primary onPress={trace} test="call-to-trace">
          <CornerDownRight size={15} />
          {t('打开关联请求', 'Open linked request')}
          <ArrowRight size={14} />
        </Btn>
      </div>
    </SideSheet>
  );
}
