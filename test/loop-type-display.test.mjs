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
