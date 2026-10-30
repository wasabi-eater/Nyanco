import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM,format} from '../language.mjs';
import {transpileGo} from '../go-backend.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const run=source=>{const p=compile(source),output=[],vm=new VM({...p,output:s=>output.push(s),warning:()=>{}});return {p,vm,output,stack:vm.evaluate('main')};};
const declarations=`class zero 'a where
  zero : -> 'a
instance zero num where
  zero = 0
data person = Person string num
instance show person where
  show (Person name age) = name ++ ":" ++ (show age)
data box 'a = Box 'a
instance show 'a => show (box 'a) where
  show (Box x) = "box(" ++ (show x) ++ ")"
data words = Words [string]
instance streem words where
  item : string
  each (Words xs) f = each xs f
render x = show x
`;
const source=declarations+`main =
  print ("a" ++ "b" ++ "c");
  print (join (split "a,,b," ",") "/");
  print (toVector (split "日本😀" ""));
  print (toVector (split "" ""));
  print (toVector (split "" ","));
  print (toVector (split "::a::::" "::"));
  print (join (take (split "a|b|c" "|") 2) "-");
  print (join (Words ["a","b"]) "--");
  print (join (fromYield {yield "a"; yield "b"; break; yield "bad"}) ",");
  print (toNum "  -1.25e2 ");
  print (toNum "1e999");
  print (toNum "bad");
  print (parseNum ".5");
  print (handle {parseNum "bad"} {exn: {-> message k; 42}});
  print (show (Person "Ada" 3));
  print (render (Box (Person "Bob" 5)));
  print (map [1,2] {show}; toVector);
  print (show (zero + 0));
  print ([1,2] ++ [3]);
  print (show "raw")`;
test('string streams, conversion and show instances work with effects and generic classes',()=>{
 assert.deepEqual(run(source).output,['abc','a//b/','["日", "本", "😀"]','[]','[""]','["", "a", "", ""]','a-b','a--b','a,b','(Some -125)','None','None','0.5','42','Ada:3','box(Bob:5)','["1", "2"]','0','[1, 2, 3]','"raw"']);
 const vm=new VM();vm.evaluate('split "a,b,c" "," -> words');assert.equal(format(vm.evaluate('toVector words')),'[["a", "b", "c"]]');assert.equal(format(vm.evaluate('join words ":"')),'["a:b:c"]');
 assert.deepEqual(run('main = join (map (1 ..= 4) {when ($ == 3) {break}; show}) ","').stack,['1,2']);
});
test('numeric parsing is strict finite decimal parsing and errors are exn effects',()=>{
 for(const text of ['', ' ', '0x10', '0b11', 'NaN', 'Infinity', '12x', '1_000', '+', '.', '1e', '1e999'])assert.equal(run(`main = toNum ${JSON.stringify(text)}`).stack[0].constructor,'None',text);
 for(const [text,n] of [['1.',1],['+.25',.25],['1e-999',0],[' -3 ', -3]])assert.equal(run(`main = parseNum ${JSON.stringify(text)}`).stack[0],n);
 assert.match(compile('f = parseNum').types.get('f'),/exn/);
 assert.doesNotMatch(compile('f = toNum').types.get('f'),/exn/);
 assert.throws(()=>run('main = parseNum "oops"'),/Invalid number/);
 assert.throws(()=>compile('main = join [1,2] ","'),/unify|streem/i);
 assert.throws(()=>compile('main = "a" ++ [1]'),/unify/i);
});
test('show is constrained and instances validate return type and instance contexts',()=>{
 assert.match(compile('f = show').types.get('f'),/show 'a =>/);
 assert.doesNotMatch(compile('f = print').types.get('f'),/show/);
 assert.throws(()=>compile('data bad = Bad\ninstance show bad where\n  show Bad = 1'),/unify/i);
 assert.deepEqual(run('instance show num where\n  show x = "number"\nmain = print (show 4); show 5').output,['number']);
 assert.deepEqual(run('instance show string where\n  show x = "string"\nmain = print "abc"; show "xyz"').stack,['string']);
});
test('native strings and show match VM including typed dictionaries and custom containers',()=>{
 const {p,output}=run(source),dir=mkdtempSync(join(tmpdir(),'hst-strings-'));
 try{const file=join(dir,'main.go'),exe=join(dir,'main.exe');writeFileSync(file,transpileGo(p));const build=spawnSync('go',['build','-o',exe,file],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(build.status,0,build.stderr);const result=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,output.join('\n')+'\n');}finally{rmSync(dir,{recursive:true,force:true});}
});
