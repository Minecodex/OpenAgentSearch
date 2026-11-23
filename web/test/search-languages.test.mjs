import {test} from 'node:test';
import assert from 'node:assert/strict';
import {routingLanguages,searchLanguageOptions} from '../src/search-languages.ts';

test('the routing catalogue preserves Google variants, regional official languages and readable names',()=>{
 assert.equal(new Set(routingLanguages).size,248);
 for(const key of ['zh','zh-CN','zh-TW','es-419','pt-BR','pt-PT','he','jv','ja','sw','crs','hif'])assert.ok(routingLanguages.includes(key),key);
 for(const locale of ['zh','en']){
   const options=searchLanguageOptions(locale,['en','fr-CA']);
   assert.equal(options.filter(o=>o.code==='en').length,1);
   assert.ok(options.some(o=>o.code==='fr-CA'));assert.ok(options.find(o=>o.code==='ja').search.includes('japanese'));
   assert.ok(options.every(o=>o.label.split(' · ')[0]!==o.code));
 }
});
