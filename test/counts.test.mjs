import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM,format} from '../language.mjs';
import {transpileGo} from '../go-backend.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
const source=`effect ask : -> int
data bag 'a = Bag ['a]
instance streem (bag 'a) where
  item : 'a
  each (Bag xs) f = each xs f
data key = Key int
instance hash key where
  hash (Key n) = 0
pureCounts : [string] -> dict string int / {}
pureCounts = counts
main =
 print (counts [1,2,1,3,1])
 print (pureCounts ["a","b","a"])
 print (counts [])
 print (counts (1 ..= 3))
 print ((counts [1.5,1.5,2.5]).[1.5])
 print (counts (Bag [1,2,1]))
 print ((counts [Key 1,Key 3,Key 1]).[Key 1])
 print ((counts [#(1,"a"),#(1,"a")]).[#(1,"a")])
 print (handle {counts (fromYield {yield ask; yield ask})} {ask:{-> k; resume 7 k}})
 print (catch {counts (fromYield {exn "source"})})
 print (counts (fromYield {yield 1; cancel; yield 2}))
 print (counts (fromYield {yield 1; [9: 99]; break}))
 123; print (counts [1,1]); print
 print (countIf (Bag [1,2,3,4]) {_ % 2 == 0})
 parity <- countsBy [1,2,3,4,5] {% 2}
 print (parity.[0]); print (parity.[1])`;
const expected=['[1: 3, 2: 1, 3: 1]','["a": 2, "b": 1]','[:]','[1: 1, 2: 1, 3: 1]','2','[1: 2, 2: 1]','2','2','[7: 2]','(Err "source")','[1: 1]','[9: 99]','[1: 2]','123','2','2','3'];
const run=()=>{const p=compile(source),output=[],vm=new VM({...p,output:s=>output.push(s)});vm.evaluate('main');return {p,output};};
test('counting functions use int counters and propagate traversal effects',()=>{
  assert.deepEqual(run().output,expected);
  const vm=new VM();assert.match(vm.infer('counts'),/dict 'b int/);assert.doesNotMatch(vm.infer('counts'),/num|exn/);
  assert.doesNotMatch(vm.infer('counts [1,2,1]'),/exn| \/ /);
  assert.match(vm.infer('counts (fromYield {yield read})'),/\{io\}/);
  assert.throws(()=>compile('main = counts [{1}]'),/hash/);
  assert.throws(()=>compile('bad : [int] -> dict int float / {}\nbad = counts'),/Cannot unify/);
  assert.equal(vm.infer('countIf [] {drop; True}'),'..s -> ..s int');
  assert.equal(vm.infer('countsBy [] {drop; "key"}'),'..s -> ..s (dict string int)');
  assert.equal(vm.infer('countIf [1] {print; True}'),'..s -> ..s int / {io}');
  assert.equal(vm.infer('countsBy [1] {print; "key"}'),'..s -> ..s (dict string int) / {io}');
  assert.throws(()=>vm.infer('countsBy [1] {drop; {nop}}'),/hash/);
  vm.evaluate('map [1,1,2] {nop} -> saved');assert.equal(format(vm.evaluate('counts saved')[0]),'[1: 2, 2: 1]');assert.equal(format(vm.evaluate('counts saved')[0]),'[1: 2, 2: 1]');
});
test('Go counting functions match pure, effectful, cancelled and interrupted VM traversal',()=>{
  const {p}=run(),dir=mkdtempSync(join(tmpdir(),'nyanco-counts-'));
  try{const file=join(dir,'main.go');writeFileSync(file,transpileGo(p));const r=spawnSync('go',['run',file],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(r.status,0,r.stderr);assert.equal(r.stdout,expected.join('\n')+'\n');}
  finally{assert.equal(dirname(dir),tmpdir());assert.ok(dir.startsWith(join(tmpdir(),'nyanco-counts-')));rmSync(dir,{recursive:true,force:true});}
});
