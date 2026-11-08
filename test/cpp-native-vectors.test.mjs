import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../language.mjs';
import {transpileCpp} from '../cpp-backend.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';

const compiler=process.platform==='win32'?'cl':'c++';
const available=!spawnSync(compiler,[compiler==='cl'?'/h':'--version'],{stdio:'ignore',windowsHide:true}).error;
function execute(code){
  const dir=mkdtempSync(join(tmpdir(),'nyanco-scalar-vectors-'));
  try{
    const file=join(dir,'main.cpp'),exe=join(dir,process.platform==='win32'?'main.exe':'main');
    writeFileSync(file,code);
    const args=compiler==='cl'?['/nologo','/std:c++20','/EHsc','/utf-8','/O2',file,'/Fe:'+exe]:['-std=c++20','-O2','-pthread',file,'-o',exe];
    const built=spawnSync(compiler,args,{cwd:dir,encoding:'utf8',timeout:120000,windowsHide:true});
    assert.equal(built.status,0,built.stdout+built.stderr);
    const run=spawnSync(exe,[],{encoding:'utf8',timeout:15000,windowsHide:true});
    assert.equal(run.status,0,run.stdout+run.stderr);
    return {stdout:run.stdout.replaceAll('\r\n','\n'),stderr:run.stderr};
  }finally{
    assert.equal(dirname(dir),tmpdir());assert.ok(dir.startsWith(join(tmpdir(),'nyanco-scalar-vectors-')));
    rmSync(dir,{recursive:true,force:true});
  }
}

test('concrete numeric vectors instantiate templates and typed scalar operations',()=>{
  const code=transpileCpp(compile(`main =
    [1,2]; vpush 3; print
    [1.0,2.0].[0]; print
    [toByte 1,toByte 2]; setAt 0 (toByte 3); print
    [3,1,2]; sort; partitionPoint {< 2}; print
`));
  assert.match(code,/scalarVector<Int>\(std::vector<Int>/);
  assert.match(code,/scalarPush<Int>/);
  assert.match(code,/scalarAt<double>/);
  assert.match(code,/scalarSetAt<Byte>/);
  assert.match(code,/scalarOrder<Int>/);
  assert.match(code,/auto scalarData\d+ = scalarData<Int>/);
});

test('index, sort, search and slice hot paths never box vector elements',{skip:!available},()=>{
  let code=transpileCpp(compile(`main =
    [3,1,2] -> mut xs
    xs ! sort
    print (length xs)
    print xs.[1]
    partitionPoint xs {<= 2}; print
    xs.[1:] -> view
    print view.[0]; print (length view)
`));
  code=code.replace('struct VectorBase {','inline unsigned scalarBoxings = 0;\nstruct VectorBase {')
    .replace('boxing.boxed.reserve(size());','++scalarBoxings; boxing.boxed.reserve(size());')
    .replace('        return 0;','        std::cerr << scalarBoxings << "\\n";\n        return 0;');
  const run=execute(code);
  assert.equal(run.stdout,'3\n2\n2\n2\n2\n');assert.equal(run.stderr.trim(),'0');
});

test('native and boxed vectors preserve sharing, views, numeric types and opaque boundaries',{skip:!available},()=>{
  const source=`data box = Box [int] deriving eq, hash, show
identity x = x
main =
    [1,2,3] -> mut xs
    xs -> old
    print xs
    xs ! vpush 4
    print old; print xs
    xs.[1:2] -> view
    view; vpush 9; print; print view
    xs ! setAt 1 8
    print xs; print view
    print xs.?[99]; print xs.?[0]
    print xs.[-1]
    print (catch {xs.[-5]})
    print (identity [1.5,3.5]); print [1.5,3.5].[1]
    [toByte 255,toByte 0]; sort; vpush (toByte 2); print
    print [True,False]; print ['a','b']
    print (Box old); print ((Box old) == (Box [1,2,3]))
    print (hash (Box old))
    handle {old; each {print}} {put:{-> text k; resume k}}
    print (tail [1,2,3]).[0]
    print (toVector (map [1,2,3] {+ 1})).[1]
    print ([1,2] ++ [3,4]); print ([1,2] ++ [1,2])
`;
  const program=compile(source),expected=[];
  new VM({...program,output:line=>expected.push(line)}).evaluate('main');
  for(const optimizeVectors of [true,false])assert.equal(execute(transpileCpp(program,{optimizeVectors})).stdout,expected.join('\n')+'\n');
});
