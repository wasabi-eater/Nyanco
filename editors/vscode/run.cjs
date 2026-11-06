const path = require('node:path');

exports.registerRun = function (vscode, context) {
  context.subscriptions.push(vscode.commands.registerCommand('nyanco.runFile', async (uri) => {
    try {
      const active = vscode.window.activeTextEditor?.document;
      const doc = typeof uri === 'string' && active?.uri?.toString() !== uri
        ? await vscode.workspace.openTextDocument(vscode.Uri.parse(uri))
        : active;
      if (!doc || doc.languageId !== 'nyanco') return;
      if (doc.isUntitled || doc.isDirty) {
        if (!await doc.save()) return;
      }
      if (doc.uri.scheme !== 'file') {
        await vscode.window.showErrorMessage('Nyanco: Save the file locally before running it.');
        return;
      }
      const config = vscode.workspace.getConfiguration('nyanco', doc.uri);
      const server = config.get('serverPath') || path.resolve(context.extensionPath, '../../lsp.mjs');
      const cli = config.get('cliPath') || path.join(path.dirname(server), 'cli.mjs');
      const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
      const task = new vscode.Task(
        { type: 'nyanco', file: doc.fileName },
        folder || vscode.TaskScope.Global,
        `Run ${path.basename(doc.fileName)}`, 'Nyanco',
        new vscode.ProcessExecution(config.get('nodePath') || 'node', [cli, doc.fileName],
          folder ? {cwd: path.dirname(doc.fileName)} : {})
      );
      task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, focus: true, clear: true };
      await vscode.tasks.executeTask(task);
    } catch (error) {
      await vscode.window.showErrorMessage(`Nyanco: ${error.message}`);
    }
  }));
};
