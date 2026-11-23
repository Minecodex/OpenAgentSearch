let preparedSearch = null;
function oasVisibleControl(node) {
  if (!node.getClientRects().length || node.disabled || node.getAttribute('aria-disabled') === 'true') return false;
  const bounds = node.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return false;
  for (let current = node; current; current = current.parentElement) {
    const style = getComputedStyle(current);
    if (current.hidden || current.hasAttribute('inert') || style.display === 'none' ||
      ['hidden', 'collapse'].includes(style.visibility)) return false;
  }
  return true;
}
function oasSearchInput(engine) {
  const selectors = engine === 'google' ? 'textarea[name="q"],input[name="q"]' :
    '#chat-textarea,#kw,textarea[name="wd"],input[name="wd"],textarea[name="word"],input[name="word"]';
  return [...document.querySelectorAll(selectors)].find(oasVisibleControl);
}
function oasForm(engine, target, home) {
  const google = engine === "google";
  const denied = document.querySelector('form[action*="/sorry/"],iframe[src*="recaptcha"],#captcha,.verify-wrap')
    || /百度安全验证|unusual traffic from your computer network/i.test(document.title)
    || /^(wappass\.baidu\.(com|cn)|consent\.google\.com)$/.test(location.hostname);
  if (denied) return {denied:true};
  if (location.origin !== new URL(home).origin) return {ready:false};
  const first = (scope,selectors) => [...scope.querySelectorAll(selectors)].find(oasVisibleControl);
  const field = oasSearchInput(engine);
  const form = field?.form;
  const button = google ? (form && first(form,'button[type=submit],input[name=btnK],input[type=submit]')) : first(document,'#chat-submit-button,#su');
  if (!field || (!button && !form) || (!form && document.readyState !== "complete")) return {ready:false};
  if (!target) {
    const params = new URL(location.href).searchParams;
    return {ready:true,previous:params.get(google?'q':'wd') || (!google && params.get('word')) || ''};
  }
  const url = new URL(target), query = url.searchParams.get(google?"q":"wd");
  if (url.origin !== new URL(home).origin) throw Error("URL_NOT_ALLOWED");
  if (form) {
    for (const previous of form.querySelectorAll('[data-oas-filter]')) previous.remove();
    for (const key of ['tbs','gpc','hl','ie','num','rn']) {
      let item=form.elements.namedItem(key);
      if (!url.searchParams.has(key)) {if(item && 'disabled' in item)item.disabled=true;continue;}
      if (!item || !('value' in item)) {item=document.createElement('input');item.type='hidden';item.name=key;item.dataset.oasFilter='';form.append(item);}
      item.disabled=false;item.value=url.searchParams.get(key);
    }
    form.target='_self';
  }
  const prototype=field instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype,'value').set.call(field,query);
  field.dispatchEvent(new Event('input',{bubbles:true}));
  field.dispatchEvent(new Event('change',{bubbles:true}));
  const token=[...crypto.getRandomValues(new Uint32Array(4))].join('-');
  document.documentElement.dataset.oasSubmitted=token;
  const root=document.querySelector(google?'#rso,#search':'#content_left');
  if(root)root.dataset.oasPrevious=token;
  preparedSearch={token,field,form,button,query,engine};
  return {prepared:true,document:token};
}
function oasCommit(token) {
  const pending=preparedSearch;preparedSearch=null;
  if(!pending || pending.token!==token || !pending.field.isConnected || pending.field.value!==pending.query
    || oasSearchInput(pending.engine)!==pending.field
    || pending.field.form!==pending.form || (pending.button && !pending.button.isConnected))throw Error('SEARCH_RESULTS_UNAVAILABLE');
  if(pending.button)pending.button.click();else pending.form.requestSubmit();
  return {committed:true};
}
