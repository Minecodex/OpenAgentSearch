import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chartMaximum,operationCounts,requestHours} from '../src/chart-data.ts';
test('operation counts distinguish loading, zero and omitted zero-valued operations',()=>{
 assert.equal(operationCounts(undefined,undefined),null);
 assert.deepEqual(operationCounts({content:2},undefined),{list:0,content:2,summary:0});
 assert.deepEqual(operationCounts({},undefined),{list:0,content:0,summary:0});
 assert.deepEqual(operationCounts(undefined,[{from:'2026-05-01T00:00:00Z',list:3},{from:'2026-05-01T01:00:00Z',summary:2}]),{list:3,content:0,summary:2});
});
test('empty hourly intervals preserve totals and clamp drill-down to the selected window',()=>{
 const from='2026-05-01T00:20:00Z',to='2026-05-01T03:40:00Z';
 const points=requestHours([{from:'2026-05-01T02:00:00Z',content:2}],from,to);
 assert.equal(points.length,4);assert.equal(Date.parse(points[0].from),Date.parse(from));assert.equal(Date.parse(points.at(-1).to),Date.parse(to));
 assert.equal(points.flatMap(p=>p.values).reduce((n,v)=>n+v,0),2);assert.deepEqual(points[0].values,[0,0,0]);
 assert.deepEqual(requestHours([],from,to),[]);
});
test('chart scales retain ordinary and large values without multiplying their order of magnitude',()=>{
 assert.equal(chartMaximum([1000]),1000);assert.equal(chartMaximum([100,null]),100);assert.equal(chartMaximum([0]),4);assert.ok(chartMaximum([.7],false)>=.7);
});
