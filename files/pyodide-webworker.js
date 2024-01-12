importScripts("/files/pyodide/pyodide.js")

const textEncoder = new TextEncoder("utf-8");
const textDecoder = new TextDecoder("utf-8");

class ServerController {
    constructor(pyodide) {
        this.json_input = [];
        this.pyodide = pyodide;
        this.listening = false;
        this.created = false;
    }

    async install() {

        // Dependencies for micropip
        await this.pyodide.loadPackage("/files/pyodide/wheels/packaging-23.1-py3-none-any.whl");

        // Install micropip
        await this.pyodide.loadPackage("/files/pyodide/wheels/micropip-0.5.0-py3-none-any.whl");

        await this.pyodide.runPythonAsync(`
            import micropip
            micropip.add_mock_package("ujson", "5.9.0", modules={"ujson":"from json import *"})
        `)

        // Install MyPy extension for pylsp server
        await this.pyodide.loadPackage("/files/pyodide/wheels/typing_extensions-4.9.0-py3-none-any.whl");
        await this.pyodide.loadPackage("/files/pyodide/wheels/mypy_extensions-1.0.0-py3-none-any.whl");

        // Dependencies for python_lsp_jsonrpc and python_lsp_server
        await this.pyodide.loadPackage("/files/pyodide/wheels/parso-0.8.3-py2.py3-none-any.whl");
        await this.pyodide.loadPackage("/files/pyodide/wheels/jedi-0.19.0-py2.py3-none-any.whl");
        await this.pyodide.loadPackage("/files/pyodide/wheels/pluggy-1.2.0-py3-none-any.whl");
        await this.pyodide.loadPackage("/files/pyodide/wheels/docstring_to_markdown-0.13-py3-none-any.whl");

        // Install python_lsp_jsonrpc and python_lsp_server
        await this.pyodide.loadPackage('/files/pyodide/wheels/python_lsp_jsonrpc-1.1.2-py3-none-any.whl');
        await this.pyodide.loadPackage('/files/pyodide/wheels/python_lsp_server-1.9.0-py3-none-any.whl');

        // Dependencies for pylsp_mypy
        await this.pyodide.loadPackage("/files/pyodide/wheels/tomli-2.0.1-py3-none-any.whl");
        await this.pyodide.loadPackage("/files/pyodide/wheels/mypy-1.5.1-cp311-cp311-emscripten_3_1_45_wasm32.whl");

        // Install pylsp_mypy
        await this.pyodide.loadPackage("/files/pyodide/wheels/pylsp_mypy-0.6.8-py3-none-any.whl");
    }

    async create_server() {
        await this.pyodide.runPythonAsync(`
            import sys
            import os
            import asyncio

            from pylsp.python_lsp import PythonLSPServer
            from pylsp.workspace import Document, Notebook

            last_lint_handle = None

            class PythonLSPServer_with_asyncio_debounced_lint(PythonLSPServer):
                def _execute_lint(self, doc_uri, is_saved):
                    # Since we're debounced, the document may no longer be open
                    workspace = self._match_uri_to_workspace(doc_uri)
                    document_object = workspace.documents.get(doc_uri, None)
                    if isinstance(document_object, Document):
                        self._lint_text_document(doc_uri, workspace, is_saved=is_saved)
                    elif isinstance(document_object, Notebook):
                        self._lint_notebook_document(document_object, workspace)

                # The original lint() was debounced with threading, which is not available in Pyodide
                # Override it to debounce with asyncio.call_later instead, which will use setTimeout in JS 
                def lint(self, doc_uri, is_saved):
                    global last_lint_handle
                    if last_lint_handle:
                        last_lint_handle.cancel()
                    last_lint_handle = asyncio.get_event_loop().call_later(0.5, self._execute_lint, doc_uri, is_saved)

            # Increase standard buffer size from 4096 to 131072 to
            # make sure large json commands will fit into a single readline call
            stdin = os.fdopen(sys.stdin.fileno(), 'rb', buffering=131072)
            stdout = os.fdopen(sys.stdout.fileno(), 'wb', buffering=131072)
            check_parent_process = False
            server = PythonLSPServer_with_asyncio_debounced_lint(stdin, stdout, check_parent_process)
        `);
        this.created = true;
        if (!this.listening && this.has_messages())
            this.start_listening();
    }

    async start_listening() {
        this.listening = true;
        await this.pyodide.runPythonAsync(`
            # starts the listening loop
            # server will not listen forever
            # listen loop will break on empty stdin line
            server.start()
            print() # flushes stdout
        `);
    }

    add_message(json_str) {
        this.json_input.push(json_str);
        if (this.created && !this.listening)
            this.start_listening();
    }

    has_messages() {
        return this.json_input.length > 0;
    }

    shift_message_as_payload() {
        const json_str = this.json_input.shift();
        const len = textEncoder.encode(json_str).length;
        return `Content-Length: ${len + 1}\n\n${json_str}`;
    }

}

class StdinHandler {
    constructor(server_controller) {
        this.server_controller = server_controller;
    }

    stdin() {
      if (this.server_controller.has_messages()) {
        return this.server_controller.shift_message_as_payload();
      } else {
        // Sending undefined will result in an empty stdin line
        // The empty line will break the listen loop for the server
        this.server_controller.listening = false;
        return undefined;
      }
    }
}

class StdoutHandler {
    constructor() {
        this.output_buffer = new Uint8Array(65536);
        this.buffer_end_position = 0;
        this.waiting_for_header = true;
        this.waiting_for_content = false;
        this.content_length = -1;
    }

    buffer_to_str(start, length) {
        return textDecoder.decode(this.output_buffer.slice(start, start+length));
    }

    consume_bytes(num_bytes) {
        const buffer_tail = this.output_buffer.slice(num_bytes, this.buffer_end_position);
        this.output_buffer.set(buffer_tail, 0, buffer_tail.length);
        this.buffer_end_position -= num_bytes;
    }

    consume_until_found(txt_to_find) {
        let consumed_count = 0;
        const txt_length = txt_to_find.length;
        while (this.buffer_end_position - consumed_count >= txt_length &&
            this.buffer_to_str(consumed_count, txt_length) !== txt_to_find)
            consumed_count += 1;
        this.consume_bytes(consumed_count);
        return this.buffer_to_str(0, txt_length) === txt_to_find;
    }

    consume_header() {
        var output_str = this.buffer_to_str(0, this.buffer_end_position);
        var first_line = output_str.split("\n")[0];
        var content_length_str = first_line.split(" ")[1];
        this.content_length = Number(content_length_str);
        this.consume_bytes(first_line.length);
    }

    consume_content() {
        if (this.buffer_end_position >= this.content_length) {
            const json_content_str = this.buffer_to_str(0, this.content_length);
            this.consume_bytes(this.content_length);
            self.postMessage(json_content_str);
            return true;
        }
        return false;
    }

    consume_output_buffer() {
        if (this.waiting_for_header) {
          const found_header = this.consume_until_found("Content-Length: ");
          if (found_header) {
              this.consume_header();
              this.waiting_for_header = false;
              this.waiting_for_content = true;
              this.consume_output_buffer(); // Might have content to consume
          }
        } else if (this.waiting_for_content) {
          const found_content_separator = this.consume_until_found("\r\n\r\n");
          if (found_content_separator) {
            this.consume_bytes(4);
            const did_consume_content = this.consume_content();
            if (did_consume_content) {
              this.waiting_for_header = true;
              this.waiting_for_content = false;
              this.consume_output_buffer(); // Might have headers to consume
            }
          }
        }
    }

    write(uint8array) {
      this.output_buffer.set(uint8array, this.buffer_end_position);
      this.buffer_end_position += uint8array.length;
      this.consume_output_buffer();
      return uint8array.length;
    }
}

const webWorkerMessageEventHandler = (pyodide, server_controller) => async event => {
    const data = event.data; 
    // Magic character @ reserved for special commands to the webworker
    if (data.startsWith('@write-file:')) {
        const json_payload_str = data.slice('@write-file:'.length);
        const json_payload = JSON.parse(json_payload_str);
        pyodide.FS.writeFile(json_payload.name, json_payload.contents, { encoding: "utf8" });
        self.postMessage(`@done:${json_payload._idx}`);
    } else if (data.startsWith('@unpack-zip:')) {
        const json_payload_str = data.slice('@unpack-zip:'.length);
        const json_payload = JSON.parse(json_payload_str);
        const zip_response = await fetch(json_payload.url);
        const zip_binary = await zip_response.arrayBuffer();
        pyodide.unpackArchive(zip_binary, "zip");
        self.postMessage(`@done:${json_payload._idx}`);
    } else if (data.startsWith('@execute-python:')) {
        const json_payload_str = data.slice('@execute-python:'.length);
        const json_payload = JSON.parse(json_payload_str);
        await pyodide.runPythonAsync(json_payload.code);
        self.postMessage(`@done:${json_payload._idx}`);
    } else if (!data.startsWith('@')) { 
        const json_str = data;
        server_controller.add_message(json_str);
    }
}

async function main() {
    const pyodide = await loadPyodide();

    console.log(pyodide.runPython(`
      import sys
      sys.version
    `));

    const server_controller = new ServerController(pyodide);

    const stdout_handler = new StdoutHandler();
    const stdin_handler = new StdinHandler(server_controller);

    pyodide.setStdout(stdout_handler);
    pyodide.setStdin(stdin_handler);

    self.onmessage = webWorkerMessageEventHandler(pyodide, server_controller);

    await server_controller.install();

    await server_controller.create_server();

    self.postMessage('@initialization-finished');
};

main()