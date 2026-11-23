import { OverflowText } from "./overflow-text";
import { LocalDateTimePicker } from "./date-time-picker";
import {
  ArrowRight,
  BookOpen,
  FileText,
  FlaskConical,
  FolderPlus,
  Layers3,
  List,
  Play,
  SlidersHorizontal,
  Square,
} from "lucide-react";
import { LanguagePicker } from "./language-picker";
import { CopyButton } from "./copy-button";
import { RequestParameters } from "./request-parameters";
import { ViewTabs } from "./ui";
import { useEffect, useRef, useState } from "react";
import {
  Link,
  useSearchParams,
  useLocation,
  useNavigate,
  useNavigationType,
} from "react-router-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { raw, write, ApiError, type Entity, type Envelope } from "./api";
import { useApp } from "./state";
import { Btn, Empty, Field, Head, Notice, Panel, Select, Status } from "./ui";
export function MarkdownView({ text }: { text: string }) {
  const {t}=useApp();
  return (
    <div className="article markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          img: ({ alt, src }) =>
            src?.startsWith("data:") ? (
              <img src={src} alt={alt} />
            ) : (
              <span>{alt || t("图片", "Image")}</span>
            ),
          a: ({ href, children }) =>
            href?.startsWith("https://") || href?.startsWith("http://") ? (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
export function SearchCards({cards,className="search-hit engine-card"}: {cards:Entity[];className?:string}) {
  const {t}=useApp();
  return <>{cards.map((card,index)=><article className={className} data-search-card key={card.url+index}>
    <small>{card.engine==="google"?"Google":t("百度","Baidu")} · {t("搜索页卡片","Search-page card")}</small>
    <h3>{card.title || t("搜索材料","Search material")}</h3>
    <MarkdownView text={card.content} />
    <a href={card.url} target="_blank" rel="noreferrer">{t("查看搜索页","View search page")}</a>
  </article>)}</>;
}
export function Result({
  result,
  onCitation,
  onOpenRange = onCitation,
}: {
  result: Envelope;
  onOpenRange?: (source: string, segment: string) => void;
  onCitation?: (source: string, segment: string) => void;
}) {
  const { t } = useApp();
  const [format, setFormat] = useState("preview");
  const [citation, setCitation] = useState("");
  useEffect(() => {
    if (citation)
      document.getElementById(citation)?.scrollIntoView({ block: "center" });
  }, [citation]);
  const data = result.data;
  if (result.error) return <Notice error={result.error.message} />;
  if (!data) return <Empty>{t("尚无结果", "No result")}</Empty>;
  if (data.items)
    return (
      <div className="hit-list">
        <SearchCards cards={data.cards || []} />
        {data.engine_answer && (
          <article className="search-hit engine-answer">
            <h3>{data.engine_answer.engine === "google" ? "Google" : t("百度", "Baidu")} · {t("AI 回答", "AI answer")}</h3>
            <MarkdownView text={data.engine_answer.content} />
            <ul>{data.engine_answer.sources.map((source: Entity) => (
              <li key={source.url}><a href={source.url} target="_blank" rel="noreferrer">{source.title || source.url}</a></li>
            ))}</ul>
          </article>
        )}
        {data.items.map((item: Entity, i: number) => (
          <article className="search-hit hit" key={item.url + i}>
            <span className="rank">{String(i + 1).padStart(2, "0")}</span>
            <div>
              <a href={item.url} target="_blank" rel="noreferrer">
                <h3>{item.title || item.url}</h3>
              </a>
              <span className="source-address">{item.url}</span>
              <p>{item.snippet}</p>
            </div>
          </article>
        ))}
        {!data.items.length && !data.engine_answer && !data.cards?.length && (
          <Empty>{t("没有找到相关网页", "No matching pages found")}</Empty>
        )}
      </div>
    );
  if (typeof data.markdown === "string")
    return (
      <div className="read-result">
        <ViewTabs
          label={t("正文格式", "Article format")}
          value={format}
          change={setFormat}
          items={[
            ["preview", t("预览", "Preview")],
            ["markdown", t("Markdown 源文", "Markdown source")],
            ["text", t("纯文本", "Plain text")],
          ]}
        >
          {format === "preview" ? (
            <MarkdownView text={data.markdown} />
          ) : (
            <pre className="code-box">{data[format]}</pre>
          )}
        </ViewTabs>
        <p className="source-address">{data.url}</p>
        {data.final_url && (
          <p>
            {t("最终地址", "Final URL")} · {data.final_url}
          </p>
        )}
        <p>
          {t("保留字数", "Retained characters")} · {data.lengths?.text.retained}{" "}
          / {data.lengths?.text.original}{" "}
          {data.truncated && t("已截断", "Truncated")}
        </p>
      </div>
    );
  return (
    <div className="summary-result synthesis">
      <article className="answer">
        <div className="answer-label">
          <BookOpen size={15} />
          {t("整体总结", "Synthesis")}
        </div>
        <MarkdownView text={data.summary || ""} />
        <div className="citation-links cite-row">
          {!!data.citations?.length && <span>{t("引用", "Citations")}</span>}
          {(data.citations || []).map((c: Entity, i: number) => (
            <button
              className="row-link"
              key={i}
              onClick={() =>
                onCitation
                  ? onCitation(c.source_id, c.segment_id)
                  : setCitation(c.source_id + "-" + c.segment_id)
              }
              aria-pressed={citation === c.source_id + "-" + c.segment_id}
              aria-label={t("查看引用 ", "Open citation ") + (i + 1)}
            >
              [{i + 1}]
            </button>
          ))}
        </div>
      </article>
      <section className="evidence">
        <h3>
          {t("来源与分段", "Sources and passages")}{" "}
          <small>{data.sources?.length ?? 0}</small>
        </h3>
        {(data.sources || []).map((source: Entity, i: number) => (
          <details
            key={source.id}
            className="source-card"
            open={citation.startsWith(source.id + "-") || undefined}
          >
            <summary>
              <span className="source-index">
                {String(i + 1).padStart(2, "0")}
              </span>
              <strong>{source.title || source.url}</strong>
              <span>
                {source.score} / 100 ·{" "}
                {source.kind === "snippet"
                  ? t("搜索简介", "Search snippet")
                  : t("网页正文", "Article body")}
              </span>
            </summary>
            <a href={source.url} target="_blank" rel="noreferrer">
              {source.url}
            </a>
            {source.segments.map((segment: Entity) => (
              <section
                className={
                  citation === source.id + "-" + segment.id
                    ? "focused-passage"
                    : undefined
                }
                id={source.id + "-" + segment.id}
                key={segment.id}
              >
                <small>{segment.id}</small>
                <MarkdownView text={segment.summary} />
                {onOpenRange && (
                  <Btn small onPress={() => onOpenRange(source.id, segment.id)}>
                    {t("查看原文范围", "View original range")}
                  </Btn>
                )}
              </section>
            ))}
          </details>
        ))}
      </section>
      {!data.sources?.length && (
        <Empty>{t("没有可用于回答的证据", "No evidence for an answer")}</Empty>
      )}
    </div>
  );
}
export function Playground() {
  const { t, projects, project, setProject, queryClient, name, lastDebug } =
    useApp();
  const nav = useNavigate();
  const location = useLocation(),
    navigationType = useNavigationType();
  const remembered =
    navigationType === "POP" && lastDebug.current?.entry === location.key
      ? lastDebug.current
      : null;
  const [responseTab, setResponseTab] = useState("result"),
    [advanced, setAdvanced] = useState(false);
  const [submitted, setSubmitted] = useState<{
    input: Entity;
    defaults: Entity;
  } | null>(null);
  const [http, setHttp] = useState<number>(),
    [cancelled, setCancelled] = useState(false);
  const [params] = useSearchParams();
  const [op, setOp] = useState(
      remembered?.op ||
        (["list", "content", "summary"].includes(params.get("op") || "")
          ? params.get("op")!
          : "summary"),
    ),
    [draft, setDraft] = useState<Entity>({}),
    [response, setResponse] = useState<Envelope | null>(null),
    [error, setError] = useState<unknown>(),
    [running, setRunning] = useState(false),
    [elapsed, setElapsed] = useState(0),
    [runId, setRunId] = useState("");
  const request = useRef<{
    id: string;
    controller: AbortController;
    seq: number;
  } | null>(null);
  const generation = useRef(0);
  const sampleEntry = useRef("");
  const storageKey = "oas-draft:" + project + ":" + op;
  useEffect(() => {
    let initial: Entity = {};
    try {
      initial = JSON.parse(sessionStorage.getItem(storageKey) || "{}");
    } catch {
      sessionStorage.removeItem(storageKey);
    }
    if (
      params.get("sample") &&
      params.get("op") === op &&
      !remembered &&
      sampleEntry.current !== location.key &&
      project
    ) {
      try {
        sampleEntry.current = location.key;
        const sample = params.get("sample")!;
        initial =
          sample === "1"
            ? op === "content"
              ? { url: "https://example.com/" }
              : { query: "How is rainfall measured?" }
            : JSON.parse(sample);
        sessionStorage.setItem(storageKey, JSON.stringify(initial));
      } catch {
        initial = {};
      }
    }
    setDraft(initial);
    const saved =
      remembered?.project === project && remembered.op === op
        ? remembered
        : null;
    setResponse(saved?.result || null);
    setError(saved?.error);
    setSubmitted(
      saved ? { input: saved.input, defaults: saved.defaults } : null,
    );
    setCancelled(saved?.cancelled ?? false);
    setHttp(saved?.http);
    setAdvanced(false);
    setResponseTab("result");
    generation.current++;
    setRunning(false);
    setRunId(saved?.id || "");
    setElapsed(saved?.elapsed || 0);
    return () => {
      const old = request.current;
      request.current = null;
      generation.current++;
      if (old) {
        old.controller.abort();
        void write("/admin/v1/requests/" + old.id + "/cancel", {}).catch(
          () => {},
        );
      }
    };
  }, [storageKey, location.key]);
  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Date.now() - started), 75);
    return () => clearInterval(timer);
  }, [running]);
  const set = (key: string, value: string) =>
    setDraft((d: Entity) => {
      const valueNext = { ...d, [key]: value };
      sessionStorage.setItem(storageKey, JSON.stringify(valueNext));
      return valueNext;
    });
  function buildInput() {
    const input: Entity =
      op === "content"
        ? { url: draft.url || "" }
        : { query: draft.query || "" };
    for (const key of op === "content"
      ? ["max_chars"]
      : op === "list"
        ? ["language", "time_range", "count"]
        : [
            "language",
            "time_range",
            "source_count",
            "max_chars",
            "region",
            "current_time",
          ]) {
      if (draft[key])
        input[key] = ["count", "source_count", "max_chars"].includes(key)
          ? Number(draft[key])
          : draft[key];
    }
    return input;
  }
  async function execute() {
    if (running || !p) return;
    const input = buildInput(),
      defaults = { ...p },
      started = performance.now();
    setSubmitted({ input, defaults });
    setResponseTab("result");
    setCancelled(false);
    setHttp(undefined);
    let status: number | undefined;
    const controller = new AbortController();
    const id = crypto.randomUUID();
    setRunId(id);
    setRunning(true);
    setElapsed(0);
    setResponse(null);
    setError(undefined);
    const seq = ++generation.current;
    request.current = { id, controller, seq };
    const receipt = {
      entry: location.key,
      project,
      op,
      input,
      defaults,
      id,
      result: null,
      elapsed: 0,
      cancelled: false,
    };
    lastDebug.current = receipt;
    try {
      const result = await raw(
        "/admin/v1/projects/" + project + "/debug/" + op,
        {
          method: "POST",
          headers: { "X-Request-ID": id },
          body: JSON.stringify(input),
          signal: controller.signal,
        },
        (code) => {
          status = code;
        },
      );
      if (seq === generation.current) {
        setResponse(result);
        lastDebug.current = {
          ...receipt,
          result,
          http: status,
          elapsed: Math.round(performance.now() - started),
        };
      }
    } catch (error) {
      if (
        seq === generation.current &&
        !(error instanceof DOMException && error.name === "AbortError")
      ) {
        setError(error);
        lastDebug.current = {
          ...receipt,
          error,
          http: status,
          elapsed: Math.round(performance.now() - started),
        };
      }
    } finally {
      if (seq === generation.current) {
        setHttp(status);
        setElapsed(Math.round(performance.now() - started));
        setRunning(false);
        request.current = null;
      }
      void queryClient.invalidateQueries({ queryKey: ["requests"] });
    }
  }
  async function cancel() {
    const job = request.current;
    if (!job) return;
    try {
      await write("/admin/v1/requests/" + job.id + "/cancel", {});
      if (request.current === job) {
        setCancelled(true);
        if (lastDebug.current?.id === job.id)
          lastDebug.current = {
            ...lastDebug.current,
            cancelled: true,
            elapsed,
          };
      }
    } catch (error) {
      if (job.seq === generation.current) setError(error);
    } finally {
      job.controller.abort();
      if (request.current === job) {
        request.current = null;
        generation.current++;
        setRunning(false);
      }
    }
  }
  const p = projects.find((p) => p.id === project);
  return (
    <>
      <Head
        title={t("检索调试", "Search playground")}
        sub={t(
          "使用项目配置运行真实检索、取文与总结。",
          "Run search, article extraction and synthesis with project configuration.",
        )}
      />
      {!project ? (
        <Panel className="resource-empty">
          <FolderPlus size={27} />
          <h2>{t("选择一个项目开始调试", "Select a project to start")}</h2>
          <Link className="text-link" to="/projects">
            {t("创建项目", "Create a project")} →
          </Link>
        </Panel>
      ) : (
        <>
          <div className="debug-project">
            <div className="debug-project-identity">
              <b>{p?.name}</b>
              <span className="code-chip">v{p?.version}</span>
            </div>
            <dl className="debug-bindings">
              {[
                [t("搜索", "Search"), p?.search_pools?.[0]],
                [t("正文", "Reader"), p?.reader_pools?.[0]],
                [
                  t("模型", "Model"),
                  p?.model_endpoint_id ? [p.model_endpoint_id] : [],
                ],
              ].map(([label, ids]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>
                    <OverflowText>{op === "summary" && label === t("正文", "Reader") && p?.summary_snippets_only
                      ? t("已跳过正文获取", "Article retrieval skipped")
                      : ids?.length
                        ? ids.map(name).join(" + ")
                        : t("未配置", "Unconfigured")}</OverflowText>
                  </dd>
                </div>
              ))}
            </dl>
            <Link to={"/projects?resource=" + project}>
              {t("项目配置", "Project configuration")} ↗
            </Link>
          </div>
          <div className="playground-panes">
            <Panel className="playground-composer composer">
              <ViewTabs
                label={t("业务操作", "Business operation")}
                toolbar={
                  <div className="debug-project-picker">
                    <Select
                      label={t("调试项目", "Project")}
                      value={project}
                      change={setProject}
                      options={projects.map((item) => ({
                        value: item.id,
                        label: item.name,
                      }))}
                    />
                  </div>
                }
                value={op}
                change={setOp}
                items={[
                  [
                    "list",
                    <>
                      <List size={14} />
                      {t("搜索列表", "Search list")}
                    </>,
                  ],
                  [
                    "content",
                    <>
                      <FileText size={14} />
                      {t("网页正文", "Article content")}
                    </>,
                  ],
                  [
                    "summary",
                    <>
                      <Layers3 size={14} />
                      {t("综合总结", "Synthesis")}
                    </>,
                  ],
                ]}
              >
                <div className="compose-editor">
                  <div className="editor-label">
                    <label htmlFor="debug-input">
                      {op === "content"
                        ? t("网页 URL", "Page URL")
                        : t("搜索问题", "Search query")}
                    </label>
                    <code>POST /v1/search/{op}</code>
                  </div>
                  <textarea
                    id="debug-input"
                    className="query-input"
                    rows={3}
                    disabled={running}
                    value={draft[op === "content" ? "url" : "query"] || ""}
                    placeholder={
                      op === "content"
                        ? "https://…"
                        : t("输入要检索的问题", "Enter a search query")
                    }
                    onChange={(e) =>
                      set(op === "content" ? "url" : "query", e.target.value)
                    }
                  />
                  <div className="compose-actions">
                    <div>
                      <Btn
                        aria-expanded={advanced}
                        onPress={() => setAdvanced(!advanced)}
                      >
                        <SlidersHorizontal size={15} />
                        {t("参数", "Parameters")}
                      </Btn>
                      <Select
                        label={t("载入样例", "Load sample")}
                        value=""
                        change={(v) => {
                          if (v && !running)
                            set(op === "content" ? "url" : "query", v);
                        }}
                        options={[
                          { value: "", label: t("载入样例", "Load sample") },
                          ...(op === "content"
                            ? [
                                "https://example.com/",
                                "https://www.rust-lang.org/",
                              ]
                            : [
                                t(
                                  "降雨量是如何测量的？",
                                  "How is rainfall measured?",
                                ),
                                t(
                                  "如何识别不同类型的云？",
                                  "How are clouds classified?",
                                ),
                              ]
                          ).map((value) => ({ value, label: value })),
                        ]}
                      />
                    </div>
                    {running ? (
                      <Btn onPress={() => void cancel()}>
                        <Square size={13} />
                        {t("取消请求", "Cancel request")}
                      </Btn>
                    ) : (
                      <Btn
                        primary
                        disabled={
                          !String(
                            draft[op === "content" ? "url" : "query"] || "",
                          ).trim()
                        }
                        test="run"
                        onPress={() => void execute()}
                      >
                        <Play size={14} />
                        {t("运行请求", "Run request")}
                      </Btn>
                    )}
                  </div>
                  {advanced && (
                    <fieldset className="debug-parameters" disabled={running}>
                      <div className="form-grid">
                        {op !== "content" && (
                          <>
                            <LanguagePicker
                              label={t("业务语言", "Business language")}
                              value={draft.language || ""}
                              change={(v) => set("language", v)}
                              emptyLabel={t(
                                "自动（按问题语言）",
                                "Automatic (query language)",
                              )}
                            />
                            <Select
                              label={t("时间范围", "Time range")}
                              value={draft.time_range || ""}
                              change={(v) => set("time_range", v)}
                              options={[
                                { value: "", label: t("不限时间", "Any time") },
                                {
                                  value: "day",
                                  label: t("最近一天", "Last day"),
                                },
                                {
                                  value: "month",
                                  label: t("最近一月", "Last month"),
                                },
                                {
                                  value: "year",
                                  label: t("最近一年", "Last year"),
                                },
                              ]}
                            />
                          </>
                        )}
                        <Field
                          label={
                            op === "content"
                              ? t("正文字数上限", "Article character limit")
                              : op === "list"
                                ? t("结果数量", "Result count")
                                : t("来源数量", "Source count")
                          }
                          type="number"
                          hint={
                            t(
                              "留空使用项目默认：",
                              "Leave empty for the project default: ",
                            ) +
                            (op === "content"
                              ? p?.body_limit
                              : op === "list"
                                ? p?.search_limit
                                : p?.source_limit)
                          }
                          value={
                            draft[
                              op === "content"
                                ? "max_chars"
                                : op === "list"
                                  ? "count"
                                  : "source_count"
                            ] || ""
                          }
                          change={(v) =>
                            set(
                              op === "content"
                                ? "max_chars"
                                : op === "list"
                                  ? "count"
                                  : "source_count",
                              v,
                            )
                          }
                        />
                        {op === "summary" && (
                          <>
                            <Field
                              label={t(
                                "总结字数上限",
                                "Summary character limit",
                              )}
                              hint={
                                t(
                                  "留空使用项目默认：",
                                  "Leave empty for the project default: ",
                                ) + p?.summary_limit
                              }
                              value={draft.max_chars || ""}
                              type="number"
                              change={(v) => set("max_chars", v)}
                            />
                            <Field
                              label={t("调用方地区", "Caller region")}
                              value={draft.region || ""}
                              change={(v) => set("region", v)}
                            />
                            <LocalDateTimePicker value={draft.current_time || ""} change={v=>set("current_time",v)}/>

                          </>
                        )}
                      </div>
                    </fieldset>
                  )}
                </div>
              </ViewTabs>
            </Panel>
            <Panel className="playground-response">
              <ViewTabs
                label={t("响应视图", "Response view")}
                value={responseTab}
                change={setResponseTab}
                heading={<h2>{t("响应", "Response")}</h2>}
                items={[
                  ["result", t("结果", "Result")],
                  ["request", t("请求参数", "Request parameters")],
                ]}
              >
                {responseTab === "request" ? (
                  <RequestParameters
                    op={op}
                    input={submitted?.input || buildInput()}
                    project={submitted?.defaults || p}
                  />
                ) : running ? (
                  <div className="busy" role="status">
                    <i className="spinner" />
                    {t("正在执行请求", "Running request")} ·{" "}
                    {(elapsed / 1000).toFixed(1)} s
                  </div>
                ) : runId ? (
                  <>
                    <div className="response-bar">
                      <Status
                        value={
                          cancelled ? "cancelled" : response?.status || "error"
                        }
                      />
                      {http && <code>HTTP {http}</code>}
                      <code>{elapsed} ms</code>
                      {(response ||
                        cancelled ||
                        (error instanceof ApiError && error.status >= 500)) && (
                        <Link className="text-link" to={"/requests/" + runId}>
                          {t("请求记录", "Request record")}
                          <ArrowRight size={14} />
                        </Link>
                      )}
                    </div>
                    <div className="debug-request-id">
                      <code>{runId}</code>
                      <CopyButton
                        value={runId}
                        label={t("复制请求 ID", "Copy request ID")}
                      />
                    </div>
                    <Notice error={error} />
                    {(response?.warnings || []).map((w: Entity) => (
                      <p className="diag-warning" key={w.code}>
                        {w.message}
                      </p>
                    ))}
                    {cancelled ? (
                      <Empty>{t("请求已取消", "Request cancelled")}</Empty>
                    ) : (
                      response && (
                        <Result
                          result={response}
                          onOpenRange={(source, segment) =>
                            nav(
                              "/requests/" +
                                runId +
                                "?" +
                                new URLSearchParams({
                                  tab: "evidence",
                                  source,
                                  segment,
                                }),
                            )
                          }
                        />
                      )
                    )}
                  </>
                ) : (
                  <Empty>
                    <FlaskConical size={24} />
                    <p>
                      {t(
                        "运行请求后在这里查看结果。",
                        "Run a request to see its result here.",
                      )}
                    </p>
                  </Empty>
                )}
              </ViewTabs>
            </Panel>
          </div>
        </>
      )}
    </>
  );
}
