import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../language.mjs';
import {transpileGo} from '../go-backend.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const run=s=>{const p=compile(s),output=[],vm=new VM({...p,output:s=>output.push(s),warning:()=>{}});return {p,output,stack:vm.evaluate('main')};};
const source=`data distance = Distance float
instance into int distance where
  from x = Distance (toFloat x)
instance into float distance where
  from x = Distance x
instance into byte distance where
  from x = Distance (toFloat x)
instance into distance int where
  from (Distance x) = toInt x
instance into distance float where
  from (Distance x) = x
make : int -> distance / {exn}
make = fromInt
convert : into 'a 'b => 'a -> 'b / {exn}
convert = from
asInt : into 'a int => 'a -> int / {exn}
asInt = toInt
asFloat : into int 'a => int -> 'a / {exn}
asFloat = fromInt
floats : [int] -> [float] / {exn}
floats xs = vmap xs {from}
class pair 'a 'b where
  pairText : 'a 'b -> string
instance pair int int where
  pairText a b = "both ints"
instance pair int string where
  pairText n s = show n ++ s
class pair 'a string => tagged 'a where
instance tagged byte where
  pairText n s = show n ++ s
instance show 'a => into 'a string where
  from x = show x
text : show 'a => 'a -> string / {exn}
text = from
numIn : num 'a => int -> 'a / {exn}
numIn = from
numOut : num 'a => 'a -> float / {exn}
numOut = from
floatIn : int -> float / {exn}
floatIn = numIn
charIn : -> char / {exn}
charIn = from 128512
data box 'a = Box 'a
instance into 'a 'b => into (box 'a) (box 'b) where
  from (Box x) = Box (from x)
boxed : box int -> box float / {exn}
boxed = from
class pairing 'a 'b where
  type combined
  combine : 'a 'b -> combined
class pairing 'a 'b => joined 'a 'b where
instance joined byte float where
  combined : string
  combine a b = "combined"
combineJoined : joined 'a 'b 'c => 'a 'b -> 'c
combineJoined = combine
class show 'a => shown 'a 'b where
  describe : 'a 'b -> string
instance shown int string where
  describe a b = show a
renderShown : shown 'a 'b => 'a 'b -> string
renderShown a b = show a
main =
  print (boxed (Box 14)); print (combineJoined (toByte 15) 1.0); print (renderShown 16 "unused");
  print (pairText 1 2); print (make 3); print (toFloat (make 4)); print (asInt (make 5));
  print (asFloat 6 + 0.5); print (floats [7,8]);
  print (pairText 9 "x"); print (pairText (toByte 10) "y");
  print (text 11); print (floatIn 12); print (numOut (toByte 13));
  print charIn; print (toInt 'A');
  print (handle {toByte 256} {exn: {-> message k; toByte 0}})`;

test('into dispatch uses both source and result and conversion wrappers share dictionaries',()=>{
 assert.deepEqual(run(source).output,['(Box 14)','combined','16','both ints','(Distance 3)','4','5','6.5','[7, 8]','9x','10y','11','12','13',"'😀'",'65','0']);
 const prefix=`data box = Box int
instance toInt box where
  from (Box x) = x
instance fromInt box where
  from x = Box x
`;
 assert.deepEqual(run(prefix+`asBox : int -> box / {exn}
asBox = from
asInt : box -> int / {exn}
asInt = from
main = asInt (asBox 42)`).stack,[42]);
 const vm=new VM();assert.match(vm.infer('from'),/into 'a 'b/);assert.match(vm.infer('fromFloat'),/fromFloat/);
 assert.throws(()=>run('main = from 1'),/Ambiguous conversion/);
 assert.throws(()=>compile(`data token = Token
instance into int token where`),/Missing instance method: from/);
 assert.throws(()=>compile(`class parent 'a where
  parentValue : 'a -> int
instance parent int where
  parentValue x = x
class parent int => child 'a where
  childValue : 'a -> int
f : child 'a => 'a -> int
f = parentValue`),/Missing constraint/);
 assert.throws(()=>compile(`class into int float => fixed 'a where
instance fixed bool where
  from n = 1.0`),/already has a superclass instance/);
 assert.throws(()=>compile(`class into 'a int, into 'a float => ambiguous 'a where`),/Conflicting inherited specialization/);
 assert.doesNotThrow(()=>compile(`class into int float => fixed 'a where
instance fixed bool where`));
 assert.throws(()=>compile(`bad : string -> int / {exn}
bad = from`),/No instance/);
 assert.throws(()=>compile(`instance into int float where
  from x = 0.0`),/already exists/);
 assert.throws(()=>compile(`instance into 'a float where
  from x = 0.0`),/already exists/);
 assert.throws(()=>compile(`class pair 'a 'b where
  pairText : 'a 'b -> string
f : pair 'a int => 'a -> string
f = pairText _ "x"`),/Missing constraint/);
});

test('native into, from wrappers, generic constraints and result-directed quotation calls agree with VM',()=>{
 const {p,output}=run(source),dir=mkdtempSync(join(tmpdir(),'nyanco-into-'));
 try{const file=join(dir,'main.go'),exe=join(dir,'main.exe');writeFileSync(file,transpileGo(p));const build=spawnSync('go',['build','-o',exe,file],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(build.status,0,build.stderr);const result=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,output.join('\n')+'\n');}finally{rmSync(dir,{recursive:true,force:true});}
});

