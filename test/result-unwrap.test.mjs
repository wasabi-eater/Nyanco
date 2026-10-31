import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../language.mjs';
import {transpileGo} from '../go-backend.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
const run=source=>{const p=compile(source),output=[],vm=new VM({...p,output:s=>output.push(s),warning:()=>{}});return {p,output,vm,stack:vm.evaluate('main')};};
const source=`data box 'a = Box 'a
instance unwrap (box 'a) where
  item : 'a
  unwrap (Box x) = x
  unwrapOr (Box x) fallback = x
  unwrapOrElse (Box x) fallback = x
data problem = Problem int
instance show problem where
  show (Problem n) = "problem {n}"
effect ask : -> int
get = unwrap
main =
 print (catch {3}); print (catch {exn "failed"});
 print (catch {[1].[8]}); print (catch {catch {exn "nested"}});
 print (get (Some 7)); print (get (catch {"yes"})); print (get (Box 9));
 print (catch {unwrap None}); print (catch {unwrap (Err (Problem 12))});
 print (unwrapOr None 5); print (unwrapOr (Some 3) 5);
 print (unwrapOr (Err "bad") 6); print (unwrapOr (Ok 2) 6);
 print (unwrapOrElse (Some 4) {exn "must not run"});
 print (unwrapOrElse (Ok 8) {exn "must not run"});
 print (unwrapOrElse None {print "fallback"; 10});
 print (unwrapOrElse (Err "bad") {print "fallback"; 11});
 print (catch {unwrapOrElse None {exn "fallback failed"}});
 print (handle {catch {ask}} {ask: {-> k; resume 13 k}});
 print (unwrapOr (Box 21) 0); print (unwrapOrElse (Box 22) {exn "unused"});
 print (catch {#(1,"pair")});
 100; print (catch {2}); print;
 print (0; while {True} {+ 1; catch {7; break}; drop});
 print (0; while {True} {+ 1; catch {cancel}; drop})`;

test('result catch and unwrap methods support both standard types and user instances',()=>{
 const {p,output}=run(source);assert.deepEqual(output,['(Ok 3)','(Err "failed")','(Err "Index out of bounds: 8")','(Ok (Err "nested"))','7','yes','9','(Err "unwrap: None")','(Err "problem 12")','5','3','6','2','4','8','fallback','10','fallback','11','(Err "fallback failed")','(Ok 13)','21','22','(Ok #(1 "pair"))','(Ok 2)','100','7','0']);
 assert.match(p.types.get('get'),/unwrap/);assert.doesNotMatch(p.types.get('catch'),/\{exn/);
});
test('fallbacks retain lazy effects and catch removes only exn',()=>{
 const p=compile('effect ask : -> int\nf = catch {ask}\ng = unwrapOrElse None {ask}\npure : -> int / {}\npure = unwrapOr None 1\nsafe : -> (result int string) / {}\nsafe = catch {unwrap None}');
 assert.match(p.types.get('f'),/ask/);assert.match(p.types.get('g'),/ask/);assert.doesNotMatch(p.types.get('safe'),/exn/);
 const result=run('main = 0 -> mut n; unwrapOrElse (Some 1) {n ! + 1; 0}; unwrapOrElse None {n ! + 1; 0}; n');assert.deepEqual(result.stack,[1,0,1]);
});
test('result types and class methods reject mismatches and fromSome is removed',()=>{
 assert.throws(()=>compile('main = fromSome (Some 1)'),/Unknown word: fromSome/);
 assert.throws(()=>compile('main = unwrapOr (Some 1) "bad"'),/unify|instance/i);
 assert.throws(()=>compile('main = unwrapOrElse (Some 1) {"bad"}'),/unify|instance/i);
 assert.throws(()=>compile('main = catch {1,2}'),/unify|stack/i);
 assert.throws(()=>compile('main = catch {drop}'),/underflow|unify/i);
 assert.deepEqual(run('main = catch {unwrap (Err 23)}').stack,[{kind:'adt',typeName:'result',constructor:'Err',fields:['23']}]);
});
test('native result handling and class dispatch agree with VM',()=>{
 const {p,output}=run(source),dir=mkdtempSync(join(tmpdir(),'nyanco-result-'));try{const file=join(dir,'main.go'),exe=join(dir,'main.exe');writeFileSync(file,transpileGo(p));const build=spawnSync('go',['build','-o',exe,file],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(build.status,0,build.stderr);const result=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,output.join('\n')+'\n');}finally{assert.equal(dirname(dir),tmpdir());assert.ok(dir.startsWith(join(tmpdir(),'nyanco-result-')));rmSync(dir,{recursive:true,force:true});}
});
