import type { Entity } from "./api";
import { cacheLookupView } from "./cache-trace-model";
import { EngineAnswer, SearchCards, SearchResultRows } from "./search";
import { useApp } from "./state";
import { Empty } from "./ui";

type TextPair = [string, string];
const reviewStates: Record<string, TextPair> = {
  no_candidates: ["没有符合条件的近义候选", "No eligible semantic candidates"],
  verified: ["已完成材料复核", "Evidence reviewed"],
  uncalibrated: ["该语言尚未启用近义复用", "Semantic reuse is not enabled for this language"],
  material_changed: ["复核后来源已变更", "Source changed after verification"],
  fallback: ["复核未完成", "Verification did not complete"],
};
const verdicts: Record<string, TextPair> = {
  reusable: ["材料可复用", "Reusable evidence"],
  insufficient: ["材料不足", "Insufficient evidence"],
  conflict: ["内容冲突", "Conflicting evidence"],
};
const failures: Record<string, TextPair> = {
  CACHE_LOOKUP_TIMEOUT: ["检索超时", "Lookup timed out"],
  DEADLINE_EXCEEDED: ["超出时间预算", "Deadline exceeded"],
  CACHE_MATCHER_PROFILE_MISMATCH: ["匹配器版本不一致", "Matcher profile mismatch"],
  CACHE_MATCHER_PROTOCOL: ["匹配器返回了无效结果", "Invalid matcher response"],
  CACHE_MATCHER_UNAVAILABLE: ["匹配器不可用", "Matcher unavailable"],
  CACHE_LOOKUP_UNAVAILABLE: ["缓存检索不可用", "Cache lookup unavailable"],
  CACHE_UNAVAILABLE: ["缓存服务不可用", "Cache service unavailable"],
  CANCELLED: ["检索已取消", "Lookup cancelled"],
};

function useSourceCaption(record: Entity) {
  const { t, resourceName, language } = useApp();
  return (source: Entity) => {
    const endpoint = record.snapshot?.endpoints?.find((e: Entity) => e.id === source.source);
    const name = endpoint ? resourceName(endpoint) : t("未记录接入点名称", "Endpoint name not recorded");
    const at = source.collected_at == null ? null : new Date(source.collected_at);
    return at && Number.isFinite(at.getTime())
      ? name + " · " + at.toLocaleString(language === "zh" ? "zh-CN" : "en-US")
      : name;
  };
}

type StageProps = {
  span: Entity;
  record: Entity;
  evidence: Entity;
  openCandidate: (id: string) => void;
  loading?: boolean;
};

export function CacheLookupStage({ span, record, evidence, openCandidate, loading }: StageProps) {
  const { t, language } = useApp();
  const caption = useSourceCaption(record);
  const view = cacheLookupView(span, evidence);
  const { output, snapshots, reviewed, hits, query, exact } = view;
  const verification = output.verification;
  const cards = output.cards || [];
  const answer = output.engine_answer;
  const outcome = output.bypass ? t("缓存旁路", "Cache bypassed")
    : output.hit && output.degraded ? t("降级后精确命中", "Exact hit after fallback")
    : output.hit && exact && (output.questions?.length || 0) > 1 ? t("精确与近义命中", "Exact and semantic hits")
    : output.hit && exact ? t("精确命中", "Exact cache hit")
    : output.hit ? t("缓存命中", "Cache hit")
    : output.hit === false ? t("缓存未命中", "Cache miss")
    : t("未记录缓存结果", "Cache outcome not recorded");
  const percent = new Intl.NumberFormat(language === "zh" ? "zh-CN" : "en-US", { style: "percent", maximumFractionDigits: 1 });
  const reason = verification?.reason || output.code;
  const reviewState = reviewStates[verification?.state];
  return <section className="cache-stage" aria-label={t("缓存检索详情", "Cache lookup details")}>
    {query && <h3>{query}</h3>}
    <p className="cache-stage-meta"><strong>{outcome}</strong>
      {(view.recorded || hits.length > 0) && <span>{hits.length} {t("条网页结果", "web results")}</span>}
      {output.search_needed && <span>{t("需要后台补搜", "Background search needed")}</span>}
    </p>
    {snapshots.length > 0 && <section className="cache-source-list" aria-label={t("命中来源", "Matched sources")}>
      <h4>{t("命中来源", "Matched sources")}</h4>
      <ul>{snapshots.map((s, index) => <li key={s.snapshot_id || index}>
        {s.query && s.query !== query && <strong>{s.query} · </strong>}
        {!s.query && <span>{t("历史问句未记录", "Historical query not recorded")} · </span>}
        {caption(s)}
      </li>)}</ul>
    </section>}
    {(cards.length > 0 || answer || hits.length > 0) && <div className="hit-list">
      <SearchCards cards={cards} />
      {answer && <EngineAnswer answer={answer} />}
      <SearchResultRows items={hits} openCandidate={openCandidate} sourceCaption={snapshots.length > 1 ? item => {
        const source = snapshots.find(s => s.snapshot_id === item.cache?.snapshot_id);
        return source ? [source.query, caption(source)].filter(Boolean).join(" · ") : undefined;
      } : undefined} />
    </div>}
    {output.hit && !cards.length && !answer && !hits.length && <Empty>
      {loading ? t("正在读取网页明细…", "Loading result details…") : view.recorded
        ? t("本次未返回网页链接", "This lookup returned no page links")
        : t("本次记录未保存网页明细", "Page details were not recorded for this lookup")}
    </Empty>}
    {verification && !(verification.state === "no_candidates" && exact) && <section className="cache-review">
      <h4>{t("近义复核", "Semantic verification")}</h4>
      <p>{reviewState ? t(...reviewState) : t("未记录复核状态", "Verification state not recorded")}
        {reason && failures[reason] && <> · {t(...failures[reason])}</>}
        {verification.threshold != null && <> · {t("放行阈值", "Threshold")} {percent.format(verification.threshold)}</>}
      </p>
      {reviewed.length > 0 && <ul>{reviewed.map(({ id, question, decision, selected }: {id: string; question?: string; decision?: Entity; selected: boolean}) => <li key={id}>
        <strong>{question || t("历史问句未记录", "Historical query not recorded")}</strong>
        <span>{decision && verdicts[decision.label] ? t(...verdicts[decision.label]) : t("未评分", "Not scored")}
          {typeof decision?.reusable_score === "number" && <> · {t("可复用得分", "Reuse score")} {percent.format(decision.reusable_score)}</>}
          {selected && <> · {t("已采用", "Used")}</>}</span>
      </li>)}</ul>}
    </section>}
  </section>;
}

export function CacheReadStage({ span, record, evidence, openCandidate }: StageProps) {
  const { t } = useApp();
  const caption = useSourceCaption(record);
  const url = span.input?.url;
  const candidate = url && evidence.candidates?.find((c: Entity) => c.url === url);
  const archived = span.replay?.find((m: Entity) => m.kind === "webpage" && (m.url === url || !url));
  const origin = span.diagnostics?.cache;
  const out = span.output || {};
  const label = out.hit ? t("正文缓存命中", "Article cache hit") : out.code || span.span?.status === "error"
    ? t("正文缓存读取失败", "Article cache read failed") : out.hit === false
      ? t("正文缓存未命中", "Article cache miss") : t("未记录缓存结果", "Cache outcome not recorded");
  return <section className="cache-stage" aria-label={t("正文缓存详情", "Article cache details")}>
    <p className="cache-stage-meta"><strong>{label}</strong>{origin && <span>{caption(origin)}</span>}
      {out.source_status && <span>HTTP {out.source_status}</span>}</p>
    {url && <div className="hit-list"><SearchResultRows items={[{
      url, title: out.title || archived?.title || candidate?.title,
      snippet: candidate?.snippet_preview, candidate_id: candidate?.candidate_id,
    }]} openCandidate={openCandidate} /></div>}
  </section>;
}
