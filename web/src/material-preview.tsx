import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type Entity } from "./api";
import { useApp } from "./state";
import { Empty, Notice, ViewTabs } from "./ui";
import { MarkdownView } from "./search";
import { testOutcome } from "./request-display";

export function MaterialPreview({
  requestId,
  material: m,
}: {
  requestId: string;
  material: Entity;
}) {
  const { t } = useApp();
  const [format, setFormat] = useState(
    m.kind === "model" ? "model_input" : m.layout_state && m.layout_state !== "unavailable" ? "layout" : "preview",
  );
  const layout = useQuery({
    queryKey: ["layout", requestId, m.material_id],
    queryFn: () =>
      api<Entity>(
        `/admin/v1/requests/${requestId}/replay/${m.material_id}/layout`,
      ),
    enabled:
      format === "layout" &&
      !!m.layout_state &&
      m.layout_state !== "unavailable",
    retry: false,
  });
  return (
    <section className="material-preview" aria-label={t("历史回放", "Historical replay")}>
      <Notice error={layout.error} />
      {m.state !== "complete" && (
        <p className="notice">
          {t("材料不完整：", "Material incomplete: ")}
          {testOutcome(m.reason, t)}
        </p>
      )}
      {m.kind === "model" ? (
        <ViewTabs label={t("模型往返", "Model exchange")} value={format} change={setFormat}
          items={[["model_input",t("模型输入","Model input")],["model_output",t("模型输出","Model output")]]}>
          <pre className="code-box model-replay">{JSON.stringify(m[format],null,2)}</pre>
        </ViewTabs>
      ) : (
        <>
          <ViewTabs
            label={t("归档格式", "Archive format")}
            value={format}
            change={setFormat}
            items={(
              [
                ["layout", t("网页原貌", "Page layout")],
                ["preview", t("Markdown 预览", "Markdown preview")],
                ["markdown", t("Markdown 源文", "Markdown source")],
                ["text", t("纯文本", "Plain text")],
                ["source", t("网页源文", "Page source")],
              ] as [string, string][]
            ).filter(([v]) => v !== "layout" || (!!m.layout_state && m.layout_state !== "unavailable"))}
          >
            {format === "layout" ? (
              layout.data ? (
                <>
                  <iframe
                    title={t("归档网页", "Archived page")}
                    sandbox=""
                    referrerPolicy="no-referrer"
                    srcDoc={layout.data.srcdoc.replaceAll('alt="Archived image unavailable"', 'alt="' + t("归档图片不可用", "Archived image unavailable") + '"')}
                    className="replay-frame"
                  />
                  {layout.data.state === "partial" && (
                    <p className="notice">
                      {t(
                        "布局资源不完整，以下内容来自当时归档。",
                        "Some layout resources are missing. This is the captured archive.",
                      )}{" "}
                      · {layout.data.missing_resource_count}
                    </p>
                  )}
                </>
              ) : (
                <Empty>{layout.isPending ? t("正在读取归档页面…","Loading archived page…") : t("暂无可用的布局快照","No layout snapshot available")}</Empty>
              )
            ) : format === "preview" ? (
              <MarkdownView
                text={
                  m.markdown ||
                  (!m.media_type?.includes("html") ? m.body : "") ||
                  t("未记录 Markdown", "Markdown was not recorded")
                }
              />
            ) : (
              <pre className="code-box">
                {format === "source"
                  ? m.body
                  : m[format] || t("未记录", "Not recorded")}
              </pre>
            )}
          </ViewTabs>
        </>
      )}
    </section>
  );
}


export function ArchivedMaterials({requestId, materials}: {requestId:string;materials:Entity[]}) {
  const {t}=useApp();
  const [selected,setSelected]=useState("");
  const active=materials.find(m=>m.material_id===selected)||materials[0];
  if(!active)return null;
  if(materials.length===1)return <MaterialPreview key={active.material_id} requestId={requestId} material={active}/>;
  return <ViewTabs label={t("归档材料","Archived materials")} value={active.material_id} change={setSelected}
    items={materials.map((m,i)=>[m.material_id,m.title||m.url||t("材料 ","Material ")+(i+1)])}>
    <MaterialPreview key={active.material_id} requestId={requestId} material={active}/>
  </ViewTabs>;
}
