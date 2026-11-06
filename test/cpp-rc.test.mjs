import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../language.mjs';
import {transpileCpp} from '../cpp-backend.mjs';
import {lowerCppRc} from '../cpp-rc.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
const compiler=process.platform==='win32'?'cl':'c++';
const available=!spawnSync(compiler,[compiler==='cl'?'/h':'--version'],{stdio:'ignore',windowsHide:true}).error;
function native(code){
 const dir=mkdtempSync(join(tmpdir(),'nyanco-rc-'));
 try{
  // Check live control blocks after globals, continuations, and views are gone.
  if(code.includes('struct RcControl {'))code=code
    .replace('struct RcControl {','struct RcControl {\ninline static std::size_t live=0;\n~RcControl(){--live;}')
    .replace(': destroy(dispose) {}',': destroy(dispose) {++live;}')
    .replace(/^int main\(\)/m,'int checkedMain()')+
    '\nint main(){auto result=checkedMain();if(nyanco::RcControl::live){std::cerr<<"Leaked RC blocks: "<<nyanco::RcControl::live;return 77;}return result;}\n';
  const cpp=join(dir,'main.cpp'),exe=join(dir,'main.exe');writeFileSync(cpp,code);
  const args=compiler==='cl'?['/nologo','/std:c++20','/EHsc','/utf-8','/O2','/bigobj',cpp,'/Fe:'+exe]:['-std=c++20','-O2',cpp,'-o',exe];
  const built=spawnSync(compiler,args,{cwd:dir,encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(built.status,0,built.stdout+built.stderr);
  const r=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:20000});assert.equal(r.status,0,r.stderr);return r.stdout.replaceAll('\r\n','\n');
 }finally{assert.equal(dirname(dir),tmpdir());assert.ok(dir.startsWith(join(tmpdir(),'nyanco-rc-')));rmSync(dir,{recursive:true,force:true});}
}

test('RC selection preserves literals, omits unused support and rejects threaded local counters',()=>{
 const p=compile('main = print "std::shared_ptr std::make_shared std::thread"');
 const code=transpileCpp(p,{referenceCounting:'local'});
 assert.ok(code.includes('std::shared_ptr std::make_shared std::thread'));
 assert.doesNotMatch(lowerCppRc('namespace nyanco { int value; }','local'),/struct RcControl/);
 const handler=compile('effect ask : -> int\nmain = handle {ask} {ask: {-> k; resume 1 k}}; print');
 assert.throws(()=>transpileCpp(handler,{effectCoroutines:false,referenceCounting:'local'}),/single-threaded/);
 assert.throws(()=>transpileCpp(p,{referenceCounting:'invalid'}),/referenceCounting/);
});

test('local counters support casts, adjusted base pointers, moves, exceptions and exact destruction',{skip:!available},()=>{
 const code=lowerCppRc(`#include <memory>
#include <any>
#include <cassert>
#include <iostream>
#include <stdexcept>
namespace nyanco {
template<class T> using Ptr=std::shared_ptr<T>;
inline int destroyed=0;
struct Left { virtual ~Left()=default; int left=3; };
struct Base { virtual ~Base()=default; int base=4; };
struct Child: Left,Base { ~Child(){++destroyed;} int child=5; };
struct Other: Base {};
struct Throws { Throws(){throw std::runtime_error("construction");} };
void check(){
 Ptr<Base> empty; assert(!empty && empty==nullptr && nullptr==empty && empty.use_count()==0);
 auto derived=std::make_shared<Child>();
 Ptr<Base> base=derived; assert(base.use_count()==2 && base->base==4);
 assert(static_cast<void*>(base.get())!=static_cast<void*>(derived.get()));
 auto down=std::dynamic_pointer_cast<Child>(base); assert(down==derived && base.use_count()==3);
 auto failure=std::dynamic_pointer_cast<Other>(std::move(base));assert(!failure && base && base.use_count()==3);
 auto moved=std::static_pointer_cast<Base>(std::move(derived)); assert(!derived && moved.use_count()==3);
 auto last=std::dynamic_pointer_cast<Child>(std::move(moved));assert(!moved && last.use_count()==3);
 down.reset();base.reset();assert(last.use_count()==1);
 std::any boxed=Ptr<Base>(last);auto copy=boxed;assert(last.use_count()==3);
 copy.reset();boxed.reset();last=last;last=std::move(last);assert(last.use_count()==1);
 last=nullptr;assert(destroyed==1);
 Ptr<Base> convert=std::make_shared<Child>();assert(convert.use_count()==1);
 Ptr<Base> assigned;assigned=convert;assert(assigned.use_count()==2);
 assigned=nullptr;convert.reset();assert(destroyed==2);
 assigned=std::make_shared<Child>();assert(assigned.use_count()==1);
 assigned.reset();assert(destroyed==3);
 try{std::make_shared<Throws>();assert(false);}catch(const std::runtime_error&){}
}
}
int main(){nyanco::check();return 0;}
`,'local');
 assert.equal(native(code),'');
});

const source=`effect ask : -> int
data box 'a = Box 'a deriving show, eq, hash
main =
    [1,2,3] -> xs
    xs.[1:] -> view
    print (vpush xs 4); print view; print xs
    [1,2] -> mut v
    v -> snapshot
    when True {print v}
    v ! vpush 3; print v; print snapshot
    [1:2,3:4] -> d
    print (d with [1] = 9); print d
    set [1,2,3] -> s
    print (sinsert s 4; vector; sort); print (vector s; sort)
    deque (0 .. 20000); count; print
    #(xs, d) with 0 = [4]; print
    {x:xs} with x = [9]; print
    set [Box xs,Box xs]; slength; print
    handle {v ! vpush ask; print v} {ask: {-> k; resume 4 k}}
    print snapshot
    handle {ask; ask; +} {ask: {-> k; resume 5 k}}; print
    handle {ask} {ask: {drop; 6}}; print
    catch {handle {ask; exn "failed"} {ask: {-> k; resume 1 k}}}; print
    zip (fromYield {yield 1; yield 2}) (map (10 .. 13) {+ 1}); take 1; vector; print
`;
test('local and shared ownership agree with the VM for COW, views, closures and coroutine cleanup',{skip:!available},()=>{
 const p=compile(source),lines=[];new VM({...p,maxSteps:3000000,output:s=>lines.push(s)}).evaluate('main');
 const expected=lines.join('\n')+'\n';
 for(const referenceCounting of ['local','shared'])assert.equal(native(transpileCpp(p,{referenceCounting})),expected);
});

test('CLI selects local for procon and allows explicit shared comparison',()=>{
 const emit=args=>{const r=spawnSync(process.execPath,['cli.mjs','--eval','[1,2]; print',...args],{encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);return r.stdout;};
 assert.match(emit(['--procon']),/struct RcControl/);
 assert.doesNotMatch(emit(['--procon','--rc','shared']),/struct RcControl/);
 const error=spawnSync(process.execPath,['cli.mjs','--eval','1','--rc','local'],{encoding:'utf8',windowsHide:true});assert.notEqual(error.status,0);assert.match(error.stderr,/requires C\+\+ output/);
});
