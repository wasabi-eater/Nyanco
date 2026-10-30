import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../migration/v048-adapter.mjs';
import {transpileGo} from '../go-backend.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const run=(source)=>{const p=compile(source),output=[],vm=new VM({...p,output:x=>output.push(x)});return {p,output,stack:vm.evaluate('main')};};
const box=`data box 'a = Box 'a
instance streem (box 'a) where
  item : 'a
  each (Box x) f = x; call f
`;
test('toList and eager map/filter accept each instances, ranges and lists',()=>{
 assert.deepEqual(run(box+`main = toList (Box "x"); toList (3 ..= 1); map (Box 3) {* 2}; filter (1 ..= 4) {_ % 2 == 0}`).stack,[['x'],[3,2,1],[6],[2,4]]);
 assert.throws(()=>compile('main = toList 3'),/No instance/);
});
test('lazy transformations defer effects, compose, replay, and preserve ambient each state',()=>{
 const result=run(`main =
  0 -> mut count;
  sfilter (smap [1,2,3] {count ! (+ 1); * 2}) {> 2} -> xs;
  count;
  toList xs;
  count;
  0; each xs {+};
  count`);
 assert.deepEqual(result.stack,[0,[4,6],3,10,6]);
});
test('generator is lazy, repeatable, streams in order and discards final results',()=>{
 const result=run(`main =
  fromYield {print "start"; yield 1; print "middle"; yield 2; print "end"; 99, "done"} -> xs;
  print "constructed";
  each xs {print};
  toList xs`);
 assert.deepEqual(result.output,['constructed','start','1','middle','2','end','start','middle','end']);
 assert.deepEqual(result.stack,[[1,2]]);
 assert.deepEqual(run('main = toList (fromYield {})').stack,[[]]);
});
test('consumer exceptions abort producers without executing the rest or replaying effects',()=>{
 const result=run(`main = handle {each (fromYield {yield 1; print "unreachable"; yield 2}) {drop; exn "stop"}} {exn: {-> message k; nop}}`);
 assert.deepEqual(result.output,[]);assert.deepEqual(result.stack,[]);
});
test('delayed effects remain in stream types and propagate through generic wrappers',()=>{
 const p=compile(`build : -> (stream int {-> / {io}}) / {}
build = smap [1,2] {dup; print}
collect xs = toList xs
main = collect build`);
 assert.match(p.types.get('build'),/stream int.*io/);assert.match(p.types.get('main'),/\/ \{io\}$/);
 assert.throws(()=>compile('bad : -> [int] / {}\nbad = toList (smap [1] {dup; print})'),/Effect io is not allowed/);
 assert.throws(()=>compile('bad : -> (stream int {-> / {}})\nbad = smap [1] {dup; print}'),/Effect io is not allowed/);
 assert.throws(()=>compile('wrap = fromYield\nmain = toList (wrap {yield 1; yield "bad"})'),/Cannot unify/);
 assert.throws(()=>compile('main = fromYield {drop; yield 1}'),/underflow|Stack shape/);
 assert.throws(()=>compile('main = sfilter [1] {+ 1}'),/Cannot unify/);
});
test('REPL streams retain types and effects across evaluations',()=>{
 const vm=new VM(),s=vm.evaluate('smap [1,2] {+ 1}');
 assert.deepEqual(vm.evaluate('toList',s),[[2,3]]);
 vm.evaluate('fromYield {yield 7} -> xs');assert.deepEqual(vm.evaluate('toList xs'),[[7]]);
});
test('yield declarations stay compatible and nested generators can yield outward',()=>{
 const result=run(`effect yield 'a : 'a ->
main = toList (fromYield {each (fromYield {yield 1; yield 2}) {+ 10; yield}})`);
 assert.deepEqual(result.stack,[[11,12]]);
});
test('native lazy streams, custom each, effects and early abort agree with interpreter',()=>{
 const source=box+`main =
  print (toList (smap (Box 3) {* 2}));
  print (map (Box 4) {+ 1});
  print (filter (1 ..= 5) {> 3});
  0 -> mut count;
  sfilter (smap (1 ..= 4) {count ! (+ 1); * 2}) {> 4} -> xs;
  print count; print (toList xs); print count;
  0; each xs {+}; print; print count;
  fromYield {print "start"; yield 1; yield 2; 99, "done"} -> ys;
  print "created"; each ys {print}; print (toList ys);
  handle {each (fromYield {yield 1; print "unreachable"}) {drop; exn "stop"}} {exn: {-> msg k; print msg}};
  print (toList (fromYield {each (fromYield {yield 1; yield 2}) {+ 10; yield}}))`;
 const {output}=run(source),p=compile(source),dir=mkdtempSync(join(tmpdir(),'nyanco-stream-'));
 try {
  const file=join(dir,'main.go'),exe=join(dir,'main.exe');writeFileSync(file,transpileGo(p));
  const built=spawnSync('go',['build','-o',exe,file],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(built.status,0,built.stderr);
  const result=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,output.join('\n')+'\n');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
