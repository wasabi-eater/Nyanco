import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../language.mjs';

test('while displays handled break in both callback rows, but not its outward row',()=>{
 const type=new VM().infer('while');
 assert.equal(type,"..s1 { ..s1 -- ..s bool / {break | 'e1} } { ..s -- ..s1 / {break | 'e} } -- ..s / { | 'e, 'e1}");
});
test('a wrapper preserves the callback handling information',()=>{
 const p=compile('loop = while {True} _');
 assert.equal(p.types.get('loop'),"..s { ..s -- ..s / {break | 'e} } -- ..s / { | 'e}");
});
test('display does not claim to handle a callback also invoked outside the loop',()=>{
 const p=compile('f q = while {False} q; call q');
 assert.doesNotMatch(p.types.get('f'),/break/);
 const vm=new VM(p);assert.throws(()=>vm.evaluate('f {break}'),/Unhandled effect: break/);
});
test('displaying accepted effects does not contaminate actual pure or handled computations',()=>{
 const p=compile('pure : -> num / {}\npure = 0; while {$ < 3} {+ 1}\nstop = 0; while {True} {break}\nmain = pure; stop');
 assert.doesNotMatch(p.types.get('pure'),/break/);assert.doesNotMatch(p.types.get('stop'),/break/);
 const vm=new VM(p);assert.deepEqual(vm.evaluate('main'),[3,0]);
 vm.infer('while');assert.deepEqual(vm.evaluate('main'),[3,0]);
});
test('mask still forwards break beyond a loop instead of silently treating it as handled',()=>{
 const p=compile('f q = while {False} q; mask break {call q}');assert.doesNotMatch(p.types.get('f'),/\{break \|/);
});

test('a handler callback that forwards the same row prevents a false handled display',()=>{
 const p=compile('effect ask : ->\nf q = while {False} q; handle {ask} {ask: {-> k; call q; resume k}}');
 assert.doesNotMatch(p.types.get('f'),/\{break \|/);
});
