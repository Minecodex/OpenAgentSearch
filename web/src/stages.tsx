import { CacheLookupStage, CacheReadStage } from "./cache-trace";
import { recordedSearchHits } from "./cache-trace-model";
import { traceFields, traceValue } from "./trace-labels";
import { rewriteView } from "./rewrite-view";
import { testOutcome } from "./request-display";
import { useDiagnosticLabel } from "./call-details";
import { CandidateTable } from "./candidate-table";
import { RequestParameters } from "./request-parameters";
import { DataTable } from "./ui";
import type { Entity } from "./api";
import { useApp } from "./state";
import { Facts } from "./ui";
import { MarkdownView, SearchCards, SearchResultRows } from "./search";
const labels: Record<string, [string, string]> = {
  ...traceFields,
  query: ["问题", "Query"],
  url: ["网页地址", "Page URL"],
  language: ["业务语言", "Language"],
  time_range: ["时间范围", "Time range"],
  count: ["结果上限", "Result limit"],
  title: ["标题", "Title"],
  snippet: ["搜索简介", "Snippet"],
  text: ["正文", "Article"],
  body: ["原始正文", "Original article"],
  source_id: ["来源", "Source"],
  segment_id: ["段落", "Passage"],
  candidate_id: ["候选", "Candidate"],
  batch_id: ["评分批次", "Score batch"],
  relevant: ["相关", "Relevant"],
  score: ["评分", "Score"],
  summary: ["总结", "Summary"],
  project_version: ["项目版本", "Project version"],
  raw_candidates: ["原始候选数", "Raw candidates"],
  unique_candidates: ["去重候选数", "Unique candidates"],
  rewrite_count: ["额外改写数", "Additional queries"],
  region: ["调用地区", "Caller region"],
  current_time: ["调用时间", "Caller time"],
  max_chars: ["字数上限", "Character limit"],
  queries: ["改写问题", "Query variants"],
  hits: ["搜索结果", "Search results"],
  scores: ["候选评分", "Candidate scores"],
  candidates: ["候选列表", "Candidates"],
  sources: ["证据来源", "Evidence sources"],
  segments: ["分段材料", "Passages"],
  citations: ["引用", "Citations"],
  code: ["结果原因", "Result reason"],
  media_type: ["原文格式", "Original format"],
  final_url: ["最终地址", "Final URL"],
  archive_body: ["完整网页", "Full webpage"],
  layout: ["布局归档", "Archived layout"],
};
const stages: Record<string, [string, string]> = {
  admit: ["请求准入", "Admission"],
  rewrite: ["问题改写", "Query rewriting"],
  search: ["网页搜索", "Web search"],
  cache_lookup:["缓存检索","Cache lookup"],
  cache_read:["读取缓存正文","Cached article read"],
  dedup: ["候选去重", "Deduplication"],
  score: ["候选评分", "Candidate scoring"],
  materials: ["网页材料", "Webpage materials"],
  source: ["来源处理", "Source preparation"],
  extract: ["提取正文", "Article extraction"],
  segments: ["分段分析", "Passage analysis"],
  compress: ["证据压缩", "Evidence compression"],
  synthesis: ["整体总结", "Synthesis"],
  test: ["连通测试", "Capability test"],
};
export function useStageLabel() {
  const { t } = useApp();
  return (value: string) => (stages[value] ? t(...stages[value]) : value);
}
export function StageData({value, field = ""}: {value: unknown; field?: string}) {
  const {t}=useApp();
  const diagnostic=useDiagnosticLabel();
  const label=(key:string)=>labels[key]?t(...labels[key]):key;
  const scalar=(value:unknown,key=field)=>{
    const formatted=traceValue(key,value,t);
    if(typeof value==="string" && ["code","reason","material_reason"].includes(key)){
      const friendly=diagnostic(value);
      return friendly!==value?friendly:testOutcome(formatted,t);
    }
    return formatted;
  };
  if (value == null) return <p>—</p>;
  if (typeof value !== "object")
    return <p className="article">{scalar(value)}</p>;
  if (Array.isArray(value)) {
    if (!value.length) return <p>{t("没有条目", "No entries")}</p>;
    if (value.every((v) => typeof v !== "object" || v == null))
      return (
        <ol>
          {value.map((v, i) => (
            <li key={i}>{scalar(v)}</li>
          ))}
        </ol>
      );
    const keys = [...new Set(value.flatMap((v) => Object.keys(v || {})))]
      .filter(
        (k) =>
          !k.startsWith("_") &&
          value.some((v) => v[k] == null || typeof v[k] !== "object"),
      )
      .slice(0, 8);
    return (
      <div className="table-scroll">
        <DataTable>
          <DataTable.Header>
            {keys.map((k) => (
              <DataTable.Column key={k}>{label(k)}</DataTable.Column>
            ))}
          </DataTable.Header>
          <DataTable.Body>
            {value.map((v, i) => (
              <DataTable.Row key={i}>
                {keys.map((k) => (
                  <DataTable.Cell
                    key={k}
                    style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                  >
                    {scalar(v?.[k],k)}
                  </DataTable.Cell>
                ))}
              </DataTable.Row>
            ))}
          </DataTable.Body>
        </DataTable>
      </div>
    );
  }
  const fields = Object.entries(value as Entity).filter(
    ([k]) => !k.startsWith("_"),
  );
  return (
    <>
      <Facts
        items={fields
          .filter(([, v]) => v == null || typeof v !== "object")
          .map(([k, v]) => [
            label(k),
            <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {scalar(v,k)}
            </span>,
          ])}
      />
      {fields
        .filter(([, v]) => v != null && typeof v === "object")
        .map(([k, v]) => (
          <details key={k} className="source-card" open={k==="passages" || k==="citations"}>
            <summary>{label(k)}</summary>
            <StageData value={v} field={k} />
          </details>
        ))}
    </>
  );
}
export function StagePresentation({
  span,
  evidence,
  openCandidate,
  record,
  evidenceLoading,
}: {
  span: Entity;
  evidence: Entity;
  record: Entity;
  openCandidate: (id: string) => void;
  evidenceLoading?: boolean;
}) {
  const { t } = useApp();
  const stage = span.span?.stage;
  const rewrite = stage === "rewrite" ? rewriteView(span,evidence,record) : null;
  if (stage === "admit" && record.snapshot?.project)
    return (
      <RequestParameters
        op={record.metadata.operation}
        input={record.request_payload || {}}
        project={record.snapshot.project}
      />
    );
  const test = record.metadata.origin.endsWith("_test");
  return (
    <>
          {span.output?.search_readiness && <Facts items={[
            [t("卡片等待结果","Card readiness"),({ai_answer_ready:t("AI 回答已完成并稳定","AI answer complete and stable"),material_ready:t("搜索材料已就绪","Search material ready"),deadline_material:t("预算到期，交付已有材料","Budget reached; returning available material")} as Record<string,string>)[span.output?.search_readiness.return_reason] || "—"],
            [t("AI 回答状态","AI answer state"),({none:t("未发现","Not found"),pending:t("未完成或缺少引用","Incomplete or missing citations"),ready:t("已完成","Complete")} as Record<string,string>)[span.output?.search_readiness.answer_state] || "—"],
            [t("普通卡片","Ordinary cards"),span.output?.search_readiness.card_count],
            [t("提交后耗时","Elapsed after submission"),span.output?.search_readiness.elapsed_ms+" ms"],
          ]} />}
      {stage === "cache_lookup"
        ? <CacheLookupStage span={span} evidence={evidence} record={record} loading={evidenceLoading} openCandidate={openCandidate} />
        : <SearchCards cards={span.output?.cards || []} className="source-card" />}
      {stage === "cache_read" && <CacheReadStage span={span} evidence={evidence} record={record} openCandidate={openCandidate} />}
      {!test && stage === "rewrite" && (
        <>
        {rewrite && <Facts items={[
          [t("请求改写数","Requested rewrites"),rewrite.requested],
          [t("有效改写数","Usable rewrites"),rewrite.used],
          [t("处理结果","Outcome"),({used:t("已生成有效查询","Usable queries generated"),fallback:t("已回退原问题","Original-query fallback"),failed:t("未生成可用查询","No usable query")} as Record<string,string>)[rewrite.state]],
          [t("回退原因","Fallback reason"),rewrite.fallback_reason==="no_usable_rewrite"?t("重复、空白或无效改写","Duplicate, blank or invalid rewrites"):rewrite.fallback_reason?testOutcome(rewrite.fallback_reason,t):"—"],
        ]} />}
        <div className="variant-cards">
          {[
            { variant_id: "Q0", query: span.input?.query },
            ...(rewrite?.entries || []),
          ].map((q: Entity, index: number) => (
            <article className="source-card" key={q.variant_id || q.state+index}>
              <small>{q.variant_id || ({duplicate_original:t("与原问题重复，未搜索","Duplicate original; not searched"),duplicate_rewrite:t("重复改写，未搜索","Duplicate rewrite; not searched"),invalid:t("无效改写，未搜索","Invalid rewrite; not searched"),over_limit:t("超出数量，未搜索","Beyond limit; not searched"),not_searched:t("未执行该查询","Query not executed")} as Record<string,string>)[q.state]}{q.variant_id === "Q0" && record.snapshot?.project?.search_original_query === false
                ? t(" · 仅作评分和总结依据，不参与搜索", " · Scoring and synthesis context; excluded from search") : ""}</small>
              <p>{q.query}</p>
            </article>
          ))}
        </div>
        </>
      )}
      {!test && stage === "search" && Array.isArray(span.output?.hits) && (
        <>
          <h3>
            {span.input?.variant_id} · {span.input?.query}
          </h3>
          <p>
            {t("原始命中", "Raw hits")} {span.output?.hits?.length ?? "—"} ·{" "}
            {t("唯一网页", "Unique pages")}{" "}
            {
              new Set(
                (span.output?.hits || []).map(
                  (h: Entity) => h.url?.split("#")[0],
                ),
              ).size
            }
          </p>
          <div className="hit-list"><SearchResultRows
            items={recordedSearchHits(span.output.hits, evidence.candidates || [])}
            openCandidate={openCandidate} /></div>
        </>
      )}
      {!test && stage === "score" && (
        <>
          <h3>
            {t("评分批次", "Score batch")} · {span.input?.batch_id}
          </h3>
          <CandidateTable candidates={evidence.candidates || (span.input?.candidates || []).map((c:Entity)=>({
            ...c,...span.output?.scores?.find((score:Entity)=>score.candidate_id===c.candidate_id),
          }))} openCandidate={openCandidate}/>

        </>
      )}
      {stage === "source" && <p className="muted">
        {t("来源处理为已选网页准备总结材料，并记录正文可用性与处理结果。提取正文阶段展示各接入点的取文尝试。",
           "Source preparation records the usable evidence and processing result for a selected page. Article extraction shows each reader attempt.")}
      </p>}
      {!test && stage === "segments" && (
        <>
          <h3>
            {span.input?.source_id} · {span.input?.segment_id}
          </h3>
          <MarkdownView text={span.output?.summary || ""} />
        </>
      )}
      {stage === "dedup" && evidence.candidates?.length > 0 && (
        <div className="stage-candidates">
          {evidence.candidates.map((c: Entity) => (
            <button
              key={c.candidate_id}
              className="candidate-row"
              onClick={() => openCandidate(c.candidate_id)}
            >
              <span>
                <b>{c.title || c.url}</b>
                <small>
                  {c.hits?.length ?? "—"} {t("次命中", "hits")}
                </small>
              </span>
              <small>{c.score ?? "—"} / 100</small>
            </button>
          ))}
        </div>
      )}
      {!(stage === "cache_lookup" || stage === "cache_read") && (test ||
        ![
          "search",
          "dedup",
          "rewrite",
          "score",
          "extract",
          "segments",
        ].includes(stage) ||
        !span.output ||
        span.output?.code) && (
        <>
          <h3>{t("实际输入", "Actual input")}</h3>
          <StageData value={span.input} />
          <h3>{t("实际输出", "Actual output")}</h3>
          <StageData value={span.output} />
        </>
      )}

      <details>
        <summary>{t("原始执行载荷", "Raw execution payload")}</summary>
        <pre className="code-box">
          {JSON.stringify({ input: span.input, output: span.output }, null, 2)}
        </pre>
      </details>
    </>
  );
}
