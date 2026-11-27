/* Baidu boundaries. Rendering, submission and references stay in this document. */
const baiduSearch = (() => {
  const {read, normalize} = googleText;
  const clipped = (value, size) => Array.from(value || '').slice(0, size).join('');
  const visible = node => !!node && searchMaterial.visible(node) &&
    !!node.getBoundingClientRect().width && !!node.getBoundingClientRect().height;
  const input = () => Array.from(document.querySelectorAll('#chat-textarea,textarea[name="wd"],input[name="wd"]')).find(visible);
  const submit = () => Array.from(document.querySelectorAll('#chat-submit-button,#su')).find(visible);
  const query = () => new URL(location.href).searchParams.get('wd') ?? new URL(location.href).searchParams.get('word');
  const ready = () => {
    const field = input(), button = submit();
    // The new server-rendered controls exist before Baidu attaches its JS
    // submit handler. The legacy form has a native submission path.
    return !!field && !!button && !field.disabled && !button.disabled &&
      button.getAttribute('aria-disabled') !== 'true' && (!!field.form || document.readyState === 'complete');
  };
  const blocked = () => !!document.querySelector('#captcha,#verify-bar,#vcode-spin,iframe[src*="captcha"],form[action*="verify"]') ||
    /百度安全验证/.test(document.title);
  const aiSelector = '[tpl="wenda_generate"],[tpl="new_baikan_index"]';
  const unitSelector = '.c-container,[tpl][srcid]';
  const uiSelector = 'script,style,noscript,template,button,[role="button"],textarea,nav,[role="navigation"],' +
    '[role="toolbar"],[role="status"],.c-tools,.c-icon,[data-module="source"],.cosd-markdown-intent,' +
    '.cosd-citation,[class*="fold-switch"],[class*="interact-container_"],[class*="footer-container_"],' +
    '[class*="footer-contact_"],[class*="footer-text-two_"],[class*="footer-right_"],.cosd-video-scroll-card,' +
    '[class*="calc-oprate_"],[class*="calc-show-btn_"],[tpl="recommend_list"],[tpl="right_toplist1"]';
  let observed = [], observers = [], dirty = true, cached = null, cacheKey = '', refs = null;

  function outbound(href) {
    if (!href || href === 'null') return null;
    try {
      const url = new URL(href, location.href);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.href.length > 2048 ||
          url.hostname === 'nourl.ubs.baidu.com' ||
          (['baidu.com', 'www.baidu.com'].includes(url.hostname) && url.pathname !== '/link')) return null;
      return url.href;
    } catch (_) { return null; }
  }
  function advertising(node) {
    if (!node?.matches) return false;
    if (node.matches('.EC_result,[data-tuiguang],.ec-tuiguang,.ecfc-tuiguang')) return true;
    if (node.hasAttribute('data-click')) {
      try { if (JSON.parse(node.getAttribute('data-click')).fm === 'pp') return true; } catch (_) {}
    }
    return false;
  }
  function ads(root) {
    const skipped = new Set();
    for (const node of root.querySelectorAll('.EC_result,[data-tuiguang],.ec-tuiguang,.ecfc-tuiguang,[data-click],a[href]')) {
      let ad = advertising(node);
      if (!ad && node.matches('a[href]')) {
        try { const url = new URL(node.href); ad = ['www.baidu.com', 'baidu.com'].includes(url.hostname) && url.pathname === '/baidu.php'; }
        catch (_) {}
      }
      if (!ad) continue;
      const unit = node.closest('.EC_result') || node.closest(unitSelector) || node;
      if (unit !== root && root.contains(unit)) skipped.add(unit);
    }
    return skipped;
  }
  const inside = (node, skipped) => Array.from(skipped).some(top => top === node || top.contains(node));
  function navigation(node) {
    if (['recommend_list', 'right_toplist1'].includes(node.getAttribute('tpl'))) return true;
    if (!/大家还在搜|相关搜索|百度热搜/.test(node.textContent)) return false;
    const links = Array.from(node.querySelectorAll('a[href]'));
    return links.length > 0 && links.every(anchor => {
      try { const url = new URL(anchor.href); return ['www.baidu.com', 'baidu.com', 'top.baidu.com'].includes(url.hostname) &&
        ['/s', '/board'].includes(url.pathname); } catch (_) { return false; }
    });
  }
  function units(root) {
    const all = Array.from(root?.querySelectorAll(unitSelector) || []);
    return all.filter(node => !all.some(other => other !== node && other.contains(node)));
  }
  function text(node, excluded, limit = 8192) {
    const skipped = new Set([...excluded, ...node.querySelectorAll(uiSelector)]);
    return read(node, skipped, limit);
  }
  function aiRoots(left, right) {
    const roots = Array.from(document.querySelectorAll('#content_left ' + aiSelector.split(',').join(',#content_left ') +
      ',#content_right ' + aiSelector.split(',').join(',#content_right ')));
    for (const area of [left, right].filter(Boolean)) {
      for (const label of area.querySelectorAll('[class*="footer-contact_"],[class*="footer-text-two_"]')) {
        if (!/^(内容由AI生成|以上内容均由AI生成)$/.test(normalize(label.textContent))) continue;
        const unit = label.closest(unitSelector);
        if (unit && !roots.includes(unit)) roots.push(unit);
      }
    }
    return roots;
  }
  function tooltipSources(tooltip) {
    const values = [], seen = new Set();
    for (const anchor of tooltip.querySelectorAll('a.cosd-citation-title[href]')) {
      const url = outbound(anchor.href);
      if (!url || seen.has(url) || anchor.closest('[data-tuiguang],.EC_result')) continue;
      seen.add(url);
      values.push({url, title: clipped(normalize(anchor.textContent || anchor.title), 200)});
    }
    return values;
  }
  const tooltipSignature = tooltip => JSON.stringify(tooltipSources(tooltip));
  function collectReferences() {
    if (!refs) return;
    const pending = refs.pending;
    if (!refs.root.isConnected || (pending && (!pending.trigger.isConnected || !refs.root.contains(pending.trigger)))) {
      refs = null; dirty = true; return;
    }
    for (const tooltip of pending ? document.querySelectorAll('.cosd-citation-tooltip') : []) {
      if (pending.before.get(tooltip) === tooltipSignature(tooltip)) continue;
      const sources = tooltipSources(tooltip);
      if (!sources.length) continue;
      refs.panels.add(tooltip);
      refs.pending = null;
      break;
    }
    const sources = [];
    for (const panel of refs.panels) if (panel.isConnected) for (const source of tooltipSources(panel)) {
      if (sources.length < 10 && !sources.some(prior => prior.url === source.url)) sources.push(source);
    }
    if (JSON.stringify(sources) !== JSON.stringify(refs.sources)) { refs.sources = sources; dirty = true; }
    if (pending && Date.now() - pending.started >= 300) { refs.pending = null; dirty = true; }
  }
  function answerBody(root) {
    return root.getAttribute('tpl') === 'wenda_generate' ? root.querySelector('.cosd-markdown-content') :
      root.querySelector('[class*="content-folded_"]') || root.querySelector('.cosd-markdown');
  }
  function answer(root, excluded) {
    const known = root.matches(aiSelector);
    const wenda = root.getAttribute('tpl') === 'wenda_generate';
    const owner = root.firstElementChild, body = answerBody(root);
    const {content, truncated} = body ? text(body, excluded) : {content:'', truncated:false};
    const marker = root.getAttribute('data-complete') || owner?.getAttribute('data-complete');
    const footer = !wenda && Array.from(root.querySelectorAll('[class*="footer-contact_"]')).some(node =>
      visible(node) && normalize(node.textContent) === '内容由AI生成');
    const done = marker !== 'false' && (marker === 'true' ||
      (wenda ? owner?.classList.contains('wenda-general-finished') : footer));
    const busy = searchMaterial.pending(root, excluded);
    const bodySignature = JSON.stringify([content, !!done]);
    if (!refs || refs.root !== root || refs.signature !== bodySignature) {
      refs = {root, signature:bodySignature, sources:[], panels:new Set(), attempted:new Set(), pending:null};
    }
    const sources = [], seen = new Set();
    for (const anchor of root.querySelectorAll('.cosd-citation a[href],a.cosd-citation-title[href]')) {
      if (inside(anchor, excluded)) continue;
      const url = outbound(anchor.href);
      if (!url || seen.has(url)) continue;
      seen.add(url); sources.push({url, title:clipped(normalize(anchor.textContent || anchor.title), 200)});
      if (sources.length === 10) break;
    }
    for (const source of refs.sources) if (!seen.has(source.url) && sources.length < 10) {
      seen.add(source.url); sources.push(source);
    }
    const eligible = known && !!content && !truncated && !!done && !busy;
    const needsSources = eligible && sources.length < 10 && (!!refs.pending ||
      Array.from(root.querySelectorAll('span.cosd-citation')).some(node => visible(node) && !refs.attempted.has(node)));
    const ready = eligible && sources.length > 0;
    return {answerState:ready ? 'ready' : 'pending', answerSignature:JSON.stringify([content, sources, !!done]),
      answerProgress:searchMaterial.meaningful(content), answerNeedsSources:needsSources,
      ...(ready ? {answer:{provider:'baidu', content, sources}} : {})};
  }
  function references(signature) {
    if (!refs || signature !== cached?.ai.answerSignature || !refs.root.isConnected) return false;
    collectReferences();
    if (!refs || refs.pending || refs.sources.length >= 10 || refs.attempted.size >= 10) return false;
    const trigger = Array.from(refs.root.querySelectorAll('span.cosd-citation')).find(node => visible(node) && !refs.attempted.has(node));
    if (!trigger) return false;
    refs.attempted.add(trigger);
    refs.pending = {trigger, started:Date.now(), before:new Map(Array.from(document.querySelectorAll('.cosd-citation-tooltip'))
      .map(node => [node, tooltipSignature(node)]))};
    trigger.click(); dirty = true;
    return true;
  }
  function snapshot(limit, allowAnswer) {
    const left = document.querySelector('#content_left'), right = document.querySelector('#content_right');
    if (observed[0] !== left || observed[1] !== right) {
      observers.forEach(observer => observer.disconnect()); observed = [left, right]; dirty = true; cached = null; refs = null;
      observers = observed.filter(Boolean).map(root => {
        const observer = new MutationObserver(() => {dirty = true;});
        observer.observe(root, {subtree:true, childList:true, characterData:true, attributes:true,
          attributeFilter:['class','style','hidden','inert','aria-hidden','aria-busy','aria-disabled','disabled','href',
            'data-state','data-status','data-complete','data-tuiguang','data-click','tpl','srcid','mu','value','alt','title']});
        return observer;
      });
    }
    if (observers.some(observer => observer.takeRecords().length)) dirty = true;
    collectReferences();
    const key = JSON.stringify([limit, allowAnswer, searchMaterial.values(left), searchMaterial.values(right)]);
    if (!dirty && cached && key === cacheKey) return cached;
    dirty = false; cacheKey = key;
    const areas = [left, right].filter(Boolean), excluded = new Set(areas.flatMap(root => Array.from(ads(root))));
    const ais = aiRoots(left, right).filter(node => visible(node) && !inside(node, excluded));
    const skipped = new Set([...excluded, ...ais]);
    const ai = allowAnswer && ais.length ? answer(ais[0], excluded) :
      {answerState:'none', answerSignature:null, answerProgress:false, answerNeedsSources:false};
    const rows = [], cards = [], seen = new Set();
    let remaining = 8192;
    for (const area of areas) {
      const items = Array.from(new Set([...units(area), ...ais.filter(node => area.contains(node))]))
        .sort((a, b) => a === b ? 0 : (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);
      for (const item of items) {
        const generated = ais.includes(item);
        if (inside(item, excluded) || (!generated && inside(item, skipped)) ||
            ais.some(root => root !== item && root.contains(item)) || navigation(item) || !visible(item)) continue;
        const heading = item.querySelector('h3'), anchor = heading?.querySelector('a[href]') || heading?.closest('a[href]');
        if (!generated && area === left && (item.classList.contains('result') || item.getAttribute('tpl') === 'www_index')) {
          const url = outbound(item.getAttribute('mu')) || outbound(anchor?.href);
          const title = normalize(heading?.textContent);
          if (!url || !title || seen.has(url) || inside(anchor || item, excluded)) continue;
          seen.add(url);
          const body = item.querySelector('[data-module="abstract"],.c-abstract') || item;
          const snippet = normalize(text(body, new Set([...excluded, ...(heading ? [heading] : [])]), 2000).content);
          if (rows.length < limit) rows.push({url, title:clipped(title, 200), snippet:clipped(snippet, 1000)});
        } else if (allowAnswer && cards.length < 10 && remaining > 0) {
          // Readable generated text can be material before it qualifies as a direct answer.
          if (generated && item === ais[0] && ai.answerState === 'ready') continue;
          const body = generated ? answerBody(item) || (item.matches(aiSelector) ? null : item) : item;
          if (!body) continue;
          const omitted = generated ? new Set([...skipped].filter(node => node !== item)) : skipped;
          const value = text(body, omitted, remaining).content.replace(/[\uE000-\uF8FF]/g, '').trim();
          if (!value || (generated && !searchMaterial.meaningful(value))) continue;
          const content = clipped(value, remaining);
          cards.push({title:clipped(normalize(heading?.textContent || content.split('\n')[0]), 200), content});
          remaining -= Array.from(content).length;
        }
      }
    }
    const signals = areas.map(root => searchMaterial.readiness(root, skipped));
    const empty = !rows.length && !cards.length && !ais.length && areas.some(root =>
      Array.from(root.querySelectorAll('.nors,#content_none,.search-none')).some(node => visible(node) &&
        /没有找到.*相关|未找到.*相关|抱歉.*没有找到/.test(node.textContent)));
    cached = {root:left || right, rows, cards, ai, empty,
      pending:signals.some(value => value.pending), discovering:signals.some(value => value.discovering)};
    return cached;
  }
  return {input, submit, query, ready, blocked, snapshot, references};
})();
