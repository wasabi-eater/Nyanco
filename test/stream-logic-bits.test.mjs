import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../language.mjs';
import {transpileGo} from '../go-backend.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const run=s=>{const p=compile(s),output=[],vm=new VM({...p,output:s=>output.push(s),warning:()=>{}});return {p,output,stack:vm.evaluate('main')};};
const source=`data bag = Bag [int]
instance streem bag where
  item : int
  each (Bag xs) f = each xs f
data mask = Mask byte
instance and mask where
  (.&.) (Mask a) (Mask b) = Mask (a .&. b)
instance xor mask where
  xor (Mask a) (Mask b) = Mask (xor a b)
instance bits mask where
  testBit (Mask a) i = testBit a i
  setBit (Mask a) i = Mask (setBit a i)
  clearBit (Mask a) i = Mask (clearBit a i)
main =
  print (maxi (map (1 ..= 4) {* 2})); print (mini (Bag [3,1,2])); print (maxi []);
  print (maxiBy [{n: 2,id: "a"},{n: 2,id: "b"}] {.n});
  print (miniBy [{n: 2,id: "a"},{n: 2,id: "b"}] {.n});
  print (maxi (fromYield {yield 3; yield 1; break; yield 9}));
  print (maxiBy [1,2,3,4] {when ($ == 3) {break}; nop});
  print (all [] {> 0}); print (any [] {> 0});
  0 -> mut seen;
  print (all (fromYield {seen ! + 1; yield 1; seen ! + 1; yield 0; seen ! + 1; yield 9}) {> 0}); print seen;
  seen <- 0;
  print (any (fromYield {seen ! + 1; yield 0; seen ! + 1; yield 1; seen ! + 1; yield 9}) {> 0}); print seen;
  print (all (Bag [1,2,3]) {when ($ == 2) {break}; > 0});
  print (any [1,2,3] {when ($ == 2) {break}; > 2});
  print (all [1] {break}); print (maxiBy [1] {break});
  while {True} @outer {drop (all [1] {break@outer}); seen ! + 1}; print seen;
  print (False && (exn "skipped")); print (True || (exn "skipped"));
  print (False && (print "wrong"; True)); print (True || (print "wrong"; False));
  print (True .|. (print "eager"; False));
  print (False || True && False); print (True && 1 < 2);
  print (7 .&. 3); print (5 .|. 2); print (xor 3 5); print (xor True False);
  print ((toByte 255) .&. (toByte 15)); print ((toByte 128) .<<. 1); print ((toByte 128) .>>. 7);
  print (-8 .>>. 2); print (1 .<<. 40); print (testBit (1 .<<. 40) 40);
  print (setBit 0 40); print (clearBit (1 .<<. 40) 40);
  print (setBit (toByte 0) 7); print (testBit (Mask (toByte 4)) 2);
  print ((Mask (toByte 7)) .&. (Mask (toByte 3))); print (xor (Mask (toByte 3)) (Mask (toByte 5)));
  print (handle {1 .<<. 64} {exn: {-> message k; 99}});
  print (handle {testBit (toByte 1) 8} {exn: {-> message k; False}})`;

function native(program){const dir=mkdtempSync(join(tmpdir(),'nyanco-stream-bits-'));try{const file=join(dir,'main.go'),exe=join(dir,'main.exe');writeFileSync(file,transpileGo(program));const build=spawnSync('go',['build','-o',exe,file],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(build.status,0,build.stderr);const result=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(result.status,0,result.stderr);return result.stdout;}finally{rmSync(dir,{recursive:true,force:true});}}

test('stream extrema predicates and bit operations preserve effects and short circuit',()=>{
 assert.deepEqual(run(source).output,['(Some 8)','(Some 1)','None','(Some {id: "b", n: 2})','(Some {id: "a", n: 2})','(Some 3)','(Some 2)','True','False','False','2','True','2','True','False','True','None','2','False','True','False','True','eager','True','False','True','3','7','6','True','15','0','1','-2','1099511627776','True','1099511627776','0','128','True','(Mask 3)','(Mask 6)','99','False']);
 assert.deepEqual(run('main = 100; maxi [1,3,2]; any [0,1] {> 0}').stack.map(v=>v?.kind==='adt'?v.constructor:v),[100,'Some',true]);
 assert.deepEqual(run('main = all (fromYield {yield True; break; yield False}) {nop}; any (fromYield {yield False; break; yield True}) {nop}').stack,[true,false]);
 assert.throws(()=>run('main = all [1]'),/underflow|stack|Cannot unify/i);
 for(const s of ['all [1] {dup}','all [1] {nop}','1 && True','1.0 .&. 2.0','(toByte 1) .|. (toInt 2)','testBit 1.0 0','1 .<<. 1.0'])assert.throws(()=>compile('main = '+s),/Type error|instance/i,s);
 assert.throws(()=>run('main = True and False'),/Unknown word/);
 assert.match(compile('f xs = all xs {print $; > 0}').types.get('f'),/io/);
 assert.doesNotMatch(compile('f xs = any xs {when ($ == 2) {break}; > 0}').types.get('f'),/\/ \{break/);
});

test('native extrema short circuit predicates and bit operations agree with VM',()=>{const {p,output}=run(source);assert.equal(native(p),output.join('\n')+'\n');});

test('native int bit operations retain all 64 bits',()=>{
 assert.equal(native(compile('main = print (9223372036854775807 .&. 1); print (1 .<<. 63); print ((-9223372036854775808) .>>. 63); print (testBit (-9223372036854775808) 63)')),'1\n-9223372036854775808\n-1\nTrue\n');
});
