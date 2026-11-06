import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../language.mjs';
import {transpileCpp} from '../cpp-backend.mjs';
import {verifyTypedIR} from '../typed-ir.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';

const compiler=process.platform==='win32'?'cl':'c++';
const available=!spawnSync(compiler,[compiler==='cl'?'/h':'--version'],{stdio:'ignore',windowsHide:true}).error;
function native(code,fn){
  const dir=mkdtempSync(join(tmpdir(),'nyanco-cpp-cow-'));
  try{
    const file=join(dir,'main.cpp'),exe=join(dir,process.platform==='win32'?'main.exe':'main');
    writeFileSync(file,code);
    const args=compiler==='cl'?['/nologo','/std:c++20','/EHsc','/utf-8',file,'/Fe:'+exe]:['-std=c++20','-pthread',file,'-o',exe];
    const build=spawnSync(compiler,args,{cwd:dir,encoding:'utf8',windowsHide:true,timeout:120000});
    assert.equal(build.status,0,build.stdout+build.stderr);
    const run=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:15000});
    assert.equal(run.status,0,run.stdout+run.stderr);
    return fn(run);
  }finally{
    assert.equal(dirname(dir),tmpdir());assert.ok(dir.startsWith(join(tmpdir(),'nyanco-cpp-cow-')));
    rmSync(dir,{recursive:true,force:true});
  }
}

test('C++ ownership uses runtime RC checks and transfers last local generations',()=>{
  let ir;
  const code=transpileCpp(compile('main = [] -> mut v; v ! vpush 1; v ! vpush 2; print v'),{onIR:value=>ir=value});
  assert.ok(verifyTypedIR(ir));
  assert.match(code,/base\.use_count\(\) == 1/);
  assert.match(code,/scalarPush<Int>\(std::move\(v\d+\), v\d+, true\)/);
  assert.match(code,/\.take\(std::string\("v", 1\)\)/);
  assert.match(code,/\.update\([^\n]+std::move\(v\d+\)\)/);
  assert.ok(ir.regions.flatMap(r=>r.instructions).some(i=>i.ownership?.mode==='cow'));
  assert.ok(ir.regions.flatMap(r=>r.instructions).some(i=>i.memory?.binding==='take-if-unshared'));
});

test('native COW, mutable aliases, closures, guards, loops and views agree with copying and VM',{skip:!available},()=>{
  const source=`data holder = Holder [int]
grow xs = vpush xs 9
choose False = [99]
choose True = [88]
guarded | length; > 10 = [99]
        | otherwise = vpush 7
main =
    [] -> mut v
    v ! vpush 1; v ! vpush 2; print v
    v -> old
    v ! vpush 3; v ! vpush 4; print old; print v
    [v] -> nested
    v ! vpush 5; print nested; print v
    (Holder v) -> wrapped
    v ! vpush 6; print wrapped; print v
    {v} -> current
    v ! vpush 7; print (call current)
    old -> snapshot
    {snapshot} -> saved
    v ! vpush 8; print (call saved); print v
    print (grow [1, 2])
    [1, 2]; when True {vpush 3}; print
    []; while {length $ < 3} {vpush 1}; print
    [1, 2]; _ ++ _; print
    [1, 2]; _, vpush _ 3; print; print
    [1, 2]; {__} -> outerCapture; print (call outerCapture)
    [] -> mut accumulated
    each [1, 2, 3] {-> i; accumulated ! vpush i}
    print accumulated
    v.[1:3] -> view
    v ! vpush 10; print view; print v
    view; vpush 11; print; print view
    {x: [1, 2], y: 3} -> mut record
    record -> priorRecord
    record.x ! vpush 4
    print priorRecord; print record
    #(1, [2, 3]) -> mut pair
    pair.1 ! vpush 4
    print pair
    [[1, 2], [3, 4]] -> mut matrix
    matrix -> priorMatrix
    matrix.[0] ! vpush 9
    print priorMatrix; print matrix
    [4, 5] -> mut x
    [6, 7] -> mut y
    x, y ! _1, _
    print x; print y
    print (choose False); print (choose True)
    print (guarded [1, 2])
    [1] -> mut short
    print (length short)
    False && (short <<- [2]; True); drop
    print short
    [1, 2] -> outer
    print (outer; vpush 3)
    (outer <- [4, 5]; print outer)
    print outer
    heap [] -> mut h
    h ! hpush 4; h -> before
    h ! hpush 9; print (toVector before); print (toVector h)
    deque [] -> mut q
    q ! qpush 1; q -> first
    q ! qpushFront 2; print (toVector first); print (toVector q)
    [] -> mut transactional
    print (catch {transactional ! vpush 1, exn "failed"; 0})
    print transactional
`;
  const program=compile(source),output=[];
  new VM({...program,output:line=>output.push(line),warning:()=>{}}).evaluate('main');
  for(const optimizeVectors of [true,false])native(transpileCpp(program,{optimizeVectors}),run=>{
    assert.equal(run.stdout.replaceAll('\r\n','\n').trimEnd(),output.join('\n'));
  });
});

test('native vector copy counts drop to zero on unique update chains and resume after sharing',{skip:!available},()=>{
  const source=`grow xs = vpush xs 5
main =
    [] -> mut v
    v ! vpush 1; v ! vpush 2; v ! vpush 3
    print (grow v)
`;
  const copyConstructor='VectorStorage(const VectorStorage& other) : values(other.scalars().begin(),other.scalars().end()) {}';
  function copies(source,optimizeVectors){
    let code=transpileCpp(compile(source),{optimizeVectors});
    assert.ok(code.includes(copyConstructor));
    code=code.replace('struct VectorBase {','inline unsigned long vectorCopies = 0;\nstruct VectorBase {')
      .replace(copyConstructor,copyConstructor.replace('{}','{ ++vectorCopies; }'))
      .replace('        return 0;','        std::cerr << vectorCopies << "\\n";\n        return 0;');
    return native(code,run=>Number(run.stderr.trim()));
  }
  assert.equal(copies(source,true),0);
  assert.equal(copies(source,false),4);
  const sharing='main = [] -> mut v; v -> old; v ! vpush 1; v ! vpush 2; print old; print v';
  assert.equal(copies(sharing,true),1);
  const dead='main = [] -> mut v; v -> old; print old; v ! vpush 1; print v';
  assert.equal(copies(dead,true),0);
  const paths='main = {x: [1, 2]} -> mut r; r.x ! vpush 3; r.x ! vpush 4; print r';
  assert.equal(copies(paths,true),0);
  assert.equal(copies('main = [1, 2]; vpush _ 3; print',true),0);
});
