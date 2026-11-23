const [engine, max, query, token, home, target] = arguments;
const locationInfo={location:location.href};
if(location.href.startsWith('about:neterror') || location.href.startsWith('about:certerror')) return {...locationInfo,unavailable:true};
const adapter=engine==='google'?googleSearch:baiduSearch;
if(adapter.blocked())return {...locationInfo,denied:true};
const address=new URL(location.href),expected=new URL(target),google=engine==='google';
const submittedQuery=address.searchParams.get(google?'q':'wd') || (!google && address.searchParams.get('word'));
// Freshness and query-echo checks are owned by the isolated extension controller.
if(address.origin!==new URL(home).origin || oasQueryKey(submittedQuery)!==oasQueryKey(query))return locationInfo;
const filter=google?'tbs':'gpc';
if(expected.searchParams.has(filter) && expected.searchParams.get(filter)!==address.searchParams.get(filter)){
  if(sessionStorage.getItem('oas-last-filter')!==token){
    sessionStorage.setItem('oas-last-filter',token);address.searchParams.set(filter,expected.searchParams.get(filter));location.replace(address.href);
  }
  return locationInfo;
}
const state=adapter.snapshot(max,true),ai=state.ai;
return {...locationInfo,current:true,hits:state.rows,cards:state.cards,empty:state.empty,root_found:!!state.root,
  materialPending:state.pending,materialDiscovering:state.discovering,
  answerState:ai.answerState,answerSignature:ai.answerSignature,answerProgress:ai.answerProgress,
  answerNeedsSources:!!ai.answerNeedsSources,
  ...(ai.answer?{engine_answer:{engine,content:ai.answer.content,sources:ai.answer.sources}}:{})};
