import type { Entity } from "./api";
export function plain(value:unknown):string{
  return String(value??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/[\\`*_{}\[\]()#!|]/g,c=>"\\"+c).replace(/\r?\n/g,"  \n");
}
export function literal(value:unknown,format="text"):string{
  const text=typeof value==="string"?value:JSON.stringify(value,null,2);
  let longest=0;for(const run of (text||"").matchAll(/~+/g))longest=Math.max(longest,run[0].length);
  const fence="~".repeat(Math.max(3,longest+1));
  return [fence+format,text||"",fence].join("\n");
}
export function requestReport(report:Entity,language:string):string{
  const t=(zh:string,en:string)=>language==="en"?en:zh;
  const request=report.request||{},meta=request.metadata||{},response=request.response_payload;
  const lines=["# "+plain(meta.query_preview||meta.request_id),"",plain(meta.request_id),"",
    "## "+t("结果","Result"),"",plain(response?.data?.summary||response?.data?.text||response?.error?.message||response?.data?.status||""),"",
    "## "+t("来源和引用","Sources and citations"),""];
  lines.splice(4,0,"## "+t("请求参数","Request parameters"),"",literal(request.request_payload,"json"),"",
    "## "+t("配置快照","Configuration snapshot"),"",literal(request.snapshot,"json"),"",
    plain(t("保留天数","Retention days")+": "+(meta.retention_days??"—"))+" · "+plain(t("到期时间","Expires")+": "+(meta.expires_at??"—")),"");
  for(const source of response?.data?.sources||[]){
    lines.push("### "+plain(source.id+" · "+(source.title||source.url)),"",plain(source.url),"");
    for(const segment of source.segments||[])lines.push(plain(segment.id),"",plain(segment.summary),"");
  }
  for(const citation of response?.data?.citations||[])lines.push(plain(citation.source_id+" / "+citation.segment_id),"");
  if(response?.data?.items)lines.push(literal(response.data.items,"json"),"");
  lines.push("## "+t("执行调用","Upstream calls"),"","| "+t("接入点 | 阶段 | 状态 | 毫秒","Endpoint | Stage | Status | ms")+" |","|---|---|---|---|");
  for(const call of report.calls||[])lines.push("| "+[call.endpoint_name,call.stage||call.operation,call.status,call.execution_ms].map(v=>plain(v).replace(/\r?\n/g," ")).join(" | ")+" |");
  lines.push("","## "+t("候选证据","Candidate evidence"),"",literal(report.evidence,"json"),"");
  for(const span of report.payloads||[]){
    lines.push("## "+plain(span.span?.stage),"");
    if(!span.replay?.length)lines.push(literal({input:span.input,output:span.output},"json"),"");
    for(const material of span.replay||[]){
      lines.push(plain(material.kind+" · "+material.state),"");
      if(material.kind==="webpage")lines.push(plain(material.url),"",literal(material.body,material.media_type?.includes("html")?"html":"markdown"),"");
      else lines.push(literal({input:material.model_input,output:material.model_output},"json"),"");
    }
  }
  return lines.join("\n");
}
