import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {compile,VM} from '../language.mjs';
import {compileModule} from '../modules.mjs';
import {LanguageService} from '../lsp.mjs';
import {transpileGo} from '../go-backend.mjs';

test('exported ordinary functions require explicit annotations including zero-argument functions',()=>{
 for(const visibility of ['pub','open'])assert.throws(()=>compile(visibility+' f = 1'),/Exported function f requires an explicit type annotation/);
 assert.doesNotThrow(()=>compile('private x = x'));
 assert.doesNotThrow(()=>compile('pub f : int\nf = 1'));
 assert.doesNotThrow(()=>compile('f : int -> int\npub f x = x'));
 assert.doesNotThrow(()=>compile('pub f : int -> int\nf x = x'));
 assert.throws(()=>compile('pub f : int -> int\nf = "wrong"'),/unify/);
 const unchecked=compile('pub f = 1','<unchecked>',new Map(),{checkTypes:false});
 assert.throws(()=>new VM(unchecked).evaluate('f'),/explicit type annotation/);
 assert.doesNotThrow(()=>compile("pub data box 'a = Box 'a\nopen type pair = #(int int)\npub class named 'a where\n  name : 'a -> string\npub effect ask : -> int"));
});

const source=`pub bump : ..s int -> ..s int
bump = + 1
pub apply : ..s {..s -> ..s / { | 'e}} -> ..s / { | 'e}
apply = call
pub twice : ..s {..s -> ..s / { | 'e}} -> ..s / { | 'e}
twice f = call f; call f
pub preserve : ..s 'a -> ..s 'a
preserve x = x
pub stop : ..s -> ! / {exn}
stop = exn "stopped"
main =
 print (bump 3)
 "prefix"; 4; bump; print; print
 True; "prefix"; 5; bump; print; print; print
 10; twice {+ 2}; print
 20; apply {print $; + 1}; print
 print (preserve "value")
 print (catch {stop; 1})
`;

test('explicit stack rows preserve prefixes through ordinary and higher-order functions',()=>{
 const p=compile(source),output=[],vm=new VM({...p,output:s=>output.push(s),warning:()=>{}});vm.evaluate('main');
 assert.deepEqual(output,['4','5','prefix','6','prefix','True','14','20','21','value','(Err "stopped")']);
 assert.match(p.types.get('bump'),/\.\.s int -> \.\.s int/);
 assert.doesNotThrow(()=>compile("f : ..s int -> ..'s int\nf = nop"));
 assert.doesNotThrow(()=>compile("f : ..'s int -> ..s int\nf = nop"));
 assert.throws(()=>compile('bad : ..s int -> ..s int\nbad = drop; drop; 0'),/row|stack|shape|rigid|unify|underflow/i);
});

test('stack row syntax rejects misplaced, duplicated, mismatched and value-position rows',()=>{
 for(const type of ['int ..s -> ..s int','..s ..t int -> ..s int','..s int -> int','..s int -> ..t int','int -> ..s int','[..s] -> int','..s int -> int ..s','{..s ->} -> int'])assert.throws(()=>compile('f : '+type+'\nf = nop'),/stack row|Stack row|row.*value/i,type);
 assert.throws(()=>compile("f : ..s 's -> ..s 's\nf = nop"),/kind|row|value/i);
});

test('module exports can obtain annotations from a different file and stack row names do not resolve as imports',()=>{
 const dir=mkdtempSync(join(tmpdir(),'nyanco-export-types-'));
 try{
  mkdirSync(join(dir,'lib'));const api=join(dir,'lib/api.nyan'),sig=join(dir,'lib/types.nyan'),entry=join(dir,'main.nyan');
  writeFileSync(api,'pub bump = + 1');writeFileSync(entry,'import "./lib" as s\nmain = print (s.bump 2)');
  assert.throws(()=>compileModule(entry),/explicit type annotation/);
  writeFileSync(sig,'bump : ..s int -> ..s int');
  writeFileSync(api,'pub bump = + 1\ns = 2\npub fetchRange : -> range\nfetchRange = 0 .. s');
  // The import alias s and stack row ..s belong to different namespaces.
  writeFileSync(entry,'import "./lib" as s\nf : ..s int -> ..s int\nf = s.bump\nmain = print (f 2); print s.fetchRange');
  const p=compileModule(entry),output=[];new VM({...p,output:s=>output.push(s),warning:()=>{}}).evaluate('main');assert.deepEqual(output,['3','(0 .. 2)']);
  const uri=pathToFileURL(api).href,service=new LanguageService();
  assert.deepEqual(service.update(uri,'pub bump = + 1',1).diagnostics,[]);
  service.update(pathToFileURL(sig).href,'',2);
  assert.match(service.documents.get(uri).diagnostics[0].message,/explicit type annotation/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('native explicit rows and higher-order row annotations match the interpreter',()=>{
 const dir=mkdtempSync(join(tmpdir(),'nyanco-native-stack-rows-'));
 try{
  const p=compile(source),output=[];new VM({...p,output:s=>output.push(s),warning:()=>{}}).evaluate('main');
  const file=join(dir,'main.go');writeFileSync(file,transpileGo(p));
  const result=spawnSync('go',['run',file],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,output.join('\n')+'\n');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
