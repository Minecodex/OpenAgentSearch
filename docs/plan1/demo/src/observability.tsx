import { useMemo, useState } from 'react';
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  ChartNoAxesCombined,
  CheckCheck,
  Clock3,
  List,
  RefreshCw,
  ScanLine,
} from 'lucide-react';
import { useConsole } from './state';
import { Kind, digits, kinds } from './model';
import {
  Attempt,
  attempts,
  endpointName,
  evaluationNames,
  originNames,
  reasonNames,
} from './diagnostic-data';
import {
  Metric,
  effectiveGrain,
  fmt,
  frameBounds,
  getWindow,
  latency,
  percentage,
  percentile,
  quality,
  qualityName,
  rollup,
  stamp,
  zones,
} from './investigation';
import { Btn, Caption, Choice, Empty, PageHead, Panel, SearchBox, Segments, StateChip } from './ui';
import { Changes, Facet, NumberStrip, Pagination, WindowPicker, pageNumber } from './diagnostic-ui';
import { InsightChart, seriesColor } from './insight-chart';
import { CallSheet } from './call-sheet';

const callSize = 12;
export function Observability() {
  const { t, l, lang, cfg, logs, go, query, updateQuery, notify } = useConsole();
  const params = useMemo(() => new URLSearchParams(query), [query]);
  const [now, setNow] = useState(() => Date.now());
  const kind = (
    ['search', 'reader', 'model'].includes(params.get('kind') || '') ? params.get('kind') : 'search'
  ) as Kind;
  const tab = params.get('view') === 'calls' ? 'calls' : 'overview',
    proj = params.get('project') || '',
    ep = params.get('ep') || '',
    origin = params.has('origin') ? params.get('origin')! : 'business',
    language = params.get('language') || '';
  const zone = zones.includes(params.get('zone') || '') ? params.get('zone')! : zones[0];
  const win = getWindow(params, now);
  const grain = effectiveGrain(
    win,
    params.get('grain') || (win.end - win.start > 2 * 86400000 ? 'day' : 'hour'),
  );
  const metric = (
    ['latency', 'quality'].includes(params.get('metric') || '') ? params.get('metric') : 'volume'
  ) as Metric;
  const frames = useMemo(() => frameBounds(win, grain, zone), [win.start, win.end, grain, zone]);
  const shared = useMemo(() => {
    const out: Attempt[] = [];
    for (const r of logs) {
      if (r.time + r.duration < win.start || r.time >= win.end || (proj && r.project !== proj)) continue;
      for (const c of attempts(r))
        if (
          c.kind === kind &&
          (!ep || c.endpoint === ep) &&
          (origin === 'all' || c.origin === origin) &&
          (!language || c.language === language) &&
          c.time >= win.start &&
          c.time < win.end
        )
          out.push(c);
    }
    return out.sort((a, b) => b.time - a.time || b.id.localeCompare(a.id));
  }, [logs, win.start, win.end, proj, kind, ep, origin, language]);
  const facts = useMemo(() => rollup(shared, frames), [shared, frames]),
    { all } = facts;
  const peers = useMemo(() => [...facts.peers].sort((a, b) => b[1].n - a[1].n), [facts]);
  const ids = useMemo(() => peers.map(([id]) => id), [peers]);
  const states = params.get('state') || '',
    evaluation = params.get('evaluation') || '',
    reason = params.get('reason') || '',
    kw = params.get('kw') || '';
  const filtered = useMemo(
    () =>
      shared.filter(
        (c) =>
          (!states || c.status === states) &&
          (!evaluation || c.evaluation === evaluation) &&
          (!reason || c.reason === reason) &&
          (!kw || (c.id + ' ' + c.target + ' ' + c.requestId).toLowerCase().includes(kw.toLowerCase())),
      ),
    [shared, states, evaluation, reason, kw],
  );
  const pg = pageNumber(params.get('pg'), filtered.length, callSize);
  const selected = shared.find((c) => c.id === params.get('call'));
  const linked = selected ? logs.find((r) => r.id === selected.requestId) : null;
  const resetSpecific = { pg: null, call: null, state: null, evaluation: null, reason: null, kw: null };
  const set = (values: Changes) => updateQuery({ pg: null, call: null, ...values });
  const drill = (values: Changes) => {
    updateQuery({ ...resetSpecific, anchor: String(win.end), view: 'calls', ...values });
  };
  const allOpt = (zh: string, en: string) => ({ value: '', label: t(zh, en) });
  const destinations = cfg.endpoints.filter(
    (e) => e.kind === kind && (!e.addon || cfg.addons[e.addon] || ep === e.id),
  );
  const facet = (
    <>
      <Facet
        name={t('项目', 'Project')}
        value={proj}
        set={(v) => set({ project: v })}
        options={[
          allOpt('全部项目', 'All projects'),
          ...cfg.projects.map((p) => ({ value: p.id, label: l(p.name) })),
        ]}
      />
      <Facet
        name={t('接入点', 'Endpoint')}
        value={ep}
        set={(v) => set({ ep: v })}
        test="obs-endpoint"
        options={[
          allOpt('全部接入点', 'All endpoints'),
          ...destinations.map((e) => ({ value: e.id, label: l(e.name) })),
        ]}
      />
      <Facet
        name={t('流量来源', 'Traffic origin')}
        value={origin}
        set={(v) => set({ origin: v })}
        options={[
          { value: 'all', label: t('全部来源', 'All origins') },
          ...(['business', 'debug', 'endpoint_test'] as const).map((k) => ({
            value: k,
            label: l(originNames[k]),
          })),
        ]}
      />
      <Facet
        name={t('业务语言', 'Language')}
        value={language}
        set={(v) => set({ language: v })}
        options={[
          allOpt('全部语言', 'All languages'),
          { value: 'zh', label: '中文' },
          { value: 'en', label: 'English' },
        ]}
      />
      <Facet
        name={t('显示时区', 'Time zone')}
        value={zone}
        set={(v) => set({ zone: v })}
        options={zones.map((value) => ({ value, label: value }))}
      />
    </>
  );
  function clear() {
    const keep = tab;
    go('observability', '', keep === 'calls' ? 'view=calls' : '');
  }
  const metricName = qualityName(kind, lang);
  const numbers = [
    {
      label: t('调用次数', 'Calls'),
      value: digits(all.n),
      note: peers.length + ' ' + t('个有调用的接入点', 'active endpoints'),
      icon: Activity,
    },
    {
      label: t('调用成功率', 'Call success'),
      value: all.n ? percentage(all.ok + all.empty, all.n)!.toFixed(1) : '—',
      unit: all.n ? '%' : '',
      note: all.failed + ' ' + t('次失败', 'failures') + ' · ' + all.empty + ' ' + t('次空结果', 'empty'),
      icon: CheckCheck,
    },
    {
      label: t('平均执行耗时', 'Mean execution'),
      value: fmt(latency(all)),
      unit: all.speeds.length ? 'ms' : '',
      note: 'P95 · ' + fmt(percentile(all), ' ms'),
      icon: Clock3,
    },
    {
      label: kind === 'model' ? t('平均排队', 'Mean queue') : metricName,
      value:
        kind === 'model'
          ? fmt(all.n ? all.queue / all.n : null)
          : quality(all) === null
            ? '—'
            : quality(all)!.toFixed(1),
      unit: kind === 'model' && all.n ? 'ms' : all.denominator ? '%' : '',
      note: digits(kind === 'model' ? all.n : all.samples) + ' ' + t('条有效样本', 'qualified samples'),
      icon: ScanLine,
      accent: true,
    },
  ];
  function closeSheet() {
    const id = selected?.id;
    updateQuery({ call: null });
    requestAnimationFrame(() => {
      if (id) document.getElementById('call-' + id)?.focus();
    });
  }
  return (
    <>
      <PageHead
        title={t('运行观测', 'Observability')}
        sub={
          t('按接入点调用完成时间统计', 'Endpoint traffic by completion time') +
          ' · ' +
          stamp(win.start, zone) +
          ' — ' +
          stamp(win.end, zone)
        }
      >
        <Btn
          small
          onPress={() => {
            setNow(Date.now());
            updateQuery({ anchor: null });
            notify(t('已刷新当前窗口', 'Window refreshed'));
          }}
        >
          <RefreshCw size={14} />
          {t('刷新', 'Refresh')}
        </Btn>
        <WindowPicker
          params={params}
          window={win}
          zone={zone}
          hours={[24, 168, 720]}
          apply={(changes) => set({ anchor: null, ...changes })}
        />
      </PageHead>
      <div className="obs-board">
        <div className="obs-board-main">
          <div className="diag-mode-row">
            <Segments
              label={t('观测视图', 'Observation view')}
              value={tab}
              change={(v) => set({ view: v })}
              items={[
                { id: 'overview', label: t('统计概览', 'Overview'), icon: ChartNoAxesCombined },
                { id: 'calls', label: t('调用明细', 'Call details'), icon: List },
              ]}
            />
            <Segments
              label={t('接入类型', 'Endpoint capability')}
              value={kind}
              change={(v) =>
                updateQuery({
                  ...resetSpecific,
                  kind: v,
                  ep: null,
                  metric: v === 'model' && metric === 'quality' ? 'volume' : metric,
                })
              }
              items={(Object.keys(kinds) as Kind[]).map((id) => ({ id, label: l(kinds[id]) }))}
            />
          </div>
          <div className="diag-filter-box">
            <div className="diag-filter-line">
              {facet}
              <button className="text-link" onClick={clear}>
                {t('重置', 'Reset')}
              </button>
            </div>
          </div>
          {tab === 'overview' ? (
            <>
              <NumberStrip items={numbers} />
              <div className="insight-visuals">
                <Panel className="trend-box">
                  <Caption title={t('调用趋势', 'Call trend')}>
                    <Choice
                      label={t('时间粒度', 'Bucket size')}
                      value={grain}
                      onChange={(v) => set({ grain: v })}
                      options={(['hour', 'day', 'week', 'month'] as const).map((v, i) => ({
                        value: v,
                        label: [
                          t('按小时', 'Hourly'),
                          t('按天', 'Daily'),
                          t('按周', 'Weekly'),
                          t('按月', 'Monthly'),
                        ][i],
                        disabled: v === 'hour' && effectiveGrain(win, 'hour') !== 'hour',
                      }))}
                    />
                  </Caption>
                  <div className="plot-switch">
                    <Segments
                      label={t('趋势指标', 'Trend metric')}
                      value={metric}
                      change={(v) => set({ metric: v })}
                      items={[
                        { id: 'volume', label: t('调用量', 'Volume') },
                        { id: 'latency', label: t('执行耗时', 'Latency') },
                        ...(kind === 'model' ? [] : [{ id: 'quality', label: t('质量', 'Quality') }]),
                      ]}
                    />
                  </div>
                  {all.n ? (
                    <InsightChart
                      series={facts.series}
                      ids={ids}
                      metric={metric}
                      zone={zone}
                      drill={(w) => drill({ from: String(w.start), to: String(w.end), hours: null })}
                    />
                  ) : (
                    <Empty text={t('此窗口内没有调用样本', 'No calls in this window')} />
                  )}
                </Panel>
                <Panel className="quality-box">
                  <Caption
                    title={
                      kind === 'model'
                        ? t('接入点负载', 'Endpoint load')
                        : t('接入点质量对比', 'Quality by endpoint')
                    }
                  />
                  <p className="panel-help">
                    {kind === 'search'
                      ? t('相关候选 / 已完整评分的候选', 'Relevant candidates / fully evaluated candidates')
                      : kind === 'reader'
                        ? t(
                            '获取有效正文 / 有确定结果的尝试',
                            'Retrieved articles / attempts with a known outcome',
                          )
                        : t('各模型接入点的调用占比', 'Share of calls per model endpoint')}
                  </p>
                  {peers.map(([id, a]) => {
                    const v = kind === 'model' ? percentage(a.n, all.n) : quality(a);
                    return (
                      <button key={id} className="quality-meter" onClick={() => drill({ ep: id })}>
                        <span>
                          <b>{endpointName(id, cfg, lang)}</b>
                          <strong>{fmt(v, '%')}</strong>
                        </span>
                        <i>
                          <em style={{ width: (v ?? 0) + '%', background: seriesColor(id) }} />
                        </i>
                        <small>
                          {digits(kind === 'model' ? a.n : a.samples)}{' '}
                          {kind === 'model' ? t('次调用', 'calls') : t('条有效样本', 'qualified samples')}
                          <ArrowUpRight size={12} />
                        </small>
                      </button>
                    );
                  })}
                  {!peers.length && <Empty text={t('暂无可比较的端点', 'No endpoints to compare')} />}
                </Panel>
              </div>
              <Panel className="performance">
                <Caption title={t('接入点表现', 'Endpoint performance')}>
                  <button className="text-link" onClick={() => drill({})}>
                    {t('全部调用', 'All calls')}
                    <ArrowRight size={14} />
                  </button>
                </Caption>
                <div className="table-scroll">
                  <table className="data-table">
                    <thead>
                      <tr>
                        {[
                          t('接入点', 'Endpoint'),
                          t('调用次数', 'Calls'),
                          t('成功率', 'Success'),
                          t('平均执行 / P95', 'Average / P95'),
                          kind === 'model'
                            ? t('排队 / 样本', 'Queue / samples')
                            : t('质量 / 样本', 'Quality / samples'),
                          t('最近调用', 'Last call'),
                          t('操作', 'Action'),
                        ].map((v) => (
                          <th key={v}>{v}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {peers.map(([id, a]) => (
                        <tr key={id}>
                          <td>
                            <span className="endpoint-id">
                              <i style={{ background: seriesColor(id) }} />
                              {endpointName(id, cfg, lang)}
                            </span>
                          </td>
                          <td>{digits(a.n)}</td>
                          <td>{fmt(percentage(a.ok + a.empty, a.n), '%')}</td>
                          <td>
                            {fmt(latency(a), ' ms')}
                            <small className="row-sub">{fmt(percentile(a), ' ms')}</small>
                          </td>
                          <td>
                            {kind === 'model' ? fmt(a.n ? a.queue / a.n : null, ' ms') : fmt(quality(a), '%')}
                            <small className="row-sub">{digits(kind === 'model' ? a.n : a.samples)}</small>
                          </td>
                          <td className="mono">{stamp(a.latest, zone, true)}</td>
                          <td>
                            <button
                              className="text-link"
                              data-testid="peer-drill"
                              onClick={() => drill({ ep: id })}
                            >
                              {t('明细', 'Inspect')}
                              <ArrowUpRight size={13} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!peers.length && <Empty text={t('没有匹配的表现记录', 'No matching performance records')} />}
              </Panel>
            </>
          ) : (
            <Panel className="calls-panel">
              <Caption title={t('上游调用明细', 'Upstream calls')}>
                <span className="count-label">{digits(filtered.length)}</span>
              </Caption>
              <div className="call-filters">
                <SearchBox
                  placeholder={t('搜索问题、URL 或调用 ID', 'Query, URL or call ID')}
                  value={kw}
                  change={(v) => set({ kw: v })}
                />
                <Choice
                  label={t('调用状态', 'Call status')}
                  value={states}
                  onChange={(v) => set({ state: v })}
                  options={[
                    allOpt('全部状态', 'All outcomes'),
                    ...['success', 'empty', 'error', 'cancelled'].map((v, i) => ({
                      value: v,
                      label: [
                        t('成功', 'Success'),
                        t('空结果', 'Empty'),
                        t('失败', 'Error'),
                        t('取消', 'Cancelled'),
                      ][i],
                    })),
                  ]}
                />
                <Choice
                  label={t('调度原因', 'Routing reason')}
                  value={reason}
                  onChange={(v) => set({ reason: v })}
                  options={[
                    allOpt('全部调度原因', 'All routing reasons'),
                    ...Object.entries(reasonNames).map(([value, n]) => ({
                      value,
                      label: l([...n] as [string, string]),
                    })),
                  ]}
                />
                <Choice
                  label={t('评价状态', 'Evaluation state')}
                  value={evaluation}
                  onChange={(v) => set({ evaluation: v })}
                  options={[
                    allOpt('全部评价', 'All evaluations'),
                    ...Object.entries(evaluationNames)
                      .filter(([k]) =>
                        kind === 'search'
                          ? ['complete', 'incomplete', 'no_candidates', 'unscored'].includes(k)
                          : kind === 'reader'
                            ? ['received', 'missing'].includes(k)
                            : k === 'model',
                      )
                      .map(([value, n]) => ({ value, label: l([...n] as [string, string]) })),
                  ]}
                />
              </div>
              <div className="table-scroll">
                <table className="data-table calls-table">
                  <thead>
                    <tr>
                      {[
                        t('输入 / 调用 ID', 'Input / call ID'),
                        t('接入点 / 项目', 'Endpoint / project'),
                        t('状态', 'Outcome'),
                        t('执行 / 排队', 'Execution / queue'),
                        t('评价', 'Evaluation'),
                        t('完成时间', 'Completed'),
                      ].map((x) => (
                        <th key={x}>{x}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.slice(pg * callSize, (pg + 1) * callSize).map((c) => (
                      <tr key={c.id}>
                        <td>
                          <button
                            id={'call-' + c.id}
                            className="row-link cut"
                            onClick={() => set({ call: c.id, pg: String(pg), anchor: String(win.end) })}
                          >
                            {c.target}
                          </button>
                          <small className="row-sub mono">{c.id}</small>
                        </td>
                        <td>
                          {endpointName(c.endpoint, cfg, lang)}
                          <small className="row-sub">
                            {l(cfg.projects.find((p) => p.id === c.project)?.name || c.project)}
                          </small>
                        </td>
                        <td>
                          <StateChip value={c.status} />
                        </td>
                        <td>
                          {c.duration} ms<small className="row-sub">{c.queue} ms</small>
                        </td>
                        <td>
                          {localEval(c)}
                          <small className="row-sub">{l(reasonNames[c.reason] as [string, string])}</small>
                        </td>
                        <td className="mono">{stamp(c.time, zone)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!filtered.length && <Empty text={t('当前筛选没有调用', 'No calls match these filters')} />}
              <Pagination
                total={filtered.length}
                page={pg}
                size={callSize}
                change={(n) => set({ pg: String(n) })}
              />
            </Panel>
          )}
        </div>
      </div>
      {selected && linked && (
        <CallSheet
          call={selected}
          request={linked}
          zone={zone}
          close={closeSheet}
          trace={() =>
            go(
              'requests',
              linked.id,

              new URLSearchParams({ back: 'observability', returnQuery: query }).toString(),
            )
          }
        />
      )}
    </>
  );
  function localEval(c: Attempt) {
    return l(evaluationNames[c.evaluation] as [string, string]);
  }
}
