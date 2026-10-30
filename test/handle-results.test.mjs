import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../migration/v037-adapter.mjs';
const header='effect ask: -> num\neffect tick: ->\neffect fail: string -> !\nwithHandlers = handle\n';
const run=body=>new VM(compile(header+'main = '+body)).evaluate('main');
test('handle returns zero or multiple results preserving the outer stack',()=>{
  assert.deepEqual(run('99 {} {:} handle'),[99]);
  assert.deepEqual(run('99 {1 "x" True} {:} handle'),[99,1,'x',true]);
  assert.deepEqual(run('99 {1 "x" True} {:} withHandlers'),[99,1,'x',true]);
});
test('resume passes an entire result row including no results',()=>{
  assert.deepEqual(run('99 {ask drop} {ask: {-> k; 3 k resume}} handle'),[99]);
  assert.deepEqual(run('99 {ask; "x"} {ask: {-> k; 3 k resume}} withHandlers'),[99,3,'x']);
  assert.deepEqual(run('{tick; 4 "x"} {tick: {-> k; k resume; swap; + 2; swap}} handle'),[6,'x']);
});
test('abort handlers and nested forwarding support arbitrary result arity',()=>{
  assert.deepEqual(run('{ask drop} {ask: {drop}} handle'),[]);
  assert.deepEqual(run('{ask; "x"} {ask: {drop; 7 "abort"}} handle'),[7,'abort']);
  assert.deepEqual(run('{{ask; "x"} {:} handle; True} {ask: {-> k; 9 k resume}} handle'),[9,'x',true]);
  assert.deepEqual(run('{"bad" fail} {fail: {drop drop}} handle'),[]);
  assert.deepEqual(run('{"bad" fail} {fail: {drop drop; 1 "abort"}} withHandlers'),[1,'abort']);
});
test('result row types and arities remain consistent and effects are removed',()=>{
  for(const body of ['{ask; "x"} {ask: {drop; 1}} handle','{ask drop} {ask: {drop; 1}} handle','{ask; "x"} {ask: {drop; 1 True}} handle'])assert.throws(()=>run(body),/Type error/);
  const p=compile(header+'main : -> num string / {}\nmain = {ask; "x"} {ask: {-> k; 1 k resume}} handle');
  assert.equal(p.types.get('main'),'..s -- ..s num string');
});

test('generic wrappers can consume a returned result',()=>{
  const p=compile('discardLast = handle; drop\nmain = {1 "x"} {:} discardLast');
  assert.deepEqual(new VM(p).evaluate('main'),[1]);
});
