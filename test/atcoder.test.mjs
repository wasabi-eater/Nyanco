import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {compileModule} from '../modules.mjs';
import {VM} from '../language.mjs';
import {problemIDs,smallCases} from '../bench/atcoder-cases.mjs';

for(const id of problemIDs){
  test(`${id}: generated inputs with an independent oracle`,()=>{
    const file=fileURLToPath(new URL(`../examples/atcoder/${id.replace('_','/')}/main.nyan`,import.meta.url));
    const program=compileModule(file);
    for(const data of smallCases(id)){
      const lines=data.input.trimEnd().split('\n'),output=[];
      new VM({...program,input:()=>lines.shift(),output:s=>output.push(s)}).evaluate('main');
      assert.equal(output.join('\n')+'\n',data.output,`${id}/${data.name}`);
    }
  });
}
