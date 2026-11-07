// Source first. Unprefixed transforms are lazy; v-prefixed transforms collect.
const modes=['map','filter','takeWhile','skipWhile','take','skip','flatMap','flatten'];
export const streamTransforms=new Map(modes.map(n=>[n,n]));
export const vectorTransforms=new Map(modes.filter(n=>!['map','filter'].includes(n)).map(n=>['v'+n,n]));
export const transforms=new Map([...streamTransforms,...vectorTransforms]);
export const countTransform=mode=>mode==='take'||mode==='skip';
export const predicateTransform=mode=>['filter','takeWhile','skipWhile'].includes(mode);
export const callbackTransform=mode=>!countTransform(mode)&&mode!=='flatten';
