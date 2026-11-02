import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,readdirSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {compile,VM,format} from '../migration/v037-adapter.mjs';
import {transpileGo} from '../migration/v037-go.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const goAvailable=spawnSync('go',['version'],{windowsHide:true}).status===0;
const env={...process.env,CGO_ENABLED:'0',GOTOOLCHAIN:'local',GOWORK:'off',GO111MODULE:'off'};
function native(program,options={}) {
  const dir=mkdtempSync(join(tmpdir(),'nyanco-go-test-'));
  try {
    const file=join(dir,'main.go'),exe=join(dir,'main.exe');
    const generated=transpileGo(program,options);
    assert.doesNotMatch(generated,/type Stack|\*Stack|\.push\(|\.pop\(|\.take\(|bindHoles/);
    writeFileSync(file,generated);
    const built=spawnSync('go',['build','-o',exe,file],{env,encoding:'utf8',timeout:120000,windowsHide:true});
    assert.equal(built.status,0,built.error?.message || built.stderr);
    return spawnSync(exe,[],{encoding:'utf8',timeout:15000,windowsHide:true,env:{...process.env,PATH:''}});
  } finally { rmSync(dir,{recursive:true,force:true}); }
}
function interpreted(program,{expression='main',showStack=false}={}) {
  const output=[],vm=new VM({...program,output:x=>output.push(x)});
  const stack=vm.evaluate(expression);
  if(showStack)output.push(format(stack));
  return output.length ? output.join('\n')+'\n' : '';
}

test('Go emission statically checks before generating executable code',()=>{
  const source=transpileGo(compile('main = 1'),{showStack:true});
  assert.match(source,/package main/);assert.match(source,/func\(m \*Machine\) fn\d+/);
  assert.doesNotMatch(source,/exec\.Command|node\.exe|os\/exec|type Stack|\.push\(|\.pop\(|\.take\(/);
  assert.throws(()=>transpileGo(compile('main = 1 + True','bad.nyan',new Map(),{checkTypes:false})),/Type error/);
  assert.throws(()=>transpileGo(compile('main = 1'),{expression:'unknown'}),/Unknown word/);
});

test('all example programs agree with the interpreter as standalone executables',{skip:!goAvailable},()=>{
  for(const name of readdirSync(join(root,'examples')).filter(n=>n.endsWith('.nyan'))) {
    const program=compile(readFileSync(join(root,'examples',name),'utf8'),name);
    const options={showStack:true},result=native(program,options);
    assert.equal(result.status,0,`${name}: ${result.stderr}`);
    assert.equal(result.stdout,interpreted(program,options),name);
  }
});

test('native builtins, captures, ADTs and nested operands preserve semantics',{skip:!goAvailable},()=>{
  const cases=[
    '1 2 3 rot over swap dup drop',
    '(7 / 2); (7 % 2); (2 ^ 3); (-2 ^ 3); (1e-7); (1e21); -0',
    '(1 < 2); (2 > 1); (1 <= 1); (2 >= 3); (1 == 1); (1 /= 2); (True and False); (True or False); True not',
    '3 4 5 (+ (*)); 20 9 2 (- (-)); 2 3 4 5 ((+) * (+))',
    '10 {+ 1} call; 3 {+ 1} {* 2} compose call; 1 2 {+ 3} dip',
    'True {1} {2} if; False {1} {2} if; 0 True {+ 1} when; 0 False {+ 1} when',
    '0 {dup; < 3} {+ 1} while',
    '0 [1 2 3] {+} each; 0 [1 2 3] {+; dup} map; [1 2 3] {_ % 2 == 1} filter; [1 2 3] 0 {+} fold',
    '0 [1 2] cons; [1] [2] concat; ([1] :: 2); ([1] ++ [2]); [1 2] head; [1 2] tail; [] length; 3 1 range',
    '0 -> mut n; {n ! (+ 1)} -> inc; inc call inc call n',
    'counter -> next; next call next call',
    '0 (4 Some) get; 2 None get; [(1 Some) None] show; (1 Some == 1 Some)',
    '[1 2 3] sum; [[1] [2]] flattenPair',
    '"日本語 😀 <>&" show; "line\\nquote\\\"" show; ([] :: 1) show',
    '[1] dup (==); [1] [2] (==)',
    'global ! (+ 1); global',
  ];
  const program=compile(`data 'a option = None | 'a Some
1 -> mut global
counter = 0 -> mut n; {n ! (+ 1); n}
fallback None get = fallback
_ (x Some) get = x
[] sum = 0
(xs :: x) sum = x + (xs sum)
[[a] [b]] flattenPair = a b
main = ${cases.map(s=>`(${s})`).join(';\n  ')}`);
  const result=native(program,{showStack:true});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout,interpreted(program,{showStack:true}));
});

test('native errors are nonzero and retain source locations',{skip:!goAvailable},()=>{
  for(const [source,message] of [
    ['main = 1 / 0','Division by zero'],
    ['main = [] head','head: empty list'],
    ['0 only = 1\nmain = 2 only','No matching pattern'],
    ['main = {True} {} while','Execution step limit'],
    ['forever = forever\nmain = forever','Call depth limit'],
  ]) {
    const result=native(compile(source,'failure.nyan'));
    assert.equal(result.status,1,result.stderr);assert.match(result.stderr,new RegExp(message));assert.match(result.stderr,/failure\.nyan:/);
  }
});

test('direct lowering specializes higher-order calls and preserves recursive captures',{skip:!goAvailable},()=>{
  const program=compile(`data 'a box = 'a Box
apply = call
counter = 0 -> mut n; {n ! (+ 1); n}
0 fact = 1
n fact = n * ((n - 1) fact)
(q Box) runBox = q call
q wrap = {q call}
main =
  99; 3 {dup} apply;
  True {not} apply;
  {dup} -> copy; 2 copy call; True copy call;
  [True {{+ 1}} {{* 2}} if] -> qs;
  5 qs head call;
  counter -> next; next call; next call;
  7 {+ 2} Box runBox;
  8 {+ 2} wrap call;
  6 fact;
  10 {+ 1} call; 3 {+ 1} {* 2} compose call;
  {+ 1} -> mut q; q := {* 3}; 4 q call`);
  const result=native(program,{showStack:true});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout,interpreted(program,{showStack:true}));
});

test('native indexed clause references preserve snapshots and missing-operand ordering',{skip:!goAvailable},()=>{
  const program=compile(`squareA = dup; *
squareB = $; *
squareC = * $
squareD = _ * _
main =
  7 squareA; 7 squareB; 7 squareC; 7 squareD;
  10 20; _1;
  10 20; $1;
  10 20 30 40; _2 _0 _2;
  10 3; _ -;
  3 4 5; + (_1 * _);
  2; (_; 3) (_ * _);
  [2; _ * _; $];
  [1 2 3] {_ * _} map;
  0 [1 2 3] {_1 + _} each;
  3; _ * _ -> x; x;
  5 { _ { _ * _ } call } call`);
  const result=native(program,{showStack:true});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout,interpreted(program,{showStack:true}));
});

test('native comparison chains evaluate middle values once and short-circuit',{skip:!goAvailable},()=>{
  const program=compile(`f = 4
main =
  f; 3 < <= 4;
  3 < ("middle" print 4) <= ("last" print 4);
  5 < ("middle" print 4) <= ("skipped" print 4);
  5 < 4 < (1 / 0);
  2 3; (1 < <= (+ 1));
  1 2 3; < <;
  4; 3 < $ <= 4;
  5 > 4 >= 4 == 4 /= 3;
  [2 3 4 5] {3 < <= 4} filter;
  0 -> mut n; 3 < (n ! (+ 1); 4) <= 4; n`);
  const result=native(program,{showStack:true});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout,interpreted(program,{showStack:true}));
});

test('native guards fall through patterns and evaluate conditions once',{skip:!goAvailable},()=>{
  const program=compile(`data 'a option = None | 'a Some
(n Some) choose
  | ("first" print n < 0) = 0
  | ("second" print 3 < n <= 4) = n
_ choose = 99
n positive | n > 0 = n
main = 123; 4 Some choose; None choose; 7 Some choose; 2 positive`);
  const result=native(program,{showStack:true});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout,interpreted(program,{showStack:true}));
  const failed=native(compile('n positive | n > 0 = n\nmain = 0 positive'));
  assert.equal(failed.status,1);assert.match(failed.stderr,/No matching pattern/);
});

test('native case, pattern bindings and stack-transforming guards agree with interpreter',{skip:!goAvailable},()=>{
  const program=compile(`data fuga = int Fuga
runFuga = -> x Fuga; x
absolute = case
    -> n | n < 0 then 0 - n
    otherwise nop
absolute2 = case
    | dup; < 0 then 0 -
    otherwise nop
classify = case
    -> n | n < 0 then "negative"
         | n == 0 then "zero"
    otherwise drop "positive"
retry = case
    | drop False then 100
    | dup; > 0 then 1 +
    otherwise nop
guarded | dup; < 0 = 0 - | otherwise = nop
consume | drop True = 42 | otherwise = drop 0
produce | 10 True = + | otherwise = 10 +
make = case
    -> n then {n +}
main =
    99 -3 absolute 5 absolute -4 absolute2 6 absolute2;
    -1 classify 0 classify 2 classify;
    4 retry -4 retry;
    -2 guarded 7 guarded 5 consume 5 produce;
    42 Fuga runFuga;
    4 Fuga -> mut x Fuga; x ! (+ 1); x;
    [1 2 3] -> (t :: h); h t;
    1 2 -> _ y; y;
    5 7 make call;
    (3; case -> n then n + 1 end)`);
  const result=native(program,{showStack:true});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout,interpreted(program,{showStack:true}));
  for(const [source,message] of [
    ['main = 2; case -> 0 then 1 end','No matching case branch'],
    ['main = [1]; -> [x y]','Assignment pattern did not match'],
  ]) {const result=native(compile(source));assert.equal(result.status,1);assert.match(result.stderr,new RegExp(message));}
});

test('native local functions are deferred, polymorphic, recursive and capture cells',{skip:!goAvailable},()=>{
  const program=compile(`{plus = +; plus} -> q
n make =
  add = n +
  {add}
main =
  y = +
  copy = dup
  n square = n * n
  fact = (case
    -> 0 then 1
    -> n then n * ((n - 1) fact)
  end)
  0 -> mut counter
  read = counter
  3 4 y; 2 copy; True copy;
  5 square; 6 fact; 3 7 make call;
  counter := 9; read; 3 4 q call`);
  const result=native(program,{showStack:true});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout,interpreted(program,{showStack:true}));
});

test('CLI emits Go without a toolchain and rejects invalid output combinations',()=>{
  const dir=mkdtempSync(join(tmpdir(),'nyanco-cli-go-'));
  try {
    const file=join(dir,'main.go');
    const cli=args=>spawnSync(process.execPath,[join(root,'migration','v037-cli.mjs'),...args],{encoding:'utf8',env:{...process.env,PATH:''},windowsHide:true});
    const ok=cli(['--eval','3 + 2','--emit-go',file]);assert.equal(ok.status,0,ok.stderr);assert.match(readFileSync(file,'utf8'),/package main/);
    const bad=join(dir,'bad.go');assert.equal(cli(['--eval','1 + True','--emit-go',bad]).status,1);assert.equal(existsSync(bad),false);
    assert.equal(cli(['--eval','1','--emit-go',file,'--build',file]).status,1);
    const missing=cli(['--eval','1','--build',join(dir,'missing.exe')]);assert.equal(missing.status,1);assert.match(missing.stderr,/Install Go/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('CLI builds a runnable executable and supports custom entry expressions',{skip:!goAvailable},()=>{
  const dir=mkdtempSync(join(tmpdir(),'nyanco-cli-build-'));
  try {
    const exe=join(dir,'with spaces.exe'),file=join(dir,'main.go');
    const result=spawnSync(process.execPath,[join(root,'migration','v037-cli.mjs'),join(root,'examples/demo.nyan'),'--eval','6 factorial','--emit-go',file,'--build',exe],{encoding:'utf8',timeout:120000,windowsHide:true});
    assert.equal(result.status,0,result.stderr);
    const run=spawnSync(exe,[],{encoding:'utf8',env:{...process.env,PATH:''},windowsHide:true});
    assert.equal(run.status,0,run.stderr);assert.equal(run.stdout,'[720]\n');
  } finally {rmSync(dir,{recursive:true,force:true});}
});

 test('native records, polymorphic projection and nested closures agree with interpreter',{skip:!goAvailable},()=>{
  const program=compile(`get = .name
r total = r.x + r.y
make = {q: {+ 1}, nested: {value: 8}}
main =
  {name: "Alice", age: 20} get print
  {name: 42, active: True} get print
  {y: 4, x: 3, z: 9} total print
  [{name: "A", age: 1}; {age: 2, name: "B"}] {.name} map print
  4 make.q call print
  make.nested.value print
  ({a: 1, b: True} == {b: True, a: 1}) print
  {:} print
  {__proto__: 3, constructor: 2} print
  5 -> n
  {q: {n +}, x: (f = 3; f)} -> r
  4 r.q call print
  r.x print`);
  const options={showStack:true},result=native(program,options);
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,interpreted(program,options));
});


test('native containers share clause captures and honor inner separators',{skip:!goAvailable},()=>{
  const cases=['3; [_]','3; {x: _}','3 {x:}','2 3 {x:, y:}',
    '2 3; {x: _, y:}','3; [_; _ * _]','3; {x: (_; _ * _)}',
    '3; [4; _] _','3; {x: 4; _, y: _} _','3; [[$]]','3 {[_]} call',
    '3; {x:}.x + 1','2 3; [{x: _1, y: _}]'];
  const program=compile('main = '+cases.map(s=>'('+s+') show print').join('; '));
  const result=native(program,{showStack:true});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout,interpreted(program,{showStack:true}));
});


test('native type class methods specialize across functions and quotations',{skip:!goAvailable},()=>{
  const program=compile(`data color = Red | Blue
class 'a describe where
  describe : 'a -> string
instance describe int where
  describe = show
instance describe bool where
  True describe = "yes"
  False describe = "no"
instance describe color where
  Red describe = "red"
  Blue describe = "blue"
render = describe
renderAll = {describe} map
wrapper = {q: {describe}}
main =
  3 render print
  True render print
  Blue render print
  [1 2] renderAll print
  [Red Blue] renderAll print
  False wrapper.q call print
  local = describe
  7 local print
  Red local print`);
  const result=native(program,{showStack:true});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout,interpreted(program,{showStack:true}));
});

test('native ADT operators cover sections, higher order calls and comparison chains',{skip:!goAvailable},()=>{
  const program=compile(`data amount = int Amount
instance add amount where
  (x Amount) (y Amount) (+) = (x + y) Amount
instance mul amount where
  (x Amount) (y Amount) * = (x * y) Amount
instance eq amount where
  (x Amount) (y Amount) == = x == y
  (x Amount) (y Amount) /= = x /= y
instance ord amount where
  (x Amount) (y Amount) < = x < y
  (x Amount) (y Amount) <= = x <= y
  (x Amount) (y Amount) > = x > y
  (x Amount) (y Amount) >= = x >= y
sum = +
wrapped = {q: {+}}
main =
  ((1 Amount) + (2 Amount)) print
  (1 Amount) (2 Amount) sum print
  (1 Amount) (+ (2 Amount)) print
  (1 Amount) (2 Amount) {+} call print
  (1 Amount) (2 Amount) wrapped.q call print
  (0 Amount) [(1 Amount); (2 Amount)] {+} each print
  ((2 Amount) * (3 Amount)) print
  ((2 Amount) == (2 Amount)) print
  ((1 Amount) < (2 Amount) <= (3 Amount)) print
  ((3 Amount) < (2 Amount) < ("bad" print; 4 Amount)) print
  ([1 2] == [1 2]) print
  (3 + 4) print`);
  const result=native(program,{showStack:true});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout,interpreted(program,{showStack:true}));
});

test('native exclusive and inclusive range operators match the interpreter',{skip:!goAvailable},()=>{
  const program=compile(`rangeTo = ..=
main =
  (1..5) print
  (1..=5) print
  (3..-1) print
  (3..=-1) print
  (2..2) print
  (2..=2) print
  (1 + 1 ..= 2 * 3) print
  1 3 {..=} call print
  2 4 rangeTo print
  ({x: 2}.x .. 4) print
  (1..3 == 1..3) print
  (0 (0..100) {drop; + 1} each) print
  (0 (0..=100) {drop; + 1} each) print`);
  const result=native(program,{showStack:true});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout,interpreted(program,{showStack:true}));
  assert.throws(()=>compile('main = 1.5..3'),/Cannot unify int with float/);
});

test('native adjacent operators preserve precedence, holes and comparison short circuiting',{skip:!goAvailable},()=>{
  const program=compile(`data amount = int Amount
instance add amount where
  (x Amount) (y Amount) + = (x + y) Amount
instance mul amount where
  (x Amount) (y Amount) * = (x * y) Amount
f = + *
main =
  (3 4 5; + +) print
  (3 4 5; + *) print
  (3 4 5; * +) print
  (20 5 2; - -) print
  (2 3 2; ^ ^) print
  (3 4 5; + * _) print
  ([] 1 2; :: ::) print
  (1 2 3 4; < + <=) print
  (5 1 2; < + < ("bad" print; 10)) print
  (1 2 4; + ..=) print
  3 4 5 {+ *} call print
  (3 Amount) (4 Amount) (5 Amount) f print`);
  const result=native(program,{showStack:true});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout,interpreted(program,{showStack:true}));
});

test('native Push constructions and patterns agree with interpreter',{skip:!goAvailable},()=>{
  const program=compile(`data 'a option = None | 'a Some
xs x Push splitPattern = xs x
([] :: x :: y) pair = x y
last = case
  -> xs x Push then x Some
  -> [] then None
[] sum = 0
xs x Push sum = (xs sum) + x
main =
  [] 3 Push 4 Push 5 Push print
  ([] :: 3 :: 4 :: 5) print
  [1 2 3] splitPattern print print
  [4 5] pair print print
  [1 2 3] sum print
  [3 4] last print
  [] last print
  [1 2 3] -> mut xs x Push
  xs ! (:: 4)
  xs print
  x print`);
  const result=native(program,{showStack:true});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout,interpreted(program,{showStack:true}));
});

test('native tuples preserve literals, indices, patterns, clauses and stored quotations',{skip:!goAvailable},()=>{
  const program=compile(`a : #(int string [int])
a = #(0 "Hoge" [])
first = .0
#(x y) unpack = x y
main =
  a print
  a.0 print
  a.1 print
  a.2 print
  #() print
  #(1) first print
  #(True "x") first print
  [#(1 "a"); #(2 "b")] {.1} map print
  #(3 "ok") unpack print print
  #(1 True) -> #(n flag)
  n print flag print
  3; #(_ "x") print
  #({+}) -> t
  4 5 t.0 call print
  (#(1 [2]) == #(1 [2])) print`);
  const result=native(program,{showStack:true});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout,interpreted(program,{showStack:true}));
});

test('native generic instances and each preserve carried values and dispatch',{skip:!goAvailable},()=>{
  const program=compile(`data 'a box = 'a Box
class 'a describe where
  describe : 'a -> string
instance describe int where
  describe = show
instance 'a describe => describe ('a box) where
  (x Box) describe = x describe
instance 'a describe => describe ['a] where
  describe = {describe} map show
instance 'a add => add ('a box) where
  (x Box) (y Box) + = (x + y) Box
instance each ('a box) where
  (x Box) q each = x q call
walk = each
main =
  "prefix" 10 (2 Box) {+} walk
  0 (1..=5) {+} walk
  0 (5..1) {+} walk
  0 [1 2 3] {+} walk
  0 (1..1) {+} walk
  [] (1..=3) {Push} each
  4 Box Box describe
  [1 2] describe;
  ((2 Box) + (3 Box));
  {each} -> q
  0 (1..=3) {+} q call`);
  const options={showStack:true},result=native(program,options);
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,interpreted(program,options));
});

test('native recursive each instances retain accumulator values',{skip:!goAvailable},()=>{
  const program=compile(`data 'a tree = 'a Leaf | ('a tree) ('a tree) Node
instance each ('a tree) where
  (x Leaf) q each = x q call
  (l r Node) q each = l q each; r q each
main = "prefix" 0 ((1 Leaf) ((2 Leaf) (3 Leaf) Node) Node) {+} each`);
  const options={showStack:true},result=native(program,options);
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,interpreted(program,options));
});

test('native algebraic effects resume, abort and forward without replaying side effects',{skip:!goAvailable},()=>{
  const program=compile(`effect ask : -> int
effect log : string ->
effect split : int -> int int
withHandlers = handle
f = ask + 1
main =
  {ask; + 1} {ask: {-> k; (k == k) print; 41 k resume; + 10}} withHandlers print;
  {ask; ask; +} {ask: {-> k; 10 k resume}} handle print;
  {{ask} {ask: {-> k; 2 k resume}} handle} {ask: {-> k; 41 k resume}} handle print;
  {{ask; + 1} {:} handle; + 2} {ask: {-> k; 41 k resume}} handle print;
  {{ask} {ask: {-> k; ask k resume}} handle} {ask: {-> k; 41 k resume}} handle print;
  {{ask} {:} handle; + 100} {ask: {drop; 7}} handle print;
  {3 split; +} {split: {-> n k; n (n + 1) k resume}} handle print;
  {"hello" log; 5} {log: {-> msg k; msg print; k resume}} handle print;
  {0 (1..=3) {drop; f; +} each} {ask: {-> k; 41 k resume}} handle print;
  0 -> mut n;
  {n ! (+ 1); "before" print; ask; n ! (+ 100); "after" print} {ask: {drop; 9}} handle print;
  n print;
  0 -> mut count;
  {count ! (+ 1); ask; count ! (+ 1)} {ask: {-> k; 4 k resume}} handle print;
  count print`);
  const options={showStack:true},result=native(program,options);
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,interpreted(program,options));
});
test('native continuations reject repeated resumption and report unhandled effects',{skip:!goAvailable},()=>{
  for(const [body,message] of [
    ['{ask} {ask: {-> k; 1 k resume drop; 2 k resume}} handle',/already resumed/],
    ['{{ask} {:} handle} {:} handle',/Unhandled effect: ask/],
    ['{0} -> mut saved; {ask} {ask: {-> k; saved := {1 k resume}; 0}} handle drop; saved call',/expired/],
  ]){
    const result=native(compile(`effect ask : -> int\nmain = ${body}`));
    assert.equal(result.status,1,result.error?.message||result.stderr);assert.match(result.stderr,message);
  }
});

test('native bottom operations join returning branches and abort without resumption',{skip:!goAvailable},()=>{
  const program=compile(`effect fail : string -> !
die : string -> !
die = fail
0 f = "bad" die
n f = n + 1
g = case
  -> 0 then "bad" fail
  -> n then n + 2
h = {fail: {-> message k; 42}}
main =
  3 f print; 3 g print;
  True {1} {"bad" fail} if print;
  False {"bad" fail} {1} if print;
  {"bad" die} h handle print;
  {0 f} h handle print;
  {0 g} h handle print;
  {1 + ("bad" fail)} h handle print;
  {["bad" fail]} h handle print;
  {{x: "bad" fail}} h handle print;
  {#("bad" fail)} h handle print;
  {True {"a" fail} {"b" fail} if} h handle print;
  {{"bad" fail; "unreachable" print} {:} handle} h handle print`);
  const options={showStack:true},result=native(program,options);
  assert.equal(result.status,0,result.error?.message||result.stderr);assert.equal(result.stdout,interpreted(program,options));
});

test('native bottom comparisons and callbacks preserve returning control flow',{skip:!goAvailable},()=>{
  const program=compile(`effect fail : string -> !
h = {fail: {drop drop; 42}}
abort = {"bad" fail}
main =
  3 < 2 < ("bad" fail); print; 7 print;
  {0 < ("bad" fail)} {fail: {drop drop; False}} handle print;
  {1 < 2 < ("bad" fail)} {fail: {drop drop; False}} handle print;
  {0 abort {+ 1} while} h handle print;
  {0 {dup; < 1} abort while} h handle print;
  {0 [] {drop; "bad" fail} each} h handle print;
  {0 [1] {drop; "bad" fail} each} h handle print`);
  const options={showStack:true},result=native(program,options);
  assert.equal(result.status,0,result.error?.message||result.stderr);assert.equal(result.stdout,interpreted(program,options));
});

test('native postfix instances and polymorphic effects agree with interpreter',{skip:!goAvailable},()=>{
  const program=compile(`data 'a box = 'a Box
instance 'a add => ('a box) add where
  (x Box) (y Box) + = (x + y) Box
effect 'a yield : 'a ->
effect 'a relay : 'a -> 'a
effect 'a 'b pair : 'a 'b -> #('a 'b)
effect 'a fail : 'a -> !
emit = yield
withHandlers = handle
h = {yield: {-> x k; x print; k resume}}
main =
  ((1 Box) + (2 Box)) print;
  {1 emit; True yield; "hi" yield; [1 2] yield; 7} h withHandlers print;
  {"again" yield; 8} h handle print;
  {1 relay; True relay; "ok" relay; #( _2 _1 _ )} {relay: {-> x k; x k resume}} handle print;
  {1 "ok" pair} {pair: {-> x y k; #(x y) k resume}} handle print;
  {True fail} {fail: {-> reason k; 42}} handle print;
  0 -> mut count;
  {1 yield; False yield; 0} {yield: {-> x k; count ! (+ 1); k resume}} handle print;
  count print`);
  const options={showStack:true},result=native(program,options);
  assert.equal(result.status,0,result.error?.message||result.stderr);assert.equal(result.stdout,interpreted(program,options));
});

test('native compilation preserves explicitly annotated effect rows',{skip:!goAvailable},()=>{
  const program=compile(`effect 'a yield: 'a ->
effect ask: -> int
run : {-> int / { | 'e}} -> int / { | 'e}
run = call
body : -> int / {ask, int yield}
body = ask; dup yield; + 10
main : -> / {io}
main = { {body} run } {ask: {-> k; 32 k resume}, yield: {-> x k; x print; k resume}} handle print`);
  const options={showStack:true},result=native(program,options);
  assert.equal(result.status,0,result.error?.message||result.stderr);assert.equal(result.stdout,interpreted(program,options));
});

test('native handlers and continuations return zero and multiple values',{skip:!goAvailable},()=>{
  const program=compile(`effect ask: -> int
effect tick: ->
effect fail: string -> !
withHandlers = handle
discardLast = handle; drop
main =
  {1 "x"} {:} discardLast print;
  99 {} {:} handle print;
  {1 "x" True} {:} withHandlers print print print;
  {ask drop} {ask: {-> k; 3 k resume}} handle;
  {tick; 4 "x"} {tick: {-> k; k resume; swap; + 2; swap}} handle print print;
  {ask; "x"} {ask: {drop; 7 "abort"}} handle print print;
  {{ask; "x"} {:} handle; True} {ask: {-> k; 9 k resume}} handle print print print;
  {"bad" fail} {fail: {drop drop}} handle;
  {"bad" fail} {fail: {drop drop; 1 "abort"}} withHandlers print print`);
  const options={showStack:true},result=native(program,options);
  assert.equal(result.status,0,result.error?.message||result.stderr);assert.equal(result.stdout,interpreted(program,options));
});

test('native conditional instances enforce and dispatch nested contexts',{skip:!goAvailable},()=>{
  const source=`data 'a box = 'a Box
class 'a describe where
  describe : 'a -> string
instance int describe where
  describe = show
instance 'a describe => ('a box) describe where
  (x Box) describe = x describe
instance 'a describe => ['a] describe where
  describe = {describe} map show
instance 'a add => ('a box) add where
  (x Box) (y Box) + = (x + y) Box
instance 'a describe => ('a box) each where
  (x Box) q each = x q call
render = describe
main =
  3 Box Box render print;
  [1 Box 2 Box] render print;
  ((2 Box Box) + (3 Box Box)) render print;
  10 (2 Box) {+} each print`;
  const program=compile(source),options={showStack:true},result=native(program,options);
  assert.equal(result.status,0,result.error?.message||result.stderr);
  assert.equal(result.stdout,interpreted(program,options));
  for(const bad of ['True Box render','(True Box) + (False Box)','(True Box) {drop} each'])assert.throws(()=>compile(source+'\nbad = '+bad),/No instance/);
});


test('native user associated types and constrained lmap instances agree with interpreter',{skip:!goAvailable},()=>{
  const program=compile(`data 'a box = 'a Box
class 'c unpack where
  type item
  unpack : 'c -> item
instance ('a box) unpack where
  item : 'a
  (x Box) unpack = x
unwrapValue = unpack
data 'c 'a 'b lmap = 'c {'a -> 'b} LMap
instance 'c 'a each => ('c 'a 'b lmap) each where
  item : 'b
  (c f LMap) g each = c {f call; g call} each
main =
  3 Box unwrapValue print;
  True Box unwrapValue print;
  {unpack} -> q;
  "s" Box q call print;
  0 ([1 2 3] {+ 10} LMap) {+} each print;
  [] ((1..=3) {show} LMap) {::} each print;
  0 (([1 2] {+ 10} LMap) {* 2} LMap) {+} each print`);
  const options={showStack:true},result=native(program,options);
  assert.equal(result.status,0,result.error?.message||result.stderr);assert.equal(result.stdout,interpreted(program,options));
});
