// Test-server reader for the same human-readable messages an operator inspects.
// No hidden JSON input is added to the production prompt for fixture convenience.
const decoded=value=>String(value||'').replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&');
function field(body,label){return decoded(body.match(new RegExp('^'+label+'：([^\\n]*)','m'))?.[1]||'').replaceAll('\\r','\r').replaceAll('\\n','\n');}
function blocks(body,kind){
 return [...body.matchAll(new RegExp('<<<'+kind+' (\\d+) 开始>>>\\n([\\s\\S]*?)<<<'+kind+' \\1 结束>>>','g'))].map(match=>match[2]);
}
const content=(body,label='内容')=>decoded(body.slice(body.indexOf(label+'：\n')+label.length+2).trimEnd());
function passage(body){
 const id=field(body,'段落标识'),references=field(body,'允许引用的原段落').split('、').filter(Boolean);
 return {id,segment_id:id,source_id:field(body,'来源标识'),text:content(body),summary:content(body),...(references.length&&references.join()!==id?{references}:{})};
}
export function parseModelPrompt(messages){
 const system=messages?.find(message=>message.role==='system')?.content||'',query=messages?.find(message=>message.role==='user')?.content||'';
 const title=field(system,'任务');
 const kind=({'查询改写':'rewrite','候选评分':'score','单段分析':'segments','段落批量分析':'segments','来源摘要压缩':'compress','原文整合总结':'synthesis','摘要整合':'synthesis'})[title];
 const task={kind,query};
 const language=field(system,'输出语言');if(language&&!language.includes('沿用'))task.language=language;
 const region=field(system,'当前地区');if(region&&!region.startsWith('未知'))task.region=region;
 const time=field(system,'参考时间');if(time&&!time.startsWith('未提供'))task[field(system,'时间依据')==='调用方提供'?'current_time':'local_time']=time;
 task.rewrite_count=Number(field(system,'改写数量').match(/\d+/)?.[0]||0);
 task.max_chars=Number(field(system,'回答字符数上限')||1200);
 if(kind==='score')task.candidates=blocks(system,'候选').map(body=>({candidate_id:field(body,'候选标识'),title:field(body,'标题'),url:field(body,'网页地址'),snippet:content(body,'简介')}));
 const values=blocks(system,'来源').map(body=>({id:field(body,'来源标识'),url:field(body,'网页地址'),title:field(body,'标题'),segments:blocks(body,'段落').map(passage)}));
 if(kind==='synthesis'){task.sources=values;if(title==='原文整合总结')task.mode='whole_sources';}
 if(kind==='compress')task.source=values[0];
 if(kind==='segments'){
  const items=blocks(system,'段落').map(passage);
  if(title==='段落批量分析')task.passages=items;else Object.assign(task,items[0]);
 }
 return task;
}
