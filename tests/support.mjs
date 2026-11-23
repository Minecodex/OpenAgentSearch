import assert from 'node:assert/strict';
export async function settled(base,id,headers){
  for(let attempt=0;attempt<100;attempt++){
    const response=await fetch(base+'/admin/v1/requests/'+id,{headers});
    const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));
    if(value.data.metadata.status!=='running'&&!value.data.incomplete_reasons?.includes('diagnostics_pending'))return value.data;
    await new Promise(resolve=>setTimeout(resolve,40));
  }
  assert.fail('diagnostic writer did not settle');
}
