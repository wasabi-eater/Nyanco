import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../migration/v037-adapter.mjs';
const header='effect fail : string -> !\n';
const run=body=>new VM(compile(header+'main = '+body)).evaluate('main');
const h='{fail: {-> message k; 42}}';
test('bottom effects and functions infer non-returning stack effects',()=>{
  const p=compile(header+'die : string -> !\ndie = fail\nf = "bad" die');
  assert.equal(p.types.get('fail'),'..s string -- ! / {fail}');assert.equal(p.types.get('die'),'..s string -- ! / {fail}');assert.equal(p.types.get('f'),'..s -- ! / {fail}');
  assert.deepEqual(new VM(p).evaluate(`99 {f} ${h} handle`),[99,42]);
  assert.throws(()=>new VM(p).evaluate('f'),/Unhandled effect: fail/);
});
test('bottom is compatible with returning branches in either order and with containers',()=>{
  for(const body of ['True {1} {"bad" fail} if','False {"bad" fail} {1} if'])assert.deepEqual(run(body),[1]);
  for(const body of ['1 + ("bad" fail)','["bad" fail]','{x: "bad" fail}','#("bad" fail)','True {"a" fail} {"b" fail} if'])assert.deepEqual(run(`{${body}} ${h} handle`),[42],body);
  const p=compile(header+'f = True {"a" fail} {"b" fail} if');assert.match(p.types.get('f'),/-- !(?: \/ \{fail\})?$/);
});
test('function and case clauses join bottom with returning paths',()=>{
  const p=compile(header+'0 f = "bad" fail\nn f = n + 1\ng = case\n  -> 0 then "bad" fail\n  -> n then n + 2');
  const vm=new VM(p);assert.deepEqual(vm.evaluate('3 f; 3 g'),[4,5]);
  assert.deepEqual(vm.evaluate(`{0 f} ${h} handle; {0 g} ${h} handle`),[42,42]);
});
test('bottom annotations reject returning implementations and resuming bottom operations',()=>{
  assert.throws(()=>compile('f : -> !\nf = 1'),/may return normally/);
  assert.throws(()=>compile('f : -> !\nf = nop'),/may return normally/);
  assert.throws(()=>compile(header+'0 f = "bad" fail\nn f = n\nf : int -> !'),/may return normally/);
  for(const body of ['k resume','1 k resume','True k resume'])assert.throws(()=>run(`{"bad" fail} {fail: {-> msg k; ${body}}} handle`),/Cannot resume a non-returning effect/);
  for(const signature of ['! -> int','int -> ! int','int -> [!]'])assert.throws(()=>compile('effect bad : '+signature));
});
test('explicit recursive non-returning functions and nested quotation signatures work',()=>{
  const p=compile('loop : -> !\nloop = loop');assert.match(p.types.get('loop'),/-- !(?: \/ \{fail\})?$/);
  const p2=compile(header+'q : -> {string -> !}\nq = {fail}');assert.match(p2.types.get('q'),/-- !/);
});
test('code after bottom is not executed and handlers can forward aborting effects',()=>{
  const output=[],vm=new VM({...compile(header+`main = {{"bad" fail; "unreachable" print} {:} handle} {fail: {-> msg k; msg print; 7}} handle`),output:x=>output.push(x)});
  assert.deepEqual(vm.evaluate('main'),[7]);assert.deepEqual(output,['bad']);
});

test('bottom promises are checked inside quotations and at higher order call sites',()=>{
  assert.throws(()=>compile('q : -> {-> !}\nq = {1}'),/may return normally/);
  assert.throws(()=>compile('use : {-> !} -> !\nuse = call\nmain = {1} use'),/may return normally/);
  assert.match(compile(header+'f : !\nf = "bad" fail').types.get('f'),/-- !(?: \/ \{fail\})?$/);
});
test('non-returning comparisons preserve short circuiting and loop callbacks can abort',()=>{
  assert.deepEqual(run(`{0 < ("bad" fail)} ${h} handle`),[42]);
  assert.deepEqual(run('3 < 2 < ("bad" fail); 7'),[false,7]);
  assert.deepEqual(run(`{1 < 2 < ("bad" fail)} {fail: {drop drop; False}} handle`),[false]);
  assert.deepEqual(run(`{0 {"bad" fail} {+ 1} while} ${h} handle`),[42]);
  assert.deepEqual(run(`{0 {dup; < 1} {"bad" fail} while} ${h} handle`),[42]);
  assert.deepEqual(run(`{0 [1] {drop; "bad" fail} each} ${h} handle`),[42]);
  assert.deepEqual(run(`{0 [] {drop; "bad" fail} each} ${h} handle`),[0]);
});
