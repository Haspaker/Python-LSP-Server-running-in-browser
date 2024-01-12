import { MonacoLanguageClient, MonacoServices } from 'monaco-languageclient';
import { AbstractMessageWriter, AbstractMessageReader } from "vscode-jsonrpc";
import { CloseAction, ErrorAction } from 'vscode-languageclient';

class MessageWriter extends AbstractMessageWriter {

    constructor(worker) {
      super();
      this.worker = worker;
    }
  
    async write(msg) {
      const content = JSON.stringify(msg);
      this.worker.postMessage(content);
    }
  
}
  
class MessageReader extends AbstractMessageReader {

  constructor(worker) {
    super();
    this.worker = worker;
  }

  listen(callback) {
    this.worker.addEventListener('message', (event) => {
      // Magic character @ reserved for other communication with the webworker
      if (event.data.startsWith('@'))
        return;

      const data = JSON.parse(event.data);
      callback(data);
    });
    return {
        dispose: () => { }
    };
  }

}

class ServerInterface {

    constructor(worker, language_client) {
        this.worker = worker;
        this.monacoLanguageClient = language_client;
        this.workerCommandCount = 0;
    }

    async postCommand(command, json_payload) {
        const command_idx = this.workerCommandCount;
        const abort_controller = new AbortController();
        this.workerCommandCount += 1;

        return new Promise(resolve => {
            this.worker.addEventListener('message', event => {
                if (!event.data.startsWith(`@done:${command_idx}`))
                    return;
                abort_controller.abort();
                resolve();
            });

            json_payload._idx = command_idx;
            const json_payload_str = JSON.stringify(json_payload);
            this.worker.postMessage(`@${command}:${json_payload_str}`);
        });
    }

    async writeSystemFile(name, contents) {
        await this.postCommand('write-file', {name, contents});
    }

    async populateFileSystemFromZipArchive(zip_url) {
        await this.postCommand('unpack-zip', {url: zip_url});
    }

    async executePython(code) {
        await this.postCommand('execute-python', {code});
    }

    async startClient() {
        await this.monacoLanguageClient.start();
    }
}

const createLanguageClient = (document_selector, transports) => {
  return new MonacoLanguageClient({
      name: 'Monaco Language Client',
      clientOptions: {
          // use a language id as a document selector
          documentSelector: [document_selector],
          // disable the default error handler
          errorHandler: {
              error: () => ({ action: ErrorAction.Continue }),
              closed: () => ({ action: CloseAction.DoNotRestart })
          },
      },
      // create a language client connection from the JSON RPC connection on demand
      connectionProvider: {
          get: () => {
              return Promise.resolve(transports);
          }
      }
  });
};

export async function createLanguageServer(pyodide_worker_url, document_selector) {
    return new Promise(resolve => {

        MonacoServices.install();

        let worker = new Worker(pyodide_worker_url);

        worker.addEventListener('message', (event) => {
            if (event.data !== '@initialization-finished')
                return;

            let monacoLanguageClient = createLanguageClient(document_selector, {
                reader: new MessageReader(worker),
                writer: new MessageWriter(worker)
            });

            resolve(new ServerInterface(worker, monacoLanguageClient));
        });
    });

}