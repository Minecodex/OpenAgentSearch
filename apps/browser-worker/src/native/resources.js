const pageCaptures=new Map();
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const normalizedURL=url=>String(url||'').split('#')[0];
function allowedNetworkURL(value) {
  const url=new URL(value),host=url.hostname.toLowerCase().replace(/^\[|\]$/g,'');
  if(!['http:','https:'].includes(url.protocol))return true;
  if(url.username||url.password)return false;
  if(OAS_ALLOWED_HOSTS.includes(host))return true;
  if(host==='localhost'||/\.(localhost|local)$/.test(host))return false;
  if(host.includes(':'))return /^[23][0-9a-f]{0,3}:/.test(host);
  if(/^\d+\.\d+\.\d+\.\d+$/.test(host)){
    const[a,b]=host.split('.').map(Number);
    return !(a===0||a===10||a===127||a>=224||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===100&&b>=64&&b<=127));
  }
  return true;
}
function startCapture(tab,archive=false) {
  const state={archive,resources:{},headers:new Map(),requests:new Set(),mainRequest:null,pending:new Set(),bytes:0,buffered:0,count:0,missing:0,status:null,url:null};
  pageCaptures.set(tab,state);return state;
}
browser.webRequest.onHeadersReceived.addListener(details=>{
  const state=pageCaptures.get(details.tabId);if(!state)return;
  if(!state.requests.has(details.requestId))return;
  const mime=details.responseHeaders?.find(h=>h.name.toLowerCase()==='content-type')?.value?.split(';')[0];
  if(state.headers.size<128)state.headers.set(details.requestId,{mime,url:details.url,status:details.statusCode});
  if(details.type==='main_frame'&&details.requestId===state.mainRequest){state.url=details.url;state.status=details.statusCode;}
},{urls:['<all_urls>']},['blocking','responseHeaders']);
browser.webRequest.onErrorOccurred.addListener(details=>{
  const state=pageCaptures.get(details.tabId);
  if(state && details.type==='main_frame' && details.requestId===state.mainRequest)state.error=true;
},{urls:['<all_urls>']});
browser.webRequest.onBeforeRequest.addListener(details=>{
  const state=pageCaptures.get(details.tabId);
  if(state){
    if(state.requests.size<1024)state.requests.add(details.requestId);
    if(details.type==='main_frame'){state.mainRequest=details.requestId;state.error=false;state.status=null;state.url=null;}
  }
  if(!allowedNetworkURL(details.url)){if(state){if(details.type==='main_frame')state.policy=true;else state.missing++;}return {cancel:true};}
  if(!state?.archive || !['image','stylesheet','font'].includes(details.type))return;
  if(state.count++>=128){state.missing++;return;}
  let filter;
  try{filter=browser.webRequest.filterResponseData(details.requestId);}catch{state.missing++;return;}
  const key=details.requestId;state.pending.add(key);
  let chunks=[],size=0,captured=0,overflow=false;
  const finish=()=>{if(state.pending.delete(key)){state.buffered-=captured;captured=0;chunks=[];}};
  filter.ondata=event=>{
    const bytes=new Uint8Array(event.data).slice();size+=bytes.byteLength;
    filter.write(event.data);
    if(!overflow && (size>2*1024*1024 || state.bytes+(state.buffered+bytes.byteLength)*4/3>8*1024*1024)){
      overflow=true;state.buffered-=captured;captured=0;chunks=[];
    }else if(!overflow){chunks.push(bytes);captured+=bytes.byteLength;state.buffered+=bytes.byteLength;}
  };
  filter.onstop=()=>{
    try{
      const meta=state.headers.get(key),mime=meta?.mime || (details.type==='stylesheet'?'text/css':details.type==='font'?'font/woff2':'image/png');
      if(overflow || state.bytes+size*4/3>8*1024*1024 || (meta?.status>=400)){state.missing++;return;}
      const bytes=new Uint8Array(size);let offset=0;
      for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
      let binary='';for(let index=0;index<bytes.length;index+=16384)binary+=String.fromCharCode(...bytes.subarray(index,index+16384));
      const value='data:'+mime+';base64,'+btoa(binary);state.bytes+=value.length;
      state.resources[meta?.url||details.url]=value;
    }catch{state.missing++;}finally{filter.close();finish();}
  };
  filter.onerror=()=>{state.missing++;finish();};
},{urls:['<all_urls>']},['blocking']);
async function waitResources(tab,expires) {
  const state=pageCaptures.get(tab);if(!state)throw Error('BROWSER_FAILED');
  const deadline=Math.min(expires,Date.now()+500);
  while(state.pending.size && Date.now()<deadline)await pause(25);
  if(OAS_NATIVE_DEBUG)console.log('Native resource headers:',JSON.stringify([...state.headers.values()].map(v=>({url:v.url,mime:v.mime,status:v.status}))));
  return {resources:state.resources,missing:state.missing+state.pending.size};
}
