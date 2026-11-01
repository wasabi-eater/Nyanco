import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM,format} from '../language.mjs';
import {transpileGo} from '../go-backend.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
const run=source=>{const p=compile(source),output=[],vm=new VM({...p,output:s=>output.push(s),warning:()=>{}});return {p,output,vm,stack:vm.evaluate('main')};};
const source=`effect ask : -> int
lookup : dict int string -> string / {exn}
lookup d = d.[0]
main =
 print (toVector (windows [0,1,2,3] 3))
 print (toVector (chunks [0,1,2,3] 3))
 print (toVector (map (chunkBy [1,2,-1,-2,3] {>= 0}) {toVector}))
 print (groupBy [0,1,2,3] {% 2})
 print (groupBy [] {nop})
 print (toVector (windows [] 1)); print (toVector (chunks [] 3))
 print (toVector (windows [1,2] 3)); print (toVector (chunks [1,2] 3))
 print (toVector (take (windows (iterate {0} {+ 1}) 3) 2))
 print [0: 1, 2: 3]
 print [:]
 print (lookup [0: "a", 1: "b"])
 print ([0: "a", 1: "b"].?[1]); print ([0: "a"].?[1]); print ([:].?[0])
 print [0: "a", 0: "b", 1: "c"]
 [0: 10] -> d
 print (d with {.?[1] ! + 2})
 print (d with {.?[0] ! + 2})
 print (d with {.[1] ??= 99})
 print (d with {.[0] ??= 99})
 print (d with {.[1] = 42})
 print d
 print ([1,2] with {.?[0] ! + 2; .?[9] ! + 100})
 print ({d: [0: [1,2]]} with {.d.?[0].?[1] ! + 5})
 print ({d: [0: [1,2]]} with {.d.?[9].?[1] ! + 5})
 0 -> mut calls
 d with {.?[9] ! (calls ! + 100; + 1)} -> ignored
 print calls
 d with {.[0] ??= (calls ! + 100; 8)} -> alsoIgnored
 print calls
 print (catch {[0: 1].[1]})
 print (catch {windows [1] 0})
 print (catch {chunks [1] -1})
 print (handle {toVector (chunks (fromYield {yield ask; yield 2; yield 3}) 2)} {ask:{-> k; resume 7 k}})
 print (handle {groupBy [1,2] {drop; ask}} {ask:{-> k; resume 0 k}})
 print (nth (chunks [1,2,3,4] 2) 0)
 print (toVector (chunks (fromYield {yield 1; cancel; yield 2}) 2))
 print (groupBy [1,2,3] {when ($ == 3) {drop; cancel}; % 2})
 print (groupBy [1,2,3] {when ($ == 2) {drop; [9: [42]]; break}; % 2})
 print (toVector (windows (fromYield {yield 1; yield 2; break}) 2))`;

test('dictionary literals, conditional updates and grouping streams work together',()=>{
  const {output}=run(source);
  assert.deepEqual(output.slice(0,13),['[[0, 1, 2], [1, 2, 3]]','[[0, 1, 2], [3]]','[[1, 2], [-1, -2], [3]]','[0: [0, 2], 1: [1, 3]]','[:]','[]','[]','[]','[[1, 2]]','[[0, 1, 2], [1, 2, 3]]','[0: 1, 2: 3]','[:]','a']);
  assert.deepEqual(output.slice(13,28),['(Some "b")','None','None','[0: "b", 1: "c"]','[0: 10]','[0: 12]','[0: 10, 1: 99]','[0: 10]','[0: 10, 1: 42]','[0: 10]','[3, 2]','{d: [0: [1, 7]]}','{d: [0: [1, 2]]}','0','0']);
  assert.deepEqual(output.slice(-6),['[0: [1, 2]]','(Some [1, 2])','[]','[1: [1], 0: [2]]','[9: [42]]','[[1, 2]]']);
});
test('typing, saved values and short-circuiting traversal remain sound',()=>{
  for(const s of ['[0: 1, "a": 2]','[0: 1, 1: "a"]','[0: "a"] with {.?[1] ! + 2}','windows [1] 2.0','chunks True 2'])assert.throws(()=>compile('main = '+s),s);
  assert.deepEqual(run('main = 0; each (windows [1,2,3] 2) {drop; + 1; when ($ == 1) {break}}').stack,[1]);
  assert.deepEqual(run('main = groupBy [1,2] @done {drop; [9: [9]]; break@done}').stack,[{kind:'dict',entries:[[9,[9]]]}]);
  assert.equal(format(run('main = [0: 1] -> mut d; d.?[9] ! + 2; d').stack[0]),'[0: 1]');
  assert.deepEqual(run('main = [0: \"a\", 1: \"b\"] == [1: \"b\", 0: \"a\"]').stack,[true]);
  const vm=new VM({warning:()=>{}});vm.evaluate('[0: 10] -> d');assert.equal(format(vm.evaluate('d.[0]')[0]),'10');
  vm.evaluate('chunks [1,2,3] 2 -> cs');assert.equal(format(vm.evaluate('toVector cs')[0]),'[[1, 2], [3]]');assert.equal(format(vm.evaluate('toVector cs')[0]),'[[1, 2], [3]]');
  vm.evaluate('chunkBy [1,2,-1] {>= 0} -> gs');assert.equal(format(vm.evaluate('map gs {toVector}; toVector')[0]),'[[1, 2], [-1]]');
  const {stack}=run('main = 0 -> mut n; fromYield {n ! + 1; yield 1; n ! + 1; yield 2; n ! + 100; yield 3} -> xs; nth (chunks xs 2) 0; n');assert.deepEqual(stack,[{kind:'adt',typeName:'option',constructor:'Some',fields:[[1,2]]},2]);
});
test('Go dictionaries and partitioning streams match interpreter values and effects',()=>{
  const {p,output}=run(source),dir=mkdtempSync(join(tmpdir(),'nyanco-dicts-'));
  try{const file=join(dir,'main.go'),exe=join(dir,'main.exe');writeFileSync(file,transpileGo(p));const build=spawnSync('go',['build','-o',exe,file],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(build.status,0,build.stderr);const result=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:20000});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,output.join('\n')+'\n');}
  finally{assert.equal(dirname(dir),tmpdir());assert.ok(dir.startsWith(join(tmpdir(),'nyanco-dicts-')));rmSync(dir,{recursive:true,force:true});}
});
