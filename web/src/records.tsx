import { ExecutionTabs } from "./execution-tabs";
import { ArchivedMaterials } from "./material-preview";
import { executionGroups, materialPages, preferredMaterialSpan, stageGroupKey, preferredStage, groupStatus } from "./trace-model";
import { WebMaterials } from "./web-materials";
import { LanguagePicker } from "./language-picker";
import { stageTiming, stageWindow } from "./trace-timing";
import {
  ArrowDownToLine,
  ArrowLeft,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Clock3,
  List,
  RefreshCw,
  Waypoints,
} from "lucide-react";
import {
  TraceHeading,
  TestReceipt,
  Snapshot,
  Recording,
} from "./trace-sections";
import { RequestParameters } from "./request-parameters";
import { SearchBox, TimeWindow } from "./filter-controls";
import {
  Operation,
  operationName,
  originName,
  requestTitle,
  resultPreview,
  timestamp,
} from "./request-display";
import { CallFacts, ProbeDetails } from "./call-details";
import { ViewTabs } from "./ui";
import { DataTable } from "./ui";
import { useEffect, useRef, useState } from "react";
import {
  Link,
  useNavigate,
  useLocation,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { useMutation, useQuery, useQueries } from "@tanstack/react-query";
import { api, write, collectPath, type Entity, type Envelope } from "./api";
import { useApp } from "./state";
import {
  Btn,
  Dialog,
  Empty,
  Facts,
  Field,
  Head,
  Notice,
  Panel,
  Select,
  Status,
  Sheet,
} from "./ui";
import { MarkdownView, Result } from "./search";
import { requestReport } from "./report";
import { StageData, useStageLabel, StagePresentation } from "./stages";
import { ExecutionOverview, CandidateSheet } from "./trace-details";
export function Records() {
  const { t, projects, pageHistory, language } = useApp();
  const [params, setParams] = useSearchParams();
  const [initialRange] = useState(() => ({
    from: new Date(Date.now() - 86400000).toISOString(),
    to: new Date().toISOString(),
  }));
  useEffect(() => {
    if (!params.has("from") && !params.has("cursor")) {
      const next = new URLSearchParams(params);
      for (const [k, v] of Object.entries(initialRange)) next.set(k, v);
      setParams(next, { replace: true });
    }
  }, []);
  const [searchText, setSearchText] = useState(params.get("q") || "");
  useEffect(() => setSearchText(params.get("q") || ""), [params.get("q")]);
  const compact = params.get("density") === "compact";
  const expanded = params.get("expanded");
  const display = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  const cursor = params.get("cursor") || "";
  const scope = new URLSearchParams(params);
  for (const key of ["cursor", "density", "expanded"]) scope.delete(key);
  const pagingKey = scope.toString();
  const previous = pageHistory.current[pagingKey] || [];
  const setCursor = (value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set("cursor", value);
    else next.delete("cursor");
    setParams(next);
  };
  const setPrevious = (value: string[]) => {
    pageHistory.current[pagingKey] = value;
  };
  const [retention, showRetention] = useState(false);
  const query = new URLSearchParams(scope);
  query.set("limit", "20");
  if (cursor) query.set("cursor", cursor);
  const list = useQuery({
    queryKey: ["requests", query.toString()],
    queryFn: () => api<Entity>("/admin/v1/requests?" + query),
    refetchInterval: 5000,
  });
  const totalsScope = new URLSearchParams(scope);
  totalsScope.delete("cursor");
  const totals = useQuery({
    queryKey: ["request-aggregates", totalsScope.toString()],
    queryFn: () => api<Entity>("/admin/v1/requests/aggregates?" + totalsScope),
    refetchInterval: 10000,
  });
  const range = {
    from: params.get("from") || initialRange.from,
    to: params.get("to") || initialRange.to,
  };
  const setWindow = (value: typeof range) => {
    const next = new URLSearchParams(params);
    next.set("from", value.from);
    next.set("to", value.to);
    next.delete("cursor");
    next.delete("expanded");
    const resetScope = new URLSearchParams(next);
    resetScope.delete("density");
    pageHistory.current[resetScope.toString()] = [];
    setParams(next);
  };
  const change = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete("cursor");
    next.delete("expanded");
    const resetScope = new URLSearchParams(next);
    resetScope.delete("density");
    pageHistory.current[resetScope.toString()] = [];
    setParams(next);
  };
  return (
    <>
      <Head
        title={t("请求记录", "Request records")}
        sub={
          timestamp(range.from, language) +
          " — " +
          timestamp(range.to, language)
        }
      >
        <Btn
          onPress={() => {
            const now = Date.now();
            setWindow({
              from: new Date(
                now - (Date.parse(range.to) - Date.parse(range.from)),
              ).toISOString(),
              to: new Date(now).toISOString(),
            });
          }}
        >
          <RefreshCw size={14} />
          {t("刷新", "Refresh")}
        </Btn>
        <TimeWindow range={range} change={setWindow} />
        <Btn onPress={() => showRetention(true)}>
          {t("全局保留设置", "Global retention")}
        </Btn>
      </Head>
      <div className="metrics record-metrics">
        {[
          {
            label: t("匹配记录", "Matching records"),
            value: totals.data?.requests,
            note: t("当前完整筛选窗口", "Across the filtered window"),
            Icon: List,
          },
          {
            label: t("业务请求", "Business requests"),
            value: totals.data?.business_requests,
            note:
              t("调试与测试", "Debug and tests") +
              " · " +
              (totals.data?.business_requests == null
                ? "—"
                : totals.data.requests - totals.data.business_requests),
            Icon: BookOpen,
          },
          {
            label: t("平均总耗时", "Mean duration"),
            value:
              totals.data?.average_duration_ms == null
                ? "—"
                : Math.round(totals.data.average_duration_ms) + " ms",
            note: t("含排队及执行时间", "Includes queue and execution"),
            Icon: Clock3,
          },
          {
            label: t("上游调用", "Upstream calls"),
            value: totals.data?.upstream_calls,
            note:
              t("其中模型", "Model calls") +
              " · " +
              (totals.data?.model_calls ?? "—"),
            Icon: Waypoints,
          },
        ].map(({ label, value, note, Icon }) => (
          <Panel key={label} className="metric">
            <small>
              <Icon size={15} />
              {label}
            </small>
            <strong>{value ?? "—"}</strong>
            <span className="metric-description">{note}</span>
          </Panel>
        ))}
      </div>
      <Panel className="filter-panel">
        <div className="filter-grid">
          <Select
            label={t("项目", "Project")}
            value={params.get("project_id") || ""}
            change={(v) => change("project_id", v)}
            options={[
              { value: "", label: t("全部项目", "All projects") },
              ...projects.map((p) => ({ value: p.id, label: p.name })),
            ]}
          />
          <Select
            label={t("操作", "Operation")}
            value={params.get("operation") || ""}
            change={(v) => change("operation", v)}
            options={["", "list", "content", "summary"].map((v) => ({
              value: v,
              label: v ? operationName(v, t) : t("全部操作", "All operations"),
            }))}
          />
          <Select
            label={t("状态", "Status")}
            value={params.get("status") || ""}
            change={(v) => change("status", v)}
            options={[
              "",
              "success",
              "partial",
              "empty",
              "error",
              "cancelled",
            ].map((v) => ({
              value: v,
              label:
                (
                  {
                    success: t("成功", "Success"),
                    partial: t("部分完成", "Partial"),
                    empty: t("无结果", "Empty"),
                    error: t("失败", "Failed"),
                    cancelled: t("已取消", "Cancelled"),
                  } as Record<string, string>
                )[v] || t("全部状态", "All statuses"),
            }))}
          />
          <Select
            label={t("来源", "Origin")}
            value={params.get("origin") || ""}
            change={(v) => change("origin", v)}
            options={[
              ["", t("全部来源", "All origins")],
              ["business", t("业务请求", "Business")],
              ["debug", t("调试", "Debug")],
              ["endpoint_test", t("接入点测试", "Endpoint test")],
              ["proxy_test", t("代理测试", "Proxy test")],
            ].map(([value, label]) => ({ value, label }))}
          />
          <LanguagePicker
            label={t("业务语言", "Business language")}
            value={params.get("language") || ""}
            change={(v) => change("language", v)}
            emptyLabel={t("全部语言", "All languages")}
          />
        </div>
        <form
          className="filter-search-row"
          onSubmit={(e) => {
            e.preventDefault();
            change("q", searchText.trim());
          }}
        >
          <SearchBox
            label={t("问题或请求 ID", "Query or request ID")}
            value={searchText}
            change={setSearchText}
          />
          <Btn type="submit">{t("查询", "Search")}</Btn>
          <Btn
            className="filter-clear"
            onPress={() => setParams(new URLSearchParams(range))}
          >
            {t("清除筛选", "Clear filters")}
          </Btn>
        </form>
      </Panel>
      <Notice error={list.error || totals.error} />

      <Panel flush className="record-panel">
        <header className="panel-header">
          <h2>{t("请求明细", "Request details")}</h2>
          <div
            className="segments"
            role="group"
            aria-label={t("列表密度", "List density")}
          >
            {[
              ["", t("摘要预览", "Preview")],
              ["compact", t("紧凑", "Compact")],
            ].map(([v, l]) => (
              <button
                key={v}
                data-active={compact === (v === "compact")}
                aria-pressed={compact === (v === "compact")}
                onClick={() => display("density", v)}
              >
                {l}
              </button>
            ))}
          </div>
        </header>
        <DataTable>
          <DataTable.Header>
            <DataTable.Column>
              {t("问题 / 网页", "Question / URL")}
            </DataTable.Column>
            {!compact && (
              <DataTable.Column>
                {t("结果摘要", "Result preview")}
              </DataTable.Column>
            )}
            <DataTable.Column>
              {t("项目 / 操作", "Project / operation")}
            </DataTable.Column>
            <DataTable.Column>{t("状态", "Status")}</DataTable.Column>
            <DataTable.Column>
              {t("开始时间 / 耗时", "Started / duration")}
            </DataTable.Column>
            <DataTable.Column>
              <span className="visually-hidden">
                {t("展开行摘要", "Expand row preview")}
              </span>
            </DataTable.Column>
          </DataTable.Header>
          <DataTable.Body>
            {(list.data?.items || []).map((r: Entity) => {
              const full = expanded === r.request_id,
                path = "/requests/" + r.request_id,
                title = requestTitle(r, t);
              return (
                <DataTable.Row key={r.request_id}>
                  <DataTable.Cell>
                    <Link
                      className="row-link request-summary record-open"
                      to={path}
                    >
                      {title}
                    </Link>
                    <small className="row-sub">
                      {originName(r.origin, t)} · <code>{r.request_id}</code>
                    </small>
                    {full && (
                      <div className="row-preview">
                        <b>
                          {operationName(r.operation, t)} · {r.duration_ms} ms
                        </b>
                        <p>{resultPreview(r, t)}</p>
                        <Link to={path} className="text-link">
                          {t("打开完整请求", "Open full request")} ↗
                        </Link>
                      </div>
                    )}
                  </DataTable.Cell>
                  {!compact && (
                    <DataTable.Cell>
                      <p
                        className={
                          "request-summary result-preview " +
                          (r.status === "error" ? "excerpt-error" : "")
                        }
                      >
                        {resultPreview(r, t)}
                      </p>
                    </DataTable.Cell>
                  )}
                  <DataTable.Cell>
                    {r.project_name || t("独立测试", "Standalone test")}
                    <small className="row-sub">
                      <Operation value={r.operation} />
                    </small>
                  </DataTable.Cell>
                  <DataTable.Cell>
                    <Status value={r.status} />
                    {r.incomplete && (
                      <small className="row-sub">
                        {t("载荷不全", "Incomplete")}
                      </small>
                    )}
                  </DataTable.Cell>
                  <DataTable.Cell>
                    {timestamp(r.started_at, language)}
                    <small className="row-sub mono">{r.duration_ms} ms</small>
                  </DataTable.Cell>
                  <DataTable.Cell>
                    <button
                      className="table-icon"
                      aria-label={
                        t("展开行摘要", "Expand row preview") + " · " + title
                      }
                      aria-expanded={full}
                      onClick={() =>
                        display("expanded", full ? "" : r.request_id)
                      }
                    >
                      {full ? (
                        <ChevronDown size={15} />
                      ) : (
                        <ChevronRight size={15} />
                      )}
                    </button>
                  </DataTable.Cell>
                </DataTable.Row>
              );
            })}
          </DataTable.Body>
        </DataTable>
        {!list.data?.items?.length && (
          <Empty>
            {list.isPending
              ? t("正在读取请求…", "Loading requests…")
              : t("当前筛选没有请求", "No requests match this filter")}
          </Empty>
        )}
        <footer className="diag-pagination">
          <span>
            {t("第", "Page ")}
            {previous.length + 1}
            {t(" 页", "")} · {list.data?.items.length ?? 0}{" "}
            {t("条记录", "records")}
          </span>
          <div>
            <Btn
              small
              disabled={!previous.length}
              onPress={() => {
                setCursor(previous[previous.length - 1]);
                setPrevious(previous.slice(0, -1));
              }}
            >
              {t("上一页", "Previous")}
            </Btn>
            <Btn
              small
              disabled={!list.data?.next_cursor}
              onPress={() => {
                setPrevious([...previous, cursor]);
                setCursor(list.data?.next_cursor || "");
              }}
            >
              {t("下一页", "Next")}
            </Btn>
          </div>
        </footer>
      </Panel>
      {retention && <Retention close={() => showRetention(false)} />}
    </>
  );
}
function Retention({ close }: { close: () => void }) {
  const { t, refresh } = useApp();
  const setting = useQuery({
    queryKey: ["retention"],
    queryFn: () => api<Entity>("/admin/v1/settings/retention"),
  });
  const [days, setDays] = useState("");
  const save = useMutation({
    mutationFn: () =>
      write(
        "/admin/v1/settings/retention",
        {
          retention_days: Number(days || setting.data?.retention_days),
          expected_version: setting.data?.version,
        },
        "PUT",
      ),
    onSuccess: () => {
      void refresh();
      close();
    },
  });
  return (
    <Dialog
      title={t("全局保留设置", "Global retention")}
      close={close}
      dirty={!!days}
      save={() => save.mutate()}
      busy={setting.isPending || save.isPending}
    >
      <p>
        {t(
          "新天数统一应用于所有项目的新记录。已有记录保留创建时的到期时间。",
          "Applies to new records in every project. Existing records retain their original expiry.",
        )}
      </p>
      <Field
        label={t("保留天数", "Retention days")}
        type="number"
        value={days || setting.data?.retention_days || 7}
        change={setDays}
      />
      <Notice error={setting.error || save.error} />
    </Dialog>
  );
}
export function Trace() {
  const stageLabel = useStageLabel();
  const location = useLocation();
  const workbench = useRef<HTMLDivElement>(null);
  const { id = "" } = useParams();
  const { t, language } = useApp();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") || "execution",
    stage = params.get("stage") || "";
  const update = (patch: Entity) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, String(v));
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };
  const setTab = (tab: string) =>
    update({
      tab,
      stage: "",
      call: "",
      call_kind: "",
      candidate: "",
      source: "",
      segment: "",
    });
  const setStage = (stage: string) => update({ stage });
  const detail = useQuery({
    queryKey: ["request", id],
    queryFn: () => api<Entity>("/admin/v1/requests/" + id),
    retry: false,
    refetchInterval: (q) =>
      q.state.error ||
      q.state.data?.incomplete_reasons?.some(
        (r: string) => r !== "diagnostics_pending",
      )
        ? false
        : !q.state.data?.response_payload ||
            q.state.data?.incomplete_reasons?.includes("diagnostics_pending")
          ? 250
          : false,
  });
  const calls = useQuery({
    queryKey: ["request-calls", id],
    queryFn: async () => ({
      items: await collectPath("/admin/v1/endpoint-calls?request_id=" + id),
    }),
    enabled:
      !!detail.data?.response_payload &&
      !detail.data.incomplete_reasons?.includes("diagnostics_pending"),
  });
  const evidence = useQuery({
    queryKey: ["evidence", id],
    queryFn: () => api<Entity>("/admin/v1/requests/" + id + "/evidence"),
    enabled:
      !!detail.data?.response_payload &&
      !detail.data.incomplete_reasons?.includes("diagnostics_pending"),
  });
  const spans: Entity[] = detail.data?.spans || [];
  const active = spans.find((s) => s.span_id === stage) || spans[0];
  const activeKey = stageGroupKey(active?.stage);
  const groups = executionGroups(spans);
  const span = useQuery({
    queryKey: ["span", id, active?.span_id],
    queryFn: () =>
      api<Entity>("/admin/v1/requests/" + id + "/spans/" + active?.span_id),
    enabled: tab === "execution" && !!active && activeKey !== "materials",
  });
  const sourceDetails = useQueries({
    queries: (activeKey === "materials" ? spans.filter(s => s.stage === "source") : []).map(item=>({
      queryKey:["span",id,item.span_id],
      queryFn:()=>api<Entity>("/admin/v1/requests/"+id+"/spans/"+item.span_id),
      enabled:tab==="execution",
    })),
  });
  const pages = materialPages(spans, calls.data?.items || [], evidence.data?.candidates || [], sourceDetails.flatMap(q => q.data ? [q.data] : []));
  const candidate = evidence.data?.candidates?.find((c: Entity) =>
    params.get("candidate")
      ? c.candidate_id === params.get("candidate")
      : !!params.get("source") && c.source_id === params.get("source"),
  );
  const openCandidate = (source: string, segment: string) => {
    const c = evidence.data?.candidates?.find(
      (c: Entity) => c.source_id === source,
    );
    if (c) update({ candidate: c.candidate_id, segment });
  };
  const data = detail.data,
    meta = data?.metadata;
  async function download() {
    const report = await api<Entity>("/admin/v1/requests/" + id + "/export");
    const markdown = requestReport(report, language);
    const object = URL.createObjectURL(
      new Blob([markdown], { type: "text/markdown" }),
    );
    const a = document.createElement("a");
    a.href = object;
    a.download = "request-" + id + ".md";
    a.click();
    URL.revokeObjectURL(object);
  }
  if (detail.isPending)
    return <Empty>{t("正在读取记录…", "Loading record…")}</Empty>;
  if (!data)
    return (
      <>
        <Notice error={detail.error} />
        <Btn onPress={() => nav("/requests")}>
          {t("返回请求列表", "Back to requests")}
        </Btn>
      </>
    );
  const isTest = meta.origin.endsWith("_test");
  const routeStage = (targetTab: string, key?: string, kind?: string) => {
    const target =
      (stageGroupKey(key || "") === "materials" && pages[0] ? preferredMaterialSpan(pages[0]) : preferredStage(groups.get(stageGroupKey(key || "")) || [])) ||
      (key === "dedup" ? groups.get("search")?.[0] : null);
    update({
      tab: targetTab,
      stage: target?.span_id,
      call_kind: kind,
      call: "",
      candidate: "",
      source: "",
      segment: "",
    });
    requestAnimationFrame(() =>
      workbench.current?.scrollIntoView({ block: "nearest" }),
    );
  };
  const receipt = data.response_payload;
  const related = (calls.data?.items || []).filter(
    (c: Entity) => c.span_id === active?.span_id,
  );
  const currentGroup = groups.get(activeKey) || [];
  const offset = currentGroup.length ? Math.min(...currentGroup.map(s => s.start_offset_ms || 0)) : 0,
    duration = stageWindow(currentGroup.map(s => ({start_offset_ms:s.start_offset_ms,duration_ms:s.duration_ms}))),
    total = meta.duration_ms;
  const timing = stageTiming(offset, duration, total);
  const executionItems = currentGroup.map(item=>{
    const call=calls.data?.items.find((c:Entity)=>c.span_id===item.span_id);
    let title=stageLabel(item.stage);
    if(call?.endpoint_name) {
      title=call.endpoint_name;
      if(call.browser_job?.search_engine) title+=" · "+(call.browser_job.search_engine==="baidu"?t("百度","Baidu"):"Google");
    }
    return {id:item.span_id,title,status:item.status,duration:item.duration_ms};
  });

  return (
    <div className="trace-dossier">
      <button
        className="back-diag"
        onClick={() => {
          if (location.key !== "default" && window.history.state?.idx > 0)
            nav(-1);
          else nav("/requests");
        }}
      >
        <ArrowLeft size={14} />
        {t("返回", "Back")}
      </button>
      <Head
        title={
          isTest ? originName(meta.origin, t) : operationName(meta.operation, t)
        }
        sub={[
          isTest
            ? t("功能测试", "Capability test")
            : "POST /v1/search/" + meta.operation,
          meta.project_name || (isTest ? t("独立测试", "Standalone test") : ""),
        ]
          .filter(Boolean)
          .join(" · ")}
      >
        <Btn onPress={() => void download()}>
          <ArrowDownToLine size={15} />
          {t("导出 Markdown", "Export Markdown")}
        </Btn>
      </Head>
      <Panel flush className="dossier-head">
        <TraceHeading
          key={id}
          data={data}
          variants={evidence.data?.variants || []}
          select={(variant) => {
            const match = evidence.data?.variants?.find(
              (v: Entity) => v.variant_id === variant,
            );
            const call = calls.data?.items?.find(
              (c: Entity) =>
                c.variant_id === variant ||
                c.search_variant_id === variant ||
                (match?.call_ids || []).includes(c.call_id),
            );
            update({
              tab: "execution",
              stage: call?.span_id || groups.get("search")?.[0]?.span_id,
            });
          }}
        />
        <ExecutionOverview data={data} jump={routeStage} />
      </Panel>
      {!!data.incomplete_reasons?.length && (
        <p className="diag-warning">
          {t("部分材料尚未就绪。", "Some materials are unavailable. ")}
          <button className="text-link" onClick={() => routeStage("recording")}>
            {t("查看记录信息", "View recording details")}
          </button>
        </p>
      )}
      <div ref={workbench}>
        <ViewTabs
          label={t("请求详情视图", "Request detail views")}
          value={tab}
          change={setTab}
          items={[
            ["execution", t("执行过程", "Execution")],
            ["evidence", t("请求与结果", "Request and result")],
            ["configuration", t("配置快照", "Configuration")],
            ["recording", t("记录信息", "Recording")],
            ["calls", t("接入点", "Endpoints")],
          ]}
        >
          {tab === "execution" ? (
            active ? (
              <Panel flush className="execution-board">
                <div className="stage-list">
                  <h3>{t("执行阶段", "Execution stages")}</h3>
                  {Array.from(groups, ([key, group]) => {
                    const selected = key === activeKey;
                    const elapsed = stageWindow(
                      group.map((s) => ({
                        start_offset_ms: s.start_offset_ms,
                        duration_ms: s.duration_ms,
                      })),
                    );
                    return (
                      <button
                        className={
                          "water-row step-pick " + (selected ? "chosen" : "")
                        }
                        aria-pressed={selected}
                        data-stage={key}
                        key={key}
                        onClick={() => setStage(key === "materials" && pages[0] ? preferredMaterialSpan(pages[0]).span_id : preferredStage(group).span_id)}
                      >
                        <i className={"stage-point " + groupStatus(key === "materials" ? pages : group)} />
                        <span className="step-label">
                          <b>{stageLabel(key)}</b>
                          {key === "materials" ? <span>{pages.length} {t("篇网页", "pages")}</span> : group.length > 1 && (
                            <span>
                              {group.length} {t("次执行", "executions")}
                            </span>
                          )}
                        </span>
                        <small>{elapsed} ms</small>
                      </button>
                    );
                  })}
                </div>
                <section
                  className="stage-inspect"
                  aria-label={t("阶段详情", "Stage details")}
                >
                  <div className="stage-heading">
                    <h2>{stageLabel(activeKey)}</h2>
                    <span>
                      {offset}–{offset + duration} ms
                    </span>
                    <Status value={groupStatus(activeKey === "materials" ? pages : currentGroup)} />
                  </div>
                  <div className="stage-duration" aria-hidden="true">
                    <i
                      style={{
                        left: timing.left + "%",
                        width: timing.width + "%",
                      }}
                    />
                  </div>
                  {activeKey === "materials" ? <WebMaterials requestId={id} pages={pages} activeSpanId={active.span_id}
                    calls={calls.data?.items || []} record={data} evidence={evidence.data || {}} select={setStage}
                    openCandidate={candidate => update({candidate})} openCall={call => update({tab:"calls",call,call_kind:""})}/> : <ExecutionTabs items={executionItems} value={active.span_id} change={setStage}>
                  <Notice error={span.error} />
                  {span.isLoading && (
                    <Empty>
                      {t("读取阶段材料…", "Loading stage materials…")}
                    </Empty>
                  )}
                  {span.data && (
                    <>
                      {span.data.diagnostics?.probe && (
                        <ProbeDetails value={span.data.diagnostics.probe} />
                      )}
                      <StagePresentation
                        record={data}
                        span={span.data}
                        evidence={evidence.data || {}}
                        openCandidate={(candidate) => update({ candidate })}
                      />
                      <ArchivedMaterials requestId={id} materials={(span.data.replay || []).map((m:Entity)=>({
                        ...m,title:(evidence.data?.candidates||[]).find((c:Entity)=>
                          c.url===m.url || (m.source_id && c.source_id===m.source_id))?.title || m.title,
                      }))}/>

                    </>
                  )}
                  {related.length > 0 && (
                    <div className="stage-endpoints">
                      {related.map((c: Entity) => (
                        <button
                          className="text-link"
                          key={c.call_id}
                          onClick={() =>
                            update({
                              tab: "calls",
                              call: c.call_id,
                              call_kind: "",
                            })
                          }
                        >
                          {c.endpoint_name} · {c.execution_ms} ms ↗
                        </button>
                      ))}
                    </div>
                  )}
                  </ExecutionTabs>}
                </section>
              </Panel>
            ) : (
              <Panel>
                <Empty>{t("暂无阶段记录", "No stages recorded")}</Empty>
              </Panel>
            )
          ) : tab === "calls" ? (
            <>
              <div
                className="segments call-kinds"
                role="group"
                aria-label={t("调用能力", "Call capability")}
              >
                {[
                  ["", t("全部", "All")],
                  ["search", t("搜索", "Search")],
                  ["reader", t("正文", "Reader")],
                  ["model", t("模型", "Model")],
                ].map(([v, label]) => (
                  <button
                    key={v}
                    data-active={(params.get("call_kind") || "") === v}
                    onClick={() => update({ call_kind: v, call: "" })}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <Notice error={calls.error} />
              <CallTable
                calls={(calls.data?.items || []).filter(
                  (c: Entity) =>
                    !params.get("call_kind") ||
                    params.get("call_kind") === c.kind,
                )}
              />
            </>
          ) : tab === "configuration" ? (
            <Snapshot data={data} />
          ) : tab === "recording" ? (
            <Recording data={data} />
          ) : (
            <Panel className="trace-response">
              {isTest ? (
                <TestReceipt data={data} />
              ) : (
                <>
                  <h2>{t("请求与结果", "Request and result")}</h2>
                  <details className="read-request-input">
                    <summary>{t("本次请求参数", "Request parameters")}</summary>
                    <RequestParameters
                      op={meta.operation}
                      input={data.request_payload || {}}
                      project={data.snapshot?.project}
                    />
                  </details>
                  {receipt ? (
                    <Result result={receipt} onCitation={openCandidate} />
                  ) : (
                    <Empty>
                      {t("本次响应尚不可用", "Response unavailable")}
                    </Empty>
                  )}
                  <Notice error={evidence.error} />
                  {!!evidence.data?.candidates?.length && (
                    <details className="read-request-input">
                      <summary>
                        {t("候选与引用", "Candidates and citations")} ·{" "}
                        {evidence.data.candidates.length}
                      </summary>
                      {evidence.data.candidates.map((c: Entity) => (
                        <button
                          className="candidate-row"
                          key={c.candidate_id}
                          onClick={() =>
                            update({ candidate: c.candidate_id, segment: "" })
                          }
                        >
                          <span>
                            <strong>{c.title || c.url}</strong>
                            <small>{c.url}</small>
                            <p>{c.snippet_preview}</p>
                          </span>
                          <span>
                            {c.score == null
                              ? t("未评分", "Unscored")
                              : `${c.score} / 100`}
                            <small>
                              {c.selected
                                ? t("已选中", "Selected")
                                : t("未选中", "Not selected")}
                            </small>
                          </span>
                        </button>
                      ))}
                    </details>
                  )}
                </>
              )}
            </Panel>
          )}
        </ViewTabs>
      </div>
      {candidate && (
        <CandidateSheet
          key={candidate.candidate_id}
          requestId={id}
          candidate={candidate}
          evidence={evidence.data || {}}
          calls={calls.data?.items || []}
          segmentId={params.get("segment") || ""}
          close={() => update({ candidate: "", source: "", segment: "" })}
          selectSegment={(segment) => update({ segment })}
        />
      )}

    </div>
  );
}
export function CallTable({ calls }: { calls: Entity[] }) {
  const { t, resourceName } = useApp();
  const stageName = useStageLabel();
  const [params, setParams] = useSearchParams();
  const selected = calls.find((call) => call.call_id === params.get("call"));
  const setSelected = (call: Entity | null) => {
    const next = new URLSearchParams(params);
    if (call) next.set("call", call.call_id);
    else next.delete("call");
    setParams(next, { replace: true });
  };
  return (
    <>
      <Panel flush>
        <div className="table-scroll">
          <DataTable>
            <DataTable.Header>
              <DataTable.Column>{t("接入点", "Endpoint")}</DataTable.Column>
              <DataTable.Column>{t("输入", "Input")}</DataTable.Column>
              <DataTable.Column>{t("阶段", "Stage")}</DataTable.Column>
              <DataTable.Column>{t("状态", "Status")}</DataTable.Column>
              <DataTable.Column>
                {t("执行 / 排队", "Executing / queued")}
              </DataTable.Column>
            </DataTable.Header>
            <DataTable.Body>
              {calls.map((c) => (
                <DataTable.Row key={c.call_id}>
                  <DataTable.Cell>
                    <button className="row-link" onClick={() => setSelected(c)}>
                      {resourceName(c)}
                    </button>
                  </DataTable.Cell>
                  <DataTable.Cell>{c.input_preview || "—"}</DataTable.Cell>
                  <DataTable.Cell>
                    {stageName(c.stage) || operationName(c.operation, t)}
                  </DataTable.Cell>
                  <DataTable.Cell>
                    <Status value={c.status} />
                  </DataTable.Cell>
                  <DataTable.Cell>
                    {c.execution_ms} / {c.queue_ms} ms
                  </DataTable.Cell>
                </DataTable.Row>
              ))}
            </DataTable.Body>
          </DataTable>
        </div>
        {!calls.length && (
          <Empty>{t("没有符合条件的调用", "No matching calls")}</Empty>
        )}
      </Panel>
      {selected && (
        <Sheet
          title={t("调用详情", "Call detail")}
          close={() => setSelected(null)}
        >
          <CallFacts call={selected} />
          <Link to={"/requests/" + selected.request_id}>
            {t("查看所属请求", "Open request")}
          </Link>
        </Sheet>
      )}
    </>
  );
}
