import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {compileModule} from '../modules.mjs';
import {compile,VM} from '../language.mjs';
import {transpileGo} from '../go-backend.mjs';
import {LanguageService,startServer} from '../lsp.mjs';
import {PassThrough} from 'node:stream';

function fixture(files,fn){const dir=mkdtempSync(join(tmpdir(),'nyanco-modules-'));try{const put=(file,text)=>{const path=join(dir,file);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,text);return path;};for(const [file,text] of Object.entries(files))put(file,text);return fn(dir,put);}finally{rmSync(dir,{recursive:true,force:true});}}
test('modules collect comma-separated top-level bindings',()=>fixture({
 'main.nyan':'import "./lib"\nmain = lib.sum',
 'lib/api.nyan':'1, #(2, 3) -> x, #(y, z)\npub sum : -> int\nsum = x + y + z'
},dir=>assert.deepEqual(new VM(compileModule(join(dir,'main.nyan'))).evaluate('main'),[6])));

const library=`pub data secret = Secret int
open data box 'a = Box 'a deriving eq, show
pub type token = int
open type pair 'a = #('a string)
privateHelper x = x + 1
pub make : int -> secret
make n = Secret (privateHelper n)
pub read : secret -> int
read (Secret n) = n
pub makeToken : -> token
makeToken = 7
pub readToken : token -> int
readToken x = x + 1
pub makePair : -> pair int
makePair = #(3, "pair")
pub class tagged 'a where
  tag : 'a -> string
instance tagged secret where
  tag _ = "secret"
pub effect alert : string ->
pub notify : -> / {alert}
notify = alert "notice"
pub record : -> {privateHelper: int}
record = {privateHelper: 1} with privateHelper = 9
interpolate : int -> string
pub interpolate x = "value={privateHelper x}"
effect hiddenAsk : -> int
pub handled : -> int
handled = handle {hiddenAsk} {hiddenAsk: {-> k; resume 11 k}}
pub hiddenBody : -> {-> int / {hiddenAsk}}
hiddenBody = {hiddenAsk}
pub handlers : -> {hiddenAsk: {(continuation {int -> int}) -> int}}
handlers = {hiddenAsk: {-> k; resume 12 k}}
privateIndex = 0
pub indexed : -> int / {exn}
indexed = ([1] with [privateIndex] ! + 2).[0]
`;
const main=`import "./lib" as lib
main =
 print (lib.read (lib.make 2))
 print (lib.Box 4)
 print (lib.Box 4 == lib.Box 4)
 print (lib.readToken lib.makeToken)
 print (lib.makePair).0
 print (lib.tag (lib.make 0))
 print lib.record.privateHelper
 print (lib.interpolate 3)
 handle {lib.notify} {lib.alert: {-> text k; print text; resume k}}
 print (local 4)
 print lib.handled
 print (handle lib.hiddenBody lib.handlers)
 print (show (lib.make 3))
 print lib.indexed
 print ({lib: 1} with lib = 2).lib
`;
const files={'main.nyan':main,'helper.nyan':'local x = x * 2','lib/api.nyan':library,'lib/helper.nyan':'unused x = privateHelper x'};
const run=file=>{const p=compileModule(file),output=[],vm=new VM({...p,output:s=>output.push(s),warning:()=>{}});vm.evaluate('main');return {p,vm,output};};

test('line continuation spans module signatures, definitions and call arguments',()=>fixture({
 'lib/api.nyan':[
  'pub identity : \\',
  'int -> int',
  'identity \\',
  'x = x',
 ].join('\n'),
 'main.nyan':[
  'import "./lib"',
  'main = print \\',
  '(lib.identity 7)',
 ].join('\n'),
},dir=>assert.deepEqual(run(join(dir,'main.nyan')).output,['7'])));

test('directory modules share private definitions and import public functions types classes and effects',()=>fixture(files,(dir)=>{
 const {p,vm,output}=run(join(dir,'main.nyan'));
 assert.deepEqual(output,['3','(Box 4)','True','8','3','secret','9','value=4','notice','8','11','12','(Secret 4)','3','2']);
 assert.deepEqual(vm.evaluate('lib.read (lib.make 5)'),[6]);
 assert.match(vm.infer('lib.makeToken'),/lib\.token/);assert.doesNotMatch(vm.infer('lib.makeToken'),/nyancoModule/);
 assert.equal(p.modules.ordered.length,2);
 assert.equal(run(dir).output.at(-1),'2');
}));

test('pub data and type hide constructors and representations while open exports them',()=>fixture(files,(dir,put)=>{
 for(const expression of ['lib.Secret 1','lib.privateHelper 1','lib.unused 1']){
  put('main.nyan',`import "./lib" as lib\nmain = ${expression}`);assert.throws(()=>compileModule(join(dir,'main.nyan')),/does not export/);
 }
 for(const expression of ['lib.readToken 7','lib.makeToken + 1','lib.makeToken == 7','lib.makeToken.x']){
  put('main.nyan',`import "./lib" as lib\nmain = ${expression}`);assert.throws(()=>compileModule(join(dir,'main.nyan')),/unify|instance/i);
 }
 put('main.nyan',`import "./lib" as lib
unbox (lib.Box x) = x
id : lib.secret -> lib.secret
id x = x
pair : lib.pair int -> int
pair = .0
main = unbox (lib.Box 4); pair #(2, "x"); lib.read (id (lib.make 0))`);
 assert.deepEqual(run(join(dir,'main.nyan')).vm.evaluate('main'),[4,2,1]);
}));

test('private names from independent modules do not collide and diamond imports initialize once',()=>fixture({
 'main.nyan':'import "./a"\nimport "./b"\nmain = a.run; b.run',
 'a/a.nyan':'import "../common"\nprivate n = n + 1\npub run : -> int\nrun = private common.value',
 'b/b.nyan':'import "../common"\nprivate n = n * 2\npub run : -> int\nrun = private common.value',
 'common/value.nyan':'print "initialize"; 0 -> marker\npub value : -> int\nvalue = 3',
},(dir)=>{
 const {vm,output,p}=run(join(dir,'main.nyan'));assert.deepEqual(vm.evaluate('main'),[4,6]);assert.deepEqual(output,['initialize']);assert.equal(p.modules.ordered.length,4);
}));

test('cycles invalid imports duplicates and cyclic aliases fail without executing',()=>fixture({'main.nyan':'import "./lib"\nmain = nop','lib/a.nyan':'import ".." as app\npub f : ->\nf = nop'},(dir,put)=>{
 assert.throws(()=>compileModule(join(dir,'main.nyan')),/Cyclic module import/);
 put('lib/a.nyan','pub f : ->\nf = nop');put('main.nyan','import "./lib" as x\nimport "./lib" as x\nmain = nop');assert.throws(()=>compileModule(join(dir,'main.nyan')),/duplicate module alias/);
 put('main.nyan','import "./missing"\nmain = nop');assert.throws(()=>compileModule(join(dir,'main.nyan')),/does not exist/);
 assert.throws(()=>compile('type a = b\ntype b = a'),/Cyclic type alias/);
}));

test('Go and CLI load whole modules and preserve opaque aliases at the native boundary',()=>fixture(files,(dir,put)=>{
 const entry=join(dir,'main.nyan'),{p,output}=run(entry),go=put('main.go',transpileGo(p));
 const native=spawnSync('go',['run',go],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(native.status,0,native.stderr);assert.equal(native.stdout,output.join('\n')+'\n');
 const cli=spawnSync(process.execPath,['cli.mjs',entry],{encoding:'utf8',windowsHide:true,timeout:10000});assert.equal(cli.status,0,cli.stderr);assert.equal(cli.stdout,native.stdout);
 const repl=spawnSync(process.execPath,['cli.mjs'],{input:':load '+entry+'\nlib.read (lib.make 5)\n:type lib.makeToken\n:words\n:q\n',encoding:'utf8',windowsHide:true,timeout:10000});assert.equal(repl.status,0,repl.stderr);assert.match(repl.stdout,/\[6\]/);assert.match(repl.stdout,/lib\.token/);assert.doesNotMatch(repl.stdout,/nyancoModule|Error:/);

}));

test('LSP uses unsaved module files and exposes only public imported names',()=>fixture(files,(dir)=>{
 const service=new LanguageService(),uri=pathToFileURL(join(dir,'main.nyan')).href,libURI=pathToFileURL(join(dir,'lib/api.nyan')).href;
 const doc=service.update(uri,main,1);assert.deepEqual(doc.diagnostics,[]);
 const request=(method,line,character)=>service.request('textDocument/'+method,{textDocument:{uri},position:{line,character}});
 const labels=request('completion',2,10).map(c=>c.label);assert.ok(labels.includes('lib.make'));assert.ok(labels.includes('lib.box'));assert.ok(labels.includes('lib.Box'));assert.ok(!labels.includes('lib.Secret'));assert.ok(!labels.some(n=>/nyancoModule/i.test(n)));
 assert.match(request('hover',2,15).contents.value,/lib.read/);
 assert.equal(request('definition',2,15).uri,libURI);
 const interpolationLine=main.split('\n').findIndex(line=>line.includes('lib.interpolate'));
 assert.equal(request('definition',interpolationLine,12).range.start.character,4);
 assert.doesNotMatch(request('hover',5,28).contents.value,/->.*int.*int/);
 service.update(libURI,library.replace('pub read :','read :').replace('pub make :','make :'),2);
 assert.match(service.documents.get(uri).diagnostics[0].message,/does not export/);
}));

test('stack inlay hints display imported type names and clear after dependency errors',()=>fixture({
 'lib/api.nyan':'open data token = Token int\npub make : -> token\nmake = Token 1',
 'main.nyan':'import "./lib"\nmain = lib.make',
},dir=>{
 const service=new LanguageService(),uri=pathToFileURL(join(dir,'main.nyan')).href,libURI=pathToFileURL(join(dir,'lib/api.nyan')).href;
 const doc=service.update(uri,'import "./lib"\nmain = lib.make',1);assert.deepEqual(doc.diagnostics,[]);
 const params={textDocument:{uri},range:{start:{line:0,character:0},end:{line:2,character:0}}};
 assert.deepEqual(service.request('textDocument/inlayHint',params).map(h=>h.label),[': ..s lib.token']);
 service.update(libURI,'open data token = Token int\npub make : -> token\nmake = missing',2);
 assert.deepEqual(service.request('textDocument/inlayHint',params),[]);
}));

test('type and value namespaces preserve visibility separately and classes may share method names',()=>fixture({
 'lib/a.nyan':`pub class zero 'a where
  zero : -> 'a
instance zero int where
  zero = 0
pub type hidden = int
hidden = 10
pub value : -> int
value = 1
pub type both = int
pub both : -> both
both = 2`,
 'main.nyan':`import "./lib"
f : lib.zero 'a => -> 'a
f = lib.zero
main = (f + 1); lib.both`,
},(dir,put)=>{
 assert.deepEqual(run(join(dir,'main.nyan')).vm.evaluate('main'),[1,2]);
 put('main.nyan','import "./lib"\nmain = lib.hidden');assert.throws(()=>compileModule(join(dir,'main.nyan')),/does not export hidden in the value/);
}));

const shortTypes={
 'box/api.nyan':"open data box 'a = Box 'a deriving show, eq",
 'secret/api.nyan':`pub type secret = int
pub make : int -> secret
make n = n
pub read : secret -> int
read n = n`,
 'pair/api.nyan':"open type pair 'a = #('a string)",
 'main.nyan':`import "./box"
import "./secret" as s
import "./pair" as p
identity : box int -> box int
identity x = x
qualified : box.box int -> box int
qualified = identity
keepSecret : s -> s
keepSecret x = x
first : p int -> int
first = .0
data wrapped = Wrapped (box int)
type boxes = [box int]
effect echo : box int -> box int
class make 'a where
  make : -> 'a
instance make (box int) where
  make = box.Box 8
class unpack 'a where
  type item
  unpack : 'a -> item
instance unpack wrapped where
  item : box int
  unpack (Wrapped x) = x
main = print (qualified (box.Box 3)); print (s.read (keepSecret (s.make 4))); print (first #(5, "x")); print (make == box.Box 8); print (unpack (Wrapped (box.Box 6)))`,
};

test('same-named exported data and aliases allow module-only type references',()=>fixture(shortTypes,(dir,put)=>{
 const {p,vm,output}=run(join(dir,'main.nyan'));
 assert.deepEqual(output,['(Box 3)','4','5','True','(Box 6)']);
 assert.match(p.types.get('identity'),/box int/);assert.doesNotMatch(p.types.get('identity'),/box\.box/);
 assert.match(vm.infer('keepSecret'),/\bs -> .*\bs/);
 put('main.nyan','import "./secret" as s\nf : s -> int\nf = + 1');assert.throws(()=>compileModule(join(dir,'main.nyan')),/instance|unify/i);
 put('main.nyan','import "./box"\nmain = box');assert.throws(()=>compileModule(join(dir,'main.nyan')),/qualified member/);
 put('box/api.nyan',"data box 'a = Box 'a");put('main.nyan',"import \"./box\"\nf : box int -> box int\nf x = x");assert.throws(()=>compileModule(join(dir,'main.nyan')),/exported same-named type/);
}));

test('short type names are available in LSP and native lowering',()=>fixture(shortTypes,(dir,put)=>{
 const entry=join(dir,'main.nyan'),uri=pathToFileURL(entry).href,service=new LanguageService();
 const doc=service.update(uri,shortTypes['main.nyan'],1);assert.deepEqual(doc.diagnostics,[]);
 const req=(method,line,character)=>service.request('textDocument/'+method,{textDocument:{uri},position:{line,character}});
 assert.equal(req('definition',3,12).uri,pathToFileURL(join(dir,'box/api.nyan')).href);
 assert.match(req('hover',3,12).contents.value,/data box/);
 const labels=req('completion',3,12).map(c=>c.label);for(const name of ['box','s','p','box.box'])assert.ok(labels.includes(name),name);
 const {p,output}=run(entry),go=put('main.go',transpileGo(p));
 const native=spawnSync('go',['run',go],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(native.status,0,native.stderr);assert.equal(native.stdout,output.join('\n')+'\n');
}));

test('LSP keeps real diagnostic locations when file URI spellings differ',()=>fixture({
 'main.nyan':'main = nop',
 'lib/api.nyan':'pub value : -> int\nvalue = 3',
},(dir)=>{
 const canonical=pathToFileURL(join(dir,'main.nyan')).href;
 let uri=canonical.replace('main.nyan','%6dain.nyan');
 if(process.platform==='win32')uri=uri.replace(/^file:\/\/\/([A-Z]):/,(_,drive)=>'file:///'+drive.toLowerCase()+':');
 const service=new LanguageService(),source='helper = nop\n\nmain =\n    print "😀"; missingWord';
 const doc=service.update(uri,source,1),start=source.split('\n')[3].indexOf('missingWord');
 assert.deepEqual(doc.diagnostics[0].range,{start:{line:3,character:start},end:{line:3,character:start+11}});
 assert.equal(doc.externalDiagnostics.size,0);
 const syntax=service.update(uri,'helper = nop\nmain =\n    "unfinished',2);
 assert.deepEqual(syntax.diagnostics[0].range,{start:{line:2,character:4},end:{line:2,character:5}});
 const text='import "./lib"\nmain = lib.value',valid=service.update(uri,text,3);
 assert.deepEqual(valid.diagnostics,[]);assert.ok(valid.symbols.some(s=>s.name==='main'));
 const request=method=>service.request('textDocument/'+method,{textDocument:{uri},position:{line:1,character:14}});
 assert.match(request('hover').contents.value,/この項の型/);
 const destination=request('definition').uri,expected=pathToFileURL(join(dir,'lib/api.nyan')).href;
 assert.equal(process.platform==='win32'?destination.toLowerCase():destination,process.platform==='win32'?expected.toLowerCase():expected);
 assert.ok(service.request('textDocument/completion',{textDocument:{uri},position:{line:1,character:14}}).some(c=>c.label==='lib.value'));
}));

test('server publishes errors in sibling files at their source and clears them after repair',()=>fixture({
 'main.nyan':'main = helper',
 'helper.nyan':'helper =\n  missingInside',
},(dir,put)=>{
 const input=new PassThrough(),output=new PassThrough(),messages=[];let buffer=Buffer.alloc(0);
 output.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);for(;;){const end=buffer.indexOf('\r\n\r\n');if(end<0)return;const count=Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0,end).toString())[1]);if(buffer.length<end+4+count)return;messages.push(JSON.parse(buffer.subarray(end+4,end+4+count)));buffer=buffer.subarray(end+4+count);}});
 const service=startServer(input,output,{exit:()=>{}}),uri=pathToFileURL(join(dir,'main.nyan')).href,helperURI=pathToFileURL(join(dir,'helper.nyan')).href;
 const send=(method,params={},id)=>{const body=Buffer.from(JSON.stringify({jsonrpc:'2.0',method,params,...(id===undefined?{}:{id})}));input.write(Buffer.concat([Buffer.from('Content-Length: '+body.length+'\r\n\r\n'),body]));};
 send('initialize',{},1);send('textDocument/didOpen',{textDocument:{uri,text:'main = helper',version:1}});
 assert.deepEqual(service.documents.get(uri).diagnostics,[]);
 const diagnostics=messages.filter(m=>m.method==='textDocument/publishDiagnostics');
 assert.deepEqual(diagnostics.find(m=>m.params.uri===uri).params.diagnostics,[]);
 const error=diagnostics.find(m=>m.params.uri===helperURI).params.diagnostics[0];assert.deepEqual(error.range.start,{line:1,character:2});assert.match(error.message,/missingInside/);
 put('helper.nyan','helper = nop');send('workspace/didChangeWatchedFiles',{changes:[{uri:helperURI,type:2}]});
 assert.deepEqual(messages.filter(m=>m.params?.uri===helperURI).at(-1).params.diagnostics,[]);
 input.destroy();output.destroy();
}));
