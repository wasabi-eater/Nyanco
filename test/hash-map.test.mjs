import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyDict,dictGet,dictSet,dictEntries} from '../hash-map.mjs';
import {compile,VM} from '../language.mjs';
import {transpileGo} from '../go-backend.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';

test('persistent hash trie performs bounded key comparisons and preserves snapshots',()=>{
  let comparisons=0;const eq=(a,b)=>{comparisons++;return a===b;};
  let d=emptyDict();const versions=[];
  for(let i=0;i<5000;i++){if(i%1000===0)versions.push(d);d=dictSet(d,i,i*2,i,eq);}
  comparisons=0;
  for(let i=0;i<5000;i++)assert.equal(dictGet(d,i,i,eq).value,i*2);
  assert.ok(comparisons<=5000,`linear bucket scanning: ${comparisons}`);
  assert.equal(dictGet(d,99999,99999,eq),null);
  assert.deepEqual(versions.map(v=>v.size),[0,1000,2000,3000,4000]);
  const updated=dictSet(d,3,99,3,eq);assert.equal(dictGet(d,3,3,eq).value,6);assert.equal(dictGet(updated,3,3,eq).value,99);
  let colliding=emptyDict();for(let i=0;i<20;i++)colliding=dictSet(colliding,i,i,0,eq);
  for(let i=0;i<20;i++)assert.equal(dictGet(colliding,i,0,eq).value,i);
  assert.equal([...dictEntries(d)].length,5000);
  comparisons=0;for(let i=0;i<5000;i++)d=dictSet(d,i,99,i,eq);assert.ok(comparisons<=10000);
  assert.equal(dictGet(versions[1],3,3,eq).value,6);
});

const source=`data key = Key int
instance hash key where
  hash (Key n) = 0
data wrap 'a = Wrap 'a
instance hash 'a => hash (wrap 'a) where
  hash (Wrap x) = hash x
data negative = Negative
instance hash negative where
  hash Negative = -1
make : hash 'k => 'k -> dict 'k string
make k = [k: "value"]
hashVector : hash 'a => ['a] -> int
hashVector = hash
hashRest r = hash (r with x = 1)
some : -> option key
some = Some (Key 1)
result : -> result key string
result = Ok (Key 3)
main =
 print ([Key 1: "one", Key 3: "three"].[Key 1])
 print ([Key 1: "one", Key 3: "three"].[Key 3])
 print ([Key 1: 1, Key 1: 2].[Key 1])
 print ((make (Wrap (Key 5))).[Wrap (Key 5)])
 print ([[Key 1,Key 3]: "vector"].[[Key 1,Key 3]])
 print ([#(Key 1, "x"): "tuple"].[#(Key 1, "x")])
 print ([{x: Key 1, y: [Key 3]}: "record"].[{y: [Key 3], x: Key 1}])
 print ([[0: "a", 1: "b"]: "dict"].[[1: "b", 0: "a"]])
 print ([some: 7].[Some (Key 1)])
 print ([result: 8].[result])
 print ((groupBy [Key 1,Key 3,Key 1] {nop}).[Key 1])
 [Key 1: 1] -> d
 print ((d with [Key 3] ??= 3).[Key 3])
 print d.?[Key 3]
 print (hash Negative)
 print (hash 0); print (hash -1); print (hash 1.5); print (hash (-0.0))
 print (hash (toByte 42)); print (hash '猫'); print (hash True); print (hash "日本😀")
 print (hashVector [Key 1,Key 3]); print (hash #(Key 1, [Key 3], {x: Key 5}))
 print (hashRest {x: "unused", y: Key 3})
 print (hash {:}); print (hash #()); print (hash (1 ..= 3))
 print (hash some); print (hash result)
 [:] -> mut big
 each (0 ..= 999) {-> n; big.[n] <- n}
 print big.[500]
 print (length (toVector (values big)))
 print (hash [0: "a", 1: "b"] == hash [1: "b", 0: "a"])
 print (hash {x: 1,y: 2} == hash {y: 2,x: 1})`;
const run=()=>{const p=compile(source),output=[],vm=new VM({...p,output:s=>output.push(s)});vm.evaluate('main');return {p,output};};
test('hash constraints derive structurally and custom hash collisions remain correct',()=>{
  const {p,output}=run();assert.deepEqual(output.slice(0,14),['one','three','2','value','vector','tuple','record','dict','7','8','[(Key 1), (Key 1)]','3','None','-1']);
  assert.deepEqual(output.slice(-2),['True','True']);assert.match(p.types.get('make'),/hash/);assert.match(p.types.get('hashVector'),/hash/);assert.match(p.types.get('hashRest'),/hash/);
  for(const body of ['[{1}: 2]','[[{1}]: 2]','[{x: {1}}: 2]','hash {1}','[Unknown: 1]'])assert.throws(()=>compile('main = '+body));
  assert.throws(()=>compile("make : 'k -> dict 'k int\nmake k = [k: 1]"),/hash/);
  assert.throws(()=>compile("data noHash = NoHash\nmain = [NoHash: 1]"),/hash/);
  assert.throws(()=>compile('data bad = Bad\ninstance hash bad where\n  hash Bad = exn "bad"'),/Effect|effect/);
});
test('Go structural hashing and generic hash instances match VM',()=>{
  const {p,output}=run(),dir=mkdtempSync(join(tmpdir(),'nyanco-hash-'));
  try{const file=join(dir,'main.go');writeFileSync(file,transpileGo(p));const r=spawnSync('go',['run',file],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(r.status,0,r.stderr);assert.equal(r.stdout,output.join('\n')+'\n');}
  finally{assert.equal(dirname(dir),tmpdir());assert.ok(dir.startsWith(join(tmpdir(),'nyanco-hash-')));rmSync(dir,{recursive:true,force:true});}
});
