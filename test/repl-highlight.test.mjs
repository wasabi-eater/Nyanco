import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {stripVTControlCharacters} from 'node:util';
import {highlight,createReplInterface} from '../repl-highlight.mjs';

test('REPL highlighting preserves unfinished syntax, Unicode, nested interpolation and escapes',()=>{
  const sources=['data option \'a = Some \'a | None',"'a' 'あ' '\\u{1f408}'",'3.14 + 2e-3; __1 $$ ~',
    '"hello {1 + {x: 2}.x} \\{x\\}" -- comment','"unfinished {Some "猫😀"}',':type while',':{',':}',
    'my_name _variable _1 $1 ..s -> bool / { | \'e}', 'x -- comment\ny'];
  for(const source of sources)assert.equal(stripVTControlCharacters(highlight(source)),source);
  assert.match(highlight('-- hello'),/\x1b\[90m-- hello/);
  assert.match(highlight('"{1 + 2}"'),/\x1b\[33m1/);
  assert.match(highlight('_1'),/\x1b\[95m_1/);
  assert.equal(highlight('my_name'),'my_name');
});

test('live REPL coloring keeps readline input, editing, history and cursor values intact',()=>{
  const input=new PassThrough(),output=new PassThrough();input.isTTY=output.isTTY=true;output.columns=20;
  input.setRawMode=()=>{};let display='';output.on('data',c=>display+=c);
  const oldTerm=process.env.TERM;process.env.TERM='xterm-256color';
  const rl=createReplInterface({input,output,color:true});const lines=[];rl.on('line',line=>lines.push(line));
  try{
    rl.setPrompt('nyanco> ');rl.prompt();
    for(const c of 'print "猫😀"')rl.write(c);
    assert.equal(rl.line,'print "猫😀"');assert.equal(rl.cursor,rl.line.length);
    assert.match(display,/\x1b\[32m/);
    rl.write(null,{name:'left'});rl.write(null,{name:'backspace'});rl.write('!');
    const edited=rl.line;rl.write(null,{name:'return'});assert.deepEqual(lines,[edited]);
    rl.write(null,{name:'up'});assert.equal(rl.line,edited);
  }finally{rl.close();if(oldTerm===undefined)delete process.env.TERM;else process.env.TERM=oldTerm;}
});

test('redirected REPL input does not emit ANSI styling',()=>{
  const input=new PassThrough(),output=new PassThrough();let display='';output.on('data',c=>display+=c);
  const rl=createReplInterface({input,output});
  rl.write('1 + 2');rl.close();assert.doesNotMatch(display,/\x1b/);
});
