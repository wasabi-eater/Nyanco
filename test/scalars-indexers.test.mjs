import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../language.mjs';
import {transpileGo} from '../go-backend.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const run=s=>{const p=compile(s),output=[],vm=new VM({...p,output:s=>output.push(s),warning:()=>{}});return {p,output,stack:vm.evaluate('main')};};
const defs=`b : -> byte
b = 250
f : -> float
f = 3
data box 'a = Box ['a]
instance indexGet (box 'a) where
  key : int
  item : 'a
  at (Box xs) i = at xs i
instance indexSet (box 'a) where
  key : int
  item : 'a
  setAt (Box xs) i x = Box (setAt xs i x)
`;
const body=`main =
 print (7 / 2); print ((0 - 7) / 2); print (7.0 / 2.0);
 print (b + 5); print (f / 2);
 print (toInt 3.9); print (toFloat 3 / 2); print (toByte 42);
 print (vchars "日本😀"); print ('あ' < '😀');
 print (toVector (take (chars "😀あ") 1)); print (nth (bytes "あ") 1); print (count (bytes "日本😀"));
 print ("あ".[0]); print ("あ".[1]); print ("あ".[2]);
 print ("あ".?[3]); print ("abc" with {.[1] = 100});
 print ((Box [1,2]).[1]); print ((Box [1,2]) with {.[1] ! + 10});
 Box [1,2] -> mut xs; xs.[0] <<- 9; print xs;
 print (handle {toByte 256} {exn: {-> message k; toByte 0}});
 print (handle {"あ" with {.[0] = 0}} {exn: {-> message k; "invalid UTF-8"}})`;
function native(source){const p=compile(source),dir=mkdtempSync(join(tmpdir(),'nyanco-scalars-'));try{const file=join(dir,'main.go'),exe=join(dir,'main.exe');writeFileSync(file,transpileGo(p));const build=spawnSync('go',['build','-o',exe,file],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(build.status,0,build.stderr);const result=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(result.status,0,result.stderr);return result.stdout;}finally{rmSync(dir,{recursive:true,force:true});}}
test('numeric inference separates scalar types and contextual integer literals',()=>{
 const vm=new VM();assert.match(vm.infer('3'),/->.*int/);assert.match(vm.infer('3.0'),/->.*float/);assert.match(vm.infer("'あ'"),/->.*char/);assert.match(vm.infer('"a".[0]'),/->.*byte/);assert.match(vm.infer('+'),/add 'a/);
 assert.match(compile(defs).types.get('b'),/byte/);assert.match(compile(defs).types.get('f'),/float/);
 for(const expr of ['toByte 1 + toInt 2','toInt 1 + toFloat 2','toFloat 1 == toInt 1',"'a' + 'b'",'3 // 2'])assert.throws(()=>run('main = '+expr),/unify|instance|removed/i,expr);
 assert.deepEqual(run('main = toByte 2 + 1').stack,[{kind:'scalar',type:'byte',value:3}]);
 assert.throws(()=>compile('one = 1\nmain = toByte 2 + one'),/Cannot unify byte with int/);
 assert.throws(()=>compile("instance indexGet string where\n  key : int\n  item : byte\n  at s i = toByte 0"),/already exists/);
 assert.throws(()=>compile('bad : -> byte\nbad = 256'),/byte literal/);
 assert.throws(()=>run('main = 9223372036854775808'),/64-bit/);
 assert.throws(()=>run('main = -9223372036854775809'),/64-bit/);
 assert.throws(()=>run('main = toInt 1 -> x; toFloat 2 + x'),/unify/);
});
test('UTF-8 indexing, character vectors, classes and persistent updates agree with native',()=>{
 const {output}=run(defs+body);assert.deepEqual(output,['3','-3','3.5','255','1.5','3','1.5','42',"['日', '本', '😀']",'True',"['😀']",'(Some 129)','10','227','129','130','None','adc','2','(Box [1, 12])','(Box [9, 2])','0','invalid UTF-8']);assert.equal(native(defs+body),output.join('\n')+'\n');
});
test('index updates dispatch to instances and skip the callback on missing indices',()=>{
 const concrete=defs.replace("data box 'a = Box ['a]",'data box = Box [int]')
   .replaceAll("(box 'a)",'box').replaceAll("item : 'a",'item : int');
 const source=concrete.replace('  setAt (Box xs) i x = Box (setAt xs i x)',`  setAt (Box xs) i x = Box (setAt xs i x)
  updateAt (Box xs) i f = Box (updateAt xs i {call f; + 100})`)+`main =
  print (updateAt (Box [1,2]) -1 {+ 3})
  print (tryUpdateAt (Box [1,2]) -1 {+ 3})
  print (tryUpdateAt [1,2] -3 {exn "unreachable"})
  print (catch {tryUpdateAt [1,2] -1 {exn "callback"}})
  print (tryAt [1,2] -1)
  print (tryAt "ab" -1)
  print ([-1: "key"].[-1])
`;
 const {output}=run(source);
 assert.deepEqual(output,['(Box [1, 105])','(Box [1, 5])','[1, 2]','(Err "callback")','(Some 2)','None','key']);
 assert.equal(native(source),output.join('\n')+'\n');
 assert.throws(()=>compile('main = 0; updateAt [1] 0 {swap}'),/unify|underflow/i);
});
test('text streams retain their scalar types across REPL evaluations',()=>{
 const vm=new VM();
 vm.evaluate('chars "a😀" -> letters; bytes "あ" -> octets');
 assert.match(vm.infer('letters'),/stream char/);
 assert.match(vm.infer('octets'),/stream byte/);
 for(let i=0;i<2;i++){
  assert.deepEqual(vm.evaluate('toVector letters'),vm.evaluate('vchars "a😀"'));
  assert.deepEqual(vm.evaluate('toVector octets'),vm.evaluate('vbytes "あ"'));
 }
 assert.deepEqual(vm.evaluate('toVector (chars ""); toVector (bytes "")'),[[],[]]);
 const boundary='a'.repeat(4095)+'😀b';
 assert.deepEqual(vm.evaluate(`toVector (bytes "${boundary}")`)[0].map(v=>v.value),[...Buffer.from(boundary)]);
});

test('native integers preserve signed 64-bit values and truncate division',()=>{
 assert.equal(native('main = print 9223372036854775807; print (-9223372036854775808); print (9223372036854775807 - 1); print (toInt 9223372036854775807)'), '9223372036854775807\n-9223372036854775808\n9223372036854775806\n9223372036854775807\n');
});

test('num instances and custom non-integer index keys use the same syntax',()=>{
 const source=`data amount = Amount int
instance num amount where
  (+) (Amount x) (Amount y) = Amount (x + y)
  (-) (Amount x) (Amount y) = Amount (x - y)
  (*) (Amount x) (Amount y) = Amount (x * y)
  (/) (Amount x) (Amount y) = Amount (x / y)
  (%) (Amount x) (Amount y) = Amount (x % y)
  (^) (Amount x) (Amount y) = Amount (x ^ y)
  toInt (Amount x) = x
  toFloat (Amount x) = toFloat x
  toByte (Amount x) = toByte x
  toChar (Amount x) = toChar x
  fromInt x = Amount x
  fromFloat x = Amount (toInt x)
  fromByte x = Amount (toInt x)
data settings = Settings int
instance indexGet settings where
  key : string
  item : int
  at (Settings value) key = value
main = print ((fromInt 3) + (Amount 4)); print ((Amount 7) / (Amount 2)); print ((Settings 9).["key"]); print (toByte (-0.5))`;
 const {output}=run(source);assert.deepEqual(output,['(Amount 7)','(Amount 3)','9','0']);assert.equal(native(source),output.join('\n')+'\n');
 assert.throws(()=>compile(source+'\nbad = (Settings 9) with {.["key"] = 1}'),/indexSet/);
});
