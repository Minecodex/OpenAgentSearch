import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowRight,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Clock3,
  RefreshCw,
  Waypoints,
} from 'lucide-react';
import { useConsole } from './state';
import { Log, digits, opLabels, ops, statusLabels } from './model';
import {
  attempts,
  endpointName,
  originNames,
  originOf,
  previewOf,
  projectLabel,
  queryText,
  recordingComplete,
} from './diagnostic-data';
import { fmt, getWindow, stamp, zones } from './investigation';
import { Changes, Facet, NumberStrip, Pagination, WindowPicker, pageNumber } from './diagnostic-ui';
import { Btn, Caption, Empty, PageHead, Panel, SearchBox, Segments, StateChip } from './ui';
import { RequestDetail } from './trace-detail';
const size = 10;
export function Records() {
  const { id } = useConsole();
  return id ? <RequestDetail key={id} /> : <RecordList />;
}
function RecordList() {
  const { t, l, lang, go, logs, cfg, query, updateQuery, notify } = useConsole();
  const params = useMemo(() => new URLSearchParams(query), [query]);
  const [now, setNow] = useState(() => Date.now());
  const [expanded, setExpanded] = useState('');
  const window = getWindow(params, now),
    zone = zones[0];
  const origin = params.get('origin') || '',
    op = params.get('op') || '',
    project = params.get('project') || '',
    state = params.get('status') || '',
    key = params.get('q') || '';
  const [draft, setDraft] = useState(key);
  useEffect(() => {
    setDraft(key);
  }, [key]);
  const density = params.get('density') === 'compact' ? 'compact' : 'preview';
  const set = (changes: Changes) => {
    setExpanded('');
    updateQuery({ pg: null, ...changes });
  };
  const base = useMemo(
    () =>
      logs.filter(
        (r) =>
          r.time >= window.start &&
          r.time < window.end &&
          (!project || r.project === project) &&
          (!op || (!originOf(r).endsWith('_test') && r.op === op)) &&
          (!origin || originOf(r) === origin) &&
          (!key ||
            (queryText(r) + ' ' + r.id + ' ' + l(r.query)).toLowerCase().includes(key.trim().toLowerCase())),
      ),
    [logs, window.start, window.end, project, op, origin, key, lang],
  );
  const rows = useMemo(
    () =>
      state
        ? base.filter((r) =>
            state === 'issues' ? ['partial', 'error', 'cancelled'].includes(r.status) : r.status === state,
          )
        : base,
    [base, state],
  );
  const summary = useMemo(
    () =>
      rows.reduce(
        (v, r) => {
          const calls = attempts(r).filter((c) => c.sent);
          v.duration += r.duration;
          v.up += calls.length;
          v.models += calls.filter((c) => c.kind === 'model').length;
          v.business += Number(originOf(r) === 'business');
          return v;
        },
        { duration: 0, up: 0, models: 0, business: 0 },
      ),
    [rows],
  );
  const pg = pageNumber(params.get('pg'), rows.length, size);
  const pageRows = rows.slice(pg * size, (pg + 1) * size);
  function open(r: Log) {
    const back = new URLSearchParams(params);
    if (!back.has('from') && !back.has('anchor')) {
      back.set('anchor', String(window.end));
      updateQuery({ anchor: String(window.end) });
    }
    go('requests', r.id, back.toString());
  }
  function reset() {
    go('requests');
    setDraft('');
    setExpanded('');
  }
  const staged = useMemo(
    () =>
      pageRows.map((r) => ({
        r,
        title: queryText(r),
        preview: previewOf(r, lang),
        calls: attempts(r).filter((c) => c.sent),
      })),
    [rows, pg, lang],
  );
  const numbers = [
    {
      label: t('匹配记录', 'Matching records'),
      value: digits(rows.length),
      note: t('当前完整筛选窗口', 'Across the filtered window'),
      icon: Activity,
      accent: true,
    },
    {
      label: t('业务请求', 'Business requests'),
      value: digits(summary.business),
      note: digits(rows.length - summary.business) + ' ' + t('条调试与测试', 'debug or test records'),
      icon: BookOpen,
    },
    {
      label: t('平均总耗时', 'Mean duration'),
      value: fmt(rows.length ? summary.duration / rows.length : null),
      unit: rows.length ? 'ms' : '',
      note: t('含排队及执行时间', 'Includes queue and execution'),
      icon: Clock3,
    },
    {
      label: t('上游调用', 'Upstream calls'),
      value: digits(summary.up),
      note: t('其中模型', 'Model calls') + ' · ' + digits(summary.models),
      icon: Waypoints,
    },
  ];
  const all = (zh: string, en: string) => ({ value: '', label: t(zh, en) });
  return (
    <>
      <PageHead
        title={t('请求记录', 'Request log')}
        sub={stamp(window.start, zone) + ' — ' + stamp(window.end, zone) + ' · ' + zone}
      >
        <Btn
          small
          onPress={() => {
            setNow(Date.now());
            updateQuery({ anchor: null });
            notify(t('请求窗口已刷新', 'Request window refreshed'));
          }}
        >
          <RefreshCw size={14} />
          {t('刷新', 'Refresh')}
        </Btn>
        <WindowPicker
          params={params}
          window={window}
          zone={zone}
          hours={[1, 24, 72]}
          apply={(changes) => set({ anchor: null, ...changes })}
        />
      </PageHead>
      <NumberStrip items={numbers} />
      <section className="diag-filter-box record-filters">
        <div className="diag-filter-line">
          <Facet
            name={t('记录类型', 'Record type')}
            value={origin}
            set={(v) => set({ origin: v })}
            options={[
              all('全部类型', 'All types'),
              ...Object.entries(originNames).map(([value, name]) => ({ value, label: l(name) })),
            ]}
          />
          <Facet
            name={t('项目', 'Project')}
            value={project}
            set={(v) => set({ project: v })}
            test="record-project"
            options={[
              all('全部项目', 'All projects'),
              ...cfg.projects.map((p) => ({ value: p.id, label: l(p.name) })),
            ]}
          />
          <Facet
            name={t('业务操作', 'Operation')}
            value={op}
            set={(v) => set({ op: v })}
            options={[
              all('全部操作', 'All operations'),
              ...ops.map((k) => ({ value: k, label: l(opLabels[k]) })),
            ]}
          />
          <Facet
            name={t('状态', 'Status')}
            value={state}
            set={(v) => set({ status: v })}
            test="record-status"
            options={[
              all('全部状态', 'All statuses'),
              { value: 'issues', label: t('需关注', 'Needs review') },
              ...Object.entries(statusLabels).map(([value, name]) => ({ value, label: l(name) })),
            ]}
          />
        </div>
        <form
          className="record-search-line"
          onSubmit={(e) => {
            e.preventDefault();
            set({ q: draft.trim() });
          }}
        >
          <SearchBox
            value={draft}
            change={setDraft}
            placeholder={t('搜索问题、URL 或请求 ID', 'Search question, URL or request ID')}
          />
          <Btn type="submit" small>
            {t('查询', 'Search')}
          </Btn>
          <button type="button" className="text-link" onClick={reset}>
            {t('清除筛选', 'Clear filters')}
          </button>
        </form>
      </section>
      <div className="records-workspace">
        <Panel className="record-panel">
          <Caption title={t('请求明细', 'Request list')}>
            <Segments
              label={t('列表密度', 'Row density')}
              value={density}
              change={(v) => set({ density: v })}
              items={[
                { id: 'preview', label: t('结果预览', 'Preview') },
                { id: 'compact', label: t('紧凑', 'Compact') },
              ]}
            />
          </Caption>
          <div className="table-scroll">
            <table className={'data-table diag-record-table ' + density}>
              <thead>
                <tr>
                  {[
                    t('问题 / 请求 ID', 'Question / request ID'),
                    ...(density === 'preview' ? [t('返回结果', 'Result preview')] : []),
                    t('项目 / 接入点', 'Project / endpoint'),
                    t('完成状态', 'Outcome'),
                    t('开始 / 耗时', 'Start / duration'),
                    t('详情', 'Details'),
                  ].map((v) => (
                    <th key={v}>{v}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {staged.map(({ r, title, preview, calls }) => {
                  const peer = calls.find((c) => c.kind === 'search' || c.kind === 'reader') || calls[0];
                  const full = expanded === r.id;
                  const projectText = projectLabel(r, cfg, lang);
                  return (
                    <Fragment key={r.id}>
                      <tr>
                        <td className="rec-query">
                          <button
                            className="row-link record-open"
                            onClick={() => open(r)}
                            data-testid="open-record"
                          >
                            {title}
                          </button>
                          <small className="row-sub">
                            <code>{r.id}</code>
                            <span>{l(originNames[originOf(r)])}</span>
                          </small>
                        </td>
                        {density === 'preview' && (
                          <td className="rec-result">
                            <span
                              className={'result-excerpt ' + (r.status === 'error' ? 'excerpt-error' : '')}
                              title={preview}
                            >
                              {preview}
                            </span>
                            <small className="row-sub">{l(opLabels[r.op])}</small>
                          </td>
                        )}
                        <td className="rec-project">
                          <span>{projectText}</span>
                          <small className="row-sub">
                            {peer ? endpointName(peer.endpoint, cfg, lang, r) : '—'}
                          </small>
                        </td>
                        <td className="rec-outcome">
                          <StateChip value={r.status} />
                          {!recordingComplete(r) && (
                            <small className="row-sub">{t('载荷不全', 'Incomplete payload')}</small>
                          )}
                        </td>
                        <td className="rec-time">
                          <time>{stamp(r.time, zone, true)}</time>
                          <small className="row-sub mono">{r.duration} ms</small>
                        </td>
                        <td className="rec-expand">
                          <button
                            className="table-icon"
                            aria-label={t('展开行摘要', 'Expand row preview') + ' ' + r.id}
                            aria-expanded={full}
                            onClick={() => setExpanded(full ? '' : r.id)}
                          >
                            {full ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                          </button>
                        </td>
                      </tr>
                      {full && (
                        <tr className="expanded-row">
                          <td colSpan={density === 'preview' ? 6 : 5}>
                            <strong>
                              {l(opLabels[r.op])} · {r.duration} ms
                            </strong>
                            <p>{preview}</p>
                            <button className="text-link" onClick={() => open(r)}>
                              {t('打开完整请求', 'Open full request')}
                              <ArrowRight size={14} />
                            </button>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!rows.length && <Empty text={t('该窗口没有匹配请求', 'No matching requests in this window')} />}
          <Pagination
            page={pg}
            total={rows.length}
            size={size}
            change={(n) => updateQuery({ pg: String(n) })}
          />
        </Panel>
      </div>
    </>
  );
}
