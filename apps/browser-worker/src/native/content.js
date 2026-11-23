const oasDocument = [...crypto.getRandomValues(new Uint32Array(4))].join('-');
function oasIdentity() {
  const state={webdriver:navigator.webdriver,page_webdriver:window.wrappedJSObject.navigator.webdriver};
  if(state.webdriver!==false || state.page_webdriver!==false)throw Error('BROWSER_FAILED');
  return state;
}
browser.runtime.onMessage.addListener(message => {
  const identity=oasIdentity();
  const args=message.args||{};
  if(message.op==='state')return Promise.resolve({...identity,document_id:oasDocument,ready:document.readyState,url:location.href,document_uri:document.documentURI});
  if(message.op==='form') {
    const state=oasForm(args.engine,args.target,args.home);
    const old=state.previous?oasReadSearch(args.engine,args.count||10,state.previous,null,args.home,location.href):null;
    return Promise.resolve({...state,...identity,document_id:oasDocument,list_signature:oasListSignature(old?.hits||[]),
      card_signature:JSON.stringify(old?.cards||[]),answer_signature:old?.answerSignature??null});
  }
  if(message.op==='commit')return Promise.resolve(oasCommit(args.document));
  if(message.op==='results') {
    const state=oasReadSearch(args.engine,args.count,args.query,args.document,args.home,args.target);
    return Promise.resolve({...state,...identity,document_id:oasDocument,document_complete:document.readyState==='complete',input_query:oasSearchInput(args.engine)?.value});
  }
  if(message.op==='sources') {
    const state=oasReadSearch(args.engine,args.count,args.query,args.document,args.home,args.target);
    const current=args.engine==='baidu' && args.document_id===oasDocument && state.current===true &&
      oasQueryKey(oasSearchInput(args.engine)?.value)===oasQueryKey(args.query) && state.answerSignature===args.answer_signature;
    return Promise.resolve({...identity,current,requested:current&&baiduSearch.references(args.answer_signature)});
  }
  if(message.op==='article') {
    const article=document.querySelector('article'),text=(document.body?.innerText||'').trim();
    if(!article && text.length<500 && document.querySelector('form input[type=password],form[action*=sorry],iframe[src*=recaptcha],#captcha'))throw Error('ACCESS_DENIED');
    const main=document.querySelector('article,main,[role=main]')||document.body;
    if(!main)throw Error('CONTENT_UNAVAILABLE');
    const body=main.outerHTML,raw=document.documentElement.outerHTML;
    if(new TextEncoder().encode(body).length>4*1024*1024)throw Error('CONTENT_UNAVAILABLE');
    const bytes=new TextEncoder().encode(raw),limit=8*1024*1024;
    return Promise.resolve({...identity,body,archive_body:bytes.length>limit?new TextDecoder().decode(bytes.slice(0,limit)):raw,
      ...(bytes.length>limit?{archive_incomplete:true}:{}),title:document.title,final_url:location.href,media_type:'text/html'});
  }
  if(message.op==='layout') {
    const layout=oasBuildLayout(args.resources,args.missing),encode=new TextEncoder();
    if(encode.encode(layout.srcdoc).length>16*1024*1024 || encode.encode(JSON.stringify(layout)).length>24*1024*1024)
      return Promise.resolve({state:'partial',reason:'layout_byte_limit',missing_resource_count:layout.missing_resource_count+1,viewport:layout.viewport});
    return Promise.resolve(layout);
  }
  throw Error('INVALID_ACTION');
});
