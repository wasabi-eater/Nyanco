import {preludeSource} from './prelude-source.mjs';

let files = new Map();
let moduleIds = new Map();
export function setVirtualFiles(entries) {
  files = new Map(Object.entries(entries));
  moduleIds = new Map();
}

export function resolve(...parts) {
  const segments=[];
  for (const part of parts) {
    if (part.startsWith('/')) segments.length=0;
    for (const item of part.split('/')) {
      if (item === '..') segments.pop();
      else if (item && item !== '.') segments.push(item);
    }
  }
  return '/'+segments.join('/');
}
export const join=resolve;
export const dirname=file=>file.slice(0,file.lastIndexOf('/'))||'/';
export const basename=file=>file.split('/').at(-1);
export const fileURLToPath=url=>decodeURIComponent(new URL(url).pathname);
export const pathToFileURL=file=>new URL('file://'+file.split('/').map(encodeURIComponent).join('/'));

const isDirectory = path => path === '/' || [...files.keys()].some(file=>file.startsWith(path+'/'));
export const existsSync=path=>files.has(path)||isDirectory(path);
export function statSync(path) {
  if (!existsSync(path)) throw new Error('Unknown virtual path: '+path);
  return {isDirectory:()=>isDirectory(path)};
}
export function realpathSync(path) {
  statSync(path);
  return path;
}
export function readdirSync(path) {
  return [...files.keys()].filter(file=>dirname(file)===path)
    .map(file=>({name:basename(file),isFile:()=>true}));
}
export function readFileSync(path) {
  if (path instanceof URL && path.pathname.endsWith('/std/prelude.nyan')) return preludeSource;
  if (!files.has(path)) throw new Error('Unknown virtual file: '+path);
  return files.get(path);
}

// Module prefixes only need to be unique within one compilation in the tour.
export function createHash() {
  return {update(path) {
    if (!moduleIds.has(path)) moduleIds.set(path,moduleIds.size+1);
    return {digest:()=>moduleIds.get(path).toString(16).padStart(12,'0')};
  }};
}
