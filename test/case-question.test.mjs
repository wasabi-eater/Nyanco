import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../language.mjs';
test('case uses question marks for patterns guards and nested branches',()=>{
 const p=compile(`abs = case
  -> n | n < 0 ? 0 - n
        | n == 0 ? 10
  -> n ? n
nested = case
  -> Some x ? x; case
    -> 0 ? "zero"
    -> n ? "other"
  end
  -> None ? "none"
describe = case
  -> "?" ? "question"
  -> s | s == "then" ? "word"
  -> s ? s
main = describe "?"; describe "then"; abs -3; abs 0; abs 4; nested (Some 0); nested None; [1].?[0]`);
 assert.deepEqual(new VM(p).evaluate('main'),['question','word',3,10,4,'zero','none',{kind:'adt',typeName:'option',constructor:'Some',fields:[1]}]);
});
test('case rejects the old delimiter and missing bodies',()=>{
 assert.throws(()=>compile('f = case -> x then x'),/requires \?/);
 assert.throws(()=>compile('f = case -> x ?'),/requires \?/);
 assert.deepEqual(new VM(compile('then = 7\nf = case -> x ? then')).evaluate('f 0'),[7]);
});
