import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM,lex} from '../language.mjs';
import {LanguageService} from '../lsp.mjs';
import {transpileGo} from '../go-backend.mjs';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const run=source=>{const p=compile(source),output=[];const vm=new VM({...p,output:s=>output.push(s)});return {stack:vm.evaluate('main'),output};};

test('newlines sequence commands and fix the print and binding example',()=>{
  const source='main =\n    print "Hello, world"\n    0 -> x; print x';
  assert.deepEqual(run(source),{stack:[],output:['Hello, world','0']});
  const service=new LanguageService(),uri='file:///newline.nyan';service.update(uri,source,1);
  const text=service.request('textDocument/hover',{textDocument:{uri},position:{line:1,character:5}}).contents.value;
  assert.match(text,/'a = string/);assert.doesNotMatch(text,/'a = int/);
  assert.deepEqual(run('main =\r\n  1 -- comment\r\n\r\n  2\r\n  +').stack,[3]);
});
test('newlines start capture clauses within parentheses, vectors, records and quotations',()=>{
  assert.deepEqual(run('main = 3\n _ + 1').stack,[4]);
  assert.deepEqual(run('main = 3,\n _ + 1').stack,[4]);
  assert.equal(run('main = {x: 1,\n y: 2}').stack[0].fields.y,2);
  assert.deepEqual(run('main = (3\n _ + 1)').stack,[4]);
  assert.deepEqual(run('main = [3\n _ + 1]').stack,[[4]]);
  assert.equal(run('main = {x: 3\n _ + 1}').stack[0].fields.x,4);
  assert.deepEqual(run('main = call {3\n _ + 1}').stack,[4]);
});

test('line continuation joins calls and operators without changing capture clauses',()=>{
  const source=[
    'main =',
    '    print \\',
    '(1 + \\ \t',
    '2 * 3)',
    '    3; _ + \\',
    '_; print',
    '    10; print $, 20, \\',
    'print $; drop; drop',
    '    1 ..= 10; map {_ * _}; \\',
    'filter {% 2 == 1}; take 3; \\',
    'toVector; print',
  ].join('\n');
  assert.deepEqual(run(source),{stack:[],output:['7','6','10','10','[1, 9, 25]']});
  assert.deepEqual(run(source.replaceAll('\n','\r\n')).output,['7','6','10','10','[1, 9, 25]']);
});

test('continued declarations, bindings and do bodies follow logical layout',()=>{
  const source=[
    'inc \\',
    'n = n + 1',
    'main =',
    '    2, 3 -> \\',
    'x, \\',
    'y; x + y; inc; print',
    '    n \\',
    '<- \\',
    '7; n; print',
    '    [1, 2]; each do -> v',
    '        print \\',
    'v',
    '    print "end"',
  ].join('\n');
  assert.deepEqual(run(source).output,['6','7','1','2','end']);
});

test('class and effect headers and members accept continued lines',()=>{
  const source=[
    'class \\',
    "tagged 'a where",
    "    tag : 'a -> \\",
    'string',
    'instance \\',
    'tagged int where',
    '    tag n = show \\',
    'n',
    'effect \\',
    "query 'a where",
    '    ask : -> \\',
    "'a",
    'main =',
    '    handle {ask; tag; print} {ask: {-> k; resume 7 k}}',
  ].join('\n');
  assert.deepEqual(run(source).output,['7']);
});

test('continuations preserve physical source positions and literal escapes',()=>{
  const tokens=lex(['print \\','    "猫"'].join('\n'),'continued.nyan');
  assert.equal(tokens[1].line,2);assert.equal(tokens[1].col,5);
  assert.equal(tokens[1].logicalLine,1);
  assert.deepEqual(run(['main =',
    '    "\\\\"; print',
    '    1 -- comment \\',
    '    + 2; print',
    '    "value: {1 + \\',
    '2}"; print',
  ].join('\n')).output,['\\','3','value: 3']);
  assert.throws(()=>compile('main = "a\\\nb"'),/Invalid string escape/);
  assert.throws(()=>compile('main = 1 \\ + 2'),/Line continuation must be followed/);
  assert.throws(()=>compile('main = 1 \\'),error=>error.incompleteContinuation===true);

  const service=new LanguageService(),uri='file:///continued.nyan';
  const source=['main =','    value <- 3','    print \\','        value'].join('\n');
  assert.deepEqual(service.update(uri,source,1).diagnostics,[]);
  const hover=service.request('textDocument/hover',{textDocument:{uri},position:{line:3,character:9}});
  assert.match(hover.contents.value,/int/);
  const invalid=['main =','    print \\','        missing'].join('\n');
  assert.equal(service.update(uri,invalid,2).diagnostics[0].range.start.line,2);
  service.update(uri,source,3);
  const edits=service.request('textDocument/formatting',{textDocument:{uri},options:{tabSize:2,insertSpaces:true}});
  if(edits.length){
    assert.match(edits[0].newText,/\\\r?\n/);
    assert.deepEqual(run(edits[0].newText).output,['3']);
  }
});

test('REPL waits for continued expressions and definitions',()=>{
  const input=['3; _ + \\','_; print','plusTwo = \\','+ 2','5; plusTwo; print',':quit',''].join('\n');
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../cli.mjs',import.meta.url))],{input,encoding:'utf8',windowsHide:true,timeout:15000});
  assert.equal(result.status,0,result.stderr);
  assert.doesNotMatch(result.stdout,/Error:/);
  assert.match(result.stdout,/6\n\[\]\nDefined\.\n7\n\[\]/);
  const unfinished=spawnSync(process.execPath,[fileURLToPath(new URL('../cli.mjs',import.meta.url))],{input:'print \\',encoding:'utf8',windowsHide:true,timeout:15000});
  assert.match(unfinished.stdout,/unfinished line continuation/);
});
test('layout still accepts multiline declarations, guards and case branches',()=>{
  const source=`f x =
  local y =
    y + 1
  local x
abs n
  | n < 0 = 0 - n
  | otherwise = n
choose = case
  -> Some x ?
    f x
  -> None ?
    0
main =
  print (choose (Some 2))
  print (choose None)
  print (abs -3)`;
  assert.deepEqual(run(source).output,['3','0','3']);
});

const belowPairs=`pairs =
  fromYield {
    each [1, 2, -1] below; -> x;
    each [1, 2, 3] below; -> y;
    when (x > 0 && y > 0 && x /= y) below;
    yield #(x, y)
  }
`;
const pairsOutput='[#(1 2), #(1 3), #(2 1), #(2 3)]';

test('below nests continuations and stops at the current block boundary',()=>{
  const source=belowPairs+`effect ask : -> int
after cleanup action = call action; call cleanup
main =
  print (toVector pairs)
  print (catch below; parseInt "7")
  (handle below {ask: {-> k; resume 8 k}}; print ask)
  after {print "cleanup"} below
  when True below
  print "body"`;
  assert.deepEqual(run(source).output,[pairsOutput,'(Ok 7)','8','body','cleanup']);
  assert.deepEqual(run('main = 3; when True below; _ + 1').stack,[4]);
  assert.throws(()=>compile('main = below; nop'),/direct argument/);
  assert.throws(()=>compile('main = catch below'),/Expected a newline or ;/);
  assert.throws(()=>compile('main = handle below below; nop'),/Only one below/);
  assert.throws(()=>compile('main = catch below + 1; nop'),/direct argument/);
  assert.deepEqual(run('using = 7\nmain = using').stack,[7]);
});

test('do quotations close on dedent and support inline bindings',()=>{
  const source=`main =
  n <- -1
  when (n < 0) do
    print "negative"
  [1, 2]; each do -> x
    print x
    when (x > 1) do
      print (
  x * 2)
    print (x * 3)
  print (catch do
    parseInt "7")
  print "end"
next = 0`;
  assert.deepEqual(run(source).output,['negative','1','3','2','4','6','(Ok 7)','end']);
  assert.throws(()=>compile('main =\n  when True do\n  print 1'),/Expected an indented body/);
  assert.throws(()=>compile('main = when True do'),/Expected an indented body/);
  assert.throws(()=>compile('main = when True do nop'),/Expected a newline or ->/);
});

test('Go execution uses the same newline sequencing and captures',()=>{
  const source=belowPairs+`main =
  print (toVector pairs)
  when True do
    print "Hello, world"
  0 -> x
  print x
  3
  _ + 1
  print`.replace('print (toVector pairs)',['print \\','    (toVector pairs)'].join('\n'));
  const dir=mkdtempSync(join(tmpdir(),'nyanco-newline-'));
  try{
    const sourceFile=join(dir,'main.nyan');writeFileSync(sourceFile,source);
    const cli=spawnSync(process.execPath,[fileURLToPath(new URL('../cli.mjs',import.meta.url)),sourceFile],{encoding:'utf8',windowsHide:true,timeout:15000});
    assert.equal(cli.status,0,cli.stderr);assert.equal(cli.stdout,pairsOutput+'\nHello, world\n0\n4\n');
    const file=join(dir,'main.go');writeFileSync(file,transpileGo(compile(source)));
    const result=spawnSync('go',['run',file],{encoding:'utf8',windowsHide:true,timeout:120000});
    assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,pairsOutput+'\nHello, world\n0\n4\n');
  }finally{
    assert.equal(dirname(dir),tmpdir());assert.ok(dir.startsWith(join(tmpdir(),'nyanco-newline-')));
    rmSync(dir,{recursive:true,force:true});
  }
});
