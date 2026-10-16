import { ISettingRegistry, SettingRegistry } from '@jupyterlab/settingregistry';
import { CommandRegistry } from '@lumino/commands';
import { JSONObject, PromiseDelegate } from '@lumino/coreutils';
import { Signal } from '@lumino/signaling';
import { CommandIDs } from '../commands';
import { ToolManager } from '../manager';
import { WebMCPRegistry } from '../registry';
import { DEFAULT_TOOLS } from '../specs';
import { Tools } from '../tools';
import { FakeModelContext, createApp, trans, waitFor } from './utils';

type Values = Record<string, unknown>;

/**
 * A fake `ISettingRegistry.ISettings`. As in JupyterLab, a list of the user
 * settings replaces the default list in the composite; the defaults include
 * the values of overrides.json.
 */
class FakeSettings {
  constructor(
    public user: Values,
    public defaults: Values = {}
  ) {}

  readonly changed = new Signal<FakeSettings, void>(this);

  get composite(): Values {
    return { ...this.defaults, ...this.user };
  }

  default(key: string): unknown {
    return this.defaults[key];
  }

  update(user: Values): void {
    this.user = user;
    this.changed.emit();
  }
}

const BUILTINS = [...Tools.BUILTIN_NAMES].sort();

const AI = 'jupyterlab-ai-commands:';

/**
 * Add a command that returns its id and arguments.
 */
function addCommand(
  commands: CommandRegistry,
  id: string,
  options: Partial<CommandRegistry.ICommandOptions> = {}
) {
  return commands.addCommand(id, {
    execute: args => ({ success: true, id, args }),
    ...options
  });
}

/**
 * Wait until the scheduled synchronizations are done.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

const managers: ToolManager[] = [];

/**
 * Create a manager with a fake app, model context and settings: the user
 * settings and their defaults.
 */
function setup(config: Values = {}, defaults: Values = {}) {
  const commands = new CommandRegistry();
  const context = new FakeModelContext();
  const registry = new WebMCPRegistry(context);
  const { app } = createApp({ commands });
  const manager = new ToolManager({ app, registry, trans });
  managers.push(manager);
  const settings = new FakeSettings(config, defaults);
  // Each synchronization lists the commands once.
  const passes = jest.spyOn(commands, 'listCommands');
  return {
    commands,
    context,
    registry,
    manager,
    settings,
    passes: () => passes.mock.calls.length,
    has: (name: string) => registry.toolNames.includes(name),
    start: async () => {
      manager.start(settings as unknown as ISettingRegistry.ISettings);
      await flush();
    },
    call: (name: string, input: JSONObject = {}) => context.call(name, input)
  };
}

let warn: jest.SpyInstance;
let error: jest.SpyInstance;

beforeEach(() => {
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  while (managers.length) {
    managers.pop()!.dispose();
  }
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('ToolManager', () => {
  describe('built-in tools', () => {
    it('registers the built-in tools', async () => {
      const { manager, registry, context, start, passes } = setup();
      await start();
      expect(registry.toolNames).toEqual(BUILTINS);
      expect(Array.from(context.tools.keys()).sort()).toEqual(BUILTINS);
      expect(Array.from(manager.tools.values())).toEqual(
        BUILTINS.map(() => null)
      );
      expect(manager.warnings).toEqual([]);
      expect(manager.error).toBeNull();
      expect(passes()).toBe(1);
      expect(error).not.toHaveBeenCalled();
    });

    it('does nothing when WebMCP is not available', async () => {
      const { app, commands } = createApp();
      const passes = jest.spyOn(commands, 'listCommands');
      const manager = new ToolManager({
        app,
        registry: new WebMCPRegistry(null),
        trans
      });
      managers.push(manager);
      manager.start(
        new FakeSettings({}) as unknown as ISettingRegistry.ISettings
      );
      await flush();
      expect(passes).not.toHaveBeenCalled();
      expect(manager.tools.size).toBe(0);
      expect(manager.error).toBeNull();
    });

    it('waits for the next macrotask to sync', async () => {
      const { manager, context, settings } = setup();
      manager.start(settings as unknown as ISettingRegistry.ISettings);
      await Promise.resolve();
      expect(context.registered).toEqual([]);
      await flush();
      expect(context.registered.sort()).toEqual(BUILTINS);
    });
  });

  describe('default tools', () => {
    it('registers a default tool only while its command exists', async () => {
      const { commands, has, manager, start } = setup();
      await start();
      expect(has('read_file')).toBe(false);

      const command = addCommand(commands, `${AI}get-file-info`);
      // Debounced: nothing happens before the next macrotask.
      expect(has('read_file')).toBe(false);
      await flush();
      expect(has('read_file')).toBe(true);
      expect(manager.tools.get('read_file')).toBe(`${AI}get-file-info`);

      command.dispose();
      await flush();
      expect(has('read_file')).toBe(false);
      expect(manager.tools.has('read_file')).toBe(false);
    });

    it('builds the default tools from their spec', async () => {
      const { commands, context, start } = setup();
      addCommand(commands, `${AI}get-file-info`, {
        describedBy: {
          args: {
            type: 'object',
            properties: {
              filePath: { type: 'string' },
              background: { type: 'boolean' },
              createWidget: { type: 'boolean' },
              isPalette: { type: 'boolean' }
            }
          }
        }
      });
      await start();
      const tool = context.tools.get('read_file')!;
      const spec = DEFAULT_TOOLS.find(item => item.name === 'read_file')!;
      expect(tool.description).toBe(spec.description);
      expect(tool.annotations).toEqual(spec.annotations);
      expect(tool.inputSchema).toEqual({
        type: 'object',
        properties: { filePath: { type: 'string' } },
        required: ['filePath'],
        additionalProperties: false
      });
    });

    it('opens documents with docmanager:open and only its inputs', async () => {
      const { call, commands, manager, start } = setup();
      addCommand(commands, 'docmanager:open', {
        describedBy: {
          args: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              factory: { type: 'string' },
              kernel: { type: 'object' },
              options: { type: 'object' }
            }
          }
        }
      });
      await start();
      expect(manager.tools.get('open_document')).toBe('docmanager:open');
      expect(await call('open_document', { path: 'a.ipynb' })).toEqual({
        success: true,
        id: 'docmanager:open',
        args: { path: 'a.ipynb' }
      });
      expect(
        await call('open_document', { path: 'a.ipynb', kernel: {} })
      ).toEqual({
        success: false,
        isError: true,
        error:
          'Unknown argument "kernel". Accepted arguments: "path", "factory", "options".'
      });
    });

    it('registers every default tool when its command exists', async () => {
      const { commands, manager, registry, start } = setup();
      for (const spec of DEFAULT_TOOLS) {
        addCommand(commands, spec.command);
      }
      await start();
      const names = DEFAULT_TOOLS.map(spec => spec.name!);
      expect(registry.toolNames).toEqual([...BUILTINS, ...names].sort());
      expect(manager.tools.get('interrupt_kernel')).toBe(
        CommandIDs.interruptKernel
      );
      expect(manager.tools.get('restart_kernel')).toBe(
        CommandIDs.restartKernel
      );
    });

    it('ignores label and state changes of commands', async () => {
      const { commands, start, passes } = setup();
      addCommand(commands, 'a:x');
      await start();
      expect(passes()).toBe(1);
      commands.notifyCommandChanged('a:x');
      commands.notifyCommandChanged();
      await flush();
      expect(passes()).toBe(1);
    });
  });

  describe('user tools', () => {
    it('adds the configured tools', async () => {
      const { commands, manager, start } = setup({
        tools: [
          { command: 'notebook:run-cell', name: 'run_it' },
          { command: 'docmanager:open' }
        ]
      });
      addCommand(commands, 'notebook:run-cell');
      addCommand(commands, 'docmanager:open');
      await start();
      expect(manager.tools.get('run_it')).toBe('notebook:run-cell');
      expect(manager.tools.get('docmanager_open')).toBe('docmanager:open');
      expect(manager.warnings).toEqual([]);
    });

    it('registers a configured tool once its command exists', async () => {
      const { commands, manager, start } = setup({
        tools: [{ command: 'later:command' }]
      });
      await start();
      expect(manager.tools.has('later_command')).toBe(false);
      addCommand(commands, 'later:command');
      await flush();
      expect(manager.tools.get('later_command')).toBe('later:command');
    });

    it('expands glob specs', async () => {
      const { commands, context, manager, start } = setup({
        tools: [{ command: 'notebook:*', annotations: { readOnlyHint: true } }]
      });
      addCommand(commands, 'notebook:a');
      addCommand(commands, 'notebook:b-c');
      addCommand(commands, 'console:x');
      await start();
      expect(manager.tools.get('notebook_a')).toBe('notebook:a');
      expect(manager.tools.get('notebook_b_c')).toBe('notebook:b-c');
      expect(manager.tools.has('console_x')).toBe(false);
      expect(context.tools.get('notebook_a')!.annotations).toEqual({
        readOnlyHint: true
      });

      addCommand(commands, 'notebook:new');
      await flush();
      expect(manager.tools.get('notebook_new')).toBe('notebook:new');
    });

    it('lets a user spec replace a default tool by name', async () => {
      const { commands, context, manager, start } = setup({
        tools: [
          { command: 'my:read', name: 'read_file', description: 'My reader.' }
        ]
      });
      addCommand(commands, `${AI}get-file-info`);
      addCommand(commands, 'my:read');
      await start();
      expect(manager.tools.get('read_file')).toBe('my:read');
      expect(context.tools.get('read_file')!.description).toBe('My reader.');
      expect(manager.warnings).toEqual([]);
    });

    it('removes a default tool when its replacement has no command', async () => {
      const { commands, manager, start } = setup({
        tools: [{ command: 'missing:command', name: 'read_file' }]
      });
      addCommand(commands, `${AI}get-file-info`);
      await start();
      expect(manager.tools.has('read_file')).toBe(false);
    });

    it('skips invalid specs with a warning', async () => {
      const { commands, manager, start } = setup({
        tools: [
          { command: '' },
          'not a spec',
          { command: 'a:*', name: 'all_a' },
          { command: 'a:b', name: 'bad name' },
          { command: 'a:b', name: 'good' }
        ]
      });
      addCommand(commands, 'a:b');
      await start();
      expect(manager.tools.get('good')).toBe('a:b');
      expect(manager.warnings).toEqual([
        'tools[0] is ignored: "command" must be a non-empty string.',
        'tools[1] is ignored: a tool must be an object.',
        'tools[2] is ignored: a glob pattern only accepts "annotations", not "name".',
        'tools[3] is ignored: "name" must have 1 to 64 letters, digits, "_" or "-".'
      ]);
      expect(warn).toHaveBeenCalledTimes(4);
      expect(warn).toHaveBeenCalledWith(
        '[jupyter-webmcp] tools[0] is ignored: "command" must be a non-empty string.'
      );

      // The same warnings are not logged again.
      addCommand(commands, 'a:c');
      await flush();
      expect(manager.warnings).toHaveLength(4);
      expect(warn).toHaveBeenCalledTimes(4);
    });
  });

  describe('name collisions', () => {
    it('keeps the first tool and warns for exact specs', async () => {
      const { commands, manager, start } = setup({
        tools: [
          { command: 'a:x', name: 'x' },
          { command: 'b:x', name: 'x' }
        ]
      });
      addCommand(commands, 'a:x');
      addCommand(commands, 'b:x');
      await start();
      expect(manager.tools.get('x')).toBe('a:x');
      expect(manager.warnings).toEqual([
        'The tool "x" for "b:x" is ignored: another tool has this name.'
      ]);
    });

    it('keeps the first command of a glob without warning', async () => {
      const { commands, manager, start } = setup({
        tools: [{ command: 'a*' }]
      });
      addCommand(commands, 'a_b');
      addCommand(commands, 'a:b');
      await start();
      // The ids are sorted: "a:b" comes before "a_b".
      expect(manager.tools.get('a_b')).toBe('a:b');
      expect(manager.warnings).toEqual([]);
    });

    it('reserves the built-in names, also of disabled built-in tools', async () => {
      const { commands, has, manager, start } = setup({
        disabledTools: ['get_context'],
        tools: [
          { command: 'my:context', name: 'get_context' },
          { command: 'list:all-commands' },
          { command: 'execute:*' }
        ]
      });
      addCommand(commands, 'my:context');
      addCommand(commands, 'list:all-commands');
      addCommand(commands, 'execute:command');
      await start();
      expect(has('get_context')).toBe(false);
      expect(manager.tools.get('list_all_commands')).toBeNull();
      expect(manager.tools.get('execute_command')).toBeNull();
      expect(manager.warnings).toEqual([
        'The tool "get_context" for "my:context" is ignored: another tool has this name.',
        'The tool "list_all_commands" for "list:all-commands" is ignored: another tool has this name.'
      ]);
    });

    it('reports a name taken by another extension and retries it', async () => {
      const { commands, manager, registry, start } = setup();
      addCommand(commands, `${AI}get-file-info`);
      const other = await registry.registerTool({
        name: 'read_file',
        description: 'Another extension.',
        execute: () => null
      });
      await start();
      expect(manager.tools.has('read_file')).toBe(false);
      expect(manager.warnings).toEqual([
        'The tool "read_file" could not be registered: A WebMCP tool named "read_file" is already registered.'
      ]);

      // Only the registry changes: no command or setting.
      other.dispose();
      await flush();
      expect(manager.tools.get('read_file')).toBe(`${AI}get-file-info`);
      expect(manager.warnings).toEqual([]);
    });

    it('does not sync for the tools of other extensions without a failure', async () => {
      const { registry, start, passes } = setup({ tools: [{ command: '' }] });
      await start();
      expect(passes()).toBe(1);
      const other = await registry.registerTool({
        name: 'other_tool',
        description: 'Another extension.',
        execute: () => null
      });
      other.dispose();
      await flush();
      expect(passes()).toBe(1);
    });
  });

  describe('disabledTools', () => {
    it('does not register the disabled tools', async () => {
      const { commands, registry, start } = setup({
        disabledTools: ['list_*', 'execute_command', 'read_?ile']
      });
      for (const spec of DEFAULT_TOOLS) {
        addCommand(commands, spec.command);
      }
      await start();
      const names = registry.toolNames;
      expect(names).not.toContain('list_all_commands');
      expect(names).not.toContain('execute_command');
      expect(names).not.toContain('list_directory');
      expect(names).not.toContain('read_file');
      expect(names).toContain('read_notebook');
      expect(names).toContain('get_context');
    });

    it('applies to configured tools and globs', async () => {
      const { commands, manager, start } = setup({
        tools: [{ command: 'a:*' }, { command: 'b:x', name: 'bx' }],
        disabledTools: ['a_y', 'bx']
      });
      addCommand(commands, 'a:x');
      addCommand(commands, 'a:y');
      addCommand(commands, 'b:x');
      await start();
      expect(manager.tools.has('a_x')).toBe(true);
      expect(manager.tools.has('a_y')).toBe(false);
      expect(manager.tools.has('bx')).toBe(false);
      expect(manager.warnings).toEqual([]);
    });

    it('still lets execute_command run the command of a disabled tool', async () => {
      const { commands, call, start } = setup({ disabledTools: ['read_file'] });
      addCommand(commands, `${AI}get-file-info`);
      await start();
      expect(
        await call('execute_command', {
          command_id: `${AI}get-file-info`,
          args: { filePath: 'a.txt' }
        })
      ).toMatchObject({ success: true, args: { filePath: 'a.txt' } });
    });
  });

  describe('blockedCommands', () => {
    it('gives no tool to blocked commands', async () => {
      const { commands, manager, start } = setup({
        blockedCommands: [`${AI}get-*`, 'secret:*'],
        tools: [{ command: 'secret:x', name: 'sx' }, { command: 'secret:*' }]
      });
      addCommand(commands, `${AI}get-file-info`);
      addCommand(commands, `${AI}get-notebook-content`);
      addCommand(commands, `${AI}list-directory`);
      addCommand(commands, 'secret:x');
      await start();
      expect(manager.tools.has('read_file')).toBe(false);
      expect(manager.tools.has('read_notebook')).toBe(false);
      expect(manager.tools.has('sx')).toBe(false);
      expect(manager.tools.has('secret_x')).toBe(false);
      expect(manager.tools.get('list_directory')).toBe(`${AI}list-directory`);
      expect(manager.isBlocked('secret:x')).toBe(true);
      expect(manager.isBlocked(`${AI}list-directory`)).toBe(false);
    });

    it('hides blocked commands from list_all_commands and refuses them', async () => {
      const { commands, call, start } = setup({
        blockedCommands: ['secret:*']
      });
      const execute = jest.fn();
      commands.addCommand('secret:x', { execute });
      addCommand(commands, 'public:x');
      await start();
      const result = await call('list_all_commands', { query: ':x' });
      expect(
        (result.commands as JSONObject[]).map(command => command.id)
      ).toEqual(['public:x']);
      expect(await call('execute_command', { command_id: 'secret:x' })).toEqual(
        {
          success: false,
          isError: true,
          error:
            'The command "secret:x" is blocked by the WebMCP settings (blockedCommands).'
        }
      );
      expect(execute).not.toHaveBeenCalled();
    });

    it('follows changes of the blocked commands', async () => {
      const { commands, manager, settings, start } = setup({
        blockedCommands: [`${AI}*`]
      });
      addCommand(commands, `${AI}get-file-info`);
      await start();
      expect(manager.tools.has('read_file')).toBe(false);
      settings.update({ blockedCommands: [] });
      await flush();
      expect(manager.tools.has('read_file')).toBe(true);
      settings.update({ blockedCommands: [`${AI}get-file-info`] });
      await flush();
      expect(manager.tools.has('read_file')).toBe(false);
    });
  });

  describe('setting defaults', () => {
    it('keeps the guardrails of the defaults after a change of the user settings', async () => {
      const { call, commands, has, manager, settings, start } = setup(
        { blockedCommands: ['user:*'] },
        {
          blockedCommands: ['admin:*'],
          disabledTools: ['list_all_commands']
        }
      );
      const execute = jest.fn();
      commands.addCommand('admin:x', { execute });
      await start();
      expect(manager.isBlocked('admin:x')).toBe(true);
      expect(manager.isBlocked('user:x')).toBe(true);
      expect(manager.isBlocked('other:x')).toBe(false);
      settings.update({ blockedCommands: [], disabledTools: [] });
      await flush();
      expect(manager.isBlocked('admin:x')).toBe(true);
      expect(has('list_all_commands')).toBe(false);
      expect(await call('execute_command', { command_id: 'admin:x' })).toEqual({
        success: false,
        isError: true,
        error:
          'The command "admin:x" is blocked by the WebMCP settings (blockedCommands).'
      });
      expect(execute).not.toHaveBeenCalled();
    });

    it('ignores the defaults that are not lists of strings', async () => {
      const { has, manager, start } = setup(
        { blockedCommands: ['user:*'] },
        {
          blockedCommands: ['admin:*', 3, null],
          disabledTools: 'get_context'
        }
      );
      await start();
      expect(manager.isBlocked('admin:x')).toBe(true);
      expect(manager.isBlocked('user:x')).toBe(true);
      expect(has('get_context')).toBe(true);
      expect(error).not.toHaveBeenCalled();
    });

    it('ignores defaults that cannot be read', async () => {
      const { manager, settings, start } = setup({
        blockedCommands: ['user:*']
      });
      settings.default = () => {
        throw new Error('No schema');
      };
      await start();
      expect(manager.isBlocked('user:x')).toBe(true);
      expect(manager.error).toBeNull();
    });

    it('does not merge the configured tools', async () => {
      const { commands, manager, start } = setup(
        { tools: [] },
        { tools: [{ command: 'admin:x', name: 'admin_x' }] }
      );
      addCommand(commands, 'admin:x');
      await start();
      expect(manager.tools.has('admin_x')).toBe(false);
    });
  });

  describe('settings changes', () => {
    it('registers again only the tools that changed', async () => {
      const tools = [
        { command: 'a:x', name: 'ax', description: 'First.' },
        { command: 'b:y', name: 'by' }
      ];
      const { commands, context, has, registry, settings, start } = setup({
        tools
      });
      addCommand(commands, 'a:x');
      addCommand(commands, 'b:y');
      await start();
      expect(context.registered.sort()).toEqual(
        [...BUILTINS, 'ax', 'by'].sort()
      );

      context.registered = [];
      const changed = [{ ...tools[0], description: 'Second.' }, tools[1]];
      settings.update({ tools: changed });
      await flush();
      expect(context.registered).toEqual(['ax']);
      expect(context.tools.get('ax')!.description).toBe('Second.');

      context.registered = [];
      settings.update({
        tools: changed,
        maxResultLength: 5000,
        executionTimeout: 5,
        blockedCommands: ['unrelated:*']
      });
      await flush();
      expect(context.registered).toEqual([]);

      settings.update({ tools: changed, disabledTools: ['by'] });
      await flush();
      expect(context.registered).toEqual([]);
      expect(has('by')).toBe(false);
      expect(context.tools.has('by')).toBe(false);

      settings.update({ tools: changed });
      await flush();
      expect(context.registered).toEqual(['by']);
      expect(registry.toolNames).toEqual([...BUILTINS, 'ax', 'by'].sort());
    });

    it('uses the execution timeout from the settings', async () => {
      const { commands, call, start } = setup({ executionTimeout: 0.02 });
      commands.addCommand('slow:x', {
        execute: () => new Promise(() => undefined)
      });
      await start();
      expect(
        await call('execute_command', { command_id: 'slow:x' })
      ).toMatchObject({ status: 'pending', tool: 'execute_command' });
    });

    it('uses the maximum result length from the settings', async () => {
      const { commands, call, settings, start } = setup({
        maxResultLength: 1000
      });
      commands.addCommand('big:x', { execute: () => 'x'.repeat(5000) });
      await start();
      let result = await call('execute_command', { command_id: 'big:x' });
      expect(result.truncated).toBe(true);
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(1000);

      settings.update({ maxResultLength: 10000 });
      result = await call('execute_command', { command_id: 'big:x' });
      expect(result).toEqual({ success: true, result: 'x'.repeat(5000) });
    });

    it('reports the dedicated tool of a command in list_all_commands', async () => {
      const { commands, call, start } = setup();
      addCommand(commands, `${AI}get-file-info`);
      addCommand(commands, 'other:x');
      await start();
      const entries = (await call('list_all_commands', {}))
        .commands as JSONObject[];
      expect(entries.find(entry => entry.id === `${AI}get-file-info`)).toEqual(
        expect.objectContaining({ tool: 'read_file' })
      );
      expect(entries.find(entry => entry.id === 'other:x')).not.toHaveProperty(
        'tool'
      );
    });
  });

  describe('invalid settings', () => {
    it('ignores invalid values', async () => {
      const { commands, has, manager, registry, start } = setup({
        tools: { command: 'a:x' },
        disabledTools: [null, 'get_context', 3],
        blockedCommands: 42
      });
      addCommand(commands, 'a:x');
      await start();
      expect(has('get_context')).toBe(false);
      expect(registry.toolNames).toEqual(
        BUILTINS.filter(name => name !== 'get_context')
      );
      expect(manager.isBlocked('a:x')).toBe(false);
      expect(manager.warnings).toEqual([]);
      expect(error).not.toHaveBeenCalled();
    });

    /**
     * Check that a call of a command that never settles is reported as
     * pending after `seconds`.
     */
    async function expectPendingAfter(
      executionTimeout: unknown,
      seconds: number
    ): Promise<void> {
      const { commands, call, start } = setup({ executionTimeout });
      commands.addCommand('slow:x', {
        execute: () => new Promise(() => undefined)
      });
      await start();
      jest.useFakeTimers();
      let result: JSONObject | null = null;
      void call('execute_command', { command_id: 'slow:x' }).then(
        value => (result = value)
      );
      await jest.advanceTimersByTimeAsync((seconds - 1) * 1000);
      expect(result).toBeNull();
      await jest.advanceTimersByTimeAsync(1000);
      expect(result).toMatchObject({ status: 'pending' });
      jest.useRealTimers();
    }

    it('uses the default execution timeout for an invalid value', async () => {
      await expectPendingAfter(-1, 20);
      await expectPendingAfter('soon', 20);
    });

    it('caps the execution timeout to one hour', async () => {
      await expectPendingAfter(100000, 3600);
    });

    it('uses a result length of at least 1000', async () => {
      const { commands, call, start } = setup({ maxResultLength: 10 });
      commands.addCommand('big:x', { execute: () => 'x'.repeat(5000) });
      await start();
      const result = await call('execute_command', { command_id: 'big:x' });
      const length = JSON.stringify(result).length;
      expect(result.truncated).toBe(true);
      expect(length).toBeGreaterThan(500);
      expect(length).toBeLessThanOrEqual(1000);
    });

    it('uses the default result length for an invalid value', async () => {
      const { commands, call, start } = setup({ maxResultLength: 'big' });
      commands.addCommand('big:x', { execute: () => 'x'.repeat(30000) });
      await start();
      expect(await call('execute_command', { command_id: 'big:x' })).toEqual({
        success: true,
        result: 'x'.repeat(30000)
      });
    });
  });

  describe('#fail()', () => {
    it('unregisters every tool and ignores later syncs', async () => {
      const { commands, context, manager, passes, registry, settings, start } =
        setup();
      addCommand(commands, `${AI}get-file-info`);
      await start();
      expect(registry.toolNames.length).toBeGreaterThan(0);

      manager.fail(new Error('Invalid settings'));
      expect(manager.error).toBe('Invalid settings');
      expect(registry.toolNames).toEqual([]);
      expect(context.tools.size).toBe(0);
      expect(manager.tools.size).toBe(0);

      const before = passes();
      addCommand(commands, 'other:x');
      settings.update({ tools: [{ command: 'other:x' }] });
      manager.sync();
      await flush();
      expect(passes()).toBe(before);
      expect(registry.toolNames).toEqual([]);
    });

    it('reports the validation errors of the settings', async () => {
      const { manager } = setup();
      // An administrator override out of the schema bounds.
      const schema = {
        type: 'object',
        properties: {
          executionTimeout: { type: 'number', default: 7200, maximum: 3600 }
        }
      };
      const settingRegistry = new SettingRegistry({
        connector: {
          fetch: async (id: string) => ({ id, raw: '{}', schema, version: '' })
        } as any
      });
      const reason = await settingRegistry.load('test:plugin').catch(r => r);
      manager.fail(reason);
      expect(manager.error).toBe('/executionTimeout must be <= 3600');
    });

    it('prevents the first sync when called before start', async () => {
      const { context, manager, start } = setup();
      manager.fail('No settings');
      expect(manager.error).toBe('No settings');
      await start();
      expect(context.registered).toEqual([]);
    });

    it('stops a sync in progress', async () => {
      const { context, manager, registry, start } = setup();
      const gate = new PromiseDelegate<void>();
      context.gate = gate.promise;
      void start();
      await waitFor(() => context.registered.length === 1);
      manager.fail('Invalid settings');
      gate.resolve();
      await flush();
      expect(context.registered).toHaveLength(1);
      expect(registry.toolNames).toEqual([]);
      expect(context.tools.size).toBe(0);
      expect(manager.tools.size).toBe(0);
    });
  });

  describe('#dispose()', () => {
    it('unregisters the tools and stops syncing', async () => {
      const { commands, context, manager, registry, settings, start } = setup();
      await start();
      expect(registry.toolNames).toEqual(BUILTINS);
      manager.dispose();
      expect(manager.isDisposed).toBe(true);
      expect(registry.toolNames).toEqual([]);
      expect(context.tools.size).toBe(0);

      context.registered = [];
      addCommand(commands, `${AI}get-file-info`);
      settings.update({ blockedCommands: ['a:*'] });
      manager.sync();
      await flush();
      expect(context.registered).toEqual([]);
      expect(manager.isBlocked('a:x')).toBe(false);
      expect(() => manager.dispose()).not.toThrow();
    });

    it('stops a sync in progress', async () => {
      const { context, manager, registry, start } = setup();
      const gate = new PromiseDelegate<void>();
      context.gate = gate.promise;
      void start();
      await waitFor(() => context.registered.length === 1);
      manager.dispose();
      gate.resolve();
      await flush();
      expect(context.registered).toHaveLength(1);
      expect(registry.toolNames).toEqual([]);
      expect(context.tools.size).toBe(0);
    });
  });

  describe('#sync()', () => {
    it('never runs two synchronizations at once', async () => {
      const { commands, context, manager, settings, start } = setup({
        tools: [{ command: 'a:*' }]
      });
      context.delay = 2;
      addCommand(commands, 'a:one');
      void start();
      await waitFor(() => context.registered.length === 2);
      addCommand(commands, 'a:two');
      settings.update({ tools: [{ command: 'a:*' }], maxResultLength: 2000 });
      manager.sync();
      manager.sync();
      await waitFor(() => manager.tools.has('a_two'));
      await flush();
      expect(context.maxActive).toBe(1);
      expect(Array.from(manager.tools.keys()).sort()).toEqual(
        [...BUILTINS, 'a_one', 'a_two'].sort()
      );
      expect(context.registered.filter(name => name === 'a_one')).toHaveLength(
        1
      );
    });

    it('batches the requests made in the same task', async () => {
      const { manager, start, passes } = setup();
      await start();
      for (let i = 0; i < 10; i++) {
        manager.sync();
      }
      await flush();
      expect(passes()).toBe(2);
    });

    it('runs one more pass for the requests made during a pass', async () => {
      const { context, manager, passes, start } = setup();
      const gate = new PromiseDelegate<void>();
      context.gate = gate.promise;
      void start();
      await waitFor(() => context.registered.length === 1);
      for (let i = 0; i < 5; i++) {
        manager.sync();
      }
      gate.resolve();
      await waitFor(() => passes() === 2);
      await flush();
      expect(passes()).toBe(2);
      expect(context.maxActive).toBe(1);
    });

    it('logs the errors of a sync and keeps the tools', async () => {
      const { commands, has, manager, registry, settings, start } = setup();
      await start();
      jest.spyOn(commands, 'listCommands').mockImplementationOnce(() => {
        throw new TypeError('Broken registry');
      });
      settings.update({ disabledTools: ['list_all_commands'] });
      await flush();
      expect(error).toHaveBeenCalledWith(
        '[jupyter-webmcp] Failed to sync the tools:',
        expect.any(TypeError)
      );
      expect(registry.toolNames).toEqual(BUILTINS);

      // Later syncs still run.
      settings.update({ disabledTools: ['get_context'] });
      await flush();
      expect(has('get_context')).toBe(false);
      expect(manager.error).toBeNull();
    });
  });
});
