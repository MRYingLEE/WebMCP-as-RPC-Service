import { ILabShell, JupyterFrontEnd } from '@jupyterlab/application';
import { IDefaultFileBrowser } from '@jupyterlab/filebrowser';
import { TranslationBundle } from '@jupyterlab/translation';
import { JSONObject, JSONValue, ReadonlyJSONObject } from '@lumino/coreutils';
import { Widget } from '@lumino/widgets';
import { Dialogs } from './dialogs';
import { CommandExecutor } from './execution';
import { IModelContextTool, IToolExecuteOptions } from './modelcontext';
import { boundResult, describeWidget } from './results';
import {
  ICommandToolSpec,
  checkInput,
  guessAnnotations,
  inputSchema
} from './specs';
import { errorMessage, parseArgs, safely, withTimeout } from './utils';

/**
 * Builders for the WebMCP tools.
 */
export namespace Tools {
  /**
   * What the tools need from the extension.
   */
  export interface IOptions {
    /**
     * The application.
     */
    app: JupyterFrontEnd;
    /**
     * Runs the commands.
     */
    executor: CommandExecutor;
    /**
     * Whether agents are forbidden to run a command.
     */
    isBlocked: (commandId: string) => boolean;
    /**
     * The tool exposing a command, if any.
     */
    toolFor: (commandId: string) => string | undefined;
    /**
     * Maximum length of a tool result, in JSON characters.
     */
    maxResultLength: () => number;
    /**
     * The default file browser, if any.
     */
    fileBrowser: IDefaultFileBrowser | null;
    /**
     * The JupyterLab shell; `null` in apps that show one document per page.
     */
    labShell: ILabShell | null;
    /**
     * The translation bundle, for the tool titles.
     */
    trans: TranslationBundle;
  }

  const GET_CONTEXT = 'get_context';
  const LIST_ALL_COMMANDS = 'list_all_commands';
  const EXECUTE_COMMAND = 'execute_command';
  const ANSWER_DIALOG = 'answer_dialog';
  const WAIT_FOR_RESULT = 'wait_for_result';

  /**
   * Names of the built-in tools.
   */
  export const BUILTIN_NAMES: readonly string[] = [
    GET_CONTEXT,
    LIST_ALL_COMMANDS,
    EXECUTE_COMMAND,
    ANSWER_DIALOG,
    WAIT_FOR_RESULT
  ];

  /**
   * Default number of commands returned by `list_all_commands`.
   */
  export const DEFAULT_LIST_LIMIT = 50;

  /**
   * Build the built-in tools.
   */
  export function builtinTools(options: IOptions): IModelContextTool[] {
    return [
      getContext(options),
      listAllCommands(options),
      executeCommand(options),
      answerDialog(options),
      waitForResult(options)
    ];
  }

  /**
   * The `get_context` tool.
   */
  export function getContext(options: IOptions): IModelContextTool {
    const { app, executor, fileBrowser, labShell, trans } = options;
    return {
      name: GET_CONTEXT,
      title: trans.__('Get the Jupyter context'),
      description:
        'Call this first. Describes this Jupyter page: the open documents (widget id, path, unsaved changes, kernel id and status, active notebook cell), the cursor and selection of the current editor, the running kernels, the file browser directory, the open dialogs and the pending tool calls. In JupyterLite, the kernels are those of this browser tab.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: wrap(options, async () => {
        const { kernels } = app.serviceManager;
        // The kernel list is polled; refresh it for current states.
        await withTimeout(
          kernels.refreshRunning().catch(() => undefined),
          Private.REFRESH_TIMEOUT,
          undefined
        );
        const current = app.shell.currentWidget;
        const widgets = Array.from(app.shell.widgets('main')).map(
          describeWidget
        );
        // Documents report the live status of their kernel.
        const live = new Map<string, JSONValue>();
        for (const widget of widgets) {
          const kernel = widget.kernel as JSONObject | undefined;
          if (kernel) {
            live.set(String(kernel.id), kernel.status);
          }
        }
        const result: JSONObject = {
          success: true,
          app: { name: app.name, version: app.version },
          fileBrowserPath: fileBrowser?.model.path ?? null,
          currentWidgetId: current?.id || null,
          currentEditor: Private.editorState(current),
          widgets,
          kernels: Array.from(kernels.running()).map(kernel => ({
            id: kernel.id,
            name: kernel.name,
            status: live.get(kernel.id) ?? kernel.execution_state ?? 'unknown'
          })),
          dialogs: Private.describeDialogs(),
          pending: executor.pendingCalls()
        };
        if (!labShell) {
          result.note =
            'This page shows one document. Other documents open in their own browser tab, with their own tools.';
        }
        return result;
      })
    };
  }

  /**
   * The `list_all_commands` tool.
   */
  export function listAllCommands(options: IOptions): IModelContextTool {
    const { commands } = options.app;
    return {
      name: LIST_ALL_COMMANDS,
      title: options.trans.__('List Jupyter commands'),
      description: `Find Jupyter commands, for tasks that no other tool covers. Every word of "query" must appear in the command id, label, caption or usage. In each result, "args" is the JSON schema of the arguments (not values) and "tool" is the dedicated tool to use instead, if any. Run commands with ${EXECUTE_COMMAND}.`,
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Words to search for, for example "notebook run" or "theme".'
          },
          limit: {
            type: 'integer',
            description: `Maximum number of commands to return (default ${DEFAULT_LIST_LIMIT}).`,
            minimum: 1
          }
        }
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: wrap(options, async input => {
        const words = String(input.query ?? '')
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean);
        const limit = Math.max(1, Number(input.limit) || DEFAULT_LIST_LIMIT);
        const matches: Private.ICommandText[] = [];
        for (const id of commands.listCommands().sort()) {
          if (options.isBlocked(id)) {
            continue;
          }
          const command: Private.ICommandText = {
            id,
            label: safely(() => commands.label(id), ''),
            caption: safely(() => commands.caption(id), ''),
            usage: safely(() => commands.usage(id), '')
          };
          const text = Object.values(command).join(' ').toLowerCase();
          if (words.every(word => text.includes(word))) {
            matches.push(command);
          }
        }
        const entries = await Promise.all(
          matches.slice(0, limit).map(async ({ id, label, caption, usage }) => {
            const entry: JSONObject = { id, label };
            if (caption && caption !== label) {
              entry.caption = caption;
            }
            if (usage && usage !== caption) {
              entry.description = usage;
            }
            const described = await argsSchema(options, id);
            if (described) {
              const args = inputSchema(described, {});
              // execute_command accepts other arguments, such as
              // semanticWidget.
              delete args.additionalProperties;
              if (Object.keys(args.properties as JSONObject).length > 0) {
                entry.args = args;
              }
            }
            entry.enabled = safely(() => commands.isEnabled(id), true);
            if (safely(() => commands.isToggleable(id), false)) {
              entry.toggled = safely(() => commands.isToggled(id), false);
            }
            const tool = options.toolFor(id);
            if (tool) {
              entry.tool = tool;
            }
            return entry;
          })
        );
        return {
          success: true,
          commandCount: matches.length,
          commands: entries
        };
      })
    };
  }

  /**
   * The `execute_command` tool.
   */
  export function executeCommand(options: IOptions): IModelContextTool {
    return {
      name: EXECUTE_COMMAND,
      title: options.trans.__('Execute a Jupyter command'),
      description: `Run any Jupyter command by id (find ids and argument schemas with ${LIST_ALL_COMMANDS}), for example {"command_id": "apputils:change-theme", "args": {"theme": "JupyterLab Dark"}}. Most commands act on the active document. To target an open notebook or console that is not active, add "semanticWidget": "<widget id from ${GET_CONTEXT}>" and "activate": false to the args of notebook:* and console:* commands.`,
      inputSchema: {
        type: 'object',
        properties: {
          command_id: {
            type: 'string',
            description: 'The command id, for example "notebook:run-all-cells".'
          },
          args: {
            type: 'object',
            description: 'Arguments for the command.',
            additionalProperties: true
          }
        },
        required: ['command_id']
      },
      annotations: { consequentialHint: true, untrustedContentHint: true },
      execute: wrap(options, (input, signal) => {
        const parsed = parseArgs(input.args);
        if ('error' in parsed) {
          return { success: false, error: parsed.error };
        }
        return options.executor.execute(
          String(input.command_id ?? ''),
          parsed.args,
          { tool: EXECUTE_COMMAND, signal }
        );
      })
    };
  }

  /**
   * The `answer_dialog` tool.
   */
  export function answerDialog(options: IOptions): IModelContextTool {
    return {
      name: ANSWER_DIALOG,
      title: options.trans.__('Answer a Jupyter dialog'),
      description: `Click a button of the dialog that is shown, for example to confirm a kernel restart reported by a pending result. Input fields keep their current value. Pass dialogId when several dialogs are open (shown or queued); queued dialogs cannot be answered. If the dialog opened during a tool call whose result you did not get yet, returns the result of that call (or a pending status).`,
      inputSchema: {
        type: 'object',
        properties: {
          button: {
            type: ['string', 'integer'],
            description:
              'The button label (case-insensitive), or its 0-based index.'
          },
          dialogId: {
            type: 'string',
            description: `The dialog id, only needed when several dialogs are open (see ${GET_CONTEXT}).`
          }
        },
        required: ['button']
      },
      annotations: { consequentialHint: true, untrustedContentHint: true },
      execute: wrap(options, (input, signal) => {
        const { button, dialogId } = input;
        if (typeof button !== 'string' && typeof button !== 'number') {
          return { success: false, error: '"button" is required.' };
        }
        return options.executor.answer(
          button,
          typeof dialogId === 'string' && dialogId ? dialogId : undefined,
          signal
        );
      })
    };
  }

  /**
   * The `wait_for_result` tool.
   */
  export function waitForResult(options: IOptions): IModelContextTool {
    return {
      name: WAIT_FOR_RESULT,
      title: options.trans.__('Wait for a pending tool call'),
      description:
        'Wait for a tool call that returned status "pending" and return its final result. If the call is still running when the wait ends, returns status "pending" again.',
      inputSchema: {
        type: 'object',
        properties: {
          pendingId: {
            type: 'string',
            description: 'The pendingId of the pending result.'
          },
          timeout: {
            type: 'number',
            description:
              'Maximum seconds to wait, capped to the execution timeout setting.'
          }
        },
        required: ['pendingId']
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: wrap(options, (input, signal) => {
        if (typeof input.pendingId !== 'string' || !input.pendingId) {
          return { success: false, error: '"pendingId" is required.' };
        }
        return options.executor.wait(
          input.pendingId,
          (Number(input.timeout) || 0) * 1000,
          signal
        );
      })
    };
  }

  /**
   * Build the tool exposing a command.
   */
  export async function commandTool(
    options: IOptions,
    spec: ICommandToolSpec,
    commandId: string,
    name: string
  ): Promise<IModelContextTool> {
    const { commands } = options.app;
    const schema = inputSchema(await argsSchema(options, commandId), spec);
    const label = safely(() => commands.label(commandId), '');
    const caption = safely(() => commands.caption(commandId), '');
    const summary = (caption || label || commandId).trim().replace(/\.$/, '');
    return {
      name,
      title: label || name,
      description:
        spec.description ||
        `${summary}. Runs the Jupyter command "${commandId}".`,
      inputSchema: schema,
      annotations: spec.annotations ?? guessAnnotations(commandId),
      execute: wrap(options, (input, signal) => {
        const checked = checkInput(input, schema);
        if ('error' in checked) {
          return { success: false, error: checked.error };
        }
        return options.executor.execute(
          commandId,
          { ...checked.args, ...(spec.args ?? {}) },
          { tool: name, signal }
        );
      })
    };
  }

  /**
   * The argument schema declared by a command, if any.
   */
  async function argsSchema(
    options: IOptions,
    commandId: string
  ): Promise<ReadonlyJSONObject | null> {
    try {
      const description = await withTimeout(
        options.app.commands.describedBy(commandId),
        Private.DESCRIBED_BY_TIMEOUT,
        { args: null }
      );
      return description.args ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Wrap a tool implementation: errors become results, open dialogs are
   * reported and the result is bounded.
   */
  function wrap(
    options: IOptions,
    run: (
      input: ReadonlyJSONObject,
      signal: AbortSignal | undefined
    ) => JSONObject | Promise<JSONObject>
  ): IModelContextTool['execute'] {
    return async (input, executeOptions?: IToolExecuteOptions) => {
      let result: JSONObject;
      try {
        result = await run(
          (input ?? {}) as ReadonlyJSONObject,
          executeOptions?.signal
        );
      } catch (error) {
        result = { success: false, error: errorMessage(error) };
      }
      if (!('dialog' in result) && !('dialogs' in result)) {
        const open = Private.describeDialogs();
        if (open.length > 0) {
          result = { ...result, dialogs: open };
        }
      }
      if (result.success === false) {
        // Some MCP clients only report a result with `isError` as an error.
        result = { ...result, isError: true };
      }
      return boundResult(result, options.maxResultLength());
    };
  }
}

/**
 * The namespace for module private data.
 */
namespace Private {
  /**
   * Maximum time to get the argument schema of a command.
   */
  export const DESCRIBED_BY_TIMEOUT = 5000;

  /**
   * Maximum time to refresh the list of running kernels.
   */
  export const REFRESH_TIMEOUT = 2000;

  /**
   * Maximum length of the selected text reported by `get_context`.
   */
  export const SELECTION_LIMIT = 2000;

  /**
   * The texts of a command that `list_all_commands` searches.
   */
  export interface ICommandText {
    id: string;
    label: string;
    caption: string;
    usage: string;
  }

  /**
   * A position in an editor, 0-based.
   */
  interface IPosition {
    line: number;
    column: number;
  }

  /**
   * The part of `CodeEditor.IEditor` used to report the editor state.
   */
  interface IEditor {
    getCursorPosition(): IPosition;
    getSelection(): { start: IPosition; end: IPosition };
    getOffsetAt(position: IPosition): number;
    model: { sharedModel: { getSource(): string } };
  }

  /**
   * The widgets holding an editor: a notebook panel (active cell), a file
   * editor or a console panel (prompt cell).
   */
  interface IEditorHost {
    content?: {
      activeCell?: { editor: IEditor | null; model: { id: string } } | null;
      editor?: IEditor | null;
    };
    console?: { promptCell?: { editor: IEditor | null } | null };
  }

  /**
   * Describe the dialogs of the page, shown or queued.
   */
  export function describeDialogs(): JSONObject[] {
    return Dialogs.all().map(Dialogs.describe);
  }

  /**
   * The cursor and selection of the editor of a widget, with 1-based lines
   * and columns, or `null` when the widget has no code editor.
   */
  export function editorState(widget: Widget | null): JSONObject | null {
    const host = widget as IEditorHost | null;
    const cell = host?.content?.activeCell;
    const editor =
      cell?.editor ??
      host?.content?.editor ??
      host?.console?.promptCell?.editor;
    if (typeof editor?.getCursorPosition !== 'function') {
      return null;
    }
    const position = ({ line, column }: IPosition) => ({
      line: line + 1,
      column: column + 1
    });
    return safely(() => {
      const state: JSONObject = {};
      if (cell?.editor) {
        state.cellId = cell.model.id;
      }
      state.cursor = position(editor.getCursorPosition());
      const { start, end } = editor.getSelection();
      const from = editor.getOffsetAt(start);
      const to = editor.getOffsetAt(end);
      if (from !== to) {
        const text = editor.model.sharedModel
          .getSource()
          .slice(Math.min(from, to), Math.max(from, to));
        state.selection = {
          start: position(start),
          end: position(end),
          text: text.slice(0, SELECTION_LIMIT)
        };
      }
      return state;
    }, null);
  }
}
