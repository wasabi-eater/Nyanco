import test from 'node:test';
import assert from 'node:assert/strict';
import {VM,compile,format} from '../migration/v037-adapter.mjs';

test('OCaml-style parameters and postfix constructors support options and annotations',()=>{
  const program=compile(`data 'a option = None | 'a Some
get : ('a ('a option)) -> 'a
fallback None get = fallback
_ (x Some) get = x`);
  const vm=new VM(program);
  assert.equal(program.types.get('Some'),"..s 'a -> ..s ('a option)");
  assert.deepEqual(vm.evaluate('0 (42 Some) get; True None get'),[42,true]);
  assert.equal(vm.infer('1 Some'),"..s -> ..s (int option)");
});

test('postfix types support multiple parameters, nested applications and recursive fields',()=>{
  const program=compile(`data 'a option = None | 'a Some
data 'e 'a result = 'e Error | 'a Ok
data 'a tree = 'a Leaf | ('a tree) ('a tree) Node
data color = Red | Blue
wrap : 'a -> 'a option option
x wrap = x Some Some
(x Leaf) sum = x
(l r Node) sum = (l sum) + (r sum)
choose : int -> (string int result)
x choose = x Ok`);
  const vm=new VM(program);
  assert.deepEqual(vm.evaluate('(1 Leaf) (2 Leaf) Node sum'),[3]);
  assert.equal(format(vm.evaluate('1 wrap; 3 choose; Red')),'[(Some (Some 1)), (Ok 3), Red]');
  assert.throws(()=>vm.evaluate('True choose'),/Cannot unify/);
});

test('postfix types reject missing parameters, undeclared fields and malformed constructors',()=>{
  for(const source of ["data 'a option = None | 'b Some","data 'a 'a option = None","data 'a option = Some 'a","data option = 'a Some"])
    assert.throws(()=>compile(source));
  assert.throws(()=>compile("data 'a option = None | 'a Some\nf : option -> int\n_ f = 0"));
  const vm=new VM(compile("data 'a option = None | 'a Some"));
  vm.evaluate('None -> mut x');vm.evaluate('x := 1 Some; x := None');
  assert.throws(()=>vm.evaluate('x := True Some'),/Cannot unify/);
});
