/* Google-specific boundaries; card contents use the same semantic DOM reader. */
const googleSearch = (() => {
  const {read, normalize} = googleText;
  const clipped = (value, size) => Array.from(value || '').slice(0, size).join('');
  const input = () => document.querySelector('textarea[name="q"],input[name="q"]');
  const main = () => document.querySelector('#rcnt, #center_col') || document.querySelector('main,[role="main"],#search,#rso');
  const googleHost = host => /(^|\.)google\.(?:com|[a-z]{2,3}|com\.[a-z]{2}|co\.[a-z]{2})$/i.test(host);
  function outbound(href) {
    try {
      const url = new URL(href, location.href);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
      if (googleHost(url.hostname)) {
        if (!['/url', '/goto'].includes(url.pathname)) return null;
        const target = url.searchParams.get('q') || url.searchParams.get('url') || '';
        if (/^https?:\/\//i.test(target)) return outbound(target);
        if (url.pathname !== '/goto' || !target) return null;
      }
      return url.href.length <= 2048 ? url.href : null;
    } catch (_) { return null; }
  }
  function blocked() {
    return location.pathname.startsWith('/sorry') || !!document.querySelector(
      '#captcha, #recaptcha, iframe[src*="recaptcha"], form[action*="consent.google"], form[action*="/sorry/"]') ||
      (!main() && /unusual traffic from your computer network|检测到异常流量|计算机网络中存在异常流量/i.test(document.body?.textContent || ''));
  }
  function aiRoots(root) {
    const roots = [];
    for (const heading of root.querySelectorAll('h1,h2,h3,[role="heading"]')) {
      if (!/^(AI 概览|AI Overview)$/i.test(normalize(heading.textContent))) continue;
      const top = heading.closest('[data-scope-id="turn"]') || heading.closest('section');
      if (top && root.contains(top) && top !== root && !top.querySelector('#rso') && !roots.includes(top)) roots.push(top);
    }
    return roots;
  }
  function busy(root) {
    return searchMaterial.pending(root);
  }
  function answer(root) {
    const body = root.querySelector('[data-container-id="main-col"]') || root;
    const skipped = new Set(root.querySelectorAll('[data-ignore-copy],[role="status"]'));
    const sources = [], seen = new Set();
    for (const scope of body === root ? [root] : [body, root]) {
      for (const anchor of scope.querySelectorAll('a[href]')) {
        const url = outbound(anchor.href);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        sources.push({url, title: clipped(normalize(anchor.textContent || anchor.getAttribute('aria-label') || anchor.title), 200)});
        if (sources.length === 10) break;
      }
      if (sources.length) break;
    }
    const {content, truncated} = read(body, skipped);
    // Descendant completion only describes that fragment, never the whole answer.
    const marker = root.getAttribute('data-complete');
    const footer = Array.from(root.querySelectorAll('footer,[role="contentinfo"]')).some(node => searchMaterial.visible(node) &&
      /AI 回答可能包含错误|AI responses may include mistakes|AI can make mistakes/i.test(node.textContent));
    // Current turn templates expose an enabled copy action only after streaming.
    // It must belong to this turn's controls, outside its answer body.
    const copyReady = body !== root && Array.from(root.querySelectorAll('button[aria-label]')).some(node =>
      /^(复制文字|Copy text)$/i.test(node.getAttribute('aria-label')) &&
      node.closest('[data-scope-id="turn"]') === root && node.closest('[data-ignore-copy]') &&
      !body.contains(node) && !node.disabled && node.getAttribute('aria-disabled') !== 'true' && searchMaterial.visible(node));
    const done = marker === 'true' || (marker !== 'false' && (footer || copyReady));
    const ready = content && !truncated && sources.length && done && !busy(root);
    return {answerState: ready ? 'ready' : 'pending', answerSignature: JSON.stringify([content, sources, done, ready]),
      answerProgress: sources.length > 0 || searchMaterial.meaningful(content),
      ...(ready ? {answer: {provider: 'google', content, sources}} : {})};
  }
  let current = null, observer = null, dirty = true, cached = null, cacheKey = '';
  const ignored = 'script,noscript,template,iframe,object,embed,nav,[role="navigation"],[role="toolbar"],[role="menu"],[role="dialog"]';
  const changed = records => {
    if (records.some(record => ['role', 'disabled', 'aria-disabled'].includes(record.attributeName) ||
        !(record.target.nodeType === 1 ? record.target : record.target.parentElement)?.closest(ignored))) dirty = true;
  };
  function snapshot(limit, allowAnswer) {
    const root = main(), key = `${limit}:${allowAnswer}:${searchMaterial.values(root)}`;
    if (root !== current) {
      observer?.disconnect(); current = root; dirty = true;
      observer = root ? new MutationObserver(changed) : null;
      observer?.observe(root, {subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter:['href','id','class','style','hidden','inert','role','aria-hidden','aria-label','aria-busy',
          'data-scope-id','data-complete','data-state','data-status','data-snc','data-rpos','alt','title','type','value','for','encoding','alttext',
          'data-container-id','data-ignore-copy','disabled','aria-disabled']});
    }
    if (observer) changed(observer.takeRecords());
    if (!dirty && cached && key === cacheKey) return cached;
    dirty = false; cacheKey = key;
    const ais = root ? aiRoots(root) : [];
    const inAI = node => ais.some(top => top.contains(node));
    const rows = [], rowNodes = new Set(), seen = new Set();
    for (const heading of root?.querySelectorAll('#rso h3,#search .g h3') || []) {
      const anchor = heading.closest('a[href]');
      if (!anchor || inAI(anchor)) continue;
      const url = outbound(anchor.href), title = normalize(heading.textContent);
      if (!url || !title || seen.has(url)) continue;
      seen.add(url);
      let item = anchor.closest('[data-snc],[data-rpos],.MjjYud,.g') || anchor;
      // MjjYud is reused for unrelated widgets. Never subtract a multi-result or AI wrapper.
      if (Array.from(item.querySelectorAll('h3')).filter(h => h.closest('a[href]')).length !== 1 ||
          ais.some(top => item.contains(top))) item = anchor;
      rowNodes.add(item);
      const snippet = normalize(read(item, new Set([anchor]), 2000).content);
      if (rows.length < limit) rows.push({url, title: clipped(title, 200), snippet: clipped(snippet, 1000)});
    }
    const ai = allowAnswer && ais.length ? answer(ais[0]) : {answerState:'none', answerSignature:null, answerProgress:false};
    const empty = !!root && !rows.length &&
      /did not match any documents|No results found|找不到和您查询|没有找到.*相关|未找到.*结果/i.test(root.textContent);
    const cards = [];
    const skipped = new Set([...rowNodes, ...ais, ...(root?.querySelectorAll('[data-ignore-copy],[role="status"]') || [])]);
    for (const heading of root?.querySelectorAll('h1,h2,h3,[role="heading"]') || []) {
      const label = normalize(heading.textContent);
      if (/^(Web (?:search )?results|网页(?:搜索)?结果|網頁(?:搜尋)?結果|搜索结果|搜尋結果|Search results)$/i.test(label)) skipped.add(heading);
      if (!/^(用户还搜索了|相关搜索|People also search for|Related searches)$/i.test(label)) continue;
      skipped.add(heading);
      // Query-link navigation is not a factual card. Keep unrelated sibling widgets.
      for (let region = heading.parentElement; region && region !== root; region = region.parentElement) {
        const links = Array.from(region.querySelectorAll('a[href]'));
        if (!links.length) continue;
        if (links.every(anchor => {
          try {
            const url = new URL(anchor.href, location.href);
            return googleHost(url.hostname) && url.pathname === '/search' && !!url.searchParams.get('q');
          } catch (_) { return false; }
        })) skipped.add(region);
        break;
      }
    }
    for (const node of root?.querySelectorAll('span') || []) {
      if (/^(正在(?:思考|搜索|加载)|再多想一会儿|Thinking(?: a little longer)?|Searching|Loading|加载中)[.… ]*$/i.test(normalize(node.textContent))) skipped.add(node);
    }
    const pendingNodes = searchMaterial.pendingNodes(root, skipped);
    const readiness = searchMaterial.readiness(root, skipped);
    if (root && allowAnswer && !empty) {
      // Known overviews go exclusively through the completion/citation gate.
      pendingNodes.forEach(node => skipped.add(node));
      const material = read(root, skipped).content;
      if (material) cards.push({title: clipped(material.split('\n')[0], 200), content: material});
    }
    cached = {root, rows, cards, ai, empty, ...readiness};
    return cached;
  }
  return {input, blocked, snapshot};
})();
