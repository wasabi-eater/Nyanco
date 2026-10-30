import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../language.mjs';
import {transpileGo} from '../go-backend.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
const run=s=>{const p=compile(s),output=[],vm=new VM({...p,output:s=>output.push(s),warning:()=>{}});return {p,output,stack:vm.evaluate('main')};};
const source=`sum = fold 0 {+}
one = 1
addOne x = x + 1
numbers = [1,2,3]
localSum xs = inner = fold 0 {+};; inner xs
constantBlock = {1}
useFloatBlock : {-> float / {}} -> float / {}
useFloatBlock = call
floatSum : [float] -> float / {}
floatSum = sum
poly : num 'a => -> 'a / {exn}
poly = 1
data count = Count int
instance num count where
  (+) (Count a) (Count b) = Count (a + b)
  (-) (Count a) (Count b) = Count (a - b)
  (*) (Count a) (Count b) = Count (a * b)
  (/) (Count a) (Count b) = Count (a / b)
  (%) (Count a) (Count b) = Count (a % b)
  (^) (Count a) (Count b) = Count (a ^ b)
  toInt (Count x) = x
  toFloat (Count x) = toFloat x
  toByte (Count x) = toByte x
  toChar (Count x) = toChar x
  fromInt x = Count x
  fromFloat x = Count (toInt x)
  fromByte x = Count (toInt x)
countOne : -> count / {exn}
countOne = one
main =
  print (sum [0,1,2]); print (sum [0.1,0.2,3]);
  print (sum [toByte 1,toByte 2]);
  print (one + toInt 2); print (one + toFloat 2); print (one + toByte 2);
  print (addOne 3.5); print (localSum [0.1,0.2,3]);
  print (floatSum [0.1,0.2,3]); print (useFloatBlock constantBlock);
  print (sum [Count 1,Count 2]); print countOne;
  print (sum numbers); print (toFloat (sum numbers));
  poly -> x; print (x + toFloat 2)`;
function native(p){const dir=mkdtempSync(join(tmpdir(),'nyanco-polynum-'));try{const file=join(dir,'main.go'),exe=join(dir,'main.exe');writeFileSync(file,transpileGo(p));const build=spawnSync('go',['build','-o',exe,file],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(build.status,0,build.stderr);const result=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(result.status,0,result.stderr);return result.stdout;}finally{assert.equal(dirname(dir),tmpdir());assert.ok(dir.startsWith(join(tmpdir(),'nyanco-polynum-')));rmSync(dir,{recursive:true,force:true});}}

test('unconstrained function literals generalize to num across calls and local functions',()=>{
 const {p,output}=run(source);assert.deepEqual(output,['3','3.3','3','3','3','3','4.5','3.3','3.3','1','(Count 3)','(Count 1)','6','6','3']);
 for(const name of ['sum','one','addOne','numbers','localSum'])assert.match(p.types.get(name),/num/);
 assert.doesNotMatch(p.types.get('floatSum'),/num|exn/);
 const vm=new VM(p);assert.match(vm.infer('sum'),/num/);assert.match(vm.infer('sum [1,2]'),/--.*int/);assert.doesNotMatch(vm.infer('sum [0.1,0.2,3]'),/num|exn/);
 assert.match(vm.infer('1'),/--.*int/);assert.match(vm.infer('one'),/num/);
});

test('value bindings stay monomorphic and literal ranges remain checked at specialization',()=>{
 const vm=new VM();vm.evaluate('1 -> x');assert.throws(()=>vm.evaluate('x + toFloat 2'),/unify/);
 assert.throws(()=>compile("poly : num 'a => -> 'a / {exn}\npoly = 1\nmain = poly -> x; x + toInt 2; x + toFloat 3"),/unify/);
 assert.throws(()=>compile('large = 256\nbad : -> byte\nbad = large'),/byte literal/);
 assert.throws(()=>compile('negative = -1\nbad : -> byte\nbad = negative'),/byte literal/);
 assert.throws(()=>compile('one = 1\nmain = one + True'),/Cannot unify|instance/);
});

test('user num literals use fromInt and preserve conversion exceptions',()=>{
 const failing=source.slice(0,source.indexOf('main =')).replace('fromInt x = Count x','fromInt x = if (x == 0) {exn "zero"} {Count x}')+'main = print (handle {sum [Count 1,Count 2]} {exn: {-> message k; Count 99}})';
 const result=run(failing);assert.deepEqual(result.output,['(Count 99)']);assert.equal(native(result.p),'(Count 99)\n');
 assert.throws(()=>compile("bad : num 'a => -> 'a / {}\nbad = 1"),/exn.*not allowed/);
});

test('native num literals specialize for int float byte and user ADTs without a runtime stack',()=>{const {p,output}=run(source);assert.equal(native(p),output.join('\n')+'\n');});
