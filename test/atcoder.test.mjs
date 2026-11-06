import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {compileModule} from '../modules.mjs';
import {VM} from '../language.mjs';
import {smallCases} from '../bench/atcoder-cases.mjs';

const fixtures=JSON.parse(readFileSync(new URL('./fixtures/atcoder-samples.json',import.meta.url),'utf8'));
for(const problem of fixtures){
  test(`${problem.id}: official samples and independent small-input oracle`,()=>{
    const file=fileURLToPath(new URL(`../examples/atcoder/${problem.id.replace('_','/')}/main.nyan`,import.meta.url));
    const program=compileModule(file);
    const cases=[...problem.samples.map((sample,i)=>({...sample,name:`sample-${i+1}`})),...smallCases(problem.id)];
    for(const data of cases){
      const lines=data.input.trimEnd().split('\n'),output=[];
      new VM({...program,input:()=>lines.shift(),output:s=>output.push(s)}).evaluate('main');
      assert.equal(output.join('\n')+'\n',data.output,`${problem.id}/${data.name}`);
    }
  });
}
