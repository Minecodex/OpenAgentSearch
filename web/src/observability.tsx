import { LanguagePicker } from "./language-picker";
import { ChartNoAxesCombined, List } from "lucide-react";
import { TimeWindow } from "./filter-controls";
import { TrendChart } from "./trend-chart";
import { ViewTabs, Segments } from "./ui";
import { DataTable } from "./ui";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type Entity } from "./api";
import { useApp } from "./state";
import { Btn, Empty, Field, Head, Notice, Panel, Select } from "./ui";
import { CallTable } from "./records";

export function Observability() {
  const { t, resources, projects, pageHistory, language } = useApp();
  const [params, setParams] = useSearchParams();
  const [initial] = useState(() => ({
    from: new Date(Date.now() - 86400000).toISOString(),
    to: new Date().toISOString(),
  }));
  useEffect(() => {
    if (!params.has("from") || !params.has("to")) {
      const next = new URLSearchParams(params);
      for (const [k, v] of Object.entries(initial))
        if (!next.has(k)) next.set(k, v);
      setParams(next, { replace: true });
    }
  }, []);
  const tab = params.has("call") ? "calls" : params.get("tab") || "overview";
  const update = (patch: Entity) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, String(v));
      else next.delete(k);
    }
    if (!("call" in patch)) next.delete("call");
    if (!("cursor" in patch)) next.delete("cursor");
    setParams(next, { replace: !!patch.call });
  };
  const scope = new URLSearchParams(params);
  for (const key of ["tab", "call", "cursor", "trend_metric"])
    scope.delete(key);
  for (const [k, v] of Object.entries(initial))
    if (!scope.has(k)) scope.set(k, v);
  const statistics = new URLSearchParams(scope);
  for (const key of ["q", "status", "evaluation", "request_id"])
    statistics.delete(key);
  const stats = useQuery({
    queryKey: ["statistics", statistics.toString()],
    queryFn: () => api<Entity>("/admin/v1/endpoint-statistics?" + statistics),
    refetchInterval: 10000,
    enabled: tab === "overview",
  });
  const callsScope = new URLSearchParams(scope);
  callsScope.set("limit", "20");
  if (params.get("cursor")) callsScope.set("cursor", params.get("cursor")!);
  const calls = useQuery({
    queryKey: ["calls", callsScope.toString()],
    queryFn: () => api<Entity>("/admin/v1/endpoint-calls?" + callsScope),
    refetchInterval: 10000,
    enabled: tab === "calls",
  });
  const key = "observability:" + scope.toString(),
    previous = pageHistory.current[key] || [];
  const m = stats.data?.overview || {},
    metric = params.get("trend_metric") || "calls";
  const ratio = (n: number, d: number) =>
    d ? `${((100 * n) / d).toFixed(1)}%` : "—";
  const filters = [
    [
      "kind",
      t("能力", "Capability"),
      [
        ["", t("全部能力", "All capabilities")],
        ["search", t("搜索", "Search")],
        ["reader", t("正文", "Reader")],
        ["model", t("模型", "Model")],
      ],
    ],
    [
      "endpoint_id",
      t("接入点", "Endpoint"),
      [
        ["", t("全部接入点", "All endpoints")],
        ...(resources.data?.endpoints || [])
          .filter((e) => !params.get("kind") || e.kind === params.get("kind"))
          .map((e) => [e.id, e.name]),
      ],
    ],
    [
      "project_id",
      t("项目", "Project"),
      [
        ["", t("全部项目", "All projects")],
        ...projects.map((e) => [e.id, e.name]),
      ],
    ],
    [
      "origin",
      t("来源", "Origin"),
      [
        ["", t("全部来源", "All origins")],
        ["business", t("业务请求", "Business")],
        ["debug", t("调试", "Debug")],
        ["endpoint_test", t("接入点测试", "Endpoint test")],
        ["proxy_test", t("代理测试", "Proxy test")],
      ],
    ],
    ["language", t("业务语言", "Business language"), []],
    [
      "operation",
      t("操作", "Operation"),
      [
        ["", t("全部操作", "All operations")],
        ["list", t("搜索列表", "Search list")],
        ["content", t("网页正文", "Article content")],
        ["summary", t("综合总结", "Synthesis")],
      ],
    ],
    [
      "timezone",
      t("统计时区", "Statistics timezone"),
      [
        ...new Set([
          "UTC",
          ...(params.get("timezone") ? [params.get("timezone")!] : []),
          ...Intl.supportedValuesOf("timeZone"),
        ]),
      ].map((v) => [v, v]),
    ],
    [
      "granularity",
      t("统计粒度", "Granularity"),
      [
        ["", t("自动", "Automatic")],
        ["hour", t("小时", "Hour")],
        ["day", t("天", "Day")],
        ["week", t("周", "Week")],
        ["month", t("月", "Month")],
      ],
    ],
  ] as [string, string, string[][]][];
  return (
    <>
      <Head
        title={t("运行观测", "Observability")}
        sub={t(
          "按调用完成时间查看结果、耗时和质量。观测不参与选路。",
          "Inspect results, timing and quality by completion time. Observations do not control routing.",
        )}
      >
        <TimeWindow
          range={{ from: scope.get("from")!, to: scope.get("to")! }}
          change={(value) => update(value)}
        />
        <Btn
          onPress={() => {
            const duration =
              new Date(scope.get("to")!).getTime() -
              new Date(scope.get("from")!).getTime();
            update({
              to: new Date().toISOString(),
              from: new Date(Date.now() - duration).toISOString(),
            });
          }}
        >
          {t("刷新时间窗", "Refresh window")}
        </Btn>
      </Head>
      <ViewTabs
        toolbar={
          <Segments
            label={t("能力", "Capability")}
            value={params.get("kind") || ""}
            change={(kind) =>
              update({
                kind,
                endpoint_id: "",
                trend_metric:
                  kind === "model" && metric === "quality" ? "calls" : metric,
              })
            }
            items={[
              ["", t("全部能力", "All capabilities")],
              ["search", t("搜索", "Search")],
              ["reader", t("正文", "Reader")],
              ["model", t("模型", "Model")],
            ]}
          />
        }
        label={t("观测视图", "Observation views")}
        value={tab}
        change={(value) => update({ tab: value })}
        items={[
          [
            "overview",
            <>
              <ChartNoAxesCombined size={14} />
              {t("统计概览", "Statistics")}
            </>,
          ],
          [
            "calls",
            <>
              <List size={14} />
              {t("调用明细", "Calls")}
            </>,
          ],
        ]}
      >
        <Panel className="filter-panel">
          <div className="filter-grid">
            {filters
              .filter(
                ([key]) =>
                  key !== "kind" && (tab === "calls" || key !== "granularity"),
              )
              .map(([key, label, options]) =>
                key === "language" ? (
                  <LanguagePicker
                    key={key}
                    label={label}
                    value={params.get(key) || ""}
                    change={(v) => update({ [key]: v })}
                    emptyLabel={t("全部语言", "All languages")}
                  />
                ) : (
                  <Select
                    key={key}
                    label={label}
                    value={params.get(key) || (key === "timezone" ? "UTC" : "")}
                    change={(v) => update({ [key]: v })}
                    options={options.map(([value, label]) => ({
                      value,
                      label,
                    }))}
                  />
                ),
              )}
          </div>
        </Panel>
        <Notice error={tab === "calls" ? calls.error : stats.error} />
        {tab === "calls" ? (
          <>
            <Panel>
              <div className="filter-grid">
                <Field
                  label={t("输入或请求 ID", "Input or request ID")}
                  value={params.get("q") || ""}
                  change={(v) => update({ q: v })}
                />
                <Select
                  label={t("调用状态", "Call status")}
                  value={params.get("status") || ""}
                  change={(v) => update({ status: v })}
                  options={[
                    ["", t("全部状态", "All statuses")],
                    ["success", t("成功", "Success")],
                    ["partial", t("部分完成", "Partial")],
                    ["error", t("失败", "Failed")],
                    ["empty", t("无结果", "Empty")],
                    ["cancelled", t("取消", "Cancelled")],
                  ].map(([value, label]) => ({ value, label }))}
                />
                <Select
                  label={t("评价状态", "Evaluation")}
                  value={params.get("evaluation") || ""}
                  change={(v) => update({ evaluation: v })}
                  options={[
                    ["", t("全部评价", "All evaluations")],
                    ["complete", t("评分完整", "Complete scores")],
                    ["incomplete", t("评分不完整", "Incomplete scores")],
                    ["unscored", t("未评分", "Unscored")],
                    ["missing", t("材料缺失", "Missing")],
                    ["received", t("正文提取", "Article extraction")],
                    ["model", t("模型调用", "Model call")],
                  ].map(([value, label]) => ({ value, label }))}
                />
              </div>
            </Panel>
            {calls.isPending ? (
              <Empty>{t("正在读取调用…", "Loading calls…")}</Empty>
            ) : (
              <CallTable calls={calls.data?.items || []} />
            )}
            <div className="form-actions">
              <Btn
                disabled={!previous.length}
                onPress={() => {
                  update({ cursor: previous.at(-1) || "" });
                  pageHistory.current[key] = previous.slice(0, -1);
                }}
              >
                {t("上一页", "Previous")}
              </Btn>
              <Btn
                disabled={!calls.data?.next_cursor}
                onPress={() => {
                  pageHistory.current[key] = [
                    ...previous,
                    params.get("cursor") || "",
                  ];
                  update({ cursor: calls.data!.next_cursor });
                }}
              >
                {t("下一页", "Next")}
              </Btn>
            </div>
          </>
        ) : (
          <>
            <div className="metrics record-metrics">
              {[
                {
                  label: t("调用次数", "Calls"),
                  value: m.calls,
                  detail: m.usage_samples
                    ? `${t("输入 / 输出 Token", "Input / output tokens")} · ${m.input_tokens} / ${m.output_tokens}`
                    : t("暂无 Token 用量样本", "No token usage samples"),
                },
                {
                  label: t("成功率", "Success rate"),
                  value: ratio(m.successes, m.calls),
                  detail: `${t("成功调用", "Successful calls")} · ${m.successes ?? "—"}`,
                },
                {
                  label: t("平均执行", "Mean execution"),
                  value: m.speed_samples
                    ? `${Math.round(m.speed_ms / m.speed_samples)} ms`
                    : "—",
                  detail: `P95 · ${m.p95_ms == null ? "—" : m.p95_ms + " ms"}`,
                },
                {
                  label: t("材料质量", "Material quality"),
                  value: ratio(m.quality_numerator, m.quality_denominator),
                  detail: `${t("有效样本", "Evaluated samples")} · ${m.quality_denominator ?? "—"}`,
                },
              ].map(({ label, value, detail }) => (
                <Panel key={label} className="metric">
                  <small>{label}</small>
                  <strong>{value ?? "—"}</strong>
                  <span className="metric-description">{detail}</span>
                </Panel>
              ))}
            </div>
            <div className="observation-plots">
              <Panel flush>
                <div className="panel-header">
                  <h2>{t("调用趋势", "Call trend")}</h2>
                  <div className="plot-controls">
                    <Select
                      label={t("统计粒度", "Granularity")}
                      value={params.get("granularity") || ""}
                      change={(v) => update({ granularity: v })}
                      options={filters
                        .find(([key]) => key === "granularity")![2]
                        .map(([value, label]) => ({ value, label }))}
                    />
                  </div>
                </div>
                <div
                  className="segments plot-metric-switch"
                  role="group"
                  aria-label={t("趋势指标", "Trend metric")}
                >
                  {[
                    ["calls", t("调用量", "Calls")],
                    ["latency", t("执行耗时", "Execution time")],
                    ["quality", t("质量", "Quality")],
                  ].map(([key, label]) => (
                    <button
                      key={key}
                      aria-pressed={metric === key}
                      data-active={metric === key}
                      onClick={() => update({ trend_metric: key })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <Trend
                  from={scope.get("from")!}
                  to={scope.get("to")!}
                  series={stats.data?.series || []}
                  metric={metric}
                  timezone={params.get("timezone") || "UTC"}
                  select={(from, to) => update({ from, to, tab: "calls" })}
                />
              </Panel>
              <Panel flush className="quality-panel">
                <header className="panel-header">
                  <h2>{t("接入点质量对比", "Quality by endpoint")}</h2>
                </header>
                <div className="quality-list">
                  {(stats.data?.endpoints || [])
                    .filter((e: Entity) => e.metrics.quality_denominator > 0)
                    .map((e: Entity) => (
                      <button
                        key={`${e.endpoint_id}:${e.version}`}
                        onClick={() =>
                          update({ endpoint_id: e.endpoint_id, tab: "calls" })
                        }
                      >
                        <span>
                          {e.name || t("未记录名称", "Name not recorded")}{" "}
                          <small>v{e.version}</small>
                        </span>
                        <b>
                          {ratio(
                            e.metrics.quality_numerator,
                            e.metrics.quality_denominator,
                          )}
                        </b>
                        <progress
                          max={e.metrics.quality_denominator}
                          value={e.metrics.quality_numerator}
                        />
                        <small>
                          {t("有效样本", "Evaluated samples")} ·{" "}
                          {e.metrics.quality_denominator}
                        </small>
                      </button>
                    ))}
                  {!(stats.data?.endpoints || []).some(
                    (e: Entity) => e.metrics.quality_denominator > 0,
                  ) && (
                    <Empty>
                      {t(
                        "该时段没有可评价的材料",
                        "No evaluated material in this window",
                      )}
                    </Empty>
                  )}
                </div>
              </Panel>
            </div>
            <Panel flush>
              <header className="panel-header">
                <h2>{t("接入点表现", "Endpoint performance")}</h2>
              </header>
              <div className="table-scroll">
                <DataTable>
                  <DataTable.Header>
                    {[
                      t("接入点", "Endpoint"),
                      t("版本", "Version"),
                      t("调用次数", "Calls"),
                      t("平均执行 / 排队", "Mean execution / queue"),
                      t("有效材料率", "Material quality"),
                    ].map((label) => (
                      <DataTable.Column key={label}>{label}</DataTable.Column>
                    ))}
                  </DataTable.Header>
                  <DataTable.Body>
                    {(stats.data?.endpoints || []).map((e: Entity) => (
                      <DataTable.Row key={e.endpoint_id + ":" + e.version}>
                        <DataTable.Cell>
                          <button
                            className="row-link"
                            onClick={() =>
                              update({
                                endpoint_id: e.endpoint_id,
                                tab: "calls",
                              })
                            }
                          >
                            {e.name || t("未记录名称", "Name not recorded")}
                          </button>
                        </DataTable.Cell>
                        <DataTable.Cell>{e.version}</DataTable.Cell>
                        <DataTable.Cell>{e.metrics.calls}</DataTable.Cell>
                        <DataTable.Cell>
                          {e.metrics.speed_samples
                            ? Math.round(
                                e.metrics.speed_ms / e.metrics.speed_samples,
                              )
                            : "—"}{" "}
                          /{" "}
                          {e.metrics.calls
                            ? Math.round(e.metrics.queue_ms / e.metrics.calls)
                            : "—"}{" "}
                          ms
                        </DataTable.Cell>
                        <DataTable.Cell>
                          {ratio(
                            e.metrics.quality_numerator,
                            e.metrics.quality_denominator,
                          )}
                        </DataTable.Cell>
                      </DataTable.Row>
                    ))}
                  </DataTable.Body>
                </DataTable>
              </div>
            </Panel>
          </>
        )}
      </ViewTabs>
    </>
  );
}
function Trend({
  series,
  metric,
  timezone,
  select,
  from,
  to,
}: {
  from: string;
  to: string;
  series: Entity[];
  metric: string;
  timezone: string;
  select: (from: string, to: string) => void;
}) {
  const { t } = useApp();
  const value = (b: Entity) =>
    metric === "quality"
      ? b.metrics.quality_denominator
        ? (100 * b.metrics.quality_numerator) / b.metrics.quality_denominator
        : null
      : metric === "latency"
        ? b.metrics.speed_samples
          ? b.metrics.speed_ms / b.metrics.speed_samples
          : null
        : b.metrics.calls;
  return (
    <TrendChart
      from={from}
      to={to}
      timezone={timezone}
      unit={metric === "quality" ? "%" : metric === "latency" ? " ms" : ""}
      series={[
        {
          id: metric,
          name:
            metric === "quality"
              ? t("有效材料率", "Material quality")
              : metric === "latency"
                ? t("平均执行耗时", "Mean execution")
                : t("调用次数", "Calls"),
          color: "var(--accent)",
        },
      ]}
      buckets={series.map((b) => ({
        from: b.from,
        to: b.to,
        values: [value(b)],
      }))}
      select={select}
    />
  );
}
