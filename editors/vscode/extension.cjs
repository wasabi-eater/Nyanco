const vscode = require('vscode');
const path = require('node:path');
const { LanguageClient } = require('vscode-languageclient/node');
let client;

exports.activate = async function (context) {
  require('./run.cjs').registerRun(vscode, context);
  const config = vscode.workspace.getConfiguration('nyanco');
  client = new LanguageClient('nyanco', 'Nyanco Language Server', {
    command: config.get('nodePath') || 'node',
    args: [config.get('serverPath') || path.resolve(context.extensionPath, '../../lsp.mjs')]
  }, {
    documentSelector: [{ scheme: 'file', language: 'nyanco' }],
    synchronize: {fileEvents: vscode.workspace.createFileSystemWatcher('**/*.nyan')}
  });
  await client.start();
};

exports.deactivate = async function () {
  if (client) await client.stop();
};
