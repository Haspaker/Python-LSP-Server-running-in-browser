import 'monaco-editor/esm/vs/editor/edcore.main.js';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';

import { buildWorkerDefinition } from 'monaco-editor-workers';

import { createLanguageServer } from './server-interface';

import { StandaloneServices } from 'vscode/services';
import getNotificationServiceOverride from 'vscode/service-override/notifications';
import getDialogServiceOverride from 'vscode/service-override/dialogs';

StandaloneServices.initialize({
  ...getNotificationServiceOverride(document.body),
  ...getDialogServiceOverride()
});

buildWorkerDefinition('../../../node_modules/monaco-editor-workers/dist/workers/', new URL('', window.location.href).href, false);

monaco.languages.register({
  id: 'python',
  extensions: ['.py'],
  aliases: ['python'],
  mimetypes: ['application/text']
})

const editor = monaco.editor.create(document.getElementById('editor'), {
  model: monaco.editor.createModel(
    "a = 1 + 2",
    'python',
    monaco.Uri.parse('code.py')
  ),
});

async function start_server() {
  const server = await createLanguageServer('/files/pyodide-webworker.js', 'python');
  await server.writeSystemFile("/code.py", editor.getValue());
  await server.startClient();
  console.log("Server running...");
}

start_server()