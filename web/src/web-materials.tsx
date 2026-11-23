import { useQueries } from "@tanstack/react-query";
import { api, type Entity } from "./api";
import { useApp } from "./state";
import { Empty, Facts, Notice, Status } from "./ui";
import { ExecutionTabs } from "./execution-tabs";
import { ArchivedMaterials } from "./material-preview";
import { StagePresentation } from "./stages";
import { preferredMaterialSpan, type MaterialPage } from "./trace-model";
import { testOutcome } from "./request-display";
import { traceValue } from "./trace-labels";
import { MarkdownView } from "./search";

export function WebMaterials({requestId, pages, activeSpanId, calls, record, evidence, select, openCandidate, openCall}: {
  requestId: string;
  pages: MaterialPage[];
  activeSpanId: string;
  calls: Entity[];
  record: Entity;
  evidence: Entity;
  select: (spanId: string) => void;
  openCandidate: (candidateId: string) => void;
  openCall: (callId: string) => void;
}) {
  const {t} = useApp();
  const page = pages.find(page => page.id === activeSpanId || page.attempts.some(s => s.span_id === activeSpanId)) || pages[0];
  const attempt = page?.attempts.find(s => s.span_id === activeSpanId) || (page && preferredMaterialSpan(page));
  const inlineCalls = !page?.attempts.length || page?.candidate?.material === "snippet" ? calls.filter(call => page?.candidate?.hits?.some((hit:Entity) => hit.call_id === call.call_id)) : [];
  const ids = [...new Set([page?.root?.span_id, ...page?.attempts.map(s => s.span_id) || [], ...inlineCalls.map(call => call.span_id)].filter(Boolean))];
  const payloads = useQueries({queries: ids.map(spanId => ({
    queryKey: ["span", requestId, spanId],
    queryFn: () => api<Entity>(`/admin/v1/requests/${requestId}/spans/${spanId}`),
  }))});
  if (!page || !attempt) return <Empty>{t("暂无网页材料", "No webpage materials recorded")}</Empty>;
  const root = payloads.find(q => q.data?.span.span_id === page.root?.span_id)?.data;
  const detail = payloads.find(q => q.data?.span.span_id === attempt.span_id);
  const related = calls.filter(call => call.span_id === attempt.span_id);
  const replay = page.attempts.length ? detail?.data?.replay || [] : payloads.flatMap(q => q.data?.replay || [])
    .filter(m => m.kind !== "model" && (m.source_id === page.candidate?.source_id || m.url === page.url));
  const uniqueReplay = [...new Map<string, Entity>(replay.map((m:Entity) => [m.material_id, {...m, title:page.title || m.title}])).values()];
  const reason = root?.output?.reason || page.candidate?.material_reason;
  const kind = page.candidate?.material || ((root?.output?.segments > 0 || uniqueReplay.length) ? (page.attempts.length ? "reader_body" : "inline_body") : undefined);
  const successful = page.attempts.filter(s => s.status === "success").length;
  const finalSnippet = kind === "snippet" ? [...new Map<string, Entity>(payloads.flatMap(q => q.data?.replay || [])
    .filter(m => m.kind !== "model" && (m.source_id === page.candidate?.source_id || m.url === page.url))
    .map((m:Entity) => [m.material_id, {...m,title:page.title || m.title}])).values()] : [];
  const inspect = <>
    <Notice error={detail?.error}/>
    {detail?.isLoading && <Empty>{t("读取网页材料…", "Loading webpage materials…")}</Empty>}
    {detail?.data && page.attempts.length > 0 && <StagePresentation span={detail.data} record={record} evidence={evidence} openCandidate={openCandidate}/>}
    <ArchivedMaterials requestId={requestId} materials={uniqueReplay}/>
    {detail?.data && !uniqueReplay.length && <p className="muted">{t("此次处理未保存可回放的网页材料。", "No archived webpage was saved for this attempt.")}</p>}
    {!!related.length && <div className="stage-endpoints">{related.map(call => <button className="text-link" key={call.call_id} onClick={() => openCall(call.call_id)}>
      {call.endpoint_name} · {call.execution_ms} {t("毫秒", "ms")} ↗
    </button>)}</div>}
  </>;
  return <ExecutionTabs kind="page" label={t("网页材料", "Webpage materials")} items={pages.map(page => ({
    id:page.id, title:page.title || t("网页材料", "Webpage material"), status:page.status, duration:page.duration,
  }))} value={page.id} change={id => {const next=pages.find(page => page.id===id);if(next)select(preferredMaterialSpan(next).span_id);}}>
    <div className="web-material-page">
      <h3 className="web-material-title">{page.title || t("网页材料", "Webpage material")}</h3>
      <p className="source-address">{page.url}</p>
      <Facts items={[
        [t("材料结果", "Material result"), <Status value={page.status}/>],
        [t("最终采用", "Final material"), kind ? traceValue("material",kind,t) : root ? t("未取得可用材料", "No usable material") : t("正在读取", "Loading")],
        [t("取文尝试", "Reader attempts"), page.attempts.length ? `${page.attempts.length} · ${t("成功", "successful")} ${successful}` : t("无需调用正文接入点", "No reader endpoint was called")],
      ]}/>
      {reason && <p className="notice">{t("材料处理原因：", "Material processing reason: ")}{testOutcome(reason,t)}</p>}
      {kind === "snippet" && <section className="final-snippet">
        <h3>{t("最终采用的搜索简介", "Final search snippet")}</h3>
        {finalSnippet.length ? <ArchivedMaterials requestId={requestId} materials={finalSnippet}/> : <>
          <p className="muted">{t("搜索简介预览", "Search snippet preview")}</p>
          <MarkdownView text={page.candidate?.snippet_preview || ""}/>
        </>}
      </section>}
      {page.attempts.length ? <ExecutionTabs label={t("取文尝试", "Reader attempts")} items={page.attempts.map(span => ({
        id:span.span_id, title:calls.find(call => call.span_id===span.span_id)?.endpoint_name || t("正文接入点", "Reader endpoint"), status:span.status, duration:span.duration_ms,
      }))} value={attempt.span_id} change={select}>{inspect}</ExecutionTabs> : inspect}
    </div>
  </ExecutionTabs>;
}
