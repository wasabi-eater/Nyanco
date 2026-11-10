import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../language.mjs';
import {transpileCpp} from '../cpp-backend.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
const compiler=process.platform==='win32'?'cl':'c++';
const available=!spawnSync(compiler,[compiler==='cl'?'/h':'--version'],{stdio:'ignore',windowsHide:true}).error;
const source=`main =
    [1:2,3:4] -> original
    original with [1] = 9 -> changed
    print original; print changed; print changed.[1]
    [1.0:2.5,3.0:4.5] -> floats
    print floats.[3.0]; print floats.?[9.0]
    [byte 1:byte 2]; with [byte 1] ! + 1; print
    [1:"a",2:"b"]; with [2] = "c"; print
    ["a":1,"b":2]; with ["a"] ! + 3; print
    dict [#(1,2),#(1,3),#(2,4)]; print
    counts [1,2,1]; print
    groupBy [1,2,3] {% 2}; print
    set [1,2,1] -> before
    before; sinsert 3; sremove 1; vector; sort; print
    before; vector; sort; print
    set [1.0,2.0,1.0]; sremove 1.0; scontains 2.0; print
    set [byte 1,byte 2]; sinsert (byte 3); vector; sort; print
    [1:2] -> mut d
    d -> old
    d.[1] ! + 4; d.[2] ??<- 8
    print d; print old
    [10,20,30] -> xs
    xs.[1:] -> ys
    ys; vpush 40; print
    xs; print
    [xs: before].?[xs]; print
`;
function expected(p){const lines=[];new VM({...p,output:s=>lines.push(s)}).evaluate('main');return lines.join('\n')+'\n';}
function native(code){
 const dir=mkdtempSync(join(tmpdir(),'nyanco-native-tries-'));
 try{
  const scalarAlias=code.includes('using ScalarVector =')?'static_assert(std::is_same_v<ScalarVector<Int>,VectorStorage<Int>>);':'';
  const boxedAlias=code.includes('using Vector =')?'static_assert(std::is_same_v<Vector,VectorStorage<Value>>);':'';
  code+=`\nnamespace nyanco {template<class E> concept HasPayload=requires(E e){e.value;};static_assert(!HasPayload<SetEntry<Int>>);static_assert(sizeof(SetEntry<Int>)==sizeof(Int));static_assert(sizeof(DictEntry<Int,Int>)<sizeof(DictEntry<>));${boxedAlias}${scalarAlias}}\n`;
  const cpp=join(dir,'main.cpp'),exe=join(dir,'main.exe');writeFileSync(cpp,code);
  const args=compiler==='cl'?['/nologo','/std:c++20','/EHsc','/utf-8','/O2','/bigobj',cpp,'/Fe:'+exe]:['-std=c++20','-O2',cpp,'-o',exe];
  const built=spawnSync(compiler,args,{cwd:dir,encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(built.status,0,built.stdout+built.stderr);
  const r=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:20000});assert.equal(r.status,0,r.stderr);return r.stdout.replaceAll('\r\n','\n');
 }finally{assert.equal(dirname(dir),tmpdir());assert.ok(dir.startsWith(join(tmpdir(),'nyanco-native-tries-')));rmSync(dir,{recursive:true,force:true});}
}
test('storage aliases instantiate numeric trie entries without a set payload',()=>{
 const p=compile(source),code=transpileCpp(p);
 for(const name of ['NativeDict<Int,Int>','NativeDict<double,double>','NativeDict<Byte,Byte>','NativeDict<Int,Value>','NativeDict<Value,Int>','NativeSet<Int>','NativeSet<double>','NativeSet<Byte>'])assert.ok(code.includes(name),name);
 assert.ok(code.includes('using Vector = VectorStorage<Value>'));
 assert.ok(code.includes('using ScalarVector = VectorStorage<T>'));
});
test('numeric, mixed, and boxed container storage preserve COW, views and snapshots',{skip:!available},()=>{
 const p=compile(source),out=expected(p);
 for(const nativeHashTries of [true,false])for(const nativeVectors of [true,false])assert.equal(native(transpileCpp(p,{nativeHashTries,nativeVectors})),out);
});
test('numeric key types with custom hashes retain collision semantics',{skip:!available},()=>{
 const text=`instance hash int where
    hash n = 0
main =
    [1:2,3:4] -> d
    print d.[3]; print d.?[9]
    set [1,2,3,1]; sremove 2; vector; sort; print
`;
 const p=compile(text);const code=transpileCpp(p);
 assert.doesNotMatch(code,/make_shared<Native(?:Dict|Set)<Int/);
 assert.equal(native(code),expected(p));
});
