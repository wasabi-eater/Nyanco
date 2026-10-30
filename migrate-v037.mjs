import {readFile,writeFile} from 'node:fs/promises';
import {migrateSource} from './migration/v037.mjs';
import {migrate} from './migration/v048.mjs';
import {compile} from './language.mjs';
const [input,output]=process.argv.slice(2);
if(!input||!output){console.error('Usage: node migrate-v037.mjs OLD.hst NEW.hst');process.exitCode=1;}
else {const source=migrate(migrateSource(await readFile(input,'utf8'),input).source);compile(source,output);await writeFile(output,source);console.log(output);}
