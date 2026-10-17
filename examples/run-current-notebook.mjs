#!/usr/bin/env node

import { performance } from 'node:perf_hooks';

const cdpUrl = (process.env.WEBMCP_CDP_URL ?? 'http://127.0.0.1:9222').replace(
  /\/+$/,
  ''
);
const pageMatch = process.env.WEBMCP_PAGE ?? '/jupyter-webmcp/';
const TOOL_WAIT_MS = 15000;
const TOOL_TIMEOUT_MS = 120000;
const KERNEL_READY_TIMEOUT_MS = 60000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class CDPConnection {
  static async open(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener(
        'error',
        () => reject(new Error(`Cannot connect to ${url}`)),
        { once: true }
      );
    });
    return new CDPConnection(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.requests = new Map();
    this.listeners = new Set();
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const request = this.requests.get(message.id);
        if (!request) {
          return;
        }
        this.requests.delete(message.id);
        if (message.error) {
          request.reject(new Error(message.error.message));
        } else {
          request.resolve(message.result);
        }
      } else if (message.method) {
        this.listeners.forEach(listener => listener(message));
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.requests.set(id, { resolve, reject });
    });
  }

  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    this.socket.close();
  }
}

async function selectPage() {
  const response = await fetch(`${cdpUrl}/json/list`);
  if (response.status === 404) {
    throw new Error(
      `${cdpUrl} is not a Chrome DevTools Protocol endpoint. Start Chrome with an unused --remote-debugging-port and set WEBMCP_CDP_URL to the same port.`
    );
  }
  if (!response.ok) {
    throw new Error(
      `Cannot list Chrome pages: HTTP ${response.status} ${await response.text()}`
    );
  }
  const pages = (await response.json()).filter(
    target => target.type === 'page' && target.url.includes(pageMatch)
  );
  if (pages.length === 0) {
    throw new Error(
      `No Chrome page URL contains "${pageMatch}". Set WEBMCP_PAGE to select a different page.`
    );
  }
  const target = pages[0];
  return target.webSocketDebuggerUrl;
}

async function loadTools(connection) {
  const apiDeadline = Date.now() + TOOL_WAIT_MS;
  let webmcpAvailable = false;
  while (Date.now() < apiDeadline) {
    const { result } = await connection.send('Runtime.evaluate', {
      expression: 'typeof document.modelContext',
      returnByValue: true
    });
    if (result.value !== 'undefined') {
      webmcpAvailable = true;
      break;
    }
    await sleep(50);
  }
  if (!webmcpAvailable) {
    throw new Error(
      'WebMCP is unavailable on this page. Start Chrome with --enable-features=WebMCP and open the Jupyter page over HTTPS or localhost.'
    );
  }

  const tools = new Map();
  const removeListener = connection.on(({ method, params }) => {
    if (method === 'WebMCP.toolsAdded') {
      params.tools.forEach(tool => tools.set(tool.name, tool));
    } else if (method === 'WebMCP.toolsRemoved') {
      params.tools.forEach(tool => tools.delete(tool.name));
    }
  });
  await connection.send('WebMCP.enable');
  const toolDeadline = Date.now() + TOOL_WAIT_MS;
  while (!tools.has('get_context') && Date.now() < toolDeadline) {
    await sleep(50);
  }
  removeListener();
  if (!tools.has('get_context')) {
    throw new Error('The page did not register its WebMCP tools.');
  }
  return tools;
}

function parseOutput(output) {
  if (typeof output !== 'string') {
    return output;
  }
  try {
    return JSON.parse(output);
  } catch {
    return output;
  }
}

async function callTool(connection, tools, name, input) {
  const tool = tools.get(name);
  if (!tool) {
    throw new Error(`The current page does not provide the "${name}" tool.`);
  }

  const responses = new Map();
  const removeListener = connection.on(({ method, params }) => {
    if (method === 'WebMCP.toolResponded') {
      responses.set(params.invocationId, params);
    }
  });
  try {
    const { invocationId } = await connection.send('WebMCP.invokeTool', {
      frameId: tool.frameId,
      toolName: name,
      input
    });
    const deadline = Date.now() + TOOL_TIMEOUT_MS;
    while (!responses.has(invocationId) && Date.now() < deadline) {
      await sleep(50);
    }
    if (!responses.has(invocationId)) {
      await connection.send('WebMCP.cancelInvocation', { invocationId });
      throw new Error(`${name} did not return within ${TOOL_TIMEOUT_MS} ms.`);
    }

    const response = responses.get(invocationId);
    if (response.status !== 'Completed') {
      throw new Error(
        `${name} ${response.status}: ${response.errorText ?? 'no error details'}`
      );
    }
    const output = parseOutput(response.output);
    if (output?.success === false) {
      throw new Error(`${name} failed: ${output.error ?? JSON.stringify(output)}`);
    }
    return output;
  } finally {
    removeListener();
  }
}

async function runToCompletion(connection, tools, notebookPath, cellId) {
  let result = await callTool(connection, tools, 'run_cell', {
    notebookPath,
    cellId
  });
  while (result.status === 'pending') {
    if (!result.pendingId) {
      throw new Error(`run_cell returned a pending result without a pendingId.`);
    }
    result = await callTool(connection, tools, 'wait_for_result', {
      pendingId: result.pendingId,
      timeout: 20
    });
  }
  if (result.status !== 'ok') {
    throw new Error(
      `run_cell did not complete successfully: ${JSON.stringify(result)}`
    );
  }
  return result;
}

async function main() {
  const workflowStarted = performance.now();
  const websocketUrl = await selectPage();
  const connection = await CDPConnection.open(websocketUrl);
  try {
    const tools = await loadTools(connection);
    const kernelWaitStarted = performance.now();
    const kernelDeadline = Date.now() + KERNEL_READY_TIMEOUT_MS;
    let context;
    let currentWidget;
    while (Date.now() < kernelDeadline) {
      context = await callTool(connection, tools, 'get_context', {});
      currentWidget = context.widgets?.find(
        widget => widget.id === context.currentWidgetId
      );
      if (
        context.dialogs?.some(dialog => dialog.title === 'Select Kernel')
      ) {
        throw new Error(
          'The current notebook has no selected kernel. Select a kernel, then retry.'
        );
      }
      if (currentWidget?.kernel?.status === 'idle') {
        break;
      }
      await sleep(250);
    }
    if (currentWidget?.type !== 'NotebookPanel' || !currentWidget.path) {
      throw new Error('The selected Jupyter page has no current notebook.');
    }
    if (currentWidget.kernel?.status !== 'idle') {
      throw new Error(
        `The kernel for ${currentWidget.path} did not become idle within ${KERNEL_READY_TIMEOUT_MS} ms.`
      );
    }

    const notebook = await callTool(connection, tools, 'read_notebook', {
      notebookPath: currentWidget.path
    });
    const codeCells = notebook.content?.cells?.filter(
      cell => cell.cell_type === 'code'
    );
    if (!Array.isArray(codeCells) || codeCells.length === 0) {
      throw new Error(`${currentWidget.path} has no code cells to run.`);
    }
    if (codeCells.some(cell => !cell.id)) {
      throw new Error(
        `${currentWidget.path} has code cells without IDs, which run_cell requires.`
      );
    }

    const cellRuns = [];
    for (const [index, cell] of codeCells.entries()) {
      const started = performance.now();
      const result = await runToCompletion(
        connection,
        tools,
        currentWidget.path,
        cell.id
      );
      cellRuns.push({
        cellNumber: index + 1,
        cellId: cell.id,
        executionCount: result.executionCount ?? null,
        elapsedMs: Number((performance.now() - started).toFixed(1)),
        outputs: result.outputs ?? []
      });
    }

    const totalRunElapsedMs = cellRuns.reduce(
      (total, run) => total + run.elapsedMs,
      0
    );
    console.log(
      JSON.stringify(
        {
          notebookPath: currentWidget.path,
          kernelName: currentWidget.kernel.name,
          kernelReadyMs: Number(
            (performance.now() - kernelWaitStarted).toFixed(1)
          ),
          codeCellsExecuted: cellRuns.length,
          cellRuns,
          totalRunElapsedMs: Number(totalRunElapsedMs.toFixed(1)),
          workflowElapsedMs: Number(
            (performance.now() - workflowStarted).toFixed(1)
          )
        },
        null,
        2
      )
    );
  } finally {
    connection.close();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
