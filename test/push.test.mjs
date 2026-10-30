import test from 'node:test';
import assert from 'node:assert/strict';
import {VM,compile,format} from '../migration/v037-adapter.mjs';
const run=s=>new VM().evaluate(s);
test('Push appends immutable elements and :: is its left associative sugar',()=>{
  assert.deepEqual(run('[] 3 Push 4 Push 5 Push'),[[3,4,5]]);
  assert.deepEqual(run('[] :: 3 :: 4 :: 5'),[[3,4,5]]);
  assert.deepEqual(run('[1] -> xs; xs 2 Push; xs'),[[1,2],[1]]);
  assert.deepEqual(run('[] [3 4 5] {Push} each'),[[3,4,5]]);
  assert.equal(new VM().infer('Push'),"..s ['a] 'a -- ..s ['a]");
  assert.equal(new VM().infer('::'),new VM().infer('Push'));
  assert.throws(()=>run('[1] True Push'),/Type error/);
  assert.throws(()=>run('1 [] Push'),/Type error/);
});
test('postfix Push and infix :: are equivalent list patterns',()=>{
  const vm=new VM(compile(`xs x Push splitPattern = xs x
(xs :: x) split2 = xs x
[] 3 Push 4 Push 5 Push exact = True
_ exact = False
[] sum = 0
xs x Push sum = (xs sum) + x`));
  assert.deepEqual(vm.evaluate('[3 4 5] splitPattern; [3 4 5] split2'),[[3,4],5,[3,4],5]);
  assert.deepEqual(vm.evaluate('[3 4 5] exact; [3 4] exact; [1 2 3] sum'),[true,false,6]);
  assert.throws(()=>vm.evaluate('[] splitPattern'),/No matching pattern/);
  assert.throws(()=>compile('x x Push f = x'),/Duplicate pattern/);
  assert.throws(()=>compile('x Push f = x'),/requires 2/);
});
test('Push patterns work in case and arrow bindings including nested constructors',()=>{
  const vm=new VM(compile(`data 'a option = None | 'a Some
last = case
  -> xs x Push then x Some
  -> [] then None
(xs (x Some) Push) lastSome = xs x`));
  assert.equal(format(vm.evaluate('[1 2] last; [] last')),'[(Some 2), None]');
  assert.equal(format(vm.evaluate('[(1 Some); (2 Some)] lastSome')),'[[(Some 1)], 2]');
  assert.deepEqual(run('[3 4 5] -> xs x Push; xs x'),[[3,4],5]);
  assert.deepEqual(run('[3 4 5] -> xs :: x; xs x'),[[3,4],5]);
  assert.deepEqual(run('[3 4 5] -> mut xs x Push; xs ! (:: 6); xs x'),[[3,4,6],5]);
  assert.throws(()=>run('[] -> xs x Push; xs'),/pattern did not match/);
});
