import {test} from 'node:test';
import assert from 'node:assert/strict';
import {rewriteView} from '../src/rewrite-view.ts';
test('historical rewrite echoes stay discarded instead of acquiring a fabricated Q1',()=>{
 const value=rewriteView({input:{query:'今天天气怎么样',rewrite_count:1},output:{queries:['今天天气怎么样']}},{variants:[{variant_id:'Q0',query:'今天天气怎么样'}]},{});
 assert.equal(value.used,0);assert.equal(value.state,'fallback');assert.equal(value.entries[0].state,'duplicate_original');assert.equal(value.entries[0].variant_id,undefined);
});
test('historical entries use actual variant identifiers and retain failed-call fallback reasons',()=>{
 const value=rewriteView({input:{query:'rain'},output:{queries:['rain locally','rain locally']}},{variants:[{variant_id:'Q0',query:'rain'},{variant_id:'Q1',query:'rain locally'}]},{});
 assert.equal(value.used,1);assert.equal(value.entries[0].variant_id,'Q1');assert.equal(value.entries[1].state,'duplicate_rewrite');
 const failed=rewriteView({input:{query:'rain'},output:{code:'MODEL_FAILED'}},{variants:[{variant_id:'Q0',query:'rain'}]},{});
 assert.equal(failed.state,'fallback');assert.equal(failed.fallback_reason,'MODEL_FAILED');
});
