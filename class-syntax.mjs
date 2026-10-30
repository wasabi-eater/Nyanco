import {lowerName} from './type-names.mjs';
// Constraints use postfix class names. Prefix spellings remain input aliases.
export function classConstraint(source,known=()=>false) {
  const words=source.trim().split(/\s+/);
  if(words.length<2)return null;
  const last=lowerName(words.at(-1)),first=lowerName(words[0]);
  const postfix=words[0].startsWith("'") || known(last) || !known(first) && !words.at(-1).startsWith("'");
  const name=postfix?last:first,args=postfix?words.slice(0,-1):words.slice(1);
  if(!/^[a-z][A-Za-z0-9_]*$/.test(name) || args.some(x=>!/^'?[a-z][A-Za-z0-9_']*$/.test(x)))return null;
  return {name,args};
}
