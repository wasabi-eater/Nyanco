import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../migration/v048-adapter.mjs';
const run=(source,expression='main')=>{const output=[],p=compile(source),vm=new VM({...p,output:x=>output.push(x),warning:()=>{}});return {p,output,stack:vm.evaluate(expression)};};

test('print and raw io infer an io effect and the host supplies the default handler',()=>{
  const {p,output,stack}=run('main = print 42; print True; print "hello"; put "raw"');
  assert.deepEqual(output,['42','True','hello','raw']);assert.deepEqual(stack,[]);
  assert.match(p.types.get('main'),/\/ \{io\}$/);
  const vm=new VM({warning:()=>{}});assert.match(vm.infer('print'),/\/ \{io\}$/);assert.match(vm.infer('put'),/string.*\/ \{io\}$/);
});

test('io can be suppressed and removed from an explicitly pure effect row',()=>{
  const {p,output,stack}=run(`main : -> int / {}
main = handle {print 42; 7} {put: {-> text k; resume k}}`);
  assert.deepEqual(output,[]);assert.deepEqual(stack,[7]);assert.doesNotMatch(p.types.get('main'),/io/);
  assert.throws(()=>compile('main : -> / {}\nmain = print 42'),/Effect io is not allowed/);
});

test('io handlers receive strings and can capture heterogeneous printed values',()=>{
  const {output,stack}=run(`main =
  [] -> mut logs;
  handle {print 42; print True; print [1, 2]} {put: {-> text k; logs ! (:: text); resume k}};
  logs`);
  assert.deepEqual(output,[]);assert.deepEqual(stack,[['42','True','[1, 2]']]);
});

test('nested handlers may forward io outward and resume without replaying earlier output',()=>{
  const {output,stack}=run(`main =
  print "before";
  handle {handle {print "inner"; 3, 4} {:}} {put: {-> text k; print text; resume k}};
  print "after"`);
  assert.deepEqual(output,['before','inner','after']);assert.deepEqual(stack,[3,4]);
});

test('aborting an io continuation stops the rest of the body',()=>{
  const {output,stack}=run('main = handle {print "first"; print "unreachable"; 2} {put: {-> text k; 9}}');
  assert.deepEqual(output,[]);assert.deepEqual(stack,[9]);
});

test('io propagates through quotations and callbacks, but constructing a block is not io',()=>{
  const p=compile('block = {print 1}\nrun = call block\nwalk = each [1, 2] {print}');
  assert.match(p.types.get('block'),/\{.*\/ \{io\} \}$/);assert.match(p.types.get('run'),/\/ \{io\}$/);assert.match(p.types.get('walk'),/\/ \{io\}$/);
  assert.doesNotThrow(()=>compile('discard : -> / {}\ndiscard = drop {print 1}'));
});

test('io signatures and handlers remain statically checked',()=>{
  assert.throws(()=>compile('main = put 42'),/Cannot unify/);
  assert.throws(()=>compile('main = handle {print 1} {put: {-> text k; resume 1 k}}'),/Type error/);
  assert.throws(()=>compile('effect put: string ->'),/already used/);
});
