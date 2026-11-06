import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

test('browser tour assets run every lesson and handle edited input and code', async () => {
  execFileSync(process.execPath,[fileURLToPath(new URL('../tour/build.mjs',import.meta.url))]);
  const {lessons}=await import('../tour/dist/lessons.mjs');
  const {execute}=await import('../tour/dist/execute.mjs');
  const {renderHighlight}=await import('../tour/dist/runtime/syntax-highlight.mjs');
  const output=(source,input,files)=>{
    const lines=[];
    execute(source,input,event=>{if(event.kind==='output')lines.push(event.text);},files);
    return lines;
  };
  for (const {id,source,input,expected,files} of lessons) assert.deepEqual(output(source,input??'',files),expected,id);
  assert.deepEqual(output(lessons[0].source.replace('+ 3; * 2','* 2; + 3'),''),['13']);
  assert.match(output(lessons.find(lesson=>lesson.id==='input').source,'hello')[0],/Err/);
  const moduleLesson=lessons.find(lesson=>lesson.id==='imports');
  assert.deepEqual(output(moduleLesson.source,'',{'/math/api.nyan':moduleLesson.files['/math/api.nyan'].replace('x * x','x + 1')}),['8']);
  assert.throws(()=>output('main = 1 + True',''),/Type error/);
  assert.match(renderHighlight('when True do\n    print "猫"',(kind,text)=>kind?`[${kind}]${text}`:text),/\[keyword\]do/);
});
