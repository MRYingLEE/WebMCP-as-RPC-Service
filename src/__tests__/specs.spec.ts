import { JSONObject } from '@lumino/coreutils';
import { CommandIDs } from '../commands';
import {
  DEFAULT_TOOLS,
  MAX_TOOL_NAME_LENGTH,
  TOOL_NAME_PATTERN,
  UI_ARGS,
  checkInput,
  guessAnnotations,
  inputSchema,
  toToolName,
  validateSpec
} from '../specs';
import { Tools } from '../tools';
import { isGlob } from '../utils';
import { deepFreeze, trans } from './utils';

/**
 * The argument schema of the core `docmanager:open` command (JupyterLab
 * 4.6), shortened.
 */
const DOCMANAGER_OPEN = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'The path of the file to open' },
    factory: { type: 'string', description: 'The widget factory name' },
    kernel: { type: 'object', properties: { id: { type: 'string' } } },
    kernelPreference: {
      type: 'object',
      properties: { name: { type: 'string' } }
    },
    options: {
      type: 'object',
      properties: { mode: { type: 'string' }, activate: { type: 'boolean' } }
    },
    icon: { type: 'string' },
    label: { type: 'string' },
    mnemonic: { type: 'number' }
  }
};

describe('toToolName', () => {
  it('replaces separators with underscores', () => {
    expect(toToolName('notebook:run-cell')).toBe('notebook_run_cell');
    expect(toToolName('jupyterlab-ai-commands:get-file-info')).toBe(
      'jupyterlab_ai_commands_get_file_info'
    );
  });

  it('keeps letters, digits and underscores only', () => {
    expect(toToolName('@jupyterlab/foo:bar baz.qux')).toBe(
      'jupyterlab_foo_bar_baz_qux'
    );
    expect(toToolName('café:ouvrir')).toBe('caf_ouvrir');
  });

  it('collapses repeated underscores and trims them at both ends', () => {
    expect(toToolName('a::b--c__d')).toBe('a_b_c_d');
    expect(toToolName('_private:cmd_')).toBe('private_cmd');
  });

  it('falls back to "command" when nothing is left', () => {
    for (const id of ['', ':::', '___', 'éè']) {
      expect(toToolName(id)).toBe('command');
    }
  });

  it('caps the length', () => {
    expect(toToolName('a'.repeat(100))).toBe('a'.repeat(MAX_TOOL_NAME_LENGTH));
  });

  it('always returns a valid tool name', () => {
    const ids = [
      '',
      ':',
      'notebook:run-cell',
      'a b\tc\nd',
      'ünïcödé:命令',
      'x'.repeat(200),
      `${'y'.repeat(63)}:z`
    ];
    for (const id of ids) {
      expect(toToolName(id)).toMatch(TOOL_NAME_PATTERN);
    }
  });
});

describe('TOOL_NAME_PATTERN', () => {
  it('accepts 1 to 64 letters, digits, "_" and "-"', () => {
    expect(TOOL_NAME_PATTERN.test('read-file_2')).toBe(true);
    expect(TOOL_NAME_PATTERN.test('a'.repeat(64))).toBe(true);
    for (const name of ['', 'a'.repeat(65), 'a.b', 'a:b', 'a b']) {
      expect(TOOL_NAME_PATTERN.test(name)).toBe(false);
    }
  });
});

describe('DEFAULT_TOOLS', () => {
  const names = DEFAULT_TOOLS.map(spec => spec.name);

  it('have unique valid names', () => {
    for (const name of names) {
      expect(name).toMatch(TOOL_NAME_PATTERN);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  it('do not use the names of the built-in tools', () => {
    for (const name of names) {
      expect(Tools.BUILTIN_NAMES).not.toContain(name);
    }
  });

  it('pass validateSpec', () => {
    for (const spec of DEFAULT_TOOLS) {
      expect([spec.name, validateSpec(spec, trans)]).toEqual([spec.name, null]);
    }
  });

  it('target distinct exact commands', () => {
    const commands = DEFAULT_TOOLS.map(spec => spec.command);
    for (const command of commands) {
      expect(command).toMatch(/^[\w-]+:[\w-]+$/);
      expect(isGlob(command)).toBe(false);
    }
    expect(new Set(commands).size).toBe(commands.length);
  });

  it('have descriptions', () => {
    for (const spec of DEFAULT_TOOLS) {
      expect(typeof spec.description).toBe('string');
      expect(spec.description!.trim().length).toBeGreaterThan(10);
    }
  });

  it('only mention tools that exist', () => {
    const known = [...names, ...Tools.BUILTIN_NAMES];
    for (const spec of DEFAULT_TOOLS) {
      const mentioned = spec.description!.match(/\b[a-z]+(?:_[a-z]+)+\b/g);
      for (const name of mentioned ?? []) {
        expect([spec.name, name, known.includes(name)]).toEqual([
          spec.name,
          name,
          true
        ]);
      }
    }
  });

  it('do not require their fixed arguments', () => {
    for (const spec of DEFAULT_TOOLS) {
      const fixed = Object.keys(spec.args ?? {});
      for (const key of spec.required ?? []) {
        expect(fixed).not.toContain(key);
      }
    }
  });

  it('have consistent annotations', () => {
    for (const spec of DEFAULT_TOOLS) {
      const annotations = spec.annotations ?? {};
      expect(
        annotations.readOnlyHint === true &&
          annotations.consequentialHint === true
      ).toBe(false);
    }
  });

  it('mark the read tools as read-only and untrusted', () => {
    for (const name of [
      'list_directory',
      'read_file',
      'read_notebook',
      'read_cell'
    ]) {
      const spec = DEFAULT_TOOLS.find(item => item.name === name);
      expect(spec?.annotations).toEqual({
        readOnlyHint: true,
        untrustedContentHint: true
      });
    }
  });

  it('fix the arguments of edit_cell', () => {
    const spec = DEFAULT_TOOLS.find(item => item.name === 'edit_cell');
    expect(spec?.args).toEqual({
      background: true,
      diffMode: 'unified',
      showDiff: false
    });
  });

  it('mark the tools returning notebook or kernel content as untrusted', () => {
    // edit_cell returns the previous content of the cell.
    for (const name of ['edit_cell', 'run_cell', 'run_code']) {
      const spec = DEFAULT_TOOLS.find(item => item.name === name);
      expect([name, spec?.annotations?.untrustedContentHint]).toEqual([
        name,
        true
      ]);
    }
  });

  it('open documents with docmanager:open and a list of inputs', () => {
    const spec = DEFAULT_TOOLS.find(item => item.name === 'open_document')!;
    expect(spec.command).toBe('docmanager:open');
    expect(spec.inputs).toEqual(['path', 'factory', 'options']);
    expect(spec.required).toEqual(['path']);
    // docmanager:open reveals a document that is already open.
    expect(spec).not.toHaveProperty('args');
    const schema = inputSchema(DOCMANAGER_OPEN, spec);
    expect(schema).toEqual({
      type: 'object',
      properties: {
        path: DOCMANAGER_OPEN.properties.path,
        factory: DOCMANAGER_OPEN.properties.factory,
        options: DOCMANAGER_OPEN.properties.options
      },
      required: ['path'],
      additionalProperties: false
    });
    expect(
      checkInput({ path: 'a.ipynb', kernel: { id: 'k1' } }, schema)
    ).toEqual({
      error:
        'Unknown argument "kernel". Accepted arguments: "path", "factory", "options".'
    });
    expect(
      checkInput(
        {
          path: 'a.ipynb',
          factory: 'Editor',
          options: { mode: 'split-right' }
        },
        schema
      )
    ).toEqual({
      args: {
        path: 'a.ipynb',
        factory: 'Editor',
        options: { mode: 'split-right' }
      }
    });
  });

  it('list their required arguments in their inputs', () => {
    for (const spec of DEFAULT_TOOLS.filter(item => item.inputs)) {
      for (const key of spec.required ?? []) {
        expect([spec.name, key, spec.inputs!.includes(key)]).toEqual([
          spec.name,
          key,
          true
        ]);
      }
    }
  });

  it('tell that old notebooks have no cell ids in read_notebook', () => {
    const spec = DEFAULT_TOOLS.find(item => item.name === 'read_notebook')!;
    expect(spec.description).toContain(
      'Cells of notebooks older than nbformat 4.5 have no id in this result.'
    );
  });

  it('run the kernel commands of this extension', () => {
    const commands = DEFAULT_TOOLS.filter(spec =>
      spec.command.startsWith('jupyter-webmcp:')
    ).map(spec => [spec.name, spec.command, spec.required]);
    expect(commands).toEqual([
      ['interrupt_kernel', CommandIDs.interruptKernel, ['kernelId']],
      ['restart_kernel', CommandIDs.restartKernel, ['kernelId']]
    ]);
  });
});

describe('validateSpec', () => {
  it('accepts a minimal spec', () => {
    expect(validateSpec({ command: 'docmanager:open' }, trans)).toBeNull();
  });

  it('accepts a full spec', () => {
    expect(
      validateSpec(
        {
          command: 'docmanager:open',
          name: 'open-file_2',
          description: 'Open a file.',
          args: { activate: false },
          inputs: ['path', 'factory'],
          required: ['path'],
          annotations: { readOnlyHint: false }
        },
        trans
      )
    ).toBeNull();
  });

  it('refuses values that are not objects', () => {
    for (const spec of [null, undefined, 'docmanager:open', 1, []]) {
      expect(validateSpec(spec, trans)).toBe('a tool must be an object');
    }
  });

  it('requires a command', () => {
    const error = '"command" must be a non-empty string';
    expect(validateSpec({}, trans)).toBe(error);
    expect(validateSpec({ command: '' }, trans)).toBe(error);
    expect(validateSpec({ command: 1 }, trans)).toBe(error);
    expect(validateSpec({ name: 'tool' }, trans)).toBe(error);
  });

  it('accepts a glob with annotations only', () => {
    expect(validateSpec({ command: 'notebook:*' }, trans)).toBeNull();
    expect(
      validateSpec(
        {
          command: 'notebook:run-?ell',
          annotations: { consequentialHint: true }
        },
        trans
      )
    ).toBeNull();
  });

  it('refuses other fields with a glob', () => {
    expect(validateSpec({ command: 'notebook:*', name: 'nb' }, trans)).toBe(
      'a glob pattern only accepts "annotations", not "name"'
    );
    expect(
      validateSpec(
        {
          command: '*',
          description: 'All',
          args: {},
          inputs: [],
          required: [],
          annotations: {}
        },
        trans
      )
    ).toBe(
      'a glob pattern only accepts "annotations", not "description", "args", "inputs", "required"'
    );
    expect(validateSpec({ command: 'a?', unknown: true }, trans)).toBe(
      'a glob pattern only accepts "annotations", not "unknown"'
    );
  });

  it('still checks the annotations of a glob', () => {
    expect(
      validateSpec({ command: 'notebook:*', annotations: [] }, trans)
    ).toBe('"annotations" must be an object');
  });

  it('checks the name', () => {
    const error = '"name" must have 1 to 64 letters, digits, "_" or "-"';
    for (const name of ['', 'has space', 'a.b', 'a:b', 'a'.repeat(65), 1]) {
      expect(validateSpec({ command: 'x:y', name }, trans)).toBe(error);
    }
    expect(
      validateSpec({ command: 'x:y', name: 'a'.repeat(64) }, trans)
    ).toBeNull();
  });

  it('checks the description', () => {
    expect(validateSpec({ command: 'x:y', description: 1 }, trans)).toBe(
      '"description" must be a string'
    );
  });

  it('checks the fixed arguments', () => {
    for (const args of [null, [], 'a=1', 1]) {
      expect(validateSpec({ command: 'x:y', args }, trans)).toBe(
        '"args" must be an object'
      );
    }
  });

  it('checks the required arguments', () => {
    for (const required of ['path', [1], ['path', null], {}]) {
      expect(validateSpec({ command: 'x:y', required }, trans)).toBe(
        '"required" must be a list of argument names'
      );
    }
    expect(validateSpec({ command: 'x:y', required: [] }, trans)).toBeNull();
  });

  it('checks the inputs', () => {
    for (const inputs of ['path', [1], ['path', null], {}, null]) {
      expect(validateSpec({ command: 'x:y', inputs }, trans)).toBe(
        '"inputs" must be a list of argument names'
      );
    }
    expect(validateSpec({ command: 'x:y', inputs: [] }, trans)).toBeNull();
    expect(
      validateSpec({ command: 'x:y', inputs: ['path'] }, trans)
    ).toBeNull();
  });

  it('checks the annotations', () => {
    for (const annotations of [null, [], true]) {
      expect(validateSpec({ command: 'x:y', annotations }, trans)).toBe(
        '"annotations" must be an object'
      );
    }
  });

  it('ignores unknown fields of an exact command', () => {
    // The settings schema refuses them before the spec gets here.
    expect(validateSpec({ command: 'x:y', other: 1 }, trans)).toBeNull();
  });
});

describe('guessAnnotations', () => {
  it('marks commands with a consequential verb', () => {
    for (const id of [
      'notebook:run-cell',
      'notebook:run-all-cells',
      'notebook:delete-cell',
      'notebook:clear-all-cell-outputs',
      'notebook:restart-kernel',
      'kernelmenu:restart-and-clear',
      'kernelmenu:shutdown',
      'filebrowser:rename',
      'filebrowser:delete',
      'docmanager:delete-file',
      'application:close-all',
      'apputils:reset',
      'console:execute',
      'console:run-forced',
      'jupyterlab-ai-commands:execute-in-kernel',
      'jupyterlab-ai-commands:shutdown-kernel',
      'my-ext:kill',
      'my-ext:remove-item'
    ]) {
      expect([id, guessAnnotations(id)]).toEqual([
        id,
        { consequentialHint: true }
      ]);
    }
  });

  it('gives no hint to other commands', () => {
    for (const id of [
      'docmanager:open',
      'notebook:insert-cell-below',
      'notebook:move-cell-up',
      'filebrowser:copy',
      'jupyterlab-ai-commands:get-file-info',
      'jupyter-webmcp:interrupt-kernel',
      'my-ext:runtime-info',
      'my-ext:rerun',
      'my-ext:closed-items',
      'my-ext:Run',
      'my-ext:shut-downer',
      'my-ext:logouts'
    ]) {
      expect([id, guessAnnotations(id)]).toEqual([id, {}]);
    }
  });

  it('never guesses readOnlyHint', () => {
    expect(guessAnnotations('notebook:get-info')).toEqual({});
  });

  it('only looks at the part after the first colon', () => {
    expect(guessAnnotations('run:open')).toEqual({});
    expect(guessAnnotations('run-cell')).toEqual({ consequentialHint: true });
    expect(guessAnnotations('a:b:delete')).toEqual({});
  });

  it('marks the "shut-down" and logout commands', () => {
    for (const id of [
      'running:kernel-shut-down',
      'running:kernel-shut-down-unused',
      'terminal:shut-down',
      'filemenu:logout',
      'hub:logout'
    ]) {
      expect([id, guessAnnotations(id)]).toEqual([
        id,
        { consequentialHint: true }
      ]);
    }
  });
});

describe('inputSchema', () => {
  const described = {
    type: 'object',
    description: 'Open a document.',
    properties: {
      path: { type: 'string' },
      factory: { type: 'string' },
      activate: { type: 'boolean' },
      isPalette: { type: 'boolean' },
      toolbar: { type: 'boolean' },
      _luminoEvent: { type: 'object' }
    },
    required: ['path', 'isPalette'],
    additionalProperties: false
  };

  it('removes the UI arguments', () => {
    const schema = inputSchema(described, {});
    expect(Object.keys(schema.properties as JSONObject)).toEqual([
      'path',
      'factory',
      'activate'
    ]);
    expect(schema.required).toEqual(['path']);
    for (const key of UI_ARGS) {
      expect(schema.properties).not.toHaveProperty(key);
    }
  });

  it('removes the fixed arguments', () => {
    const schema = inputSchema(described, {
      args: { activate: false, path: 'a.txt' }
    });
    expect(Object.keys(schema.properties as JSONObject)).toEqual(['factory']);
    expect(schema).not.toHaveProperty('required');
  });

  it('merges the required arguments without duplicates', () => {
    const schema = inputSchema(described, {
      required: ['factory', 'path', 'toolbar']
    });
    expect(schema.required).toEqual(['path', 'factory']);
  });

  it('does not require fixed arguments', () => {
    const schema = inputSchema(described, {
      args: { factory: 'Editor' },
      required: ['factory']
    });
    expect(schema.required).toEqual(['path']);
  });

  it('keeps the other schema fields', () => {
    const schema = inputSchema(described, {});
    expect(schema.type).toBe('object');
    expect(schema.description).toBe('Open a document.');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties).toEqual({
      path: { type: 'string' },
      factory: { type: 'string' },
      activate: { type: 'boolean' }
    });
  });

  it('does not change the command schema', () => {
    const frozen = deepFreeze(JSON.parse(JSON.stringify(described)));
    const schema = inputSchema(frozen, {
      args: { activate: true },
      required: ['factory']
    });
    expect(frozen).toEqual(described);
    (schema.properties as any).path.type = 'number';
    expect(frozen.properties.path.type).toBe('string');
  });

  it('starts from an empty object schema without a command schema', () => {
    expect(inputSchema(null, {})).toEqual({ type: 'object', properties: {} });
    expect(inputSchema(null, { required: ['kernelId'] })).toEqual({
      type: 'object',
      properties: { kernelId: {} },
      required: ['kernelId']
    });
  });

  it('replaces a schema that does not describe an object', () => {
    const schemas: JSONObject[] = [
      { type: 'string' },
      { type: 'array', items: { type: 'string' } },
      { properties: { path: { type: 'string' } } },
      {}
    ];
    for (const schema of schemas) {
      expect(inputSchema(schema, {})).toEqual({
        type: 'object',
        properties: {}
      });
    }
  });

  it('handles an object schema without properties or required', () => {
    expect(inputSchema({ type: 'object' }, {})).toEqual({
      type: 'object',
      properties: {}
    });
    expect(
      inputSchema({ type: 'object', required: 'path' }, { required: ['a'] })
    ).toEqual({ type: 'object', properties: { a: {} }, required: ['a'] });
  });

  it('declares the required arguments missing from the properties', () => {
    const schema = inputSchema(
      {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path', 'mode']
      },
      { required: ['kernelId', 'path'] }
    );
    expect(schema).toEqual({
      type: 'object',
      properties: { path: { type: 'string' }, mode: {}, kernelId: {} },
      required: ['path', 'mode', 'kernelId'],
      additionalProperties: false
    });
  });

  it('refuses unknown arguments when the command declares properties', () => {
    expect(
      inputSchema(
        { type: 'object', properties: { path: { type: 'string' } } },
        {}
      )
    ).toEqual({
      type: 'object',
      properties: { path: { type: 'string' } },
      additionalProperties: false
    });
    // Also when all the declared arguments are fixed or UI arguments.
    expect(
      inputSchema(
        {
          type: 'object',
          properties: { path: { type: 'string' }, isPalette: {} }
        },
        { args: { path: 'a.txt' } }
      )
    ).toEqual({ type: 'object', properties: {}, additionalProperties: false });
  });

  it('keeps an explicit additionalProperties', () => {
    for (const additionalProperties of [true, false, { type: 'string' }]) {
      expect(
        inputSchema(
          {
            type: 'object',
            properties: { path: { type: 'string' } },
            additionalProperties
          },
          {}
        ).additionalProperties
      ).toEqual(additionalProperties);
    }
  });

  it('keeps only the inputs of the spec', () => {
    const schema = inputSchema(described, {
      inputs: ['path', 'factory', 'isPalette', 'unknown']
    });
    expect(schema).toEqual({
      type: 'object',
      description: 'Open a document.',
      properties: { path: { type: 'string' }, factory: { type: 'string' } },
      required: ['path'],
      additionalProperties: false
    });
  });

  it('hides the fixed arguments listed in the inputs', () => {
    const schema = inputSchema(described, {
      args: { factory: 'Editor' },
      inputs: ['path', 'factory']
    });
    expect(schema.properties).toEqual({ path: { type: 'string' } });
  });

  it('refuses unknown arguments when every declared argument is hidden by the inputs', () => {
    expect(inputSchema(DOCMANAGER_OPEN, { inputs: [] })).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false
    });
  });

  it('keeps the required arguments that are not in the inputs', () => {
    const schema = inputSchema(described, { inputs: ['factory'] });
    expect(Object.keys(schema.properties as JSONObject).sort()).toEqual([
      'factory',
      'path'
    ]);
    expect(schema.required).toEqual(['path']);
  });

  it('keeps the declared schema of a required argument not in the inputs', () => {
    const schema = inputSchema(described, { inputs: ['factory'] });
    expect(schema.properties).toEqual({
      path: { type: 'string' },
      factory: { type: 'string' }
    });
  });

  it('ignores the inputs without a command schema', () => {
    expect(
      inputSchema(null, { inputs: ['path'], required: ['kernelId'] })
    ).toEqual({
      type: 'object',
      properties: { kernelId: {} },
      required: ['kernelId']
    });
  });

  it('does not refuse unknown arguments without declared properties', () => {
    const schemas: Array<JSONObject | null> = [
      null,
      { type: 'object' },
      { type: 'object', properties: {} }
    ];
    for (const described of schemas) {
      expect(
        inputSchema(described, { required: ['kernelId'] })
      ).not.toHaveProperty('additionalProperties');
    }
  });
});

describe('checkInput', () => {
  const schema = {
    type: 'object',
    properties: {
      notebookPath: { type: 'string' },
      cellId: { type: 'string' },
      count: { type: 'integer' },
      ratio: { type: 'number' },
      save: { type: 'boolean' },
      tags: { type: 'array' },
      options: { type: 'object' },
      anything: {},
      either: { type: ['string', 'integer'] }
    },
    required: ['notebookPath', 'cellId']
  };
  const strict = { ...schema, additionalProperties: false };
  const base = { notebookPath: 'a.ipynb', cellId: 'c1' };

  it('returns the valid arguments', () => {
    const input = {
      ...base,
      count: 2,
      ratio: 0.5,
      save: true,
      tags: ['x'],
      options: { a: 1 },
      anything: 'x',
      either: 3
    };
    expect(checkInput(input, schema)).toEqual({ args: input });
  });

  it('drops the UI arguments and undefined values', () => {
    expect(
      checkInput(
        {
          ...base,
          isPalette: true,
          toolbar: true,
          _luminoEvent: { type: 'click' },
          isContextMenu: true,
          isLauncher: true,
          count: undefined
        } as any,
        schema
      )
    ).toEqual({ args: base });
  });

  it('refuses unknown arguments', () => {
    const names =
      '"notebookPath", "cellId", "count", "ratio", "save", "tags", "options", "anything", "either"';
    expect(checkInput({ ...base, path: 'b.ipynb' }, strict)).toEqual({
      error: `Unknown argument "path". Accepted arguments: ${names}.`
    });
    expect(checkInput({ ...base, path: 'b', id: 'c' }, strict)).toEqual({
      error: `Unknown arguments "path", "id". Accepted arguments: ${names}.`
    });
  });

  it('reports unknown arguments before missing ones', () => {
    expect(checkInput({ notebook: 'a.ipynb' }, strict)).toEqual({
      error: expect.stringMatching(/^Unknown argument "notebook"\./)
    });
  });

  it('accepts unknown arguments unless additionalProperties is false', () => {
    // The advertised schema allows them.
    const schemas: JSONObject[] = [
      schema,
      { ...schema, additionalProperties: true },
      { ...schema, additionalProperties: { type: 'string' } }
    ];
    for (const toolSchema of schemas) {
      expect(checkInput({ ...base, path: 'b', extra: 1 }, toolSchema)).toEqual({
        args: { ...base, path: 'b', extra: 1 }
      });
    }
  });

  it('accepts unknown arguments for a command without an argument schema', () => {
    const toolSchema = inputSchema(null, { required: ['path'] });
    expect(checkInput({ path: 'a.py', line: 10 }, toolSchema)).toEqual({
      args: { path: 'a.py', line: 10 }
    });
    expect(checkInput({ line: 10 }, toolSchema)).toEqual({
      error: 'Missing required argument "path".'
    });
  });

  it('refuses missing required arguments', () => {
    expect(checkInput({ notebookPath: 'a.ipynb' }, schema)).toEqual({
      error: 'Missing required argument "cellId".'
    });
    expect(checkInput({}, schema)).toEqual({
      error: 'Missing required arguments "notebookPath", "cellId".'
    });
  });

  it('treats null as missing for required arguments', () => {
    expect(checkInput({ ...base, cellId: null }, schema)).toEqual({
      error: 'Missing required argument "cellId".'
    });
  });

  it('treats blank strings as missing for required ids, names and paths', () => {
    const toolSchema = {
      type: 'object',
      properties: {
        notebookPath: { type: 'string' },
        cellId: { type: 'string' },
        kernelId: { type: 'string' },
        fileName: { type: 'string' },
        name: { type: 'string' },
        filepath: { type: 'string' }
      },
      required: [
        'notebookPath',
        'cellId',
        'kernelId',
        'fileName',
        'name',
        'filepath'
      ]
    };
    const input = {
      notebookPath: 'a.ipynb',
      cellId: 'c1',
      kernelId: 'k1',
      fileName: 'a.py',
      name: 'nb',
      filepath: 'b.py'
    };
    expect(checkInput(input, toolSchema)).toEqual({ args: input });
    for (const key of Object.keys(input)) {
      for (const blank of ['', '  ', '\n\t']) {
        expect(checkInput({ ...input, [key]: blank }, toolSchema)).toEqual({
          error: `Missing required argument "${key}".`
        });
      }
    }
  });

  it('accepts empty strings for other arguments', () => {
    const toolSchema = {
      type: 'object',
      properties: {
        filePath: { type: 'string' },
        content: { type: 'string' },
        code: { type: 'string' },
        path: { type: 'string' },
        cellId: { type: 'string' }
      },
      required: ['filePath', 'content', 'code']
    };
    // An empty optional path is the server root for list_directory.
    const input = {
      filePath: 'a.txt',
      content: '',
      code: '',
      path: '',
      cellId: ''
    };
    expect(checkInput(input, toolSchema)).toEqual({ args: input });
  });

  it('checks the types of the arguments', () => {
    const cases: Array<[string, unknown, string]> = [
      ['cellId', 1, 'string'],
      ['count', 1.5, 'integer'],
      ['count', '2', 'integer'],
      ['ratio', '0.5', 'number'],
      ['save', 'true', 'boolean'],
      ['tags', 'x', 'array'],
      ['tags', { 0: 'x' }, 'array'],
      ['options', [], 'object'],
      ['options', '{}', 'object']
    ];
    for (const [key, value, type] of cases) {
      expect(checkInput({ ...base, [key]: value } as any, schema)).toEqual({
        error: `Argument "${key}" must be of type ${type}.`
      });
    }
  });

  it('drops null for optional arguments', () => {
    // LLM clients often send null for the optional arguments they skip.
    expect(
      checkInput({ ...base, save: null, options: null, anything: null }, schema)
    ).toEqual({ args: base });
  });

  it('drops null for unknown arguments before checking them', () => {
    expect(checkInput({ ...base, path: null }, strict)).toEqual({
      args: base
    });
  });

  it('accepts integers for number arguments', () => {
    expect(checkInput({ ...base, ratio: 2 }, schema)).toEqual({
      args: { ...base, ratio: 2 }
    });
  });

  it('skips type unions and unknown types', () => {
    expect(
      checkInput({ ...base, either: true, anything: [1] }, schema)
    ).toEqual({ args: { ...base, either: true, anything: [1] } });
    expect(
      checkInput(
        { a: 'x' },
        { type: 'object', properties: { a: { type: 'null' } } }
      )
    ).toEqual({ args: { a: 'x' } });
  });

  it('accepts unknown arguments with additionalProperties: true', () => {
    expect(
      checkInput(
        { ...base, extra: 1, isPalette: true },
        { ...schema, additionalProperties: true }
      )
    ).toEqual({ args: { ...base, extra: 1 } });
  });

  it('accepts any argument when the schema has no properties', () => {
    expect(checkInput({ a: 1, b: 'x' }, { type: 'object' })).toEqual({
      args: { a: 1, b: 'x' }
    });
    expect(
      checkInput({ a: 1, toolbar: true }, { type: 'object', properties: {} })
    ).toEqual({ args: { a: 1 } });
  });

  it('refuses any argument with additionalProperties: false and no properties', () => {
    const schemas: JSONObject[] = [
      { type: 'object', additionalProperties: false },
      { type: 'object', properties: {}, additionalProperties: false }
    ];
    for (const toolSchema of schemas) {
      expect(checkInput({ a: 1 }, toolSchema)).toEqual({
        error: expect.stringMatching(/^Unknown argument "a"\./)
      });
      expect(checkInput({ toolbar: true, b: null }, toolSchema)).toEqual({
        args: {}
      });
    }
  });

  it('still checks the required arguments without properties', () => {
    expect(
      checkInput({ a: 1 }, { type: 'object', required: ['kernelId'] })
    ).toEqual({ error: 'Missing required argument "kernelId".' });
  });

  it('refuses the fixed arguments hidden by inputSchema', () => {
    const toolSchema = inputSchema(schema, {
      args: { save: true },
      required: ['count']
    });
    expect(checkInput({ ...base, count: 1, save: false }, toolSchema)).toEqual({
      error: expect.stringMatching(/^Unknown argument "save"\./)
    });
    expect(checkInput(base, toolSchema)).toEqual({
      error: 'Missing required argument "count".'
    });
  });

  it('accepts an empty content for edit_cell', () => {
    const spec = DEFAULT_TOOLS.find(item => item.name === 'edit_cell')!;
    const toolSchema = inputSchema(
      {
        type: 'object',
        properties: {
          notebookPath: { type: 'string' },
          cellId: { type: 'string' },
          content: { type: 'string' },
          showDiff: { type: 'boolean' },
          background: { type: 'boolean' }
        },
        required: ['content']
      },
      spec
    );
    const input = { notebookPath: 'a.ipynb', cellId: 'c1', content: '' };
    expect(checkInput(input, toolSchema)).toEqual({ args: input });
  });

  it('accepts a required argument that the command does not declare', () => {
    const toolSchema = inputSchema(
      { type: 'object', properties: { path: { type: 'string' } } },
      { required: ['kernelId'] }
    );
    expect(checkInput({ kernelId: 'k1' }, toolSchema)).toEqual({
      args: { kernelId: 'k1' }
    });
    expect(checkInput({ kernelId: 'k1', other: 1 }, toolSchema)).toEqual({
      error: 'Unknown argument "other". Accepted arguments: "path", "kernelId".'
    });
  });
});
