import {readSync} from 'node:fs';
export function readLine() {
  const bytes=[],buffer=Buffer.alloc(1);
  while(readSync(0,buffer,0,1,null)) {if(buffer[0]===10)break;bytes.push(buffer[0]);}
  if(bytes.at(-1)===13)bytes.pop();
  return Buffer.from(bytes).toString('utf8');
}
