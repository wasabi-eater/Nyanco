#!/usr/bin/env node
import {pathToFileURL} from 'node:url';
import {startServer} from './src/tooling/lsp.mjs';
export * from './src/tooling/lsp.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startServer();
