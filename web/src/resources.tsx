import { OverflowText } from "./overflow-text";
import { languageOptions } from "./search-languages";
import { ResourceInventory } from "./resource-inventory";
import { CopyButton } from "./copy-button";
import { LanguagePicker } from "./language-picker";
import { SearchBox } from "./filter-controls";
import { ProbeDetails, SearchAttempts } from "./call-details";
import { DataTable, Segments } from "./ui";
import { Checkbox, Description, Label, Switch } from "@heroui/react";
import { useEffect, useState, useRef, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Plus,
  History,
  FileText,
  FlaskConical,
  ArrowUp,
  ArrowDown,
  X,
  Folder,
  Network,
  Waypoints,
  Pencil,
} from "lucide-react";
import { api, write, type Entity } from "./api";
import { useApp } from "./state";
import {
  Btn,
  Confirm,
  Dialog,
  Empty,
  Facts,
  Field,
  Head,
  Notice,
  Panel,
  Select,
  Status,
} from "./ui";
const providers: Record<string, string[]> = {
  search: ["tavily", "searxng", "anysearch", "deepseek"],
  reader: ["tavily", "anysearch", "crawl4ai", "deepseek"],
  model: ["openai_compatible"],
};
function endpointDefault(kind: string, provider: string): Entity {
  return {
    name: "",
    kind,
    provider,
    adapter:
      kind === "search"
        ? "http_search"
        : kind === "reader"
          ? "http_reader"
          : "chat_model",
    base_url:
      (
        {
          tavily: "https://api.tavily.com",
          anysearch: "https://api.anysearch.com",
          deepseek: "https://api.deepseek.com",
          openai_compatible: "https://api.openai.com/v1",
        } as Entity
      )[provider] || "",
    timeout_ms: kind === "model" ? 15000 : 8000,
    max_concurrency: 4,
    rpm: 60,
    options:
      kind === "model"
        ? {
            model: "",
            tokenizer: "cl100k_base",
            max_input_tokens: 8192,
            max_output_tokens: 2048,
          }
        : kind === "search"
          ? {}
          : { format: "markdown" },
  };
}
function defaults(kind: string): Entity {
  if (kind === "projects")
    return {
      name: "",
      search_pools: [],
      reader_pools: [],
      model_endpoint_id: null,
      browser_proxy_pool_id: null,
      search_limit: 10,
      source_limit: 4,
      body_limit: 40000,
      summary_limit: 1200,
      rewrite_count: 1,
      search_original_query: true,
      summary_snippets_only: false,
      allow_snippets: false,
    };
  if (kind === "proxies")
    return {
      name: "",
      scheme: "socks5",
      host: "",
      port: 1080,
      auth_mode: "none",
      max_concurrency: 4,
      enabled: true,
    };
  return { name: "", members: [] };
}
export function Resources({ kind }: { kind: string }) {
  const { t, resources, refresh, queryClient, setProject, name } = useApp();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState(""),
    [category, setCategory] = useState("search"),
    [page, setPage] = useState(0);
  const [editor, edit] = useState<Entity | null>(null),
    [key, setKey] = useState("");
  const detail =
    (resources.data?.[kind] || []).find(
      (e) => e.id === params.get("resource"),
    ) || null;
  const show = (entity: Entity | null) => {
    const next = new URLSearchParams(params);
    if (entity) next.set("resource", entity.id);
    else next.delete("resource");
    setParams(next, { replace: true });
  };
  const [components, showComponents] = useState(false);
  const [receipt, setReceipt] = useState<Entity | null>(null);
  const testScope = kind === "endpoints" ? kind + ":" + category : kind;
  const scopeRef = useRef(testScope);
  scopeRef.current = testScope;
  useEffect(() => {
    setReceipt(null);
    test.reset();
  }, [testScope]);

  const [rotateTarget, setRotateTarget] = useState<Entity | null>(null);
  const [testing, setTesting] = useState("");
  const testRequest = useRef("");
  useEffect(
    () => () => {
      if (testRequest.current)
        void write(
          "/admin/v1/requests/" + testRequest.current + "/cancel",
          {},
        ).catch(() => {});
    },
    [],
  );
  const ResourceIcon =
    kind === "projects" ? Folder : kind === "endpoints" ? Waypoints : Network;
  const create = () =>
    edit(
      kind === "endpoints"
        ? endpointDefault(category, providers[category][0])
        : defaults(kind),
    );
  const rows = (resources.data?.[kind] || []).filter(
    (e) =>
      (kind !== "endpoints" || e.kind === category) &&
      e.name.toLowerCase().includes(query.toLowerCase()),
  );
  const title =
    kind === "projects"
      ? t("项目", "Projects")
      : kind === "endpoints"
        ? t("接入点", "Endpoints")
        : kind === "proxies"
          ? t("VPN 代理", "VPN proxies")
          : t("代理池", "Proxy pools");
  const test = useMutation({
    mutationFn: (id: string) => {
      setTesting(id);
      const request = crypto.randomUUID();
      testRequest.current = request;
      const scope = scopeRef.current;
      return api("/admin/v1/" + kind + "/" + id + "/test", {
        method: "POST",
        body: "{}",
        headers: { "X-Request-ID": request },
      }).then(receipt=>({receipt,scope}));
    },
    onSettled: () => {
      setTesting("");
      testRequest.current = "";
    },
    onSuccess: ({receipt,scope}) => {
      if(scopeRef.current===scope) setReceipt({...receipt,scope});
      void refresh();
    },
  });
  const rotate = useMutation({
    mutationFn: (entity: Entity) =>
      write("/admin/v1/projects/" + entity.id + "/key", {
        expected_version: entity.version,
      }),
    onSuccess: (r) => {
      setKey(r.api_key);
      setRotateTarget(null);
      show(null);
      void refresh();
    },
  });
  if (resources.isPending)
    return <Empty>{t("正在读取资源…", "Loading resources…")}</Empty>;
  return (
    <>
      <Head
        title={title}
        sub={t(
          "配置能力、容量与项目引用。",
          "Configure capabilities, capacity and project bindings.",
        )}
      >
        {kind === "endpoints" && (
          <>
            <Btn onPress={() => nav("/language-routes")}>
              {t("语言路由", "Language routes")}
            </Btn>
            <Btn onPress={() => showComponents(true)}>
              {t("组件状态", "Components")}
            </Btn>
          </>
        )}
        <Btn primary onPress={create}>
          <Plus size={16} />
          {t("新建", "Create")}
        </Btn>
      </Head>
      {components && (
        <Dialog
          title={t("组件状态", "Components")}
          close={() => showComponents(false)}
        >
          <Facts
            items={(resources.data?.endpoints || [])
              .filter((e) => ["helm", "system"].includes(e.managed_by))
              .map((e) => [
                e.name,
                <>
                  <Status value={e.availability} />
                  {e.ready_pods != null && " · " + e.ready_pods + " Pods"}
                </>,
              ])}
          />
        </Dialog>
      )}
      <div className="toolbar resource-toolbar">
        {(kind === "proxies" || kind === "proxy-pools") && (
          <Segments
            label={t("代理配置", "Proxy configuration")}
            value={kind}
            change={(v) => nav("/" + v)}
            items={[
              [
                "proxies",
                t("VPN 代理", "VPN proxies") +
                  " · " +
                  (resources.data?.proxies?.length || 0),
              ],
              [
                "proxy-pools",
                t("代理池", "Proxy pools") +
                  " · " +
                  (resources.data?.["proxy-pools"]?.length || 0),
              ],
            ]}
          />
        )}
        {kind === "endpoints" && (
          <Segments
            label={t("接入点类型", "Endpoint type")}
            value={category}
            change={(v) => {
              setCategory(v);
              setPage(0);
              setQuery("");
            }}
            items={[
              ["search", t("搜索", "Search")],
              ["reader", t("正文", "Reader")],
              ["model", t("模型", "Model")],
            ]}
          />
        )}
        <SearchBox
          label={t("按名称查找", "Find by name")}
          value={query}
          change={(v) => {
            setQuery(v);
            setPage(0);
          }}
        />
        <span>
          {rows.length} {t("项", "items")}
        </span>
      </div>
      <Notice error={resources.error || (scopeRef.current === testScope ? test.error : null) || rotate.error} />
      {receipt?.scope === testScope && (
        <Panel className="test-receipt">
          <Status
            value={
              receipt.reason === "CANCELLED" ? "cancelled" : receipt.status
            }
          />
          <span>{receipt.elapsed_ms} ms</span>
          <SearchAttempts attempts={receipt.search_attempts} />
          <Btn
            small
            onPress={() => nav("/requests/" + receipt.trace_request_id)}
          >
            {t("查看测试记录", "View test trace")}
          </Btn>
          {receipt.diagnostics && <ProbeDetails value={receipt.diagnostics} />}
        </Panel>
      )}
      {kind === "projects" ? (
        <div className="project-grid">
          {rows.slice(page * 20, page * 20 + 20).map((e) => (
            <Panel key={e.id} className="project-card project-entry">
              <div className="project-card-head">
                <span className="tile-icon">
                  <Folder size={22} />
                </span>
                <div className="project-tools">
                  <small className="mono">v{e.version}</small>
                  <Btn small onPress={() => edit(e)}>
                    <Pencil size={14} aria-hidden="true" />
                    {t("编辑", "Edit")}
                  </Btn>
                </div>
              </div>
              <h2><OverflowText>{e.name}</OverflowText></h2>
              <Facts compact
                items={[
                  [
                    t("搜索池", "Search pools"),
                    e.search_pools
                      .map((pool: string[]) => pool.map(name).join(" + "))
                      .join(" → ") || "—",
                  ],
                  [
                    t("正文池", "Reader pools"),
                    e.reader_pools
                      .map((pool: string[]) => pool.map(name).join(" + "))
                      .join(" → ") || "—",
                  ],
                  [
                    t("生成模型", "Generation model"),
                    e.model_endpoint_id
                      ? name(e.model_endpoint_id)
                      : t("未配置", "Unconfigured"),
                  ],
                  [
                    t("总结材料", "Summary material"),
                    e.summary_snippets_only
                      ? t("搜索列表", "Search results")
                      : t("网页正文", "Page content"),
                  ],
                  [
                    t("浏览器出口", "Browser egress"),
                    e.browser_proxy_pool_id
                      ? name(e.browser_proxy_pool_id)
                      : t("自动选择 VPN 或 Pod 网络", "Automatic VPN or Pod network"),
                  ],
                  [
                    t("查询改写", "Query rewrites"),
                    (e.rewrite_count || t("关闭改写", "Off")) +
                      (e.search_original_query === false ? t(" · 仅改写查询", " · Rewrites only") : ""),
                  ],
                  [
                    t("搜索 / 来源上限", "Search / source limit"),
                    e.search_limit + " / " + e.source_limit,
                  ],
                ]}
              />
              <footer className="project-actions">
                <Btn small onPress={() => show(e)}>
                  <FileText size={14} />
                  {t("详情", "Details")}
                </Btn>
                <Btn small onPress={() => nav("/requests?project_id=" + e.id)}>
                  <History size={14} />
                  {t("请求记录", "Requests")}
                </Btn>
                <Btn
                  small
                  primary
                  onPress={() => {
                    setProject(e.id);
                    nav("/playground");
                  }}
                >
                  <FlaskConical size={14} />
                  {t("调试", "Debug")}
                </Btn>
              </footer>
            </Panel>
          ))}
        </div>
      ) : (
        rows.length > 0 && (
          <div
            className={
              kind === "proxy-pools"
                ? "pool-inventory-wrap"
                : "resource-table-surface"
            }
          >
            <ResourceInventory
              kind={kind}
              rows={rows.slice(page * 20, page * 20 + 20)}
              show={show}
              edit={edit}
              testing={testing}
              test={(id) => test.mutate(id)}
              cancel={() =>
                void write(
                  "/admin/v1/requests/" + testRequest.current + "/cancel",
                  {},
                )
              }
            />
          </div>
        )
      )}
      {!rows.length && (
        <Panel className="resource-empty">
          <span className="tile-icon">
            <ResourceIcon size={26} />
          </span>
          <h2>
            {query
              ? t("没有匹配的资源", "No matching resources")
              : kind === "projects"
                ? t("还没有项目", "No projects yet")
                : t("还没有配置资源", "No resources yet")}
          </h2>
          <p>
            {query
              ? t(
                  "试试其他名称，或清除搜索条件。",
                  "Try another name or clear the search.",
                )
              : kind === "projects"
                ? t(
                    "创建项目，组合搜索、正文与模型能力，开始你的第一次检索。",
                    "Create a project, connect search, reading and model capabilities, and start your first search.",
                  )
                : t(
                    "创建资源后，即可在项目中配置并使用。",
                    "Create a resource to make it available to your projects.",
                  )}
          </p>
          {!query && (
            <Btn primary onPress={create}>
              {kind === "projects"
                ? t("创建第一个项目", "Create your first project")
                : t("创建资源", "Create resource")}
            </Btn>
          )}
        </Panel>
      )}
      {rows.length > 20 && (
        <div className="form-actions">
          <Btn disabled={!page} onPress={() => setPage(page - 1)}>
            {t("上一页", "Previous")}
          </Btn>
          <span>{page + 1}</span>
          <Btn
            disabled={(page + 1) * 20 >= rows.length}
            onPress={() => setPage(page + 1)}
          >
            {t("下一页", "Next")}
          </Btn>
        </div>
      )}
      {editor && (
        <ResourceEditor
          key={editor.id || "new-" + kind}
          kind={kind}
          initial={editor}
          close={() => edit(null)}
          done={(r) => {
            const saved = r.project ?? r;
            queryClient.setQueryData<Record<string, Entity[]>>(["resources"], current => {
              if (!current) return current;
              const rows = current[kind] || [];
              return {
                ...current,
                [kind]: rows.some(row => row.id === saved.id)
                  ? rows.map(row => row.id === saved.id ? saved : row)
                  : [saved, ...rows],
              };
            });
            edit(null);
            if (r.api_key) setKey(r.api_key);
            void refresh();
          }}
        />
      )}
      {detail && (
        <Detail
          kind={kind}
          entity={detail}
          close={() => show(null)}
          edit={() => {
            edit(detail);
            show(null);
          }}
          rotate={() => setRotateTarget(detail)}
        />
      )}
      {rotateTarget && (
        <Confirm
          title={t("轮换项目密钥？", "Rotate project key?")}
          close={() => setRotateTarget(null)}
          confirm={() => rotate.mutate(rotateTarget)}
          busy={rotate.isPending}
        >
          {t(
            "旧密钥会立即失效，请同步更新调用方配置。",
            "The previous key will stop working immediately. Update your callers with the new key.",
          )}
          <Notice error={rotate.error} />
        </Confirm>
      )}
      {key && (
        <Dialog
          title={t("保存项目密钥", "Save project key")}
          close={() => setKey("")}
        >
          <p>
            {t(
              "本次只显示一次，请保存到安全位置。",
              "Shown once. Store it in a safe place.",
            )}
          </p>
          <div className="secret-row">
            <code className="one-time-key">{key}</code>
            <CopyButton value={key} label={t("复制密钥", "Copy key")} />
          </div>
        </Dialog>
      )}
    </>
  );
}
function Detail({
  kind,
  entity: e,
  close,
  edit,
  rotate,
}: {
  kind: string;
  entity: Entity;
  close: () => void;
  edit: () => void;
  rotate: () => void;
}) {
  const { t, name, resources } = useApp();
  const routes = useQuery({
    queryKey: ["language-routes"],
    queryFn: () => api<Entity>("/admin/v1/language-routes"),
    enabled: kind === "endpoints" && e.kind === "search",
  });
  const usedBy = Object.entries(resources.data || {}).flatMap(([group, rows]) =>
    rows
      .filter((r) =>
        group === "projects"
          ? r.search_pools?.flat().includes(e.id) ||
            r.reader_pools?.flat().includes(e.id) ||
            r.model_endpoint_id === e.id ||
            r.browser_proxy_pool_id === e.id
          : group === "proxy-pools" &&
            r.members?.some((m: Entity) => m.proxy_id === e.id),
      )
      .map((r) => ({ group, resource: r })),
  );
  const reference = (id: string) => {
    const group = Object.entries(resources.data || {}).find(([, rows]) =>
      rows.some((e) => e.id === id),
    );
    const entity = group?.[1].find((e) => e.id === id);
    return group ? (
      <span className="resource-reference">
        <Link to={`/${group[0]}?resource=${id}`}>{name(id)}</Link>
        {entity?.availability && entity.availability !== "available" && (
          <Status value={entity.availability} />
        )}
      </span>
    ) : (
      <span>{t("已移除的资源", "Removed resource")}</span>
    );
  };
  const human = (key: string, value: any): ReactNode => {
    if (key === "options") {
      const captions: Entity = {
        engines: t("搜索引擎", "Search engines"),
        format: t("正文格式", "Article format"),
        model: t("模型名称", "Model name"),
        tokenizer: t("分词器", "Tokenizer"),
        max_input_tokens: t("输入上限（Token）", "Input limit (tokens)"),
        max_output_tokens: t("输出上限（Token）", "Output limit (tokens)"),
      };
      return (
        <Facts
          items={Object.entries(value).map(([k, v]) => [
            captions[k] || k,
            Array.isArray(v) ? v.join(" · ") : String(v),
          ])}
        />
      );
    }
    if (key === "google_probe" || key === "default_network_google_probe")
      return (
        <Facts
          items={[
            [
              t("Google 可达性", "Google reachability"),
              value?.reachable == null
                ? t("待首次检测", "Awaiting first probe")
                : value.reachable
                  ? t("可达", "Reachable")
                  : t("不可达，使用百度", "Unreachable, using Baidu"),
            ],
            [
              t("检测完成时间", "Probe completion"),
              value?.checked_at
                ? new Date(value.checked_at).toLocaleString()
                : "—",
            ],
            [t("采样实例 UID", "Probe Pod UID"), value?.probe_pod_uid || "—"],
          ]}
        />
      );
    if (key === "health" || key === "availability")
      return <Status value={value} />;
    if (key === "search_pools" || key === "reader_pools")
      return value.map((pool: string[], i: number) => (
        <p key={i}>
          {t("优先级", "Priority")} {i + 1} ·{" "}
          {pool.map((id) => (
            <span key={id}>{reference(id)} </span>
          ))}
        </p>
      ));
    if (key === "model_endpoint_id" || key === "browser_proxy_pool_id")
      return value ? reference(value) : t("未绑定", "Unbound");
    if (key === "members")
      return value.map((member: Entity) => (
        <p key={member.proxy_id}>
          {reference(member.proxy_id)} · {t("权重", "Weight")} {member.weight}
        </p>
      ));
    if (typeof value === "boolean")
      return value ? t("是", "Yes") : t("否", "No");
    if (Array.isArray(value))
      return value
        .map((v: any) =>
          typeof v === "string"
            ? v
            : v.proxy_id
              ? name(v.proxy_id) + " × " + v.weight
              : "",
        )
        .join(", ");
    if (value && typeof value === "object")
      return Object.entries(value).map(([key, val]) => (
        <p key={key}>
          {key} · {String(val)}
        </p>
      ));
    return String(value ?? "—");
  };
  const labels: Entity = {
    id: t("资源 ID", "Resource ID"),
    version: t("配置版本", "Configuration version"),
    kind: t("能力", "Capability"),
    provider: t("服务商", "Provider"),
    adapter: t("接入协议", "Adapter"),
    base_url: t("服务基址", "Base URL"),
    options: t("能力选项", "Capability options"),
    scheme: t("代理协议", "Proxy protocol"),
    host: t("主机", "Host"),
    port: t("端口", "Port"),
    auth_mode: t("认证方式", "Authentication"),
    enabled: t("启用", "Enabled"),
    health: t("代理健康", "Proxy health"),
    active_leases: t("活跃租约", "Active leases"),
    google_probe: t("Google 周期检测", "Periodic Google probe"),
    ready_pods: t("就绪实例", "Ready instances"),
    name: t("名称", "Name"),
    search_pools: t("搜索池", "Search pools"),
    reader_pools: t("正文池", "Reader pools"),
    model_endpoint_id: t("生成模型", "Model"),
    browser_proxy_pool_id: t("浏览器代理池", "Browser proxy pool"),
    timeout_ms: t("超时（毫秒）", "Timeout (ms)"),
    max_concurrency: t("最大并发", "Max concurrency"),
    rpm: t("每分钟上限", "Requests per minute"),
    search_limit: t("搜索数量上限", "Search limit"),
    source_limit: t("总结来源上限", "Source limit"),
    body_limit: t("正文字数上限", "Article character limit"),
    summary_limit: t("总结字数上限", "Summary character limit"),
    rewrite_count: t("额外查询数", "Extra queries"),
    search_original_query: t("原问题参与搜索", "Search original query"),
    summary_snippets_only: t("直接使用搜索列表总结", "Summarize search results only"),
    allow_snippets: t("允许简介回退", "Allow snippet fallback"),
    has_secret: t("已配置凭据", "Credential configured"),
    default_network_google_probe: t(
      "共享默认网络 Google 检测",
      "Shared default-network Google probe",
    ),
    managed_by: t("管理来源", "Managed by"),
    availability: t("部署状态", "Deployment state"),
    health_reason: t("健康状态原因", "Health reason"),
    failure_count: t("连续连接失败次数", "Consecutive connection failures"),
    health_backoff: t("恢复退避轮次", "Recovery backoff round"),
    health_revision: t("状态版本", "Health revision"),
    cooldown_until: t("恢复检测时间", "Recovery probe due"),
    last_health_check: t("最近健康检测", "Last health check"),
    members: t("成员", "Members"),
  };
  return (
    <Dialog title={e.name} layout="wide" close={close}>
      <Facts
        items={Object.entries(e)
          .filter(([k]) => k !== "last_test")
          .map(([k, v]) => [labels[k] || k, human(k, v)])}
      />
      {(usedBy.length > 0 ||
        routes.data?.entries?.some((r: Entity) =>
          r.endpoint_ids.includes(e.id),
        )) && (
        <section className="source-card">
          <h3>{t("使用位置", "Used by")}</h3>
          {usedBy.map(({ group, resource }) => (
            <p key={resource.id}>
              <Link to={`/${group}?resource=${resource.id}`}>
                {resource.name}
              </Link>
            </p>
          ))}
          {(routes.data?.entries || [])
            .filter((r: Entity) => r.endpoint_ids.includes(e.id))
            .map((r: Entity) => (
              <p key={r.language}>
                <Link to={`/language-routes?language=${r.language}`}>
                  {t("优先语言", "Preferred language")} · {r.language}
                </Link>
              </p>
            ))}
        </section>
      )}
      <div className="form-actions">
        {kind === "projects" && (
          <Btn onPress={rotate}>{t("轮换项目密钥", "Rotate project key")}</Btn>
        )}
        {!["system", "helm"].includes(e.managed_by) && (
          <Btn primary onPress={edit}>
            {t("编辑配置", "Edit configuration")}
          </Btn>
        )}
      </div>
      {e.last_test?.diagnostics && (
        <ProbeDetails value={e.last_test.diagnostics} />
      )}
      {e.last_test && (
        <section className="source-card">
          <h3>{t("最近手工测试", "Latest manual test")}</h3>
          <Status value={e.last_test.status} />
          <p>
            {t("配置版本", "Configuration version")}{" "}
            {e.last_test.resource_version} · {e.last_test.elapsed_ms} ms
          </p>
          <Link to={`/requests/${e.last_test.trace_request_id}`}>
            {t("查看测试记录", "Open test record")}
          </Link>
        </section>
      )}
    </Dialog>
  );
}
function ResourceEditor({
  kind,
  initial,
  close,
  done,
}: {
  kind: string;
  initial: Entity;
  close: () => void;
  done: (r: Entity) => void;
}) {
  const { t, resources } = useApp();
  const [baseline, setBaseline] = useState<Entity>(initial);
  const [reloadRequested, setReloadRequested] = useState(false);
  const [draft, setDraft] = useState<Entity>(structuredClone(initial));
  const [secret, setSecret] = useState(""),
    [username, setUsername] = useState(""),
    [action, setAction] = useState("keep");
  const set = (key: string, value: any) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const options = (key: string, value: any) =>
    setDraft((d) => ({ ...d, options: { ...d.options, [key]: value } }));
  const save = useMutation({
    mutationFn: async () => {
      const body = { ...draft };
      for (const k of [
        "id",
        "version",
        "managed_by",
        "availability",
        "has_secret",
        "last_test",
        "google_probe",
        "active_leases",
        "health",
        "health_reason",
        "failure_count",
        "health_backoff",
        "health_revision",
        "cooldown_until",
        "last_health_check",
        "ready_pods",
        "default_network_google_probe",
      ])
        delete body[k];
      if (initial.id) body.expected_version = baseline.version;
      if (kind === "endpoints" || kind === "proxies") {
        if (initial.id) body.secret_action = action;
        if (action === "replace" || secret)
          body.secret =
            kind === "proxies"
              ? { username, password: secret }
              : { api_key: secret };
      }
      return write(
        "/admin/v1/" + kind + (initial.id ? "/" + initial.id : ""),
        body,
        initial.id ? "PUT" : "POST",
      );
    },
    onSuccess: done,
  });
  const all = resources.data || {};
  const references = (resourceKind: string, empty: string) => [
    { value: "", label: empty },
    ...(all[resourceKind] || []).map((e: Entity) => ({
      value: e.id,
      label: e.name,
    })),
  ];
  const resourceNames: Record<string, [string, string]> = {
    projects: ["项目", "project"],
    endpoints: ["接入点", "endpoint"],
    proxies: ["VPN 代理", "VPN proxy"],
    "proxy-pools": ["代理池", "proxy pool"],
  };
  const [zhName, enName] = resourceNames[kind];
  const title = initial.id
    ? t(`编辑${zhName}`, `Edit ${enName}`)
    : t(`新建${zhName}`, `Create ${enName}`);
  const numeric = (key: string, label: string) => (
    <Field
      key={key}
      label={label}
      type="number"
      value={draft[key]}
      change={(v) => set(key, Number(v))}
    />
  );
  return (
    <>
      <Dialog
        title={title}
        layout="wide"
        close={close}
        dirty={
          JSON.stringify(baseline) !== JSON.stringify(draft) ||
          !!secret ||
          action !== "keep"
        }
        save={() => save.mutate()}
        busy={save.isPending}
      >
        <div
          className={
            kind === "projects" ? "form-stack project-form" : "form-stack"
          }
        >
          <Notice error={save.error} />
          {(save.error as any)?.code === "VERSION_CONFLICT" && (
            <Btn onPress={() => setReloadRequested(true)}>
              {t("载入最新版本", "Reload latest version")}
            </Btn>
          )}
          {kind === "projects" && (
            <h3 className="form-section">
              {t("项目设置", "Project settings")}
            </h3>
          )}
          <Field
            label={t("名称", "Name")}
            value={draft.name}
            change={(v) => set("name", v)}
            required
          />
          {kind === "projects" ? (
            <>
              <h3 className="form-section">
                {t("搜索与正文能力", "Search and reading")}
              </h3>
              <div className="project-pools">
                {(["search", "reader"] as const).map((cap) => (
                  <PoolBuilder
                    key={cap}
                    label={
                      cap === "search"
                        ? t("搜索接入点池", "Search pools")
                        : t("正文接入点池", "Reader pools")
                    }
                    pools={draft[cap + "_pools"]}
                    endpoints={(all.endpoints || []).filter(
                      (e: Entity) => e.kind === cap,
                    )}
                    change={(v) => set(cap + "_pools", v)}
                  />
                ))}
              </div>
              <div className="form-grid">
                <Select
                  label={t("生成模型", "Generation model")}
                  value={draft.model_endpoint_id || ""}
                  change={(v) => set("model_endpoint_id", v || null)}
                  options={[
                    { value: "", label: t("稍后配置", "Configure later") },
                    ...(all.endpoints || [])
                      .filter((e: Entity) => e.kind === "model")
                      .map((e: Entity) => ({ value: e.id, label: e.name })),
                  ]}
                />
                <Select
                  label={t("浏览器代理池", "Browser proxy pool")}
                  value={draft.browser_proxy_pool_id || ""}
                  change={(v) => set("browser_proxy_pool_id", v || null)}
                  options={references(
                    "proxy-pools",
                    t("自动选择 VPN 或 Pod 网络", "Automatic VPN or Pod network"),
                  )}
                />
              </div>
              <h3 className="form-section">
                {t("限制与总结策略", "Limits and synthesis")}
              </h3>
              <Switch
                isSelected={draft.summary_snippets_only ?? false}
                onChange={value => set("summary_snippets_only", value)}
              >
                <Switch.Content>
                  <Switch.Control><Switch.Thumb /></Switch.Control>
                  <Label>{t("直接使用搜索列表总结", "Summarize search results only")}</Label>
                </Switch.Content>
                <Description>
                  {t(
                    "使用搜索结果的标题和简介作为总结依据，跳过正文获取，保留评分、来源和引用。",
                    "Use search titles and snippets as evidence, skip article retrieval, and retain scoring, sources and citations.",
                  )}
                </Description>
              </Switch>
              <div className="form-grid">
                {numeric("search_limit", t("最大搜索数量", "Search limit"))}
                {numeric("source_limit", t("总结来源上限", "Source limit"))}
                {numeric(
                  "body_limit",
                  draft.summary_snippets_only
                    ? t("搜索材料字数上限", "Search material character limit")
                    : t("正文字数上限", "Article character limit"),
                )}
                {numeric(
                  "summary_limit",
                  t("总结字数上限", "Summary character limit"),
                )}
                {numeric(
                  "rewrite_count",
                  t("额外查询数（0–3）", "Extra queries (0–3)"),
                )}
              </div>
              <Checkbox isSelected={draft.search_original_query ?? true} onChange={value => set("search_original_query", value)}>
                <Checkbox.Content>
                  <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
                  {t("原问题参与搜索", "Search original query")}
                </Checkbox.Content>
                <Description>{t("用于综合总结。关闭后只搜索改写查询，额外查询数至少为 1；原问题仍用于评分和总结。", "Applies to summaries. When disabled, search only rewritten queries (at least one required); keep the original for scoring and synthesis.")}</Description>
              </Checkbox>
              <Checkbox
                isSelected={draft.allow_snippets}
                isDisabled={draft.summary_snippets_only ?? false}
                onChange={value => set("allow_snippets", value)}
              >
                <Checkbox.Content>
                  <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
                  {t("普通取文失败时允许使用简介", "Allow snippets after ordinary extraction failure")}
                </Checkbox.Content>
              </Checkbox>
            </>
          ) : kind === "endpoints" ? (
            <>
              {initial.id && (
                <Facts
                  items={[
                    [t("能力", "Capability"), draft.kind],
                    [t("服务商", "Provider"), draft.provider],
                    [t("接入协议", "Adapter"), draft.adapter],
                  ]}
                />
              )}
              {!initial.id && (
                <Select
                  label={t("服务商", "Provider")}
                  value={draft.provider}
                  change={(v) => {
                    setDraft(endpointDefault(draft.kind, v));
                    setSecret("");
                    setUsername("");
                    setAction("clear");
                  }}
                  options={providers[draft.kind].map((v) => ({
                    value: v,
                    label: v === "deepseek" ? "DeepSeek" : v,
                  }))}
                />
              )}
              <Field
                label={t("原生服务基址", "Native service base URL")}
                value={draft.base_url || ""}
                change={(v) => set("base_url", v)}
                hint={draft.provider === "deepseek" ? t(
                  draft.kind === "search"
                    ? "支持 https://api.deepseek.com 或 https://api.deepseek.com/v1。搜索词最多 128 个字符，请使用不限时间的搜索。"
                    : "支持 https://api.deepseek.com 或 https://api.deepseek.com/v1。传入网页 URL，取得 Markdown 正文。",
                  draft.kind === "search"
                    ? "Use https://api.deepseek.com or https://api.deepseek.com/v1. Queries support up to 128 characters. Select no time filter."
                    : "Use https://api.deepseek.com or https://api.deepseek.com/v1. Supply a webpage URL to retrieve Markdown content.",
                ) : undefined}
              />
              <div className="form-grid">
                <Field
                  type="number"
                  step={0.001}
                  label={t("单次超时（秒）", "Attempt timeout (seconds)")}
                  value={draft.timeout_ms / 1000}
                  change={(v) =>
                    set("timeout_ms", Math.round(Number(v) * 1000))
                  }
                />
                {numeric("max_concurrency", t("最大并发", "Max concurrency"))}
                {numeric("rpm", t("每分钟调用上限", "Requests per minute"))}
              </div>
              {draft.kind === "model" ? (
                <div className="form-grid">
                  {["model", "tokenizer"].map((key) => (
                    <Field
                      key={key}
                      label={
                        key === "model"
                          ? t("模型标识", "Model ID")
                          : t("分词器", "Tokenizer")
                      }
                      value={draft.options[key] ?? ""}
                      change={(v) => options(key, v)}
                    />
                  ))}
                  <Select label={t("推理强度（按模型支持）", "Reasoning effort (model dependent)")}
                    value={draft.options.reasoning_effort || ""}
                    change={v=>options("reasoning_effort",v || undefined)}
                    options={[{value:"",label:t("使用服务商默认值", "Provider default")},...["none","minimal","low","medium","high","xhigh","max"].map(value=>({value,label:value}))]}/>
                  {["max_input_tokens", "max_output_tokens", "context_window_tokens"].map((key) => (
                    <Field
                      key={key}
                      label={
                        key === "max_input_tokens"
                          ? t("最大输入 Token", "Max input tokens")
                          : key === "context_window_tokens" ? t("总上下文 Token（可选）", "Total context tokens (optional)") : t("最大输出 Token", "Max output tokens")
                      }
                      type="number"
                      value={draft.options[key] ?? ""}
                      change={(v) => options(key, v === "" && key === "context_window_tokens" ? undefined : Number(v))}
                    />
                  ))}
                </div>
              ) : draft.kind === "search" ? (
                <>
                  {draft.provider === "searxng" && (
                    <Field
                      label={t(
                        "引擎列表（逗号分隔）",
                        "Engines (comma separated)",
                      )}
                      value={(draft.options.engines || []).join(",")}
                      change={(v) =>
                        options(
                          "engines",
                          v
                            .split(",")
                            .map((s) => s.trim())
                            .filter(Boolean),
                        )
                      }
                    />
                  )}
                  {draft.provider !== "searxng" && (
                    <label>
                      <input
                        type="checkbox"
                        checked={draft.adapter === "integrated_search"}
                        onChange={(e) =>
                          set(
                            "adapter",
                            e.target.checked
                              ? "integrated_search"
                              : "http_search",
                          )
                        }
                      />{" "}
                      {t("请求随附网页材料", "Request inline page material")}
                    </label>
                  )}
                </>
              ) : (
                <Select
                  label={t("上游正文格式", "Upstream article format")}
                  value={draft.options.format || "markdown"}
                  change={(v) => options("format", v)}
                  options={[
                    { value: "markdown", label: "Markdown" },
                    { value: "html", label: "HTML" },
                  ]}
                />
              )}
            </>
          ) : kind === "proxies" ? (
            <>
              <div className="form-grid">
                <Select
                  label={t("协议", "Protocol")}
                  value={draft.scheme}
                  change={(v) => set("scheme", v)}
                  options={[
                    { value: "socks5", label: "SOCKS5" },
                    { value: "https", label: "HTTPS" },
                  ]}
                />
                <Field
                  label={t("主机", "Host")}
                  value={draft.host}
                  change={(v) => set("host", v)}
                />
                {numeric("port", t("端口", "Port"))}
                {numeric("max_concurrency", t("最大并发", "Max concurrency"))}
              </div>
              <Select
                label={t("认证方式", "Authentication")}
                value={draft.auth_mode}
                change={(v) => set("auth_mode", v)}
                options={[
                  { value: "none", label: t("无认证", "None") },
                  {
                    value: "password",
                    label: t("用户名和口令", "Username and password"),
                  },
                ]}
              />
              <label>
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(e) => set("enabled", e.target.checked)}
                />{" "}
                {t("启用代理", "Enable proxy")}
              </label>
            </>
          ) : (
            <>
              {(all.proxies || []).map((e: Entity) => {
                const member = draft.members.find(
                  (m: Entity) => m.proxy_id === e.id,
                );
                return (
                  <div key={e.id} className="member-row">
                    <label>
                      <input
                        type="checkbox"
                        checked={!!member}
                        onChange={(event) =>
                          set(
                            "members",
                            event.target.checked
                              ? [
                                  ...draft.members,
                                  { proxy_id: e.id, weight: 1 },
                                ]
                              : draft.members.filter(
                                  (m: Entity) => m.proxy_id !== e.id,
                                ),
                          )
                        }
                      />{" "}
                      {e.name}
                    </label>
                    {member && (
                      <Field
                        type="number"
                        label={t("权重", "Weight")}
                        value={member.weight}
                        change={(v) =>
                          set(
                            "members",
                            draft.members.map((m: Entity) =>
                              m.proxy_id === e.id
                                ? { ...m, weight: Number(v) }
                                : m,
                            ),
                          )
                        }
                      />
                    )}
                  </div>
                );
              })}
            </>
          )}
          {(kind === "endpoints" ||
            (kind === "proxies" && draft.auth_mode === "password")) && (
            <>
              {initial.id && (
                <Select
                  label={t("凭据操作", "Credential action")}
                  value={action}
                  change={setAction}
                  options={[
                    { value: "keep", label: t("保留现有凭据", "Keep") },
                    { value: "replace", label: t("替换凭据", "Replace") },
                    { value: "clear", label: t("清除凭据", "Clear") },
                  ]}
                />
              )}
              {(!initial.id || action === "replace") && (
                <>
                  {kind === "proxies" && (
                    <Field
                      label={t("用户名", "Username")}
                      value={username}
                      change={setUsername}
                    />
                  )}
                  <Field
                    type="password"
                    label={
                      kind === "proxies"
                        ? t("代理口令", "Proxy password")
                        : "API Key"
                    }
                    value={secret}
                    change={(v) => {
                      setSecret(v);
                      setAction("replace");
                    }}
                  />
                </>
              )}
            </>
          )}
        </div>
      </Dialog>
      {reloadRequested && (
        <Dialog
          title={t("载入最新版本", "Reload latest version")}
          close={() => setReloadRequested(false)}
        >
          <p>
            {t(
              "载入后将使用服务器的最新配置。",
              "The server configuration will replace this draft.",
            )}
          </p>
          <Btn onPress={() => setReloadRequested(false)}>
            {t("继续编辑", "Keep editing")}
          </Btn>
          <Btn
            primary
            onPress={() =>
              void api<Entity>("/admin/v1/" + kind + "/" + initial.id).then(
                (value) => {
                  setBaseline(value);
                  setDraft(structuredClone(value));
                  setSecret("");
                  setAction("keep");
                  save.reset();
                  setReloadRequested(false);
                },
              )
            }
          >
            {t("放弃草稿并载入", "Discard draft and reload")}
          </Btn>
        </Dialog>
      )}
    </>
  );
}
function PoolBuilder({
  label,
  pools,
  endpoints,
  change,
}: {
  label: string;
  pools: string[][];
  endpoints: Entity[];
  change: (v: string[][]) => void;
}) {
  const { t } = useApp();
  const used = pools.flat();
  return (
    <fieldset className="pool-builder">
      <legend>{label}</legend>
      {pools.map((pool, i) => (
        <div className="endpoint-group" key={i}>
          <div className="group-title">
            <b>
              {t("优先级", "Priority")} {i + 1}
            </b>
            <div>
              {[-1, 1].map((dir) => (
                <Btn
                  key={dir}
                  iconOnly
                  small
                  aria-label={`${label} ${t("优先级", "Priority")} ${i + 1} ${dir < 0 ? t("上移", "Move up") : t("下移", "Move down")}`}
                  disabled={i + dir < 0 || i + dir >= pools.length}
                  onPress={() => {
                    const n = [...pools];
                    [n[i], n[i + dir]] = [n[i + dir], n[i]];
                    change(n);
                  }}
                >
                  {dir < 0 ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
                </Btn>
              ))}
              <Btn
                iconOnly
                small
                aria-label={`${label} ${t("优先级", "Priority")} ${i + 1} ${t("删除池", "Remove pool")}`}
                onPress={() => change(pools.filter((_, j) => j !== i))}
              >
                <X size={14} />
              </Btn>
            </div>
          </div>
          <div className="member-chips">
            {pool.map((id) => (
              <button
                className="code-chip"
                key={id}
                onClick={() =>
                  change(
                    pools.map((g, j) =>
                      j === i ? g.filter((x) => x !== id) : g,
                    ),
                  )
                }
              >
                {endpoints.find((e) => e.id === id)?.name ||
                  t("不可用的成员", "Unavailable member")}{" "}
                ×
              </button>
            ))}
            <Select
              label={t("添加成员", "Add member")}
              value=""
              change={(v) => {
                if (v) change(pools.map((g, j) => (j === i ? [...g, v] : g)));
              }}
              options={[
                { value: "", label: t("选择接入点", "Select endpoint") },
                ...endpoints
                  .filter(
                    (e) =>
                      !used.includes(e.id) && e.availability === "available",
                  )
                  .map((e) => ({ value: e.id, label: e.name })),
              ]}
            />
          </div>
        </div>
      ))}
      <Btn small onPress={() => change([...pools, []])}>
        <Plus size={14} />
        {t("新增池", "Add pool")}
      </Btn>
    </fieldset>
  );
}
export function LanguageRoutes() {
  const { t, resources, refresh, routeDraft, language: uiLanguage } = useApp();
  const [reload, setReload] = useState(false);
  const [version, setVersion] = useState(routeDraft.current?.version);
  const routes = useQuery({
    queryKey: ["language-routes"],
    queryFn: () => api<Entity>("/admin/v1/language-routes"),
  });
  const [parameters] = useSearchParams();
  const [draft, setDraft] = useState<Entity[]>(
      routeDraft.current?.entries || [],
    ),
    [language, setLanguage] = useState(parameters.get("language") || "zh"),
    [endpoint, setEndpoint] = useState("");
  const set = (entries: Entity[]) => {
    setDraft(entries);
    routeDraft.current = { entries, version: version! };
  };
  useEffect(() => {
    if (routes.data && !routeDraft.current) {
      const entries = structuredClone(routes.data.entries);
      setDraft(entries);
      setVersion(routes.data.version);
      routeDraft.current = { entries, version: routes.data.version };
    }
  }, [routes.data, routeDraft]);
  const save = useMutation({
    mutationFn: () =>
      write(
        "/admin/v1/language-routes",
        {
          entries: draft,
          expected_version: version,
        },
        "PUT",
      ),
    onSuccess: (value) => {
      routeDraft.current = {
        entries: structuredClone(value.entries),
        version: value.version,
      };
      setDraft(routeDraft.current.entries);
      setVersion(value.version);
      void refresh();
    },
  });
  const name = (id: string) =>
    (resources.data?.endpoints || []).find((e) => e.id === id)?.name ||
    t("不可用成员", "Unavailable member");
  return (
    <>
      <Head
        title={t("语言路由", "Language routing")}
        sub={t(
          "搜索从第一个语言命中池开始，全池不可用时继续向后。",
          "Search starts at the first matching project pool and moves forward if necessary.",
        )}
      >
        <span className="code-chip">v{version ?? "—"}</span>
        <Btn onPress={() => setReload(true)}>
          {t("重新载入配置", "Reload configuration")}
        </Btn>
        <Btn
          primary
          onPress={() => save.mutate()}
          disabled={
            !routes.data ||
            save.isPending ||
            JSON.stringify(draft) === JSON.stringify(routes.data.entries)
          }
        >
          {t("保存路由", "Save routes")}
        </Btn>
      </Head>
      <Notice error={routes.error || save.error} />
      {routes.data && version !== routes.data.version && (
        <p>
          {t(
            "配置已变化，当前草稿仍保留。",
            "Configuration changed; your draft is preserved.",
          )}
        </p>
      )}

      {reload && (
        <Confirm
          title={t("放弃路由草稿？", "Discard route draft?")}
          close={() => setReload(false)}
          confirm={() =>
            void routes.refetch().then(({ data }) => {
              if (data) {
                routeDraft.current = {
                  entries: structuredClone(data.entries),
                  version: data.version,
                };
                setDraft(routeDraft.current.entries);
                setVersion(data.version);
                save.reset();
                setReload(false);
              }
            })
          }
        >
          {t(
            "将载入服务器的最新配置。",
            "Load the latest configuration from the server.",
          )}
        </Confirm>
      )}
      <Panel flush className="route-map">
        <header className="panel-header">
          <h2>{t("语言优先规则", "Language preferences")}</h2>
          <small className="muted">
            {JSON.stringify(draft) !==
            JSON.stringify(routes.data?.entries || [])
              ? t("未保存", "Unsaved")
              : t("已保存", "Saved")}
          </small>
        </header>
        <DataTable>
          <DataTable.Header>
            <DataTable.Column>{t("语言", "Language")}</DataTable.Column>
            <DataTable.Column>
              {t("优先成员", "Preferred members")}
            </DataTable.Column>
            <DataTable.Column>{t("操作", "Action")}</DataTable.Column>
          </DataTable.Header>
          <DataTable.Body>
            {draft.map((r) => (
              <DataTable.Row key={r.language}>
                <DataTable.Cell>
                  <b>
                    {
                      languageOptions([r.language], uiLanguage)[0].label.split(
                        " · ",
                      )[0]
                    }
                  </b>
                  <small className="row-sub mono">{r.language}</small>
                </DataTable.Cell>
                <DataTable.Cell>
                  {r.endpoint_ids.map((id: string) => (
                    <button
                      key={id}
                      className="code-chip"
                      onClick={() =>
                        set(
                          draft
                            .map((v) =>
                              v.language === r.language
                                ? {
                                    ...v,
                                    endpoint_ids: v.endpoint_ids.filter(
                                      (x: string) => x !== id,
                                    ),
                                  }
                                : v,
                            )
                            .filter((v) => v.endpoint_ids.length),
                        )
                      }
                    >
                      {name(id)} ×
                    </button>
                  ))}
                </DataTable.Cell>
                <DataTable.Cell>
                  <button
                    className="text-link"
                    onClick={() =>
                      set(draft.filter((v) => v.language !== r.language))
                    }
                  >
                    {t("移除语言", "Remove language")}
                  </button>
                </DataTable.Cell>
              </DataTable.Row>
            ))}
          </DataTable.Body>
        </DataTable>
        {!draft.length && (
          <Empty>{t("尚未添加优先成员", "No preferred endpoints yet")}</Empty>
        )}
      </Panel>
      <Panel className="route-composer">
        <h2>{t("添加优先成员", "Add a preferred endpoint")}</h2>
        <div className="form-grid">
          <LanguagePicker
            label={t("业务语言", "Language")}
            value={language}
            change={setLanguage}
            extra={draft.map((rule) => rule.language)}
          />
          <Select
            label={t("优先搜索接入点", "Preferred search endpoint")}
            value={endpoint}
            change={setEndpoint}
            options={[
              { value: "", label: t("选择接入点", "Select endpoint") },
              ...(resources.data?.endpoints || [])
                .filter(
                  (e) => e.kind === "search" && e.availability === "available",
                )
                .map((e) => ({ value: e.id, label: e.name })),
            ]}
          />
        </div>
        <Btn
          disabled={
            !endpoint ||
            draft.some(
              (r) =>
                r.language === language && r.endpoint_ids.includes(endpoint),
            )
          }
          onPress={() => {
            if (!endpoint) return;
            const old = draft.find((r) => r.language === language);
            set(
              old
                ? draft.map((r) =>
                    r === old
                      ? {
                          ...r,
                          endpoint_ids: [
                            ...new Set([...r.endpoint_ids, endpoint]),
                          ],
                        }
                      : r,
                  )
                : [...draft, { language, endpoint_ids: [endpoint] }],
            );
          }}
        >
          {t("添加规则", "Add rule")}
        </Btn>
      </Panel>
    </>
  );
}
