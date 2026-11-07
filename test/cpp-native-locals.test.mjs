import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../language.mjs';
import {compileModule} from '../modules.mjs';
import {transpileCpp} from '../cpp-backend.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {smallCases} from '../bench/atcoder-cases.mjs';
const compiler=process.platform==='win32'?'cl':'c++';
const available=!spawnSync(compiler,[compiler==='cl'?'/h':'--version'],{stdio:'ignore',windowsHide:true}).error;
const expected=program=>{const lines=[];new VM({...program,output:line=>lines.push(line),maxSteps:3000000}).evaluate('main');return lines.join('\n')+'\n';};
function native(code,check){
 const dir=mkdtempSync(join(tmpdir(),'nyanco-native-locals-'));
 try{
  const cpp=join(dir,'main.cpp'),exe=join(dir,'main.exe');writeFileSync(cpp,code);
  const flags=compiler==='cl'?['/nologo','/std:c++20','/EHsc','/utf-8','/O2','/bigobj',cpp,'/Fe:'+exe]:['-std=c++20','-O2',cpp,'-o',exe];
  const built=spawnSync(compiler,flags,{cwd:dir,encoding:'utf8',timeout:120000,windowsHide:true});assert.equal(built.status,0,built.stdout+built.stderr);
  check(input=>{const r=spawnSync(exe,[],{input:input??'',encoding:'utf8',timeout:20000,windowsHide:true});assert.equal(r.status,0,r.stderr);return {...r,stdout:r.stdout.replaceAll('\r\n','\n')};});
 }finally{assert.equal(dirname(dir),tmpdir());assert.ok(dir.startsWith(join(tmpdir(),'nyanco-native-locals-')));rmSync(dir,{recursive:true,force:true});}
}

test('synchronous captures and numeric traversals use lexical slots and native loop values',()=>{
 const p=compile('main = 0 -> mut total; each (0 .. 100) {-> i; when (i % 2 == 0) {total ! + i}}; print total');
 let ir;const code=transpileCpp(p,{onIR:x=>ir=x});
 assert.match(code,/NativeCell<Int>/);assert.match(code,/Int scalarItem\d+=/);
 assert.doesNotMatch(code,/\.read\(std::string\("(?:total|i)"|\.cell\(std::string\("total"|\.select\(/);
 const memory=ir.regions.flatMap(r=>r.instructions).map(i=>i.memory?.binding);
 assert.ok(memory.includes('native-cell'));assert.ok(memory.includes('lexical-capture'));
 const fallback=transpileCpp(p,{nativeLocals:false});assert.match(fallback,/\.(?:read|take|update)\(std::string\("total"/);
});

test('escaped captures, shadowing, borrowed cells, effects and loop cancellation match the VM',{skip:!available},()=>{
 const p=compile(`effect ask : -> int
make start = start -> mut n; {n ! + (fromInt 1); n}
makeFloat start = start -> mut n; {n ! + 1.0; n}
data tree = Leaf int | Branch tree tree deriving eq
main =
    [1,2]; dup; -> left, right
    print left; print right
    [3]; dup; -> mut a, mut b
    a ! vpush 4; print a; print b
    Some (Leaf 5); dup; -> Some node, Some (Leaf number)
    print number; print (node == Leaf 5)
    make 10 -> next
    print (call next); print (call next)
    makeFloat 2.5 -> nextFloat
    print (call nextFloat)
    [1,2] -> mut xs
    {xs} -> current
    xs -> frozen
    xs ! vpush 3
    print (call current); print frozen
    1 -> x
    (2 -> x; print x)
    print x
    0 -> mut total
    each (0 .. 6) {-> i; when (i == 4) {cancel}; total ! + i}
    borrow mut total as r {writeRef r (readRef r + 2)}
    print total
    handle {total ! + ask} {ask: {-> k; resume 7 k}}
    print total
    print (vfilter [[1],[1,2],[]] {length; > 0})
    print (vmap [[2,1],[3,0]] {sort})
    unzip (fromYield {yield #(1,2); cancel; yield #(3,4)}); print; print
    each (5 ..= 1) {print}
    0; each (0 .. 5) {+; when ($ > 3) {break}}; print
`);
 const out=expected(p);
 for(const nativeLocals of [true,false])native(transpileCpp(p,{nativeLocals,referenceCounting:'local'}),run=>assert.equal(run().stdout,out));
});

test('jagged row pushes preserve snapshots and errors with bounded copied elements',{skip:!available},()=>{
 const p=compile(`main =
    vreplicate 4 [] -> mut rows
    each (0 .. 128) {-> i; rows.[i % 4] ! vpush i}
    rows -> before
    rows.[0] ! vpush 999
    rows.[1:] -> view
    rows.[1] ! vpush 1000
    print (vmap before {length}); print (vmap rows {length}); print (vmap view {length})
    catch {rows.[-1] ! vpush 3; 0}; print
    catch {rows.[0] ! vpush (exn "item"); 0}; print
    print (vmap rows {length})
`);
 let ir;let code=transpileCpp(p,{referenceCounting:'local',onIR:x=>ir=x});
 assert.ok(ir.regions.flatMap(r=>r.instructions).some(i=>i.memory?.binding==='typed-row-update'));
 const ctor='VectorStorage(const VectorStorage& other) : values(other.scalars().begin(),other.scalars().end()) {}';
 assert.ok(code.includes(ctor));
 code=code.replace('struct VectorBase {','inline std::size_t copiedElements=0;\nstruct VectorBase {')
  .replace(ctor,ctor.replace('{}','{copiedElements+=other.size();}'))
  .replace('        return 0;','        std::cerr<<copiedElements<<"\\n";\n        return 0;');
 native(code,run=>{const r=run();assert.equal(r.stdout,expected(p));assert.ok(Number(r.stderr.trim())<256,r.stderr);});
});

test('C++ updates use ambient operands and preserve extra results through paths and loops',{skip:!available},()=>{
 const p=compile(`main =
    [] -> mut v
    [1,2,3]; each {v ! vpush}
    v ! dup
    v ! vpush 4
    print; print v
    while {True} {5; v ! vpush, when True {cancel}}
    print v
    [[1]] -> mut rows; 2; rows.[0] ! vpush; print rows
    [10] -> mut xs
    8; xs.?[9] ! swap; print
    9; xs.?[0] ! swap; print; print xs
    deque [1,2] -> mut queue
    queue -> before
    loop {queue ! qpopFront; ?? cancel -> x; print (x * 2)}
    print (toVector before)
    print (qisEmpty queue)
`);
 const out='[1, 2, 3]\n[1, 2, 3, 4]\n[1, 2, 3, 4]\n[[1, 2]]\n8\n10\n[9]\n2\n4\n[1, 2]\nTrue\n';
 assert.equal(expected(p),out);
 for(const nativeLocals of [true,false])native(transpileCpp(p,{nativeLocals,referenceCounting:'local'}),run=>assert.equal(run().stdout,out));
});

test('jagged graph uses row updates without general coroutine path machinery',{skip:!available},()=>{
 const root=fileURLToPath(new URL('..',import.meta.url)),p=compileModule(join(root,'examples/atcoder/abc481/d-jagged/main.nyan'));
 const code=transpileCpp(p,{batchIO:true,noSourcePaths:true,referenceCounting:'local'});
 assert.match(code,/cellRowPush<Int>/);assert.doesNotMatch(code,/#include <coroutine>|updatePath\(m/);
 native(code,run=>{for(const data of smallCases('abc481_d'))assert.equal(run(data.input).stdout,data.output,data.name);});
});
