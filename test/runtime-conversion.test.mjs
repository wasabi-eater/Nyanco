import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../language.mjs';
import {LanguageService} from '../lsp.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const source=`instance toInt bool where
    toInt = if {1} {0}
main =
    repeatWith {read}; vtake 5 -> s
    0..5; map do -> i
        all (0..5) {-> j; s.[i].[j] == toByte 'o'}; toInt
        all (0..5) {-> j; s.[j].[i] == toByte 'o'}; toInt
        +
    sum
    0..5; all {-> i; s.[i].[i] == toByte 'o'}; when {+ 1}
    0..5; all {-> i; s.[i].[4 - i] == toByte 'o'}; when {+ 1}
    print`;

const board=['.o..o','..oo.','.o..o','o.o..','o..oo'];
test('analyzed boolean conversions execute inside a lazy stream with ambient stack values',async()=>{
 const service=new LanguageService();
 assert.deepEqual(service.update('file:///runtime-conversion.nyan',source,1).diagnostics,[]);
 const program=compile(source);
 for(const [input,expected] of [[board,'0'],[Array(5).fill('ooooo'),'12'],[['o...o','.o.o.','..o..','.o.o.','o...o'],'2']]){
  for(const asynchronous of [false,true]){
   const rows=[...input],output=[],vm=new VM({...program,input:asynchronous?async()=>rows.shift():()=>rows.shift(),output:line=>output.push(line)});
   if(asynchronous)await vm.evaluateAsync('main');else vm.evaluate('main');
   assert.deepEqual(output,[expected]);assert.deepEqual(rows,[]);
  }
 }
});

test('custom conversion wrappers preserve an existing stack prefix',()=>{
 const prefix=source.slice(0,source.indexOf('main ='));
 for(const body of ['9, True; toInt','9, False; toInt','9, True; from','9, False; from']){
  const program=compile(prefix+'main : -> int int / {exn}\nmain = '+body);
  const stack=new VM(program).evaluate('main');
  assert.deepEqual(stack,[9,body.includes('True')?1:0]);
 }
});

test('Run CLI execution accepts the original program and standard input',()=>{
 const dir=mkdtempSync(join(tmpdir(),'nyanco-runtime-conversion-'));
 try{
  const file=join(dir,'main.nyan');writeFileSync(file,source);
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../cli.mjs',import.meta.url)),file],{input:board.join('\n')+'\n',encoding:'utf8',windowsHide:true,timeout:15000});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'0\n');
 }finally{
  assert.equal(dirname(dir),tmpdir());assert.ok(dir.startsWith(join(tmpdir(),'nyanco-runtime-conversion-')));rmSync(dir,{recursive:true,force:true});
 }
});
