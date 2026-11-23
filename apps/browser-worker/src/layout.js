const resources = arguments[0];
const clone = document.documentElement.cloneNode(true);
let missing = arguments[1];
const original = [document.documentElement, ...document.documentElement.querySelectorAll("*")];
const copied = [clone, ...clone.querySelectorAll("*")];
clone.querySelectorAll("script,noscript,iframe,object,embed,base,meta[http-equiv]").forEach(el => el.remove());
const rewrite = (css, base) => css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_, q, raw) => {
  if (raw.startsWith("data:") || raw.startsWith("#")) return "url(" + JSON.stringify(raw) + ")";
  let absolute;
  try { absolute = new URL(raw, base).href; } catch { missing++; return "none"; }
  const saved = resources[absolute];
  if (!saved) { missing++; return "none"; }
  return "url(" + JSON.stringify(saved) + ")";
}).replace(/@import[^;]+;/gi, "");
// Keep font faces and pseudo elements in addition to the frozen computed box
// styles. Resolving a stylesheet URL uses that sheet's own base URL.
const extra = [];
const visited = new Set();
const stylesheet = (sheet) => {
  if (!sheet || visited.has(sheet)) return;
  visited.add(sheet);
  const base = sheet.href || document.baseURI;
  try {
    for (const rule of sheet.cssRules) {
      if (rule.type === CSSRule.IMPORT_RULE) stylesheet(rule.styleSheet);
      else if (rule.type === CSSRule.FONT_FACE_RULE) extra.push(rewrite(rule.cssText, base));
      else if (rule.cssRules) {
        for (const nested of rule.cssRules) if (nested.type === CSSRule.FONT_FACE_RULE) extra.push(rewrite(nested.cssText, base));
      }
    }
  } catch {
    const saved = resources[base];
    if (saved) {
      try {
        const raw = new TextDecoder().decode(Uint8Array.from(atob(saved.split(",")[1]), c => c.charCodeAt(0)));
        for (const face of raw.match(/@font-face\s*\{[^}]*\}/gi) || []) extra.push(rewrite(face, base));
      } catch { missing++; }
    } else missing++;
  }
};
[...document.styleSheets].forEach(stylesheet);
for (let i = 0; i < copied.length; i++) {
  const el = copied[i], source = original[i];
  if (!el.parentNode && el !== clone) continue;
  for (const attr of [...el.attributes]) {
    if (/^on/i.test(attr.name) || ["href","src","srcset","action","formaction","ping","background"].includes(attr.name)) el.removeAttribute(attr.name);
  }
  if (source && i < 6000) {
    const style = getComputedStyle(source);
    el.setAttribute("style", rewrite([...style].map(name => name + ":" + style.getPropertyValue(name)).join(";"), document.baseURI));
    el.setAttribute("data-oas-archive",String(i));
    for (const pseudo of ["::before","::after"]) {
      const computed=getComputedStyle(source,pseudo);
      if (computed.content && !["none","normal","\"\""].includes(computed.content)) {
        extra.push(`[data-oas-archive="${i}"]${pseudo}{`+rewrite([...computed].map(name=>name+":"+computed.getPropertyValue(name)).join(";"),document.baseURI)+"}");
      }
    }
  } else if (source && i >= 6000) {
    missing++;
  }
  if (source?.tagName === "IMG") {
    const src=source.currentSrc||source.src;
    const saved = src.startsWith("data:")?src:resources[src];
    if (saved) el.setAttribute("src", saved);
    else { missing++; el.setAttribute("alt", source.alt || "Archived image unavailable"); }
  }
  if (el.tagName === "A") el.removeAttribute("target");
  if (el.tagName === "STYLE") el.textContent = rewrite(el.textContent, document.baseURI);
  if (el.tagName === "LINK") el.remove();
}
const archivedStyles=document.createElement("style");
archivedStyles.textContent=extra.join("\n");
clone.querySelector("head")?.append(archivedStyles);
const policy = document.createElement("meta");
policy.httpEquiv = "Content-Security-Policy";
policy.content = "default-src 'none'; style-src 'unsafe-inline' data:; img-src data:; font-src data:; media-src data:; form-action 'none'; base-uri 'none'";
clone.querySelector("head")?.prepend(policy);
return {state: missing ? "partial" : "complete", srcdoc: "<!doctype html>" + clone.outerHTML,
  missing_resource_count: missing, ...(missing ? {reason:"asset_not_captured"} : {}),
  viewport: {width: innerWidth, height: innerHeight}};
