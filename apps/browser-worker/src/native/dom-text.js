/* Read-only semantic serialization shared by every Google card/overview type. */
const googleText = (() => {
  const omitted = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED',
    'NAV', 'FOOTER', 'FORM', 'SELECT', 'OPTION', 'TEXTAREA']);
  const blocks = new Set(['DIV', 'P', 'SECTION', 'ARTICLE', 'HEADER', 'H1', 'H2', 'H3', 'H4', 'H5',
    'H6', 'LI', 'UL', 'OL', 'TABLE', 'TR', 'DL', 'DT', 'DD']);
  const normalize = value => (value || '').normalize('NFC').replace(/\s+/g, ' ').trim();
  const ui = /^(展开|收起|反馈|更多|全部显示|显示更多|显示更少|分享|了解详情|show more|show less|feedback|share|learn more)$/i;
  function unavailable(node) {
    if (node.hidden || node.hasAttribute('inert')) return true;
    const style = getComputedStyle(node);
    return style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility);
  }
  function math(node) {
    const tex = node.querySelector('annotation[encoding="application/x-tex"]');
    if (tex) return '$' + tex.textContent.trim() + '$';
    function expression(element) {
      if (element.nodeType === 3) return element.nodeValue.trim();
      if (element.nodeType !== 1 || ['annotation', 'annotation-xml'].includes(element.localName)) return '';
      const parts = Array.from(element.childNodes).map(expression).filter(Boolean);
      switch (element.localName) {
        case 'mfrac': return '(' + parts[0] + ')/(' + parts[1] + ')';
        case 'msup': return parts[0] + '^(' + parts[1] + ')';
        case 'msub': return parts[0] + '_(' + parts[1] + ')';
        case 'msubsup': return parts[0] + '_(' + parts[1] + ')^(' + parts[2] + ')';
        case 'msqrt': return 'sqrt(' + parts.join('') + ')';
        case 'mroot': return 'root(' + parts.join(', ') + ')';
        default: return parts.join('');
      }
    }
    return node.getAttribute('alttext') || expression(node);
  }
  function read(root, skipped = new Set(), limit = 8192) {
    let visited = 0, size = 0, overflow = false;
    const cap = Math.max(32768, limit + 1);
    function walk(node, pre = false) {
      if (skipped.has(node)) return '';
      if (++visited > 30000 || size >= cap) { overflow = true; return ''; }
      if (node.nodeType === 3) { size += node.nodeValue.length; return node.nodeValue; }
      if (node.nodeType !== 1) return '';
      const tag = node.tagName.toUpperCase(), role = node.getAttribute('role');
      // aria-hidden is used for already-loaded folded answers. CSS visibility,
      // hidden and inert still apply; the DOM is never expanded or mutated.
      if (omitted.has(tag) || unavailable(node) ||
          ['navigation', 'toolbar', 'menu', 'menubar', 'dialog'].includes(role)) return '';
      if (tag === 'MATH') return math(node);
      if (node.matches('.katex, mjx-container')) {
        const formula = node.querySelector('math');
        if (formula) return math(formula);
        if (node.getAttribute('aria-label')) return node.getAttribute('aria-label');
      }
      if (['IMG', 'SVG', 'CANVAS'].includes(tag)) {
        return node.getAttribute('alt') || node.getAttribute('aria-label') ||
          (tag === 'SVG' ? Array.from(node.querySelectorAll('text')).map(text => text.textContent).join(' ') ||
            node.querySelector('title,desc')?.textContent : '') || '';
      }
      if (tag === 'INPUT') {
        if (['button', 'submit', 'reset', 'hidden', 'checkbox', 'radio', 'password', 'file'].includes(node.type)) return '';
        const label = node.getAttribute('aria-label') || Array.from(node.labels || []).map(e => e.textContent).join(' ');
        return label && node.value ? '\n' + normalize(label) + ': ' + node.value + '\n' : '';
      }
      if (tag === 'BR') return '\n';
      const children = () => Array.from(node.childNodes).map(child => walk(child, pre || tag === 'PRE')).join('');
      if (tag === 'PRE') return '\n```\n' + children().replace(/^\n|\n$/g, '') + '\n```\n';
      if (tag === 'CODE' && !pre) return '`' + children() + '`';
      if (tag === 'SUP' || tag === 'SUB') return (tag === 'SUP' ? '^(' : '_(') + children() + ')';
      if (tag === 'TR' || role === 'row') {
        const cells = Array.from(node.children).filter(child =>
          ['TD', 'TH'].includes(child.tagName) || ['cell', 'columnheader', 'rowheader'].includes(child.getAttribute('role')));
        // Nested layout tables are containers; only actual leaf data rows use pipes.
        if (cells.length && !cells.some(cell => cell.querySelector('table,[role="table"]'))) {
          return '\n' + cells.filter(cell => !unavailable(cell)).map(cell => walk(cell, pre).trim()).join(' | ') + '\n';
        }
      }
      if (tag === 'BUTTON' || role === 'button') {
        const value = normalize(children()) || normalize(node.getAttribute('aria-label'));
        return ui.test(value) || !value || /^[\d\s.+−×÷%=(),√^+-]+$/.test(value) ? '' : '\n' + value + '\n';
      }
      const value = children();
      return blocks.has(tag) || ['heading', 'row'].includes(role) ? '\n' + value + '\n' : value;
    }
    const raw = walk(root).normalize('NFC');
    // Preserve code indentation, including spaces which are significant in Python.
    const content = raw.split(/(```[\s\S]*?```)/g).map((part, index) => index % 2 ? part :
      part.replace(/[ \t\u00a0]+/g, ' ').split(/\r?\n/).map(line => line.trim()).join('\n').replace(/\n{3,}/g, '\n\n'))
      .join('').trim();
    const chars = Array.from(content);
    return {content: chars.slice(0, limit).join(''), truncated: overflow || chars.length > limit};
  }
  return {read, unavailable, normalize};
})();
