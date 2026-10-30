import {transpileGo as transpile} from '../go-backend.mjs';
import {parseExpression} from './v037-adapter.mjs';
export function transpileGo(program,options={}){return transpile(program,{...options,entryNodes:parseExpression(options.expression||'main','<entry>',program.definitions.constructors)});}
