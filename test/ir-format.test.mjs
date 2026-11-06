import test from 'node:test';
import assert from 'node:assert/strict';
import {compile} from '../language.mjs';
import {transpileCpp} from '../cpp-backend.mjs';
import {formatTypedIR} from '../ir-format.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const source=`identity x = x
main =
    [1, 2] -> xs
    vpush xs 3; print
    print xs
    [1, 2]; vpush 3; print
    [1, 2, 3].[0:1]; print
    7 -> n
    call {print n}
    print (identity "hello")
    print (identity 1)
`;
const cli=(args)=>spawnSync(process.execPath,[fileURLToPath(new URL('../cli.mjs',import.meta.url)),...args],{encoding:'utf8',windowsHide:true,timeout:15000});
const temporary=fn=>{
  const dir=mkdtempSync(join(tmpdir(),'nyanco-ir-format-'));
  try{return fn(dir);}finally{
    assert.equal(dirname(dir),tmpdir());
    assert.ok(dir.startsWith(join(tmpdir(),'nyanco-ir-format-')));
    rmSync(dir,{recursive:true,force:true});
  }
};

test('readable IR shows types, value flow, regions, captures, effects and ownership',()=>{
  let ir;
  transpileCpp(compile(source,'example.nyan'),{onIR:value=>{ir=value;}});
  const snapshot=JSON.stringify(ir);
  const text=formatTypedIR(ir,{backend:'C++'});
  assert.match(text,/Nyanco typed IR v1 \(C\+\+\)/);
  assert.match(text,/@r\d+ function identity/);
  assert.match(text,/specialization: int -> int/);
  assert.match(text,/specialization: string -> string/);
  assert.match(text,/%\d+: \[int\] = call vpush\(%\d+, %\d+\)/);
  assert.match(text,/\[cow: runtime-reference-count\]/);
  assert.match(text,/\[RC take-if-unshared: last-use-before-write-or-scope-end\]/);
  assert.match(text,/\[view: immutable-shared-storage\]/);
  assert.match(text,/capture n: %\d+ -> %\d+: int/);
  assert.match(text,/regions: body\[0\] = @r\d+/);
  assert.match(text,/stack: \[%\d+, %\d+\] -> \[%\d+\]/);
  assert.match(text,/\/ \{io\}/);
  assert.match(text,/@ example\.nyan:\d+:\d+/);
  assert.doesNotMatch(formatTypedIR(ir,{noSourcePaths:true}),/example\.nyan/);
  assert.equal(text,formatTypedIR(ir,{backend:'C++'}));
  assert.equal(JSON.stringify(ir),snapshot);
});

test('dump-ir emits C++ IR without executing main and accepts --eval',()=>temporary(dir=>{
  const file=join(dir,'main.nyan');
  writeFileSync(file,'main = print "SHOULD_NOT_EXECUTE"');
  const run=cli([file,'--dump-ir']);
  assert.equal(run.status,0,run.stderr);
  assert.match(run.stdout,/Nyanco typed IR v1 \(C\+\+\)/);
  assert.doesNotMatch(run.stdout,/^SHOULD_NOT_EXECUTE$/m);
  assert.equal(run.stderr,'');
  const expression=cli(['--dump-ir','--eval','3; 4; +']);
  assert.equal(expression.status,0,expression.stderr);
  assert.match(expression.stdout,/literal 3/);
  assert.match(expression.stdout,/binary \+/);
}));

test('IR text and JSON use the same C++ compilation and cannot overwrite inputs',()=>temporary(dir=>{
  const file=join(dir,'main.nyan'),cpp=join(dir,'main.cpp'),json=join(dir,'main.ir.json'),text=join(dir,'main.ir.txt');
  writeFileSync(file,source);
  const run=cli([file,'--emit-cpp',cpp,'--emit-ir',json,'--emit-ir-text',text]);
  assert.equal(run.status,0,run.stderr);
  assert.match(readFileSync(cpp,'utf8'),/int main\(/);
  const snapshot=JSON.parse(readFileSync(json,'utf8'));
  assert.equal(readFileSync(text,'utf8'),formatTypedIR(snapshot,{backend:'C++'}));
  const collision=cli([file,'--emit-ir-text',file]);
  assert.notEqual(collision.status,0);
  assert.match(collision.stderr,/Input and output paths must be different/);
  assert.equal(readFileSync(file,'utf8'),source);
  const duplicate=cli([file,'--emit-ir',text,'--emit-ir-text',text]);
  assert.notEqual(duplicate.status,0);
  assert.match(duplicate.stderr,/Input and output paths must be different/);
  const check=cli([file,'--check','--dump-ir']);
  assert.notEqual(check.status,0);
  assert.match(check.stderr,/cannot be combined/);
}));

test('procon keeps stdout valid C++ and sends path-free dump to stderr',()=>temporary(dir=>{
  const file=join(dir,'main.nyan');
  writeFileSync(file,'main = [1]; vpush 2; print');
  const run=cli([file,'--procon','--dump-ir']);
  assert.equal(run.status,0,run.stderr);
  assert.match(run.stdout,/int main\(/);
  assert.doesNotMatch(run.stdout,/Nyanco typed IR/);
  assert.match(run.stderr,/Nyanco typed IR v1 \(C\+\+\)/);
  assert.doesNotMatch(run.stderr,/main\.nyan/);
}));

test('readable IR can follow Go generation and file-only output does not execute',()=>temporary(dir=>{
  const file=join(dir,'main.nyan'),go=join(dir,'main.go'),text=join(dir,'main.ir.txt');
  writeFileSync(file,'main = print "SHOULD_NOT_EXECUTE"');
  const run=cli([file,'--emit-go',go,'--dump-ir']);
  assert.equal(run.status,0,run.stderr);
  assert.match(run.stdout,/Nyanco typed IR v1 \(Go\)/);
  assert.match(run.stderr,/Go source:/);
  assert.match(readFileSync(go,'utf8'),/package main/);
  const saved=cli([file,'--emit-ir-text',text]);
  assert.equal(saved.status,0,saved.stderr);
  assert.match(readFileSync(text,'utf8'),/Nyanco typed IR v1 \(C\+\+\)/);
  assert.doesNotMatch(saved.stdout,/SHOULD_NOT_EXECUTE/);
}));
