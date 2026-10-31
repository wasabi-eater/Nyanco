import test from 'node:test';
import assert from 'node:assert/strict';
import {VM,compile} from '../migration/v037-adapter.mjs';
const vmFor=source=>new VM(compile(source));

test('case supports named patterns, guards, and different branch arities',()=>{
  const vm=vmFor(`absolute = case
    -> n | n < 0 then 0 - n
    -> n then n
absolute2 = case
    -> n | n < 0 then 0 - n
    otherwise nop
absolute3 = case
    | dup; < 0 then 0 -
    otherwise nop`);
  for(const name of ['absolute','absolute2','absolute3']) {
    assert.deepEqual(vm.evaluate(`99 -7 ${name} 0 ${name} 5 ${name}`),[99,7,0,5]);
    assert.equal(vm.infer(name),"'a num => ..s 'a -> ..s 'a / {exn}");
  }
});

test('case guard alternatives share patterns and false conditions restore the input',()=>{
  const vm=vmFor(`classify = case
    -> n | n < 0 then "negative"
         | n == 0 then "zero"
    otherwise drop "positive"
retry = case
    | drop False then 100
    | dup; > 0 then 1 +
    otherwise nop`);
  assert.deepEqual(vm.evaluate('-1 classify 0 classify 2 classify'),['negative','zero','positive']);
  assert.deepEqual(vm.evaluate('4 retry -4 retry'),[5,-4]);
});

test('case is an expression, supports nesting, and case locals do not escape',()=>{
  const vm=vmFor(`classify = case
    -> x then case
        | x < 0 then -1
        otherwise 1
main = (3; case -> x then x + 1 end); 5`);
  assert.deepEqual(vm.evaluate('main'),[4,5]);
  assert.deepEqual(vm.evaluate('-1 classify 2 classify'),[-1,1]);
  const nested=vmFor(`nested = case
    -> x then case
        | x < 0 then -1
        otherwise 1
    end
end`);
  assert.deepEqual(nested.evaluate('-1 nested 2 nested'),[-1,1]);
  assert.throws(()=>vm.evaluate('1; (case -> x then x end); x'),/Unknown word/);
});

test('nop is an independent stack identity and otherwise accepts any branch body',()=>{
  const vm=vmFor('fallback = case otherwise 42 end\nreplace = case otherwise drop 0 end');
  assert.deepEqual(vm.evaluate('nop'),[]);
  assert.deepEqual(vm.evaluate('1 True "x" nop'),[1,true,'x']);
  assert.equal(vm.infer('nop'),'..s -> ..s');
  assert.deepEqual(vm.evaluate('fallback 7 replace'),[42,0]);
});

test('arrow destructures ADTs and lists, supports wildcard and mutable fields',()=>{
  const vm=vmFor(`data fuga = int Fuga
runFuga = -> x Fuga; x
sumPair = -> [x y]; x + y
headTail = -> (xs :: x); x xs
increment = -> mut x Fuga; x ! (+ 1); x`);
  assert.deepEqual(vm.evaluate('42 Fuga runFuga'),[42]);
  assert.deepEqual(vm.evaluate('[2 3] sumPair'),[5]);
  assert.deepEqual(vm.evaluate('[2 3 4] headTail'),[4,[2,3]]);
  assert.deepEqual(vm.evaluate('4 Fuga increment'),[5]);
  assert.deepEqual(vm.evaluate('1 2 -> _ x; x'),[2]);
  assert.throws(()=>vm.evaluate('[1] -> [a b]'),/pattern did not match/);
  assert.throws(()=>vm.evaluate('1 2 -> x x'),/Duplicate/);
});

test('function guards may consume or produce carried values',()=>{
  const vm=vmFor(`absolute | dup; < 0 = 0 - | otherwise = nop
consume | drop True = 42 | otherwise = drop 0
produce | 10 True = + | otherwise = 10 +`);
  assert.deepEqual(vm.evaluate('-3 absolute 4 absolute'),[3,4]);
  assert.deepEqual(vm.evaluate('99 5 consume'),[99,42]);
  assert.deepEqual(vm.evaluate('5 produce'),[15]);
});

test('case checks branch result effects, condition bool, and missing matches',()=>{
  for(const source of [
    'bad = case -> x | x > 0 then True otherwise nop end',
    'bad = case | 3 then nop otherwise nop end',
    'bad = case -> x then x x otherwise nop end',
    'bad = case -> x then',
  ])assert.throws(()=>compile(source),undefined,source);
  assert.throws(()=>vmFor('only = case -> 0 then 1 end').evaluate('2 only'),/No matching case branch/);
});
