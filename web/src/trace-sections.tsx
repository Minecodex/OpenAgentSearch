import { useState } from "react";
import { FileText, FlaskConical, Search } from "lucide-react";
import { useApp } from "./state";
import { CopyButton } from "./copy-button";
import type { Entity } from "./api";
import { Empty, Facts, Panel, Status } from "./ui";
import {
  originName,
  requestTitle,
  resultPreview,
  testOutcome,
  timestamp,
} from "./request-display";
import { ProbeDetails, SearchAttempts } from "./call-details";

export function TraceHeading({
  data,
  variants,
  select,
}: {
  data: Entity;
  variants: Entity[];
  select: (key: string) => void;
}) {
  const { t, language } = useApp();
  const [expanded, setExpanded] = useState(false);
  const m = data.metadata,
    input = data.request_payload,
    response = data.response_payload;
  const test = m.origin.endsWith("_test");
  const title =
    input?.query || input?.url || input?.resource_name || requestTitle(m, t);
  const text = test
    ? testOutcome(
        response?.data?.reason || response?.data?.status || m.response_preview,
        t,
      )
    : response?.error?.message ||
      response?.data?.summary ||
      response?.data?.text ||
      resultPreview(m, t);
  return (
    <div className="trace-summary-grid">
      <section>
        <span className="section-label">
          {test ? <FlaskConical size={15} /> : <Search size={15} />}
          {test
            ? t("被测资源", "Tested resource")
            : m.operation === "content"
              ? t("网页地址", "Article URL")
              : t("输入问题", "Input question")}
        </span>
        <div className="trace-question">
          <h2>{title}</h2>
          <CopyButton
            value={title}
            label={t("复制请求内容", "Copy request input")}
          />
        </div>
        <small className="row-sub">
          <code>{m.request_id}</code> · {originName(m.origin, t)} ·{" "}
          {timestamp(m.started_at, language)}
        </small>
        {variants.length > 1 && (
          <div className="query-variants">
            {variants.slice(1).map((v) => (
              <button key={v.variant_id} onClick={() => select(v.variant_id)}>
                <b>{v.variant_id}</b> {v.query}
              </button>
            ))}
          </div>
        )}
      </section>
      <section>
        <span className="section-label">
          <FileText size={15} />
          {test
            ? t("测试结果", "Test outcome")
            : t("结果摘要", "Result preview")}
        </span>
        <p className={expanded ? "" : "clamped"}>{text}</p>
        {text.length > 90 && (
          <button className="text-link" onClick={() => setExpanded(!expanded)}>
            {expanded ? t("收起", "Collapse") : t("展开全文", "Expand answer")}
          </button>
        )}
        {test && response?.data?.reason && (
          <code className="row-sub">{response.data.reason}</code>
        )}
      </section>
    </div>
  );
}
export function TestReceipt({ data }: { data: Entity }) {
  const { t, language } = useApp(),
    m = data.metadata,
    receipt = data.response_payload?.data;
  if (!receipt)
    return <Empty>{t("尚无测试回执", "No test receipt recorded")}</Empty>;
  return (
    <>
      <h2>{t("测试回执", "Test receipt")}</h2>
      <Facts
        items={[
          [
            t("被测资源", "Tested resource"),
            data.request_payload?.resource_name || m.query_preview || "—",
          ],
          [
            t("资源版本", "Resource version"),
            receipt.resource_version == null
              ? "—"
              : "v" + receipt.resource_version,
          ],
          [t("测试状态", "Test status"), <Status value={m.status} />],
          [
            t("原因", "Reason"),
            testOutcome(receipt.reason || receipt.status, t),
          ],
          [t("完成时间", "Finished"), timestamp(receipt.tested_at, language)],
          [
            t("总耗时", "Duration"),
            receipt.elapsed_ms == null ? "—" : receipt.elapsed_ms + " ms",
          ],
        ]}
      />
      <SearchAttempts attempts={receipt.search_attempts} />
      {receipt.diagnostics && <ProbeDetails value={receipt.diagnostics} />}
    </>
  );
}
export function Snapshot({ data }: { data: Entity }) {
  const { t, resourceName } = useApp(),
    snapshot = data.snapshot,
    project = snapshot?.project;
  if (!project)
    return (
      <Panel>
        <Empty>
          {t(
            "本次记录没有项目配置快照",
            "No project configuration was recorded for this request",
          )}
        </Empty>
      </Panel>
    );
  const endpoint = (id: string) => {
    const e = snapshot.endpoints?.find((e: Entity) => e.id === id);
    return e ? resourceName(e) : t("未记录名称", "Name not recorded");
  };
  const pools = (groups?: string[][]) =>
    groups?.map((group) => group.map(endpoint).join(" + ")).join(" → ") || "—";
  return (
    <Panel>
      <h2>{t("配置快照", "Configuration snapshot")}</h2>
      <Facts
        items={[
          [t("项目", "Project"), project.name],
          [t("配置版本", "Config version"), "v" + project.version],
          [t("搜索接入点池", "Search pools"), pools(project.search_pools)],
          [t("正文接入点池", "Reader pools"), pools(project.reader_pools)],
          [
            t("生成模型", "Model"),
            project.model_endpoint_id
              ? endpoint(project.model_endpoint_id)
              : t("未绑定", "Unbound"),
          ],
          ...(project.default_language
            ? [
                [
                  t("当时的默认业务语言", "Recorded default language"),
                  project.default_language,
                ] as [string, string],
              ]
            : []),
          [
            t("搜索 / 来源上限", "Search / source limit"),
            project.search_limit + " / " + project.source_limit,
          ],
          [
            project.summary_snippets_only
              ? t("搜索材料 / 总结字数上限", "Search material / summary character limits")
              : t("正文 / 总结字数上限", "Article / summary character limits"),
            project.body_limit + " / " + project.summary_limit,
          ],
          [t("额外改写数量", "Additional queries"), project.rewrite_count],
          [t("原问题参与搜索", "Search original query"), (project.search_original_query ?? true) ? t("是", "Yes") : t("否", "No")],
          [
            t("总结材料", "Summary material"),
            project.summary_snippets_only
              ? t("搜索列表标题和简介", "Search titles and snippets")
              : t("网页正文", "Page content"),
          ],
          [t("语言路由版本", "Routing version"), snapshot.routes_version],
        ]}
      />
    </Panel>
  );
}
export function Recording({ data }: { data: Entity }) {
  const { t, language } = useApp(),
    m = data.metadata;
  const reasons: Record<string, string> = {
    diagnostics_pending: t("诊断材料整理中", "Diagnostics pending"),
    execution_interrupted: t("执行中断", "Execution interrupted"),
  };
  return (
    <Panel>
      <h2>{t("记录信息", "Recording")}</h2>
      <Facts
        items={[
          [
            t("完整性", "Completeness"),
            m.status === "running"
              ? t("执行中", "In progress")
              : m.incomplete
                ? t("部分缺失", "Incomplete")
                : t("完整", "Complete"),
          ],
          [t("请求 ID", "Request ID"), m.request_id],
          [t("记录类型", "Record type"), originName(m.origin, t)],
          [t("开始时间", "Started"), timestamp(m.started_at, language)],
          [t("保留天数", "Retention days"), m.retention_days],
          [t("到期时间", "Expires"), timestamp(m.expires_at, language)],
          [
            t("警告", "Warnings"),
            data.response_payload?.warnings
              ?.map((w: Entity) => w.message || w.code)
              .join(" · ") || "—",
          ],
          [
            t("缺失原因", "Missing materials"),
            data.incomplete_reasons
              .map((r: string) => reasons[r] || r)
              .join(" · ") || "—",
          ],
        ]}
      />
    </Panel>
  );
}
