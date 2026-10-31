import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {LanguageService,applyChanges} from '../lsp.mjs';

const uri='file:///example.nyan';
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
  assert.equal(service.request('textDocument/hover',{textDocument:{uri},position:{line:1,character:9}}),null);
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
  send('initialize',{},1);assert.equal((await next()).result.capabilities.positionEncoding,'utf-16');
  send('initialized');
  send('textDocument/didOpen',{textDocument:{uri,version:1,languageId:'nyanco',text:'main = "猫😀"'}});
  assert.deepEqual((await next()).params.diagnostics,[]);
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
