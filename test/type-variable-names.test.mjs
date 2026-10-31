import test from 'node:test';
import assert from 'node:assert/strict';
import {VM,compile} from '../language.mjs';
import {formatType,typeIR} from '../types.mjs';

test('inferred value variables use letters and retain shared identities',()=>{
  const vm=new VM();
  assert.equal(vm.infer('swap'),"..s 'b 'a -> ..s 'a 'b");
  assert.match(vm.infer('from'),/^into 'a 'b => \.\.s 'a -> \.\.s 'b/);
  assert.equal(vm.infer('dup'),"..s 'a -> ..s 'a 'a");
  assert.equal(compile('f = swap').types.get('f'),vm.infer('swap'));
});

test('alphabetic names continue past z and reset for each signature',()=>{
  const items=Array.from({length:28},()=>typeIR.variable());
  const tuple={tag:'tuple',items,tail:{tag:'tuple-end'}};
  const expected='#('+Array.from({length:26},(_,i)=>"'"+String.fromCharCode(97+i)).concat(["'aa","'ab"]).join(' ')+')';
  assert.equal(formatType(tuple),expected);
  assert.equal(formatType(tuple),expected);
  assert.equal(formatType(items[27]),"'a");
});

test('value names do not collide with unchanged effect, record or tuple row names',()=>{
  const items=Array.from({length:21},()=>typeIR.variable());
  const tuple={tag:'tuple',items,tail:typeIR.variable('tuple-row')};
  const record={tag:'record',row:typeIR.variable('record-row')};
  const s=typeIR.row();
  const q=typeIR.quote(typeIR.stack(s,tuple,record),s,typeIR.variable('effect-row'));
  const text=formatType(q);
  assert.match(text,/\| 'e/);assert.match(text,/\| 'r/);assert.match(text,/\| 't/);
  for(const name of ["'e","'r","'t"])assert.equal(text.split(name).length-1,1,text);
  assert.match(text,/'d 'f/);assert.match(text,/'q 's 'u/);
  assert.match(text,/-> \.\.s/);
});
