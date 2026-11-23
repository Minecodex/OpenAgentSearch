type Entity = Record<string, any>;
export function rewriteView(span: Entity, evidence: Entity, record: Entity): Entity {
  if (span.diagnostics?.rewrite) return span.diagnostics.rewrite;
  const original=String(span.input?.query||""),key=(query:string)=>query.trim().toLowerCase(),seen=new Set([key(original)]);
  const variants=evidence.variants||[];
  const entries=(Array.isArray(span.output?.queries)?span.output.queries:[]).map((query:unknown)=>{
    const text=typeof query==="string"?query.trim():"";
    let state=!text?"invalid":key(text)===key(original)?"duplicate_original":seen.has(key(text))?"duplicate_rewrite":"not_searched";
    seen.add(key(text));
    const variant=variants.find((value:Entity)=>value.variant_id!=="Q0"&&key(value.query||"")===key(text));
    if(variant&&state==="not_searched")state="used";
    return {query:text,state,...(state==="used"?{variant_id:variant.variant_id}:{})};
  });
  const used=entries.filter((entry:Entity)=>entry.state==="used").length,originalSearched=variants.some((value:Entity)=>value.variant_id==="Q0");
  return {entries,used,requested:record.snapshot?.project?.rewrite_count??span.input?.rewrite_count,
    state:used?"used":originalSearched?"fallback":"failed",fallback_reason:used?null:span.output?.code||"no_usable_rewrite"};
}
