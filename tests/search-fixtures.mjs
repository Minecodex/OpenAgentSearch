const escaped=value=>String(value).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
const script=code=>'<script>'+code+'</script>';

// Engine-shaped fixtures exercise the real extension, MutationObserver and DOM
// serializer. None of the fixture scripts alters navigator.webdriver.
export function searchDocument(engine,query,page,{empty=false}={}){
 const google=engine==='google',path=google?'/search':'/s',name=google?'q':'wd';
 const cardOnly=/card-only|ai-only|late-material/.test(query);
 let organic=empty||cardOnly?'':google
  ? `<div class="g"><a href="${page}"><h3>Rainfall field guide</h3></a><div class="VwiC3b">A rain gauge measures rainfall.</div></div>`
  : `<div class="result c-container" tpl="www_index" mu="${page}"><h3><a href="${page}">Rainfall field guide</a></h3><div class="c-abstract" data-module="abstract">A rain gauge measures rainfall.</div></div>`;
 if(query.includes('plan2-'))organic=Array.from({length:10},(_,index)=>organic.replaceAll(page,page+'?cache_page='+index).replaceAll('Rainfall field guide','Rainfall source '+index)).join('');
 if(query.includes('concurrent-readers'))organic=Array.from({length:4},(_,index)=>organic.replaceAll(page,page+'?parallel_source='+index).replaceAll('Rainfall field guide','Rainfall source '+index)).join('');
 const noResults=empty?(google?'No results found':'<div class="nors">抱歉，没有找到相关结果</div>'):'';
 const region=google?`<main id="rcnt"><div id="search"><div id="rso">${organic}${noResults}</div><div id="card-zone"></div><div id="answer-zone"></div></div></main>`
  : `<div id="content_left">${organic}${noResults}<div id="card-zone"></div><div id="answer-zone"></div></div><div id="content_right"></div>`;
 if(query.includes('hydrating-search')){
  const content=`<form action="${path}"><input ${google?'':'id="kw"'} name="${name}" value="${escaped(query)}"><button type="submit" ${google?'':'id="su"'}>Search</button></form>${region}`;
  return `<html><head><meta charset="utf-8"></head><body>${script(`setTimeout(()=>document.body.insertAdjacentHTML('beforeend',${JSON.stringify(content)}),1000);`)}</body></html>`;
 }
 let dynamic='';
 if(/weather-card|card-only|late-material|live-value/.test(query)&&!query.includes('ai-only')){
  const weather='<div id="weather" class="c-container" tpl="weather" srcid="weather" role="region"><h2>Rainfall weather card</h2><p>广州 · 今日降雨</p><img alt="多云"><label>降雨量<input aria-label="降雨量" value="7" type="text"></label><table><tr><th>日期</th><th>降水</th></tr><tr><td>今天</td><td>12 mm</td></tr></table><pre><code>rain = 12</code></pre><span hidden>HIDDEN_NOISE</span><nav>QUERY_NAVIGATION_NOISE</nav><button>反馈</button></div>';
  const related=google?'<section><h2>Related searches</h2><a href="https://www.google.com/search?q=suggestion">QUERY_SUGGESTION_NOISE</a></section>'
   :'<div class="c-container" tpl="recommend_list" srcid="suggestions">相关搜索<a href="/s?wd=suggestion">QUERY_SUGGESTION_NOISE</a></div><div class="EC_result c-container">AD_NOISE<a href="https://www.baidu.com/baidu.php?ad=1">广告</a></div>';
  dynamic+=script(`setTimeout(()=>{document.querySelector('#card-zone').innerHTML=${JSON.stringify(weather+related)};},${query.includes('late-material')?4200:150});`);
  if(query.includes('live-value'))dynamic+=script("setTimeout(()=>{document.querySelector('#weather input').value='12';},1800);");
 }
 if(query.includes('ai-card')||query.includes('ai-only')){
  const popup=query.includes('popup'),never=query.includes('unfinished'),fragment=query.includes('fragment'),only=query.includes('ai-only');
  const answer='<p>A rain gauge measures precipitation.</p>'+(popup?'<span class="cosd-citation" tabindex="0">引用</span>':'<a class="cosd-citation-title" href="https://example.org/rain-source">Rain evidence</a>');
  const marker=fragment?'':`data-complete="${never?'false':'true'}"`;
  const googleBlock=`<section data-scope-id="turn" ${marker}><h2>AI Overview</h2><div data-container-id="main-col">${answer}${never||fragment?'<div data-complete="true">Fragment complete</div><button aria-label="Copy text">Copy</button><p>AI can make mistakes</p>':''}</div></section>`;
  const baiduBlock=`<div tpl="wenda_generate" class="c-container" ${marker}><div class="${never||fragment?'wenda-generating':'wenda-general-finished'}"><div class="cosd-markdown-content">${answer}${never||fragment?'<div data-complete="true">Fragment complete</div><p>内容由AI生成</p>':''}</div></div></div>`;
  const pending=google?'<section data-scope-id="turn" data-complete="false"><h2>AI Overview</h2><div data-container-id="main-col" aria-busy="true">正在搜索…</div></section>'
   :'<div tpl="wenda_generate" class="c-container" data-complete="false"><div><div class="cosd-markdown-content" aria-busy="true">正在搜索…</div></div></div>';
  if(only)dynamic+=script(`setTimeout(()=>document.querySelector('#answer-zone').innerHTML=${JSON.stringify(pending)},100);`);
  dynamic+=script(`setTimeout(()=>{document.querySelector('#answer-zone').innerHTML=${JSON.stringify(google?googleBlock:baiduBlock)};
   ${popup&&!google?`
    document.body.insertAdjacentHTML('beforeend','<div class="cosd-citation-tooltip"><a class="cosd-citation-title" href="https://example.org/stale-source">Old unrelated tooltip</a></div>');
    let clicks=0;document.querySelector('span.cosd-citation').onclick=()=>{
     clicks++;const stale=${JSON.stringify(query.includes('stale'))}&&clicks===1;
     if(stale)setTimeout(()=>document.querySelector('.cosd-markdown-content p').textContent='New rainfall answer.',10);
     setTimeout(()=>{document.body.insertAdjacentHTML('beforeend','<div class="cosd-citation-tooltip"><a class="cosd-citation-title" href="https://example.org/'+(stale?'stale-answer-source':'rain-source')+'">Rain evidence</a></div>');},30);
    };` : ''}
  },${only||query.includes('late-ai-card')?4500:450});`);
 }
 return `<html><head><meta charset="utf-8"><title>Search fixture</title></head><body><div hidden><textarea name="${name}" id="chat-textarea"></textarea><button id="chat-submit-button">Hidden submit</button></div><input name="${name}" disabled value="stale"><form action="${path}"><input ${google?'':'id="kw"'} name="${name}" value="${escaped(query)}"><button type="submit" ${google?'':'id="su"'}>${google?'Google':'Baidu'}</button></form>${region}${dynamic}</body></html>`;
}
