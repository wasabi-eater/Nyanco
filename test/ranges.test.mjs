import test from 'node:test';
import assert from 'node:assert/strict';
import {VM,compile,lex,format} from '../migration/v037-adapter.mjs';
const run=s=>new VM().evaluate(s);
const collect=s=>run(`[] (${s}) {Push} each`)[0];
test('range operators create dedicated values with inclusive and exclusive endpoints',()=>{
  assert.deepEqual(run('1..5')[0],{kind:'range',start:1,end:5,inclusive:false});
  for(const [s,xs] of [['1..5',[1,2,3,4]],['1..=5',[1,2,3,4,5]],['5..1',[5,4,3,2]],['5..=1',[5,4,3,2,1]],['2..2',[]],['2..=2',[2]],['-3..=-1',[-3,-2,-1]],['2..-2',[2,1,0,-1]]])assert.deepEqual(collect(s),xs,s);
  assert.deepEqual(run('1 3 range'),[[1,2,3]]);
  assert.equal(format(run('1..=3')[0]),'(1 ..= 3)');
});
test('range tokenization preserves decimals and record projections',()=>{
  assert.deepEqual(lex('1..=3').map(t=>t.value),[1,'..=',3]);
  assert.deepEqual(lex('1.5..2.5').map(t=>t.value),[1.5,'..',2.5]);
  assert.deepEqual(collect('{x: 2}.x ..= 4'),[2,3,4]);
  assert.deepEqual(run('1.5; {x: 3}.x'),[1.5,3]);
});
test('range sections and references keep precedence and have range type',()=>{
  assert.deepEqual(collect('1 + 1 ..= 2 * 3'),[2,3,4,5,6]);
  assert.deepEqual(run('(1..3) == (1..3); (1..3) == (1..=3)'),[true,false]);
  assert.throws(()=>run('(1..3) == [1 2]'),/Cannot unify/);
  for(const s of ['1 4 (..)','1 (..= 3)','3 (1 ..=)','1 3 {..=} call','1 3; _1 ..= _'])assert.deepEqual(collect(s),[1,2,3]);
  assert.equal(new VM().infer('..'),'..s int int -> ..s range');
  assert.deepEqual(new VM(compile('f = ..=')).evaluate('0 (2 4 f) {+} each'),[9]);
});
test('range endpoints validate safe integer limits without materializing lists',()=>{
  for(const s of ['1.5..3','1..=2.5','0..100001','0..=100001','9007199254740992..9007199254740992'])assert.throws(()=>run(s),/safe integers|Cannot unify/);
  for(const s of ['True..3','1..="x"','(1..3) length'])assert.throws(()=>run(s),/Type error/);
  assert.equal(run('0..100000')[0].end,100000);
  assert.deepEqual(collect('9007199254740990..=9007199254740991'),[9007199254740990,9007199254740991]);
});
