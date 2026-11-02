import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM,format} from '../language.mjs';
import {compileModule} from '../modules.mjs';
import {LanguageService} from '../lsp.mjs';
import {transpileGo} from '../go-backend.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const source=`speak {name: ~} = print
projection = .name; print
greet {:name, :age} = "{name}/{age}"
subtractFields {b: ~, a: ~} = -
nested {user: Some({name: ~}), tags: [first _]} = print first; print
positive {value: ~} | $ > 0 = + 1 | otherwise = 0 -
category {age: 0} = "baby"
category {age: _} = "older"
choose = case
  -> {kind: "cat", user: Some({:name})} ? name
  -> {kind: _, user: _} ? "other"
bump {count: mut n} = n ! + 1; n
empty {:} = 7
main =
 speak {name: "Nyanco", extra: True}
 print (greet {name: "Cat", age: 3, extra: True})
 print (subtractFields {a: 3, b: 10, extra: True})
 nested {user: Some({name: "nested", age: 4}), tags: ["tag", "ignored"], extra: 1}
 print (positive {value: 4}); print (positive {value: -2})
 print (category {age: 0}); print (category {age: 3})
 print (choose {kind: "cat", user: Some({name: "matched", extra: True})})
 print (choose {kind: "dog", user: None})
 {name: "bound", age: 4, extra: True} -> {:name, :age}
 print ({:name, :age}); print ({:name, years: age,})
 #({x: 2}, Some({y: 3})) -> #({x: ~} Some({y: ~})); -; print
 {count: 5} -> {count: mut n}; n ! + 1; print n
 print (bump {count: 8, other: True})
 print (empty {:}); print (empty {x: 1})
 local {:name} = name ++ "!";; print (local {name: "local", extra: 1})
 {first: "multi", second: 6} -> {
   :first,
   :second
 }
 print ({:first, :second})
 localMult {
   :label,
   value: ~
 } = print label; print;; localMult {label: "multi-local", value: 7}
`;
const run=s=>{const p=compile(s),output=[],vm=new VM({...p,output:s=>output.push(s),warning:()=>{}});return {p,vm,output,stack:vm.evaluate('main')};};
const expected=['Nyanco','Cat/3','7','tag','nested','5','2','baby','older','matched','other','{age: 4, name: "bound"}','{name: "bound", years: 4}','-1','6','9','7','7','local!','{first: "multi", second: 6}','multi-local','7'];

test('record patterns project open rows and preserve tilde order and named bindings',()=>{
 const {vm,output}=run(source);assert.deepEqual(output,expected);
 assert.equal(vm.infer('speak'),vm.infer('projection'));
 assert.match(vm.infer('greet'),/age:.*name:.*\| 'r/);
 assert.equal(format(run('main = "x" -> name; {:name}').stack),'[{name: "x"}]');
 assert.deepEqual(run('main = {x: 1, y: 2} -> {x: a, y: b}; a, b').stack,[1,2]);
});

test('record patterns reject invalid syntax and types and roll back failed bindings',()=>{
 for(const pattern of ['{x: a, x: b}','{x: a, y: a}','{x}','{x: a y: b}','{:x, :x}'])assert.throws(()=>compile('f '+pattern+' = nop'),/Duplicate|Expected/);
 assert.throws(()=>compile('f {name: x} = x\nmain = f {age: 3}'),/record|field/i);
 assert.throws(()=>compile('f {name: x} = x\nmain = f #(1)'),/unify/);
 assert.throws(()=>compile('main = {:missing}'),/Unknown/);
 const vm=new VM(),value={kind:'record',fields:{tag:'dog',keep:1}},stack=[value];
 assert.throws(()=>vm.evaluate('-> {tag: "cat"}',stack),/pattern did not match/);assert.deepEqual(stack,[value]);
});

function native(p,output,dir){const file=join(dir,'main.go');writeFileSync(file,transpileGo(p));const result=spawnSync('go',['run',file],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,output.join('\n')+'\n');}
test('native record patterns and record puns match VM behavior',()=>{
 const dir=mkdtempSync(join(tmpdir(),'nyanco-record-patterns-'));try{const {p,output}=run(source);native(p,output,dir);}finally{rmSync(dir,{recursive:true,force:true});}
});

test('module name resolution preserves shorthand keys and pattern local names',()=>{
 const dir=mkdtempSync(join(tmpdir(),'nyanco-record-modules-'));
 try{
  mkdirSync(join(dir,'lib'));writeFileSync(join(dir,'lib/api.nyan'),`name = "module"
age = 9
pub stored : -> {name: string, age: int}
stored = {:name, :age}
pub interpolated : -> string
interpolated = "record={ {:name} }"
pub echo : {name: 'a, age: 'b | 'r} -> {name: 'a, age: 'b}
echo {:name, :age} = {:name, :age}
pub speak : ..s {name: 'a | 'r} -> ..s / {io}
speak {name: ~} = print
`);
  const entry=join(dir,'main.nyan');writeFileSync(entry,'import "./lib"\nmain = print lib.stored; print (lib.echo {name: "x", age: 1, extra: True}); lib.speak {name: "hello", extra: 1}; print lib.interpolated');
  const p=compileModule(entry),output=[];new VM({...p,output:s=>output.push(s),warning:()=>{}}).evaluate('main');assert.deepEqual(output,['{age: 9, name: "module"}','{age: 1, name: "x"}','hello','record={name: "module"}']);native(p,output,dir);
  const service=new LanguageService(),uri='file:///record-patterns.nyan',text='name = "global"\nf {:name} = name';
  assert.deepEqual(service.update(uri,text,1).diagnostics,[]);
  assert.equal(service.request('textDocument/hover',{textDocument:{uri},position:{line:1,character:13}}),null);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
