import {searchDocument} from './search-fixtures.mjs';
import {parseModelPrompt} from './prompt-fixture.mjs';
import http from 'node:http';
import {readFileSync} from 'node:fs';
export function fixture(port=18780, host='0.0.0.0'){
  const requests=[],counts=new Map();
  const server=http.createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);
    let input={};try{input=JSON.parse(Buffer.concat(chunks).toString()||'{}')}catch{}
    const url=new URL(req.url,'http://fixture');
    const origin=process.env.OAS_FIXTURE_PUBLIC||'http://host.docker.internal:'+port;
    const page=origin+'/article';
    const match=url.pathname.match(/^\/case\/([^/]+)(\/.*)$/);const mode=match?.[1]||'normal';if(match)url.pathname=match[2];
    requests.push({path:url.pathname,request_url:req.url,method:req.method,mode,input,authorization:req.headers.authorization,egress:req.headers['x-oas-fixture-egress']});if(requests.length>10000)requests.shift();
    const json=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    let body='<html><head><title>Rainfall field guide</title><link rel="stylesheet" href="/style.css"></head><body><main><aside>Station A</aside><article><h1>Rainfall measurements</h1><p>A rain gauge measures accumulated rainfall in millimetres. 雨量计记录累积降水。🙂</p><p>Read the scale at the same time each day.</p><table><tr><th>Station</th><th>Rain</th></tr><tr><td>A</td><td>12 mm</td></tr></table><pre><code>rain = 12;</code></pre><img src="/pixel.gif" alt="Gauge"></article></main></body></html>';
    if(mode==='long')body=body.replace('</article>','<p>'+('雨量计每日上午记录降水，单位为毫米。 Rain is measured daily. 🙂 '.repeat(3000))+'</p></article>');
    if(mode==='escaped')body='<html><body><article><p>*alpha</p></article></body></html>';
    if(mode==='login')body='<html><body><form><h1>Sign in</h1><input type="password"><button>Login</button></form></body></html>';
    if(mode==='business-error'){json({code:19,results:[],data:null});return;}
    if(mode==='slowread'&&['/v1/extract','/extract'].includes(url.pathname))await new Promise(r=>setTimeout(r,250));
    if(url.pathname.startsWith('/requires-key/')){if(req.headers.authorization!=='Bearer sample-native-key'){json({error:{code:'invalid_api_key'}},401);return;}url.pathname=url.pathname.slice('/requires-key'.length);}
    if(url.pathname.startsWith('/upstream-denied/')){json({error:{code:'permission_denied'}},403);return;}
    if(url.pathname.startsWith('/searx-failed/')){json({results:[],unresponsive_engines:[['fixture','timeout']]});return;}
    if(url.pathname.startsWith('/risk/')){json({error:{code:'risk_control'}},429);return;}
    if(url.pathname.startsWith('/target-denied/')){json({error:{code:'ACCESS_DENIED'}},403);return;}
    if(url.pathname.startsWith('/slow/')){await new Promise(r=>setTimeout(r,1200));url.pathname=url.pathname.slice(5);}
    if(url.pathname==='/hold-article'){await new Promise(resolve=>{server.held??=[];server.held.push(resolve);});res.writeHead(200,{'Content-Type':'text/html'});res.end(body);return;}
    if(url.pathname==='/slow-article'){await new Promise(r=>setTimeout(r,8000));res.writeHead(200,{'Content-Type':'text/html'});res.end(body);return;}
    if(url.pathname==='/cache-retry-later'){
      res.writeHead(429,{'Content-Type':'text/html','Retry-After':'3600'});res.end('Please retry later');return;
    }
    if(url.pathname==='/cache-recover'){
      if(server.cacheOriginGone){res.writeHead(410,{'Content-Type':'text/html'});res.end('<html><body>Removed by origin</body></html>');}
      else {res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});res.end(body);}
      return;
    }
    if(url.pathname==='/refused'){res.writeHead(403,{'Content-Type':'text/html'});res.end('<html><body><main><h1>Forbidden</h1><p>Access denied by the site.</p></main></body></html>');return;}
    if(url.pathname==='/risk-article'){res.writeHead(429,{'Content-Type':'text/html'});res.end('<html><body>Request throttled</body></html>');return;}
    if(url.pathname==='/style.css'){res.writeHead(200,{'Content-Type':'text/css'});res.end('@font-face{font-family:ArchiveFixture;src:url("/font.woff2") format("woff2")}body{font-family:ArchiveFixture,sans-serif}main{display:grid;grid-template-columns:160px 1fr;gap:20px}aside{background:#aaccdd}aside::before{content:"Station: ";color:#123456}article{max-width:700px}h1{color:rgb(32,83,63)}');return;}
    if(url.pathname==='/font.woff2'){res.writeHead(200,{'Content-Type':'font/woff2'});res.end(readFileSync(new URL('../web/src/assets/geist.woff2',import.meta.url)));return;}
    if(url.pathname==='/redirect'){res.writeHead(302,{Location:origin+'/article'});res.end();return;}
    if(url.pathname==='/redirect-private'){res.writeHead(302,{Location:'http://169.254.169.254/latest/meta-data/'});res.end();return;}
    if(url.pathname==='/pixel.gif'){res.writeHead(200,{'Content-Type':'image/gif'});res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==','base64'));return;}
    if(url.pathname==='/'){
      res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});
      res.end('<div hidden><textarea name="q"></textarea><textarea id="chat-textarea" name="wd"></textarea><button id="chat-submit-button">Hidden submit</button></div><form action="/search"><input name="q"><button type="submit">Google</button></form><form action="/s"><input id="kw" name="wd"><button type="submit" id="su">Baidu</button></form>');return;
    }
    if(url.pathname==='/probe'){res.writeHead(server.probeReply?.status||200,{'Content-Type':'text/plain'});res.end(server.probeReply?.body||'oas-probe-ok');return;}
    if(url.pathname==='/missing-assets'){res.writeHead(200,{'Content-Type':'text/html'});res.end(body.replace('/pixel.gif','/not-captured.gif'));return;}
    if(url.pathname==='/article'){if(url.searchParams.has('parallel_source')){await new Promise(resolve=>setTimeout(resolve,600));body=body.replace('</article>','<p>Independent source '+url.searchParams.get('parallel_source')+'</p></article>');}res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});res.end(body);return;}
    if(url.pathname==='/v1/chat/completions'){
      const system=input.messages?.[0]?.content||'', task=parseModelPrompt(input.messages);
      let output;
      const key=mode+':'+system.slice(0,50)+':'+(task.query||'');const n=(counts.get(key)||0)+1;counts.set(key,n);
      if(mode==='bad-model'){json({choices:[{message:{content:'not JSON'}}]});return;}
      if(mode==='slow-model')await new Promise(r=>setTimeout(r,5000));
      if(mode==='rewrite-failed' && task.kind==='rewrite'){json({error:{code:'temporarily_unavailable'}},503);return;}
      if(task.kind==='cache_summary')output={summary:'A rain gauge measures rainfall in millimetres.'};
      else if(task.kind==='rewrite' && task.query.includes('plan2-three'))output={queries:[task.query+' east',task.query+' west']};
      else if(task.kind==='rewrite')output={queries:mode==='duplicate-rewrite'?[task.query]:[task.query+((task.current_time||task.local_time)?' '+(task.current_time||task.local_time).slice(0,10):'')+(task.region?' '+task.region:'')+' measurement']};
      else if(task.kind==='score'){
        output={scores:task.candidates.map((c,i)=>({candidate_id:c.candidate_id,relevant:mode!=='irrelevant',score:mode==='tied'?90:95-i}))};
        if(mode==='invalid-score'&&n===1)output.scores=[output.scores[0],{candidate_id:'unknown',relevant:true,score:100},...output.scores.slice(1).flatMap(s=>[s,s])];
      }
      else if(task.mode==='whole_sources' || Array.isArray(task.passages)){
        const passages=task.passages||task.sources.flatMap(s=>s.segments.map(p=>({source_id:s.id,segment_id:p.id,text:p.text})));
        const rows=passages.map(p=>({source_id:p.source_id,segment_id:p.segment_id,relevant:!['irrelevant-passages','no-evidence-explanation'].includes(mode),summary:['irrelevant-passages','no-evidence-explanation'].includes(mode)?'':'Rain gauges record accumulated rainfall.'}));
        const relevant=rows.filter(p=>p.relevant);
        output={passages:rows,...(task.mode==='whole_sources'?{summary:relevant.length?(task.language==='zh'?'雨量计记录累积降水，单位为毫米。':'A rain gauge measures accumulated rainfall in millimetres.'):mode==='no-evidence-explanation'?'There is no relevant evidence for this question.':'',citations:relevant.slice(0,1).map(p=>({source_id:p.source_id,segment_id:mode==='invalid-citation'?'invented':p.segment_id}))}:{})};
      }
      else if(task.kind==='segments'){
        if(mode==='partial-segment'&&task.source_id==='s2'){json({choices:[{message:{content:'{}'}}]});return;}
        if(mode==='budget-segment'&&task.source_id==='s2')await new Promise(r=>setTimeout(r,5000));
        output={source_id:task.source_id,segment_id:task.segment_id,relevant:mode!=='irrelevant-passages',summary:mode==='verbose-segments'?'Rain gauges record accumulated rainfall in millimetres. '.repeat(12):task.language==='zh'?'雨量计记录累积降水，单位为毫米。':'A rain gauge records rainfall in millimetres.'};
      }
      else if(task.kind==='compress')output={summary:'Rain is measured in millimetres.',citations:task.source.segments.map(s=>({source_id:task.source.id,segment_id:s.references?.[0]||s.id}))};
      else output={summary:task.language==='zh'?'雨量计记录累积降水，单位为毫米。':input.model==='fixture-alternate'?'Rain gauges record accumulated rainfall in millimetres.':'A rain gauge measures accumulated rainfall in millimetres.',citations:[{source_id:task.sources[0].id,segment_id:mode==='invalid-citation'?'invented':task.sources[0].segments[0].references?.[0]||task.sources[0].segments[0].id}]};
      json({choices:[{message:{role:'assistant',content:JSON.stringify(output)}}],usage:{prompt_tokens:40,completion_tokens:30}});return;
    }
    if(['/search','/v1/search','/v1/tools/search'].includes(url.pathname)){
      const query=input.query||url.searchParams.get('q')||'';
      if(mode==='fanout'&&query.includes('measurement'))await new Promise(resolve=>{server.fanoutHeld??=[];server.fanoutHeld.push(resolve);});
      if(query.includes('ownership-slow'))await new Promise(r=>setTimeout(r,6000));
      if(req.method==='GET' && url.pathname==='/search'){
        if(server.googleBehavior==='risk'){res.writeHead(429,{'Content-Type':'text/html'});res.end('Search temporarily restricted');return;}
        if(server.googleBehavior==='empty'){res.writeHead(200,{'Content-Type':'text/html'});res.end(searchDocument('google',query,page,{empty:true}));return;}
        if(server.googleBehavior==='delayed')await new Promise(resolve=>setTimeout(resolve,6200));
        if(server.googleBehavior==='slow')await new Promise(resolve=>setTimeout(resolve,9000));
      }
      if(req.method==='GET'&&query.includes('browser-risk')){res.writeHead(429,{'Content-Type':'text/html'});res.end('<html><body>Request throttled</body></html>');return;}
      if(query.includes('upstream-failure')){json({error:{code:'temporarily_unavailable'}},503);return;}
      let results=query.includes('no-match')||mode==='empty'?[]:[{url:page,title:'Rainfall field guide',snippet:'A rain gauge measures rainfall.',raw_content:input.include_raw_content?'# Rainfall\n\nA rain gauge measures rainfall.':undefined,content:input.need_content?'# Rainfall\n\nA rain gauge measures rainfall.':undefined}];
      if(query.includes('plan2-') || mode==='cache')results=Array.from({length:10},(_,i)=>({...results[0],url:page+'?cache_page='+i,title:'Rainfall field guide '+i}));
      if(query.includes('plan2-proof'))results=results.map(row=>({...row,title:'Ubuntu 13.04 Unity startup guide'}));
      if(query.includes('plan2-three'))results=results.map((row,i)=>({...row,url:page+'?variant='+encodeURIComponent(query)+'&rank='+i}));
      if(['duplicate','invalid-score','tied','partial-segment','budget-segment'].includes(mode))results=[...results,{...results[0],url:page+'#duplicate'},{url:origin+'/article?second=1',title:'Second rainfall guide',snippet:'Daily rainfall readings.'}];
      if(mode==='mixed')results.push({url:'file:///invalid',title:'Invalid',snippet:''});
      if(mode==='missing-title')results=results.map(({title,...row})=>row);
      if(mode==='malformed'){json({unexpected:true});return;}
      if(url.pathname==='/v1/tools/search')json({results:results.map(row=>({...row,summary:row.snippet||'',content:row.content||'',site_name:'Fixture',site_icon:null,rerank_score:2.4,authority:3,date:null}))});
      else if(url.pathname==='/v1/search')json({code:0,data:{results}});
      else if(url.searchParams.get('format')==='json')json({results:results.map(r=>({...r,content:r.snippet}))});
      else if(req.method==='GET'){
        res.writeHead(200,{'Content-Type':'text/html'});res.end(searchDocument('google',query,page));
      }else json({results});return;
    }
    if(url.pathname==='/s' && url.searchParams.get('wd')?.includes('browser-risk')){res.writeHead(429,{'Content-Type':'text/html'});res.end('Search temporarily restricted');return;}
    if(url.pathname==='/s'){res.writeHead(200,{'Content-Type':'text/html'});res.end(searchDocument('baidu',url.searchParams.get('wd')||'',page));return;}
    if(url.pathname==='/extract' && mode==='cache-guard' && server.refuseCacheRead){
      json({results:[],failed_results:[{url:input.urls[0],error:'Access denied by target site'}]});return;
    }
    if(url.pathname==='/extract'){if(mode==='emptycontent'){json({results:[],failed_results:[]});return;}json({results:[{url:input.urls[0],raw_content:'# Rainfall\n\nA rain gauge measures rainfall.'}],failed_results:[]});return;}
    if(url.pathname==='/v1/extract'){json({code:0,data:{url:input.url,title:'Rainfall field guide',content:mode==='emptycontent'?'':body,...(mode==='final'?{final_url:page+'?redirected=1'}:{})}});return;}
    if(url.pathname==='/v1/tools/fetch'){if(mode==='emptycontent'){json({title:'Empty',content:''});return;}json({title:'Rainfall field guide',content:'# Rainfall\n\nA rain gauge measures rainfall.'});return;}
    if(url.pathname==='/crawl'){if(mode==='emptycontent'){json({results:[{success:true,markdown:{raw_markdown:''}}]});return;}json({results:[{success:true,title:'Rainfall field guide',markdown:{raw_markdown:'# Rainfall\n\nA rain gauge measures rainfall.'}}]});return;}
    json({error:'not found'},404);
  });
  server.requests=requests;
  return new Promise(resolve=>server.listen(port,host,()=>resolve(server)));
}
if(process.argv[1]?.endsWith('fixture.mjs')){
  await fixture(Number(process.env.PORT||18780));console.log('Fixture ready');
}
