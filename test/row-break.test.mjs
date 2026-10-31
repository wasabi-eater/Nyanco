import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../language.mjs';
import {transpileGo} from '../go-backend.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
const run=source=>{const p=compile(source),output=[],vm=new VM({...p,output:s=>output.push(s),warning:()=>{}});return {p,output,vm,stack:vm.evaluate('main')};};
const source=`effect halt (..'s) ..'s -> !
effect relay (..'s) : ..'s -> ..'s
loop = while {True} _
stop = break
main =
 print (0; while {True} {+ 1; when ($ > 3) {break}});
 print (0; while {True} {+ 1; when ($ > 3) {cancel}});
 print (0; each [1,2,3] {+; when ($ > 2) {break}});
 print (fold [1,2,3] 0 {+; when ($ > 2) {break}});
 print (1; loop @a {* 2; when ($ > 8) {break@a}});
 print (0; each [1,2] @outer {drop; each [3,4] {drop; + 10; break@outer}});
 print (0; while {True} {+ 9; while {True} {mask break {stop}}});
 print (0; while {+ 5; break} {nop});
 0; while {dup; $ < 5} {drop; + 1; when ($ == 2) {dup; break}}; print; print;
 print (vtakeWhile [1,2] {drop; [77]; break});
 print (vmap [1,2] {drop; [42]; break});
 print (all [1,2] {drop; False; break});
 print (sortBy [1,2] {drop; [42]; break});
 print (toVector (fromYield {yield 1; [99]; break}));
 print (toVector (map [1,2] {drop; break}));
 print (join (fromYield {yield "a"; "done"; break}) ",");
 handle {1,2; halt} {halt: {drop}}; print; print;
 handle {3,4; relay} {relay: {resume}}; print; print;
 "kept", 1; loop {* 2; when ($ > 2) {break}}; print; print`;
test('break returns the carried stack and cancel retains checkpoint behavior',()=>{
 const result=run(source);assert.deepEqual(result.output,['4','3','3','3','16','10','9','5','2','2','[77]','[42]','False','[42]','[99]','[]','done','2','1','4','3','4','kept']);
 assert.doesNotMatch(result.p.types.get('main'),/break|cancel|halt|relay/);
 assert.match(result.vm.infer('break'),/break \(\.\.s\)/);
});
test('break rows must agree with ordinary exit and routed destinations',()=>{
 assert.throws(()=>compile('main = 0; while {True} {drop; "bad"; break}'),/unify/);
 assert.throws(()=>compile('main = 0; while {True} {1,2; break}'),/Infinite type|stack|unify/i);
 assert.throws(()=>compile('f : -> / {break int}\nf = nop'),/kind/);
 assert.throws(()=>compile("effect bad (..'s) : 's -> !"),/Unused|kind|parameter|row/i);
 assert.throws(()=>compile("effect bad (..'s) : [..'s] -> !"),/row.*value/i);
 assert.throws(()=>new VM().evaluate('1; break'),/Unhandled effect: break/);
});
test('explicit stack-row annotations describe reusable loops',()=>{
 const p=compile("loop : ..'s {..'s -> ..'s / {break (..'s), cancel}} -> ..'s\nloop = while {True} _\nmain = 0; loop {+ 3; break}");assert.deepEqual(new VM(p).evaluate('main'),[3]);
});
test('native stack-row effects and both loop exits agree with VM',()=>{
 const {p,output}=run(source),dir=mkdtempSync(join(tmpdir(),'nyanco-row-break-'));try{const file=join(dir,'main.go'),exe=join(dir,'main.exe');writeFileSync(file,transpileGo(p));const build=spawnSync('go',['build','-o',exe,file],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(build.status,0,build.stderr);const result=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,output.join('\n')+'\n');}finally{assert.equal(dirname(dir),tmpdir());assert.ok(dir.startsWith(join(tmpdir(),'nyanco-row-break-')));rmSync(dir,{recursive:true,force:true});}
});
