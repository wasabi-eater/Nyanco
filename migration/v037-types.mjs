export {StaticTypeError} from '../types.mjs';
import {checkExpression as check,inferExpression as infer} from '../types.mjs';
import {legacyType} from './v037-adapter.mjs';
export function checkExpression(nodes,definitions,...rest){return legacyType(check(nodes,definitions,...rest),definitions);}
export function inferExpression(nodes,definitions,...rest){return legacyType(infer(nodes,definitions,...rest),definitions);}
