import { useState } from "react";
import { BusinessReference } from "./business-reference";
import { ChevronRight, Copy, FlaskConical } from "lucide-react";
import { Link } from "react-router-dom";
import businessUrl from "./generated/business.openapi.json?url";
import managementUrl from "./generated/management.openapi.json?url";
import { operationName } from "./request-display";
import { RequestParameters } from "./request-parameters";
import reference from "./generated/reference.json";
import { useApp } from "./state";
import { Btn, DataTable, Empty, Head, Notice, Panel, ViewTabs } from "./ui";
import { SearchBox } from "./filter-controls";
import type { Entity } from "./api";

type Operation = (typeof reference)[number];
const operationKey = (doc: Operation) => doc.method + " " + doc.path;
const docTitle = (doc: Operation, t: (zh: string, en: string) => string) =>
  doc.group === "business"
    ? operationName(doc.path.split("/").at(-1)!, t)
    : t(doc.summary, doc.english);
const groupOf = (doc: Operation) =>
  doc.path.startsWith("/health/") ? "health" : doc.group;

export function Reference() {
  const { t } = useApp();
  const [group, setGroup] = useState("business"),
    [query, setQuery] = useState(""),
    [selected, setSelected] = useState("");
  const groups: [string, string][] = [
    ["business", t("业务 API", "Business API")],
    ["management", t("管理 API", "Management API")],
    ["health", t("健康探针", "Health checks")],
  ];
  const match = query.trim().toLowerCase();
  const matches = reference.filter((doc) =>
    `${doc.method} ${doc.path} ${doc.summary} ${doc.english}`
      .toLowerCase()
      .includes(match),
  );
  const activeGroup = matches.some((doc) => groupOf(doc) === group)
    ? group
    : groupOf(matches[0] || reference[0]);
  const operations = matches.filter((doc) => groupOf(doc) === activeGroup);
  const current =
    operations.find((doc) => operationKey(doc) === selected) || operations[0];
  return (
    <>
      <Head
        title={t("API 文档", "API reference")}
        sub={t(
          "查看请求字段、身份要求和响应状态。",
          "Browse request fields, authentication and response statuses.",
        )}
      >
        <a
          className="ui-btn neutral"
          href={activeGroup === "business" ? businessUrl : managementUrl}
          download={
            (activeGroup === "business" ? "business" : "management") +
            ".openapi.json"
          }
        >
          OpenAPI 3.1 ↓
        </a>
      </Head>
      <ViewTabs
        toolbar={
          <SearchBox
            label={t("查找接口", "Find operation")}
            value={query}
            change={setQuery}
          />
        }
        label={t("接口类别", "API categories")}
        value={activeGroup}
        items={groups}
        change={(value) => {
          setGroup(value);
          setSelected("");
          if (!matches.some((doc) => groupOf(doc) === value)) setQuery("");
        }}
      >
        {current ? (
          <div className="reference-columns">
            <Panel flush className="reference-menu">
              <nav aria-label={t("接口目录", "Operation index")}>
                {operations.map((doc) => (
                  <button
                    key={operationKey(doc)}
                    aria-current={doc === current ? "page" : undefined}
                    onClick={() => setSelected(operationKey(doc))}
                  >
                    <strong>{docTitle(doc, t)}</strong>
                    <code>{operationKey(doc)}</code>
                  </button>
                ))}
              </nav>
            </Panel>
            <OperationDetails key={operationKey(current)} doc={current} />
          </div>
        ) : (
          <Empty>{t("没有匹配的接口", "No matching operations")}</Empty>
        )}
      </ViewTabs>
    </>
  );
}

function OperationDetails({ doc }: { doc: Operation }) {
  const { t } = useApp();
  const [copied, setCopied] = useState(false),
    [error, setError] = useState<unknown>();
  if (doc.group === "business") return <BusinessReference doc={doc}/>;
  const op = doc.path.split("/").at(-1)!;
  const sample =
    op === "content"
      ? { url: "https://example.com/" }
      : op === "summary"
        ? {
            query: "How is rainfall measured?",
            language: "en",
            region: "Shanghai",
            current_time: "2026-05-01T00:30:00+08:00",
          }
        : { query: "How is rainfall measured?", count: 5 };
  const curl = [
    `curl -X ${doc.method} '${location.origin}${doc.path}'`,
    "  -H 'Authorization: Bearer <PROJECT_KEY>'",
    "  -H 'Content-Type: application/json'",
    `  -d '${JSON.stringify(sample)}'`,
  ].join(" \\\n");
  const parameters = {
    properties: Object.fromEntries(
      doc.parameters.map((param: Entity) => [
        `${param.in}: ${param.name}`,
        param.schema,
      ]),
    ),
    required: doc.parameters
      .filter((param: Entity) => param.required)
      .map((param: Entity) => `${param.in}: ${param.name}`),
  };
  async function copyExample() {
    try {
      await navigator.clipboard.writeText(curl);
      setCopied(true);
      setError(undefined);
    } catch (error) {
      setError(error);
    }
  }
  return (
    <Panel className="reference-detail">
      <div className="reference-method">
        <span>{doc.method}</span>
        <code>{doc.path}</code>
      </div>
      <h2>{docTitle(doc, t)}</h2>
      <Notice error={error} />
      {doc.group === "business" && (
        <p className="reference-auth">
          {t("认证方式", "Authentication")} · Bearer
        </p>
      )}
      {!!doc.parameters.length && doc.group !== "business" && (
        <SchemaFields schema={parameters} />
      )}
      {doc.input && (
        <section>
          {doc.group === "business" ? (
            <dl className="wire-fields">
              {[
                ...Object.entries((doc.input as Entity).properties || {}).map(
                  ([key, field]) =>
                    [
                      key,
                      field as Entity,
                      (doc.input as Entity).required?.includes(key),
                    ] as const,
                ),
                ...doc.parameters.map(
                  (p: Entity) =>
                    [p.name, p.schema as Entity, p.required] as const,
                ),
              ].map(([key, f, required]) => (
                <div key={key}>
                  <dt>
                    {fieldName(key, t)} <code>{key}</code>
                  </dt>
                  <dd>
                    {f.enum?.join(" / ") || f.type} ·{" "}
                    {required ? t("必填", "Required") : t("可选", "Optional")}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <>
              <h3>{t("请求字段", "Request fields")}</h3>
              <SchemaFields schema={doc.input} />
            </>
          )}
          <details>
            <summary>{t("完整请求 Schema", "Complete request schema")}</summary>
            <pre className="code-box">{JSON.stringify(doc.input, null, 2)}</pre>
          </details>
        </section>
      )}
      <p className="response-codes">
        {t("响应状态", "Response statuses")}
        {doc.responses.map((status) => (
          <code key={status}>{status}</code>
        ))}
      </p>
      {doc.group === "business" && (
        <section>
          <h3>{t("请求示例", "Request example")}</h3>
          <p>
            {t(
              "使用项目密钥进行 Bearer 认证。",
              "Authenticate with the project Bearer key.",
            )}
          </p>
          <RequestParameters op={op} input={sample} />
          <details>
            <summary>cURL</summary>
            <pre className="code-box">{curl}</pre>
          </details>
          <div className="reference-example-actions">
            <Btn onPress={copyExample}>
              <Copy size={15} />
              {copied ? t("已复制", "Copied") : t("复制 cURL", "Copy cURL")}
            </Btn>
            <Link
              className="ui-btn oas-button primary"
              to={
                "/playground?" +
                new URLSearchParams({ sample: JSON.stringify(sample), op })
              }
            >
              <FlaskConical size={15} />
              {t("载入调试台", "Load in playground")}
            </Link>
          </div>
        </section>
      )}
      <details className="response-schemas">
        <summary>
          {t("完整响应定义", "Complete response definitions")}
          <ChevronRight size={14} />
        </summary>
        {Object.entries(doc.outputs).map(([status, output]) => (
          <details className="source-card" key={status}>
            <summary>
              {status} · {(output as Entity).description}
            </summary>
            <pre className="code-box">
              {JSON.stringify((output as Entity).schema, null, 2)}
            </pre>
          </details>
        ))}
      </details>
    </Panel>
  );
}
function SchemaFields({ schema }: { schema: Entity }) {
  const { t } = useApp();
  const fields =
    schema.properties ||
    schema.allOf?.find((s: Entity) => s.properties)?.properties ||
    {};
  return (
    <div className="table-scroll">
      <DataTable>
        <DataTable.Header>
          {[
            t("字段", "Field"),
            t("类型", "Type"),
            t("必填", "Required"),
            t("约束与说明", "Constraints and description"),
          ].map((label) => (
            <DataTable.Column key={label}>{label}</DataTable.Column>
          ))}
        </DataTable.Header>
        <DataTable.Body>
          {Object.entries(fields).map(([key, v]) => {
            const s = v as Entity;
            return (
              <DataTable.Row key={key}>
                <DataTable.Cell>{key}</DataTable.Cell>
                <DataTable.Cell>
                  {Array.isArray(s.type)
                    ? s.type.join(" | ")
                    : s.type ||
                      s.anyOf?.map((s: Entity) => s.type).join(" | ") ||
                      "—"}
                </DataTable.Cell>
                <DataTable.Cell>
                  {schema.required?.includes(key)
                    ? t("是", "Yes")
                    : t("否", "No")}
                </DataTable.Cell>
                <DataTable.Cell>
                  {s.description || ""} {s.enum?.join(" / ")}{" "}
                  {s.minimum != null ? `≥${s.minimum}` : ""}{" "}
                  {s.maximum != null ? `≤${s.maximum}` : ""}
                </DataTable.Cell>
              </DataTable.Row>
            );
          })}
        </DataTable.Body>
      </DataTable>
    </div>
  );
}

function fieldName(key: string, t: (zh: string, en: string) => string) {
  const labels: Record<string, [string, string]> = {
    query: ["检索问题", "Question"],
    url: ["网页地址", "URL"],
    language: ["业务语言", "Language"],
    time_range: ["检索时间范围", "Time range"],
    count: ["结果数", "Result count"],
    source_count: ["来源数", "Sources"],
    max_chars: ["字符上限", "Character limit"],
    region: ["地区", "Region"],
    current_time: ["当地时间", "Local time"],
    "Accept-Language": ["响应语言", "Response language"],
  };
  return labels[key] ? t(...labels[key]) : "";
}
