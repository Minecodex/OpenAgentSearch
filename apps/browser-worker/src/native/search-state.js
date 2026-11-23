// Shared by the controller and content script; tolerate only display-equivalent
// query normalization. Document identity is generated in the extension world.
function oasQueryKey(value) {
  return String(value || '').normalize('NFC').trim().replace(/\s+/g, ' ')
    .replace(/[\uFF01-\uFF5E]/g, character => String.fromCharCode(character.charCodeAt(0) - 0xFEE0));
}
function oasListSignature(hits) {
  return JSON.stringify(hits.map(hit=>[hit.url,hit.title]));
}
function oasFreshSearch(value,before) {
  if(value.current!==true || oasQueryKey(value.input_query)!==oasQueryKey(before.query))return null;
  const navigated=value.document_id!==before.before,changed=oasQueryKey(before.before_query)!==oasQueryKey(before.query);
  const list=navigated || (changed&&oasListSignature(value.hits||[])!==before.before_signature);
  const cards=navigated || (changed&&JSON.stringify(value.cards||[])!==(before.before_cards||'[]'));
  const answer=navigated || (changed&&value.answerSignature!=null&&value.answerSignature!==before.before_answer);
  if(!list&&!cards&&!answer)return null;
  const current={...value};
  if(!list){current.hits=[];current.empty=false;}
  if(!cards)current.cards=[];
  if(!answer){current.answerState='none';current.answerSignature=null;current.answerProgress=false;current.answerNeedsSources=false;delete current.engine_answer;}
  return current;
}
function oasCurrentSearch(value,before) {
  return oasFreshSearch(value,before)!==null;
}
