import {readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {fingerprint} from './fingerprint.mjs';
import {validate} from './gate.mjs';
const catalog=JSON.parse(await readFile('tests/acceptance/subitems.json','utf8'));
const metadata=await Promise.all(['docker','kubernetes'].map(async suite=>JSON.parse(await readFile('artifacts/acceptance-'+suite+'.json','utf8'))));
const source=await fingerprint();
const subitems=await validate({fingerprint:source,catalog,metadata});
const docker=metadata.find(m=>m.suite==='docker');const directory=docker.directory;
let executions=0;const names=new Set();
for(const file of await readdir(directory))if(file.endsWith('.tap')){
 const text=await readFile(resolve(directory,file),'utf8');assert.ok(!/^not ok /m.test(text),file+' contains failures');assert.match(text,/# fail 0\b/,file+' did not finish');
 for(const match of text.matchAll(/^ok \d+ - (.+)$/gm)){executions++;names.add(match[1]);}
}
const units=await readFile(resolve(directory,'unit.log'),'utf8');assert.ok(!units.includes('test result: FAILED'));assert.match(units,/test result: ok/);
const web=await readFile(resolve(directory,'web-unit.log'),'utf8');assert.match(web,/(?:#|ℹ) fail 0/);
const storage=await readFile(resolve(directory,'storage.log'),'utf8');assert.match(storage,/test result: ok\. 1 passed/);assert.ok(!storage.includes('test result: FAILED'));const databaseTests=[...storage.matchAll(/test result: ok\. (\d+) passed/g)].reduce((n,m)=>n+Number(m[1]),0);
const groups=Array.from({length:27},(_,i)=>{const id='A'+String(i+1).padStart(2,'0');const items=subitems.filter(s=>s.area===id);assert.ok(items.length);return {id,status:'passed',passed:items.length,total:items.length,subitems:items.map(s=>s.id)};});
const quality=JSON.parse(await readFile('artifacts/acceptance-quality.json','utf8'));
const report={status:'passed',fingerprint:source,acceptance_cases:groups.length,acceptance_subitems:subitems.length,http_browser_ui_tests:names.size,test_executions:executions,rust_tests:[...units.matchAll(/test result: ok\. (\d+) passed/g)].reduce((n,m)=>n+Number(m[1]),0),web_tests:Number(web.match(/(?:#|ℹ) pass (\d+)/)?.[1]),repository_database_tests:databaseTests,groups,subitems,quality,scope:'Real Rust/PostgreSQL/Firefox/React/HeroUI and Helm/oasctl; synthetic sites, native HTTP protocol fixtures and deterministic model fixtures. No paid-provider or production-model quality claim.'};
await writeFile('artifacts/acceptance-report.json',JSON.stringify(report,null,2));
const link=p=>`[${p.split(/[\\/]/).at(-1)}](${p.replaceAll('\\','/')})`;
await writeFile('artifacts/acceptance-report.md',`# 验收结果\n\nA01–A27 的 ${subitems.length} 个必需子项全部通过。${report.rust_tests} 项 Rust 单元测试、${report.web_tests} 项前端单元测试、${report.repository_database_tests} 项 PostgreSQL 仓储测试、${names.size} 项 HTTP/浏览器/UI 用例。\n\n源码 SHA-256：\`${source}\`。Docker、Kubernetes、逐断言证据及测试镜像使用同一指纹。缺少子项、失败断言、部分运行及旧指纹均拒绝生成成功报告；测试标题不参与完成判定。\n\n| 子项 | 验收行为 | 结果 | 断言来源与执行证据 |\n| --- | --- | --- | --- |\n`+subitems.map(s=>`| ${s.id} | ${s.description} | 通过 | ${[...new Set(s.evidence.map(e=>e.source))].join('<br>')} · ${[...new Set(s.evidence.map(e=>e.evidence_file))].map(link).join('、')} |`).join('\n')+'\n\n受控网页、原生协议和模型夹具验证事实基线、语言、引用与材料覆盖，不代表付费服务或生产模型质量。[质量指标](./acceptance-quality.json) · [结构化结果](./acceptance-report.json) · [资源清理核对](./cleanup-check.json)\n');
console.log(`A01–A27: ${subitems.length} explicitly asserted subitems passed at ${source}.`);
