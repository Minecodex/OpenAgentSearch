import {test} from 'node:test';
import assert from 'node:assert/strict';
import {requestReport,literal,plain} from '../src/report.ts';
test('export neutralizes HTML and table delimiters and fences archived source',()=>{
  const report=requestReport({request:{metadata:{query_preview:'<img src=x>| title',request_id:'r1'},response_payload:{data:{summary:'<iframe src=https://example.com>',sources:[],citations:[{source_id:'s1',segment_id:'p1'}]}}},
    calls:[{endpoint_name:'A|B',span_id:'score',status:'success',execution_ms:1}],evidence:{candidates:[]},payloads:[{span:{stage:'extract'},replay:[{kind:'webpage',state:'complete',body:'~~~\n<img src="https://example.com">',media_type:'text/html'}]}]},'en');
  assert.ok(report.includes('&lt;iframe'));assert.ok(report.includes('A\\|B'));assert.ok(report.includes('~~~~html'));
  assert.ok(report.includes('s1 / p1'));assert.equal((report.match(/~~~~/g)||[]).length,2);
});
test('literal fence is longer than any archived delimiter',()=>{assert.ok(literal('~~~~~\nhi').startsWith('~~~~~~text'));assert.equal(plain('<script>'),'&lt;script&gt;');});
