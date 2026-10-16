import { ILabShell } from '@jupyterlab/application';
import { Dialog, showDialog, showErrorMessage } from '@jupyterlab/apputils';
import { IDefaultFileBrowser } from '@jupyterlab/filebrowser';
import { CommandRegistry } from '@lumino/commands';
import { PromiseDelegate, ReadonlyPartialJSONObject } from '@lumino/coreutils';
import { Widget } from '@lumino/widgets';
import { Dialogs } from '../dialogs';
import { CommandExecutor } from '../execution';
import { IModelContextTool } from '../modelcontext';
import { Tools } from '../tools';
import { createApp, shown, trans, waitFor } from './utils';

const executors: CommandExecutor[] = [];

/**
 * Options for the tool builders, with a fake app.
 */
function createOptions(
  commands = new CommandRegistry(),
  overrides: Partial<Tools.IOptions> = {},
  extra: createApp.IOptions & { timeout?: number } = {}
) {
  const isBlocked = overrides.isBlocked ?? (() => false);
  const executor = new CommandExecutor({
    commands,
    isBlocked,
    timeout: () => extra.timeout ?? 1000
  });
  executors.push(executor);
  const fake = createApp({ ...extra, commands });
  const options: Tools.IOptions = {
    app: fake.app,
    executor,
    isBlocked,
    toolFor: () => undefined,
    maxResultLength: () => 40000,
    fileBrowser: null,
    labShell: {} as ILabShell,
    trans,
    ...overrides
  };
  return Object.assign(options, { fake });
}

/**
 * Call a tool like a browser does.
 */
function run(
  tool: IModelContextTool,
  input: Record<string, unknown> = {},
  signal?: AbortSignal
): Promise<any> {
  return tool.execute(input, { signal }) as Promise<any>;
}

/**
 * Show a dialog with "Cancel" and "Ok" buttons.
 */
async function openDialog(title = 'Title'): Promise<{
  dialog: Dialog<unknown>;
  result: Promise<Dialog.IResult<unknown>>;
}> {
  const dialog = new Dialog({
    title,
    body: 'Body',
    buttons: [Dialog.cancelButton(), Dialog.okButton()]
  });
  const result = dialog.launch();
  result.catch(() => undefined);
  await shown(dialog, title);
  return { dialog, result };
}

/**
 * A fake code editor holding `source`, with a cursor and a selection given
 * as 0-based offsets.
 */
function fakeEditor(source: string, cursor: number, anchor = cursor) {
  const position = (offset: number) => {
    const before = source.slice(0, offset).split('\n');
    return {
      line: before.length - 1,
      column: before[before.length - 1].length
    };
  };
  const offsetAt = ({ line, column }: { line: number; column: number }) =>
    source
      .split('\n')
      .slice(0, line)
      .reduce((total, text) => total + text.length + 1, 0) + column;
  return {
    getCursorPosition: () => position(cursor),
    getSelection: () => ({
      start: position(Math.min(anchor, cursor)),
      end: position(Math.max(anchor, cursor))
    }),
    getOffsetAt: offsetAt,
    model: { sharedModel: { getSource: () => source } }
  };
}

afterEach(() => {
  Dialog.flush();
  while (executors.length) {
    executors.pop()!.dispose();
  }
});

describe('Tools', () => {
  describe('builtinTools', () => {
    it('builds the built-in tools', () => {
      const tools = Tools.builtinTools(createOptions());
      expect(tools.map(tool => tool.name)).toEqual(Tools.BUILTIN_NAMES);
      for (const tool of tools) {
        expect(tool.title).toBeTruthy();
        expect(tool.description).toBeTruthy();
        // Theme names are the same in every frontend.
        expect(tool.description.replace('JupyterLab Dark', '')).not.toContain(
          'JupyterLab'
        );
        expect(tool.inputSchema).toMatchObject({ type: 'object' });
      }
    });
  });

  describe('get_context', () => {
    it('describes the page', async () => {
      const widget = new Widget();
      widget.id = 'editor-1';
      widget.title.label = 'a.py';
      widget.addClass('jp-FileEditor');
      const fileBrowser = {
        model: { path: 'work' }
      } as unknown as IDefaultFileBrowser;
      const tool = Tools.getContext(
        createOptions(
          new CommandRegistry(),
          { fileBrowser },
          {
            widgets: [widget],
            current: widget,
            kernels: [
              { id: 'k1', name: 'python3', execution_state: 'busy' },
              { id: 'k2', name: 'ir' }
            ]
          }
        )
      );
      expect(await run(tool)).toEqual({
        success: true,
        app: { name: 'JupyterLab', version: '4.6.0' },
        fileBrowserPath: 'work',
        currentWidgetId: 'editor-1',
        currentEditor: null,
        widgets: [{ type: 'FileEditor', id: 'editor-1', title: 'a.py' }],
        kernels: [
          { id: 'k1', name: 'python3', status: 'busy' },
          { id: 'k2', name: 'ir', status: 'unknown' }
        ],
        dialogs: [],
        pending: []
      });
    });

    it('refreshes the running kernels first', async () => {
      const options = createOptions(
        new CommandRegistry(),
        {},
        { kernels: [{ id: 'k1', name: 'python3', execution_state: 'busy' }] }
      );
      const { kernels, state } = options.fake;
      kernels.refreshRunning.mockImplementation(async () => {
        state.kernels = [
          { id: 'k1', name: 'python3', execution_state: 'idle' }
        ];
      });
      const result = await run(Tools.getContext(options));
      expect(kernels.refreshRunning).toHaveBeenCalledTimes(1);
      expect(result.kernels).toEqual([
        { id: 'k1', name: 'python3', status: 'idle' }
      ]);
    });

    it('ignores a failed refresh of the kernels', async () => {
      const options = createOptions(
        new CommandRegistry(),
        {},
        { kernels: [{ id: 'k1', name: 'python3', execution_state: 'idle' }] }
      );
      options.fake.kernels.refreshRunning.mockImplementation(() =>
        Promise.reject(new Error('Offline'))
      );
      expect(await run(Tools.getContext(options))).toMatchObject({
        success: true,
        kernels: [{ id: 'k1', name: 'python3', status: 'idle' }]
      });
    });

    it('waits at most 2 seconds for the refresh of the kernels', async () => {
      const options = createOptions(
        new CommandRegistry(),
        {},
        { kernels: [{ id: 'k1', name: 'python3' }] }
      );
      options.fake.kernels.refreshRunning.mockImplementation(
        () => new Promise(() => undefined)
      );
      const tool = Tools.getContext(options);
      jest.useFakeTimers();
      try {
        let done = false;
        const promise = run(tool).then(result => {
          done = true;
          return result;
        });
        await jest.advanceTimersByTimeAsync(1900);
        expect(done).toBe(false);
        await jest.advanceTimersByTimeAsync(100);
        expect(await promise).toMatchObject({
          success: true,
          kernels: [{ id: 'k1', name: 'python3', status: 'unknown' }]
        });
      } finally {
        jest.useRealTimers();
      }
    });

    it('reports the live kernel status of the open documents', async () => {
      const widget = new Widget();
      widget.id = 'nb-1';
      Object.assign(widget, {
        sessionContext: {
          session: { kernel: { id: 'k1', name: 'python3' } },
          kernelDisplayStatus: 'idle'
        }
      });
      const tool = Tools.getContext(
        createOptions(
          new CommandRegistry(),
          {},
          {
            widgets: [widget],
            kernels: [
              { id: 'k1', name: 'python3', execution_state: 'busy' },
              { id: 'k2', name: 'python3', execution_state: 'busy' }
            ]
          }
        )
      );
      const result = await run(tool);
      expect(result.widgets).toEqual([
        {
          type: 'Widget',
          id: 'nb-1',
          title: '',
          kernel: { id: 'k1', name: 'python3', status: 'idle' }
        }
      ]);
      expect(result.kernels).toEqual([
        { id: 'k1', name: 'python3', status: 'idle' },
        { id: 'k2', name: 'python3', status: 'busy' }
      ]);
    });

    it('reports null without a file browser or a current widget', async () => {
      const result = await run(Tools.getContext(createOptions()));
      expect(result).toMatchObject({
        fileBrowserPath: null,
        currentWidgetId: null,
        currentEditor: null,
        widgets: [],
        kernels: []
      });
      expect(result).not.toHaveProperty('note');
    });

    it('reports a current widget without id as null', async () => {
      // The file browser page of Jupyter Notebook.
      const widget = new Widget();
      widget.addClass('jp-TreePanel');
      const result = await run(
        Tools.getContext(
          createOptions(
            new CommandRegistry(),
            {},
            { widgets: [widget], current: widget }
          )
        )
      );
      expect(result.currentWidgetId).toBeNull();
      expect(result.widgets).toEqual([{ type: 'TreePanel', title: '' }]);
    });

    it('adds a note in apps that show one document per page', async () => {
      const result = await run(
        Tools.getContext(
          createOptions(new CommandRegistry(), { labShell: null })
        )
      );
      expect(result.note).toBe(
        'This page shows one document. Other documents open in their own browser tab, with their own tools.'
      );
    });

    describe('currentEditor', () => {
      const context = async (current: unknown) =>
        (
          await run(
            Tools.getContext(
              createOptions(new CommandRegistry(), {}, { current })
            )
          )
        ).currentEditor;

      it('reports the cursor of the active notebook cell, 1-based', async () => {
        const editor = fakeEditor('import os\nos.getcwd()', 13);
        const notebook = {
          content: { activeCell: { editor, model: { id: 'cell-1' } } }
        };
        expect(await context(notebook)).toEqual({
          cellId: 'cell-1',
          cursor: { line: 2, column: 4 }
        });
      });

      it('reports the selection of a file editor', async () => {
        const editor = fakeEditor('a = 1\nb = 2\n', 10, 2);
        expect(await context({ content: { editor } })).toEqual({
          cursor: { line: 2, column: 5 },
          selection: {
            start: { line: 1, column: 3 },
            end: { line: 2, column: 5 },
            text: '= 1\nb = '
          }
        });
      });

      it('reports the prompt of a console', async () => {
        const editor = fakeEditor('print(1)', 8);
        expect(await context({ console: { promptCell: { editor } } })).toEqual({
          cursor: { line: 1, column: 9 }
        });
      });

      it('cuts the selected text to 2000 characters', async () => {
        const editor = fakeEditor('x'.repeat(5000), 5000, 0);
        const state = await context({ content: { editor } });
        expect(state.selection.text).toBe('x'.repeat(2000));
        expect(state.selection.end).toEqual({ line: 1, column: 5001 });
      });

      it('is null without a code editor', async () => {
        for (const current of [
          new Widget(),
          { content: { activeCell: { editor: null, model: { id: 'c' } } } },
          { content: { editor: {} } }
        ]) {
          expect(await context(current)).toBeNull();
        }
      });

      it('is null when the editor throws', async () => {
        const editor = fakeEditor('x', 0);
        editor.getSelection = () => {
          throw new Error('Disposed');
        };
        expect(await context({ content: { editor } })).toBeNull();
      });
    });

    it('lists the pending calls', async () => {
      const commands = new CommandRegistry();
      commands.addCommand('slow:x', {
        execute: () => new Promise(() => undefined)
      });
      const options = createOptions(commands, {}, { timeout: 10 });
      const pending = await run(Tools.executeCommand(options), {
        command_id: 'slow:x'
      });
      expect(pending.status).toBe('pending');
      const result = await run(Tools.getContext(options));
      expect(result.pending).toEqual([
        {
          pendingId: pending.pendingId,
          tool: 'execute_command',
          command: 'slow:x',
          seconds: 0
        }
      ]);
    });

    it('lists a call that showed an error dialog, and the dialog', async () => {
      const commands = new CommandRegistry();
      commands.addCommand('test:broken', {
        execute: () => {
          showErrorMessage('Error', 'Broken').catch(() => undefined);
          return new Promise(() => undefined);
        }
      });
      const options = createOptions(commands);
      const pending = await run(Tools.executeCommand(options), {
        command_id: 'test:broken'
      });
      expect(pending).toMatchObject({
        status: 'pending',
        message: expect.stringContaining('probably failed'),
        dialog: { title: 'Error', body: 'Broken', buttons: ['Close'] }
      });
      expect(pending).not.toHaveProperty('isError');
      const result = await run(Tools.getContext(options));
      expect(result.pending).toEqual([
        expect.objectContaining({ pendingId: pending.pendingId })
      ]);
      expect(result.dialogs).toEqual([
        expect.objectContaining({ id: pending.dialog.id })
      ]);
    });

    it('lists the open dialogs', async () => {
      const { dialog } = await openDialog();
      const result = await run(Tools.getContext(createOptions()));
      expect(result.dialogs).toEqual([
        {
          id: expect.stringMatching(/^dialog-\d+$/),
          title: 'Title',
          body: 'Body',
          buttons: ['Cancel', 'Ok'],
          shown: true
        }
      ]);
      dialog.dispose();
    });

    it('is a read-only tool without input', () => {
      const tool = Tools.getContext(createOptions());
      expect(tool.name).toBe('get_context');
      expect(tool.title).toBe('Get the Jupyter context');
      expect(tool.inputSchema).toEqual({ type: 'object', properties: {} });
      expect(tool.annotations).toEqual({
        readOnlyHint: true,
        untrustedContentHint: true
      });
    });
  });

  describe('list_all_commands', () => {
    function createCommands(): CommandRegistry {
      const commands = new CommandRegistry();
      const execute = () => null;
      commands.addCommand('notebook:run-cell', {
        label: 'Run Selected Cell',
        caption: 'Run the selected cell',
        usage: 'Runs the cell and selects the next one.',
        describedBy: {
          args: {
            type: 'object',
            properties: {
              activate: { type: 'boolean' },
              toolbar: { type: 'boolean' },
              isPalette: { type: 'boolean' }
            },
            required: ['toolbar']
          }
        },
        execute
      });
      commands.addCommand('notebook:insert-cell-below', {
        label: 'Insert Cell Below',
        execute
      });
      commands.addCommand('console:create', {
        label: 'New Console',
        caption: 'Create a console',
        isEnabled: () => false,
        execute
      });
      commands.addCommand('docmanager:open', {
        label: 'Open',
        caption: 'Open',
        usage: 'Open',
        describedBy: {
          args: {
            type: 'object',
            properties: { path: { type: 'string' } }
          }
        },
        execute
      });
      commands.addCommand('theme:dark', {
        label: 'Dark Theme',
        usage: 'Switch to the dark theme',
        execute
      });
      commands.addCommand('help:about', {
        label: () => {
          throw new Error('No label');
        },
        describedBy: () => {
          throw new Error('No schema');
        },
        execute
      });
      return commands;
    }

    async function ids(
      input: Record<string, unknown>,
      overrides: Partial<Tools.IOptions> = {}
    ): Promise<string[]> {
      const tool = Tools.listAllCommands(
        createOptions(createCommands(), overrides)
      );
      const result = await run(tool, input);
      return result.commands.map(
        (entry: ReadonlyPartialJSONObject) => entry.id
      );
    }

    it('lists every command without a query', async () => {
      const tool = Tools.listAllCommands(createOptions(createCommands()));
      const result = await run(tool);
      expect(result.success).toBe(true);
      expect(result.commandCount).toBe(6);
      expect(
        result.commands.map((entry: ReadonlyPartialJSONObject) => entry.id)
      ).toEqual([
        'console:create',
        'docmanager:open',
        'help:about',
        'notebook:insert-cell-below',
        'notebook:run-cell',
        'theme:dark'
      ]);
    });

    it('matches every word of the query', async () => {
      expect(await ids({ query: 'notebook cell' })).toEqual([
        'notebook:insert-cell-below',
        'notebook:run-cell'
      ]);
      expect(await ids({ query: 'notebook console' })).toEqual([]);
      expect(await ids({ query: '  run   CELL ' })).toEqual([
        'notebook:run-cell'
      ]);
    });

    it('searches the id, label, caption and usage', async () => {
      expect(await ids({ query: 'docmanager' })).toEqual(['docmanager:open']);
      expect(await ids({ query: 'selected run' })).toEqual([
        'notebook:run-cell'
      ]);
      expect(await ids({ query: 'create a console' })).toEqual([
        'console:create'
      ]);
      expect(await ids({ query: 'switch dark' })).toEqual(['theme:dark']);
      expect(await ids({ query: 'next one' })).toEqual(['notebook:run-cell']);
    });

    it('describes each command', async () => {
      const tool = Tools.listAllCommands(createOptions(createCommands()));
      const { commands } = await run(tool);
      const find = (id: string) =>
        commands.find((entry: ReadonlyPartialJSONObject) => entry.id === id);
      expect(find('notebook:run-cell')).toEqual({
        id: 'notebook:run-cell',
        label: 'Run Selected Cell',
        caption: 'Run the selected cell',
        description: 'Runs the cell and selects the next one.',
        args: {
          type: 'object',
          properties: { activate: { type: 'boolean' } }
        },
        enabled: true
      });
      // A caption equal to the label and a usage equal to the caption are
      // not repeated.
      expect(find('docmanager:open')).toEqual({
        id: 'docmanager:open',
        label: 'Open',
        args: { type: 'object', properties: { path: { type: 'string' } } },
        enabled: true
      });
      expect(find('console:create')).toEqual({
        id: 'console:create',
        label: 'New Console',
        caption: 'Create a console',
        enabled: false
      });
      // Failing callbacks give empty values.
      expect(find('help:about')).toEqual({
        id: 'help:about',
        label: '',
        enabled: true
      });
    });

    it('reports the state of toggle commands', async () => {
      const commands = new CommandRegistry();
      let toggled = false;
      commands.addCommand('test:toggle', {
        isToggleable: true,
        isToggled: () => toggled,
        execute: () => (toggled = !toggled)
      });
      commands.addCommand('test:plain', { execute: () => null });
      const tool = Tools.listAllCommands(createOptions(commands));
      const entries = async () => (await run(tool)).commands;
      expect(await entries()).toEqual([
        { id: 'test:plain', label: '', enabled: true },
        { id: 'test:toggle', label: '', enabled: true, toggled: false }
      ]);
      await commands.execute('test:toggle');
      expect((await entries())[1].toggled).toBe(true);
    });

    it('omits the args of a command with only UI arguments', async () => {
      const commands = new CommandRegistry();
      commands.addCommand('ui:only', {
        describedBy: {
          args: {
            type: 'object',
            properties: { isPalette: { type: 'boolean' } },
            required: ['isPalette']
          }
        },
        execute: () => null
      });
      const tool = Tools.listAllCommands(createOptions(commands));
      const { commands: entries } = await run(tool);
      expect(entries[0]).not.toHaveProperty('args');
    });

    it('lists the args schema without additionalProperties', async () => {
      const commands = new CommandRegistry();
      commands.addCommand('strict:open', {
        describedBy: {
          args: {
            type: 'object',
            properties: { path: { type: 'string' } },
            additionalProperties: false
          }
        },
        execute: () => null
      });
      const tool = Tools.listAllCommands(createOptions(commands));
      const { commands: entries } = await run(tool);
      expect(entries[0].args).toEqual({
        type: 'object',
        properties: { path: { type: 'string' } }
      });
    });

    it('limits the number of commands', async () => {
      const tool = Tools.listAllCommands(createOptions(createCommands()));
      let result = await run(tool, { limit: 2 });
      expect(result.commands).toHaveLength(2);
      expect(result.commandCount).toBe(6);
      expect(result).not.toHaveProperty('truncated');

      result = await run(tool, { limit: '3' });
      expect(result.commands).toHaveLength(3);

      result = await run(tool, { limit: 6 });
      expect(result.commands).toHaveLength(6);

      result = await run(tool, { limit: -1 });
      expect(result.commands).toHaveLength(1);

      result = await run(tool, { limit: 'many' });
      expect(result.commands).toHaveLength(6);
    });

    it('returns 50 commands by default', async () => {
      const commands = new CommandRegistry();
      for (let i = 0; i < 60; i++) {
        commands.addCommand(`test:command-${i}`, { execute: () => null });
      }
      const tool = Tools.listAllCommands(createOptions(commands));
      const result = await run(tool);
      expect(result.commands).toHaveLength(Tools.DEFAULT_LIST_LIMIT);
      expect(result.commandCount).toBe(60);
    });

    it('hides the blocked commands', async () => {
      const isBlocked = (id: string) => id.startsWith('notebook:');
      const tool = Tools.listAllCommands(
        createOptions(createCommands(), { isBlocked })
      );
      const result = await run(tool, { query: 'cell' });
      expect(result.commandCount).toBe(0);
      expect(result.commands).toEqual([]);
      expect(await ids({}, { isBlocked })).not.toContain('notebook:run-cell');
    });

    it('reports the dedicated tool of a command', async () => {
      const toolFor = (id: string) =>
        id === 'docmanager:open' ? 'open_document' : undefined;
      const tool = Tools.listAllCommands(
        createOptions(createCommands(), { toolFor })
      );
      const { commands } = await run(tool, { query: 'open' });
      expect(commands).toEqual([
        expect.objectContaining({
          id: 'docmanager:open',
          tool: 'open_document'
        })
      ]);
      const other = await run(tool, { query: 'theme' });
      expect(other.commands[0]).not.toHaveProperty('tool');
    });

    it('returns an error result when a callback throws', async () => {
      const toolFor = () => {
        throw new Error('Boom');
      };
      const tool = Tools.listAllCommands(
        createOptions(createCommands(), { toolFor })
      );
      expect(await run(tool)).toEqual({
        success: false,
        isError: true,
        error: 'Boom'
      });
    });

    it('is a read-only tool returning untrusted content', () => {
      const tool = Tools.listAllCommands(createOptions());
      expect(tool.annotations).toEqual({
        readOnlyHint: true,
        untrustedContentHint: true
      });
    });
  });

  describe('execute_command', () => {
    function setup() {
      const commands = new CommandRegistry();
      const execute = jest.fn((args: ReadonlyPartialJSONObject) => ({
        received: args
      }));
      commands.addCommand('test:echo', {
        describedBy: {
          args: { type: 'object', properties: { path: { type: 'string' } } }
        },
        execute
      });
      const tool = Tools.executeCommand(createOptions(commands));
      return { commands, execute, tool };
    }

    it('runs a command with an args object', async () => {
      const { execute, tool } = setup();
      const result = await run(tool, {
        command_id: 'test:echo',
        args: { path: 'a.txt' }
      });
      expect(result).toEqual({
        success: true,
        result: { received: { path: 'a.txt' } }
      });
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it('accepts args as a JSON string', async () => {
      const { tool } = setup();
      const result = await run(tool, {
        command_id: 'test:echo',
        args: '{"path": "b.txt"}'
      });
      expect(result).toEqual({
        success: true,
        result: { received: { path: 'b.txt' } }
      });
    });

    it('accepts missing or empty args', async () => {
      const { tool } = setup();
      for (const args of [undefined, null, '']) {
        expect(await run(tool, { command_id: 'test:echo', args })).toEqual({
          success: true,
          result: { received: {} }
        });
      }
    });

    it('accepts args encoded twice as JSON', async () => {
      const { tool } = setup();
      const result = await run(tool, {
        command_id: 'test:echo',
        args: JSON.stringify(JSON.stringify({ path: 'c.txt' }))
      });
      expect(result).toEqual({
        success: true,
        result: { received: { path: 'c.txt' } }
      });
    });

    it('refuses args that are not valid JSON', async () => {
      const { execute, tool } = setup();
      const result = await run(tool, {
        command_id: 'test:echo',
        args: '{path: b.txt}'
      });
      expect(result).toEqual({
        success: false,
        isError: true,
        error: expect.stringMatching(/^"args" is not valid JSON: /)
      });
      expect(execute).not.toHaveBeenCalled();
    });

    it('refuses args that are not an object', async () => {
      const { execute, tool } = setup();
      for (const args of [[1, 2], '[1]', 42, true]) {
        expect(await run(tool, { command_id: 'test:echo', args })).toEqual({
          success: false,
          isError: true,
          error: '"args" must be a JSON object'
        });
      }
      expect(execute).not.toHaveBeenCalled();
    });

    it('does not check the argument names', async () => {
      const { tool } = setup();
      const result = await run(tool, {
        command_id: 'test:echo',
        args: { other: 1 }
      });
      expect(result).toEqual({
        success: true,
        result: { received: { other: 1 } }
      });
    });

    it('reports unknown commands', async () => {
      const { tool } = setup();
      expect(await run(tool, { command_id: 'nope:x' })).toEqual({
        success: false,
        isError: true,
        error:
          'Unknown command "nope:x". Use list_all_commands to find the available commands.'
      });
      expect(await run(tool)).toEqual({
        success: false,
        isError: true,
        error: expect.stringContaining('Unknown command ""')
      });
    });

    it('returns results that report success as they are', async () => {
      const { commands, tool } = setup();
      commands.addCommand('test:fail', {
        execute: () => ({
          success: false,
          isError: true,
          errorName: 'NameError',
          errorValue: 'x is not defined'
        })
      });
      expect(await run(tool, { command_id: 'test:fail' })).toEqual({
        success: false,
        isError: true,
        errorName: 'NameError',
        errorValue: 'x is not defined',
        error: 'NameError: x is not defined'
      });
    });

    it('reports the errors of the command', async () => {
      const { commands, tool } = setup();
      commands.addCommand('test:throw', {
        execute: () => {
          throw new Error('It failed');
        }
      });
      expect(await run(tool, { command_id: 'test:throw' })).toEqual({
        success: false,
        isError: true,
        error: 'It failed'
      });
    });

    it('warns when the command is not enabled', async () => {
      const { commands, tool } = setup();
      commands.addCommand('test:disabled', {
        isEnabled: () => false,
        execute: () => 'done'
      });
      const result = await run(tool, { command_id: 'test:disabled' });
      expect(result).toMatchObject({ success: true, result: 'done' });
      expect(result.warning).toMatch(/not enabled/);
    });

    it('does not run the command of a cancelled call', async () => {
      const { execute, tool } = setup();
      const controller = new AbortController();
      controller.abort();
      const result = await run(
        tool,
        { command_id: 'test:echo' },
        controller.signal
      );
      expect(result).toEqual({
        success: false,
        isError: true,
        error: 'The tool call was cancelled.'
      });
      expect(execute).not.toHaveBeenCalled();
    });

    it('returns a pending result when the agent cancels the call', async () => {
      const { commands, tool } = setup();
      commands.addCommand('test:slow', {
        execute: () => new Promise(() => undefined)
      });
      const controller = new AbortController();
      const promise = run(tool, { command_id: 'test:slow' }, controller.signal);
      await new Promise(resolve => setTimeout(resolve, 5));
      controller.abort();
      expect(await promise).toMatchObject({
        status: 'pending',
        pendingId: expect.any(String),
        tool: 'execute_command'
      });
    });

    it('has the expected schema and annotations', () => {
      const { tool } = setup();
      expect(tool.inputSchema).toMatchObject({ required: ['command_id'] });
      expect(tool.annotations).toEqual({
        consequentialHint: true,
        untrustedContentHint: true
      });
    });
  });

  describe('commandTool', () => {
    function setup() {
      const commands = new CommandRegistry();
      const received: ReadonlyPartialJSONObject[] = [];
      commands.addCommand('test:open', {
        label: 'Open Test',
        caption: 'Open a test file.',
        describedBy: {
          args: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'The path.' },
              line: { type: 'integer' },
              background: { type: 'boolean' },
              isPalette: { type: 'boolean' },
              toolbar: { type: 'boolean' }
            },
            required: ['path', 'background', 'toolbar']
          }
        },
        execute: args => {
          received.push(args);
          return { success: true, path: args.path as string };
        }
      });
      const options = createOptions(commands);
      return { commands, options, received };
    }

    it('builds the input schema from the command', async () => {
      const { options } = setup();
      const tool = await Tools.commandTool(
        options,
        {
          command: 'test:open',
          args: { background: true },
          required: ['line']
        },
        'test:open',
        'open_test'
      );
      expect(tool.name).toBe('open_test');
      expect(tool.inputSchema).toEqual({
        type: 'object',
        properties: {
          path: { type: 'string', description: 'The path.' },
          line: { type: 'integer' }
        },
        required: ['path', 'line'],
        additionalProperties: false
      });
    });

    it('keeps the additionalProperties of the command', async () => {
      const commands = new CommandRegistry();
      commands.addCommand('test:open', {
        describedBy: {
          args: {
            type: 'object',
            properties: { path: { type: 'string' } },
            additionalProperties: true
          }
        },
        execute: () => null
      });
      const tool = await Tools.commandTool(
        createOptions(commands),
        { command: 'test:open' },
        'test:open',
        'open'
      );
      expect(tool.inputSchema).toEqual({
        type: 'object',
        properties: { path: { type: 'string' } },
        additionalProperties: true
      });
    });

    it('does not require a fixed argument', async () => {
      const { options } = setup();
      const tool = await Tools.commandTool(
        options,
        {
          command: 'test:open',
          args: { path: 'fixed.txt', background: true },
          required: ['path']
        },
        'test:open',
        'open_fixed'
      );
      expect(tool.inputSchema).toEqual({
        type: 'object',
        properties: { line: { type: 'integer' } },
        additionalProperties: false
      });
    });

    it('uses an empty object schema when the command has none', async () => {
      const commands = new CommandRegistry();
      commands.addCommand('test:plain', { execute: () => null });
      commands.addCommand('test:string', {
        describedBy: { args: { type: 'string' } },
        execute: () => null
      });
      commands.addCommand('test:throw', {
        describedBy: () => {
          throw new Error('No schema');
        },
        execute: () => null
      });
      commands.addCommand('test:reject', {
        describedBy: () => Promise.reject(new Error('No schema')),
        execute: () => null
      });
      const options = createOptions(commands);
      for (const id of ['test:plain', 'test:string', 'test:throw']) {
        const tool = await Tools.commandTool(options, { command: id }, id, 't');
        expect(tool.inputSchema).toEqual({ type: 'object', properties: {} });
      }
      const tool = await Tools.commandTool(
        options,
        { command: 'test:reject', required: ['path'] },
        'test:reject',
        't'
      );
      // A required argument the command does not describe accepts any value.
      expect(tool.inputSchema).toEqual({
        type: 'object',
        properties: { path: {} },
        required: ['path']
      });
    });

    it('gives up on a schema that takes too long', async () => {
      const commands = new CommandRegistry();
      commands.addCommand('test:hang', {
        describedBy: () => new Promise(() => undefined),
        execute: () => null
      });
      const options = createOptions(commands);
      jest.useFakeTimers();
      try {
        const promise = Tools.commandTool(
          options,
          { command: 'test:hang' },
          'test:hang',
          'hang'
        );
        await jest.advanceTimersByTimeAsync(5000);
        const tool = await promise;
        expect(tool.inputSchema).toEqual({ type: 'object', properties: {} });
      } finally {
        jest.useRealTimers();
      }
    });

    it('describes the tool', async () => {
      const commands = new CommandRegistry();
      commands.addCommand('test:caption', {
        label: 'Label',
        caption: 'Do something',
        execute: () => null
      });
      commands.addCommand('test:period', {
        caption: 'Do something.',
        execute: () => null
      });
      commands.addCommand('test:label', {
        label: 'Only Label',
        execute: () => null
      });
      commands.addCommand('test:bare', { execute: () => null });
      const options = createOptions(commands);
      const build = (id: string, description?: string) =>
        Tools.commandTool(options, { command: id, description }, id, 'tool');

      let tool = await build('test:caption', 'Custom description.');
      expect(tool.description).toBe('Custom description.');
      expect(tool.title).toBe('Label');

      tool = await build('test:caption');
      expect(tool.description).toBe(
        'Do something. Runs the Jupyter command "test:caption".'
      );
      tool = await build('test:period');
      expect(tool.description).toBe(
        'Do something. Runs the Jupyter command "test:period".'
      );
      expect(tool.title).toBe('tool');
      tool = await build('test:label');
      expect(tool.description).toBe(
        'Only Label. Runs the Jupyter command "test:label".'
      );
      tool = await build('test:bare');
      expect(tool.description).toBe(
        'test:bare. Runs the Jupyter command "test:bare".'
      );
    });

    it('keeps the dots of the caption', async () => {
      const commands = new CommandRegistry();
      commands.addCommand('test:up', {
        caption: 'Go to ../data',
        execute: () => null
      });
      commands.addCommand('test:more', {
        label: ' Open... ',
        execute: () => null
      });
      const options = createOptions(commands);
      let tool = await Tools.commandTool(
        options,
        { command: 'test:up' },
        'test:up',
        'up'
      );
      expect(tool.description).toBe(
        'Go to ../data. Runs the Jupyter command "test:up".'
      );
      tool = await Tools.commandTool(
        options,
        { command: 'test:more' },
        'test:more',
        'more'
      );
      expect(tool.description).toBe(
        'Open... Runs the Jupyter command "test:more".'
      );
    });

    it('uses the annotations of the spec or guesses them', async () => {
      const commands = new CommandRegistry();
      commands.addCommand('test:delete-file', { execute: () => null });
      commands.addCommand('test:open', { execute: () => null });
      const options = createOptions(commands);
      let tool = await Tools.commandTool(
        options,
        { command: 'test:delete-file', annotations: { readOnlyHint: true } },
        'test:delete-file',
        'a'
      );
      expect(tool.annotations).toEqual({ readOnlyHint: true });
      tool = await Tools.commandTool(
        options,
        { command: 'test:delete-file' },
        'test:delete-file',
        'b'
      );
      expect(tool.annotations).toEqual({ consequentialHint: true });
      tool = await Tools.commandTool(
        options,
        { command: 'test:open' },
        'test:open',
        'c'
      );
      expect(tool.annotations).toEqual({});
    });

    it('runs the command with the input and the fixed arguments', async () => {
      const { options, received } = setup();
      const tool = await Tools.commandTool(
        options,
        { command: 'test:open', args: { background: true } },
        'test:open',
        'open_test'
      );
      const result = await run(tool, { path: 'a.txt', line: 3 });
      expect(result).toEqual({ success: true, path: 'a.txt' });
      expect(received).toEqual([{ path: 'a.txt', line: 3, background: true }]);
    });

    it('refuses unknown arguments and lists the accepted ones', async () => {
      const { options, received } = setup();
      const tool = await Tools.commandTool(
        options,
        { command: 'test:open', args: { background: true } },
        'test:open',
        'open_test'
      );
      expect(await run(tool, { pth: 'a.txt' })).toEqual({
        success: false,
        isError: true,
        error: 'Unknown argument "pth". Accepted arguments: "path", "line".'
      });
      expect(
        await run(tool, { path: 'a.txt', file: 'b', background: false })
      ).toEqual({
        success: false,
        isError: true,
        error:
          'Unknown arguments "file", "background". Accepted arguments: "path", "line".'
      });
      expect(received).toEqual([]);
    });

    it('refuses missing required arguments and wrong types', async () => {
      const { options, received } = setup();
      const tool = await Tools.commandTool(
        options,
        {
          command: 'test:open',
          args: { background: true },
          required: ['line']
        },
        'test:open',
        'open_test'
      );
      expect(await run(tool, { path: 'a.txt' })).toEqual({
        success: false,
        isError: true,
        error: 'Missing required argument "line".'
      });
      expect(await run(tool, { path: '' })).toEqual({
        success: false,
        isError: true,
        error: 'Missing required arguments "path", "line".'
      });
      expect(await run(tool, { path: 'a.txt', line: '3' })).toEqual({
        success: false,
        isError: true,
        error: 'Argument "line" must be of type integer.'
      });
      expect(received).toEqual([]);
    });

    it('drops null values of optional arguments', async () => {
      const { options, received } = setup();
      const tool = await Tools.commandTool(
        options,
        { command: 'test:open', args: { background: true } },
        'test:open',
        'open_test'
      );
      expect(await run(tool, { path: 'a.txt', line: null })).toEqual({
        success: true,
        path: 'a.txt'
      });
      expect(await run(tool, { path: null })).toEqual({
        success: false,
        isError: true,
        error: 'Missing required argument "path".'
      });
      expect(received).toEqual([{ path: 'a.txt', background: true }]);
    });

    it('accepts an empty string for a required non-identifier argument', async () => {
      const commands = new CommandRegistry();
      const received: ReadonlyPartialJSONObject[] = [];
      commands.addCommand('test:insert', {
        describedBy: {
          args: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              cellId: { type: 'string' }
            },
            required: ['text', 'cellId']
          }
        },
        execute: args => {
          received.push(args);
          return null;
        }
      });
      const tool = await Tools.commandTool(
        createOptions(commands),
        { command: 'test:insert' },
        'test:insert',
        'insert'
      );
      expect(await run(tool, { text: '', cellId: '' })).toEqual({
        success: false,
        isError: true,
        error: 'Missing required argument "cellId".'
      });
      expect(await run(tool, { text: '', cellId: 'c1' })).toEqual({
        success: true,
        result: null
      });
      expect(received).toEqual([{ text: '', cellId: 'c1' }]);
    });

    it('refuses unknown arguments when every argument is fixed', async () => {
      const { options, received } = setup();
      const tool = await Tools.commandTool(
        options,
        {
          command: 'test:open',
          args: { path: 'a.txt', line: 1, background: true }
        },
        'test:open',
        'open_all_fixed'
      );
      expect(tool.inputSchema).toEqual({
        type: 'object',
        properties: {},
        additionalProperties: false
      });
      expect(await run(tool, { other: 1 })).toEqual({
        success: false,
        isError: true,
        error: expect.stringMatching(/^Unknown argument "other"\./)
      });
      expect(await run(tool, {})).toEqual({ success: true, path: 'a.txt' });
      expect(received).toEqual([{ path: 'a.txt', line: 1, background: true }]);
    });

    it('drops the UI arguments of the input', async () => {
      const { options, received } = setup();
      const tool = await Tools.commandTool(
        options,
        { command: 'test:open', args: { background: true } },
        'test:open',
        'open_test'
      );
      await run(tool, { path: 'a.txt', isPalette: true, toolbar: true });
      expect(received).toEqual([{ path: 'a.txt', background: true }]);
    });

    it('lets the fixed arguments override the input', async () => {
      const commands = new CommandRegistry();
      const received: ReadonlyPartialJSONObject[] = [];
      const execute = (args: ReadonlyPartialJSONObject) => {
        received.push(args);
        return null;
      };
      commands.addCommand('test:plain', { execute });
      commands.addCommand('test:open-schema', {
        describedBy: {
          args: {
            type: 'object',
            properties: { a: { type: 'string' } },
            additionalProperties: true
          }
        },
        execute
      });
      const options = createOptions(commands);
      let tool = await Tools.commandTool(
        options,
        { command: 'test:plain', args: { mode: 'fixed' } },
        'test:plain',
        'plain'
      );
      await run(tool, { mode: 'agent', other: 1 });
      tool = await Tools.commandTool(
        options,
        { command: 'test:open-schema', args: { b: 'fixed' } },
        'test:open-schema',
        'open_schema'
      );
      await run(tool, { a: 'x', b: 'agent' });
      expect(received).toEqual([
        { mode: 'fixed', other: 1 },
        { a: 'x', b: 'fixed' }
      ]);
    });

    it('reports a command removed after the tool was built', async () => {
      const commands = new CommandRegistry();
      const command = commands.addCommand('test:gone', {
        execute: () => null
      });
      const tool = await Tools.commandTool(
        createOptions(commands),
        { command: 'test:gone' },
        'test:gone',
        'gone'
      );
      command.dispose();
      expect(await run(tool)).toEqual({
        success: false,
        isError: true,
        error: expect.stringContaining('Unknown command "test:gone"')
      });
    });

    it('shows only the inputs of the spec and refuses the others', async () => {
      const { options, received } = setup();
      const tool = await Tools.commandTool(
        options,
        { command: 'test:open', args: { background: true }, inputs: ['path'] },
        'test:open',
        'open_path'
      );
      expect(tool.inputSchema).toEqual({
        type: 'object',
        properties: { path: { type: 'string', description: 'The path.' } },
        required: ['path'],
        additionalProperties: false
      });
      expect(await run(tool, { path: 'a.txt', line: 3 })).toEqual({
        success: false,
        isError: true,
        error: 'Unknown argument "line". Accepted arguments: "path".'
      });
      expect(await run(tool, { path: 'a.txt' })).toEqual({
        success: true,
        path: 'a.txt'
      });
      expect(received).toEqual([{ path: 'a.txt', background: true }]);
    });

    it('accepts unknown arguments when the command declares no arguments', async () => {
      const commands = new CommandRegistry();
      const received: ReadonlyPartialJSONObject[] = [];
      commands.addCommand('myext:goto', {
        execute: args => {
          received.push(args);
          return null;
        }
      });
      const tool = await Tools.commandTool(
        createOptions(commands),
        { command: 'myext:goto', name: 'goto_line', required: ['path'] },
        'myext:goto',
        'goto_line'
      );
      expect(tool.inputSchema).toEqual({
        type: 'object',
        properties: { path: {} },
        required: ['path']
      });
      expect(await run(tool, { path: 'a.py', line: 10 })).toEqual({
        success: true,
        result: null
      });
      expect(await run(tool, { line: 10 })).toEqual({
        success: false,
        isError: true,
        error: 'Missing required argument "path".'
      });
      expect(received).toEqual([{ path: 'a.py', line: 10 }]);
    });

    it('reports pending calls with the tool name', async () => {
      const commands = new CommandRegistry();
      commands.addCommand('test:slow', {
        execute: () => new Promise(() => undefined)
      });
      const tool = await Tools.commandTool(
        createOptions(commands, {}, { timeout: 10 }),
        { command: 'test:slow' },
        'test:slow',
        'slow_tool'
      );
      expect(await run(tool)).toMatchObject({
        status: 'pending',
        tool: 'slow_tool'
      });
    });
  });

  describe('answer_dialog', () => {
    it('requires a button', async () => {
      const tool = Tools.answerDialog(createOptions());
      expect(tool.inputSchema).toMatchObject({ required: ['button'] });
      for (const input of [
        {},
        { button: true },
        { button: null },
        { button: {} }
      ]) {
        expect(await run(tool, input)).toEqual({
          success: false,
          isError: true,
          error: '"button" is required.'
        });
      }
    });

    it('reports that no dialog is open', async () => {
      const tool = Tools.answerDialog(createOptions());
      expect(await run(tool, { button: 'Ok' })).toEqual({
        success: false,
        isError: true,
        error: 'No dialog is open.',
        dialogs: []
      });
    });

    it('answers the only open dialog', async () => {
      const { dialog, result } = await openDialog();
      const tool = Tools.answerDialog(createOptions());
      expect(await run(tool, { button: 1, dialogId: '' })).toEqual({
        success: true,
        answered: { dialogId: expect.stringMatching(/^dialog-/), button: 'Ok' }
      });
      expect(dialog.isDisposed).toBe(true);
      expect((await result).button.label).toBe('Ok');
    });

    it('reports a button that does not exist', async () => {
      const { dialog } = await openDialog();
      const tool = Tools.answerDialog(createOptions());
      const result = await run(tool, { button: 'Maybe' });
      expect(result).toMatchObject({
        success: false,
        isError: true,
        error: 'No button "Maybe" in the dialog. Buttons: ["Cancel","Ok"].',
        dialog: { buttons: ['Cancel', 'Ok'] }
      });
      expect(result).not.toHaveProperty('dialogs');
      expect(dialog.isDisposed).toBe(false);
    });

    it('is a consequential tool returning untrusted content', () => {
      const tool = Tools.answerDialog(createOptions());
      expect(tool.annotations).toEqual({
        consequentialHint: true,
        untrustedContentHint: true
      });
      expect(tool.description).toContain('queued');
    });

    it('refuses to guess the dialog when one is queued', async () => {
      const first = await openDialog('First');
      const second = new Dialog({
        title: 'Second',
        body: 'Queued',
        buttons: [Dialog.okButton()]
      });
      second.launch().catch(() => undefined);
      const tool = Tools.answerDialog(createOptions());
      const firstId = Dialogs.idOf(first.dialog);
      const secondId = Dialogs.idOf(second);
      const dialogs = [
        expect.objectContaining({ id: firstId, title: 'First', shown: true }),
        expect.objectContaining({ id: secondId, body: 'Queued', shown: false })
      ];
      expect(await run(tool, { button: 'Ok' })).toEqual({
        success: false,
        isError: true,
        error: 'Several dialogs are open (shown or queued): pass dialogId.',
        dialogs
      });
      expect(await run(tool, { button: 'Ok', dialogId: secondId })).toEqual({
        success: false,
        isError: true,
        error: `The dialog "${secondId}" is queued behind the dialog that is shown. Only the shown dialog can be answered.`,
        dialogs
      });
      expect(first.dialog.isDisposed).toBe(false);
      expect(
        await run(tool, { button: 'Ok', dialogId: firstId })
      ).toMatchObject({
        success: true,
        answered: { dialogId: firstId, button: 'Ok' }
      });
      await waitFor(() => second.isAttached);
      expect(await run(tool, { button: 'Ok' })).toEqual({
        success: true,
        answered: { dialogId: secondId, button: 'Ok' }
      });
    });

    it('continues the call that opened the dialog', async () => {
      const commands = new CommandRegistry();
      commands.addCommand('test:confirm', {
        execute: async () => {
          const answer = await showDialog({
            title: 'Confirm',
            body: 'Sure?',
            buttons: [Dialog.cancelButton(), Dialog.okButton()]
          });
          return { clicked: answer.button.label };
        }
      });
      const options = createOptions(commands);
      const pending = await run(Tools.executeCommand(options), {
        command_id: 'test:confirm'
      });
      expect(pending).toMatchObject({
        status: 'pending',
        dialog: { title: 'Confirm', buttons: ['Cancel', 'Ok'] }
      });
      expect(pending).not.toHaveProperty('dialogs');
      const result = await run(Tools.answerDialog(options), { button: 'ok' });
      expect(result).toEqual({
        success: true,
        result: { clicked: 'Ok' },
        answered: { dialogId: pending.dialog.id, button: 'Ok' }
      });
    });
  });

  describe('wait_for_result', () => {
    it('requires a known pendingId', async () => {
      const tool = Tools.waitForResult(createOptions());
      expect(tool.inputSchema).toMatchObject({ required: ['pendingId'] });
      for (const input of [{}, { pendingId: '' }, { pendingId: 42 }]) {
        expect(await run(tool, input)).toEqual({
          success: false,
          isError: true,
          error: '"pendingId" is required.'
        });
      }
      expect(await run(tool, { pendingId: 'call-99' })).toEqual({
        success: false,
        isError: true,
        error: 'Unknown or expired pendingId "call-99".'
      });
    });

    it('returns the result of a pending call', async () => {
      const commands = new CommandRegistry();
      const done = new PromiseDelegate<string>();
      commands.addCommand('test:slow', { execute: () => done.promise });
      const options = createOptions(commands, {}, { timeout: 10 });
      const pending = await run(Tools.executeCommand(options), {
        command_id: 'test:slow'
      });
      expect(pending.status).toBe('pending');
      done.resolve('finished');
      const result = await run(Tools.waitForResult(options), {
        pendingId: pending.pendingId
      });
      expect(result).toEqual({ success: true, result: 'finished' });
    });

    it('reports the dialogs open at each wait', async () => {
      const commands = new CommandRegistry();
      const done = new PromiseDelegate<string>();
      commands.addCommand('test:slow', { execute: () => done.promise });
      const options = createOptions(commands, {}, { timeout: 10 });
      const pending = await run(Tools.executeCommand(options), {
        command_id: 'test:slow'
      });
      expect(pending.status).toBe('pending');
      const user = await openDialog('User');
      done.resolve('finished');
      const tool = Tools.waitForResult(options);
      const input = { pendingId: pending.pendingId };
      expect(await run(tool, input)).toEqual({
        success: true,
        result: 'finished',
        dialogs: [expect.objectContaining({ title: 'User' })]
      });
      user.dialog.resolve(0);
      const other = await openDialog('Other');
      expect(await run(tool, input)).toEqual({
        success: true,
        result: 'finished',
        dialogs: [expect.objectContaining({ title: 'Other' })]
      });
      other.dialog.resolve(0);
      expect(await run(tool, input)).toEqual({
        success: true,
        result: 'finished'
      });
    });

    it('caps the wait to the execution timeout', async () => {
      const commands = new CommandRegistry();
      commands.addCommand('test:slow', {
        execute: () => new Promise(() => undefined)
      });
      const options = createOptions(commands, {}, { timeout: 20 });
      const pending = await run(Tools.executeCommand(options), {
        command_id: 'test:slow'
      });
      const tool = Tools.waitForResult(options);
      for (const timeout of [3600, 'soon', undefined]) {
        expect(
          await run(tool, { pendingId: pending.pendingId, timeout })
        ).toMatchObject({ status: 'pending', pendingId: pending.pendingId });
      }
    });
  });

  describe('results', () => {
    it('marks failed results with isError', async () => {
      const commands = new CommandRegistry();
      commands.addCommand('test:fail', {
        execute: () => ({ success: false, error: 'Nope' })
      });
      commands.addCommand('test:ok', { execute: () => ({ success: true }) });
      const tool = Tools.executeCommand(createOptions(commands));
      expect(await run(tool, { command_id: 'test:fail' })).toEqual({
        success: false,
        error: 'Nope',
        isError: true
      });
      expect(await run(tool, { command_id: 'test:ok' })).toEqual({
        success: true
      });
    });

    it('keeps isError in a preview', async () => {
      const commands = new CommandRegistry();
      commands.addCommand('test:big-fail', {
        execute: () => ({
          success: false,
          error: 'Too big',
          rows: Array.from({ length: 20 }, () => 'r'.repeat(340))
        })
      });
      const tool = Tools.executeCommand(
        createOptions(commands, { maxResultLength: () => 1000 })
      );
      expect(await run(tool, { command_id: 'test:big-fail' })).toMatchObject({
        success: false,
        isError: true,
        error: 'Too big',
        truncated: true
      });
    });

    it('bounds the results to maxResultLength', async () => {
      const commands = new CommandRegistry();
      commands.addCommand('test:big', { execute: () => 'x'.repeat(10000) });
      let max = 2000;
      const tool = Tools.executeCommand(
        createOptions(commands, { maxResultLength: () => max })
      );
      let result = await run(tool, { command_id: 'test:big' });
      expect(result.truncated).toBe(true);
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(2000);

      max = 20000;
      result = await run(tool, { command_id: 'test:big' });
      expect(result).toEqual({ success: true, result: 'x'.repeat(10000) });
    });

    it('bounds the list of commands', async () => {
      const commands = new CommandRegistry();
      for (let i = 0; i < 100; i++) {
        commands.addCommand(`test:command-${i}`, {
          label: `Command ${i}`,
          execute: () => null
        });
      }
      const tool = Tools.listAllCommands(
        createOptions(commands, { maxResultLength: () => 1000 })
      );
      const result = await run(tool, { limit: 100 });
      expect(result.truncated).toBe(true);
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(1000);
    });

    it('adds the open dialogs', async () => {
      const commands = new CommandRegistry();
      commands.addCommand('test:quick', { execute: () => 'done' });
      const options = createOptions(commands);
      expect(
        await run(Tools.executeCommand(options), { command_id: 'test:quick' })
      ).toEqual({ success: true, result: 'done' });

      const { dialog } = await openDialog();
      const expected = [
        expect.objectContaining({ title: 'Title', buttons: ['Cancel', 'Ok'] })
      ];
      expect(
        await run(Tools.executeCommand(options), { command_id: 'test:quick' })
      ).toEqual({ success: true, result: 'done', dialogs: expected });
      const listed = await run(Tools.listAllCommands(options));
      expect(listed.dialogs).toEqual(expected);
      expect(
        await run(Tools.waitForResult(options), { pendingId: 'call-0' })
      ).toMatchObject({ success: false, isError: true, dialogs: expected });
      dialog.dispose();
    });
  });
});
