import { MaterialPreview, ArchivedMaterials } from "./material-preview";
import { testOutcome } from "./request-display";
import { ArrowUpRight } from "lucide-react";
import { CallFacts } from "./call-details";
import { useEffect, useRef } from "react";
import { useQueries } from "@tanstack/react-query";
import { api, type Entity } from "./api";
import { useApp } from "./state";
import { Dialog, Empty, Facts, Notice, Sheet, Status } from "./ui";
import { MarkdownView } from "./search";
import { StageData } from "./stages";

export function ExecutionOverview({
  data,
  jump,
}: {
  data: Entity;
  jump: (tab: string, stage?: string, kind?: string) => void;
}) {
  const { t, resourceName } = useApp();
  const m = data.metadata || {},
    s = data.execution_summary || {};
  const na = t("不适用", "Not applicable"),
    unknown = t("未记录", "Not recorded");
  const names = (kind: string) =>
    s.endpoints?.[kind]?.length
      ? s.endpoints[kind]
          .map((e: Entity) => resourceName(e) || unknown)
          .join(" · ")
      : s.endpoints?.[kind]
        ? t("未调用", "Not called")
        : unknown;
  const answer: Record<string, string> = {
    body: t("网页正文", "Article body"),
    snippet: t("搜索简介", "Search snippet"),
    mixed: t("正文与简介", "Body and snippets"),
    search_results: t("搜索结果", "Search results"),
    none: t("无有效答案", "No answer"),
  };
  const test = m.origin?.endsWith("_test");
  const entries: [string, React.ReactNode, (() => void) | undefined][] = [
    [
      t("业务状态", "Status"),
      <Status value={m.status} />,
      () => jump("evidence"),
    ],
    [
      t("总耗时", "Duration"),
      m.duration_ms == null ? "—" : `${m.duration_ms} ms`,
      () => jump("execution"),
    ],
    [
      t("上游调用", "Upstream calls"),
      m.upstream_calls ?? "—",
      () => jump("calls"),
    ],
    [
      t("检索变体 · 候选去重", "Queries · deduplication"),
      !test && s.retrieval
        ? `${s.retrieval.variant_count ?? "—"} · ${s.retrieval.raw_candidates ?? "≥" + (s.retrieval.known_raw_candidates ?? 0)} → ${s.retrieval.unique_candidates ?? "≥" + (s.retrieval.known_unique_candidates ?? 0)}${s.retrieval.incomplete_variants ? " · " + t("部分检索未完成", "Some searches incomplete") : ""}`
        : na,
      !test && s.retrieval ? () => jump("execution", "dedup") : undefined,
    ],
    [
      t("评分批次", "Score batches"),
      test || s.score_batches == null
        ? na
        : `${s.score_batches.length} · ${s.score_batches.map((b: Entity) => b.candidate_count).join(" / ")}`,
      !test && s.score_batches?.length
        ? () => jump("execution", "score")
        : undefined,
    ],
    [
      t("答案来源", "Answer source"),
      test ? na : answer[s.answer_source] || unknown,
      test ? undefined : () => jump("evidence"),
    ],
    [
      t("记录信息", "Recording"),
      m.incomplete ? t("部分缺失", "Incomplete") : t("完整", "Complete"),
      () => jump("recording"),
    ],
    [
      t("搜索接入点", "Search endpoints"),
      names("search"),
      s.endpoints?.search?.length
        ? () => jump("calls", undefined, "search")
        : undefined,
    ],
    [
      t("正文接入点", "Reader endpoints"),
      names("reader"),
      s.endpoints?.reader?.length
        ? () => jump("calls", undefined, "reader")
        : undefined,
    ],
    [
      t("模型接入点", "Model endpoints"),
      names("model"),
      s.endpoints?.model?.length
        ? () => jump("calls", undefined, "model")
        : undefined,
    ],
  ];
  return (
    <div className="trace-overview execution-overview">
      <dl>
        {entries.map(([label, value, action]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              {action ? (
                <button className="trace-fact-link" onClick={action}>
                  {value}
                  <ArrowUpRight size={11} />
                </button>
              ) : (
                value
              )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function Material({requestId,material,close}: {requestId:string;material:Entity;close:()=>void}) {
  const {t}=useApp();
  return <Dialog layout="wide" title={t("历史回放","Historical replay")} close={close}>
    <MaterialPreview requestId={requestId} material={material}/>
  </Dialog>;
}

export function CandidateSheet({
  requestId,
  candidate: c,
  evidence,
  calls,
  segmentId,
  close,
  selectSegment,
}: {
  requestId: string;
  candidate: Entity;
  evidence: Entity;
  calls: Entity[];
  segmentId: string;
  close: () => void;
  selectSegment: (id: string) => void;
}) {
  const { t } = useApp();
  const highlight = useRef<HTMLElement>(null);
  const related = calls
    .filter(
      (call) =>
        c.reader_call_ids?.includes(call.call_id) ||
        c.hits?.some((h: Entity) => h.call_id === call.call_id),
    )
    .sort(
      (a, b) =>
        String(a.started_at).localeCompare(String(b.started_at)) ||
        a.call_id.localeCompare(b.call_id),
    );
  const spans = useQueries({
    queries: related.map((call) => ({
      queryKey: ["span", requestId, call.span_id],
      queryFn: () =>
        api<Entity>(`/admin/v1/requests/${requestId}/spans/${call.span_id}`),
    })),
  });
  const materials = spans
    .flatMap((query) => query.data?.replay || [])
    .filter(
      (m: Entity) =>
        m.kind === "webpage" &&
        (m.source_id === c.source_id || m.url === c.url),
    );
  const normalized = materials.find((m: Entity) => m.text)?.text || "";
  const segments = (evidence.segments || []).filter(
    (s: Entity) => s.source_id === c.source_id,
  );
  const segment = segments.find((s: Entity) => s.segment_id === segmentId);
  const characters = Array.from(normalized) as string[];
  useEffect(() => {
    highlight.current?.scrollIntoView({ block: "center" });
  }, [segmentId, normalized]);
  return (
    <>
      <Sheet title={c.title || c.url} close={close}>
        <p className="source-address">{c.url}</p>
        <Facts
          items={[
            [
              t("相关性", "Relevance"),
              c.relevant == null
                ? t("未取得合法评分", "No valid score")
                : c.relevant
                  ? t("相关", "Relevant")
                  : t("不相关", "Irrelevant"),
            ],
            [t("评分", "Score"), c.score == null ? "—" : `${c.score} / 100`],
            [t("评分批次", "Score batch"), c.score_batch_id || "—"],
            [
              t("选材原因", "Selection reason"),
              (
                {
                  selected: t("已选中", "Selected"),
                  unscored: t("未评分", "Unscored"),
                  irrelevant: t("不相关", "Irrelevant"),
                  source_limit: t("超出来源上限", "Source limit"),
                } as Entity
              )[c.selection_reason] || "—",
            ],
            [
              t("材料来源", "Material"),
              (
                {
                  reader_body: t("正文接入点", "Reader"),
                  inline_body: t("搜索随附正文", "Inline article"),
                  search_snippet: t("搜索列表", "Search result"),
                  snippet: t("搜索简介回退", "Snippet fallback"),
                } as Entity
              )[c.material] || t("无有效材料", "No usable material"),
            ],
            [t("取文或分析原因", "Material reason"), c.material_reason ? testOutcome(c.material_reason,t) : "—"],
          ]}
        />
        {c.lengths && (
          <Facts
            items={[
              [
                t(
                  "纯文本原始 / 保留字数",
                  "Text original / retained characters",
                ),
                `${c.lengths.text?.original ?? "—"} / ${c.lengths.text?.retained ?? "—"}`,
              ],
              [
                t(
                  "Markdown 原始 / 保留字数",
                  "Markdown original / retained characters",
                ),
                `${c.lengths.markdown?.original ?? "—"} / ${c.lengths.markdown?.retained ?? "—"}`,
              ],
            ]}
          />
        )}
        <h3>{t("逐次取文尝试", "Reader attempts")}</h3>
        {related
          .filter((call) => call.kind === "reader")
          .map((call, index) => (
            <details
              className="source-card reader-attempt"
              key={call.call_id}
              data-call-id={call.call_id}
            >
              <summary>
                {index + 1} · {call.endpoint_name}{" "}
                <Status value={call.status} />
              </summary>
              <CallFacts call={call} />
            </details>
          ))}
        {!c.reader_call_ids?.length && (
          <p className="muted">
            {c.material === "inline_body"
              ? t(
                  "使用搜索随附正文，无独立取文调用。",
                  "Used the inline article; no separate reader call.",
                )
              : t(
                  "没有已发送的独立取文调用。",
                  "No separate reader call was dispatched.",
                )}
          </p>
        )}
        <h3>{t("全部查询命中与原始排名", "Query hits and original ranks")}</h3>
        <StageData value={c.hits} />
        <h3>{t("搜索简介", "Search snippet")}</h3>
        <p className="article">{c.snippet_preview || "—"}</p>
        <h3>{t("分段与最终引用", "Passages and answer citations")}</h3>
        {segments.map((s: Entity) => (
          <section key={s.segment_id} className="source-card">
            <button
              className="row-link"
              onClick={() => selectSegment(s.segment_id)}
            >
              {s.segment_id} · [{s.start_char},{s.end_char}) ·{" "}
              {s.cited ? t("已引用", "Cited") : t("未引用", "Not cited")}
            </button>
            <MarkdownView text={s.summary} />
            {s.segment_id === segmentId && (
              <pre className="code-box">{s.text_preview}</pre>
            )}
          </section>
        ))}
        {!segments.length && (
          <Empty>{t("没有有效分段", "No valid passages")}</Empty>
        )}
        {segment && (
          <>
            <h3>
              {t("归档正文中的原文范围", "Original range in archived text")}
            </h3>
            <p>
              [{segment.start_char},{segment.end_char}) ·{" "}
              {t(
                "Unicode 字符，起点包含、终点不含",
                "Unicode characters, start inclusive and end exclusive",
              )}
            </p>
            {normalized ? (
              <pre className="original-range">
                {characters.slice(0, segment.start_char).join("")}
                <mark ref={highlight}>
                  {characters
                    .slice(segment.start_char, segment.end_char)
                    .join("")}
                </mark>
                {characters.slice(segment.end_char).join("")}
              </pre>
            ) : (
              <p className="notice">
                {t(
                  "未记录完整正文，仅能核对已保存段落。",
                  "Full text is missing; only the recorded passage is available.",
                )}
              </p>
            )}
          </>
        )}
        <h3>{t("当次网页归档", "Captured webpage")}</h3>
        <ArchivedMaterials requestId={requestId} materials={materials}/>
        {spans.map((query, index) => (
          <Notice key={index} error={query.error} />
        ))}
        {!materials.length && (
          <Empty>
            {spans.some((query) => query.isPending)
              ? t("正在读取材料…", "Loading materials…")
              : t("没有可读取的归档材料", "No archived material available")}
          </Empty>
        )}
      </Sheet>

    </>
  );
}
