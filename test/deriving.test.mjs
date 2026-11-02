import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../language.mjs';
import {transpileGo} from '../go-backend.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
const source=`data foo 'a = Foo 'a deriving show, eq, hash, ord
data tree 'a = Leaf 'a | Node (tree 'a) (tree 'a) deriving show, eq, hash, ord
data left 'a = L (right 'a) | End 'a deriving show, eq, hash, ord
data right 'a = R (left 'a) deriving show, eq, hash, ord
data phantom 'a = Phantom deriving show, eq, hash, ord
data ticket = Ticket int string
instance eq ticket where
  (==) (Ticket a _) (Ticket b _) = a == b
  (/=) a b = not (a == b)
instance show ticket where
  show (Ticket _ name) = "ticket:" ++ name
instance hash ticket where
  hash (Ticket n _) = hash n
instance ord ticket where
  (<) (Ticket a _) (Ticket b _) = a < b
  (<=) (Ticket a _) (Ticket b _) = a <= b
  (>) (Ticket a _) (Ticket b _) = a > b
  (>=) (Ticket a _) (Ticket b _) = a >= b
data wrapped 'a = Wrapped ['a] deriving show, eq, hash, ord
same : eq 'a => 'a 'a -> bool
same = ==
less : ord 'a => 'a 'a -> bool
less = <
compareRest a b = (a with x = 0) == (b with x = 0)
main =
 print (Foo 1 == Foo 1); print (Foo 1 /= Foo 2); print (Foo 1 < Foo 2)
 print (show (Foo "x"))
 print (Node (Leaf 1) (Leaf 2) == Node (Leaf 1) (Leaf 2))
 print (Leaf 999 < Node (Leaf 0) (Leaf 0))
 print (show (Node (Leaf 1) (Leaf 2)))
 print (L (R (End 3)) == L (R (End 3)))
 print (show (L (R (End 3))))
 print (same [Ticket 1 "a"] [Ticket 1 "b"])
 print (same #(Ticket 1 "a", 2) #(Ticket 1 "b", 2))
 print (same {x: Ticket 1 "a"} {x: Ticket 1 "b"})
 print (same [0: Ticket 1 "a"] [0: Ticket 1 "b"])
 print (same (Some (Ticket 1 "a")) (Some (Ticket 1 "b")))
 print (same (Wrapped [Ticket 1 "a"]) (Wrapped [Ticket 1 "b"]))
 print (show (Wrapped [Ticket 1 "a",Ticket 2 "b"]))
 print (less [Ticket 1 "x"] [Ticket 2 "y"])
 print (less #(1,2) #(1,3)); print (less {x: 1} {x: 2})
 print (less [1: 10] [2: 20]); print (less None (Some 1))
 print (Foo 2 >= Foo 2)
 print (([Foo 1: "value"]).[Foo 1])
 print (hash (Node (Leaf 1) (Leaf 2)))
 print (hash (L (R (End 3))))
 print (compareRest {x: "ignored", y: Ticket 1 "a"} {x: "other", y: Ticket 1 "b"})
 print (Phantom == Phantom)`;
const run=()=>{const p=compile(source),output=[],vm=new VM({...p,output:s=>output.push(s)});vm.evaluate('main');return {p,output};};
test('deriving supports recursive ADTs and structural instances honor custom fields',()=>{
  const {output}=run();assert.deepEqual(output.slice(0,9),['True','True','True','(Foo "x")','True','True','(Node (Leaf 1) (Leaf 2))','True','(L (R (End 3)))']);
  assert.deepEqual(output.slice(9,16),['True','True','True','True','True','True','(Wrapped [ticket:a, ticket:b])']);
  assert.ok(output.slice(16,22).every(x=>x==='True'));assert.equal(output[22],'value');assert.equal(output.at(-1),'True');
  const vm=new VM();vm.definitions=compile("data foo 'a = Foo 'a deriving eq").definitions;
  assert.deepEqual(vm.evaluate('Foo 3 == Foo 3'),[true]);
  vm.definitions=compile('identity x = x','<repl>',vm.definitions).definitions;assert.deepEqual(vm.evaluate('Foo 3 == Foo 3'),[true]);
});
test('eq constraints reject quotations and non-derived ADTs, including nested values',()=>{
  const vm=new VM();assert.match(vm.infer('=='),/eq 'a/);assert.match(vm.infer('/='),/eq 'a/);
  for(const expr of ['{1} == {1}','[{1}] == [{1}]','{f: {1}} == {f: {1}}','Some {1} == Some {1}','[0: {1}] == [0: {1}]','fromYield {yield 1} == fromYield {yield 1}'])assert.throws(()=>vm.infer(expr),/eq/);
  assert.throws(()=>compile('data foo = Foo\nmain = Foo == Foo'),/eq/);
  assert.throws(()=>compile("same : 'a 'a -> bool\nsame = =="),/eq/);
  assert.throws(()=>compile('data bad = Bad {-> int} deriving eq'),/eq/);
  assert.throws(()=>compile('data bad = Bad {-> int} deriving hash'),/hash/);
  assert.throws(()=>compile('data bad = Bad {-> int} deriving eq, ord'),/eq|ord/);
  assert.throws(()=>compile('data bad = Bad deriving unknown'),/derive/);
  assert.throws(()=>compile('data bad = Bad deriving eq, eq'),/deriving/);
  assert.throws(()=>compile('data bad = Bad deriving eq,\n'),/deriving/);
});
test('deriving infers obligations through existing instance contexts and phantom fields',()=>{
  const p=compile(`data box 'a = Box 'a
instance hash 'a => eq (box 'a) where
  (==) (Box a) (Box b) = hash a == hash b
  (/=) a b = not (a == b)
data outer 'a = Outer (box 'a) deriving eq
data phantom 'a = Phantom deriving eq
f x = Outer (Box x) == Outer (Box x)
main = f 1; Phantom == Phantom`);
  assert.match(p.types.get('f'),/hash/);assert.doesNotMatch(p.types.get('f'),/eq 'a/);
  assert.deepEqual(new VM(p).evaluate('main'),[true,true]);
  const multi=compile(`class evidence 'a 'b where
  witness : 'a 'b -> bool
instance evidence int string where
  witness _ _ = True
data box 'a 'b = Box 'a 'b
instance evidence 'a 'b => eq (box 'a 'b) where
  (==) (Box a b) (Box c d) = witness a b && witness c d
  (/=) a b = not (a == b)
data outer 'a 'b = Outer (box 'a 'b) deriving eq
same a b = Outer (Box a b) == Outer (Box a b)
main = same 1 "x"`);
  assert.match(multi.types.get('same'),/evidence/);assert.deepEqual(new VM(multi).evaluate('main'),[true]);

});
test('native deriving and structural Eq/Ord/Show/Hash agree with VM',()=>{
  const {p,output}=run(),dir=mkdtempSync(join(tmpdir(),'nyanco-deriving-'));
  try{const file=join(dir,'main.go');writeFileSync(file,transpileGo(p));const r=spawnSync('go',['run',file],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(r.status,0,r.stderr);assert.equal(r.stdout,output.join('\n')+'\n');}
  finally{assert.equal(dirname(dir),tmpdir());assert.ok(dir.startsWith(join(tmpdir(),'nyanco-deriving-')));rmSync(dir,{recursive:true,force:true});}
});
