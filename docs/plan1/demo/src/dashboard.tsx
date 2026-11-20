import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  CheckCheck,
  Clock3,
  FlaskConical,
  Waypoints,
} from 'lucide-react';
import { useConsole } from './state';
import { Table } from '@heroui/react';
import { Log, Op, clock, date, digits, ops, opLabels } from './model';
import { anchorTime, DAY } from './fixtures';
import { periodLogs, stats, buckets } from './metrics';
import { Btn, Caption, OpLabel, PageHead, Panel, RangeSelect, StateChip } from './ui';
import { available } from './engine';
const chartColors = { list: '#d5f58a', content: '#6fd2b4', summary: '#78a9e5' };
function Trend({ rows }: { rows: Log[] }) {
  const { period, lang, l, t, go } = useConsole();
  const ref = useRef<HTMLCanvasElement>(null);
  const [point, setPoint] = useState<number | null>(null);
  const [visible, setVisible] = useState<Op[]>(ops);
  const points = useMemo(() => buckets(rows, period), [rows, period]);
  function inspectBucket(index: number) {
    const span = (period * DAY) / points.length;
    const p = points[index];
    if (!p) return;
    const from = Math.round(p.time - span / 2),
      to = index === points.length - 1 ? Math.max(from + 1, Date.now() + 1) : Math.round(p.time + span / 2);
    const q = new URLSearchParams({
      from: String(from),
      to: String(to),
      ...(visible.length === 1 ? { op: visible[0] } : {}),
    });
    go('requests', '', q.toString());
  }
  function pointerAt(el: HTMLCanvasElement, px: number) {
    const b = el.getBoundingClientRect();
    return Math.max(
      0,
      Math.min(points.length - 1, Math.round(((px - b.left - 34) / (b.width - 43)) * (points.length - 1))),
    );
  }
  const [size, setSize] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize((x) => x + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const w = box.width,
      h = box.height,
      dpr = window.devicePixelRatio || 1;
    if (w < 10 || h < 10) return;
    el.width = Math.round(w * dpr);
    el.height = Math.round(h * dpr);
    const ctx = el.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    const left = 34,
      right = 9,
      top = 12,
      bottom = 25;
    const plotW = w - left - right,
      plotH = h - top - bottom;
    const largest = Math.max(1, ...points.map((p) => Math.max(...visible.map((k) => p[k]))));
    const step = Math.max(1, Math.ceil(largest / 3 / 10) * 10);
    const max = step * 3;
    ctx.font = '10px Geist, sans-serif';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 3; i++) {
      const y = top + (plotH * i) / 3;
      ctx.strokeStyle = 'rgba(209,239,223,.16)';
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(w - right, y);
      ctx.stroke();
      ctx.fillStyle = '#adbfaf';
      ctx.textAlign = 'left';
      ctx.fillText(String(max - step * i), 0, y);
    }
    ctx.setLineDash([]);
    const x = (i: number) => left + (plotW * i) / (points.length - 1);
    const y = (v: number) => top + plotH * (1 - v / max);
    const labels = w > 480 ? 6 : 4;
    for (let n = 0; n < labels; n++) {
      const i = Math.round(((points.length - 1) * n) / (labels - 1));
      const dt = new Date(points[i].time);
      ctx.textAlign = n === 0 ? 'left' : n === labels - 1 ? 'right' : 'center';
      ctx.fillText(
        period === 1
          ? String(dt.getHours()).padStart(2, '0') + ':00'
          : dt.getMonth() + 1 + '/' + dt.getDate(),
        x(i),
        h - 6,
      );
    }
    visible.forEach((k) => {
      const path = new Path2D();
      path.moveTo(x(0), y(points[0][k]));
      for (let i = 1; i < points.length; i++) {
        const prev = points[i - 1],
          cur = points[i],
          before = points[Math.max(0, i - 2)],
          after = points[Math.min(points.length - 1, i + 1)];
        const dx = (x(i) - x(i - 1)) / 3;
        path.bezierCurveTo(
          x(i - 1) + dx,
          y(prev[k]) + (y(cur[k]) - y(before[k])) / 6,
          x(i) - dx,
          y(cur[k]) - (y(after[k]) - y(prev[k])) / 6,
          x(i),
          y(cur[k]),
        );
      }
      if (k === 'list') {
        const fill = new Path2D(path);
        fill.lineTo(x(points.length - 1), top + plotH);
        fill.lineTo(left, top + plotH);
        fill.closePath();
        const grad = ctx.createLinearGradient(0, top, 0, top + plotH);
        grad.addColorStop(0, 'rgba(198,238,135,.21)');
        grad.addColorStop(1, 'rgba(198,238,135,0)');
        ctx.fillStyle = grad;
        ctx.fill(fill);
      }
      ctx.strokeStyle = chartColors[k];
      ctx.lineWidth = k === 'list' ? 2.7 : 1.9;
      ctx.lineJoin = 'round';
      ctx.stroke(path);
    });
    if (point !== null) {
      const i = Math.min(points.length - 1, point);
      ctx.beginPath();
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = '#c8d9cc';
      ctx.moveTo(x(i), top);
      ctx.lineTo(x(i), top + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      visible.forEach((k) => {
        ctx.beginPath();
        ctx.fillStyle = chartColors[k];
        ctx.arc(x(i), y(points[i][k]), 3.8, 0, Math.PI * 2);
        ctx.fill();
      });
    }
  }, [points, point, size, visible, period]);
  return (
    <Panel className="trend-panel">
      <header>
        <div className="chart-head">
          <span className="chart-glyph">
            <Activity size={18} />
          </span>
          <h2>{t('请求流量', 'Request traffic')}</h2>
        </div>
        <span className="chart-unit">{t('请求数', 'Requests')}</span>
      </header>
      <div className="chart-legends">
        {ops.map((k) => (
          <button
            key={k}
            aria-pressed={visible.includes(k)}
            onClick={() =>
              setVisible((v) => (v.includes(k) ? (v.length > 1 ? v.filter((x) => x !== k) : v) : [...v, k]))
            }
          >
            <i style={{ background: chartColors[k] }} />
            {l(opLabels[k])}
          </button>
        ))}
      </div>
      <div className="line-plot">
        <canvas
          ref={ref}
          aria-label={t(
            '请求流量，左右键选时段，回车查看请求',
            'Traffic by operation. Arrow keys select a bucket; Enter opens its requests.',
          )}
          role="button"
          data-testid="atlas-traffic"
          tabIndex={0}
          onMouseMove={(e) => setPoint(pointerAt(e.currentTarget, e.clientX))}
          onClick={(e) => inspectBucket(pointerAt(e.currentTarget, e.clientX))}
          onMouseLeave={() => setPoint(null)}
          onBlur={() => setPoint(null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              inspectBucket(point ?? 0);
              return;
            }
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
              e.preventDefault();
              setPoint((v) =>
                Math.max(0, Math.min(points.length - 1, (v ?? 0) + (e.key === 'ArrowRight' ? 1 : -1))),
              );
            }
          }}
        />
        {point !== null && points[point] && (
          <div className="plot-tip">
            {date(points[point].time, lang)} · {clock(points[point].time)}　
            {visible.map((k) => points[point][k]).join(' / ')}
          </div>
        )}
      </div>
    </Panel>
  );
}
export function RecentTable({ rows }: { rows: Log[] }) {
  const { t, l, go, cfg } = useConsole();
  const columns = [
    ['query', t('请求内容', 'Request')],
    ['operation', t('操作', 'Operation')],
    ['project', t('项目', 'Project')],
    ['status', t('状态', 'Status')],
    ['duration', t('耗时', 'Duration')],
    ['time', t('时间', 'Time')],
  ];
  return (
    <Table className="hero-grid">
      <Table.ScrollContainer className="table-scroll">
        <Table.Content aria-label={t('最近请求', 'Recent requests')} className="data-table requests-table">
          <Table.Header>
            {columns.map(([id, label]) => (
              <Table.Column
                key={id}
                id={id}
                isRowHeader={id === 'query'}
                className={id === 'duration' ? 'numeric' : ''}
              >
                {label}
              </Table.Column>
            ))}
          </Table.Header>
          <Table.Body>
            {rows.map((r) => (
              <Table.Row id={r.id} key={r.id} textValue={l(r.query)}>
                <Table.Cell>
                  <button className="row-link cut" onClick={() => go('requests', r.id, 'back=overview')}>
                    {l(r.query)}
                  </button>
                  <small className="row-sub mono">{r.id}</small>
                </Table.Cell>
                <Table.Cell>
                  <OpLabel op={r.op} />
                </Table.Cell>
                <Table.Cell>{l(cfg.projects.find((p) => p.id === r.project)?.name || '—')}</Table.Cell>
                <Table.Cell>
                  <StateChip value={r.status} />
                </Table.Cell>
                <Table.Cell className="numeric mono">{r.duration} ms</Table.Cell>
                <Table.Cell className="mono muted">{clock(r.time, true)}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
    </Table>
  );
}
export function Dashboard() {
  const { t, l, lang, go, logs, period, cfg } = useConsole();
  const rows = useMemo(() => periodLogs(logs, period), [logs, period]);
  const values = useMemo(() => stats(rows), [rows]);
  const previous = useMemo(() => stats(periodLogs(logs, period, 1)), [logs, period]);
  const needsReview = useMemo(
    () => ({
      error: rows.filter((r) => r.status === 'error').length,
      partial: rows.filter((r) => r.status === 'partial').length,
    }),
    [rows],
  );
  function openWindow(status = '') {
    go(
      'requests',
      '',

      new URLSearchParams({
        from: String(anchorTime - period * DAY),
        to: String(Date.now() + 1),
        ...(status ? { status } : {}),
      }).toString(),
    );
  }
  const endpointCount = cfg.endpoints.filter((e) => available(cfg, e.id)).length;
  const metrics = [
    {
      id: 'count',
      name: t('请求总量', 'Total requests'),
      value: digits(values.count),
      unit: '',
      icon: Activity,
      change: previous.count ? ((values.count - previous.count) / previous.count) * 100 : null,
    },
    {
      id: 'rate',
      name: t('请求成功率', 'Success rate'),
      value: values.rate.toFixed(2),
      unit: '%',
      icon: CheckCheck,
      change: previous.count ? values.rate - previous.rate : null,
    },
    {
      id: 'latency',
      name: t('平均耗时', 'Average latency'),
      value: digits(values.latency),
      unit: 'ms',
      icon: Clock3,
      change: previous.latency ? ((values.latency - previous.latency) / previous.latency) * 100 : null,
    },
    {
      id: 'endpoints',
      name: t('可用接入点', 'Available endpoints'),
      value: String(endpointCount),
      unit: ' / ' + cfg.endpoints.length,
      icon: Waypoints,
      change: null,
    },
  ];
  const ratio = ops.map((k) => (values.count ? (values.counts[k] / values.count) * 100 : 0));
  const conic = values.count
    ? 'conic-gradient(var(--op-list) 0 ' +
      ratio[0] +
      '%,var(--op-content) ' +
      ratio[0] +
      '% ' +
      (ratio[0] + ratio[1]) +
      '%,var(--op-summary) 0)'
    : 'var(--line)';
  return (
    <>
      <PageHead
        title={t('运行总览', 'Workspace overview')}
        sub={date(anchorTime - period * DAY, lang) + ' — ' + date(anchorTime, lang)}
      >
        <RangeSelect />
        <Btn onPress={() => go('observability', '', 'hours=' + period * 24)}>
          <Activity size={15} />
          {t('运行观测', 'Observability')}
        </Btn>
        <Btn primary onPress={() => go('playground')}>
          <FlaskConical size={16} />
          {t('打开调试台', 'Open playground')}
        </Btn>
      </PageHead>
      <div className="metric-grid">
        {metrics.map(({ id, name, value, unit, icon: I, change }) => (
          <Panel className={'metric metric-' + id} key={id}>
            <div className="metric-top">
              <span>{name}</span>
              <I size={17} />
            </div>
            <strong>
              {value}
              <small>{unit}</small>
            </strong>
            <div className="metric-note">
              {change !== null ? (
                <>
                  <span
                    className={
                      'delta ' +
                      ((id === 'rate' && change < 0) || (id === 'latency' && change > 0) ? 'downside' : '')
                    }
                  >
                    {change >= 0 ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}{' '}
                    {Math.abs(change).toFixed(id === 'rate' ? 2 : 1)}
                    {id === 'rate' ? ' pp' : '%'}
                  </span>{' '}
                  {t('较上一周期', 'vs. prior period')}
                </>
              ) : id === 'endpoints' ? (
                <button className="text-link" onClick={() => go('endpoints')}>
                  <i className="health-dot" />
                  {t('查看接入点', 'View endpoints')}
                  <ArrowRight size={12} />
                </button>
              ) : (
                t('无上期样本', 'No prior sample')
              )}
            </div>
          </Panel>
        ))}
      </div>
      <div className="dash-pair">
        <Trend rows={rows} />
        <Panel className="distribution">
          <Caption title={t('操作分布', 'Operation mix')} />
          <div className="distribution-body">
            <div
              className="donut"
              style={{ background: conic }}
              role="img"
              aria-label={ops.map((x, i) => l(opLabels[x]) + ' ' + Math.round(ratio[i]) + '%').join(', ')}
            >
              <div>
                <strong>{digits(values.count)}</strong>
                <small>{t('次请求', 'requests')}</small>
              </div>
            </div>
            <div className="mix-list">
              {ops.map((k, i) => (
                <button
                  type="button"
                  key={k}
                  onClick={() =>
                    go(
                      'requests',
                      '',

                      new URLSearchParams({
                        op: k,
                        from: String(anchorTime - period * DAY),
                        to: String(Date.now() + 1),
                      }).toString(),
                    )
                  }
                  title={t('查看匹配请求', 'View matching requests')}
                >
                  <i style={{ background: 'var(--op-' + k + ')' }} />
                  <span>{l(opLabels[k])}</span>
                  <b>{ratio[i].toFixed(1)}%</b>
                  <ArrowUpRight size={12} />
                </button>
              ))}
            </div>
          </div>
        </Panel>
      </div>
      <div className="atlas-review">
        <div>
          <Activity size={17} />
          <b>{t('待排查请求', 'Requests to review')}</b>
          <span>{t('当前窗口', 'Current window')}</span>
        </div>
        <button onClick={() => openWindow('error')}>
          <i className="incident-dot" />
          {t('失败', 'Errors')} <strong>{digits(needsReview.error)}</strong>
          <ArrowUpRight size={13} />
        </button>
        <button onClick={() => openWindow('partial')}>
          <i className="incident-dot partial" />
          {t('部分完成', 'Partial')} <strong>{digits(needsReview.partial)}</strong>
          <ArrowUpRight size={13} />
        </button>
      </div>
      <Panel className="recent">
        <Caption title={t('最近请求', 'Recent requests')}>
          <button className="text-link" onClick={() => openWindow()}>
            {t('查看全部', 'View all')}
            <ArrowUpRight size={14} />
          </button>
        </Caption>
        <RecentTable rows={rows.slice(0, 5)} />
      </Panel>
    </>
  );
}
