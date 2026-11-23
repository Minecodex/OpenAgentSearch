/* Shared DOM readiness signals. Independent of engine and card business type. */
const searchMaterial = (() => {
  const loading = '[aria-busy="true"],[role="progressbar"],[data-state="streaming"],' +
    '[data-status="generating"],[data-state="loading"],[data-status="loading"],[data-complete="false"]';
  const controls = 'button,[role="button"],nav,[role="navigation"],[role="toolbar"],[role="menu"]';
  function visible(node) {
    if (!node.getClientRects().length) return false;
    for (let current = node; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (current.hidden || current.hasAttribute('inert') || style.display === 'none' ||
          ['hidden', 'collapse'].includes(style.visibility)) return false;
    }
    return true;
  }
  function pendingNodes(root, skipped = new Set()) {
    if (!root) return [];
    return [root, ...root.querySelectorAll(loading)].filter(node => node.matches(loading) &&
      !node.closest(controls) && !Array.from(skipped).some(skip => skip.contains(node)) && visible(node));
  }
  const meaningful = text => (text || '').split(/\n+/).some(line => {
    const value = line.replace(/\s+/g, ' ').trim();
    return value && !/^(?:AI Overview|AI 概览|Loading[.… ]*|Thinking(?: a little longer)?[.… ]*|Searching[.… ]*|正在(?:思考|搜索|加载)[.… ]*|加载中[.… ]*)$/i.test(value);
  });
  function readiness(root, skipped = new Set()) {
    const nodes = pendingNodes(root, skipped);
    const pending = nodes.some(node => {
      const region = node.closest('aside,section,article,[role="region"],li.b_ans') || node;
      const scope = root.contains(region) ? region : node;
      return meaningful(scope.textContent);
    });
    return {pending, discovering: nodes.length > 0};
  }
  // Assigning input.value does not produce a MutationObserver record.
  const values = (root, selector = 'input') => JSON.stringify(Array.from(root?.querySelectorAll(selector) || [])
    .filter(node => !['hidden', 'password', 'file', 'button', 'submit', 'reset', 'checkbox', 'radio'].includes(node.type))
    .map(node => [node.getAttribute('aria-label'), node.value]));
  return {visible, pendingNodes, meaningful, readiness,
    pending: (root, skipped) => pendingNodes(root, skipped).length > 0, values};
})();
