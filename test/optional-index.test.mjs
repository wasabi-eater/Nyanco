import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../migration/v048-adapter.mjs';
const run=s=>new VM().evaluate(s);
const some=x=>({kind:'adt',typeName:'option',constructor:'Some',fields:[x]});
const none={kind:'adt',typeName:'option',constructor:'None',fields:[]};
test('optional list access returns option, including invalid indices and empty lists',()=>{
 assert.deepEqual(run('[10,20] -> x; x.?[1]'),[some(20)]);
 for(const i of ['-1','2','9999999999999999'])assert.deepEqual(run(`[10,20].?[${i}]`),[none]);
 assert.deepEqual(run('[].?[0]'),[none]);
 assert.deepEqual(run('.?[1] [10,20]'),[some(20)]);
 assert.deepEqual(run('1; [10,20].?[_]'),[some(20)]);
 assert.deepEqual(run('{xs:[10,20]}.xs.?[0 + 1]'),[some(20)]);
});
test('option supports annotations, constructors, pattern matching and REPL values',()=>{
 const p=compile(`get : [int] int -> (option int)
get xs i = xs.?[i]
unwrapValue (Some x) = x
unwrapValue None = -1
main = unwrapValue (get [10,20] 1); unwrapValue (get [] 1)`);
 assert.deepEqual(new VM(p).evaluate('main'),[20,-1]);
 const vm=new VM(),stack=vm.evaluate('[10].?[0]');
 assert.deepEqual(vm.evaluate('-> Some x; x',stack),[10]);
 assert.deepEqual(run('Some 10 == [10].?[0]'),[true]);
 const explicit=compile("data option 'a = None | Some 'a\nmain = [1].?[0]");
 assert.deepEqual(new VM(explicit).evaluate('main'),[some(1)]);
 assert.doesNotThrow(()=>compile("data box = Box (option int)"));
});
test('optional indexing is pure but preserves index expression effects',()=>{
 const p=compile(`safe : -> (option int) / {}
safe = [1].?[99]
unsafeIndex = [1].?[exn "oops"]`);
 assert.doesNotMatch(p.types.get('safe'),/exn/);assert.match(p.types.get('unsafeIndex'),/exn/);
 assert.deepEqual(new VM(p).evaluate('safe'),[none]);
 assert.throws(()=>run('[1].?["x"]'),/Cannot unify/);
 assert.deepEqual(run('handle {[1].?[exn "oops"]} {exn: {-> msg k; None}}'),[none]);
});
