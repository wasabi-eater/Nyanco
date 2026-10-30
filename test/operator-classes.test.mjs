import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM,format} from '../migration/v037-adapter.mjs';
const vec2=`data vec2 = int int Vec
instance add vec2 where
  (x y Vec) (u v Vec) (+) = (x + u); (y + v); Vec
instance mul vec2 where
  (x y Vec) (u v Vec) * = (x * u); (y * v); Vec
sum = +`;
const run=(p,s)=>format(new VM(p).evaluate(s));

test('ADT operator instances work for infix, missing operands and quotations',()=>{
  const p=compile(vec2);
  for(const expr of ['(1 2 Vec) + (3 4 Vec)','(1 2 Vec) (3 4 Vec) (+)',
    '(1 2 Vec) (+ (3 4 Vec))','(3 4 Vec) ((1 2 Vec) +)',
    '(1 2 Vec) (3 4 Vec) sum','(1 2 Vec) (3 4 Vec) {+} call'])
    assert.equal(run(p,expr),'[(Vec 4 6)]',expr);
  assert.equal(run(p,'(2 3 Vec) * (4 5 Vec)'),'[(Vec 8 15)]');
  assert.equal(run(p,'3 + 4'),'[7]');
  assert.match(p.types.get('sum'),/'a add =>/);
  assert.throws(()=>run(p,'(1 2 Vec) + 3'),/Type error/);
  assert.throws(()=>run(p,'True + False'),/No instance/);
});

test('operator instances propagate through higher order functions and closures',()=>{
  const p=compile(vec2+`\naddAll = {+} each
wrapped = {q: {+}}
main =
  (0 0 Vec) [(1 2 Vec); (3 4 Vec)] addAll
  (5 6 Vec) (1 2 Vec) wrapped.q call`);
  assert.equal(run(p,'main'),'[(Vec 4 6), (Vec 6 8)]');
});

test('custom operator class declarations allow symbols and primitive fallbacks',()=>{
  const p=compile(`data amount = int Amount
class 'a combine where
  (+) : 'a 'a -> 'a
instance combine amount where
  (x Amount) (y Amount) + = (x + y) Amount
combine : 'a combine => 'a 'a -> 'a
combine = +`);
  assert.equal(run(p,'(1 Amount) (2 Amount) combine'),'[(Amount 3)]');
  assert.equal(run(p,'1 2 combine'),'[3]');
});

const ordered=`data ticket = int int Ticket
instance eq ticket where
  (id _ Ticket) (other _ Ticket) == = id == other
  (id _ Ticket) (other _ Ticket) /= = id /= other
instance ord ticket where
  (id _ Ticket) (other _ Ticket) < = id < other
  (id _ Ticket) (other _ Ticket) <= = id <= other
  (id _ Ticket) (other _ Ticket) > = id > other
  (id _ Ticket) (other _ Ticket) >= = id >= other`;
test('equality and comparison chains select ADT instances and preserve short circuiting',()=>{
  const p=compile(ordered);
  assert.equal(run(p,'(1 2 Ticket) == (1 8 Ticket)'),'[True]');
  assert.equal(run(p,'(1 2 Ticket) /= (1 8 Ticket)'),'[False]');
  assert.equal(run(p,'(1 0 Ticket) < (2 0 Ticket) <= (3 0 Ticket)'),'[True]');
  assert.equal(run(p,'(2 0 Ticket); (1 0 Ticket) < <= (3 0 Ticket)'),'[True]');
  const output=[],vm=new VM({...p,output:s=>output.push(s)});
  assert.deepEqual(vm.evaluate('(3 0 Ticket) < (2 0 Ticket) < ("bad" print; 4 0 Ticket)'),[false]);
  assert.deepEqual(output,[]);
  assert.equal(run(p,'[1 2] == [1 2]'),'[True]');
  assert.equal(run(p,'{x: 1} == {x: 1}'),'[True]');
});

test('append preserves list concatenation while supporting ADTs',()=>{
  const p=compile(`data bag = [int] Bag
instance append bag where
  (xs Bag) (ys Bag) ++ = (xs ++ ys) Bag`);
  assert.equal(run(p,'([1] Bag) ++ ([2 3] Bag)'),'[(Bag [1, 2, 3])]');
  assert.equal(run(p,'[1] ++ [2]'),'[[1, 2]]');
});

test('invalid or overlapping operator instances fail before execution',()=>{
  assert.throws(()=>compile('instance add int where\n  + = drop'),/Primitive operator instance/);
  assert.throws(()=>compile("class 'a Wrong where\n  + : 'a -> 'a"),/requires/);
  assert.throws(()=>compile('data box = int Box\ninstance add box where\n  + = drop drop True'),/Type error/);
  assert.throws(()=>compile("class 'a A where\n  + : 'a 'a -> 'a\nclass 'a B where\n  + : 'a 'a -> 'a"),/already used/);
  assert.throws(()=>compile('data box = int Box\ninstance eq box where\n  == = drop drop True'),/Missing instance method/);
});

test('REPL instance additions preserve previous definitions and primitive operators',()=>{
  const p=compile('data box = int Box\nplus = +');
  const next=compile('instance add box where\n  (x Box) (y Box) + = (x + y) Box','<repl>',p.definitions);
  assert.equal(run(next,'(1 Box) (2 Box) plus'),'[(Box 3)]');
  assert.equal(run(p,'1 2 plus'),'[3]');
  assert.throws(()=>run(p,'(1 Box) (2 Box) plus'),/Type error/);
});

test('standard operator constraints can be used without declaring an ADT instance',()=>{
  const p=compile("plus : 'a add => 'a 'a -> 'a\nplus = +");
  assert.equal(run(p,'2 3 plus'),'[5]');
  assert.match(p.types.get('plus'),/'a add =>/);
  assert.throws(()=>run(p,'True False plus'),/No instance/);
});

test('standard operator classes are inferred before any instance is declared',()=>{
  const vm=new VM(compile('f = +\nlocal =\n  inner = +\n  inner'));
  const expected="'a add => ..s 'a 'a -- ..s 'a";
  assert.equal(new VM().infer('+'),"'a num => ..s 'a 'a -- ..s 'a");
  assert.equal(vm.infer('f'),expected);
  assert.equal(vm.infer('local'),expected);
  assert.equal(vm.infer('3 +'),'..s int -- ..s int');
  assert.deepEqual(vm.evaluate('2 3 f'),[5]);
  assert.throws(()=>vm.evaluate('True False f'),/No instance/);
});
