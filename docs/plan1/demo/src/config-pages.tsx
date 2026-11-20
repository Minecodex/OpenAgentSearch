import { providerNames } from './endpoint-providers';
import { adapterNames, languageName, amount, resultUnit, pageUnit, testReason } from './display-values';
import { offlineOutcome } from './routing';
import { Pagination } from './diagnostic-ui';
import { useEffect, useRef, useState } from 'react';
import {
  FileText,
  History,
  FlaskConical,
  Folder,
  Pencil,
  Plus,
  Settings2,
  Square,
} from 'lucide-react';
import { useConsole } from './state';
import { Btn, Empty, IconBtn, PageHead, Panel, SearchBox, Segments } from './ui';
import { Endpoint, type Kind, kinds, clock } from './model';
import { installed, isBrowser } from './configuration';
import { resourceTestLog, attempts } from './diagnostic-data';
export function Projects() {
  const { cfg, open, l, t, lang, selectProject, go } = useConsole();
  const [q, change] = useState('');
  const [page, setPage] = useState(0);
  const items = cfg.projects.filter((p) =>
    (l(p.name) + ' ' + l(p.description)).toLowerCase().includes(q.toLowerCase()),
  );
  const currentPage = Math.min(page, Math.max(0, Math.ceil(items.length / 20) - 1));
  const empty = t('未配置', 'Not configured');
  const name = (id: string) =>
    id ? l(cfg.endpoints.find((e) => e.id === id)?.name ?? t('已移除的接入点', 'Removed endpoint')) : empty;
  const pools = (groups: string[][]) => groups.map((g) => g.map(name).join(' + ')).join(' → ') || empty;
  return (
    <>
      <PageHead
        title={t('项目', 'Projects')}
        sub={t(
          '为每个项目设置能力、路由优先级和执行边界。',
          'Configure capabilities, routing priorities and limits per project.',
        )}
      >
        <Btn primary onPress={() => open('project')} test="new-project">
          <Plus size={16} />
          {t('新建项目', 'New project')}
        </Btn>
      </PageHead>
      <div className="toolbar">
        <SearchBox
          value={q}
          change={(s) => {
            change(s);
            setPage(0);
          }}
          placeholder={t('搜索项目', 'Find a project')}
        />
        <span className="muted">
          {items.length} {t('个项目', 'projects')}
        </span>
      </div>
      <div className="project-grid">
        {items.slice(currentPage * 20, currentPage * 20 + 20).map((p) => (
          <Panel key={p.id} className="project-card project-entry">
            <div className="resource-top">
              <span className="tile-icon">
                <Folder size={22} />
              </span>
              <div className="project-tools">
                <small className="mono">v{p.version}</small>
                <Btn small onPress={() => open('project', p.id)}>
                  <Pencil size={13} />
                  {t('编辑', 'Edit')}
                </Btn>
              </div>
            </div>
            <h2>{l(p.name)}</h2>
            {p.description && <p>{l(p.description)}</p>}
            <dl>
              {[
                [t('搜索池', 'Search pools'), pools(p.searchPools)],
                [t('正文池', 'Reader pools'), pools(p.readerPools)],
                [t('生成模型', 'Model'), name(p.model)],
                [t('默认业务语言', 'Default language'), languageName(p.language, lang)],
                [t('代理池', 'Proxy pool'), l(cfg.pools.find((x) => x.id === p.pool)?.name || empty)],
                [
                  t('查询改写', 'Query rewrites'),
                  p.rewriteCount
                    ? amount(p.rewriteCount, [' 条改写', 'extra queries'], lang)
                    : t('关闭改写', 'Rewriting off'),
                ],
                [
                  t('搜索 / 来源上限', 'Search / source limit'),
                  amount(p.searchLimit, resultUnit, lang) + ' / ' + amount(p.sourceLimit, pageUnit, lang),
                ],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            <footer className="project-actions">
              <Btn small onPress={() => open('project-info', p.id)}>
                <FileText size={15} />
                {t('详情', 'Details')}
              </Btn>
              <Btn
                small
                onPress={() => go('requests', '', new URLSearchParams({ project: p.id }).toString())}
              >
                <History size={15} />
                {t('请求记录', 'Requests')}
              </Btn>
              <Btn
                small
                primary
                onPress={() => {
                  selectProject(p);
                  go('playground');
                }}
              >
                <FlaskConical size={15} />
                {t('调试', 'Inspect')}
              </Btn>
            </footer>
          </Panel>
        ))}
      </div>
      {items.length > 20 && <Pagination page={currentPage} size={20} total={items.length} change={setPage} />}
      {!items.length && <Empty text={t('没有匹配项目', 'No matching projects')} />}
    </>
  );
}
export function Endpoints() {
  const { t, l, lang, cfg, dispatcher, open, setCfg, notify, go, addLog, query: location, updateQuery } = useConsole();
  const kindParam = new URLSearchParams(location).get('kind');
  const kind: Kind = kindParam && Object.hasOwn(kinds, kindParam) ? (kindParam as Kind) : 'search';
  const [q, query] = useState(''),
    [page, setPage] = useState(0);
  const [receipt, setReceipt] = useState<{
    id: string;
    label: string;
    version: number;
    at: number;
    duration: number;
    ok: boolean;
    reason: string | null;
    upstream: number;
    models: number;
  } | null>(null);
  const [testing, setTesting] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rows = cfg.endpoints.filter(
    (e) =>
      e.kind === kind &&
      (l(e.name) + ' ' + (e.provider ? l(providerNames[e.provider]) : '') + ' ' + l(adapterNames[e.adapter]))
        .toLowerCase()
        .includes(q.toLowerCase()),
  );
  const currentPage = Math.min(page, Math.max(0, Math.ceil(rows.length / 20) - 1));
  function cancel() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setTesting('');
  }
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  function test(e: Endpoint) {
    if (timer.current || !installed(cfg, e.id)) return;
    setTesting(e.id);
    const start = Date.now();
    timer.current = setTimeout(() => {
      timer.current = null;
      setTesting('');
      const outcome = offlineOutcome(e);
      const ok = outcome === 'ok';
      const log = resourceTestLog({ id: e.id, name: e.name, kind: e.kind, version: e.version }, lang);
      const duration = Date.now() - start;
      const at = Date.now();
      const reason = outcome === 'risk' ? 'ENDPOINT_RISK_CONTROL' : ok ? null : 'UPSTREAM_UNREACHABLE';
      if (outcome === 'risk') dispatcher.markRisk(e, at);
      log.duration = duration;
      log.time = start;
      log.status = ok ? 'success' : 'error';
      log.response = {
        request_id: log.id,
        status: 'success',
        data: {
          resource_version: e.version,
          status: log.status,
          tested_at: new Date(at).toISOString(),
          elapsed_ms: duration,
          reason,
          trace_request_id: log.id,
        },
        warnings: [],
        error: null,
      };
      addLog(log);
      setCfg((c) => ({
        ...c,
        endpoints: c.endpoints.map((x) =>
          x.id === e.id && x.version === e.version && (x.lastTest?.started ?? 0) <= start
            ? {
                ...x,
                lastTest: {
                  version: e.version,
                  status: ok ? 'success' : 'error',
                  at,
                  started: start,
                  elapsed: duration,
                  reason,
                  requestId: log.id,
                },
              }
            : x,
        ),
      }));
      const sent = attempts(log).filter((c) => c.sent);
      setReceipt({
        id: log.id,
        label: l(e.name),
        version: e.version,
        at,
        duration,
        ok,
        reason,
        upstream: sent.length,
        models: sent.filter((c) => c.kind === 'model').length,
      });
      notify(ok ? t('功能测试通过', 'Capability test passed') : t('功能测试失败', 'Capability test failed'));
    }, 350);
  }
  return (
    <>
      <PageHead
        title={t('接入点', 'Endpoints')}
        sub={t(
          '配置能力、凭据与共享限额，测试已保存的版本。',
          'Configure capabilities, credentials and shared limits. Test a saved version.',
        )}
      >
        <Btn onPress={() => go('languages')}>{t('语言路由', 'Language routes')}</Btn>
        <Btn onPress={() => open('environment')}>
          <Settings2 size={15} />
          {t('组件选项', 'Components')}
        </Btn>
        <Btn primary onPress={() => open('endpoint', undefined, kind)}>
          <Plus size={15} />
          {t('添加' + l(kinds[kind]) + '接入点', 'Add ' + l(kinds[kind]).toLowerCase() + ' endpoint')}
        </Btn>
      </PageHead>
      <div className="toolbar">
        <Segments
          value={kind}
          change={(v) => {
            setPage(0);
            updateQuery({ kind: v });
            query('');
          }}
          label={t('接入点类型', 'Endpoint type')}
          items={[...Object.entries(kinds).map(([id, n]) => ({ id, label: l(n) }))]}
        />
        <SearchBox
          value={q}
          change={(v) => {
            query(v);
            setPage(0);
          }}
          placeholder={t('搜索接入点', 'Find an endpoint')}
        />
      </div>
      {receipt && (
        <div className={'test-receipt ' + (receipt.ok ? 'ok' : 'fault')} role="status">
          <div>
            <strong>
              {receipt.label} · v{receipt.version}
            </strong>
            <span>
              {receipt.ok ? t('测试成功', 'Test passed') : testReason(receipt.reason, lang)} ·{' '}
              {receipt.duration} ms · {clock(receipt.at, true)} · {t('上游调用', 'Upstream calls')}{' '}
              {receipt.upstream} · {t('其中模型', 'Model calls')} {receipt.models}
            </span>
          </div>
          <Btn
            small
            onPress={() =>
              go(
                'requests',
                receipt.id,
                new URLSearchParams({ back: 'endpoints', returnQuery: location }).toString(),
              )
            }
          >
            {t('查看测试链路', 'Inspect test trace')}
          </Btn>
        </div>
      )}
      <Panel>
        <div className="table-scroll">
          <table className="data-table resource-table">
            <thead>
              <tr>
                {[
                  t('接入点 / 服务商', 'Endpoint / provider'),
                  t('凭据', 'Credentials'),
                  t('超时', 'Timeout'),
                  t('并发 / 每分钟上限', 'Concurrency / per minute'),
                  t('状态', 'Availability'),
                  t('本版本测试', 'Version test'),
                  t('操作', 'Actions'),
                ].map((x) => (
                  <th key={x}>{x}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(currentPage * 20, currentPage * 20 + 20).map((e) => {
                const last = e.lastTest?.version === e.version ? e.lastTest : undefined;
                return (
                  <tr key={e.id}>
                    <td>
                      <button className="row-link" onClick={() => open('endpoint-info', e.id)}>
                        {l(e.name)}
                      </button>
                      <code>
                        {e.provider ? l(providerNames[e.provider]) : t('待选择服务商', 'Provider not set')} ·
                        v{e.version}
                        {e.builtin ? ' · ' + t('内置', 'built-in') : ''}
                      </code>
                      {e.address && <small className="row-sub">{e.address}</small>}
                    </td>
                    <td>
                      {isBrowser(e.adapter)
                        ? t('无需凭据', 'Not required')
                        : e.hasSecret
                          ? t('已配置', 'Configured')
                          : t('未配置', 'Not set')}
                    </td>
                    <td>{e.timeoutMs / 1000} s</td>
                    <td className="mono">
                      {e.limit} / {e.rpm}
                    </td>
                    <td>
                      <span className={'health-label ' + (installed(cfg, e.id) ? 'on' : 'off')}>
                        <i />
                        {installed(cfg, e.id)
                          ? t('可用', 'Ready')
                          : e.provider
                            ? t('未安装', 'Not installed')
                            : t('待配置', 'Needs configuration')}
                      </span>
                    </td>
                    <td>
                      {last ? (
                        <button
                          className="text-link"
                          disabled={!last.requestId}
                          onClick={() =>
                            go(
                              'requests',
                              last.requestId,
                              new URLSearchParams({ back: 'endpoints', returnQuery: location }).toString(),
                            )
                          }
                        >
                          {last.status === 'success' ? t('通过', 'Passed') : t('失败', 'Failed')} ·{' '}
                          {clock(last.at)}
                        </button>
                      ) : (
                        t('未测试', 'Untested')
                      )}
                    </td>
                    <td>
                      <div className="table-actions">
                        {testing === e.id ? (
                          <Btn small onPress={cancel}>
                            <Square size={12} />
                            {t('取消测试', 'Cancel test')}
                          </Btn>
                        ) : (
                          <Btn small disabled={!!testing || !installed(cfg, e.id)} onPress={() => test(e)}>
                            {t('测试', 'Test')}
                          </Btn>
                        )}
                        <IconBtn
                          icon={Pencil}
                          label={t('编辑', 'Edit') + ' ' + l(e.name)}
                          onPress={() => open('endpoint', e.id)}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {rows.length > 20 && <Pagination page={currentPage} size={20} total={rows.length} change={setPage} />}
        {!rows.length && <Empty text={t('没有匹配接入点', 'No matching endpoints')} />}
      </Panel>
    </>
  );
}
