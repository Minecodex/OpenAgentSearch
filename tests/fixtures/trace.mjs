export function traceFixture() {
  const id='00000000-0000-4000-8000-000000000099';
  const project={id:'00000000-0000-4000-8000-000000000020',name:'流程验证项目',version:1,
    search_pools:[['search']],reader_pools:[['reader']],model_endpoint_id:'model',search_limit:10,
    source_limit:2,body_limit:40000,summary_limit:1200,rewrite_count:1};
  const candidates=[
    {candidate_id:'c1',title:'无关说明',url:'https://example.test/other',relevant:false,score:5,selected:false,selection_reason:'irrelevant'},
    {candidate_id:'c2',title:'雨量计说明',url:'https://example.test/gauge',relevant:true,score:90,selected:true,selection_reason:'selected',source_id:'s1',reader_call_ids:['read-fail','read-good']},
    {candidate_id:'c3',title:'观测站记录',url:'https://example.test/station',relevant:true,score:85,selected:true,selection_reason:'selected',source_id:'s2',reader_call_ids:['read-station']},
    {candidate_id:'c4',title:'补充测量资料',url:'https://example.test/extra?name='+('encoded-long-address-'.repeat(20)),relevant:true,score:70,selected:false,selection_reason:'source_limit'},
  ].map(c=>({snippet_preview:'降水观测资料',hits:[],reader_call_ids:[],...c}));
  const spans=[],payloads={},calls=[];
  function span(span_id,stage,status,start,duration,input={},output={},parent_id=null,replay=[]) {
    const value={span_id,stage,status,start_offset_ms:start,duration_ms:duration,parent_id};
    spans.push(value);payloads[span_id]={span:value,input,output,diagnostics:{},replay};
    return value;
  }
  function call(call_id,span_id,kind,status,endpoint_name,extra={}) {
    const s=spans.find(s=>s.span_id===span_id);
    calls.push({call_id,span_id,kind,status,endpoint_name,endpoint_id:kind==='reader'?'reader':kind,
      started_at:new Date(Date.UTC(2026,10,22)+s.start_offset_ms).toISOString(),execution_ms:s.duration_ms,
      queue_ms:0,request_id:id,project_id:project.id,stage:s.stage,origin:'debug',sent:true,
      reason:'primary',input_preview:'rainfall',...extra});
  }
  span('admit','admit','success',0,1);
  span('search-fail','search','error',1,5,{query:'rainfall',variant_id:'Q0',time_range:'month'},{code:'ENDPOINT_RISK_CONTROL'});
  span('search-good','search','success',7,15,{query:'rainfall',variant_id:'Q0'},{
    hits:candidates.map(c=>({url:c.url,title:c.title,snippet:c.snippet_preview}))});
  span('search-variant','search','success',9,10,{query:'rain gauge',variant_id:'Q1'},{hits:[]});
  call('search-first','search-fail','search','error','搜索甲',{error_code:'ENDPOINT_RISK_CONTROL'});
  call('search-second','search-good','search','success','搜索乙');
  call('search-third','search-variant','search','success','搜索丙');
  const scores=candidates.map(c=>({candidate_id:c.candidate_id,score:c.score,relevant:c.relevant}));
  span('score','score','success',23,10,{query:'rainfall',batch_id:'B1',candidates}, {scores});
  call('score-call','score','model','success','评分模型');
  span('source-one','source','success',34,25,{url:candidates[1].url,candidate_id:'c2',source_id:'s1'},{source_id:'s1',segments:1,reason:null});
  span('source-two','source','partial',34,26,{url:candidates[2].url,candidate_id:'c3',source_id:'s2'},{source_id:'s2',segments:0,reason:'STAGE_BUDGET_EXCEEDED'});
  const material={material_id:'page-one',kind:'webpage',url:candidates[1].url,source_id:'s1',call_id:'read-good',
    state:'complete',layout_state:'partial',media_type:'text/html',
    body:'<article><h1>雨量计说明</h1><p>记录降水。</p></article>',
    markdown:'# 雨量计说明\n\n记录降水。',text:'雨量计说明\n记录降水。'};
  span('read-failed','extract','error',35,4,{url:candidates[1].url,source_id:'s1',candidate_id:'c2'},{code:'UPSTREAM_TIMEOUT'},'source-one');
  span('read-success','extract','success',40,18,{url:candidates[1].url,source_id:'s1',candidate_id:'c2'},{title:candidates[1].title},'source-one',[material]);
  span('read-station','extract','error',36,20,{url:candidates[2].url,source_id:'s2',candidate_id:'c3'},{code:'STAGE_BUDGET_EXCEEDED'},'source-two');
  call('read-fail','read-failed','reader','error','正文甲',{candidate_id:'c2',source_id:'s1',error_code:'UPSTREAM_TIMEOUT'});
  call('read-good','read-success','reader','success','正文乙',{candidate_id:'c2',source_id:'s1'});
  call('read-station','read-station','reader','error','正文丙',{candidate_id:'c3',source_id:'s2',error_code:'STAGE_BUDGET_EXCEEDED'});
  const model={material_id:'model-exchange',kind:'model',state:'complete',
    model_input:{model:'fixture',messages:[{role:'user',content:'rainfall'}]},
    model_output:{choices:[{message:{content:'{"summary":"记录降水。"}'}}]}};
  span('synthesis','synthesis','success',61,12,{mode:'whole_sources',query:'rainfall',language:'zh'},
    {summary:'记录降水。',passages:[{source_id:'s1',segment_id:'p1',relevant:true,summary:'雨量计记录降水。'}],
      citations:[{source_id:'s1',segment_id:'p1'}]},null,[model]);
  call('synthesis-call','synthesis','model','success','总结模型');
  const metadata={request_id:id,project_id:project.id,project_name:project.name,origin:'debug',operation:'summary',
    status:'partial',duration_ms:75,upstream_calls:calls.length,query_preview:'rainfall',started_at:'2026-11-22T00:00:00Z',incomplete:false};
  const evidence={candidates,variants:[],sources:[],segments:[]};
  const record={metadata,spans,incomplete_reasons:[],snapshot:{project,endpoints:[]},request_payload:{query:'rainfall'},
    response_payload:{request_id:id,status:'partial',data:{summary:'记录降水。',sources:[],citations:[]},warnings:[],error:null},
    execution_summary:{endpoints:{search:[],reader:[],model:[]},score_batches:[{batch_id:'B1',candidate_count:4}],answer_source:'body'}};
  const layout={state:'partial',missing_resource_count:1,srcdoc:'<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:"></head><body><article><h1>归档雨量计页面</h1><p>当时取得的记录。</p><img alt="Archived image unavailable"></article></body></html>'};
  return {id,project,evidence,record,calls,payloads,layout};
}
