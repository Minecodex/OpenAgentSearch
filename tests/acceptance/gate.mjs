import {readFile} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

function under(directory,path){const location=resolve(directory,path);const child=relative(directory,location);assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child),'Evidence path escaped its run directory');return location;}
function location(value,root){
 assert.equal(typeof value,'string','An assertion must identify its source location');
 const js=value.match(/(file:\/\/\/[^)]+?):(\d+):\d+/);const rust=value.match(/^(.+\.rs):(\d+)$/);
 assert.ok(js||rust,'Missing source file and line in assertion evidence');
 const file=js?fileURLToPath(js[1]):resolve(root,rust[1]);const child=relative(root,file);assert.ok(!child.startsWith('..')&&!isAbsolute(child),'Assertion source is outside the source tree');return {file,line:Number((js||rust)[2])};
}
export async function validate({root=process.cwd(),fingerprint,catalog,metadata}){
 const items=new Map(catalog.items.map(item=>[item.id,item]));assert.equal(items.size,catalog.items.length,'Duplicate required subitem IDs');
 const evidence=new Map();const suites=new Set();
 for(const meta of metadata){
  assert.equal(meta.version,2,'Old aggregate reports are not subitem evidence');assert.equal(meta.completed,true,'An execution suite did not complete');assert.equal(meta.fingerprint,fingerprint,'Source fingerprint mismatch');assert.ok(meta.run_id&&meta.directory&&meta.assertions?.length);
  suites.add(meta.suite);
  if(meta.suite==='docker'){assert.equal(meta.full,true,'A partial Docker run cannot satisfy full acceptance');assert.deepEqual(meta.suites.sort(),['database','docker','rust']);}
  assert.equal(meta.images?.length,3,'Three tested application image identities are required');
  assert.equal(new Set(meta.images.map(i=>i.image)).size,3,'Test image identities must be distinct');
  for(const image of meta.images){assert.ok(image.id&&image.image,'Missing tested image identity');assert.equal(image.fingerprint,fingerprint,'Test image source fingerprint mismatch');}
  for(const entry of meta.assertions){
   const file=under(resolve(meta.directory),entry.path);const text=await readFile(file,'utf8');let seen=0;
   for(const line of text.split(/\r?\n/).filter(Boolean)){
    const event=JSON.parse(line);assert.equal(event.version,1);assert.equal(event.run_id,meta.run_id);assert.equal(event.fingerprint,fingerprint,'Stale assertion result');assert.ok(meta.suites.includes(event.suite));assert.equal(event.status,'passed','A required subitem assertion failed');assert.ok(Number.isInteger(event.assertions)&&event.assertions>0,'Subitem has no executed assertion');assert.ok(items.has(event.id),'Unknown acceptance subitem');
    const source=location(event.source,root);const lines=(await readFile(source.file,'utf8')).split(/\r?\n/);assert.ok(source.line>=1&&source.line<=lines.length,'Assertion source line does not exist');
    const values=evidence.get(event.id)||[];values.push({...event,evidence_file:file});evidence.set(event.id,values);seen++;
   }
   assert.ok(seen>0,'An assertion evidence file is empty');
  }
 }
 assert.ok(suites.has('docker')&&suites.has('kubernetes'),'Both Docker and Kubernetes execution are required');
 const missing=catalog.items.filter(item=>!evidence.has(item.id));assert.deepEqual(missing.map(i=>i.id),[],'Required acceptance subitems are missing');
 for(const item of catalog.items)for(const suite of item.required_suites||[])assert.ok(evidence.get(item.id).some(e=>e.suite===suite),'Missing required suite '+suite+' for '+item.id);
 return catalog.items.map(item=>({...item,status:'passed',evidence:evidence.get(item.id)}));
}
