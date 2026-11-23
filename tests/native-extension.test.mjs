import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

test('search freshness rejects stale rows and mismatched visible queries while accepting display normalization',()=>{
 const context=vm.createContext({});
 vm.runInContext(readFileSync(new URL('../apps/browser-worker/src/native/search-state.js',import.meta.url),'utf8'),context);
 const current=vm.runInContext('oasCurrentSearch',context),key=vm.runInContext('oasQueryKey',context);
 const before={before:'old-document',before_query:'old query',before_signature:'[]',before_cards:'[]',before_answer:null,query:'广州 ＡＢＣ cafe\u0301'};
 const value={document_id:'new-document',current:true,hits:[{title:'Current result'}],input_query:'  广州  ABC café '};
 assert.equal(current(value,before),true);
 assert.equal(current({...value,input_query:''},before),false);
 assert.equal(current({...value,input_query:'另一条问题'},before),false);
 assert.equal(current({...value,current:false},before),false);
 assert.equal(current({...value,document_id:'old-document'},before),true,'SPA replacement has both a new query and new rows');
 assert.equal(current({...value,document_id:'old-document',hits:[]},before),false,'unchanged rows from the old document');
 assert.equal(current({...value,document_id:'old-document'},{...before,before_query:before.query}),false,'repeated query needs a new document');
 assert.notEqual(key('Guangzhou'),key('Guangdong'));
 assert.equal(key(' ＡＢＣ\n\t café '),key('ABC cafe\u0301'));
});

test('a new card cannot authorize stale organic rows or an old AI answer in the same document',()=>{
 const context=vm.createContext({});vm.runInContext(readFileSync(new URL('../apps/browser-worker/src/native/search-state.js',import.meta.url),'utf8'),context);
 const fresh=vm.runInContext('oasFreshSearch',context);
 const before={before:'doc',before_query:'first',query:'second',before_signature:'[["https://example.com/","Old"]]',before_cards:'[]',before_answer:'old-answer'};
 const value={current:true,document_id:'doc',input_query:'second',hits:[{url:'https://example.com/',title:'Old',snippet:'Changed noise'}],cards:[{title:'New card',content:'New value'}],answerState:'ready',answerSignature:'old-answer',engine_answer:{content:'Old answer'}};
 const result=fresh(value,before);assert.equal(result.hits.length,0);assert.equal(result.cards.length,1);assert.equal(result.answerState,'none');assert.equal(result.engine_answer,undefined);
 assert.equal(fresh({...value,cards:[]},before),null);
});

function readiness(){
 const context=vm.createContext({});vm.runInContext(readFileSync(new URL('../apps/browser-worker/src/native/search-readiness.js',import.meta.url),'utf8'),context);
 return vm.runInContext('oasSearchReadiness',context);
}
const sample=(patch={})=>({current:true,document_id:'doc',location:'https://www.google.com/search?q=rain',hits:[{url:'https://example.com/',title:'Rain'}],cards:[],empty:false,answerState:'none',answerProgress:false,...patch});
test('readiness waits for minimum observation, accepts AI-only completion after four seconds and respects short budgets',()=>{
 const create=readiness(),lists=create(0,7000,0);
 assert.equal(lists.sample(sample(),100),null);assert.equal(lists.sample(sample(),3999),null);
 assert.equal(lists.sample(sample(),4000).search_readiness.return_reason,'material_ready');
 const ai=create(0,7000,0),pending=sample({hits:[],answerState:'pending',answerProgress:true});
 assert.equal(ai.sample(pending,100),null);assert.equal(ai.sample(pending,4000),null);
 const complete={...pending,answerState:'ready',answerSignature:'complete',engine_answer:{engine:'google',content:'Rain.',sources:[{url:'https://example.com/'}]}};
 assert.equal(ai.sample(complete,4500),null);assert.equal(ai.sample(complete,4699),null);
 assert.equal(ai.sample(complete,4700).engine_answer.content,'Rain.');
 const short=create(0,1000,0);short.sample(sample(),100);assert.ok(short.sample(sample(),850));
});
test('late materials receive bounded readiness grace, while navigation, removal and receiver loss retire cached material',()=>{
 const create=readiness(),late=create(0,7000,0);
 assert.equal(late.sample(sample({hits:[],materialDiscovering:true}),100),null);
 const card=sample({hits:[],cards:[{title:'Weather',content:'23℃'}]});
 assert.equal(late.sample(card,4300),null);assert.equal(late.sample(card,4500),null);
 assert.equal(late.sample(card,4900).cards.length,1);
 for(const replace of [sample({current:false}),sample({document_id:'next',hits:[]}),sample({hits:[]})]){
  const policy=create(0,7000,0);policy.sample(sample(),100);policy.sample(replace,500);assert.equal(policy.fallback(6900),null);
 }
 const lost=create(0,7000,0);lost.sample(sample(),100);lost.reset();assert.equal(lost.fallback(6900),null);
 const pending=create(0,7000,0);pending.sample(sample({answerState:'pending',answerProgress:true}),100);
 const fallback=pending.sample(sample({answerState:'pending',answerProgress:true}),4000);assert.equal(fallback.engine_answer,undefined);assert.equal(fallback.search_readiness.answer_state,'pending');
});

function controller(){
 const hooks={};
 const event=name=>({addListener:handler=>{hooks[name]=handler;}});
 const context=vm.createContext({URL,Uint8Array,TextDecoder,console,setTimeout,OAS_ALLOWED_HOSTS:[],OAS_NATIVE_DEBUG:false,
  browser:{webRequest:{onBeforeRequest:event('before'),onHeadersReceived:event('headers'),onErrorOccurred:event('error')}}});
 vm.runInContext(readFileSync(new URL('../apps/browser-worker/src/native/resources.js',import.meta.url),'utf8'),context);
 const start=()=>vm.runInContext('startCapture(7)',context);
 const state=()=>vm.runInContext('pageCaptures.get(7)',context);
 const request=(id,url='https://example.com/',type='main_frame')=>({tabId:7,requestId:id,url,type});
 return {hooks,start,state,request};
}

test('late headers and aborted navigation from the previous page cannot poison its replacement',()=>{
 const {hooks,start,state,request}=controller();
 start();hooks.before(request('old'));
 start();hooks.before(request('new'));
 hooks.error({...request('old'),error:'NS_BINDING_ABORTED'});
 hooks.headers({...request('old'),statusCode:429,responseHeaders:[]});
 assert.equal(state().error,false);assert.equal(state().status,null);
 hooks.headers({...request('new'),statusCode:200,responseHeaders:[{name:'Content-Type',value:'text/html'}]});
 assert.equal(state().status,200);assert.equal(state().headers.has('old'),false);
});

test('a blocked document is a policy failure while a blocked asset only makes its archive partial',()=>{
 const {hooks,start,state,request}=controller();
 start();hooks.before(request('page'));
 assert.equal(hooks.before(request('asset','http://169.254.169.254/private','image')).cancel,true);
 assert.equal(state().policy,undefined);assert.equal(state().missing,1);
 assert.equal(hooks.before(request('redirect','http://127.0.0.1/private')).cancel,true);
 assert.equal(state().policy,true);
});
