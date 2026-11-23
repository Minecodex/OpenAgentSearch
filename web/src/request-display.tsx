import { FileText, Layers3, List } from "lucide-react";
import { useApp } from "./state";
import type { Entity } from "./api";
type Translate = (zh: string, en: string) => string;
export function operationName(value: string, t: Translate) {
  return (
    (
      {
        list: t("搜索列表", "Search list"),
        content: t("网页正文", "Article content"),
        summary: t("综合总结", "Synthesis"),
      } as Record<string, string>
    )[value] || value
  );
}
export function originName(value: string, t: Translate) {
  return (
    (
      {
        business: t("业务请求", "Business"),
        debug: t("调试请求", "Debug"),
        endpoint_test: t("接入点测试", "Endpoint test"),
        proxy_test: t("代理测试", "Proxy test"),
      } as Record<string, string>
    )[value] || value
  );
}
export function requestTitle(record: Entity, t: Translate) {
  return (
    record.query_preview ||
    `${originName(record.origin || "business", t)} · ${operationName(record.operation || "list", t)}`
  );
}
export function Operation({ value }: { value: string }) {
  const { t } = useApp();
  const Icon =
    value === "content" ? FileText : value === "summary" ? Layers3 : List;
  return (
    <span className="operation-label" data-operation={value}>
      <Icon size={15} />
      {operationName(value, t)}
    </span>
  );
}

export function testOutcome(value: string | null | undefined, t: Translate) {
  const outcomes: Record<string, string> = {
    success: t("测试成功", "Test passed"),
    error: t("测试失败", "Test failed"),
    CANCELLED: t("测试已取消", "Test cancelled"),
    UPSTREAM_TIMEOUT: t("上游响应超时", "Upstream timed out"),
    UPSTREAM_UNAVAILABLE: t("上游服务不可用", "Upstream unavailable"),
    UPSTREAM_ERROR: t("上游调用失败", "Upstream call failed"),
    ENDPOINT_RISK_CONTROL: t("搜索或访问受到风控限制", "Access restricted by the provider"),
    SEARCH_ENGINE_UNAVAILABLE: t("搜索引擎不可达或服务异常", "Search engine unavailable"),
    SEARCH_RESULTS_UNAVAILABLE: t("无法读取搜索结果页", "Search results could not be read"),
    STAGE_BUDGET_EXCEEDED: t("阶段处理时限已用尽", "Stage time budget exhausted"),
    DEADLINE_EXCEEDED: t("请求总时限已用尽", "Request deadline exceeded"),
    ACCESS_DENIED: t("目标网页拒绝访问", "The page denied access"),
    URL_NOT_ALLOWED: t("目标地址不符合访问策略", "The destination is not allowed"),
    CONTENT_UNAVAILABLE: t("未能取得有效正文", "No readable article received"),
    MODEL_FAILED: t("模型未完成处理", "Model processing failed"),
    QUERY_REWRITE_FAILED: t("未生成可用的改写查询", "No usable rewritten query"),
    MODEL_CONTEXT_EXCEEDED: t("材料超出模型上下文上限", "Materials exceed model context"),
    MODEL_FORMAT_INVALID: t("模型返回格式不符合要求", "Invalid model response format"),
    PROXY_UNAVAILABLE: t("暂无可用代理出口", "No proxy egress available"),
    PROXY_CONNECTION_FAILED: t("代理连接失败", "Proxy connection failed"),
    SEARCH_FAILED: t("未能取得搜索结果", "Search failed"),
    empty_search_item: t("搜索项没有标题和简介", "Search item has no title or snippet"),
    SERVICE_UNAVAILABLE: t("暂无可用接入点", "No available endpoint"),
    RISK_CONTROL: t("上游触发风控", "Upstream risk control"),
  };
  return value ? outcomes[value] || value : t("未记录", "Not recorded");
}
export function resultPreview(record: Entity, t: Translate) {
  return record.origin?.endsWith("_test")
    ? testOutcome(
        record.response_preview ||
          (record.status === "running" ? null : record.status),
        t,
      )
    : record.response_preview ||
        (record.status === "empty"
          ? t("没有匹配结果", "No matching results")
          : t("未记录摘要", "No preview recorded"));
}
export function timestamp(value: string | undefined, lang: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return new Date(value).toLocaleString(lang === "zh" ? "zh-CN" : "en", {
    hour12: false,
  });
}
