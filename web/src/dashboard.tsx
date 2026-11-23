import { operationCounts, requestHours } from "./chart-data";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  CircleAlert,
  CheckCheck,
  Clock3,
  FlaskConical,
  FolderPlus,
  RefreshCw,
  Waypoints,
} from "lucide-react";
import { api, type Entity } from "./api";
import { useApp } from "./state";
import {
  Btn,
  DataTable,
  Empty,
  Head,
  Notice,
  Panel,
  Select,
  Status,
} from "./ui";
import { Operation, operationName, requestTitle } from "./request-display";
import { TrendChart } from "./trend-chart";
const interval = (hours: number) => ({
  from: new Date(Date.now() - hours * 3600000).toISOString(),
  to: new Date().toISOString(),
});
export function Dashboard() {
  const { t, projects, resources, language } = useApp();
  const [hours, setHours] = useState(24),
    [range, setRange] = useState(() => interval(24));
  const nav = useNavigate();
  const params = new URLSearchParams({
    ...range,
  });
  const counts = useQuery({
    queryKey: ["aggregates", params.toString()],
    queryFn: () => api<Entity>("/admin/v1/requests/aggregates?" + params),
    refetchInterval: 10000,
  });
  const recent = useQuery({
    queryKey: ["recent", params.toString()],
    queryFn: () => api<Entity>("/admin/v1/requests?limit=6&" + params),
    refetchInterval: 10000,
  });
  const a = counts.data || {},
    endpoints = resources.data?.endpoints || [];
  const available = endpoints.filter(
    (e) => e.availability === "available",
  ).length;
  const operations = ["list", "content", "summary"] as const;
  const colors = [
    "var(--trend-list)",
    "var(--trend-content)",
    "var(--trend-summary)",
  ];
  const knownOps = operationCounts(a.operations, a.series),
    ops = knownOps ?? { list: 0, content: 0, summary: 0 };
  const total = knownOps ? operations.reduce((v, k) => v + ops[k], 0) : null;
  const number = (value: number | null | undefined) =>
    value == null ? "—" : new Intl.NumberFormat(language).format(value);
  const priorRange = new URLSearchParams({
    from: new Date(
      2 * Date.parse(range.from) - Date.parse(range.to),
    ).toISOString(),
    to: range.from,
  });
  const prior = useQuery({
    queryKey: ["aggregates", priorRange.toString()],
    queryFn: () => api<Entity>("/admin/v1/requests/aggregates?" + priorRange),
    staleTime: 60000,
  });
  const rate = (r: Entity | undefined) =>
    r?.completed ? (100 * r.successful) / r.completed : null;
  const success = rate(a),
    previousRate = rate(prior.data);
  const delta = (
    value: number | null | undefined,
    base: number | null | undefined,
    points = false,
  ) => {
    if (
      value == null ||
      base == null ||
      !prior.data?.requests ||
      (!points && !base)
    )
      return t("当前时间窗口", "Current time window");
    const n = points ? value - base : (100 * (value - base)) / base;
    return (
      t("较上一周期 ", "vs previous ") +
      (n > 0 ? "+" : "") +
      number(Number(n.toFixed(1))) +
      (points ? " pp" : "%")
    );
  };
  const metrics = [
    {
      label: t("请求总量", "Total requests"),
      value: number(a.requests),
      note: delta(a.requests, prior.data?.requests),
      Icon: Activity,
      path: "/requests?" + params,
    },
    {
      label: t("请求成功率", "Success rate"),
      value: success == null ? "—" : success.toFixed(2),
      unit: success == null ? "" : "%",
      note: delta(success, previousRate, true),
      Icon: CheckCheck,
      path: "/requests?" + params,
    },
    {
      label: t("平均耗时", "Average duration"),
      value:
        a.average_duration_ms == null
          ? "—"
          : a.average_duration_ms >= 1000
            ? (a.average_duration_ms / 1000).toFixed(1)
            : number(Math.round(a.average_duration_ms)),
      unit:
        a.average_duration_ms == null
          ? ""
          : a.average_duration_ms >= 1000
            ? "s"
            : "ms",
      note: delta(a.average_duration_ms, prior.data?.average_duration_ms),
      Icon: Clock3,
      path: "/requests?" + params,
    },
    {
      label: t("可用接入点", "Available endpoints"),
      value: resources.isPending ? "—" : number(available),
      unit: resources.isPending ? "" : `/ ${endpoints.length}`,
      note: t("查看已配置的能力", "View configured capabilities"),
      Icon: Waypoints,
      path: "/endpoints",
    },
  ];
  const open = (from: string, to: string) =>
    nav(
      "/requests?" +
        new URLSearchParams({
          from,
          to,
        }),
    );
  return (
    <>
      <Head
        title={t("运行总览", "Overview")}
        sub={new Intl.DateTimeFormat(language, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).formatRange(new Date(range.from), new Date(range.to))}
      >
        <div className="scope-picker">
          <Select
            label={t("时间范围", "Time range")}
            value={String(hours)}
            change={(v) => {
              setHours(Number(v));
              setRange(interval(Number(v)));
            }}
            options={[
              ["24", t("最近 24 小时", "Last 24 hours")],
              ["168", t("最近 7 天", "Last 7 days")],
              ["720", t("最近 30 天", "Last 30 days")],
            ].map(([value, label]) => ({ value, label }))}
          />
        </div>
        <Btn
          aria-label={t("刷新", "Refresh")}
          onPress={() => setRange(interval(hours))}
        >
          <RefreshCw size={16} />
          {t("刷新", "Refresh")}
        </Btn>
        <Btn primary onPress={() => nav("/playground")}>
          <FlaskConical size={17} />
          {t("打开调试台", "Open playground")}
        </Btn>
      </Head>
      <Notice error={counts.error || recent.error} />
      <div className="metric-grid dashboard-metrics">
        {metrics.map(({ label, value, unit, note, Icon, path }) => (
          <Panel key={label} className="metric dashboard-metric">
            <div className="metric-top">
              <span>{label}</span>
              <Icon size={18} />
            </div>
            <strong className="metric-value">
              {value}
              {unit && <small>{unit}</small>}
            </strong>
            <button className="metric-note" onClick={() => nav(path)}>
              {note}
              <ArrowUpRight size={13} />
            </button>
          </Panel>
        ))}
      </div>
      <div className="dashboard-charts">
        <Panel flush className="dashboard-traffic">
          <header className="panel-header">
            <div>
              <Activity size={18} />
              <h2>{t("请求流量", "Request traffic")}</h2>
            </div>
            <small>{t("请求数", "Requests")}</small>
          </header>
          <TrendChart
            dark
            from={range.from}
            to={range.to}
            series={operations.map((id, i) => ({
              id,
              name: operationName(id, t),
              color: colors[i],
            }))}
            buckets={requestHours(a.series, range.from, range.to)}
            select={open}
          />
        </Panel>
        <Panel flush className="dashboard-distribution">
          <header className="panel-header">
            <h2>{t("操作分布", "Operation mix")}</h2>
          </header>
          <div className="distribution-content">
            <div
              className="operation-donut"
              style={{
                background: total
                  ? `conic-gradient(var(--op-list) 0 ${(100 * ops.list) / total}%,var(--op-content) ${(100 * ops.list) / total}% ${(100 * (ops.list + ops.content)) / total}%,var(--op-summary) ${(100 * (ops.list + ops.content)) / total}% 100%)`
                  : "var(--line)",
              }}
              aria-label={t("操作分布", "Operation mix")}
            >
              <div>
                <strong>{number(total)}</strong>
                <span>{t("次请求", "requests")}</span>
              </div>
            </div>
            <div className="distribution-legend">
              {operations.map((op, i) => (
                <button
                  key={op}
                  onClick={() =>
                    nav("/requests?" + params + "&operation=" + op)
                  }
                >
                  <i
                    style={{
                      background: [
                        "var(--op-list)",
                        "var(--op-content)",
                        "var(--op-summary)",
                      ][i],
                    }}
                  />
                  <span>{operationName(op, t)}</span>
                  <b>
                    {total ? `${((100 * ops[op]) / total).toFixed(1)}%` : "—"}
                  </b>
                  <ArrowUpRight size={14} />
                </button>
              ))}
            </div>
          </div>
        </Panel>
      </div>
      <Panel flush className="dashboard-review">
        <div>
          <Activity size={18} />
          <strong>{t("当前窗口", "Current window")}</strong>
          <span>
            {t("上游调用", "Upstream calls")} <b>{number(a.upstream_calls)}</b>{" "}
            · {t("模型调用", "Model calls")} <b>{number(a.model_calls)}</b>
          </span>
        </div>
        <div className="review-links">
          <Btn
            small
            onPress={() => nav("/requests?" + params + "&status=error")}
          >
            {t("失败", "Failed")} {number(a.errors)}
            <ArrowUpRight size={14} />
          </Btn>
          <Btn
            small
            onPress={() => nav("/requests?" + params + "&status=partial")}
          >
            {t("部分完成", "Partial")} {number(a.partial)}
            <ArrowUpRight size={14} />
          </Btn>
          <Btn small onPress={() => nav("/observability?" + params)}>
            {t("运行观测", "Observability")}
            <ArrowUpRight size={14} />
          </Btn>
        </div>
      </Panel>
      {!projects.length && (
        <Panel flush className="onboarding">
          <div className="onboarding__content">
            <span className="tile-icon">
              <FolderPlus size={21} />
            </span>
            <div>
              <strong>
                {t("创建第一个项目", "Create your first project")}
              </strong>
              <p>
                {t(
                  "创建项目，连接搜索、正文和模型能力。",
                  "Create a project and connect search, reading and model capabilities.",
                )}
              </p>
            </div>
            <Btn onPress={() => nav("/projects")}>
              {t("配置项目", "Configure projects")}
              <ArrowRight size={16} />
            </Btn>
          </div>
        </Panel>
      )}
      <Panel flush className="recent">
        <header className="panel-header">
          <h2>{t("最近请求", "Recent requests")}</h2>
          <Link to={"/requests?" + params}>
            {t("查看全部", "View all")}
            <ArrowUpRight size={15} />
          </Link>
        </header>
        <DataTable>
          <DataTable.Header>
            {[
              t("请求内容", "Request"),
              t("操作", "Operation"),
              t("项目", "Project"),
              t("状态", "Status"),
              t("耗时", "Duration"),
              t("时间", "Time"),
            ].map((label) => (
              <DataTable.Column key={label}>{label}</DataTable.Column>
            ))}
          </DataTable.Header>
          <DataTable.Body>
            {(recent.data?.items || []).map((r: Entity) => (
              <DataTable.Row key={r.request_id}>
                <DataTable.Cell>
                  <Link className="row-link" to={"/requests/" + r.request_id}>
                    {requestTitle(r, t)}
                  </Link>
                </DataTable.Cell>
                <DataTable.Cell>
                  <Operation value={r.operation} />
                </DataTable.Cell>
                <DataTable.Cell>
                  {r.project_name || t("独立测试", "Standalone test")}
                </DataTable.Cell>
                <DataTable.Cell>
                  <Status value={r.status} />
                </DataTable.Cell>
                <DataTable.Cell>
                  <span className="numeric">{number(r.duration_ms)} ms</span>
                </DataTable.Cell>
                <DataTable.Cell>
                  <span className="muted">
                    {new Date(r.started_at).toLocaleTimeString(
                      language === "zh" ? "zh-CN" : "en-US",
                      { hour12: false },
                    )}
                  </span>
                </DataTable.Cell>
              </DataTable.Row>
            ))}
          </DataTable.Body>
        </DataTable>
        {!recent.data?.items?.length && (
          <Empty>
            {recent.isPending
              ? t("正在读取请求…", "Loading requests…")
              : t("当前时间窗口没有请求", "No requests in this time window")}
          </Empty>
        )}
      </Panel>
    </>
  );
}
