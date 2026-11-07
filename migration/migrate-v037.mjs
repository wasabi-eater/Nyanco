import {readFile,writeFile} from 'node:fs/promises';
import {migrateSource} from './v037.mjs';
import {migrate} from './v048.mjs';
import {compile} from '../src/frontend/language.mjs';
const [input,output]=process.argv.slice(2);
if(!input||!output){console.error('Usage: node migrate-v037.mjs OLD.nyan NEW.nyan');process.exitCode=1;}
else {const source=migrate(migrateSource(await readFile(input,'utf8'),input).source);compile(source,output);await writeFile(output,source);console.log(output);}
