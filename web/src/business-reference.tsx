import { useState } from "react";
import { Copy, FlaskConical } from "lucide-react";
import { Link } from "react-router-dom";
import type { Entity } from "./api";
import { useApp } from "./state";
import { Btn, DataTable, Notice, Panel } from "./ui";

function rows(schema: Entity, prefix = "", depth = 0): Entity[] {
  const fields = Object.entries(schema.properties || {}).map(([key, raw]) => {
    const field = raw as Entity;
    const name = prefix ? prefix + "." + key : key;
    const nested = field.type === "array" ? field.items : field;
    return [
      { name, field, required: schema.required?.includes(key) || false },
      ...(depth < 5 && nested?.properties ? rows(nested, name + (field.type === "array" ? "[]" : ""), depth + 1) : [])
    ];
  });
  return fields.flat();
}
function FieldTable({ schema }: { schema: Entity }) {
  const { t } = useApp();
  return (
    <DataTable>
      <DataTable.Header>
        {[t("字段", "Field"), t("类型与必填", "Type and requirement"), t("用途、默认值和限制", "Purpose, defaults and limits")].map(label => <DataTable.Column key={label}>{label}</DataTable.Column>)}
      </DataTable.Header>
      <DataTable.Body>
        {rows(schema).map(({ name, field, required }) => (
          <DataTable.Row key={name}>
            <DataTable.Cell><code>{name}</code></DataTable.Cell>
            <DataTable.Cell>
              {Array.isArray(field.type) ? field.type.join(" | ") : field.type || field.anyOf?.map((s: Entity) => s.type).join(" | ") || (field.const != null ? typeof field.const : "object")}
              <small className="row-sub">{required ? t("必填", "Required") : t("可选", "Optional")}</small>
            </DataTable.Cell>
            <DataTable.Cell>
              {t(field.description || "", field["x-description-en"] || field.description || "")}
              {field.enum && <small className="row-sub">{field.enum.join(" / ")}</small>}
              {(field.minimum != null || field.maximum != null || field.maxLength != null) && <small className="row-sub">
                {field.minimum != null && "≥ " + field.minimum + " "}
                {field.maximum != null && "≤ " + field.maximum + " "}
                {field.maxLength != null && t("最多字符数 ", "Maximum characters ") + field.maxLength}
              </small>}
            </DataTable.Cell>
          </DataTable.Row>
        ))}
      </DataTable.Body>
    </DataTable>
  );
}

export function BusinessReference({ doc }: { doc: Entity }) {
  const { t } = useApp();
  const [example, setExample] = useState("complete");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<unknown>();
  const sample = doc.examples[example].value;
  const op = doc.path.split("/").at(-1);
  const command = [
    `curl -X POST '${location.origin}${doc.path}'`,
    "  -H 'Authorization: Bearer <PROJECT_KEY>'",
    "  -H 'Content-Type: application/json'",
    "  -H 'Accept-Language: zh-CN'",
    `  --data-raw '${JSON.stringify(sample)}'`
  ].join(" \\\n");
  const headers = {
    required: ["Authorization", "Content-Type"],
    properties: {
      Authorization: { type: "string", description: "Bearer <PROJECT_KEY>。使用创建或轮换项目时获得的项目密钥，按该项目的资源和限额执行。", "x-description-en": "Bearer <PROJECT_KEY>. Use the project key issued when creating or rotating the project. Its resources and limits apply." },
      "Content-Type": { type: "string", description: "application/json，请求体为 JSON 对象。", "x-description-en": "application/json. The request body is a JSON object." },
      ...Object.fromEntries(doc.parameters.map((p: Entity) => [p.name, { ...p.schema, description: p.description, "x-description-en": p["x-description-en"] }]))
    }
  };
  return (
    <Panel className="reference-detail business-reference">
      <div className="reference-title"><span className="method">POST</span><code>{doc.path}</code></div>
      <h2>{t(doc.summary, op === "list" ? "Search results" : op === "content" ? "Article content" : "Search synthesis")}</h2>
      <p>{t(doc.description, doc.englishDescription)}</p>
      <section>
        <h3>{t("身份与请求头", "Authentication and headers")}</h3>
        <FieldTable schema={headers} />
      </section>
      <section>
        <h3>{t("请求参数", "Request parameters")}</h3>
        <p>{t("可选字段可直接省略。显式 null、未知字段和错误类型会返回参数错误。数量须为 JSON 整数，字符数按 Unicode 字符计。", "Omit optional fields when unused. Explicit nulls, unknown fields and incorrect types are rejected. Counts must be JSON integers. Lengths count Unicode characters.")}</p>
        <FieldTable schema={doc.input} />
      </section>
      <section>
        <h3>{t("调用示例", "Calling the API")}</h3>
        <div className="reference-example-actions">
          <Btn onPress={() => { setExample(example === "complete" ? "minimal" : "complete"); setCopied(false); }}>{example === "complete" ? t("只看必填参数", "Show required fields only") : t("包含可选参数", "Include optional fields")}</Btn>
          <Btn onPress={async () => { try {await navigator.clipboard.writeText(command);setCopied(true);setError(undefined)}catch(e){setError(e)} }}><Copy size={15}/>{copied ? t("已复制", "Copied") : t("复制 cURL", "Copy cURL")}</Btn>
          <Link className="ui-btn oas-button primary" to={"/playground?" + new URLSearchParams({ sample: JSON.stringify(sample), op })}><FlaskConical size={15}/>{t("载入调试台", "Load in playground")}</Link>
        </div>
        <Notice error={error}/>
        <pre className="code-box">{command}</pre>
      </section>
      <section>
        <h3>{t("成功响应字段", "Success response fields")}</h3>
        <p>{t("嵌套字段的必填标记在其父对象存在时生效。status 为 partial 时检查 warnings，empty 表示正常完成但没有匹配内容。", "Nested required fields apply when the parent object exists. Inspect warnings for partial results. empty indicates completed processing without matching content.")}</p>
        <FieldTable schema={doc.outputs["200"].schema}/>
        <h3>{t("成功响应示例", "Success response example")}</h3>
        <pre className="code-box">{JSON.stringify(doc.outputs["200"].example, null, 2)}</pre>
      </section>
      <section>
        <h3>{t("错误与状态", "Errors and statuses")}</h3>
        <p>{t("HTTP 200 可为 success、partial 或 empty。请求失败时 data 为 null，根据 error.code 判断原因。error.message 用于展示，request_id 用于追踪。", "HTTP 200 may contain success, partial or empty. On failure, data is null. Handle error.code programmatically, display error.message and use request_id for tracing.")}</p>
        <DataTable>
          <DataTable.Header><DataTable.Column>HTTP</DataTable.Column><DataTable.Column>{t("含义", "Meaning")}</DataTable.Column></DataTable.Header>
          <DataTable.Body>{[
            ["400",t("参数、项目限额或时间窗口能力不满足", "Invalid parameters, project limits or time-window capabilities")],
            ["401",t("项目密钥无效或缺失", "Missing or invalid project key")],
            ["413",t("请求体超过字节限制", "Request body exceeds the byte limit")],
            ["429",t("速率或容量不足，有建议时返回 Retry-After 秒数", "Rate or capacity limit. Retry-After seconds may be returned")],
            ["500",t("服务内部错误", "Internal server error")],
            ["502",t("上游、内容或模型失败，详细原因见 error.code", "Upstream, content or model failure. See error.code")],
            ["503",t("可用接入点或出口不足", "No available endpoint or egress")],
            ["504",t("同步请求总时限耗尽", "Synchronous request deadline exceeded")]
          ].map(([status,description])=><DataTable.Row key={status}><DataTable.Cell>{status}</DataTable.Cell><DataTable.Cell>{description}</DataTable.Cell></DataTable.Row>)}</DataTable.Body>
        </DataTable>
        <FieldTable schema={doc.outputs["400"].schema}/>
        <pre className="code-box">{JSON.stringify(doc.outputs["400"].example,null,2)}</pre>
      </section>
    </Panel>
  );
}
