// Layout follows logical lines while diagnostics retain physical positions.
export const tokenLine = token => token?.logicalLine ?? token?.line;
export const tokenEndLine = token => token?.endLogicalLine ?? token?.endLine ?? tokenLine(token);
