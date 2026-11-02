import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../language.mjs';
import {transpileGo} from '../go-backend.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const run=s=>{const p=compile(s),output=[],vm=new VM({...p,output:s=>output.push(s),warning:()=>{}});return {p,output,stack:vm.evaluate('main')};};
const source=`sameOrdered : ord 'a => 'a 'a -> bool
sameOrdered = ==
differentOrdered : ord 'a => 'a 'a -> bool
differentOrdered = /=
data ordered = Ordered int
instance ord ordered where
  (==) (Ordered a) (Ordered b) = a == b
  (/=) (Ordered a) (Ordered b) = a /= b
  (<) (Ordered a) (Ordered b) = a < b
  (<=) (Ordered a) (Ordered b) = a <= b
  (>) (Ordered a) (Ordered b) = a > b
  (>=) (Ordered a) (Ordered b) = a >= b
class show \'a => left \'a where
class show \'a => right \'a where
class left \'a, right \'a => named \'a where
  name : \'a -> string
data person = Person string
instance named person where
  name (Person x) = x
  show (Person x) = "person:" ++ x
render : named \'a => \'a -> string
render = show
class source \'a where
  type item
  readItem : \'a -> item
class source \'a => checked \'a where
  checkedItem : \'a -> item
data box \'a = Box \'a
instance checked (box \'a) where
  item : \'a
  readItem (Box x) = x
  checkedItem (Box x) = x
readChecked : checked \'a \'b => \'a -> \'b
readChecked = readItem
cast : num \'a => \'a -> float / {exn}
cast = toFloat
class streem 'c => iterable 'c where
data seq 'a = Seq ['a]
instance iterable (seq 'a) where
  item : 'a
  each (Seq xs) f = each xs f
instance iterable ['a] where
  item : 'a
collect : iterable 'c 'a => 'c -> ['a]
collect = toVector
data code = Code int
instance toChar code where
  toChar (Code n) = toChar n
main = print (sameOrdered (Ordered 3) (Ordered 3)); print (differentOrdered [1] [2]); print (collect [4,5]); print (collect (Seq [1,2,3])); print (toChar (Code 66)); print (render (Person "Ada")); print (name (Person "Bob")); print (readChecked (Box 7)); print (cast 3); print (bytes "日本😀"); print (toChar 65); print (toChar 128512); print (toChar 'あ'); print (handle {toChar 55296} {exn: {-> msg k; 'x'}})`;
test('inheritance carries methods and associated types through diamonds and generic annotations',()=>{
 assert.deepEqual(run(source).output,['True','True','[4, 5]','[1, 2, 3]',"'B'",'person:Ada','Bob','7','3','[230, 151, 165, 230, 156, 172, 240, 159, 152, 128]',"'A'","'😀'","'あ'","'x'"]);
 assert.deepEqual(run('class show \'a => named \'a where\n  name : \'a -> string\ndata p = P\ninstance show p where\n  show P = "p"\ninstance named p where\n  name P = "name"\nmain = show P; name P').stack,['p','name']);
 assert.deepEqual(run(`class show 'a => parent 'a where
class parent 'a => child 'a where
instance child int where
f : child 'a => 'a -> string
f = show
main = f 3`).stack,['3']);
 for(const n of [-1,55296,57343,1114112])assert.throws(()=>run('main = toChar '+n),/Invalid numeric cast/);
 assert.deepEqual(run('main = bytes ""').stack,[[]]);
});
test('invalid superclass graphs and incomplete instances fail statically',()=>{
 for(const s of ['class missing \'a => child \'a where','class b \'a => a \'a where\nclass a \'a => b \'a where','class show \'b => child \'a where'])assert.throws(()=>compile(s),/superclass|inheritance|parameter/i);
 assert.throws(()=>compile('class parent \'a where\n  parentName : \'a -> string\nclass parent \'a => child \'a where\n  label : \'a -> string\ndata p = P\ninstance child p where\n  label P = "p"'),/Missing instance method: parentName/);
 assert.throws(()=>compile('class show \'a => child \'a where\n  label : \'a -> string\nf : show \'a => \'a -> string\nf = label'),/Missing constraint/);
 const context=`class parent 'a where
  parentName : 'a -> string
class parent 'a => child 'a where
  childName : 'a -> string
data box 'a = Box 'a
instance parent 'a => parent (box 'a) where
  parentName (Box x) = parentName x
instance child (box 'a) where
  childName (Box x) = "child"`;
 assert.throws(()=>compile(context),/Missing constraint/);
 assert.doesNotThrow(()=>compile(context.replace('instance child (box',"instance parent 'a => child (box")));
 assert.throws(()=>compile(`class parent 'a where
  type item
  getItem : 'a -> item
class parent 'a => child 'a where
data box 'a = Box 'a
instance parent (box 'a) where
  item : 'a
  getItem (Box x) = x
instance child (box 'a) where
  item : int`),/Cannot unify|Type mismatch|rigid/i);
 assert.throws(()=>compile(`class show 'a => child 'a where
data p = P
instance show p where
  show P = "parent"
instance child p where
  show P = "child"`),/already has a superclass instance/);
 assert.throws(()=>compile(`class add 'a => child 'a where
instance child int where
  (+) a b = a`),/already has a superclass instance/);
 assert.throws(()=>compile(`class streem 'a => child 'a where
data box 'a = Box ['a]
instance streem (box 'a) where
  item : 'a
  each (Box xs) f = each xs f
instance child (box 'a) where
  item : int`),/Cannot unify|Type mismatch|rigid/i);
 assert.match(new VM().infer('+'),/add/);assert.match(new VM().infer('toInt'),/toInt/);assert.match(new VM().infer('bytes'),/\[byte\]/);
});
test('native superclass dictionaries and character/byte conversions match VM',()=>{
 const {p,output}=run(source),dir=mkdtempSync(join(tmpdir(),'nyanco-inheritance-'));
 try{const file=join(dir,'main.go'),exe=join(dir,'main.exe');writeFileSync(file,transpileGo(p));const build=spawnSync('go',['build','-o',exe,file],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(build.status,0,build.stderr);const result=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,output.join('\n')+'\n');}finally{rmSync(dir,{recursive:true,force:true});}
});

test('ord requires eq implementations and entails eq in generic annotations',()=>{
 const p=compile(source);
 assert.match(p.types.get('sameOrdered'),/ord 'a/);
 assert.doesNotMatch(p.types.get('sameOrdered'),/eq 'a/);
 assert.throws(()=>compile(`data opaque = Opaque
instance ord opaque where
  (<) _ _ = False
  (<=) _ _ = True
  (>) _ _ = False
  (>=) _ _ = True`),/Missing instance method: ==/);
 assert.throws(()=>compile(`f : eq 'a => 'a 'a -> bool
f = <`),/Missing constraint: ord/);
});
