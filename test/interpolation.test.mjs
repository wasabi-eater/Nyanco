import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM,lex} from '../language.mjs';
import {transpileGo} from '../go-backend.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const run=source=>{const p=compile(source),output=[],vm=new VM({...p,output:s=>output.push(s),warning:()=>{}});return {p,output,stack:vm.evaluate('main')};};
const source=String.raw`class zero 'a where
  zero : -> 'a
instance zero num where
  zero = 0
data user = User string
instance show user where
  show (User name) = "user:{name}"
fmt = "{} {}"
main =
  print ("{} {}" 3 4);
  print "3 * 4 = {3 * 4}";
  print "\{\}";
  print (fmt "raw" True);
  "Ada" -> name; print "hello {name}";
  print "nested {"{}" 7}";
  print "record {({x: 12}).x}";
  print ("{}" (User "Bob"));
  print "key={zero + 0}";
  print "effects={print "once"; 42}";
  3; print "square={_ * _}";
  print "unicode=日本😀\nline";
  print (toVector (map (1 ..= 3) {"item={_}"}));
  print (handle @a {"ask={ask@a}"} {ask: {-> k; resume 9 k}})
effect ask : -> num`;
test('interpolation evaluates expressions and consumes empty slots in stack order',()=>{
 assert.deepEqual(run(source).output,['3 4','3 * 4 = 12','{}','raw True','hello Ada','nested 7','record 12','user:Bob','key=0','once','effects=42','square=9','unicode=日本😀\nline','["item=1", "item=2", "item=3"]','ask=9']);
 assert.deepEqual(run('main = 99, 3, 4; "{} {}"').stack,[99,'3 4']);
 assert.deepEqual(run('main = "{1} {} {2} {}" 3 4').stack,['1 3 2 4']);
 assert.deepEqual(run('main = 3; "{_}:{_}"').stack,['3:3']);
 assert.deepEqual(run('main = "{3; _ * _}"').stack,['9']);
});
test('escapes and nesting remain literal when requested',()=>{
 assert.deepEqual(run(String.raw`main = "\{3 * 4\}"; "\\{3}"; "\u007b\u007d"; "{ "a\"b" }"`).stack,['{3 * 4}','\\3','{}','a"b']);
 assert.deepEqual(run('main = "{1 -- ignore } and quotes \\\"\n}"').stack,['1']);
 assert.deepEqual(run(String.raw`main = "{ "inner={3}" }"`).stack,['inner=3']);
});
test('interpolation infers show constraints and effects and rejects malformed or non-single expressions',()=>{
 const p=compile('f = "{}"\ng = "{print 1; 2}"');assert.match(p.types.get('f'),/show 'a =>/);assert.match(p.types.get('g'),/io/);
 assert.throws(()=>run('main = "{} {}" 1'),/underflow/i);
 for(const body of ['nop','1,2','+'])assert.throws(()=>compile(`main = "{${body}}"`),/consume 0.*produce 1|underflow|unify/i);
 for(const source of ['"{1"','"x}"',String.raw`"\q"`])assert.throws(()=>lex(source),/Unterminated|Unescaped|Invalid/);
 assert.throws(()=>compile('main = "value={missingName}"','interpolation.hst'),/interpolation.hst:1:16:.*Unknown word/);
 assert.deepEqual(run('main = handle {"{exn "no"}"} {exn: {-> message k; "caught"}}').stack,['caught']);
});
test('native interpolation agrees with VM including custom show, nested syntax and effects',()=>{
 const {p,output}=run(source),dir=mkdtempSync(join(tmpdir(),'hst-interpolation-'));
 try{const file=join(dir,'main.go'),exe=join(dir,'main.exe');writeFileSync(file,transpileGo(p));const build=spawnSync('go',['build','-o',exe,file],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(build.status,0,build.stderr);const result=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,output.join('\n')+'\n');}finally{rmSync(dir,{recursive:true,force:true});}
});
