import { apiExample } from './api-example';
import { RequestFacts } from './request-facts';
import { testReason, fieldLabels } from './display-values';
import { useState } from 'react';
import reference from 'oas:contracts';
import { Clipboard, FlaskConical, Network, Pencil, Plus, Power } from 'lucide-react';
import { useConsole } from './state';
import { resourceTestLog } from './diagnostic-data';
import { Op, clock, opLabels } from './model';
import { Btn, Caption, Empty, IconBtn, PageHead, Panel, SearchBox, Segments, useCopy } from './ui';
function Healthy({ on, label }: { on: boolean; label: string }) {
  return (
    <span className={'health-label ' + (on ? 'on' : 'off')}>
      <i />
      {label}
    </span>
  );
}
export function Proxies() {
  const { cfg, t, l, open, setCfg, notify, addLog, lang, go } = useConsole();
  const [tab, choose] = useState('proxies');
  const [q, query] = useState('');
  const rows = cfg.proxies.filter((p) =>
    (l(p.name) + ' ' + p.host + ' ' + p.scheme).toLowerCase().includes(q.toLowerCase()),
  );
  const pools = cfg.pools.filter((p) => l(p.name).toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <PageHead
        title={t('VPN 代理', 'VPN proxies')}
        sub={t(
          '为浏览器任务配置出口与调度权重。',
          'Configure egress and scheduling weights for browser jobs.',
        )}
      >
        <Btn primary onPress={() => open(tab === 'proxies' ? 'proxy' : 'pool')}>
          <Plus size={15} />
          {tab === 'proxies' ? t('添加代理', 'Add proxy') : t('新建代理池', 'New proxy pool')}
        </Btn>
      </PageHead>
      <div className="toolbar">
        <Segments
          label={t('网络资源', 'Network resources')}
          value={tab}
          change={(v) => {
            choose(v);
            query('');
          }}
          items={[
            { id: 'proxies', label: t('代理列表', 'Proxies') + ' · ' + cfg.proxies.length },
            { id: 'pools', label: t('代理池', 'Pools') + ' · ' + cfg.pools.length },
          ]}
        />
        <SearchBox placeholder={t('查找资源', 'Find resource')} value={q} change={query} />
      </div>
      {tab === 'proxies' ? (
        <Panel>
          <div className="table-scroll">
            <table className="data-table resource-table">
              <thead>
                <tr>
                  {[
                    t('代理出口', 'Egress'),
                    t('协议', 'Protocol'),
                    t('容量', 'Capacity'),
                    t('状态', 'Status'),
                    t('操作', 'Actions'),
                  ].map((n) => (
                    <th key={n}>{n}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <button className="row-link" onClick={() => open('proxy-info', p.id)}>
                        {l(p.name)}
                      </button>
                      <code>
                        {p.host}:{p.port}
                      </code>
                    </td>
                    <td>
                      <span className="code-chip">{p.scheme.toUpperCase()}</span>
                    </td>
                    <td className="mono">{p.limit}</td>
                    <td>
                      <Healthy
                        on={p.enabled}
                        label={p.enabled ? t('已启用', 'Enabled') : t('已停用', 'Disabled')}
                      />
                      {p.lastTest?.requestId ? (
                        <button
                          className="text-link"
                          onClick={() => go('requests', p.lastTest!.requestId, 'back=proxies')}
                        >
                          {p.lastTest.status === 'success'
                            ? t('测试通过', 'Test passed')
                            : t('测试失败', 'Test failed')}{' '}
                          · {p.lastTest.elapsed} ms ↗
                        </button>
                      ) : (
                        p.tested && (
                          <code>
                            {t('已测', 'Tested')} {clock(p.tested)}
                          </code>
                        )
                      )}
                    </td>
                    <td>
                      <div className="table-actions">
                        <Btn
                          small
                          disabled={!p.enabled}
                          onPress={() => {
                            const version = p.version ?? 1,
                              ok = !p.host.toLowerCase().endsWith('.invalid');
                            const log = resourceTestLog(
                              { id: p.id, name: p.name, kind: 'proxy', version },
                              lang,
                            );
                            const at = log.time + log.duration,
                              reason = ok ? null : 'UPSTREAM_UNREACHABLE';
                            log.status = ok ? 'success' : 'error';
                            log.response = {
                              request_id: log.id,
                              status: 'success',
                              data: {
                                resource_version: version,
                                status: log.status,
                                tested_at: new Date(at).toISOString(),
                                elapsed_ms: log.duration,
                                reason,
                                trace_request_id: log.id,
                              },
                              warnings: [],
                              error: null,
                            };
                            addLog(log);
                            setCfg((c) => ({
                              ...c,
                              proxies: c.proxies.map((x) =>
                                x.id === p.id && (x.version ?? 1) === version
                                  ? {
                                      ...x,
                                      tested: at,
                                      lastTest: {
                                        version,
                                        at,
                                        status: ok ? 'success' : 'error',
                                        elapsed: log.duration,
                                        reason,
                                        requestId: log.id,
                                      },
                                    }
                                  : x,
                              ),
                            }));
                            notify(
                              ok ? t('代理连通性测试通过', 'Proxy test passed') : testReason(reason, lang),
                            );
                          }}
                        >
                          {t('测试', 'Test')}
                        </Btn>
                        <IconBtn
                          icon={Pencil}
                          label={t('编辑', 'Edit') + ' ' + l(p.name)}
                          onPress={() => open('proxy', p.id)}
                        />
                        <IconBtn
                          icon={Power}
                          label={p.enabled ? t('停用代理', 'Disable proxy') : t('启用代理', 'Enable proxy')}
                          onPress={() => open('toggle-proxy', p.id)}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!rows.length && <Empty text={t('没有匹配代理', 'No matching proxies')} />}
        </Panel>
      ) : (
        <div className="project-grid">
          {pools.map((p) => (
            <Panel key={p.id} className="project-card">
              <span className="tile-icon">
                <Network size={21} />
              </span>
              <h2>
                <button className="row-link" onClick={() => open('pool-info', p.id)}>
                  {l(p.name)}
                </button>
              </h2>
              <dl>
                {p.members.map((m) => (
                  <div key={m.id}>
                    <dt>{l(cfg.proxies.find((n) => n.id === m.id)?.name || '—')}</dt>
                    <dd>
                      {t('权重', 'Weight')} {m.weight}
                    </dd>
                  </div>
                ))}
              </dl>
              <footer>
                <Btn small onPress={() => open('pool', p.id)}>
                  {t('编辑成员', 'Edit members')}
                </Btn>
              </footer>
            </Panel>
          ))}
          {!pools.length && <Empty text={t('没有匹配代理池', 'No matching pools')} />}
        </div>
      )}
    </>
  );
}
export function Reference() {
  const { t, l, go, lang } = useConsole();
  const [group, setGroup] = useState('business');
  const [chosen, setChosen] = useState('');
  const [q, query] = useState('');
  const copy = useCopy();
  const list = reference.filter(
    (x) =>
      x.area === group && (x.path + ' ' + x.id + ' ' + x.summary).toLowerCase().includes(q.toLowerCase()),
  );
  const item = list.find((x) => x.id === chosen) || list[0];
  const op = item?.path.split('/').at(-1) as Op;
  const example = apiExample(op, lang);
  function title(x: (typeof reference)[number]) {
    if (x.area === 'business') return l(opLabels[x.path.split('/').at(-1) as Op]);
    if (lang === 'zh') return x.summary;
    return x.id.replace(/([a-z])([A-Z])/g, '$1 $2');
  }
  return (
    <>
      <PageHead
        title={t('API 文档', 'API reference')}
        sub={t(
          '查看请求字段、身份要求和响应状态。',
          'Inspect request fields, authentication and response statuses.',
        )}
      >
        <a
          className="ui-btn neutral"
          href={'./contracts/' + (group === 'business' ? 'business' : 'management') + '.openapi.yaml'}
          download
        >
          OpenAPI 3.1 ↓
        </a>
      </PageHead>
      <div className="toolbar">
        <Segments
          label={t('契约分区', 'API group')}
          value={group}
          change={(v) => {
            setGroup(v);
            setChosen('');
            query('');
          }}
          items={[
            { id: 'business', label: t('业务 API', 'Business API') },
            { id: 'management', label: t('管理 API', 'Management API') },
            { id: 'health', label: t('健康探针', 'Health probes') },
          ]}
        />
        <SearchBox value={q} change={query} placeholder={t('搜索接口', 'Find operation')} />
      </div>
      {item ? (
        <div className="reference-layout">
          <Panel className="ref-nav">
            {list.map((x) => (
              <button
                key={x.id}
                className={item.id === x.id ? 'selected' : ''}
                onClick={() => setChosen(x.id)}
              >
                <strong>{title(x)}</strong>
                <code>
                  {x.method} {x.path}
                </code>
              </button>
            ))}
          </Panel>
          <Panel className="ref-body">
            <div className="trace-ident">
              <span className="route-tag">{item.method}</span>
              <code>{item.path}</code>
            </div>
            <h2>{title(item)}</h2>
            <p className="ref-auth">
              {t('认证', 'Authentication')} ·{' '}
              {item.auth
                .map((a) =>
                  a === 'AdminSession'
                    ? t('管理员会话', 'Admin session')
                    : a === 'ProjectKey'
                      ? t('项目密钥', 'Project key')
                      : a === 'Csrf'
                        ? t('请求防伪令牌', 'CSRF token')
                        : a,
                )
                .join(' + ') || t('公开', 'Public')}
            </p>
            <dl className="field-map">
              {item.fields.map((f) => (
                <div key={f.location + f.name}>
                  <dt>
                    {fieldLabels[f.name] ? (
                      <>
                        {l(fieldLabels[f.name])} <code>{f.name}</code>
                      </>
                    ) : (
                      f.name
                    )}
                  </dt>
                  <dd>
                    {f.type} · {f.location} · {f.required ? t('必填', 'required') : t('可选', 'optional')}
                  </dd>
                </div>
              ))}
            </dl>
            <div className="ref-statuses">
              <b>{t('响应', 'Responses')}</b>
              {item.statuses.map((n) => (
                <code key={n}>{n}</code>
              ))}
            </div>
            {item.area === 'business' && (
              <>
                <Caption title={t('请求示例', 'Example request')}>
                  <IconBtn
                    icon={Clipboard}
                    label={t('复制请求示例', 'Copy example request')}
                    onPress={() => void copy(JSON.stringify(example, null, 2))}
                  />
                </Caption>
                <RequestFacts op={op} input={example} defaults={{ useProjectDefaults: true }} />
                <Btn primary onPress={() => go('playground', op, 'sample=api')}>
                  <FlaskConical size={15} />
                  {t('在调试台运行', 'Open in playground')}
                </Btn>
              </>
            )}
          </Panel>
        </div>
      ) : (
        <Empty text={t('没有匹配接口', 'No matching operations')} />
      )}
    </>
  );
}
