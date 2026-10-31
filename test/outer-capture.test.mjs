import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../language.mjs';
import {transpileGo} from '../go-backend.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const run=s=>{const p=compile(s),output=[],vm=new VM({...p,output:s=>output.push(s),warning:()=>{}});return {p,output,stack:vm.evaluate('main')};};
const source=`make = 7; {__ * __}
main =
  3; {__} -> q; print (call q); print (call q);
  4; {$$} -> q2; print; print (call q2);
  5; {{___}}; call; call; print;
  10,20; {__1 + __}; call; print;
  2; {3; {__ + ___}}; call; call; print;
  print (call make);
  8; @a {"outer={__}"}; call; print;
  9; {mask cancel {__}}; call; print`;
test('outer captures bind once at the enclosing clause and survive repeated invocation',()=>{
 assert.deepEqual(run(source).output,['3','3','4','4','5','30','5','49','outer=8','9']);
 const vm=new VM();assert.equal(vm.evaluate('3; {__} -> q').length,0);assert.deepEqual(vm.evaluate('call q'),[3]);assert.deepEqual(vm.evaluate('100; drop; call q'),[3]);
 assert.deepEqual(run('main = 3; {$$ * $$}; call').stack,[3,9]);
 assert.throws(()=>compile('main = __'),/depth/);
 assert.throws(()=>compile('main = {___}'),/depth/);
 assert.throws(()=>run('main = 3; {_ + __}; call'),/underflow/i);
 assert.throws(()=>compile('main = 3; {__}, {$$}'),/Cannot mix/);
 assert.throws(()=>compile('main = 3; {__ + $$}'),/Cannot mix/);
 assert.match(compile('f = {__}').types.get('f'),/--.*\{/);
});
test('native closures capture the same outer values and do not need the source stack',()=>{
 const {p,output}=run(source),dir=mkdtempSync(join(tmpdir(),'nyanco-capture-'));
 try{const file=join(dir,'main.go'),exe=join(dir,'main.exe');writeFileSync(file,transpileGo(p));const build=spawnSync('go',['build','-o',exe,file],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(build.status,0,build.stderr);const result=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,output.join('\n')+'\n');}finally{rmSync(dir,{recursive:true,force:true});}
});
