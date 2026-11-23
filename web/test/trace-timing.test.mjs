import test from "node:test";
import assert from "node:assert/strict";
import {stageTiming,stageWindow} from "../src/trace-timing.ts";

test("stage bars use the full request axis and stay within it",()=>{
  assert.deepEqual(stageTiming(0,9844,10008),{left:0,width:100*9844/10008});
  assert.deepEqual(stageTiming(80,45,100),{left:80,width:20});
  assert.deepEqual(stageTiming(0,0,0),{left:0,width:0});
});

test("overlapping searches show the elapsed window, independent of dispatch order",()=>{
  assert.equal(stageWindow([{start_offset_ms:60,duration_ms:55},{start_offset_ms:10,duration_ms:70}]),105);
  assert.equal(stageWindow([]),0);
});
