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

test('native collectors, numeric parsers and scalar vector operations avoid element boxing',{skip:!available},()=>{
  const program=compile(`main =
    pairs <- vzip [1,2,3] [10,20]
    pairs; map {_.0 + _.1}; sum; print
    unzip pairs -> left right
    left; map {+ 2}; sum; print
    print (sum right)
    bytes "Aé"; vector -> raw
    fromBytes <- vbytes "Aé"
    print (raw == fromBytes)
    print (raw < vbytes "B")
    print ((hash raw) == (hash fromBytes))
    print ([0.0] == [-0.0])
    print ((hash [0.0]) == (hash [-0.0]))
    print (parseInt " +7 " + 1)
    print (parseFloat " 1.5 " + 0.5)
    print (catch {parseInt "invalid"})
`);
  const output=[];
  new VM({...program,output:line=>output.push(line)}).evaluate('main');
  let code=transpileCpp(program);
  for(const spelling of ['zipNativeVectors<Int,Int>','unzipNativeVector<Int,Int>','mapNativePairs<Int,Int,Int>','transformTyped<Transform::map,Int,Int>',
    'equalScalarVectors<double>','compareScalarVectors<Byte>','hashScalarVector<double>'])assert.ok(code.includes(spelling),spelling);
  assert.match(code,/Int v\d+ = (?:\(co_await )?parseNumberText<Int, true>/);
  assert.match(code,/double v\d+ = (?:\(co_await )?parseNumberText<double, true>/);
  code=code.replace('struct VectorBase {','inline unsigned boxings = 0;\nstruct VectorBase {')
    .replace('boxing.boxed.reserve(size());','++boxings; boxing.boxed.reserve(size());')
    .replace('Values values;values.reserve(rows.size());','++boxings; Values values;values.reserve(rows.size());')
    .replace('return nyanco::runTask(coroutineMain());','int status=nyanco::runTask(coroutineMain()); std::cerr << nyanco::boxings << "\\n"; return status;');
  assert.match(code,/nyanco::boxings/);
  const actual=execute(code);
  assert.equal(actual.stdout,output.join('\n')+'\n');
  assert.equal(actual.stderr.trim(),'0');
  assert.equal(execute(transpileCpp(program,{nativeLocals:false,optimizeVectors:false})).stdout,actual.stdout);
});

test('native pair vectors and grouped counts preserve fields, snapshots and effects',{skip:!available},()=>{
  const program=compile(`effect classify : int -> int
streamWithOffset a = map [1,2] {+ a}
twice = * 2
replacement = if True {exn "replacement"} {1}
main =
    xs <- [byte 0, byte 255, byte 128, byte 1]
    print (sort xs)
    print (xs.[1:] with [0] = byte 254)
    print xs
    print ([byte 0] ++ [byte 255, byte 128])
    print (catch {[1] with [99] = replacement})
    rows <- [vbytes "abcdefghz", [byte 0, byte 0], vbytes "abcdefgh", [], [byte 0], vbytes "abcdefgha", [byte 255]]
    print (sort (map rows {}))
    print (vector (map (chunkBy [1,1,2,1,1,1] {}) {count}))
    print (vector (map (chunkBy [1,2,-1,3] {>= 0}) {count}))
    print (orderedCounts [3,1,3,3,2,1])
    orderedCounts [3,1,3,3,2,1]; map {twice _.1}; vector; print
    orderedCounts [3,1,3,3,2,1]; map {.1; print $} -> later
    print "created"
    print (vector later)
    orderedCounts [3,1,3,3,2,1]; dup; map {_.1}; vector; print; print
    orderedCounts [3,1,3,3,2,1]; map {_.0}; vector; print
    pairs <- [#(5, 10), #(7, 20)]
    pairs; map {_.0 + _.1}; vector; print
    pairs; map {-> #(a, b); a + b}; vector; print
    pairs; map {}; vector; print
    print ((pairs with [0] = #(8, 12)).[0]); print pairs.[0]
    orderedCounts [[1],[1],[2,3]]; map {(length _.0) + _.1}; vector; print
    groups <- chunkBy [1,1,2] {}
    print (vector (map groups {count}))
    print (vector (map groups {vector}))
    offsets <- streamWithOffset 10
    print (vector offsets); print (vector offsets)
    print (handle {chunkBy [1,1,2] {classify}; map {vector}; vector} {classify: {-> value k; resume value k}})
`);
  const expected=[];
  new VM({...program,output:line=>expected.push(line)}).evaluate('main');
  const code=transpileCpp(program);
  assert.match(code,/sortScalarVectors<Byte,Ptr<VectorBase>>/);
  assert.match(code,/partition<Partition::chunkBy,true,/);
  assert.match(code,/groupOrderedCounts<Int>/);
  assert.match(code,/nativePairVector<Int,Int>\(std::vector<std::tuple<Int,Int>>/);
  assert.match(code,/mapNativePairs<Int,Int,Int>/);
  assert.match(code,/mapNativePairs<Ptr<VectorBase>,Int,Int>/);
  assert.match(code,/scalarSetAt<Byte>/);
  assert.match(code,/class CoroutineWorker/);
  assert.equal(execute(code).stdout,expected.join('\n')+'\n');
  assert.equal(execute(transpileCpp(program,{optimizeVectors:false,nativeLocals:false})).stdout,expected.join('\n')+'\n');
});

test('ordered counts, vector collectors and tuple consumers avoid materializing boxes',{skip:!available},()=>{
  const scalar=transpileCpp(compile('main = print (orderedCounts [3,1,3])'));
  assert.doesNotMatch(scalar,/\b(?:Value|Values)\b|std::any/);
  const program=compile(`main =
    print (orderedCounts (0 .. 0))
    print (orderedCounts [3,1,3,2,1,3])
    print (orderedCounts [2.5,1.5,2.5])
    print (orderedCounts (split "z y z" " "))
    rows <- vmap (0 .. 4) {[_ % 2]}
    print (orderedCounts rows)
    rows; each {print _.[0]}
    print rows.[-1]
    print rows.?[3]
    pairs <- vector (zip (0 .. 2) [10,20])
    pairs; map {_.0 + _.1}; vector; print
    unzip pairs -> left right
    print left; print right
`);
  const expected=[];
  new VM({...program,output:line=>expected.push(line)}).evaluate('main');
  const code=transpileCpp(program)
    .replace('struct VectorBase {','inline unsigned boxings = 0;\nstruct VectorBase {')
    .replace('boxing.boxed.reserve(size());','++boxings; boxing.boxed.reserve(size());')
    .replace('Values values;values.reserve(rows.size());','++boxings; Values values;values.reserve(rows.size());')
    .replace('boxed = std::apply','++boxings; boxed = std::apply');
  assert.match(code,/Ptr<VectorBase> v\d+ = groupOrderedCounts<Int>\(v\d+,\[\]\(const Int& a,const Int& b\)/);
  assert.match(code,/groupOrderedCounts<std::string>/);
  assert.match(code,/Ptr<VectorBase> v\d+ = groupOrderedCounts<Ptr<VectorBase>>\(v\d+,\[\]\(const Ptr<VectorBase>& a,const Ptr<VectorBase>& b\)/);
  assert.match(code,/TypedConsumption<Ptr<VectorBase>>>? sortScalarVectors/);
  assert.match(code,/unzipNativeVector<Int,Int>/);
  const instrumented=code.replace(/(int main\(\) \{)/,
    '$1\n    struct Report { ~Report() { std::cerr << nyanco::boxings << "\\n"; } } report;');
  assert.notEqual(code,instrumented);
  const actual=execute(instrumented);
  assert.equal(actual.stdout,expected.join('\n')+'\n');
  assert.equal(actual.stderr.trim(),'0');
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
