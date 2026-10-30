import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {migrate} from './migration/v048.mjs';
import {compile} from './language.mjs';
const [input,output]=process.argv.slice(2);
try {
 if(!input||!output)throw new Error('Usage: node migrate-v048.mjs OLD.hst NEW.hst');
 if(resolve(input)===resolve(output))throw new Error('Choose a different output path; the original is preserved');
 const source=migrate(await readFile(input,'utf8'));compile(source,output);
 await writeFile(output,source,{flag:'wx'});console.log(output);
}catch(error){console.error(error.message);process.exitCode=1;}
