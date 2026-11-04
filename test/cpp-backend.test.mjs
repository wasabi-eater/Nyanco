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

test('C++ lowering uses typed specializations and preserves vector ownership decisions', () => {
  let ir;
  const program = compile('main = v <- [1,2]; when True {print (length v)}; vpush v 3');
  const source = transpileCpp(program, {onIR: value => {ir = value;}});
  assert.ok(verifyTypedIR(ir));
  assert.match(source, /Results<1> fn\d+\(Machine& m\)/);
  assert.match(source, /append<false>\([^\n]+, true\)/);
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
  const effects = transpileCpp(compile('main = handle {print "ok"} {put: {-> text k; resume k}}'));
  assert.match(effects, /#include <thread>/);
  assert.match(effects, /class EffectWorker/);
  assert.match(effects, /inline Values Machine::perform\(/);
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
    print (qlength (qpush deque 1))`);
  const source = transpileCpp(program);
  const emitted = source.slice(source.lastIndexOf('\nnamespace nyanco {'));
  for (const call of ['intOp<Arithmetic::divide>', 'vectorTail(', 'vectorLength(',
    'transform<Transform::map>', 'transform<Transform::take>', 'partition<Partition::chunks>',
    'combinatorics<Combinatorics::combinations>', 'consume<Consume::sort>', 'collectionOp<CollectionOp::qpush>']) {
    assert.ok(emitted.includes(call),call);
  }
  assert.doesNotMatch(source,/\b(?:binary|unary)\(const std::string& op|\b(?:op|mode) == "/);
});

test('ADT constructors use variant alternatives and constructor patterns use their tags', () => {
  const source = transpileCpp(compile(`data tree 'a = Leaf 'a | Branch (tree 'a) (tree 'a)
sum (Leaf n) = n
sum (Branch left right) = (sum left) + (sum right)
main = sum (Branch (Leaf 2) (Leaf 3))`));
  assert.match(source, /std::variant<Constructors\.\.\.> value/);
  assert.match(source, /using AdtFamily\d+ = AdtValue<\d+, AdtCtor\d+, AdtCtor\d+>;/);
  assert.match(source, /makeAdt<AdtFamily\d+>\(AdtCtor\d+\{\{v\d+, v\d+\}\}\)/);
  assert.match(source, /PatternKind::constructor, \{\}[^\n]+AdtCtor\d+::tag/);
  assert.doesNotMatch(source, /struct Adt \{ std::string|x\.name == std::string\("(Leaf|Branch)"/);
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
    dict <- [0: "left", 4294967297: "right"]
    print (dict with [0] = "next")
    print dict
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
`);
    const program = compileModule(source);
    const expected = [];
    new VM({...program,input:()=> '6',output:line=>expected.push(line),warning:()=>{}}).evaluate('main');
    const cpp = join(dir,'main.cpp'), ir = join(dir,'main.ir.json'), exe = join(dir,'program.exe');
    const emitted = run(process.execPath, [join(root,'cli.mjs'),source,'--emit-cpp',cpp,'--emit-ir',ir],dir);
    assert.equal(emitted.status,0,emitted.error?.message || emitted.stderr);
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
