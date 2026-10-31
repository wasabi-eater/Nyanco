import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../language.mjs';
import {transpileGo} from '../go-backend.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
const run=source=>{const p=compile(source),output=[],vm=new VM({...p,output:s=>output.push(s),warning:()=>{}});return {p,output,vm,stack:vm.evaluate('main')};};
const source=`f Some(~) = print
f None = nop
square Some(~) = _ * _
whole ~ = nop
pair #(~ Some(~)) = -
last (~ :: ~) = swap; drop
positive Some(~) | $ > 0 = print | otherwise = drop
positive None = nop
choose = case
  -> Some(~) | $ > 0 ? + 1
            | $ == 0 ? + 2
  -> Some(~) ? 0 -
  -> None ? 99
main =
 f (Some 3); f None; print (square (Some 4));
 print (pair #(10,Some 3));
 print (last [1,2,3]);
 positive (Some 4); positive (Some -1); positive None;
 print (choose (Some 4)); print (choose (Some 0)); print (choose (Some -3)); print (choose None);
 Some 8 -> Some(~); print;
 #(1,Some 2) -> #(~ Some(~)); print; print;
 print (whole "value");
 local Some(~) = + 1;; print (local (Some 9));
 print (handle {Some 5 -> Some(~); exn "error"} {exn: {-> message k; 0}});
 100; f (Some 6); print`;
test('tilde pushes matched values in source order before guards and bodies',()=>{const {output,vm}=run(source);assert.deepEqual(output,['3','16','7','3','4','5','2','3','99','8','2','1','value','10','0','6','100']);assert.match(vm.infer('square'),/mul/);});
test('tilde remains distinct from wildcard and failed matches keep the original stack',()=>{const vm=new VM(compile('f Some(~) = nop\nf None = 0'));assert.deepEqual(vm.evaluate('f None'),[0]);vm.evaluate('Some 9 -> Some(~)');assert.ok(![...vm.globals.keys()].some(n=>n.startsWith('@match')));const value={kind:'adt',typeName:'option',constructor:'None',fields:[]};const stack=[value];assert.throws(()=>vm.evaluate('-> Some(~)',stack),/pattern did not match/);assert.deepEqual(stack,[value]);assert.deepEqual(run('f Some(_) = 9\nmain = f (Some 3)').stack,[9]);assert.deepEqual(run('main = [1,2] -> [~ ~]; -').stack,[-1]);});
test('native tilde patterns preserve stack, guards and local functions',()=>{const {p,output}=run(source),dir=mkdtempSync(join(tmpdir(),'nyanco-pattern-stack-'));try{const file=join(dir,'main.go'),exe=join(dir,'main.exe');writeFileSync(file,transpileGo(p));const b=spawnSync('go',['build','-o',exe,file],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(b.status,0,b.stderr);const r=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:20000});assert.equal(r.status,0,r.stderr);assert.equal(r.stdout,output.join('\n')+'\n');}finally{assert.equal(dirname(dir),tmpdir());assert.ok(dir.startsWith(join(tmpdir(),'nyanco-pattern-stack-')));rmSync(dir,{recursive:true,force:true});}});
