import test from "node:test";
import assert from "node:assert/strict";
import { cacheLookupView, recordedSearchHits } from "../src/cache-trace-model.ts";

const hit = (title, lookup, snap = "saved", url = "https://example.org/weather") => ({
  title, url, snippet: title + " snippet", cache: {lookup_id: lookup, snapshot_id: snap, source: "endpoint", collected_at: 123},
});
const archived = {input: {query: "Weather today"}, output: {lookup_id: "second", hit: true, search_needed: false, questions: ["q"], snapshot_ids: ["saved"]}};
test("archived exact hits retain their own variant, order, source and linked candidate", () => {
  const view = cacheLookupView(archived, {
    variants: [{cache_lookup_id: "first", hits: [hit("Another city","first")]},
      {cache_lookup_id: "second", hits: [hit("Forecast","second"),hit("Wrong lookup","first"),hit("Hourly","second","saved","https://example.org/hourly")]}],
    candidates: [{candidate_id: "c1", url: "https://example.org/weather#today"}],
  });
  assert.deepEqual(view.hits.map(h=>h.title), ["Forecast","Hourly"]);
  assert.equal(view.hits[0].candidate_id, "c1");
  assert.equal(view.snapshots[0].query, "Weather today");
  assert.equal(view.snapshots[0].source, "endpoint");
  assert.equal(view.exact,true);
});
test("older semantic hits and missing records never guess source questions or borrow unrelated pages", () => {
  const view = cacheLookupView({...archived,output:{...archived.output,search_needed:true}}, {
    variants: [{query: "Weather today", hits: [hit("Wrong","first")]}],
    candidates: [{candidate_id:"c2",title:"Recovered",snippet_preview:"Archived preview",hits:[hit("","second"),hit("","first")]}],
  });
  assert.deepEqual(view.hits.map(h=>h.title),["Recovered"]);
  assert.equal(view.snapshots[0].query,undefined);
  assert.deepEqual(cacheLookupView({input:{query:"Weather today"}},{variants:[{query:"Weather today",hits:[hit("Wrong","first")]}]}).hits,[]);
});
test("snapshot names and verification decisions resolve by identity even when returned in another order", () => {
  const view=cacheLookupView({span:{span_id:"stage"}},{cache_lookups:[{span_id:"stage",lookup_id:"read",query:"Current",questions:["accepted"],
    matched_snapshots:[{snapshot_id:"s",question_id:"accepted",query:"Earlier",exact:false}],
    verification:{shortlisted_question_ids:["other","accepted"],question_texts:{other:"Rejected",accepted:"Earlier"},decisions:[
      {question_id:"accepted",label:"reusable",reusable_score:0.99},{question_id:"other",label:"conflict",reusable_score:0},
    ]}}]});
  assert.deepEqual(view.reviewed.map(r=>[r.question,r.decision.label,r.selected]),[["Rejected","conflict",false],["Earlier","reusable",true]]);
  assert.deepEqual(recordedSearchHits([{title:"No URL"}],[{candidate_id:"wrong"}]).map(h=>h.candidate_id),[undefined]);
});
