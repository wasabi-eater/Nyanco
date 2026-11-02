import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM,format} from '../language.mjs';
import {transpileGo} from '../go-backend.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
const source=`effect ask : -> int
data pairs 'k 'v = Pairs [#('k 'v)]
instance streem (pairs 'k 'v) where
  item : #('k 'v)
  each (Pairs xs) f = each xs f
data key = Key int
instance hash key where
  hash (Key n) = 0
collect xs = toDict xs
main =
 print (toDict [#(0,"a"),#(1,"b"),#(0,"c")])
 print (toDict [])
 print (collect (zip [1,2] ["a","b"]))
 print (toDict (map (1 ..= 3) {-> n; #(n,n * n)}))
 print (toDict (Pairs [#(1,"one")]))
 print ((toDict [#(Key 1,"one"),#(Key 3,"three")]).[Key 3])
 print ((toDict [#({x: 1},"record")]).[{x: 1}])
 print ((toDict [#([1,2],"vector")]).[[1,2]])
 print (toDict [0: "a", 1: "b"] == [1: "b", 0: "a"])
 print (handle {toDict (fromYield {yield #(ask,"value")})} {ask:{-> k; resume 7 k}})
 print (catch {toDict (fromYield {exn "source"})})
 print (toDict (fromYield {yield #(1,2); cancel; yield #(3,4)}))
 print (toDict (fromYield {yield #(1,2); [9: 99]; break}))
 123; print (toDict [#(1,2)]); print`;
const expected=['[0: "c", 1: "b"]','[:]','[1: "a", 2: "b"]','[1: 1, 2: 4, 3: 9]','[1: "one"]','three','record','vector','True','[7: "value"]','(Err "source")','[1: 2]','[9: 99]','[1: 2]','123'];
const run=()=>{const p=compile(source),output=[],vm=new VM({...p,output:s=>output.push(s)});vm.evaluate('main');return {p,output};};
test('toDict collects generic pair streams with hash keys and handles loop effects',()=>{
  const {p,output}=run();assert.deepEqual(output,expected);assert.match(p.types.get('collect'),/hash/);assert.match(p.types.get('collect'),/streem/);
  for(const body of ['toDict [1,2]','toDict [#(1)]','toDict [#(1,2,3)]','toDict [#({1},2)]'])assert.throws(()=>compile('main = '+body));
  const vm=new VM();vm.evaluate('map [1,2] {-> n; #(n,n * 2)} -> saved');assert.equal(format(vm.evaluate('toDict saved')[0]),'[1: 2, 2: 4]');assert.equal(format(vm.evaluate('toDict saved')[0]),'[1: 2, 2: 4]');
});
test('Go toDict preserves collisions, source effects and break results',()=>{
  const {p}=run(),dir=mkdtempSync(join(tmpdir(),'nyanco-to-dict-'));
  try{const file=join(dir,'main.go');writeFileSync(file,transpileGo(p));const r=spawnSync('go',['run',file],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(r.status,0,r.stderr);assert.equal(r.stdout,expected.join('\n')+'\n');}
  finally{assert.equal(dirname(dir),tmpdir());assert.ok(dir.startsWith(join(tmpdir(),'nyanco-to-dict-')));rmSync(dir,{recursive:true,force:true});}
});
