import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../migration/v037-adapter.mjs';
const program=(body,extra='')=>compile(`effect ask : -> num\n${extra}\nmain = ${body}`);
const run=(body,extra='')=>new VM(program(body,extra)).evaluate('main');
const handler='{ask: {-> k; 41 k resume}}';
test('effects resume the remaining computation and handlers transform its result',()=>{
  assert.deepEqual(run(`99 {ask; + 1} ${handler} handle`),[99,42]);
  assert.deepEqual(run('{ask; + 1} {ask: {-> k; 41 k resume; + 10}} handle'),[52]);
  assert.deepEqual(run('{ask; ask; +} {ask: {-> k; 10 k resume}} handle'),[20]);
  assert.deepEqual(run('{7} {:} handle'),[7]);
});
test('operations suspend inside named functions, operands, records and collections',()=>{
  assert.deepEqual(run(`{[f; f]; 0 {+} fold} ${handler} handle`,'f = ask + 1'),[84]);
  assert.deepEqual(run(`{{x: ask}.x} ${handler} handle`),[41]);
  assert.deepEqual(run(`{0 (1..=3) {drop; ask; +} each} ${handler} handle`),[123]);
  assert.deepEqual(run(`{5 classify} ${handler} handle`,'x classify | ask > 0 = x\n           | otherwise = 0'),[5]);
});
test('aborting a continuation skips remaining computation and keeps prior side effects',()=>{
  const output=[],vm=new VM({...program(`0 -> mut n;
    {n ! (+ 1); "before" print; ask; n ! (+ 100); "after" print} {ask: {drop; 9}} handle;
    n`),output:x=>output.push(x)});
  assert.deepEqual(vm.evaluate('main'),[9,1]);assert.deepEqual(output,['before']);assert.equal(vm.depth,0);
  assert.deepEqual(vm.evaluate('1 + 2'),[3]);
});
test('nested handlers shadow operations and forward unhandled ones',()=>{
  assert.deepEqual(run(`{{ask} {ask: {-> k; 2 k resume}} handle} ${handler} handle`),[2]);
  assert.deepEqual(run(`{{ask; + 1} {:} handle; + 2} ${handler} handle`),[44]);
  assert.deepEqual(run(`{{ask} {ask: {-> k; ask k resume}} handle} ${handler} handle`),[41]);
  assert.deepEqual(run(`{{ask} {:} handle; + 100} {ask: {drop; 7}} handle`),[7]);
});
test('operations accept arguments, multiple results and zero results',()=>{
  assert.deepEqual(run('{3 split; +} {split: {-> n k; n (n + 1) k resume}} handle','effect split : num -> num num'),[7]);
  const output=[],vm=new VM({...program('{"hello" log; 5} {log: {-> msg k; msg print; k resume}} handle','effect log : string ->'),output:x=>output.push(x)});
  assert.deepEqual(vm.evaluate('main'),[5]);assert.deepEqual(output,['hello']);
});
test('continuations cannot be resumed twice or after their handler returns',()=>{
  assert.throws(()=>run('{ask} {ask: {-> k; 1 k resume drop; 2 k resume}} handle'),/already resumed/);
  assert.throws(()=>run(`{0} -> mut saved; {ask} {ask: {-> k; saved := {1 k resume}; 0}} handle drop; saved call`),/expired/);
  assert.throws(()=>run(`{ask} {ask: {-> k; 1 k call}} handle`),/Type error/);
});
test('effect signatures and handler result/resumption types are statically checked',()=>{
  assert.throws(()=>run('{ask} {ask: {-> k; True k resume}} handle'),/Type error/);
  assert.throws(()=>run('{ask} {ask: {drop; "wrong"}} handle'),/Type error/);
  assert.throws(()=>run('{ask} {missing: {drop; 1}} handle'),/Unknown effect/);
  assert.deepEqual(run('{1 2} {:} handle'),[1,2]);
  assert.throws(()=>compile("effect generic : 'a -> 'a"),/Unknown type|undeclared/);
  assert.throws(()=>compile('effect ask : -> num\neffect ask : -> num'),/already used/);
  assert.throws(()=>compile('effect ask : -> num\nask = 1'),/redefine effect/);
  assert.throws(()=>compile('effect print : -> num'),/already used/);
});
test('unhandled operations report their name and REPL declarations persist',()=>{
  const initial=compile('effect ask : -> num'),extended=compile('f = ask','<repl>',initial.definitions),vm=new VM(extended);
  assert.match(extended.types.get('ask'),/num/);
  assert.deepEqual(vm.evaluate(`{f} ${handler} handle`),[41]);
  assert.throws(()=>vm.evaluate('f'),/Unhandled effect: ask/);assert.equal(vm.depth,0);
});
