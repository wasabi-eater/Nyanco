import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {builtinNames,compile,VM} from '../language.mjs';
import {compileModule,standardTokens} from '../modules.mjs';
import {standardModule} from '../std-modules.mjs';
import {transpileGo} from '../go-backend.mjs';
import {LanguageService} from '../lsp.mjs';

function fixture(files,fn){const dir=mkdtempSync(join(tmpdir(),'nyanco-stdlib-'));try{for(const [name,source] of Object.entries(files)){const file=join(dir,name);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,source);}return fn(dir);}finally{rmSync(dir,{recursive:true,force:true});}}

test('std.prelude publicly reexports every existing standard word, class, type and effect',()=>{
 const definitions=compile('').definitions,prelude=standardModule('std.prelude');
 for(const names of [builtinNames(),[...definitions.keys()].filter(n=>!n.startsWith('__')),[...definitions.classes.keys()],[...definitions.methods.keys()],[...definitions.effects.keys()],[...definitions.constructors.keys()]])
  for(const name of names)assert.ok(prelude.exports.has(name),name);
 assert.equal(standardModule('std.vector').exports.get('map').internal,'vmap');
 assert.equal(standardModule('std.stream').exports.get('map').internal,'map');
 assert.equal(prelude.exports.get('vmap').internal,'vmap');
 assert.equal(prelude.exports.get('map').internal,'map');
 assert.doesNotThrow(()=>compileModule(fileURLToPath(new URL('../std/prelude.nyan',import.meta.url))));
});

test('qualified standard modules and implicit prelude work with values, types, classes and effects',()=>fixture({
 'main.nyan':`pub increment : std.vector int -> std.vector int
increment xs = std.vector.map xs {+ 1}
pub equal : std.classes.eq 'a => 'a 'a -> bool
equal = ==
pub fail : -> ! / {std.effects.exn}
fail = std.effects.exn "bad"
main = increment [1, 2]; vmap [3] {+ 1}; std.option.Some 5; equal 2 2; std.io.put "done"
`},dir=>{
 const p=compileModule(join(dir,'main.nyan')),output=[];
 new VM({...p,output:s=>output.push(s),warning:()=>{}}).evaluate('main');
 assert.deepEqual(output,['done']);
 assert.equal(p.modules.prelude.exports.get('vmap').internal,'vmap');
 assert.deepEqual(new VM(p).evaluate('increment [1, 2]'),[[2,3]]);
}));

test('pub import reexports selected standard members under new names',()=>fixture({
 'lib/main.nyan':`pub import "std.vector" {map as transform, vector}
pub use : vector int -> vector int
use xs = transform xs {+ 1}
`,
 'main.nyan':`import "./lib" as v
import "std.option" as opt
main = v.use [1, 2]; opt.Some 3
`},dir=>{
 const p=compileModule(join(dir,'main.nyan'));
 assert.deepEqual(new VM(p).evaluate('main')[0],[2,3]);
 assert.equal(p.modules.ordered[0].exports.get('transform').internal,'vmap');
}));

test('whole pub imports reexport all public symbols; private selections stay local',()=>fixture({
 'lib/main.nyan':`pub import "std.vector"
import "std.option" {map as localMap}
pub apply : vector int -> vector int
apply xs = map xs {+ 1}
`,
 'main.nyan':`import "./lib"
main = lib.map [1, 2] {+ 1}
`},dir=>{
 const entry=join(dir,'main.nyan'),p=compileModule(entry);
 assert.deepEqual(new VM(p).evaluate('main'),[[2,3]]);
 assert.ok(p.modules.ordered[0].exports.has('map'));
 assert.ok(!p.modules.ordered[0].exports.has('localMap'));
 writeFileSync(entry,'import "./lib"\nmain = lib.localMap (Some 1) {+ 1}\n');
 assert.throws(()=>compileModule(entry),/does not export localMap/);
}));

test('standalone compilation, CLI token rewriting, LSP and Go backend understand std names',()=>fixture({
 'main.nyan':`main = std.vector.map [1, 2] {+ 1}; print (std.option.Some 3)
`},dir=>{
 const entry=join(dir,'main.nyan'),p=compileModule(entry),output=[];
 new VM({...p,output:s=>output.push(s),warning:()=>{}}).evaluate('main');
 assert.deepEqual(output,['(Some 3)']);
 const previous=new Map();previous.moduleTokens=standardTokens;
 assert.deepEqual(new VM(compile('main = std.vector.map [1] {+ 1}','<single>',previous)).evaluate('main'),[[2]]);
 const service=new LanguageService(),uri=pathToFileURL(entry).href;service.update(uri,'main = std.vector.map [1, 2] {+ 1}',1);
 assert.equal(service.documents.get(uri).diagnostics.filter(d=>d.severity===1).length,0);
 assert.ok(service.request('textDocument/completion',{textDocument:{uri},position:{line:0,character:0}}).some(x=>x.label==='std.vector.map'));
 const go=join(dir,'main.go');writeFileSync(go,transpileGo(p));
 const run=spawnSync('go',['run',go],{encoding:'utf8',timeout:120000});assert.equal(run.status,0,run.stderr);assert.equal(run.stdout.trim(),output.join('\n'));
}));
