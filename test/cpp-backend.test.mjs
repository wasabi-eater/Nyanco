import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compile, VM} from '../language.mjs';
import {compileModule} from '../modules.mjs';
import {transpileCpp} from '../cpp-backend.mjs';
import {transpileGo} from '../go-backend.mjs';
import {verifyTypedIR} from '../typed-ir.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const compiler = [process.env.CXX, 'c++', 'g++', 'clang++', ...(process.platform === 'win32' ? ['cl'] : [])]
  .filter(Boolean)
  .find(command => !spawnSync(command, [isMsvc(command) ? '/?' : '--version'], {
    windowsHide: true, stdio: 'ignore'
  }).error);

function isMsvc(command) {
  return /^cl(?:\.exe)?$/i.test(basename(command));
}
function run(command, args, cwd, input = '') {
  return spawnSync(command, args, {cwd, input, encoding:'utf8', timeout:120000, windowsHide:true});
}

test('native emitters can omit source paths while retaining line and column', () => {
  const program = compile('main = print (1 + 2)', 'private-folder/private-source.nyan');
  for (const emit of [transpileGo, transpileCpp]) {
    assert.match(emit(program), /private-folder\/private-source\.nyan:1:/);
    const output = emit(program, {noSourcePaths:true});
    assert.doesNotMatch(output, /private-folder|private-source\.nyan/);
    assert.match(output, /"1:\d+"/);
  }
});

test('C++ lowering uses typed specializations and preserves vector ownership decisions', () => {
  let ir;
  const program = compile('main = v <- [1,2]; when True {print (length v)}; vpush v 3');
  const source = transpileCpp(program, {onIR: value => {ir = value;}});
  assert.ok(verifyTypedIR(ir));
  assert.match(source, /Results<1> fn\d+\(Machine& m\)/);
  assert.match(source, /scalarPush<Int>\([^\n]+, true\)/);
  assert.doesNotMatch(source, /evalStack|node\.exe|system\(/);
  assert.throws(() => transpileCpp(compile('main = 1 + True', 'bad.nyan', new Map(), {checkTypes:false})), /Type error/);
});

test('C++ output keeps only runtime fragments reachable from the generated program', () => {
  const source = transpileCpp(compile(`data unused = UnusedTag
unused = toVector (map [1, 2] {* 2})
main = print "EffectWorker transform"`));
  assert.match(source, /inline Values Machine::perform\(/);
  assert.match(source, /"EffectWorker transform"/);
  assert.doesNotMatch(source, /#include <thread>|class EffectWorker|class Dict|class AdtValue|UnusedTag/);
  assert.doesNotMatch(source, /inline Value transform\(|No matching pattern for unused/);

  const arithmetic = transpileCpp(compile('main = 1 + 2'));
  assert.doesNotMatch(arithmetic, /inline Values Machine::perform|std::string show\(/);
  const octets = transpileCpp(compile('main = bytes "abc"'));
  assert.match(octets, /byteStream\(v\d+\)/);
  assert.doesNotMatch(octets, /inline void walkChars|decode\(/);
  const effects = transpileCpp(compile('main = handle {print "ok"} {put: {-> text k; resume k}}'));
  assert.match(effects, /#include <coroutine>/);
  assert.doesNotMatch(effects, /#include <thread>|std::thread|std::condition_variable/);
  assert.match(effects, /class CoroutineWorker/);
  assert.match(effects, /inline Task<Values> Machine::perform\(/);
});

test('scalar arithmetic and ordinary function calls avoid boxing', () => {
  const source = transpileCpp(compile(`calc : int int -> int
calc x y =
    total <- x + y
    total * 2
mixed : int -> int string bool
mixed x = x, "hi", True
main = mixed (calc 2 3); drop; drop`));
  const arithmetic = source.match(/Int fn\d+\(Machine& m, Int arg\d+, Int arg\d+\) \{[\s\S]*?No matching pattern for calc/);
  assert.ok(arithmetic);
  assert.match(arithmetic[0], /Int v\d+ = bits\(static_cast<UInt>/);
  assert.doesNotMatch(arithmetic[0], /\bValue\b|\bas<|\.read\(|\.bind\(/);
  assert.match(source, /std::tuple<Int, Value, bool> fn\d+\(Machine& m, Int arg\d+\)/);
});

test('known bit operations lower to native scalars and checked positions', () => {
  const source = transpileCpp(compile(`change : byte int -> byte bool
change b n = clearBit (setBit (b .<<. n) n) 0; testBit b n
logical : bool bool -> bool
logical a b = xor (a .&. b) (a .|. b)
main = change (toByte 5) 1; drop; drop; logical True False`));
  const emitted = source.slice(source.lastIndexOf('\nnamespace nyanco {'));
  assert.match(emitted, /std::tuple<Byte, bool> fn\d+\(Machine& m, Byte arg\d+, Int arg\d+\)/);
  assert.match(emitted, /unsigned v\d+ = bitPosition\(m, v\d+, 8,/);
  assert.match(emitted, /Byte v\d+ = static_cast<Byte>\(static_cast<UInt>\(v\d+\) << v\d+\)/);
  assert.match(emitted, /bool v\d+ = v\d+ != v\d+;/);
  assert.doesNotMatch(emitted, /\bbitOp[<(]/);
});

test('built-in calls select their operation at C++ compile time', () => {
  const program = compile(`main =
    print (7 / 2)
    print (length (tail [1, 2, 3]))
    print (toVector (take (map [1, 2] {* 2}) 1))
    print (toVector (chunks [1, 2] 1))
    print (toVector (combinations [1, 2] 1))
    print (sort [2, 1])
    print (qlength (qpush (deque []) 1))`);
  const source = transpileCpp(program);
  const emitted = source.slice(source.lastIndexOf('\nnamespace nyanco {'));
  for (const call of ['intOp<Arithmetic::divide>', 'vectorTail(', 'vectorLength(',
    'transformTyped<Transform::map,Int,Int>', 'transformTyped<Transform::take,Int,Int>', 'partition<Partition::chunks>',
    'combinatorics<Combinatorics::combinations>', 'scalarOrder<Int>', 'queueOp<0>']) {
    assert.ok(emitted.includes(call),call);
  }
  assert.doesNotMatch(source,/\b(?:binary|unary)\(const std::string& op|\b(?:op|mode) == "/);
});

test('ADT constructors use variant alternatives and constructor patterns use their tags', () => {
  const source = transpileCpp(compile(`data tree 'a = Leaf 'a | Branch (tree 'a) (tree 'a)
sum (Leaf n) = n
sum (Branch left right) = (sum left) + (sum right)
main = sum (Branch (Leaf 2) (Leaf 3))`));
  assert.match(source, /std::variant<AdtAlternative<Constructors>\.\.\.> value/);
  assert.match(source, /using AdtFamily\d+ = AdtValue<\d+, AdtCtor\d+_\d+, AdtCtor\d+_\d+>;/);
  assert.match(source, /using AdtCtor\d+_\d+ = AdtFields<AdtCtor\d+, Int>;/);
  assert.match(source, /using AdtCtor\d+_\d+ = AdtFields<AdtCtor\d+, Adt, Adt>;/);
  assert.match(source, /makeAdt<AdtFamily\d+>\(AdtCtor\d+_\d+\{\{/);
  assert.match(source, /->tag\(\) == AdtCtor\d+::tag/);
  assert.match(source, /Int v\d+ = adtField<AdtFamily\d+,AdtCtor\d+_\d+,0>/);
  assert.doesNotMatch(source, /std::array<Value, \d+> fields|Ptr<Adt>/);
});

test('ADT construction allocates only large alternatives and typed matches read fields directly', {skip:!compiler}, () => {
  const program = compile(`data payload = Small int int | Large int int int int
data wrapped = Wrapped payload
total (Small a b) = a + b
total (Large a b c d) = a + b + c + d
nested (Wrapped (Small 1 n)) = n
nested _ = 0
readOption (Some n) = n
readOption None = 0
main =
    print (total (Small 1 2))
    print (total (Large 3 4 5 6))
    print (nested (Wrapped (Small 1 7)))
    print (nested (Wrapped (Small 2 7)))
    [9].?[0]; readOption; print
    [9].?[1]; readOption; print
    [3,4]; pop; drop; readOption; print
    print ([9].?[0] == Some 9)
    print (Some 2 < Some 3)
`);
  let source = transpileCpp(program,{referenceCounting:'local'});
  source = source.replace('inline constexpr std::size_t adtInlineBytes', 'inline unsigned allocations=0, boxedFields=0;\ninline constexpr std::size_t adtInlineBytes')
    .replace('else return makeRc<C>(std::move(constructor));','else { ++allocations; return makeRc<C>(std::move(constructor)); }')
    .replace('return ops->field(storage,index);','++boxedFields; return ops->field(storage,index);')
    .replace('        return 0;\n    } catch','        std::cerr << allocations << " " << boxedFields << "\\n";\n        return 0;\n    } catch');
  assert.match(source,/\+\+allocations/);
  assert.match(source,/\+\+boxedFields/);
  const dir = mkdtempSync(join(tmpdir(),'nyanco-cpp-adt-'));
  try {
    const file=join(dir,'main.cpp'), exe=join(dir,'main.exe');
    writeFileSync(file,source);
    const flags=isMsvc(compiler)?['/nologo','/std:c++20','/EHsc','/utf-8','/O2',file,'/Fe:'+exe]
      :['-std=c++20','-O2','-pthread',file,'-o',exe];
    const built=run(compiler,flags,dir);
    assert.equal(built.status,0,built.stdout+built.stderr);
    const result=run(exe,[],dir);
    assert.equal(result.status,0,result.stderr);
    assert.equal(result.stdout.replaceAll('\r\n','\n'),'3\n18\n7\n0\n9\n0\n4\nTrue\nTrue\n');
    assert.equal(result.stderr.trim(),'3 0');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('CLI C++20 emission builds a standalone program with modules, IO and resumable effects', {
  skip: !compiler, timeout: 120000
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'nyanco-cpp-'));
  try {
    mkdirSync(join(dir,'math'));
    writeFileSync(join(dir,'math','api.nyan'),"pub square : int -> int\nsquare x = x * x");
    const source = join(dir,'main.nyan');
    writeFileSync(source,`import "./math"
effect ask : -> int
data tree 'a = Leaf 'a | Branch (tree 'a) (tree 'a) deriving eq, hash, ord
sumTree (Leaf n) = n
sumTree (Branch left right) = (sumTree left) + (sumTree right)
mixed : int -> int string bool
mixed x = x, "hi", True
localCapture x =
    value <- x + 2
    call {value * 3}
main =
    n <- parseInt read
    print (math.square n)
    tree <- Branch (Leaf n) (Leaf 2)
    print (sumTree tree)
    print (show tree)
    print (tree == (Branch (Leaf n) (Leaf 2)))
    print (tree > (Leaf n))
    print ([tree: "branch"].[Branch (Leaf n) (Leaf 2)])
    print ([n].?[0])
    print ([n].?[1])
    mixed n; print; print; print
    print (localCapture n)
    1; while {drop; True; False} {drop; 1}; print
    print (handle {ask; ask; +} {ask: {-> k; resume n k}})
    print (toVector (take (map (1 ..= n) {* 2}) 3))
    saved <- [1,2]
    print (vpush saved 3)
    print saved
    dictionary <- [0: "left", 4294967297: "right"]
    print (dictionary with [0] = "next")
    print dictionary
    print ((1 .<<. 63) .>>. 63)
    print ((toByte 128) .>>. 7)
    print (setBit (toByte 0) 7)
    print (clearBit 15 2)
    print (testBit (toByte 128) 7)
    print (xor (True .&. False) (False .|. True))
    print (catch {1 .<<. 64})
    print (catch {(toByte 1) .>>. -1})
    print (catch {clearBit (toByte 1) 8})
    print "猫😀"
    print (std.stream.count (std.text.chars "猫😀"))
    print (std.stream.countIf (chars "猫😀猫") {== '猫'})
    [1,2,3]; std.stream.sum; print
    [1.5,2.5]; std.stream.product; print
    [toByte 2,toByte 3]; product; print
    std.stream.zipWith [1,2,3] [10,20] {-}; toVector; print
    [#(1,"a"),#(2,"b")]; std.stream.unzip; print; print
    print ((std.dict.countsBy [1,2,3,4,5] {% 2}).[1])
    print (toVector (take (bytes "猫😀") 4))
    print (vbytes "猫😀")
    print (vchars "猫😀")
    (each [1,2] below; -> x; when (x > 1) below; print x)
    print (catch below; parseInt "12")
    [1,2]; each do -> x
      print (x * 2)
    print "after do"
    print (toVector (take (std.stream.repeat "猫") 2))
    mut next <- 0
    series <- std.stream.repeatWith {next ! + 1; next}
    print (toVector (take series 0))
    print (toVector (take series 3))
    print next
    [1,2,3,4] -> [a, b, c, d]
    print [a,b,c,d]
    print (toVector (toDeque [3,1,4,2]))
    print (sort (toVector (toHeap [3,1,4,2])))
    print (sort (toDeque (toHeap [3,1,4,2])))
    toDeque [3,1,4,2]; toHeap; hpeek; print
    1, #(2, 3) -> first, #(second, third); print [first, second, third]
    [0,5] -> ([item,0] || [0,item]); print item
    #(0,6) -> (#(~,0) || #(0,~)); print
`);
    const program = compileModule(source);
    const expected = [];
    new VM({...program,input:()=> '6',output:line=>expected.push(line),warning:()=>{}}).evaluate('main');
    const cpp = join(dir,'main.cpp'), ir = join(dir,'main.ir.json'), exe = join(dir,'program.exe');
    const emitted = run(process.execPath, [join(root,'cli.mjs'),source,'--procon','--emit-ir',ir],dir);
    assert.equal(emitted.status,0,emitted.error?.message || emitted.stderr);
    assert.doesNotMatch(emitted.stdout, /main\.nyan|api\.nyan|Typed IR:/);
    const procon = run(process.execPath, [join(root,'cli.mjs'),source,'--procon'],dir);
    assert.equal(procon.status,0,procon.stderr);
    assert.equal(procon.stdout,emitted.stdout);
    writeFileSync(cpp,procon.stdout);
    assert.ok(verifyTypedIR(JSON.parse(readFileSync(ir,'utf8'))));
    const args = isMsvc(compiler)
      ? ['/nologo','/std:c++20','/EHsc','/utf-8','/O2','/Fe'+exe,cpp]
      : ['-std=c++20','-O2','-pthread',cpp,'-o',exe];
    const built = run(compiler,args,dir);
    assert.equal(built.status,0,built.error?.message || (built.stdout+built.stderr));
    const native = run(exe,[],dir,'6\n');
    assert.equal(native.status,0,native.error?.message || native.stderr);
    assert.equal(native.stdout.replaceAll('\r\n','\n'),expected.join('\n')+'\n');
  } finally {
    rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});
