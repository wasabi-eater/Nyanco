// Run pre-vector fixtures through the current parser, checker and execution engines.
import * as current from '../language.mjs';
import {migrate} from './v048.mjs';
export * from '../language.mjs';
export const compile=(source,...args)=>current.compile(migrate(source),...args);
export const parseExpression=(source,...args)=>current.parseExpression(migrate(source),...args);
export class VM extends current.VM {
 evaluate(source,...args){return super.evaluate(migrate(source),...args);}
 evaluateAsync(source,...args){return super.evaluateAsync(migrate(source),...args);}
 infer(source,...args){return super.infer(migrate(source),...args);}
}
