const nativePort=browser.runtime.connectNative('oas.native');
const readers=new Map();
let searchTab=null,searchEngine=null;
function remaining(command) {if(Date.now()>=command.expires)throw Error('UPSTREAM_TIMEOUT');return command.expires-Date.now();}
function safeURL(value) {try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password;}catch{return false;}}
function check(value) {if(value?.webdriver!==false || value?.page_webdriver!==false)throw Error('BROWSER_FAILED');return value;}
async function message(tab,op,args={}) {return browser.tabs.sendMessage(tab,{op,args});}
async function poll(command,read) {
  while(remaining(command)>0) {
    try {const value=await read();if(value)return value;}
    catch(error){
      if(/^(ENDPOINT_|ACCESS_|UPSTREAM_|SEARCH_|CONTENT_|URL_|BROWSER_)/.test(error.message))throw error;
      if(OAS_NATIVE_DEBUG && command.lastError!==error.message){console.error('Native page receiver:',error.message);command.lastError=error.message;}
    }
    await pause(Math.min(50,remaining(command)));
  }
}
function assertStatus(tab,search=false) {
  const state=pageCaptures.get(tab);
  const fail=code=>{const error=Error(code);if(!search && state?.status){error.source_status=state.status;error.source_url=state.url;error.retry_after_ms=state.retry_after_ms;}throw error;};
  if(state?.policy)throw Error('URL_NOT_ALLOWED');
  if(state?.error)throw Error(search?'SEARCH_ENGINE_UNAVAILABLE':'CONTENT_UNAVAILABLE');
  if(state?.status===429 || (search&&[401,403].includes(state?.status)))fail('ENDPOINT_RISK_CONTROL');
  if([401,403].includes(state?.status))fail('ACCESS_DENIED');
  if(state?.status>=400)fail(search?'SEARCH_ENGINE_UNAVAILABLE':'CONTENT_UNAVAILABLE');
  return state;
}
async function home(command,args) {
  if(!safeURL(args.home)||!['google','baidu'].includes(args.engine))throw Error('URL_NOT_ALLOWED');
  searchEngine=args.engine;
  if(searchTab===null)searchTab=(await browser.tabs.create({url:'about:blank',active:true})).id;
  let previous=null;
  try{previous=(await message(searchTab,'state')).document_id;}catch{}
  startCapture(searchTab);
  await browser.tabs.update(searchTab,{url:args.home});
  return poll(command,async()=>{
    assertStatus(searchTab,true);
    const state=check(await message(searchTab,'form',{engine:args.engine,home:args.home,count:args.count}));
    if(state.document_id===previous)return null;
    if(state.denied)throw Error('ENDPOINT_RISK_CONTROL');
    return state.ready?state:null;
  });
}
async function removeReader(tab) {
  const container=readers.get(tab);readers.delete(tab);pageCaptures.delete(tab);
  try{await browser.tabs.remove(tab);}finally{if(container)await browser.contextualIdentities.remove(container);}
}
async function run(command) {
  const args=command.args||{};
  if(command.op==='health')return {driver:'native_messaging',webdriver:navigator.webdriver};
  if(command.op==='home')return home(command,args);
  if(command.op==='prepare_search') {
    if(!safeURL(args.target)||new URL(args.target).origin!==new URL(args.home).origin)throw Error('URL_NOT_ALLOWED');
    let state;
    if(searchTab!==null && searchEngine===args.engine){try{state=check(await message(searchTab,'form',{engine:args.engine,home:args.home,count:args.count}));}catch{}}
    if(state?.denied)throw Error('ENDPOINT_RISK_CONTROL');
    if(!state?.ready || oasQueryKey(state.previous)===oasQueryKey(args.query) || (args.engine==='baidu'&&state.previous))state=await home(command,args);
    const before=state.document_id;
    startCapture(searchTab);
    const prepared=check(await message(searchTab,'form',args));
    if(prepared.denied)throw Error('ENDPOINT_RISK_CONTROL');
    if(!prepared.prepared)throw Error('SEARCH_RESULTS_UNAVAILABLE');
    const submittedAt=Date.now();
    try{await message(searchTab,'commit',{document:prepared.document});}
    catch(error){if(!/Receiving end|message port|message manager|went out of scope|Could not establish/.test(error.message))throw error;}
    return {document:prepared.document,before,before_query:state.previous,before_signature:state.list_signature,
      before_cards:state.card_signature,before_answer:state.answer_signature,submitted_at:submittedAt};
  }
  if(command.op==='search_results') {
    const startedAt=Date.now(),submittedAt=args.submitted_at||startedAt;
    const expires=Math.min(command.expires,submittedAt+7000);
    const readiness=oasSearchReadiness(submittedAt,expires,startedAt);
    const finish=value=>({...value,cards:value.cards.map(card=>({...card,engine:args.engine,url:value.location})),driver:'native_messaging'});
    while(Date.now()<expires-100) {
      assertStatus(searchTab,true);
      try {
        const raw=check(await message(searchTab,'results',args));
        if(raw.denied)throw Error('ENDPOINT_RISK_CONTROL');
        if(raw.unavailable)throw Error('SEARCH_ENGINE_UNAVAILABLE');
        const value=oasFreshSearch(raw,args);
        if(!value)readiness.reset();
        else {
          if(value.document_complete&&!value.root_found)throw Error('SEARCH_RESULTS_UNAVAILABLE');
          if(value.answerNeedsSources && args.engine==='baidu' && Date.now()<expires-150){
            const reference=check(await message(searchTab,'sources',{...args,document_id:value.document_id,answer_signature:value.answerSignature}));
            if(reference.current===false){readiness.reset();await pause(75);continue;}
          }
          const result=readiness.sample(value,Date.now());
          if(result)return finish(result);
        }
      }catch(error){
        if(/^(ENDPOINT_|SEARCH_|BROWSER_)/.test(error.message))throw error;
        readiness.reset();
      }
      await pause(Math.min(75,Math.max(1,expires-100-Date.now())));
    }
    const fallback=readiness.fallback(Date.now());
    if(fallback)return finish(fallback);
    throw Error('UPSTREAM_TIMEOUT');
  }
  if(command.op==='open_reader') {
    if(!safeURL(args.url))throw Error('URL_NOT_ALLOWED');
    const container=await browser.contextualIdentities.create({name:'OpenAgentSearch reader',color:'blue',icon:'fingerprint'});
    let tab;
    try {
      tab=(await browser.tabs.create({url:'about:blank',cookieStoreId:container.cookieStoreId,active:false})).id;
      readers.set(tab,container.cookieStoreId);startCapture(tab,true);
      await browser.tabs.update(tab,{url:args.url});
      const state=await poll(command,async()=>{
        const response=assertStatus(tab);
        const page=await browser.tabs.get(tab);
        if(page.url==='about:blank')return null;
        if(!safeURL(page.url))throw Error('SEARCH_ENGINE_UNAVAILABLE');
        const state=check(await message(tab,'state'));
        if(!safeURL(state.document_uri))throw Error('SEARCH_ENGINE_UNAVAILABLE');
        if(OAS_NATIVE_DEBUG){
          const observation=JSON.stringify({tab,page:page.url,document:state.document_uri,url:state.url,ready:state.ready,response:response?.url,status:response?.status,error:response?.error});
          if(command.readerObservation!==observation){console.log('Native reader readiness:',observation);command.readerObservation=observation;}
        }
        return state.ready==='complete' && normalizedURL(response?.url)===normalizedURL(state.url) && response?.status ? state : null;
      });
      await pause(Math.min(100,remaining(command)));
      return {tab,...state};
    }catch(error){if(tab!==undefined)await removeReader(tab).catch(()=>{});else await browser.contextualIdentities.remove(container.cookieStoreId).catch(()=>{});throw error;}
  }
  if(command.op==='reader_article') {
    if(!readers.has(args.tab))throw Error('BROWSER_FAILED');assertStatus(args.tab);
    return check(await message(args.tab,'article'));
  }
  if(command.op==='reader_layout') {
    if(!readers.has(args.tab))throw Error('BROWSER_FAILED');
    const resources=await waitResources(args.tab,command.expires);
    return message(args.tab,'layout',resources);
  }
  if(command.op==='close_readers') {for(const tab of [...readers.keys()])await removeReader(tab);return {closed:true};}
  throw Error('INVALID_ACTION');
}
nativePort.onMessage.addListener(command=>{
  command.expires=Date.now()+Math.max(1,Math.min(command.timeout_ms,45000));
  run(command).then(result=>nativePort.postMessage({id:command.id,result}),error=>nativePort.postMessage({id:command.id,error:error.message,details:{source_status:error.source_status,source_url:error.source_url,retry_after_ms:error.retry_after_ms}}));
});
