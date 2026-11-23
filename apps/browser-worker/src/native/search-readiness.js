// Material readiness uses bounded grace periods within the existing call deadline.
// Four seconds is the earliest normal return, not a fixed extraction cutoff.
function oasSearchReadiness(submittedAt,expires,startedAt) {
  const budget=Math.max(0,expires-startedAt),quiet=Math.min(200,budget/10),discover=Math.min(400,budget/5),
    pendingGrace=Math.min(1500,budget/2),placeholder=Math.min(600,budget/3),earliest=Math.min(expires-150,submittedAt+4000);
  let cached=null,signature=null,stableSince=null,document=null,materialSignature=null,materialSince=null,changedAt=null,sawPending=false,last=null;
  const material=value=>({location:value.location,current:true,hits:value.hits||[],cards:value.cards||[],empty:!!value.empty,
    webdriver:value.webdriver,page_webdriver:value.page_webdriver});
  function reset(){cached=null;signature=null;stableSince=null;materialSignature=null;materialSince=null;changedAt=null;sawPending=false;last=null;}
  function finish(value,reason,now){return {...value,search_readiness:{return_reason:reason,elapsed_ms:Math.max(0,now-submittedAt),
    answer_state:last?.answerState||'none',card_count:value.cards.length,material_pending:!!last?.materialPending,
    material_discovering:!!last?.materialDiscovering,source_count:last?.engine_answer?.sources?.length||0}};}
  function sample(value,now){
    if(!value||value.current===false){reset();return null;}
    if(value.document_id!==document){reset();document=value.document_id;}
    last=value;
    const usable=value.hits?.length||value.cards?.length||value.empty;
    if(usable){
      cached=material(value);const next=JSON.stringify([document,cached.hits,cached.cards,cached.empty]);
      if(materialSince===null)materialSince=now;
      if(next!==materialSignature){materialSignature=next;changedAt=now;}
    }else{cached=null;materialSignature=null;materialSince=null;changedAt=null;sawPending=false;}
    if(value.answerState==='ready'&&value.engine_answer){
      if(signature!==value.answerSignature){signature=value.answerSignature;stableSince=now;}
      if(now>=earliest&&now-stableSince>=200)return finish({...material(value),engine_answer:value.engine_answer},'ai_answer_ready',now);
    }else{signature=null;stableSince=null;}
    const aiPending=['pending','ready'].includes(value.answerState)&&value.answerProgress!==false;
    const pending=!!value.materialPending||aiPending;if(pending)sawPending=true;
    const discovering=value.materialDiscovering||(value.answerState==='pending'&&!aiPending);
    if(cached&&now>=earliest&&(now>=expires-150||now-materialSince>=(sawPending?pendingGrace:placeholder)||
      (!pending&&now-materialSince>=(discovering?placeholder:discover)&&now-changedAt>=quiet)))
      return finish(cached,now>=expires-150?'deadline_material':'material_ready',now);
    return null;
  }
  return {sample,reset,fallback:now=>cached?finish(cached,'deadline_material',now):null};
}
