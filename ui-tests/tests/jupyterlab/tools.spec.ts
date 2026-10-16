import { expect, test } from '@jupyterlab/galata';
import {
  ALL_TOOLS,
  BUILTIN_TOOLS,
  type ToolResult,
  callTool,
  createNotebook,
  runTool,
  startKernel,
  streamText,
  uniqueName,
  waitForTools
} from '../helpers';

/**
 * The arguments of each tool, sorted: [properties, required]. The command
 * tools also refuse unknown arguments. The schemas of the
 * jupyterlab-ai-commands tools are the ones of its version 0.4.
 */
const TOOL_ARGS: Record<string, [string[], string[]]> = {
  add_cell: [
    ['cellType', 'content', 'notebookPath', 'position', 'referenceCellId'],
    ['notebookPath']
  ],
  answer_dialog: [['button', 'dialogId'], ['button']],
  create_file: [['content', 'cwd', 'fileName', 'fileType'], ['fileName']],
  create_notebook: [['language', 'name'], ['name']],
  delete_cell: [
    ['cellId', 'notebookPath'],
    ['cellId', 'notebookPath']
  ],
  edit_cell: [
    ['cellId', 'content', 'notebookPath'],
    ['cellId', 'content', 'notebookPath']
  ],
  execute_command: [['args', 'command_id'], ['command_id']],
  get_context: [[], []],
  interrupt_kernel: [['kernelId'], ['kernelId']],
  list_all_commands: [['limit', 'query'], []],
  list_directory: [['includeHidden', 'path'], []],
  open_document: [['factory', 'options', 'path'], ['path']],
  read_cell: [
    ['cellId', 'notebookPath'],
    ['cellId', 'notebookPath']
  ],
  read_file: [['filePath'], ['filePath']],
  read_notebook: [['notebookPath'], ['notebookPath']],
  restart_kernel: [['kernelId'], ['kernelId']],
  run_cell: [
    ['cellId', 'notebookPath'],
    ['cellId', 'notebookPath']
  ],
  run_code: [
    ['code', 'kernelId', 'stopOnError'],
    ['code', 'kernelId']
  ],
  save_notebook: [['notebookPath'], ['notebookPath']],
  wait_for_result: [['pendingId', 'timeout'], ['pendingId']],
  write_file: [
    ['content', 'filePath'],
    ['content', 'filePath']
  ]
};

/**
 * The tools with each annotation, as Playwright names them.
 */
const ANNOTATED: Record<string, string[]> = {
  readOnly: [
    'get_context',
    'list_all_commands',
    'list_directory',
    'read_cell',
    'read_file',
    'read_notebook',
    'wait_for_result'
  ],
  untrustedContent: [
    'answer_dialog',
    'edit_cell',
    'execute_command',
    'get_context',
    'list_all_commands',
    'list_directory',
    'read_cell',
    'read_file',
    'read_notebook',
    'run_cell',
    'run_code',
    'wait_for_result'
  ],
  consequential: [
    'answer_dialog',
    'delete_cell',
    'execute_command',
    'restart_kernel',
    'run_cell',
    'run_code',
    'write_file'
  ]
};

test.beforeEach(async ({ page }) => {
  await waitForTools(page, ALL_TOOLS);
});

test('should register the built-in and the default tools', async ({ page }) => {
  const tools = await page.webmcp.tools();
  expect(Object.keys(TOOL_ARGS).sort()).toEqual(ALL_TOOLS);
  for (const tool of tools) {
    expect(tool.description, tool.name).toBeTruthy();
    const schema = tool.inputSchema as ToolResult;
    expect(schema?.type, tool.name).toBe('object');
    // Fixed and UI arguments are hidden. Commands ignore unknown
    // arguments, so the command tools declare them as errors.
    const [properties, required] = TOOL_ARGS[tool.name];
    expect(
      {
        properties: Object.keys(schema.properties ?? {}).sort(),
        required: [...(schema.required ?? [])].sort(),
        additionalProperties: schema.additionalProperties
      },
      tool.name
    ).toEqual({
      properties,
      required,
      additionalProperties: BUILTIN_TOOLS.includes(tool.name)
        ? undefined
        : false
    });
  }
  for (const [hint, names] of Object.entries(ANNOTATED)) {
    const hinted = tools
      .filter(tool => (tool.annotations as ToolResult)?.[hint] === true)
      .map(tool => tool.name)
      .sort();
    expect(hinted, hint).toEqual(names);
  }
  const description = (name: string) =>
    tools.find(tool => tool.name === name)!.description;
  expect(description('answer_dialog')).toMatch(/queued/);
  expect(description('open_document')).toMatch(/"disposed": true/);
});

test('get_context should describe the page', async ({ page, tmpPath }) => {
  const context = await callTool(page, 'get_context');
  expect(context).toMatchObject({
    success: true,
    app: { name: 'JupyterLab' },
    fileBrowserPath: tmpPath,
    currentEditor: null,
    dialogs: [],
    pending: []
  });
  expect(context.app.version).toMatch(/^4\./);
  // JupyterLab opens documents in the page: there is no note about tabs.
  expect(context).not.toHaveProperty('note');
  expect(context.widgets.map((widget: ToolResult) => widget.id)).toContain(
    context.currentWidgetId
  );
  expect(Array.isArray(context.kernels)).toBe(true);
});

test('get_context should report the cursor and the selection', async ({
  page
}) => {
  const { path, widgetId } = await createNotebook(page, 'webmcp-editor');
  try {
    const added = await runTool(page, 'add_cell', {
      notebookPath: path,
      content: 'n = 10'
    });
    expect(added).toMatchObject({ success: true });
    expect(await runTool(page, 'open_document', { path })).toMatchObject({
      success: true,
      result: { id: widgetId }
    });

    // The user selects "10".
    await page
      .locator(`#${widgetId} .jp-Cell .cm-line`, { hasText: 'n = 10' })
      .click();
    await page.keyboard.press('End');
    await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('Shift+ArrowLeft');

    const context = await callTool(page, 'get_context');
    expect(context.currentWidgetId).toBe(widgetId);
    expect(context.currentEditor).toEqual({
      cellId: added.cellId,
      cursor: { line: 1, column: 5 },
      selection: {
        start: { line: 1, column: 5 },
        end: { line: 1, column: 7 },
        text: '10'
      }
    });
  } finally {
    await page.contents.deleteFile(path);
  }
});

test('list_all_commands should find commands and their tools', async ({
  page
}) => {
  const result = await callTool(page, 'list_all_commands', {
    query: 'run cell',
    limit: 100
  });
  expect(result.success).toBe(true);
  expect(result.commandCount).toBe(result.commands.length);
  for (const command of result.commands) {
    const text = JSON.stringify(command).toLowerCase();
    expect(text).toContain('run');
    expect(text).toContain('cell');
  }
  const runCell = result.commands.find(
    (command: ToolResult) => command.id === 'jupyterlab-ai-commands:run-cell'
  );
  expect(runCell).toMatchObject({ tool: 'run_cell', enabled: true });
  expect(runCell.args.properties).toHaveProperty('cellId');
  // execute_command accepts other arguments, such as semanticWidget.
  expect(runCell.args).not.toHaveProperty('additionalProperties');

  const limited = await callTool(page, 'list_all_commands', {
    query: 'notebook',
    limit: 3
  });
  expect(limited.commands).toHaveLength(3);
  expect(limited.commandCount).toBeGreaterThan(3);

  const kernel = await callTool(page, 'list_all_commands', {
    query: 'jupyter-webmcp:restart-kernel'
  });
  expect(kernel.commands).toEqual([
    expect.objectContaining({
      id: 'jupyter-webmcp:restart-kernel',
      label: 'Restart Kernel by ID',
      tool: 'restart_kernel',
      args: expect.objectContaining({ required: ['kernelId'] })
    })
  ]);
});

test('should edit and run a notebook', async ({ page }) => {
  const { path, widgetId } = await createNotebook(page, 'webmcp-flow');
  try {
    const context = await callTool(page, 'get_context');
    expect(context.widgets).toContainEqual(
      expect.objectContaining({
        id: widgetId,
        type: 'NotebookPanel',
        path,
        kernel: expect.objectContaining({ name: 'python3' })
      })
    );

    const added = await runTool(page, 'add_cell', {
      notebookPath: path,
      content: 'x = 21\nprint(x * 2)'
    });
    expect(added).toMatchObject({ success: true, cellType: 'code' });
    const cellId: string = added.cellId;
    expect(cellId).toBeTruthy();

    const run = await runTool(page, 'run_cell', {
      notebookPath: path,
      cellId
    });
    expect(run).toMatchObject({
      success: true,
      status: 'ok',
      cellId,
      hasOutput: true
    });
    expect(streamText(run)).toBe('42\n');

    const notebook = await runTool(page, 'read_notebook', {
      notebookPath: path
    });
    expect(notebook).toMatchObject({ success: true, isDirty: true });
    const cell = notebook.content.cells.find(
      (item: ToolResult) => item.id === cellId
    );
    expect(cell).toMatchObject({
      cell_type: 'code',
      source: 'x = 21\nprint(x * 2)',
      execution_count: 1
    });
    expect(streamText(cell)).toBe('42\n');

    const edited = await runTool(page, 'edit_cell', {
      notebookPath: path,
      cellId,
      content: 'print("edited")'
    });
    expect(edited).toMatchObject({
      success: true,
      previousContent: 'x = 21\nprint(x * 2)',
      newContent: 'print("edited")',
      diffShown: false
    });

    const read = await runTool(page, 'read_cell', {
      notebookPath: path,
      cellId
    });
    expect(read).toMatchObject({ success: true, source: 'print("edited")' });

    const saved = await runTool(page, 'save_notebook', { notebookPath: path });
    expect(saved).toMatchObject({ success: true, notebookPath: path });
    const response = await page.request.get(
      `/api/contents/${encodeURIComponent(path)}?content=1`
    );
    expect(response.ok()).toBe(true);
    const onDisk = (await response.json()).content;
    expect(onDisk.cells.map((item: ToolResult) => item.source)).toContain(
      'print("edited")'
    );
  } finally {
    await page.contents.deleteFile(path);
  }
});

test('should return errors as data', async ({ page }) => {
  expect(
    await callTool(page, 'run_cell', {
      notebook: 'missing.ipynb',
      cellId: 'abc'
    })
  ).toEqual({
    success: false,
    isError: true,
    error:
      'Unknown argument "notebook". Accepted arguments: "notebookPath", "cellId".'
  });
  expect(
    await callTool(page, 'run_cell', { notebookPath: 'missing.ipynb' })
  ).toMatchObject({
    success: false,
    isError: true,
    error: 'Missing required argument "cellId".'
  });
  // An empty path would make the command use the active notebook.
  expect(
    await callTool(page, 'read_cell', { notebookPath: ' ', cellId: 'abc' })
  ).toMatchObject({
    success: false,
    isError: true,
    error: 'Missing required argument "notebookPath".'
  });
  expect(await callTool(page, 'wait_for_result')).toMatchObject({
    success: false,
    isError: true,
    error: '"pendingId" is required.'
  });
  expect(
    await callTool(page, 'execute_command', { command_id: 'not-a:command' })
  ).toMatchObject({
    success: false,
    isError: true,
    error:
      'Unknown command "not-a:command". Use list_all_commands to find the available commands.'
  });
  // The default settings block the core commands that run other commands.
  expect(
    await callTool(page, 'execute_command', {
      command_id: 'apputils:run-first-enabled',
      args: { commands: ['help:about'] }
    })
  ).toMatchObject({
    success: false,
    isError: true,
    error:
      'The command "apputils:run-first-enabled" is blocked by the WebMCP settings (blockedCommands).'
  });

  // The error dialog of a missing file stays open until the agent answers.
  const absent = await callTool(page, 'read_cell', {
    notebookPath: 'missing.ipynb',
    cellId: 'abc'
  });
  expect(absent).toEqual({
    success: false,
    isError: true,
    error: 'Invalid response: 404 Not Found',
    dialogs: [
      {
        id: expect.stringMatching(/^dialog-\d+$/),
        title: 'File Load Error for missing.ipynb',
        body: 'Invalid response: 404 Not Found',
        buttons: ['Close'],
        shown: true
      }
    ]
  });
  await expect(page.locator('.jp-Dialog')).toHaveCount(1);
  // The agent already has the failure: the answer does not repeat it.
  expect(await callTool(page, 'answer_dialog', { button: 'Close' })).toEqual({
    success: true,
    answered: { dialogId: absent.dialogs[0].id, button: 'Close' }
  });
  await expect(page.locator('.jp-Dialog')).toHaveCount(0);
  expect((await callTool(page, 'get_context')).pending).toEqual([]);
});

test('open_document should show a document opened in the background', async ({
  page
}) => {
  const created = await runTool(page, 'create_file', {
    fileName: `${uniqueName('webmcp-open')}.txt`,
    content: 'hello'
  });
  expect(created).toMatchObject({ success: true });
  const path: string = created.filePath;
  try {
    const before = await callTool(page, 'get_context');
    const widget = before.widgets.find(
      (item: ToolResult) => item.path === path
    );
    expect(widget).toMatchObject({ type: 'FileEditor', dirty: false });
    expect(before.currentWidgetId).not.toBe(widget.id);

    const opened = await runTool(page, 'open_document', { path });
    expect(opened).toEqual({ success: true, result: widget });
    await expect
      .poll(async () => (await callTool(page, 'get_context')).currentWidgetId)
      .toBe(widget.id);

    const missing = await runTool(page, 'open_document', {
      path: 'missing.txt'
    });
    expect(missing).toMatchObject({ success: false, isError: true });
    expect(missing.error).toMatch(/404/);

    expect(
      await callTool(page, 'open_document', {
        path,
        kernel: { name: 'python3' }
      })
    ).toMatchObject({
      success: false,
      error: expect.stringMatching(/^Unknown argument "kernel"\./)
    });
  } finally {
    await page.contents.deleteFile(path);
  }
});

test('run_code should run code in the kernel of a notebook', async ({
  page
}) => {
  const { path, kernelId } = await createNotebook(page, 'webmcp-code');
  try {
    const context = await callTool(page, 'get_context');
    expect(context.kernels).toContainEqual(
      expect.objectContaining({ id: kernelId, name: 'python3' })
    );

    const result = await runTool(page, 'run_code', {
      kernelId,
      code: 'shared = 6 * 7\nshared'
    });
    expect(result).toMatchObject({ success: true, status: 'ok', kernelId });
    expect(result.outputs).toContainEqual(
      expect.objectContaining({
        output_type: 'execute_result',
        data: expect.objectContaining({ 'text/plain': '42' })
      })
    );

    // The notebook shares the variables of run_code.
    const added = await runTool(page, 'add_cell', {
      notebookPath: path,
      content: 'print(shared + 1)'
    });
    const run = await runTool(page, 'run_cell', {
      notebookPath: path,
      cellId: added.cellId
    });
    expect(streamText(run)).toBe('43\n');

    const failed = await runTool(page, 'run_code', {
      kernelId,
      code: '1 / 0'
    });
    expect(failed).toMatchObject({
      success: false,
      isError: true,
      status: 'error'
    });
    expect(failed.error).toMatch(/^ZeroDivisionError/);
    expect(JSON.stringify(failed.traceback)).not.toContain('\\u001b[');

    // An exception without a message gives no trailing ": ".
    expect(
      await runTool(page, 'run_code', { kernelId, code: 'raise ValueError' })
    ).toMatchObject({ success: false, error: 'ValueError' });
  } finally {
    await page.contents.deleteFile(path);
  }
});

test('run_code should compact rich outputs', async ({ page }) => {
  const kernelId = await startKernel(page);
  const result = await runTool(page, 'run_code', {
    kernelId,
    code: [
      'import base64',
      'from IPython.display import HTML, Image, display',
      "display(HTML('<b>short</b>'))",
      "display(HTML('<p>' + 'x' * 3000 + '</p>'))",
      'png = base64.b64decode(',
      "    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='",
      ')',
      'display(Image(data=png, width=10))'
    ].join('\n')
  });
  expect(result).toMatchObject({ success: true, status: 'ok' });
  const displays = result.outputs.filter(
    (output: ToolResult) => output.output_type === 'display_data'
  );
  expect(displays).toHaveLength(3);
  const [short, long, image] = displays;

  // Short rich data is kept, long rich data with a text/plain alternative
  // is replaced.
  expect(short.data['text/html']).toBe('<b>short</b>');
  expect(long.data['text/plain']).toBeTruthy();
  expect(long.data['text/html']).toMatch(
    /^\[omitted text\/html data, \d+ characters; see text\/plain\]$/
  );

  // Binary data is always replaced; the metadata is not a MIME bundle.
  expect(image.data['image/png']).toMatch(/^\[omitted image\/png data/);
  expect(image.metadata).toEqual({ 'image/png': { width: 10 } });
});
