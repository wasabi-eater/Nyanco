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
import {LanguageService} from '../lsp.mjs';

function fixture(files,fn){const dir=mkdtempSync(join(tmpdir(),'nyanco-modules-'));try{const put=(file,text)=>{const path=join(dir,file);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,text);return path;};for(const [file,text] of Object.entries(files))put(file,text);return fn(dir,put);}finally{rmSync(dir,{recursive:true,force:true});}}
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
pub notify = alert "notice"
pub record = {privateHelper: 1} with privateHelper = 9
pub interpolate x = "value={privateHelper x}"
effect hiddenAsk : -> int
pub handled = handle {hiddenAsk} {hiddenAsk: {-> k; resume 11 k}}
pub hiddenBody = {hiddenAsk}
pub handlers = {hiddenAsk: {-> k; resume 12 k}}
privateIndex = 0
pub indexed = ([1] with [privateIndex] ! + 2).[0]
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
 'a/a.nyan':'import "../common"\nprivate n = n + 1\npub run = private common.value',
 'b/b.nyan':'import "../common"\nprivate n = n * 2\npub run = private common.value',
 'common/value.nyan':'print "initialize"; 0 -> marker\npub value = 3',
},(dir)=>{
 const {vm,output,p}=run(join(dir,'main.nyan'));assert.deepEqual(vm.evaluate('main'),[4,6]);assert.deepEqual(output,['initialize']);assert.equal(p.modules.ordered.length,4);
}));

test('cycles invalid imports duplicates and cyclic aliases fail without executing',()=>fixture({'main.nyan':'import "./lib"\nmain = nop','lib/a.nyan':'import ".." as app\npub f = nop'},(dir,put)=>{
 assert.throws(()=>compileModule(join(dir,'main.nyan')),/Cyclic module import/);
 put('lib/a.nyan','pub f = nop');put('main.nyan','import "./lib" as x\nimport "./lib" as x\nmain = nop');assert.throws(()=>compileModule(join(dir,'main.nyan')),/duplicate module alias/);
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

test('type and value namespaces preserve visibility separately and classes may share method names',()=>fixture({
 'lib/a.nyan':`pub class zero 'a where
  zero : -> 'a
instance zero int where
  zero = 0
pub type hidden = int
hidden = 10
pub value = 1
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
