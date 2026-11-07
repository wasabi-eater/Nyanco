import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../language.mjs';

test('while displays handled cancel in both callback rows, but not its outward row',()=>{
 const type=new VM().infer('while');
 assert.equal(type,"..s1 { ..s1 -> ..s bool / {break (..s), cancel | 'e1} } { ..s -> ..s1 / {break (..s), cancel | 'e} } -> ..s / { | 'e, 'e1}");
});
test('a wrapper preserves the callback handling information',()=>{
 const p=compile('loop = while {True} _');
 assert.equal(p.types.get('loop'),"..s { ..s -> ..s / {break (..s), cancel | 'e} } -> ..s / { | 'e}");
});
test('display does not claim to handle a callback also invoked outside the loop',()=>{
 const p=compile('f q = while {False} q; call q');
 assert.doesNotMatch(p.types.get('f'),/cancel/);
 const vm=new VM(p);assert.throws(()=>vm.evaluate('f {cancel}'),/Unhandled effect: cancel/);
});
test('displaying accepted effects does not contaminate actual pure or handled computations',()=>{
 const p=compile('pure : -> int / {}\npure = 0; while {$ < 3} {+ 1}\nstop = 0; while {True} {cancel}\nmain = pure; stop');
 assert.doesNotMatch(p.types.get('pure'),/cancel/);assert.doesNotMatch(p.types.get('stop'),/cancel/);
 const vm=new VM(p);assert.deepEqual(vm.evaluate('main'),[3,0]);
 vm.infer('while');assert.deepEqual(vm.evaluate('main'),[3,0]);
});
test('mask still forwards cancel beyond a loop instead of silently treating it as handled',()=>{
 const p=compile('f q = while {False} q; mask cancel {call q}');assert.doesNotMatch(p.types.get('f'),/\{cancel \|/);
});

test('a handler callback that forwards the same row prevents a false handled display',()=>{
 const p=compile('effect ask : ->\nf q = while {False} q; handle {ask} {ask: {-> k; call q; resume k}}');
 assert.doesNotMatch(p.types.get('f'),/\{cancel \|/);
});

test('handler wrappers display accepted operations and preserve the residual row',()=>{
 const p=compile(`effect ask : -> int
recover = handle _ {exn: {drop; drop; 0}}
answer = handle _ {ask: {-> k; resume 3 k}}
main = recover {exn "bad"}; recover {7}; answer {ask; + 1}; recover {print "ok"; 8}
`);
 assert.equal(p.types.get('recover'),"..s { ∅ -> int / {exn | 'e} } -> ..s int / { | 'e}");
 assert.equal(p.types.get('answer'),"..s1 { ∅ -> ..s / {ask | 'e} } -> ..s1 ++ ..s / { | 'e}");
 assert.match(p.types.get('catch'),/\{exn \| 'e\}.*\/ \{ \| 'e\}$/);
 assert.match(p.types.get('main'),/\/ \{io\}$/);
 const output=[],vm=new VM({...p,output:line=>output.push(line)});
 assert.equal(vm.infer('recover'),p.types.get('recover'));
 assert.deepEqual(vm.evaluate('main'),[0,7,4,8]);
 assert.deepEqual(output,['ok']);
});

test('handled families are displayed with shared parameters only when fully covered',()=>{
 const p=compile(`partial = handle _ {read: {-> k; resume "in" k}}
full = handle _ {read: {-> k; resume "in" k}, put: {-> x k; resume k}}
`);
 assert.doesNotMatch(p.types.get('partial'),/\bio\b/);
 assert.match(p.types.get('full'),/\{io \| 'e\}.*\/ \{ \| 'e\}$/);
 assert.match(p.types.get('withHeap'),/\(heap 'a\).*\{worklist 'a \| 'e\}.*\/ \{ \| 'e\}$/);
});

test('unprotected uses of the input quotation prevent a handled effect display',()=>{
 const p=compile(`twice q = handle q {exn: {drop; drop}}; call q
clause q = handle q {exn: {drop; drop; call q}}
masked q = handle {mask exn {call q}} {exn: {drop; drop}}
deferred q = handle q {exn: {drop; drop}}; {call q}
`);
 for(const name of ['twice','clause','masked','deferred'])assert.doesNotMatch(p.types.get(name),/\bexn\b/,name);
});
