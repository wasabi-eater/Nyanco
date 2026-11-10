import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../language.mjs';
import {compileModule,standardTokens} from '../modules.mjs';
import {transpileCpp} from '../cpp-backend.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
const compiler=process.platform==='win32'?'cl':'c++';
const available=!spawnSync(compiler,[compiler==='cl'?'/h':'--version'],{stdio:'ignore',windowsHide:true}).error;
const source=`effect ask : -> int
effect tell : int ->
effect forkPair : int -> int int
effect fail : string -> !
data bag 'a = Bag ['a]
instance streem (bag 'a) where
    item : 'a
    each (Bag xs) f = each xs f
plusOne = ask; + 1
recurse n = if (n == 0) {ask} {recurse (n - 1); + 1}
main =
    handle {plusOne; * 2} {ask: {-> k; resume 10 k; + 100}}; print
    handle {recurse 100; + 1} {ask: {-> k; resume 2 k}}; print
    handle {3; forkPair; +} {forkPair: {-> n k; resume n (n + 1) k}}; print
    handle {99; ask; +} {ask: {drop; 7}}; print
    handle {handle {ask; tell; 3} {tell: {-> n k; resume k}}} {ask: {-> k; resume 8 k}}; print
    handle @outer {handle @inner {ask@outer + ask@inner} {ask: {-> k; resume 20 k}}} {ask: {-> k; resume 10 k}}; print
    handle {handle {mask ask {ask}} {ask: {-> k; resume 20 k}}} {ask: {-> k; resume 10 k}}; print
    handle {ask; ask; +} {ask: {-> k; resume 4 k}}; print
    handle {fail "abort"; print "unreachable"} {fail: {-> message k; 12}}; print
    catch {handle {ask; exn "after resume"} {ask: {-> k; resume 1 k}}}; print
    handle {0; each (0 .. 10) {drop; ask; +}} {ask: {-> k; resume 1 k}}; print
    [1,2,3] -> mut xs
    xs -> snapshot
    handle {xs.[1] ! + ask} {ask: {-> k; resume 5 k}}
    print xs; print snapshot
    handle {zip (fromYield {yield ask; yield 2}) (map (10 .. 14) {+ ask}); take 1; vector} {ask: {-> k; resume 3 k}}; print
    handle {zip (Bag [1,2]) (map (10 .. 12) {+ ask}); vector} {ask: {-> k; resume 3 k}}; print
    print (vector (zip (iterate {0} {+ 1}) (iterate {10} {+ 1}); take 3))
    0 -> mut seen
    zip (fromYield {seen ! + 1; yield 1; seen ! + 100; yield 2}) [3,4]; take 1; vector; print
    print seen
    catch {zip (fromYield {yield 1; exn "producer"}) (0 .. 3); vector}; print
    each (zip (0 .. 10) (10 .. 20)) @out {drop; cancel@out}
    print "class EffectWorker \\{ std::function<void(Value)> Task<int> main()"
`;
function vm(program){const out=[];new VM({...program,output:s=>out.push(s),maxDepth:2000}).evaluate('main');return out.join('\n')+'\n';}
function native(code,input='',frameLimit=0){
 const dir=mkdtempSync(join(tmpdir(),'nyanco-coroutines-'));
 try{
  // Count allocated coroutine frames, including abandonment and error paths.
  // The pool may cache storage; every constructed frame must still be released.
  const entry='return nyanco::runTask(coroutineMain());';
  if(frameLimit)assert.ok(code.includes(entry));
  const peakCheck=frameLimit
   ? `if(nyanco::TaskPromiseBase::peakFrames>${frameLimit}){std::cerr<<"Too many coroutine frames: "<<nyanco::TaskPromiseBase::peakFrames;return 78;}` : '';
  code=code.replace('struct TaskPromiseBase {','struct TaskPromiseBase {\ninline static std::size_t liveFrames=0, peakFrames=0;')
    .replace('return frames().allocate(size);','auto memory=frames().allocate(size);if(++liveFrames>peakFrames)peakFrames=liveFrames;return memory;')
    .replace('frames().deallocate(memory,size);','--liveFrames;frames().deallocate(memory,size);')
    .replace(entry,`auto status=nyanco::runTask(coroutineMain());if(nyanco::TaskPromiseBase::liveFrames){std::cerr<<"Leaked coroutine frames";return 77;}${peakCheck}return status;`);
  const file=join(dir,'main.cpp'),exe=join(dir,'main.exe');writeFileSync(file,code);
  const args=compiler==='cl'?['/nologo','/std:c++20','/EHsc','/utf-8','/O2','/bigobj',file,'/Fe:'+exe]:['-std=c++20','-O2',file,'-o',exe];
  const build=spawnSync(compiler,args,{cwd:dir,encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(build.status,0,build.stdout+build.stderr);
  return spawnSync(exe,[],{input,encoding:'utf8',windowsHide:true,timeout:20000});
 }finally{assert.equal(dirname(dir),tmpdir());assert.ok(dir.startsWith(join(tmpdir(),'nyanco-coroutines-')));rmSync(dir,{recursive:true,force:true});}
}
test('resumable boundaries use C++20 tasks, while synchronous programs retain direct calls',()=>{
 const p=compile(source),code=transpileCpp(p);
 assert.match(code,/#include <coroutine>/);assert.match(code,/co_await/);assert.match(code,/class CoroutineWorker/);
 assert.doesNotMatch(code,/#include <thread>|std::thread|std::condition_variable|std::mutex/);
 assert.ok(transpileCpp(p,{effectCoroutines:false}).includes('class EffectWorker'));
 const pure=transpileCpp(compile('square n = n * n\nmain = square 3; print'));
 assert.doesNotMatch(pure,/#include <coroutine>|co_await|class Task/);
});
test('typed stream stages keep heterogeneous zip items and intercepted yields out of the boxed stream ABI',{skip:!available},()=>{
 const program=compile(`data bag 'a = Bag ['a]
instance streem (bag 'a) where
    item : 'a
    each (Bag xs) f = each xs f
main =
    source <- fromYield {
        handle {yield 3} {yield: {-> x k; yield x; resume k}}
        yield 1; yield 1
    }
    zip source (Bag ["z","a","b"]); sortBy {_.1}; print
    chunkBy source {}; map {count}; vector; print
    windows source 2; vector; print
    combinations source 2; vector; print
    values [0: 2, 1: 1]; sort; print
    [0: 2, 1: 1]; map {_.1}; sort; print
`);
 const expected=vm(program);
 for(const effectCoroutines of [true,false]){
  const code=transpileCpp(program,{effectCoroutines});
  for(const spelling of ['fromYield<Int>','performTypedYield<Int>','zip<Int,std::string>','nativeVisitorQuote<std::string>','consume<Consume::sortBy,Ptr<Tuple>,std::string>','partition<Partition::chunkBy,false,Int,Int>','walkTypedDict<Int,Int>'])
   assert.ok(code.includes(spelling),spelling);
  assert.doesNotMatch(code,/\bboxedStreamWalk\b/);
  const result=native(code);
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout.replaceAll('\r\n','\n'),expected);
 }
});
test('the standard worklist handlers preserve priority and FIFO ordering in C++',{skip:!available},()=>{
 const program=compileModule(new URL('../examples/worklist/main.nyan',import.meta.url).href);
 const result=native(transpileCpp(program,{batchIO:true,referenceCounting:'local'}));
 assert.equal(result.status,0,result.stderr);
 assert.equal(result.stdout.replaceAll('\r\n','\n'),'(Some 7)\n7\n3\n(Some 3)\n3\n7\n');
});
test('tail resumption releases frames before the next operation',{skip:!available},()=>{
 const program=compile(`effect tick : -> int
handlers n = {tick: {-> k; case
    | n > 0 ? if (n > 1) {resume n k} {resume 1 k}
    otherwise resume 0 k
    end}}
main =
    handle {0; each (0 .. 10000) {drop; tick; +}; 7} (handlers 2); print; print
    handle {tick; tick; +} {tick: {-> k; resume 10 k; + 1}}; print
`);
 const code=transpileCpp(program,{referenceCounting:'local'}), result=native(code,'',64);
 assert.match(code,/if \(resumeTail\(/);
 assert.equal(result.status,0,result.stderr);
 assert.equal(result.stdout.replaceAll('\r\n','\n'),'7\n20000\n22\n');
});
test('native worklists preserve snapshots and respect labels, mask and user handlers',{skip:!available},()=>{
 const previous=new Map();previous.moduleTokens=standardTokens;
 const program=compile(`main =
    heap [1] -> h
    (withHeap h @outer below
        std.worklist.push 3
        withDeque (deque [10]) {
            std.worklist.push 20
            std.worklist.push@outer 7
            mask std.worklist.push {std.worklist.push 5}
            handle {std.worklist.pop; print} {std.worklist.pop: {-> k; resume (Some 99) k}}
            print std.worklist.peek
            print std.worklist.peek
            print std.worklist.pop
            print std.worklist.pop
            print std.worklist.pop
        }
        print std.worklist.pop
        print std.worklist.pop
        print std.worklist.peek
        11, 12
    )
    print; print
    print (hpeek h)
`,'<worklist-routing>',previous);
 const expected='(Some 99)\n(Some 10)\n(Some 10)\n(Some 10)\n(Some 20)\nNone\n(Some 7)\n(Some 5)\n(Some 3)\n12\n11\n(Some 1)\n';
 assert.equal(vm(program),expected);
 const code=transpileCpp(program,{referenceCounting:'local'});
 assert.match(code,/NativeHeapWorklist worklist/);
 assert.match(code,/NativeDequeWorklist worklist/);
 const result=native(code);
 assert.equal(result.status,0,result.stderr);
 assert.equal(result.stdout.replaceAll('\r\n','\n'),expected);
});
test('coroutine handlers, labels, aborts, mutation and lazy cursors match VM and the baseline',{skip:!available},()=>{
 const p=compile(source),expected=vm(p);
 for(const options of [{effectCoroutines:true},{effectCoroutines:false},{referenceCounting:'local'}]){const r=native(transpileCpp(p,options));assert.equal(r.status,0,r.stderr);assert.equal(r.stdout.replaceAll('\r\n','\n'),expected);}
});
test('continuations stay one-shot and expire when handlers return',{skip:!available},()=>{
 for(const [text,error] of [
  ['effect ask : -> int\nmain = handle {ask} {ask: {-> k; resume 1 k; drop; resume 2 k}}','already resumed'],
  ['effect ask : -> int\nmain = None -> mut saved; handle {ask} {ask: {-> k; saved <<- Some k; 5}}; drop; unwrap saved -> k; resume 1 k','expired']
 ])for(const referenceCounting of ['shared','local']){const r=native(transpileCpp(compile(text),{referenceCounting}));assert.notEqual(r.status,0);assert.match(r.stderr,new RegExp(error));}
 assert.throws(()=>compile('effect fail : -> !\nmain = handle {fail} {fail: {-> k; resume k}}'),/non-returning/);
});
test('unconsumed coroutine streams need no coroutine entry point and preserve IO',{skip:!available},()=>{
 const dormant=native(transpileCpp(compile('main = zip (0 .. 3) (4 .. 7)')));assert.equal(dormant.status,0,dormant.stderr);assert.equal(dormant.stdout,'');
 const p=compile('main = handle {read; print} {put: {-> text k; put text; resume k}}');
 const r=native(transpileCpp(p,{batchIO:true}),'hello\n');assert.equal(r.status,0,r.stderr);assert.equal(r.stdout.replaceAll('\r\n','\n'),'hello\n');
});

test('pure hash and comparison callbacks may handle effects internally',{skip:!available},()=>{
 const text=`effect ask : -> int
data key = Key int deriving eq, show
instance hash key where
    hash (Key n) = handle {ask; drop; n} {ask: {-> k; resume 0 k}}
instance ord key where
    (<) (Key a) (Key b) = handle {ask; drop; a < b} {ask: {-> k; resume 0 k}}
    (<=) (Key a) (Key b) = a <= b
    (>) (Key a) (Key b) = a > b
    (>=) (Key a) (Key b) = a >= b
main =
    [Key 1: "ok"].[Key 1]; print
    sort [Key 3,Key 1,Key 2]; print
    set [Key 1,Key 1,Key 2]; slength; print
    withHeap (heap [Key 3,Key 1]) {std.worklist.push (Key 5); print std.worklist.pop}
`;
 const previous=new Map();previous.moduleTokens=standardTokens;
 const p=compile(text,'<comparison-effects>',previous),r=native(transpileCpp(p));assert.equal(r.status,0,r.stderr);assert.equal(r.stdout.replaceAll('\r\n','\n'),vm(p));
});
