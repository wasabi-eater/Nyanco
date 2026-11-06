import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../language.mjs';
import {createTypedIR,verifyTypedIR} from '../typed-ir.mjs';
import {typeIR as T} from '../types.mjs';
import {parseExpression} from '../language.mjs';
import {transpileGo} from '../go-backend.mjs';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const lower=source=>{let ir;const p=compile(source),code=transpileGo(p,{onIR:x=>{ir=x;}});assert.ok(verifyTypedIR(ir));return {ir,code,p};};
const ops=ir=>ir.regions.flatMap(r=>r.instructions);
test('typed IR can be built without a backend and snapshots types and SSA values',()=>{
 const p=compile(''),ir=createTypedIR(p.definitions),nodes=parseExpression('3; 4; +'),analysis=ir.analyze(nodes,T.EMPTY,new Map());
 ir.lower(nodes,analysis.trace);const snapshot=ir.serialize();assert.ok(verifyTypedIR(snapshot));
 assert.ok(snapshot.types.some(t=>t.kind==='atom'&&t.name==='int'));
 assert.ok(snapshot.regions[0].instructions.some(i=>i.name==='+'&&i.arguments.length===2&&i.results.length===1));
 const saved=JSON.stringify(snapshot),more=parseExpression('call'),open=ir.analyze(more,T.row(),new Map());ir.lower(more,open.trace);assert.equal(JSON.stringify(snapshot),saved);
 assert.ok(ir.serialize().types.some(t=>t.kind==='var'&&t.sort==='effect-row'));
 assert.doesNotThrow(()=>JSON.stringify(snapshot));
});

test('specializations retain distinct concrete types, effects, regions and source locations',()=>{
 const {ir}=lower('identity x = x\nmain = print (identity 1); print (identity "a"); print (call 2 {+ 1})');
 const functions=ir.regions.filter(r=>r.owner?.name==='identity');assert.equal(functions.length,2);
 assert.deepEqual(new Set(functions.map(r=>ir.types[r.owner.parameterTypes.at(-1)].name)),new Set(['int','string']));
 assert.ok(ops(ir).some(i=>i.name==='print'&&i.effects.some(e=>e.name==='io')));
 assert.ok(ir.regions.some(r=>r.owner?.kind==='quotation'));
 assert.ok(ops(ir).every(i=>i.location.line>=1));
 const bad=structuredClone(ir);bad.regions.find(r=>r.instructions.length).instructions[0].arguments=[999999];assert.throws(()=>verifyTypedIR(bad),/undefined value/);
});

test('ownership uses liveness, escapes and type checks rather than syntax alone',()=>{
 for(const name of ['vpush','hpush']){
  const empty=name==='vpush'?'[]':'heap []';
  const unique=lower(`main = ${empty}; dup; drop; ${name} 1`);
  assert.ok(ops(unique.ir).some(i=>i.name===name&&i.ownership.mode==='move'));
  const shared=lower(`main = ${empty} -> a; ${name} a 1; a`);
  assert.ok(ops(shared.ir).some(i=>i.name===name&&i.ownership.mode==='copy'));
  const captured=lower(`main = ${empty} -> a; {a} -> q; ${name} a 1; call q`);
  assert.ok(ops(captured.ir).some(i=>i.name===name&&i.ownership.mode==='copy'));
 }
 const input=lower('grow xs = vpush xs 1\nmain = grow []');
 assert.ok(ops(input.ir).some(i=>i.name==='vpush'&&i.ownership.reason==='shared-input'));
 const nested=lower('main = [] -> a; [a] -> b; vpush a 1; b');
 assert.ok(ops(nested.ir).some(i=>i.name==='vpush'&&i.ownership.mode==='copy'));
});

test('native ownership moves match copying for heap aliases, closures, globals, vector aliases and control flow',()=>{
 const source=`heap [] -> original
main =
 heap []; dup; drop; hpush 3; hpush 5; hpop; print; print
 heap [] -> h; print (hpush h 9); print h
 heap [] -> a; {a} -> saved; print (hpush a 7); print (call saved)
 heap [] -> b; [b] -> nested; print (hpush b 4); print nested
 print (hpush original 1); print original
 [] -> xs; dup 0; drop; print (vpush xs 1); print xs
 0; each [1,2,3] {+; when ($ > 2) {break}}; print
`;
 const p=compile(source),output=[];new VM({...p,output:s=>output.push(s),warning:()=>{}}).evaluate('main');
 const dir=mkdtempSync(join(tmpdir(),'nyanco-ir-'));
 try{
  for(const enabled of [true,false]){
   const go=transpileGo(p,{optimizeVectors:enabled});
   if(enabled)assert.match(go,/m\.collectionOp\("hpush"[^\n]+,true\)/);
   else assert.doesNotMatch(go,/m\.collectionOp\("hpush"[^\n]+,true\)/);
   const file=join(dir,'main.go');writeFileSync(file,go);const run=spawnSync('go',['run',file],{encoding:'utf8',timeout:120000});assert.equal(run.status,0,run.stderr);assert.equal(run.stdout.trim(),output.join('\n'));
  }
  const input=join(dir,'main.nyan'),out=join(dir,'ir.json');writeFileSync(input,'main = heap []; hpush 1');
  const cli=spawnSync(process.execPath,['cli.mjs',input,'--emit-ir',out],{encoding:'utf8'});assert.equal(cli.status,0,cli.stderr);assert.ok(verifyTypedIR(JSON.parse(readFileSync(out,'utf8'))));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
