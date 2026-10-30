import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../migration/v037-adapter.mjs';
const header="effect 'a yield: 'a ->\neffect 'a ask: -> 'a\n";
const type=body=>compile(header+'f = '+body).types.get('f');

test('blocks infer latent effect arguments with shared type variables',()=>{
  assert.equal(type('{+ 10; yield}'),'..s -- ..s { ..s1 num -- ..s1 / {num yield} }');
  assert.equal(type('{2 yield; 3}'),'..s -- ..s { ..s1 -- ..s1 num / {num yield} }');
  assert.equal(type('{ask yield}'),"..s -- ..s { ..s1 -- ..s1 / {'a ask, 'a yield} }");
  assert.equal(type('{2 yield} drop'),'..s -- ..s');
});

test('function and block annotations accept closed effect rows and validate arguments',()=>{
  const p=compile(header+`a : {num -> / {num yield}}
a = {+ 10; yield}
b : {-> num / {num yield}}
b = {2 yield; 3}
c : {-> / {'a ask, 'a yield}}
c = {ask yield}
d : num -> / {num yield}
d = yield`);
  assert.match(p.types.get('c'),/\{'a ask, 'a yield\}/);
  assert.throws(()=>compile(header+'f : -> / {}\nf = 1 yield'),/not allowed/);
  assert.throws(()=>compile(header+'f : -> / {string yield}\nf = 1 yield'),/Cannot unify/);
  assert.throws(()=>compile(header+'f : -> / {missing}\nf = nop'),/Unknown effect/);
  assert.throws(()=>compile(header+'f : -> / {yield}\nf = nop'),/requires 1 type arguments/);
});

test('execution combinators propagate callback effects while compose remains latent',()=>{
  for(const body of ['{1 yield} call','[1 2] {yield} each','True {1 yield} {} if','True {1 yield} when','{1 yield} {2 yield} compose call','0 {dup; 0 >} {dup yield; - 1} while'])
    assert.match(type(body),/ \/ \{num yield\}$/);
  assert.equal(type('{1 yield} {2 yield} compose drop'),'..s -- ..s');
});

test('open effect row annotations propagate effects and pure callback contracts are enforced',()=>{
  const source=header+`run : {-> num / { | 'e}} -> num / { | 'e}
run = call
f = {1 yield; 2} run
g = {3} run`;
  const p=compile(source);assert.equal(p.types.get('f'),'..s -- ..s num / {num yield}');assert.equal(p.types.get('g'),'..s -- ..s num');
  const pure=header+'pure : {-> num / {}} -> num / {}\npure = call\n';
  assert.throws(()=>compile(pure+'f = {1 yield; 2} pure'),/not allowed/);
  assert.deepEqual(new VM(compile(pure+'f = {2} pure')).evaluate('f'),[2]);
});

test('handlers subtract handled operations through direct and named applications',()=>{
  const p=compile(header+`withHandlers = handle
f = {1 yield; 2} {yield: {-> x k; k resume}} handle
g = {1 yield; 2} {yield: {-> x k; k resume}} withHandlers
h = {ask; yield; 3} {yield: {-> x k; k resume}} handle`);
  assert.equal(p.types.get('f'),'..s -- ..s num');assert.equal(p.types.get('g'),'..s -- ..s num');
  assert.match(p.types.get('h'),/ask/);assert.doesNotMatch(p.types.get('h'),/yield/);
});

test('handler bodies retain outward operations and nested handlers can remove them',()=>{
  const p=compile(`effect ping: -> num
effect log: num ->
f = {ping} {ping: {-> k; 1 log; 2 k resume}} handle
g = {f} {log: {-> n k; k resume}} handle`);
  assert.equal(p.types.get('f'),'..s -- ..s num / {log}');assert.equal(p.types.get('g'),'..s -- ..s num');
  assert.deepEqual(new VM(p).evaluate('g'),[2]);
});

test('recursive functions accumulate effects without spurious open rows',()=>{
  const p=compile(header+`0 f = 0
n f = n yield; (n - 1) f
0 even = True
n even = n yield; (n - 1) odd
0 odd = False
n odd = (n - 1) even`);
  for(const n of ['f','even','odd']){assert.match(p.types.get(n),/num yield/);assert.doesNotMatch(p.types.get(n),/\|/);}
});

test('polymorphic operations preserve heterogeneous instantiations and bottom effects',()=>{
  assert.equal(type('1 yield; "x" yield'),'..s -- ..s / {num yield, string yield}');
  const p=compile('effect fail: string -> !\nf : -> ! / {fail}\nf = "bad" fail');
  assert.equal(p.types.get('f'),'..s -- ! / {fail}');
});

test('REPL inference retains effects through captured quotations and local functions',()=>{
  const vm=new VM(compile(header));vm.evaluate('{1 yield} -> q');
  assert.match(vm.infer('q call'),/num yield/);
  assert.match(type('local = 1 yield\n  local'),/num yield/);
});

test('mutable captured blocks cannot conceal newly introduced effects',()=>{
  for(const [bind,call] of [['run = q call','run'],['{q call} -> run','run call']]) {
    assert.throws(()=>compile(header+`f : -> / {}
f =
  {nop} -> mut q
  ${bind}
  q := {1 yield}
  ${call}`),/not allowed/);
  }
});

test('polymorphic handler forwarding specializes every operation occurrence',()=>{
  const source=header+`effect 'a log: 'a ->
f = {1 yield; "x" yield; 2} {yield: {-> x k; x log; k resume}} handle`;
  assert.equal(compile(source).types.get('f'),'..s -- ..s num / {num log, string log}');
  assert.throws(()=>compile(source+'\nf : -> num / {num log}'),/Cannot unify/);
  assert.match(compile(source+'\nf : -> num / {num log, string log}').types.get('f'),/num log, string log/);
});

test('class method contracts retain declared effects and reject hidden effects',()=>{
  const make=suffix=>header+`class 'a emit where
  emit : 'a ->${suffix}
instance num emit where
  emit = yield
f = 1 emit`;
  assert.equal(compile(make(' / {num yield}')).types.get('f'),'..s -- ..s / {num yield}');
  assert.throws(()=>compile(make('')),/not allowed/);
});

test('mutable assignments respect explicit quotation effect contracts',()=>{
  assert.throws(()=>compile(header+`pure : {-> / {}}
pure = {nop}
f = pure -> mut q; q := {1 yield}; q call`),/not allowed/);
});
