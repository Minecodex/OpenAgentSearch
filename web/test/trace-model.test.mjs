import {test} from 'node:test';
import assert from 'node:assert/strict';
import {rankedCandidates,groupStatus,preferredStage,stageCandidate,executionGroups,materialPages,preferredMaterialSpan} from '../src/trace-model.ts';
import {traceValue} from '../src/trace-labels.ts';

test('final selection sorts ahead of higher unselected scores without changing stored order',()=>{
 const rows=[{candidate_id:'c1',score:99,selected:false},{candidate_id:'c2',score:80,selected:true},{candidate_id:'c3',score:90,selected:true},{candidate_id:'c4',score:null}];
 assert.deepEqual(rankedCandidates(rows).map(c=>c.candidate_id),['c3','c2','c1','c4']);
 assert.equal(rows[0].candidate_id,'c1');
 assert.equal(rankedCandidates([{candidate_id:'a',score:50},{candidate_id:'b',score:50}])[0].candidate_id,'a');
});
test('mixed attempts retain partial status and extraction defaults to its first success',()=>{
 const attempts=[{span_id:'bad',stage:'extract',status:'error'},{span_id:'good',stage:'extract',status:'success'}];
 assert.equal(groupStatus(attempts),'partial');
 assert.equal(preferredStage(attempts).span_id,'good');
 assert.equal(preferredStage(attempts.map(s=>({...s,stage:'search'}))).span_id,'bad');
 assert.equal(groupStatus([{status:'error'},{status:'cancelled'}]),'error');
 assert.equal(groupStatus([{status:'empty'}]),'empty');
});
test('source and extraction titles resolve through request-scoped candidate IDs and parent spans',()=>{
 const candidates=[{candidate_id:'c1',source_id:'s1',title:'Gauge',reader_call_ids:['call']}];
 const calls=[{span_id:'reader',candidate_id:'c1',call_id:'call'}];
 assert.equal(stageCandidate({span_id:'source'},calls,candidates,[{span_id:'reader',parent_id:'source'}]).title,'Gauge');
 assert.equal(stageCandidate({span:{span_id:'source'},input:{source_id:'s1'}},[],candidates).title,'Gauge');
 assert.equal(stageCandidate({span_id:'other'},calls,candidates),undefined);
});
test('diagnostic enums are localized while original query and article contents are preserved',()=>{
 const zh=(zh,en)=>zh,en=(zh,en)=>en;
 assert.equal(traceValue('mode','whole_sources',zh),'原文一次性总结');
 assert.equal(traceValue('driver','native_messaging',zh),'Firefox 扩展与 Native Messaging');
 assert.equal(traceValue('time_range','month',zh),'最近一月');
 assert.equal(traceValue('variant_id','Q0',zh),'原问题');
 assert.equal(traceValue('mode','whole_sources',en),'Single synthesis from original sources');
 assert.equal(traceValue('query','whole_sources',zh),'whole_sources');
 assert.equal(traceValue('text','month',zh),'month');
});

test('webpage materials keep parent outcomes and group reader retries without counting the parent twice',()=>{
 const spans=[{span_id:'root',stage:'source',status:'success',duration_ms:20},
   {span_id:'bad',parent_id:'root',stage:'extract',status:'error',duration_ms:5},
   {span_id:'good',parent_id:'root',stage:'extract',status:'success',duration_ms:10},
   {span_id:'inline',stage:'source',status:'success',duration_ms:2}];
 const candidates=[{candidate_id:'c1',title:'Weather',url:'https://example.test/page'},
   {candidate_id:'c2',title:'Inline',url:'https://example.test/inline'}];
 const calls=[{span_id:'good',candidate_id:'c1'}];
 const pages=materialPages(spans,calls,candidates,[{span:{span_id:'inline'},input:{candidate_id:'c2'}}]);
 assert.deepEqual([...executionGroups(spans).keys()],['materials']);
 assert.equal(pages.length,2);
 assert.equal(pages[0].title,'Weather');
 assert.equal(pages[0].status,'success');
 assert.equal(pages[0].duration,20);
 assert.equal(preferredMaterialSpan(pages[0]).span_id,'good');
 assert.equal(preferredMaterialSpan(pages[1]).span_id,'inline');
});

test('standalone content requests group multiple reader attempts for the same webpage',()=>{
 const spans=[{span_id:'a',stage:'extract',status:'error',start_offset_ms:2,duration_ms:3},
   {span_id:'b',stage:'extract',status:'success',start_offset_ms:6,duration_ms:4}];
 const calls=spans.map(s=>({span_id:s.span_id,input_preview:'https://example.test/page'}));
 const pages=materialPages(spans,calls,[]);
 assert.equal(pages.length,1);
 assert.equal(pages[0].duration,8);
 assert.equal(preferredMaterialSpan(pages[0]).span_id,'b');
});
