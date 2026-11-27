import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams, Link } from "react-router-dom";
import { Database, List, RefreshCw, Settings2 } from "lucide-react";
import { api, type Entity } from "./api";
import { useApp } from "./state";
import { Btn, DataTable, Empty, Facts, Head, Notice, Panel, Select, Sheet, ViewTabs } from "./ui";
import { TimeWindow } from "./filter-controls";
import { OverflowText } from "./overflow-text";
import { CacheSettings } from "./cache-settings";

export function CacheManagement() {
  const { t, projects, language } = useApp();
  const [params, setParams] = useSearchParams();
  const [settings, setSettings] = useState<"concurrency" | "policy" | "model-budgets" | null>(null);
  const update = (patch: Entity) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(patch)) { if (value != null && value !== "") next.set(key, String(value)); else next.delete(key); }
    if (!("cursor" in patch)) next.delete("cursor");
    if (!("task" in patch)) next.delete("task");
    setParams(next);
  };
  const tab = params.get("tab") || "overview";
  const from = params.get("from"), to = params.get("to");
  const fixed = !!from && !!to && Number.isFinite(Date.parse(from)) && Date.parse(from) < Date.parse(to);
  const requestedHours = Number(params.get("hours"));
  const hours = [1, 24, 168].includes(requestedHours) ? requestedHours : 24;
  const rangeAt = (at: number) => fixed ? { from: from!, to: to! } : {
    from: new Date(at - hours * 3600000).toISOString(), to: new Date(at).toISOString(),
  };
  const scope = new URLSearchParams(params);
  for (const key of ["tab", "task", "cursor", "from", "to", "hours"]) scope.delete(key);
  const windowKey = fixed ? [from, to] : ["rolling", hours];
  // Use a stable query key. Resolve the bounds on every poll or manual refresh.
  const withWindow = (filters: URLSearchParams) => {
    const range = rangeAt(Date.now());
    const query = new URLSearchParams(filters);
    query.set("since", String(Date.parse(range.from))); query.set("until", String(Date.parse(range.to)));
    return query.toString();
  };
  const overview = useQuery({ queryKey: ["cache-overview", scope.toString(), ...windowKey], queryFn: () => api<Entity>("/admin/v1/cache/overview?" + withWindow(scope)), refetchInterval: 5000 });
  const taskQuery = new URLSearchParams(scope); taskQuery.set("limit", "25");
  if (params.get("cursor")) taskQuery.set("cursor", params.get("cursor")!);
  const tasks = useQuery({ queryKey: ["cache-tasks", taskQuery.toString(), ...windowKey], queryFn: () => api<Entity>("/admin/v1/cache/tasks?" + withWindow(taskQuery)), enabled: tab === "tasks", refetchInterval: 5000 });
  const detail = useQuery({ queryKey: ["cache-task", params.get("task")], queryFn: () => api<Entity>("/admin/v1/cache/tasks/" + encodeURIComponent(params.get("task")!)), enabled: !!params.get("task"), refetchInterval: 3000 });
  const data = overview.data;
  const ratio = (value?: Entity) => value?.total ? `${(100 * value.hits / value.total).toFixed(1)}%` : "—";
  const number = (value?: number) => value == null ? "—" : value.toLocaleString(language === "zh" ? "zh-CN" : "en-US");
  const duration = (value?: number) => value == null ? "—" : `${(value / 1000).toFixed(1)}s`;
  const states: Record<string, [string, string]> = {
    waiting: ["待领取", "Waiting"], retry: ["退避等待", "Backoff"], running: ["执行中", "Running"], completed: ["已发布 / 已满足", "Published / satisfied"],
    not_admitted: ["已处理未准入", "Not admitted"], failed: ["最终失败", "Failed"], expired: ["任务到期", "Expired"], evicted: ["队满淘汰", "Queue eviction"], ignored: ["已停止 / 已忽略", "Stopped / ignored"],
  };
  const kinds: Record<string, [string, string]> = { list: ["列表搜索", "List search"], content: ["正文补齐", "Page fetch"], summary: ["页级简介", "Page summary"], index: ["索引发布", "Index publishing"], publish_page: ["正文发布", "Page publishing"] };
  const reasons: Record<string, [string, string]> = {
    similar_single_hit: ["相似问题单命中", "Similar question hit"], selected_page: ["选中页面缺文", "Selected page missing content"], selected_summary: ["选中页面缺简介", "Selected page missing summary"],
    acquired: ["已取材料入库", "Acquired material"], foreground_failed: ["前台失败补齐", "Foreground failure"], hot_expiry: ["热点到期", "Hot cache expiry"],
  };
  const label = (task: Entity) => task.input?.query?.text || task.input?.url || task.input?.page?.url || (kinds[task.kind] ? t(...kinds[task.kind]) : task.kind);
  const gotoTasks = (state = "") => update({ tab: "tasks", state });
  const browser = data?.browser;
  const filters = <Panel className="filter-panel"><div className="filter-grid cache-filter-grid">
    <Select label={t("项目", "Project")} value={params.get("project") || ""} change={project => update({ project })}
      options={[{ value: "", label: t("全部项目", "All projects") }, ...projects.map((p: Entity) => ({ value: p.id, label: p.name + (p.cache_enabled ? "" : t(" · 缓存关闭", " · Cache off")) }))]} />
    <Select label={t("触发来源", "Origin")} value={params.get("origin") || ""} change={origin => update({ origin })}
      options={[["", t("全部来源", "All origins")], ["business", t("业务请求", "Business")], ["debug", t("项目调试", "Project debug")], ["endpoint_test", t("能力测试", "Capability test")], ["cache_background", t("后台维护", "Background maintenance")], ["system", t("系统定时", "Scheduled")]].map(([value, label]) => ({ value, label }))} />
    <Select label={t("业务操作", "Operation")} value={params.get("operation") || ""} change={operation => update({ operation })}
      options={[["", t("全部操作", "All operations")], ["list", t("列表", "List")], ["content", t("正文", "Content")], ["summary", t("综合", "Summary")]].map(([value, label]) => ({ value, label }))} />
    <div className="field"><span className="label">{t("时间范围", "Time range")}</span>
      <TimeWindow range={rangeAt(Date.now())} presetHours={fixed ? null : hours}
        change={(range, preset) => update(preset ? { hours: preset, from: "", to: "" } : { ...range, hours: "" })} />
    </div>
  </div></Panel>;
  return <>
    <Head title={t("缓存管理", "Cache management")} sub={t("查看缓存库存、命中情况和后台消费。项目启停在项目编辑界面设置。", "Inspect cache inventory, hits and background work. Enable caching in the project editor.")}>
      <Btn onPress={() => { void overview.refetch(); if (tab === "tasks") void tasks.refetch(); }}><RefreshCw size={16} />{t("刷新", "Refresh")}</Btn>
      <Btn onPress={() => setSettings("concurrency")}><Settings2 size={16} />{t("调整后台并发", "Background concurrency")}</Btn>
    </Head>
    <ViewTabs value={tab} change={value => update({ tab: value })} label={t("缓存视图", "Cache views")}
      items={[["overview", <><Database size={15} />{t("概览", "Overview")}</>], ["tasks", <><List size={15} />{t("任务明细", "Tasks")}</>]]}>
      {filters}<Notice error={overview.error || (tab === "tasks" ? tasks.error : null)} />
      {tab === "overview" ? <>
        {overview.isPending && <Empty>{t("正在读取缓存状态…", "Loading cache status…")}</Empty>}
        {data && <>
          <div className="metrics record-metrics">{[
            [t("有效问题", "Usable questions"), number(data.inventory.questions), t("当前项目范围", "Current project scope")],
            [t("有效快照", "Usable snapshots"), number(data.inventory.snapshots), t("保留各查询原始榜单", "Original query snapshots")],
            [t("有效正文", "Usable pages"), number(data.inventory.pages), `${number(data.inventory.summaries)} ${t("份就绪简介", "ready summaries")}`],
            [t("列表命中率", "List hit rate"), ratio(data.list), `${number(data.list.hits)} / ${number(data.list.total)}`],
            [t("正文命中率", "Content hit rate"), ratio(data.content), `${number(data.content?.hits)} / ${number(data.content?.total)}`],
            [t("任务消费速度", "Task throughput"), `${Number(data.traffic.per_minute).toFixed(1)}/min`, t("实际处理后终结的任务", "Tasks completed by processing")],
          ].map(([title, value, note]) => <Panel className="metric" key={title}><small>{title}</small><strong>{value}</strong><span className="metric-description">{note}</span></Panel>)}</div>
          <Panel><h2>{t("后台消费", "Background consumption")}</h2>
            <Facts items={[[t("全局浏览器占用 / 生效上限", "Global browser active / limit"), `${browser.background_active} / ${browser.effective_limit}`],
              [t("已保存后台并发", "Saved concurrency"), browser.configured_limit], [t("就绪标签", "Ready tabs"), browser.ready_tabs],
              [t("前台标签占用", "Foreground tabs"), browser.foreground_active], [t("等待队列 / 容量", "Waiting / capacity"), `${data.queue.waiting} / ${data.queue.capacity}`],
              [t("最老等待", "Oldest wait"), duration(data.queue.oldest_ms)], [t("等待 P95", "Wait P95"), duration(data.queue.p95_ms)],
              [t("实际尝试", "Actual attempts"), data.traffic.attempts], [t("队满淘汰", "Queue evictions"), data.traffic.evicted], [t("停止或忽略", "Stopped or ignored"), data.traffic.ignored]]} />
            <div className="form-actions">{["waiting", "running", "retry", "failed", "evicted", "ignored"].map(state => <Btn key={state} small onPress={() => gotoTasks(state)}>{t(...states[state])} {number(data.states[state] || 0)}</Btn>)}</div>
            {browser.capacity_insufficient && <p className="field-help">{t("就绪标签不足，后台暂不派发；已保存并发保持不变。", "Not enough ready tabs. Background dispatch is paused and the saved limit is retained.")}</p>}
          </Panel>
          <Panel><h2>{t("缓存诊断与设置", "Diagnostics and settings")}</h2>
            <Facts items={[[t("活动策略", "Active handler"), data.binding.handler], [t("统一向量服务", "Embedding service"), data.embedding.configured ? t("已配置", "Configured") : t("未配置，使用项目路由", "Unconfigured; project routing is used")],
              ...(data.matcher ? [[t("复用判断器", "Cache reuse matcher"), data.matcher.configured ? data.matcher.profile : t("未配置，仅可精确复用", "Unconfigured, exact reuse only") ] as [string, string]] : []),
              [t("索引回填", "Index backfill"), data.embedding.ready ? t("已就绪", "Ready") : t("准备中，允许精确降级", "Preparing; exact fallback is allowed")],
              [t("正文对象存储", "Content object store"), data.objects.configured ? t("已配置", "Configured") : t("未配置", "Unconfigured")],
              [t("精确降级交付", "Exact fallback hits"), data.outcomes["lookup:degraded_exact"] || 0], [t("检索故障旁路", "Lookup bypasses"), data.outcomes["lookup:bypass"] || 0],
              [t("项目缓存未开启", "Project cache disabled"), data.outcomes["lookup:disabled"] || 0],
              [t("全量名册", "Logical registry"), number(data.hotness.registry)], [t("累计热点 / 近期热点", "All-time / recent hot"), `${number(data.hotness.total_hot)} / ${number(data.hotness.recent_hot)}`],
              [t("正文占用 / 配额", "Content bytes / quota"), `${number(data.storage.object_bytes)} / ${number(data.storage.max_object_bytes)}`],
              [t("缓存写入", "Cache writes"), data.storage.write_paused ? t("容量受限", "Capacity limited") : t("允许", "Allowed")],
              [t("容量采样时间", "Capacity sampled"), data.storage.as_of ? new Date(data.storage.as_of).toLocaleString(language === "zh" ? "zh-CN" : "en-US") : t("尚未采样", "Not sampled")]]} />
            <div className="form-actions"><Btn onPress={() => setSettings("policy")}>{t("系统热点策略", "Default hotness policy")}</Btn><Btn onPress={() => setSettings("model-budgets")}>{t("后台模型预算", "Background model budget")}</Btn><Link to="/projects">{t("编辑项目缓存设置", "Edit project cache settings")}</Link></div>
            <p className="field-help">{t("库存取当前状态；时间及来源筛选影响请求和消费统计。命中率仅统计已可靠记录的样本，缺失记录不填零。", "Inventory reflects current state; time and origin filters apply to traffic. Hit rates use recorded samples; missing records are not filled with zero.")}</p>
          </Panel>
        </>}
      </> : <>
        <Panel><div className="filter-grid">
          <Select label={t("任务状态", "Task state")} value={params.get("state") || ""} change={state => update({ state })} options={[{ value: "", label: t("全部状态", "All states") }, ...Object.entries(states).map(([value, name]) => ({ value, label: t(...name) }))]} />
          <Select label={t("任务类型", "Task kind")} value={params.get("kind") || ""} change={kind => update({ kind })} options={[{ value: "", label: t("全部类型", "All kinds") }, ...Object.entries(kinds).map(([value, name]) => ({ value, label: t(...name) }))]} />
        </div></Panel>
        {tasks.isPending ? <Empty>{t("正在读取任务…", "Loading tasks…")}</Empty> : tasks.data && <Panel flush><DataTable>
          <DataTable.Header>{[t("问题或页面", "Question or page"), t("项目", "Project"), t("类型与原因", "Kind and reason"), t("状态", "State"), t("尝试 / 合并", "Attempts / merged"), t("入队时间", "Enqueued")].map(name => <DataTable.Column key={name}>{name}</DataTable.Column>)}</DataTable.Header>
          <DataTable.Body renderEmptyState={() => <Empty>{t("当前条件下没有缓存任务", "No cache tasks match these filters")}</Empty>}>
            {tasks.data.items.map((row: Entity) => <DataTable.Row key={row.id} id={row.id}>
              <DataTable.Cell><Btn small className="quiet" onPress={() => update({ task: row.id })}><OverflowText>{label(row)}</OverflowText></Btn></DataTable.Cell>
              <DataTable.Cell>{row.project_name || t("管理员测试", "Administrator test")}</DataTable.Cell>
              <DataTable.Cell>{kinds[row.kind] ? t(...kinds[row.kind]) : row.kind}<small>{reasons[row.reason] ? t(...reasons[row.reason]) : row.reason}</small></DataTable.Cell>
              <DataTable.Cell>{states[row.state] ? t(...states[row.state]) : row.state}</DataTable.Cell>
              <DataTable.Cell>{row.attempts} / {row.merged}</DataTable.Cell>
              <DataTable.Cell>{new Date(row.created_at).toLocaleString(language === "zh" ? "zh-CN" : "en-US")}</DataTable.Cell>
            </DataTable.Row>)}
          </DataTable.Body></DataTable><div className="form-actions">
            {params.get("cursor") && <Btn onPress={() => update({ cursor: "" })}>{t("返回最新", "Latest tasks")}</Btn>}
            {tasks.data.next_cursor && <Btn onPress={() => update({ cursor: tasks.data.next_cursor })}>{t("下一页", "Next page")}</Btn>}
          </div></Panel>}
      </>}
    </ViewTabs>
    {params.get("task") && <Sheet title={t("缓存任务详情", "Cache task details")} close={() => update({ task: "" })}>
      <Notice error={detail.error} />{detail.isPending ? <Empty>{t("正在读取详情…", "Loading details…")}</Empty> : detail.data && <>
        <h3><OverflowText>{label(detail.data)}</OverflowText></h3>
        <Facts items={[[t("状态", "State"), states[detail.data.state] ? t(...states[detail.data.state]) : detail.data.state], [t("停止或失败原因", "Stop or failure reason"), detail.data.last_error || "—"],
          [t("Handler 版本", "Handler version"), detail.data.handler_version], [t("启用代次", "Activation"), detail.data.activation_id], [t("项目开关代次", "Project cache epoch"), detail.data.project_cache_epoch],
          [t("载荷版本", "Payload version"), detail.data.payload_version], [t("已用尝试 / 总次数", "Attempts used / limit"), `${detail.data.attempts} / ${detail.data.attempt_limit}`], [t("合并需求", "Merged demands"), detail.data.merged],
          [t("任务截止", "Deadline"), new Date(detail.data.deadline).toLocaleString()], [t("下次可执行", "Available after"), new Date(detail.data.available_at).toLocaleString()]]} />
        {/^[0-9a-f-]{36}$/.test(detail.data.parent) && <Link to={"/requests/" + detail.data.parent}>{t("查看关联请求", "View parent request")}</Link>}
        {detail.data.execution_request && <Link to={"/requests/" + detail.data.execution_request}>{t("查看本轮执行记录", "View this execution")}</Link>}
        <h3>{t("执行阶段与配置", "Execution phases and configuration")}</h3><pre className="json-preview">{JSON.stringify(detail.data.phases, null, 2)}</pre>
      </>}
    </Sheet>}
    {settings && <CacheSettings section={settings} close={() => setSettings(null)} />}
  </>;
}
