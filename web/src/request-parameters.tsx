import { traceValue } from "./trace-labels";
import { useApp } from "./state";
import { Facts } from "./ui";
import type { Entity } from "./api";

export function RequestParameters({
  op,
  input,
  project,
}: {
  op: string;
  input: Entity;
  project?: Entity;
}) {
  const { t } = useApp();
  const inherited = (key: string, defaultKey: string) =>
    input[key] ??
    (project?.[defaultKey] == null
      ? "—"
      : String(project[defaultKey]) + " · " + t("项目默认", "Project default"));
  const rows: [string, string][] =
    op === "content"
      ? [
          [t("网页 URL", "Article URL"), input.url],
          [
            t("正文字符上限", "Article character limit"),
            inherited("max_chars", "body_limit"),
          ],
        ]
      : [
          [t("搜索问题", "Search query"), input.query],
          [
            t("业务语言", "Business language"),
            input.language ??
              (project?.default_language
                ? inherited("language", "default_language")
                : t("自动（按问题语言）", "Automatic (query language)")),
          ],
          [
            t("时间范围", "Time range"),
            input.time_range ? traceValue("time_range",input.time_range,t) : t("不限时间", "Any time"),
          ],
        ];
  if (op === "list")
    rows.push([
      t("结果数", "Result limit"),
      inherited("count", "search_limit"),
    ]);
  if (op === "summary") {
    rows.push(
      [
        t("来源上限", "Source limit"),
        inherited("source_count", "source_limit"),
      ],
      [
        t("总结字数上限", "Summary character limit"),
        inherited("max_chars", "summary_limit"),
      ],
    );
    if (input.region)
      rows.push([t("调用方地区", "Caller region"), input.region]);
    if (input.current_time)
      rows.push([
        t("带偏移的当地时间", "Local time with offset"),
        input.current_time,
      ]);
  }
  return <Facts items={rows} />;
}
