import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../language.mjs';
import {transpileGo} from '../go-backend.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const run=s=>{const p=compile(s),output=[],vm=new VM({...p,output:s=>output.push(s),warning:()=>{}});return {p,output,stack:vm.evaluate('main')};};
const source=`data ranked = Ranked int string
instance ord ranked where
  (<) (Ranked a x) (Ranked b y) = a < b
  (<=) (Ranked a x) (Ranked b y) = a <= b
  (>) (Ranked a x) (Ranked b y) = a > b
  (>=) (Ranked a x) (Ranked b y) = a >= b
main =
  print (max 3 5); print (min 3 5); print (max -8 -3); print (min 1.5 2.5);
  print (max (toByte 3) (toByte 5)); print (max 'a' 'z');
  print (max (Ranked 2 "a") (Ranked 2 "b")); print (min (Ranked 2 "a") (Ranked 2 "b"));
  print (vmap [1,7,3] {min 5});
  print (unwrap (Some "hi")); print (unwrap (maxi [1,3,2])); print (mini []);
  print (maxiBy [1,2,3] {0 -}); print (miniBy [1,2,3] {0 -});
  print (maxiBy [1,2,3] {when ($ == 3) {cancel}; nop});
  print (handle {unwrap None} {exn: {-> message k; message}});
  print (call 7 (unwrap (Some {+ 1})))`;

test('binary extrema use ord and unwrap returns payloads or raises exn',()=>{
 assert.deepEqual(run(source).output,['5','3','-3','1.5','5',"'z'",'(Ranked 2 "b")','(Ranked 2 "a")','[1, 5, 3]','hi','3','None','(Some 1)','(Some 3)','(Some 2)','unwrap: None','8']);
 assert.deepEqual(run('main = 100; max 3 5; min 2 4').stack,[100,5,2]);
 assert.throws(()=>run('main = unwrap None'),/unwrap: None/);
 assert.throws(()=>compile('main = unwrap 3'),/No instance: unwrap int/);
 assert.throws(()=>compile('main = max (toInt 1) (toFloat 2)'),/Cannot unify/);
 assert.throws(()=>compile("data option 'a = None | Some int\nmain = unwrap (Some 1)"),/No instance: unwrap/);
 const vm=new VM();assert.match(vm.infer('max'),/ord/);assert.match(vm.infer('maxi'),/streem/);assert.match(vm.infer('unwrap'),/exn/);
});

test('missing instance diagnostics put class names before their type arguments',()=>{
 for(const [source,message] of [
  ['data opaque = Opaque\nmain = max Opaque Opaque','No instance: ord opaque'],
  ['main = maxi True','No instance: streem bool'],
  ['main = (Some 1).[0]','No instance: indexGet (option int)'],
  ['main = testBit 1.0 0','No instance: bits float'],
  ['main = toInt "bad"','No instance: into string int'],
  ["f : 'a 'a -> 'a\nf = +",'Missing constraint: add '],
 ])assert.throws(()=>compile(source),error=>error.message.includes(message),message);
});

test('native binary extrema, renamed stream extrema and option unwrap agree with VM',()=>{
 const {p,output}=run(source),dir=mkdtempSync(join(tmpdir(),'nyanco-extrema-option-'));
 try{const file=join(dir,'main.go'),exe=join(dir,'main.exe');writeFileSync(file,transpileGo(p));const build=spawnSync('go',['build','-o',exe,file],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(build.status,0,build.stderr);const result=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,output.join('\n')+'\n');}finally{rmSync(dir,{recursive:true,force:true});}
});
