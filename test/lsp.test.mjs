import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {LanguageService,applyChanges} from '../lsp.mjs';

const uri='file:///example.nyan';
const hints=(service,start=0,end=1000)=>service.request('textDocument/inlayHint',{textDocument:{uri},range:{start:{line:start,character:0},end:{line:end,character:1000}}});

test('line-end hints show solved stacks in evaluation order and omit empty results',()=>{
  const service=new LanguageService(),source='main =\n    1\n    dup\n    +\n    print\n    2; print\n    -- comment\n';
  const doc=service.update(uri,source,1);assert.deepEqual(doc.diagnostics,[]);
  assert.deepEqual(hints(service).map(h=>[h.position,h.label]),[
    [{line:1,character:5},': ..s int'],
    [{line:2,character:7},': ..s int int'],
    [{line:3,character:5},': ..s int'],
  ]);
  for(const hint of hints(service)){assert.equal(hint.kind,1);assert.equal(hint.paddingLeft,true);assert.match(hint.tooltip.value,/左が底、右がトップ/);}
  assert.deepEqual(hints(service,2,2).map(h=>h.label),[': ..s int int']);
  // Prefix arguments are evaluated before the head; their temporary stacks
  // must not become the final line hint (nor leave one after print).
  service.update(uri,'main = print "Hello"',2);assert.deepEqual(hints(service),[]);
  service.update(uri,'main = length [1,2]',3);assert.deepEqual(hints(service).map(h=>h.label),[': ..s int']);
});

test('multiline calls show quotation-local stacks and the completed outer stack',()=>{
  const service=new LanguageService();
  const doc=service.update(uri,'main =\n    x <- 1\n    x\n    when True {\n        + 2\n        print $\n    }\n    print',1);
  assert.deepEqual(doc.diagnostics,[]);
  assert.deepEqual(hints(service).map(h=>[h.position.line,h.label]),[
    [2,': ..s int'],[4,': ..s int'],[5,': ..s int'],[6,': ..s int'],
  ]);
  service.update(uri,'main =\n    call {\n        1\n    }\n    print',2);
  assert.deepEqual(hints(service).map(h=>[h.position.line,h.label]),[[2,': ..s int'],[3,': ..s int']]);
  service.update(uri,'main =\n    x <- (\n        1\n    )\n    print x',3);
  assert.deepEqual(hints(service).map(h=>[h.position.line,h.label]),[[2,': ..s int']]);
});

test('stack hints retain polymorphic types and later constraints and survive edits',()=>{
  const service=new LanguageService();
  service.update(uri,"keep : 'a -> 'a\nkeep =\n    dup\n    drop\nmain = print (keep 1.5)",1);
  assert.deepEqual(hints(service).map(h=>h.label),[": ..s 'a 'a",": ..s 'a"]);
  service.update(uri,'main =\n    1\n    + 2.5\n    print',2);
  assert.deepEqual(hints(service).map(h=>h.label),[': ..s float',': ..s float']);
  service.update(uri,'main = unknownName',3);assert.deepEqual(hints(service),[]);
  service.update(uri,'main = "unfinished',4);assert.deepEqual(hints(service),[]);
  service.update(uri,'',5);assert.deepEqual(hints(service),[]);
  assert.deepEqual(service.request('textDocument/inlayHint',{textDocument:{uri:'file:///missing.nyan'},range:{start:{line:0,character:0},end:{line:1,character:0}}}),[]);
});

test('stack hint positions use UTF-16 line ends including comments and CRLF',()=>{
  const service=new LanguageService(),source='main =\r\n    "猫😀" -- text\r\n    print';
  const doc=service.update(uri,source,1);assert.deepEqual(doc.diagnostics,[]);
  assert.deepEqual(hints(service).map(h=>[h.position,h.label]),[[{line:1,character:source.split('\r\n')[1].length},': ..s string']]);
  assert.equal(service.documents.get(uri).text,source);
});
test('hover preserves annotated numeric parameters inside a function while specializing calls',()=>{
  const service=new LanguageService();
  const source="abs : num 'a, ord 'a => 'a -> 'a\nabs = when ($ < 0) {0 -}\nmain =\n    print -5.3 abs";
  const doc=service.update(uri,source,1);assert.deepEqual(doc.diagnostics,[]);
  const hover=(line,character)=>service.request('textDocument/hover',{textDocument:{uri},position:{line,character}}).contents.value;
  const body=hover(1,7).split('この項の型')[1];
  assert.match(body,/num 'a, ord 'a/);assert.match(body,/\.\.s 'a bool/);assert.doesNotMatch(body,/\bint\b/);
  assert.match(hover(3,16).split('この項の型')[1],/float -> .*float/);
  assert.doesNotMatch(hover(0,1),/\bint\b/);
  service.update(uri,'main = print 1',2);
  assert.match(hover(0,8).split('この項の型')[1],/int ->/);
});
test('hover shows polymorphic definitions and separately instantiated occurrences',()=>{
  const service=new LanguageService();
  const source="square x = x * x\ninteger : -> int\ninteger = square 4\ndecimal : -> float\ndecimal = square 1.5";
  const doc=service.update(uri,source,1);assert.deepEqual(doc.diagnostics,[]);
  const hover=line=>service.request('textDocument/hover',{textDocument:{uri},position:{line,character:12}}).contents.value;
  const integer=hover(2),decimal=hover(4);
  for(const text of [integer,decimal]){assert.match(text,/定義時の型/);assert.match(text,/mul 'a/);assert.match(text,/この項の型/);}
  assert.match(integer.split('この項の型')[1],/int -> .*int/);
  assert.match(integer,/型変数の対応/);
  assert.match(integer,/'a = int/);
  assert.match(decimal,/'a = float/);
  assert.doesNotMatch(integer.split('この項の型')[1],/mul|float/);
  assert.match(decimal.split('この項の型')[1],/float -> .*float/);
  assert.doesNotMatch(decimal.split('この項の型')[1],/mul|int/);
  assert.match(service.request('textDocument/hover',{textDocument:{uri},position:{line:0,character:1}}).contents.value,/mul 'a/);
  service.update(uri,source.replace('integer : -> int','integer : -> float'),2);
  assert.match(hover(2).split('この項の型')[1],/float/);
});
test('hover substitutions retain parameter identity and show structured types',()=>{
  const service=new LanguageService();
  service.update(uri,"keep x y = x\nmain : -> int\nmain = keep 1 \"hi\"",1);
  let text=service.request('textDocument/hover',{textDocument:{uri},position:{line:2,character:8}}).contents.value;
  assert.match(text,/型変数の対応\n\n```nyanco\n'a = string\n'b = int\n```/);
  service.update(uri,"identity x = x\nmain : -> [int]\nmain = identity [1,2]",2);
  text=service.request('textDocument/hover',{textDocument:{uri},position:{line:2,character:8}}).contents.value;
  assert.match(text,/'a = \[int\]/);
});
test('LSP checks without executing, provides inferred types and source definitions',()=>{
  const service=new LanguageService();
  const doc=service.update(uri,'square x = x * x\nmain = print (square 4)',1);
  assert.deepEqual(doc.diagnostics,[]);
  const params={textDocument:{uri},position:{line:1,character:15}};
  assert.match(service.request('textDocument/hover',params).contents.value,/square.*mul/);
  assert.match(service.request('textDocument/hover',params).contents.value,/ -> /);
  assert.doesNotMatch(service.request('textDocument/hover',params).contents.value,/ -- /);
  assert.deepEqual(service.request('textDocument/definition',params).range.start,{line:0,character:0});
  assert.deepEqual(service.request('textDocument/documentSymbol',params).map(s=>s.name),['square','main']);
  assert.ok(service.request('textDocument/completion',params).some(c=>c.label==='print'));
  assert.ok(service.request('textDocument/completion',params).some(c=>c.label==='square'));
  // Compiling this initializer must neither block for input nor raise a runtime effect.
  assert.deepEqual(service.update(uri,'read -> answer',2).diagnostics,[]);
  const broken=service.update(uri,'main = unknownName',3);
  assert.equal(broken.diagnostics[0].severity,1);
  assert.deepEqual(broken.diagnostics[0].range.start,{line:0,character:7});
  assert.equal(service.update(uri,'main = 1',4).diagnostics.length,0);
  assert.equal(service.update(uri,'main = 1 2',5).diagnostics[0].code,'W001');
});
test('UTF-16 edits, syntax recovery, and shadowed names',()=>{
  assert.equal(applyChanges('a😀b\r\nc',[{range:{start:{line:0,character:3},end:{line:1,character:1}},text:'!'}]),'a😀!');
  assert.equal(applyChanges('old',[{text:'new'},{range:{start:{line:0,character:0},end:{line:0,character:1}},text:'N'}]),'New');
  const service=new LanguageService();
  assert.equal(service.update(uri,'main = "unfinished',1).diagnostics[0].severity,1);
  assert.deepEqual(service.update(uri,'main = "😀"; unknownName',2).diagnostics[0].range.start,{line:0,character:13});
  service.update(uri,'foo = 1\nf foo = foo',2);
  assert.equal(service.request('textDocument/definition',{textDocument:{uri},position:{line:1,character:9}}),null);
  assert.match(service.request('textDocument/hover',{textDocument:{uri},position:{line:1,character:9}}).contents.value,/foo : 'a/);
});

test('variable hover follows bindings, including assignment targets and nested scopes',()=>{
  const service=new LanguageService();
  const doc=service.update(uri,[
    'message <- "hi"',
    'main =',
    '    mut x <- 1',
    '    2 ->> x',
    '    call { x <- message; print x }',
    '    print x',
  ].join('\n'),1);
  assert.deepEqual(doc.diagnostics,[]);
  const hover=(line,character)=>service.request('textDocument/hover',{textDocument:{uri},position:{line,character}}).contents.value;
  assert.match(hover(0,0),/message : string/);
  assert.match(hover(2,8),/x : int/);
  assert.match(hover(3,10),/x : int/);
  assert.match(hover(4,11),/x : string/);
  assert.match(hover(4,31),/x : string/);
  assert.match(hover(5,10),/x : int/);
});

test('signature lenses show one inferred type per unannotated function',()=>{
  const service=new LanguageService();
  const source="pick : 'a -> 'a\npick x = x\nflag True = False\nflag False = True\nmain =\n    local x = x\n    print (local \"hi\")";
  const doc=service.update(uri,source,1);assert.deepEqual(doc.diagnostics,[]);
  const lenses=()=>service.request('textDocument/codeLens',{textDocument:{uri}});
  assert.deepEqual(lenses().map(lens=>[lens.range.start.line,lens.command.title,lens.command.command]),[
    [2,'flag : ..s bool -> ..s bool',''],
    [4,'main : ..s -> ..s / {io}',''],
    [5,"local : ..s 'a -> ..s 'a",''],
  ]);
  service.update(uri,'main = missing',2);
  assert.deepEqual(lenses(),[]);
});

test('stdio lifecycle, fragmented Unicode frames, updates, and shutdown',{timeout:20000},async t=>{
  const child=spawn(process.execPath,['cli.mjs','--lsp'],{cwd:new URL('..',import.meta.url),stdio:['pipe','pipe','pipe']});
  t.after(()=>child.kill());
  let buffer=Buffer.alloc(0),errors='';const queued=[],waiting=[];
  child.stderr.on('data',c=>errors+=c);
  child.stdout.on('data',chunk=>{
    buffer=Buffer.concat([buffer,chunk]);
    while(true){const end=buffer.indexOf('\r\n\r\n');if(end<0)return;
      const n=Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0,end).toString())[1]);
      if(buffer.length<end+4+n)return;
      const value=JSON.parse(buffer.subarray(end+4,end+4+n));buffer=buffer.subarray(end+4+n);
      if(waiting.length)waiting.shift()(value);else queued.push(value);
    }
  });
  const next=()=>queued.length?Promise.resolve(queued.shift()):new Promise(resolve=>waiting.push(resolve));
  const send=(method,params={},id)=>{
    const body=Buffer.from(JSON.stringify({jsonrpc:'2.0',method,params,...(id===undefined?{}:{id})}));
    const frame=Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),body]);
    child.stdin.write(frame.subarray(0,17));child.stdin.write(frame.subarray(17));
  };
  child.stdin.write('Content-Length: 1\r\n\r\n{');assert.equal((await next()).error.code,-32700);
  send('textDocument/hover',{},0);assert.equal((await next()).error.code,-32002);
  send('initialize',{},1);const capabilities=(await next()).result.capabilities;assert.equal(capabilities.positionEncoding,'utf-16');assert.equal(capabilities.inlayHintProvider,true);
  assert.deepEqual(capabilities.codeLensProvider,{resolveProvider:false});
  send('initialized');
  send('textDocument/didOpen',{textDocument:{uri,version:1,languageId:'nyanco',text:'main = "猫😀"'}});
  assert.deepEqual((await next()).params.diagnostics,[]);
  send('textDocument/inlayHint',{textDocument:{uri},range:{start:{line:0,character:0},end:{line:1,character:0}}},10);
  assert.deepEqual((await next()).result.map(h=>[h.position,h.label]),[[{line:0,character:'main = "猫😀"'.length},': ..s string']]);
  send('textDocument/codeLens',{textDocument:{uri}},11);
  assert.deepEqual((await next()).result.map(lens=>lens.command.title),['main : ..s -> ..s string']);
  send('textDocument/didChange',{textDocument:{uri,version:2},contentChanges:[{text:'main = unknownName'}]});
  assert.equal((await next()).params.diagnostics[0].severity,1);
  send('textDocument/didChange',{textDocument:{uri,version:3},contentChanges:[{range:{start:{line:0,character:7},end:{line:0,character:18}},text:'1'}]});
  assert.deepEqual((await next()).params.diagnostics,[]);
  send('textDocument/didChange',{textDocument:{uri,version:2},contentChanges:[{text:'invalid'}]});
  send('textDocument/hover',{textDocument:{uri},position:{line:0,character:1}},2);
  assert.match((await next()).result.contents.value,/main/);
  send('unknown',{},3);assert.equal((await next()).error.code,-32601);
  send('textDocument/didClose',{textDocument:{uri}});assert.deepEqual((await next()).params.diagnostics,[]);
  send('shutdown',{},4);assert.equal((await next()).result,null);
  const exited=new Promise(resolve=>child.on('exit',resolve));send('exit');assert.equal(await exited,0);
  assert.equal(errors,'');
});
