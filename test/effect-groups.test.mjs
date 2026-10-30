import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {compile,VM} from '../migration/v048-adapter.mjs';
const state=`effect state 'a where
  ask : -> 'a
  write : 'a ->
`;
const handlers=`{ask: {-> k; resume value k}, write: {-> x k; value := x; resume k}}`;
test('group operations share a parameter and a single inferred effect family',()=>{
 const p=compile(state+`work = write 3; ask
main : -> num / {}
main = 0 -> mut value; handle {work} ${handlers}`);
 assert.match(p.types.get('work'),/state num/);assert.doesNotMatch(p.types.get('main'),/state/);
 assert.deepEqual(new VM(p).evaluate('main'),[3]);
 assert.throws(()=>compile(state+'bad = write 3; write "bad"'),/Cannot unify/);
 assert.throws(()=>compile(state+`main = "bad" -> mut value; handle {write 3; ask} ${handlers}`),/Cannot unify/);
});
test('partial handlers retain only unhandled operations and full handlers discharge annotations',()=>{
 const p=compile(state+`work : -> num / {state num}
work = write 3; ask
partial = handle {write 3; ask} {ask: {-> k; resume 0 k}}
main : -> num / {}
main = 0 -> mut value; handle {work} ${handlers}`);
 assert.match(p.types.get('partial'),/state num/);
 assert.deepEqual(new VM(p).evaluate('main'),[3]);
 assert.throws(()=>compile(state+`bad : -> num / {}
bad = handle {write 3; ask} {ask: {-> k; resume 0 k}}`),/Effect state is not allowed/);
});
test('group members may omit parameters used by other members and return bottom',()=>{
 const p=compile(`effect channel 'a where
  send : 'a ->
  closed : -> bool
  abort : string -> !
f = send 3; closed`);
 assert.match(p.types.get('f'),/channel num/);
 assert.throws(()=>compile("effect state 'a where\n  ask: -> bool"),/Unused/);
 assert.throws(()=>compile('effect state where\n  ask: -> num\n  ask: -> num'),/already used/);
 assert.throws(()=>compile('effect state where'),/indented/);
 assert.throws(()=>compile("effect state 'a where\n  ask: -> 'b"),/Unknown/);
});
test('group operations persist across incremental compilation',()=>{
 const p=compile(state),q=compile('f = write 4; ask','<next>',p.definitions);
 assert.match(q.types.get('f'),/state num/);
 assert.throws(()=>compile(state,'<next>',q.definitions),/already used/);
});
test('read and put can both be handled without host IO',()=>{
 const p=compile(`main : -> [string] / {}
main = [] -> mut logs;
  handle {put read; print 42} {read: {-> k; resume "input" k}, put: {-> s k; logs ! (:: s); resume k}}; logs`);
 const vm=new VM({...p,input:()=>{throw Error('host input');},output:()=>{throw Error('host output');}});
 assert.deepEqual(vm.evaluate('main'),[['input','42']]);
 assert.match(vm.infer('read'),/string.*io/);
});
test('REPL read consumes the next input line, including buffered input',()=>{
 const result=spawnSync(process.execPath,['cli.mjs'],{input:'read\nhello\nput read\n世界\n:q\n',encoding:'utf8',windowsHide:true,timeout:10000});
 assert.equal(result.status,0,result.stderr);assert.doesNotMatch(result.stdout,/Error:/);assert.match(result.stdout,/\["hello"\]/);assert.match(result.stdout,/世界/);
});
test('synchronous CLI reads lines, CRLF, Unicode, and EOF',()=>{
 const result=spawnSync(process.execPath,['cli.mjs','--eval','read; read; read'],{input:'一\r\ntwo\n',encoding:'utf8',windowsHide:true,timeout:10000});
 assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),'["一", "two", ""]');
});

test('generic handle wrappers preserve family parameters and partial handling',()=>{
 const p=compile(state+`withHandlers = handle
main : -> num / {}
main = 0 -> mut value; withHandlers {write 8; ask} ${handlers}`);
 assert.deepEqual(new VM(p).evaluate('main'),[8]);
 assert.throws(()=>compile(state+`withHandlers = handle
main = "bad" -> mut value; withHandlers {write 8; ask} ${handlers}`),/Cannot unify/);
});
test('annotations with an entire IO family require both handlers to prove purity',()=>{
 const prefix='work : -> string / {io}\nwork = read\n';
 assert.throws(()=>compile(prefix+'main : -> string / {}\nmain = handle {work} {read: {-> k; resume "x" k}}'),/Effect io is not allowed/);
 const p=compile(prefix+'main : -> string / {}\nmain = handle {work} {read: {-> k; resume "x" k}, put: {-> s k; resume k}}');
 assert.deepEqual(new VM(p).evaluate('main'),['x']);
});
test('async VM input and REPL initializers share the same effect driver',async()=>{
 const vm=new VM({input:async()=> 'async'});
 assert.deepEqual(await vm.evaluateAsync('read'),['async']);
 const result=spawnSync(process.execPath,['cli.mjs'],{input:'read -> name\nvalue\nname\n:q\n',encoding:'utf8',windowsHide:true,timeout:10000});
 assert.equal(result.status,0,result.stderr);assert.doesNotMatch(result.stdout,/Error:/);assert.match(result.stdout,/\["value"\]/);
});
