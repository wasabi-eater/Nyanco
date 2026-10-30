import {lowerName} from './type-names.mjs';
// Current constraints use prefix class names; archived postfix input is accepted.
export function classConstraint(source,known=()=>false) {
  const words=source.match(/->|[\[\]{}():,|#!/]|'?[A-Za-z_][A-Za-z0-9_']*/g)||[];
  if(words.join('')!==source.replace(/\s/g,''))return null;
  if(words.length<2)return null;
  const last=lowerName(words.at(-1)),first=lowerName(words[0]);
  const postfix=words[0].startsWith("'") || known(last) && !known(first);
  const name=postfix?last:first,args=postfix?words.slice(0,-1):words.slice(1);
  if(!/^[a-z][A-Za-z0-9_]*$/.test(name))return null;
  return {name,args};
}
