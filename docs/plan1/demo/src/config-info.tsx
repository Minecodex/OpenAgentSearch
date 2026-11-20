import { providerNames } from './endpoint-providers';
import type { ReactNode } from 'react';
import { Pencil, Clipboard, ArrowUpRight, KeyRound } from 'lucide-react';
import { useConsole } from './state';
import { Btn, DialogFrame, Empty, IconBtn, useCopy } from './ui';
import { KeyValues } from './diagnostic-ui';
import { installed, isBrowser, usesEndpoint, wireId } from './configuration';
import {
  adapterNames,
  rangeNames,
  languageName,
  amount,
  charUnit,
  resultUnit,
  pageUnit,
  testReason,
} from './display-values';
import { kinds, type Endpoint, type Project, type Local } from './model';

export function FactSection({
  title,
  items,
  children,
}: {
  title: string;
  items?: [string, ReactNode][];
  children?: ReactNode;
}) {
  return (
    <section className="read-section">
      <h3>{title}</h3>
      {items && <KeyValues items={items} />} {children}
    </section>
  );
}
function ProjectFacts({ project: p }: { project: Project }) {
  const { cfg, t, l, lang, open } = useConsole();
  const empty = t('未配置', 'Not configured');
  const epName = (id: string) => {
    const e = cfg.endpoints.find((e) => e.id === id);
    return e ? l(e.name) : t('接入点已移除', 'Removed endpoint');
  };
  const pool = cfg.pools.find((v) => v.id === p.pool);
  function group(title: string, groups: string[][]) {
    return (
      <FactSection title={title}>
        {groups.length ? (
          <ol className="readonly-pools">
            {groups.map((members, i) => (
              <li key={i}>
                <b>
                  {t('优先级', 'Priority')} {i + 1}
                </b>
                <span>
                  {members.map((id) => (
                    <span key={id} className="member-chip">
                      {epName(id)}
                      {!installed(cfg, id) && ' · ' + t('不可用', 'Unavailable')}
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p>{empty}</p>
        )}
      </FactSection>
    );
  }
  return (
    <>
      <FactSection
        title={t('项目设置', 'Project settings')}
        items={[
          [t('默认业务语言', 'Default content language'), languageName(p.language, lang)],
          [
            t('允许的业务语言', 'Allowed content languages'),
            p.languages.map((v) => languageName(v, lang)).join(' / '),
          ],
          [t('生成模型', 'Generation model'), p.model ? epName(p.model) : empty],
          [
            t('浏览器代理池', 'Browser proxy pool'),
            pool ? (
              <button className="text-link" onClick={() => open('pool-info', pool.id)}>
                {l(pool.name)} <ArrowUpRight size={12} />
              </button>
            ) : p.pool ? (
              t('代理池已移除', 'Removed pool')
            ) : (
              empty
            ),
          ],
        ]}
      />
      {group(t('搜索接入点池', 'Search endpoint pools'), p.searchPools)}
      {group(t('正文接入点池', 'Reader endpoint pools'), p.readerPools)}
      <FactSection
        title={t('限制与总结策略', 'Limits and synthesis')}
        items={[
          [t('最大搜索数量', 'Search limit'), amount(p.searchLimit, resultUnit, lang)],
          [t('总结来源上限', 'Source limit'), amount(p.sourceLimit, pageUnit, lang)],
          [t('每页正文上限', 'Article character limit'), amount(p.bodyLimit, charUnit, lang)],
          [t('整体总结上限', 'Summary character limit'), amount(p.summaryLimit, charUnit, lang)],
          [
            t('额外改写', 'Additional queries'),
            p.rewriteCount
              ? amount(p.rewriteCount, [' 条', 'queries'], lang)
              : t('关闭，仅检索原问题', 'Off · original query only'),
          ],
          [
            t('正文获取失败时', 'On article retrieval failure'),
            p.allowSnippets
              ? t('允许采用搜索简介', 'Allow search snippets')
              : t('跳过该来源', 'Skip this source'),
          ],
        ]}
      />
    </>
  );
}
function EndpointFacts({ endpoint: e }: { endpoint: Endpoint }) {
  const { cfg, t, l, lang, go, open } = useConsole(),
    o = e.options;
  const details: [string, ReactNode][] = [];
  if (e.kind === 'search') {
    if (o.engine) details.push([t('搜索引擎', 'Search engine'), o.engine]);
    if (e.provider === 'searxng')
      details.push([
        t('启用引擎', 'Enabled engines'),
        o.engines?.length ? o.engines.join('、') : t('服务默认', 'Service default'),
      ]);
    details.push(
      [
        t('支持的业务语言', 'Supported languages'),
        (o.languages ?? ['zh', 'en']).map((v) => languageName(v, lang)).join(' / '),
      ],
      [
        t('支持的检索时间', 'Supported search windows'),
        [
          t('不限', 'Any time'),
          ...(o.time_ranges ?? ['day', 'month', 'year']).map((v) => l(rangeNames[v])),
        ].join(' / '),
      ],
    );
  } else if (e.kind === 'reader')
    details.push([
      t('正文格式', 'Article format'),
      isBrowser(e.adapter)
        ? t('从渲染网页提取', 'Extracted from the rendered page')
        : o.format === 'html'
          ? 'HTML'
          : 'Markdown',
    ]);
  else
    details.push(
      [t('模型标识', 'Model ID'), o.model ?? '—'],
      [t('分词器', 'Tokenizer'), o.tokenizer ?? '—'],
      [
        t('最大输入', 'Maximum input'),
        o.max_input_tokens === undefined
          ? t('未配置', 'Not configured')
          : amount(o.max_input_tokens, [' Token', 'tokens'], lang),
      ],
      [
        t('最大输出', 'Maximum output'),
        o.max_output_tokens === undefined
          ? t('未配置', 'Not configured')
          : amount(o.max_output_tokens, [' Token', 'tokens'], lang),
      ],
    );
  const refs = cfg.projects.filter((p) => usesEndpoint(p, e.id)),
    routes = Object.entries(cfg.routes)
      .filter(([, ids]) => ids.includes(e.id))
      .map(([code]) => code);
  const last = e.lastTest?.version === e.version ? e.lastTest : undefined;
  return (
    <>
      <FactSection
        title={t('能力与连接', 'Capability and connection')}
        items={[
          [t('用途', 'Capability'), l(kinds[e.kind])],
          [t('服务商', 'Provider'), e.provider ? l(providerNames[e.provider]) : t('待选择', 'Not set')],
          [t('接入方式', 'Connection type'), l(adapterNames[e.adapter])],
          [
            t('服务地址', 'Service address'),
            isBrowser(e.adapter) ? t('集群浏览器执行器', 'Cluster browser worker') : e.address,
          ],
          [
            t('可用状态', 'Availability'),
            installed(cfg, e.id)
              ? t('可用', 'Available')
              : e.provider
                ? t('组件未安装', 'Component not installed')
                : t('待选择服务商', 'Provider not set'),
          ],
          [
            t('上游凭据', 'Upstream credentials'),
            isBrowser(e.adapter)
              ? t('无需凭据', 'Not required')
              : e.hasSecret
                ? t('已配置', 'Configured')
                : t('未配置', 'Not configured'),
          ],
        ]}
      />
      <FactSection title={t('接入选项', 'Adapter settings')} items={details} />
      <FactSection
        title={t('运行限制', 'Runtime limits')}
        items={[
          [t('单次超时', 'Timeout'), amount(e.timeoutMs / 1000, [' 秒', 'seconds'], lang)],
          [t('最大并发', 'Concurrency'), amount(e.limit, [' 个请求', 'requests'], lang)],
          [t('每分钟请求上限', 'Requests per minute'), amount(e.rpm, [' 次/分钟', 'requests/min'], lang)],
        ]}
      />
      <FactSection
        title={t('当前版本的功能测试', 'Current version test')}
        items={
          last
            ? [
                [
                  t('测试结果', 'Outcome'),
                  last.status === 'success' ? t('通过', 'Passed') : testReason(last.reason, lang),
                ],
                [t('测试时间', 'Tested at'), new Date(last.at).toLocaleString(lang)],
                [t('耗时', 'Duration'), last.elapsed + ' ms'],
              ]
            : [[t('测试状态', 'Status'), t('尚未测试', 'Untested')]]
        }
      >
        {last?.requestId && (
          <button
            className="text-link"
            onClick={() =>
              go(
                'requests',
                last.requestId,
                new URLSearchParams({
                  back: 'endpoints',
                  returnQuery: new URLSearchParams({ kind: e.kind }).toString(),
                }).toString(),
              )
            }
          >
            {t('查看测试记录', 'View test record')} ↗
          </button>
        )}
      </FactSection>
      <FactSection
        title={t('使用位置', 'Used by')}
        items={[
          [
            t('项目', 'Projects'),
            refs.length ? (
              <span className="reference-links">
                {refs.map((p) => (
                  <button className="text-link" key={p.id} onClick={() => open('project-info', p.id)}>
                    {l(p.name)}
                  </button>
                ))}
              </span>
            ) : (
              t('暂无项目', 'No projects')
            ),
          ],
          [
            t('优先语言', 'Preferred languages'),
            routes.length ? (
              <span className="reference-links">
                {routes.map((code) => (
                  <button
                    key={code}
                    className="text-link"
                    onClick={() => go('languages', '', new URLSearchParams({ language: code }).toString())}
                  >
                    {languageName(code, lang)}
                  </button>
                ))}
              </span>
            ) : (
              t('未设置', 'None')
            ),
          ],
        ]}
      />
      <button
        className="text-link"
        onClick={() => go('observability', '', new URLSearchParams({ kind: e.kind, ep: e.id }).toString())}
      >
        {t('查看此接入点的运行观测', 'Inspect this endpoint’s activity')} ↗
      </button>
    </>
  );
}
export function ConfigInfo({ id, kind }: { id: string; kind: 'project' | 'endpoint' | 'pool' | 'proxy' }) {
  const { cfg, t, l, lang, open, close, go } = useConsole(),
    copy = useCopy();
  const p = cfg.projects.find((p) => p.id === id),
    e = cfg.endpoints.find((e) => e.id === id),
    pool = cfg.pools.find((x) => x.id === id),
    node = cfg.proxies.find((x) => x.id === id);
  const item = kind === 'project' ? p : kind === 'endpoint' ? e : kind === 'pool' ? pool : node;
  const memberPools =
    kind === 'proxy' ? cfg.pools.filter((group) => group.members.some((m) => m.id === id)) : [];
  if (!item)
    return (
      <DialogFrame title={t('资源详情', 'Resource details')}>
        <Empty text={t('该资源已移除', 'Resource removed')} />
      </DialogFrame>
    );
  const titles: Record<typeof kind, Local> = {
    project: ['项目详情', 'Project details'],
    endpoint: ['接入点详情', 'Endpoint details'],
    pool: ['代理池详情', 'Proxy pool details'],
    proxy: ['代理详情', 'Proxy details'],
  };
  return (
    <DialogFrame
      title={l(titles[kind])}
      wide
      footer={
        <div className="form-actions info-actions">
          {kind === 'project' && p && (
            <Btn small className="rotate-project-key" onPress={() => open('rotate', p.id, String(p.version))}>
              <KeyRound size={14} />
              {t('轮换项目密钥', 'Rotate project key')}
            </Btn>
          )}
          <Btn onPress={close}>{t('关闭', 'Close')}</Btn>
          <Btn onPress={() => open(kind, id)} primary>
            <Pencil size={14} />
            {t('编辑配置', 'Edit configuration')}
          </Btn>
        </div>
      }
    >
      <div className="read-details" data-testid="config-details">
        <header>
          <h3>{l(item.name)}</h3>
          {item.version !== undefined && <span className="code-chip">v{item.version}</span>}
        </header>
        {kind === 'project' && p && <ProjectFacts project={p} />}
        {kind === 'endpoint' && e && <EndpointFacts endpoint={e} />}
        {kind === 'proxy' && node && (
          <FactSection
            title={t('连接与调度', 'Connection and scheduling')}
            items={[
              [t('协议', 'Protocol'), node.scheme.toUpperCase()],
              [t('主机与端口', 'Host and port'), node.host + ' · ' + node.port],
              [
                t('认证', 'Authentication'),
                node.auth
                  ? t('已配置用户名和密码', 'Username and password configured')
                  : t('无需认证', 'No authentication'),
              ],
              [t('最大并发', 'Concurrency'), String(node.limit)],
              [t('状态', 'Status'), node.enabled ? t('已启用', 'Enabled') : t('已停用', 'Disabled')],
              [
                t('最近测试', 'Last test'),
                node.lastTest?.requestId ? (
                  <button
                    className="text-link"
                    onClick={() => go('requests', node.lastTest!.requestId, 'back=proxies')}
                  >
                    {node.lastTest.status === 'success'
                      ? t('通过', 'Passed')
                      : testReason(node.lastTest.reason, lang)}{' '}
                    · {node.lastTest.elapsed} ms ↗
                  </button>
                ) : node.tested ? (
                  new Date(node.tested).toLocaleString(lang)
                ) : (
                  t('尚未测试', 'Untested')
                ),
              ],
              [
                t('所属代理池', 'Proxy pools'),
                  memberPools.length ? (
                    <span className="reference-links">
                      {memberPools.map((group) => (
                        <button key={group.id} className="text-link" onClick={() => open('pool-info', group.id)}>
                          {l(group.name)}
                        </button>
                      ))}
                    </span>
                  ) : (
                    t('尚未分组', 'Unassigned')
                  ),
              ],
            ]}
          />
        )}
        {kind === 'pool' && pool && (
          <>
            <FactSection title={t('代理成员', 'Proxy members')}>
              {pool.members.length ? (
                <ol className="readonly-pools">
                  {pool.members.map((m) => {
                    const n = cfg.proxies.find((v) => v.id === m.id);
                    return (
                      <li key={m.id}>
                        <b>
                          {t('权重', 'Weight')} {m.weight}
                        </b>
                        {n ? (
                          <button className="text-link" onClick={() => open('proxy-info', n.id)}>
                            {l(n.name)} · {n.scheme.toUpperCase()} ·{' '}
                            {n.enabled ? t('已启用', 'Enabled') : t('已停用', 'Disabled')}
                          </button>
                        ) : (
                          t('已移除', 'Removed')
                        )}
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <p>{t('尚无成员', 'No members')}</p>
              )}
            </FactSection>
            <FactSection title={t('绑定项目', 'Bound projects')}>
              <div className="reference-links">
                {cfg.projects
                  .filter((x) => x.pool === pool.id)
                  .map((x) => (
                    <button key={x.id} className="text-link" onClick={() => open('project-info', x.id)}>
                      {l(x.name)}
                    </button>
                  ))}
                {!cfg.projects.some((x) => x.pool === pool.id) && t('暂无项目', 'No projects')}
              </div>
            </FactSection>
          </>
        )}
        <div className="resource-identity">
          <span>{t('资源 ID', 'Resource ID')}</span>
          <code>{wireId(id)}</code>
          <IconBtn
            icon={Clipboard}
            label={t('复制资源 ID', 'Copy resource ID')}
            onPress={() => void copy(wireId(id))}
          />
        </div>
      </div>
    </DialogFrame>
  );
}
