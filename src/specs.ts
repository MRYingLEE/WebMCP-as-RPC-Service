import { TranslationBundle } from '@jupyterlab/translation';
import { JSONObject, JSONValue, ReadonlyJSONObject } from '@lumino/coreutils';
import { CommandIDs } from './commands';
import { IToolAnnotations } from './modelcontext';
import { isGlob } from './utils';

/**
 * Maximum length of a tool name. WebMCP allows 128 characters, but MCP
 * clients often cap tool names at 64.
 */
export const MAX_TOOL_NAME_LENGTH = 64;

/**
 * Valid names for configured tools.
 */
export const TOOL_NAME_PATTERN = new RegExp(
  `^[A-Za-z0-9_-]{1,${MAX_TOOL_NAME_LENGTH}}$`
);

/**
 * Convert a command id into a tool name (`notebook:run-cell` becomes
 * `notebook_run_cell`).
 *
 * Only `[A-Za-z0-9_]` is kept: MCP bridges rewrite `.` and some drop `-`.
 */
export function toToolName(commandId: string): string {
  const name = commandId
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return (name || 'command').slice(0, MAX_TOOL_NAME_LENGTH);
}

/**
 * A WebMCP tool backed by a command.
 */
export interface ICommandToolSpec {
  /**
   * The command id, or a glob pattern (`*` and `?`) to expose every
   * matching command with a name derived from its id.
   */
  command: string;
  /**
   * The tool name; derived from the command id when omitted. Not allowed
   * with a glob pattern.
   */
  name?: string;
  /**
   * The description shown to the agent; defaults to the command caption.
   */
  description?: string;
  /**
   * Fixed arguments, hidden from the input schema and always passed to the
   * command.
   */
  args?: JSONObject;
  /**
   * The arguments shown to agents, to hide the others of a command with a
   * large schema; all of them when omitted.
   */
  inputs?: string[];
  /**
   * Arguments the agent must give, in addition to the ones the command
   * declares as required.
   */
  required?: string[];
  /**
   * Hints for the agent; derived from the command id when omitted.
   */
  annotations?: IToolAnnotations;
}

/**
 * Arguments used by the user interface only, never exposed to agents.
 */
export const UI_ARGS = [
  '_luminoEvent',
  'isContextMenu',
  'isLauncher',
  'isPalette',
  'toolbar'
];

/**
 * Prefix of the commands of jupyterlab-ai-commands.
 */
const AI = 'jupyterlab-ai-commands:';

/**
 * The default command-backed tools. Each tool is registered only while its
 * command exists, so the set adapts to the installed extensions.
 */
export const DEFAULT_TOOLS: readonly ICommandToolSpec[] = [
  {
    name: 'open_document',
    command: 'docmanager:open',
    description:
      'Show a file (notebook, text file, image...) to the user: open it in the main area, or bring its tab to the front. Not needed to read or edit files. "factory" picks a viewer (for example "Editor" to see a notebook as JSON) and "options.mode" a layout (for example "split-right"). On a page that shows one document (see get_context), the document opens in a new browser tab with its own tools, and the result has "disposed": true. A pop-up blocker can stop that tab: then ask the user to open the document.',
    inputs: ['path', 'factory', 'options'],
    required: ['path']
  },
  {
    name: 'list_directory',
    command: `${AI}list-directory`,
    description:
      'List the files and folders of a directory. Paths are relative to the root of the file browser; "" is the root.',
    annotations: { readOnlyHint: true, untrustedContentHint: true }
  },
  {
    name: 'read_file',
    command: `${AI}get-file-info`,
    description:
      'Read a text file, including unsaved changes in an open editor. For notebooks, use read_notebook.',
    args: { background: true, createWidget: false },
    required: ['filePath'],
    annotations: { readOnlyHint: true, untrustedContentHint: true }
  },
  {
    name: 'write_file',
    command: `${AI}set-file-content`,
    description:
      'Replace the whole content of an existing text file and save it. Read the file first. Use create_file for a new file, and the notebook tools for notebooks.',
    args: { background: true, save: true, showDiff: false },
    required: ['filePath', 'content'],
    annotations: { consequentialHint: true }
  },
  {
    name: 'create_file',
    command: `${AI}create-file`,
    description:
      'Create a text file with optional content. "fileName" is a name, not a path; "cwd" is the directory (default: the root). Fails if the file exists.',
    args: { background: true },
    required: ['fileName']
  },
  {
    name: 'create_notebook',
    command: `${AI}create-notebook`,
    description:
      'Create the notebook "<name>.ipynb" at the root with a kernel for "language" (the default kernel otherwise) and open it without taking the focus. Returns notebookPath. Fails if the file exists.',
    args: { background: true },
    required: ['name']
  },
  {
    name: 'read_notebook',
    command: `${AI}get-notebook-content`,
    description:
      'Read a notebook as nbformat JSON (cells with their id, type, source and outputs), including unsaved changes. The other notebook tools take the cell ids from here. Cells of notebooks older than nbformat 4.5 have no id in this result.',
    args: { background: true, createWidget: false },
    required: ['notebookPath'],
    annotations: { readOnlyHint: true, untrustedContentHint: true }
  },
  {
    name: 'read_cell',
    command: `${AI}get-cell-info`,
    description:
      'Read one notebook cell: type, source, outputs and execution count.',
    args: { background: true, createWidget: false },
    required: ['notebookPath', 'cellId'],
    annotations: { readOnlyHint: true, untrustedContentHint: true }
  },
  {
    name: 'add_cell',
    command: `${AI}add-cell`,
    description:
      'Insert a cell with optional content next to "referenceCellId" ("position": below by default) and return its cellId. Without referenceCellId the cell goes next to the active cell: to append, pass the id of the last cell. A single empty first cell is replaced. Not saved: call save_notebook.',
    args: { background: true },
    required: ['notebookPath']
  },
  {
    name: 'edit_cell',
    command: `${AI}set-cell-content`,
    description:
      'Replace the whole source of a notebook cell (the cell type does not change). Read the cell first. Not saved: call save_notebook.',
    args: { background: true, diffMode: 'unified', showDiff: false },
    required: ['notebookPath', 'cellId', 'content'],
    annotations: { untrustedContentHint: true }
  },
  {
    name: 'delete_cell',
    command: `${AI}delete-cell`,
    description: 'Delete a notebook cell. Not saved: call save_notebook.',
    args: { background: true },
    required: ['notebookPath', 'cellId'],
    annotations: { consequentialHint: true }
  },
  {
    name: 'run_cell',
    command: `${AI}run-cell`,
    description:
      'Run a code cell in the notebook kernel and return its status and outputs, which the notebook also shows. Errors return success false with the traceback.',
    args: { background: true, recordTiming: true },
    required: ['notebookPath', 'cellId'],
    annotations: { consequentialHint: true, untrustedContentHint: true }
  },
  {
    name: 'save_notebook',
    command: `${AI}save-notebook`,
    description: 'Save a notebook.',
    args: { background: true },
    required: ['notebookPath']
  },
  {
    name: 'run_code',
    command: `${AI}execute-in-kernel`,
    description:
      'Run code in a running kernel and return the outputs, which no notebook shows. Kernel ids come from get_context; the kernel of an open notebook shares its variables.',
    args: { silent: false, storeHistory: true },
    required: ['kernelId', 'code'],
    annotations: { consequentialHint: true, untrustedContentHint: true }
  },
  {
    name: 'interrupt_kernel',
    command: CommandIDs.interruptKernel,
    description:
      'Interrupt the code running in a kernel. Kernel ids come from get_context.',
    required: ['kernelId']
  },
  {
    name: 'restart_kernel',
    command: CommandIDs.restartKernel,
    description:
      'Restart a kernel without confirmation: all its variables are lost. Kernel ids come from get_context.',
    required: ['kernelId'],
    annotations: { consequentialHint: true }
  }
];

/**
 * Check a tool spec from the settings.
 *
 * @returns a translated error message, or `null` for a valid spec.
 */
export function validateSpec(
  spec: unknown,
  trans: TranslationBundle
): string | null {
  if (!Private.isObject(spec)) {
    return trans.__('a tool must be an object');
  }
  const { command, name, description, args, inputs, required, annotations } =
    spec;
  if (typeof command !== 'string' || !command) {
    return trans.__('"command" must be a non-empty string');
  }
  if (isGlob(command)) {
    const extra = Object.keys(spec).filter(
      key => key !== 'command' && key !== 'annotations'
    );
    if (extra.length > 0) {
      return trans.__(
        'a glob pattern only accepts "annotations", not %1',
        Private.list(extra)
      );
    }
  }
  if (
    name !== undefined &&
    (typeof name !== 'string' || !TOOL_NAME_PATTERN.test(name))
  ) {
    return trans.__(
      '"name" must have 1 to %1 letters, digits, "_" or "-"',
      MAX_TOOL_NAME_LENGTH
    );
  }
  if (description !== undefined && typeof description !== 'string') {
    return trans.__('"description" must be a string');
  }
  if (args !== undefined && !Private.isObject(args)) {
    return trans.__('"args" must be an object');
  }
  if (required !== undefined && !Private.isStringList(required)) {
    return trans.__('"required" must be a list of argument names');
  }
  if (inputs !== undefined && !Private.isStringList(inputs)) {
    return trans.__('"inputs" must be a list of argument names');
  }
  if (annotations !== undefined && !Private.isObject(annotations)) {
    return trans.__('"annotations" must be an object');
  }
  return null;
}

/**
 * Hints for a command without explicit annotations. Only
 * `consequentialHint` is guessed: a wrong `readOnlyHint` would mislead
 * agents into running a command without confirmation.
 */
export function guessAnnotations(commandId: string): IToolAnnotations {
  const verb = commandId.slice(commandId.indexOf(':') + 1);
  return /(^|-)(clear|close|delete|execute|kill|logout|remove|rename|reset|restart|run|shut-down|shutdown)(-|$)/.test(
    verb
  )
    ? { consequentialHint: true }
    : {};
}

/**
 * The input schema of a command tool: the command argument schema without
 * the UI and fixed arguments, plus the arguments the spec requires.
 */
export function inputSchema(
  described: ReadonlyJSONObject | null,
  spec: Pick<ICommandToolSpec, 'args' | 'inputs' | 'required'>
): JSONObject {
  const hidden = new Set([...UI_ARGS, ...Object.keys(spec.args ?? {})]);
  const base: JSONObject =
    described && described.type === 'object'
      ? (JSON.parse(JSON.stringify(described)) as JSONObject)
      : { type: 'object' };
  const declared = Object.entries(
    (base.properties as JSONObject | undefined) ?? {}
  );
  const required = Array.from(
    new Set([
      ...(Array.isArray(base.required) ? (base.required as string[]) : []),
      ...(spec.required ?? [])
    ])
  ).filter(key => !hidden.has(key));
  const properties: JSONObject = {};
  for (const [key, value] of declared) {
    const shown =
      !spec.inputs || spec.inputs.includes(key) || required.includes(key);
    if (!hidden.has(key) && shown) {
      properties[key] = value as JSONValue;
    }
  }
  for (const key of required) {
    properties[key] = properties[key] ?? {};
  }
  base.properties = properties;
  if (required.length > 0) {
    base.required = required;
  } else {
    delete base.required;
  }
  // Commands ignore unknown arguments: declare them as errors when the
  // command describes its arguments, even if they are all fixed.
  if (declared.length > 0 && base.additionalProperties === undefined) {
    base.additionalProperties = false;
  }
  return base;
}

/**
 * Check the input of a command tool against its schema.
 *
 * Browsers do not validate tool inputs, and commands silently ignore
 * unknown arguments, so a misnamed argument would otherwise target the
 * active document instead of failing.
 */
export function checkInput(
  input: ReadonlyJSONObject,
  schema: ReadonlyJSONObject
): { args: JSONObject } | { error: string } {
  const properties = (schema.properties ?? {}) as ReadonlyJSONObject;
  const names = Object.keys(properties);
  const required = Array.isArray(schema.required)
    ? (schema.required as string[])
    : [];
  const args: JSONObject = {};
  for (const [key, value] of Object.entries(input)) {
    // LLM clients often send `null` for the optional arguments they skip.
    if (
      UI_ARGS.includes(key) ||
      value === undefined ||
      (value === null && !required.includes(key))
    ) {
      continue;
    }
    args[key] = value as JSONValue;
  }
  if (schema.additionalProperties === false) {
    const unknown = Object.keys(args).filter(key => !names.includes(key));
    if (unknown.length > 0) {
      const accepted =
        names.length > 0
          ? `Accepted arguments: ${Private.list(names)}.`
          : 'This tool takes no arguments.';
      return {
        error: `Unknown argument${unknown.length > 1 ? 's' : ''} ${Private.list(unknown)}. ${accepted}`
      };
    }
  }
  const missing = required.filter(key => {
    const value = args[key];
    return (
      value === undefined ||
      value === null ||
      (typeof value === 'string' &&
        value.trim() === '' &&
        Private.IDENTIFIER.test(key))
    );
  });
  if (missing.length > 0) {
    return {
      error: `Missing required argument${missing.length > 1 ? 's' : ''} ${Private.list(missing)}.`
    };
  }
  for (const [key, value] of Object.entries(args)) {
    const expected = (properties[key] as ReadonlyJSONObject | undefined)?.type;
    if (typeof expected === 'string' && !Private.hasType(value, expected)) {
      return { error: `Argument "${key}" must be of type ${expected}.` };
    }
  }
  return { args };
}

/**
 * The namespace for module private data.
 */
namespace Private {
  /**
   * Arguments that cannot be blank when required: an empty path or id makes
   * commands fall back to the active document.
   */
  export const IDENTIFIER = /(^id|Id|ID|_id|[nN]ame|[pP]ath)$/;

  /**
   * Whether a value is a plain object.
   */
  export function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  /**
   * Whether a value is a list of strings.
   */
  export function isStringList(value: unknown): value is string[] {
    return (
      Array.isArray(value) && value.every(item => typeof item === 'string')
    );
  }

  /**
   * Quote and join names.
   */
  export function list(names: string[]): string {
    return names.map(name => `"${name}"`).join(', ');
  }

  /**
   * Whether a value matches a JSON schema primitive type.
   */
  export function hasType(value: JSONValue, type: string): boolean {
    switch (type) {
      case 'string':
      case 'boolean':
        return typeof value === type;
      case 'number':
        return typeof value === 'number';
      case 'integer':
        return Number.isInteger(value);
      case 'array':
        return Array.isArray(value);
      case 'object':
        return isObject(value);
      default:
        return true;
    }
  }
}
