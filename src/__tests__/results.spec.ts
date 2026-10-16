import { MainAreaWidget } from '@jupyterlab/apputils';
import {
  DEFAULT_CONTENT,
  NBTestUtils
} from '@jupyterlab/notebook/lib/testutils';
import { JSONObject } from '@lumino/coreutils';
import { Widget } from '@lumino/widgets';
import {
  Bounds,
  boundResult,
  describeWidget,
  toJSON,
  toToolResult,
  widgetType
} from '../results';
import { deepFreeze } from './utils';

/**
 * The length of a value as JSON.
 */
const size = (value: unknown): number => JSON.stringify(value).length;

/**
 * A string cut the way `boundResult` cuts it.
 */
const cut = (head: string, omitted: number, tail: string): string =>
  `${head}\n[... ${omitted} characters omitted ...]\n${tail}`;

/**
 * A widget with a duck-typed session context, like a console panel.
 */
class SessionWidget extends Widget {
  constructor(readonly sessionContext: unknown) {
    super();
  }
}

describe('widgetType', () => {
  it('uses the specific JupyterLab class of the widget', () => {
    const widget = new Widget();
    widget.addClass('jp-Terminal');
    expect(widgetType(widget)).toBe('Terminal');
  });

  it('skips generic, modifier and non-JupyterLab classes', () => {
    const widget = new Widget();
    for (const name of [
      'jp-FileEditor',
      'jp-MainAreaWidget',
      'jp-MainAreaWidget-ContainStrict',
      'jp-Document',
      'jp-Activity',
      'jp-mod-current',
      'lm-Widget',
      'Foo'
    ]) {
      widget.addClass(name);
    }
    expect(widgetType(widget)).toBe('FileEditor');
  });

  it('uses the last specific class', () => {
    const widget = new Widget();
    widget.addClass('jp-First');
    widget.addClass('jp-Second');
    expect(widgetType(widget)).toBe('Second');
  });

  it('falls back to "Widget"', () => {
    expect(widgetType(new Widget())).toBe('Widget');
  });

  it('uses the content class of a generic main area widget', () => {
    const content = new Widget();
    content.addClass('jp-Terminal');
    const widget = new MainAreaWidget({ content });
    expect(widgetType(widget)).toBe('Terminal');
    widget.addClass('jp-Launcher');
    expect(widgetType(widget)).toBe('Launcher');
    widget.dispose();
  });

  it('falls back to "Widget" when the content of a main area widget failed', async () => {
    const reveal = Promise.reject(new Error('Load error'));
    const widget = new MainAreaWidget({ content: new Widget(), reveal });
    await reveal.catch(() => undefined);
    expect(widget.content).toBeNull();
    expect(widgetType(widget)).toBe('Widget');
    widget.dispose();
  });

  it('does not look into the content of other widgets', () => {
    const parent = new Widget();
    const child = new Widget();
    child.addClass('jp-Terminal');
    parent.node.appendChild(child.node);
    expect(widgetType(parent)).toBe('Widget');
  });
});

describe('describeWidget', () => {
  it('describes a plain widget', () => {
    const widget = new Widget();
    const title = 'My Widget';
    widget.id = 'my-widget';
    widget.title.label = title;
    widget.addClass('jp-Terminal');
    expect(describeWidget(widget)).toEqual({
      type: 'Terminal',
      id: 'my-widget',
      title
    });
  });

  it('omits an empty id', () => {
    expect(describeWidget(new Widget())).toEqual({ type: 'Widget', title: '' });
  });

  it('reports a disposed widget', () => {
    // Jupyter Notebook disposes the widget of a document opened in a new tab.
    const widget = new Widget();
    widget.id = 'nb-1';
    widget.addClass('jp-NotebookPanel');
    widget.dispose();
    expect(describeWidget(widget)).toEqual({
      type: 'NotebookPanel',
      disposed: true
    });
    expect(toToolResult(widget)).toEqual({
      success: true,
      result: { type: 'NotebookPanel', disposed: true }
    });
  });

  it('reports the kernel of a widget with a session context', () => {
    const widget = new SessionWidget({
      session: { kernel: { id: 'k-1', name: 'python3' } },
      kernelDisplayStatus: 'idle'
    });
    widget.id = 'console-1';
    expect(describeWidget(widget)).toEqual({
      type: 'Widget',
      id: 'console-1',
      title: '',
      kernel: { id: 'k-1', name: 'python3', status: 'idle' }
    });
  });

  it('omits the kernel when the session has none', () => {
    expect(
      describeWidget(new SessionWidget({ session: null })).kernel
    ).toBeUndefined();
    expect(
      describeWidget(
        new SessionWidget({
          session: { kernel: null },
          kernelDisplayStatus: ''
        })
      ).kernel
    ).toBeUndefined();
  });

  describe('with a notebook panel', () => {
    let warn: jest.SpyInstance;

    beforeEach(() => {
      // The notebook test utilities warn about Yjs documents.
      warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
      warn.mockRestore();
    });

    it('reports the document, kernel and notebook state', async () => {
      const context = await NBTestUtils.createMockContext(true);
      const panel = NBTestUtils.createNotebookPanel(context);
      await context.ready;
      context.model.fromJSON(DEFAULT_CONTENT);
      panel.content.activeCellIndex = 2;
      const kernel = context.sessionContext.session!.kernel!;

      const info = describeWidget(panel);
      expect(info).toEqual({
        type: 'NotebookPanel',
        id: panel.id,
        title: panel.title.label,
        path: context.path,
        dirty: context.model.dirty,
        kernel: {
          id: kernel.id,
          name: kernel.name,
          status: context.sessionContext.kernelDisplayStatus
        },
        notebook: {
          cellCount: DEFAULT_CONTENT.cells.length,
          activeCellIndex: 2,
          activeCellId: panel.content.activeCell!.model.id,
          activeCellType: DEFAULT_CONTENT.cells[2].cell_type
        }
      });
      expect(typeof info.dirty).toBe('boolean');
      expect(JSON.parse(JSON.stringify(info))).toEqual(info);
      expect(toJSON(panel)).toEqual(info);
      expect(toToolResult(panel)).toEqual({ success: true, result: info });

      panel.dispose();
      context.dispose();
    });
  });
});

describe('toJSON', () => {
  it('turns undefined into null', () => {
    expect(toJSON(undefined)).toBeNull();
    expect(toJSON(null)).toBeNull();
  });

  it('keeps JSON values', () => {
    expect(toJSON(1)).toBe(1);
    expect(toJSON('text')).toBe('text');
    expect(toJSON(false)).toBe(false);
    expect(toJSON([1, 'a', null])).toEqual([1, 'a', null]);
  });

  it('returns a copy of objects', () => {
    const value = { a: [1, { b: 2 }] };
    const json = toJSON(value);
    expect(json).toEqual(value);
    expect(json).not.toBe(value);
    expect((json as any).a).not.toBe(value.a);
  });

  it('applies the JSON conversion rules', () => {
    const date = new Date(Date.UTC(2026, 0, 2));
    expect(toJSON(date)).toBe('2026-01-02T00:00:00.000Z');
    expect(toJSON({ a: undefined, b: 1, c: () => 1 })).toEqual({ b: 1 });
    expect(toJSON(NaN)).toBeNull();
    expect(toJSON(new Map([['a', 1]]))).toEqual({});
    expect(toJSON(() => 1)).toBeNull();
    expect(toJSON(Symbol('s'))).toBeNull();
  });

  it('falls back to a string for values without JSON form', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;
    expect(toJSON(circular)).toBe('[object Object]');
    const custom = {
      toJSON: () => {
        throw new Error('no JSON');
      },
      toString: () => 'custom'
    };
    expect(toJSON(custom)).toBe('custom');
  });

  it('converts objects without prototype', () => {
    const bare = Object.assign(Object.create(null), { a: 1 });
    expect(toJSON(bare)).toEqual({ a: 1 });
  });

  it('uses a placeholder when the string fallback throws', () => {
    const bare = Object.create(null);
    bare.self = bare;
    expect(toJSON(bare)).toBe('[value that cannot be serialized]');
  });

  it('describes a widget', () => {
    const widget = new Widget();
    widget.id = 'w-1';
    expect(toJSON(widget)).toEqual(describeWidget(widget));
  });

  it('describes widgets inside objects and arrays', () => {
    const widget = new Widget();
    widget.id = 'w-1';
    const other = new Widget();
    other.addClass('jp-Terminal');
    expect(toJSON({ widget, count: 1 })).toEqual({
      widget: describeWidget(widget),
      count: 1
    });
    expect(toJSON([widget])).toEqual([describeWidget(widget)]);
    expect(toJSON({ panels: [{ main: widget }, other] })).toEqual({
      panels: [{ main: describeWidget(widget) }, describeWidget(other)]
    });
  });
});

describe('toToolResult', () => {
  it('wraps values without a boolean success', () => {
    expect(toToolResult(42)).toEqual({ success: true, result: 42 });
    expect(toToolResult('done')).toEqual({ success: true, result: 'done' });
    expect(toToolResult(undefined)).toEqual({ success: true, result: null });
    expect(toToolResult(null)).toEqual({ success: true, result: null });
    expect(toToolResult([1, 2])).toEqual({ success: true, result: [1, 2] });
    expect(toToolResult({ path: 'a.txt' })).toEqual({
      success: true,
      result: { path: 'a.txt' }
    });
    expect(toToolResult({ success: 'yes' })).toEqual({
      success: true,
      result: { success: 'yes' }
    });
  });

  it('returns results with a boolean success flat', () => {
    expect(toToolResult({ success: true, cellId: 'c1' })).toEqual({
      success: true,
      cellId: 'c1'
    });
    expect(toToolResult({ success: false, error: 'Not found' })).toEqual({
      success: false,
      error: 'Not found'
    });
  });

  it('describes nested widgets', () => {
    const widget = new Widget();
    widget.id = 'w-1';
    expect(toToolResult({ success: true, widget })).toEqual({
      success: true,
      widget: describeWidget(widget)
    });
  });

  it('adds an error from errorName and errorValue', () => {
    expect(
      toToolResult({
        success: false,
        status: 'error',
        message: 'Cell execution failed',
        errorName: 'NameError',
        errorValue: "name 'x' is not defined",
        traceback: ['...']
      })
    ).toEqual({
      success: false,
      status: 'error',
      message: 'Cell execution failed',
      errorName: 'NameError',
      errorValue: "name 'x' is not defined",
      traceback: ['...'],
      error: "NameError: name 'x' is not defined"
    });
  });

  it('uses errorName alone when errorValue is empty', () => {
    for (const errorValue of [undefined, '', null]) {
      expect(
        toToolResult({
          success: false,
          errorName: 'KeyboardInterrupt',
          errorValue
        }).error
      ).toBe('KeyboardInterrupt');
    }
  });

  it('adds an error from the message', () => {
    expect(
      toToolResult({ success: false, message: 'Kernel execution failed' })
    ).toEqual({
      success: false,
      message: 'Kernel execution failed',
      error: 'Kernel execution failed'
    });
    expect(
      toToolResult({ success: false, errorName: '', message: 'Failed' }).error
    ).toBe('Failed');
  });

  it('adds a generic error otherwise', () => {
    expect(toToolResult({ success: false })).toEqual({
      success: false,
      error: 'The command failed.'
    });
    expect(toToolResult({ success: false, message: 42 })).toEqual({
      success: false,
      message: 42,
      error: 'The command failed.'
    });
  });

  it('keeps an existing error', () => {
    expect(
      toToolResult({ success: false, error: 'Boom', errorName: 'X' }).error
    ).toBe('Boom');
  });

  it('adds no error to successful results', () => {
    expect(toToolResult({ success: true, message: 'ok' })).toEqual({
      success: true,
      message: 'ok'
    });
  });

  it('does not change its input', () => {
    const value = deepFreeze({ success: false, errorName: 'E' });
    expect(toToolResult(value).error).toBe('E');
    expect(value).toEqual({ success: false, errorName: 'E' });
  });
});

describe('Bounds', () => {
  it('has the documented limits and steps', () => {
    expect(Bounds.RICH_LIMIT).toBe(2000);
    expect(Bounds.REPORT_LIMIT).toBe(20);
    expect(Bounds.STEPS).toEqual([
      { outputs: 1000, strings: Infinity, items: Infinity },
      { outputs: 500, strings: 500, items: 50 },
      { outputs: 150, strings: 150, items: 10 }
    ]);
  });
});

describe('boundResult', () => {
  const png = `iVBORw0KGgo${'A'.repeat(500)}`;

  it('returns a copy of a result under the limit', () => {
    const result = {
      success: true,
      source: 'print("hi")',
      outputs: [{ output_type: 'stream', name: 'stdout', text: 'hi\n' }],
      items: Array.from({ length: 100 }, (item, index) => index)
    };
    const bounded = boundResult(result, size(result));
    expect(bounded).toEqual(result);
    expect(bounded).not.toBe(result);
    expect(bounded).not.toHaveProperty('truncated');
    expect(bounded).not.toHaveProperty('truncation');
  });

  it('does not cut when the limit is 0', () => {
    const result = {
      success: true,
      content: 'x'.repeat(10000),
      outputs: [{ text: 'o'.repeat(10000) }]
    };
    expect(boundResult(result, 0)).toEqual(result);
    expect(boundResult(result, -1)).toEqual(result);
  });

  describe('MIME data', () => {
    it('replaces binary data with a placeholder, even without a limit', () => {
      const data = {
        'image/png': png,
        'image/jpeg': png,
        'audio/wav': png,
        'video/mp4': png,
        'application/pdf': png,
        'application/octet-stream': png
      };
      const placeholder = (mime: string) =>
        `[omitted ${mime} data, ${png.length + 2} characters]`;
      for (const limit of [100000, 0]) {
        const bounded = boundResult(
          { success: true, outputs: [{ output_type: 'display_data', data }] },
          limit
        ) as any;
        for (const key of Object.keys(data)) {
          expect(bounded.outputs[0].data[key]).toBe(placeholder(key));
        }
        expect(bounded).not.toHaveProperty('truncated');
      }
    });

    it('keeps SVG and text data without a text/plain alternative', () => {
      const data = {
        'image/svg+xml': '<svg></svg>',
        'text/html': `<p>${'h'.repeat(5000)}</p>`,
        'application/json': { a: 'j'.repeat(5000) }
      };
      const result = { success: true, outputs: [{ data }] };
      expect(boundResult(result, 100000)).toEqual(result);
    });

    it('keeps short rich data that has a text/plain alternative', () => {
      const data = {
        'text/plain': '   a\n0  1',
        'text/html': '<table><tr><td>1</td></tr></table>',
        'application/vnd.jupyter.widget-view+json': { model_id: 'm' },
        'image/png': png
      };
      const bounded = boundResult(
        { success: true, outputs: [{ output_type: 'execute_result', data }] },
        100000
      ) as any;
      expect(bounded.outputs[0].data).toEqual({
        ...data,
        'image/png': `[omitted image/png data, ${size(png)} characters; see text/plain]`
      });
    });

    it('replaces rich data longer than RICH_LIMIT that has a text/plain alternative', () => {
      const atLimit = 'h'.repeat(Bounds.RICH_LIMIT - 2);
      const aboveLimit = 'h'.repeat(Bounds.RICH_LIMIT - 1);
      const json = { rows: 'j'.repeat(Bounds.RICH_LIMIT) };
      const plain = 'p'.repeat(5000);
      const bounded = boundResult(
        {
          success: true,
          outputs: [
            { data: { 'text/plain': 'a', 'text/html': atLimit } },
            {
              data: {
                'text/plain': plain,
                'text/html': aboveLimit,
                'application/json': json
              }
            }
          ]
        },
        100000
      ) as any;
      expect(size(atLimit)).toBe(Bounds.RICH_LIMIT);
      expect(bounded.outputs[0].data['text/html']).toBe(atLimit);
      expect(bounded.outputs[1].data).toEqual({
        'text/plain': plain,
        'text/html': `[omitted text/html data, ${Bounds.RICH_LIMIT + 1} characters; see text/plain]`,
        'application/json': `[omitted application/json data, ${size(json)} characters; see text/plain]`
      });
    });

    it('finds MIME bundles at any depth', () => {
      const bounded = boundResult(
        {
          success: true,
          content: {
            cells: [
              {
                cell_type: 'markdown',
                attachments: { 'plot.png': { 'image/png': png } }
              }
            ]
          }
        },
        100000
      ) as any;
      expect(bounded.content.cells[0].attachments['plot.png']).toEqual({
        'image/png': `[omitted image/png data, ${size(png)} characters]`
      });
    });

    it('only treats known MIME type prefixes as MIME bundles', () => {
      const result = {
        success: true,
        files: { 'data/log.txt': '\u001b[31mred', 'src/plot.py': png },
        fonts: { 'font/woff2': png, 'model/gltf+json': '\u001b[31mred' }
      };
      const bounded = boundResult(result, 100000) as any;
      expect(bounded.files).toEqual(result.files);
      expect(bounded.fonts).toEqual({
        'font/woff2': png,
        'model/gltf+json': 'red'
      });
    });

    it('ignores objects whose keys are not all MIME types', () => {
      const result = {
        success: true,
        files: { 'image/png': png, name: 'plot.png' }
      };
      expect(boundResult(result, 100000)).toEqual(result);
    });

    it('keeps output metadata keyed by MIME type', () => {
      const metadata = {
        'image/png': { width: 640, height: 480 },
        'application/json': { expanded: true }
      };
      const result = {
        success: true,
        outputs: [
          {
            output_type: 'display_data',
            data: { 'text/plain': 'x', 'image/png': png },
            metadata
          }
        ],
        metadata: { 'image/png': png }
      };
      const bounded = boundResult(result, 100000) as any;
      expect(bounded.outputs[0].metadata).toEqual(metadata);
      expect(bounded.outputs[0].data['image/png']).toMatch(/^\[omitted /);
      expect(bounded.metadata).toEqual(result.metadata);
    });
  });

  describe('escape codes', () => {
    const red = '\u001b[0;31mNameError\u001b[0m: x';

    it('strips them in outputs, tracebacks and MIME bundles', () => {
      const bounded = boundResult(
        {
          success: false,
          traceback: [red, '\u001b[1;32mline\u001b[39m'],
          outputs: [
            { output_type: 'stream', text: '\u001b[1mbold\u001b[22m' },
            { output_type: 'error', traceback: [red] }
          ],
          data: { 'text/plain': '\u001b[32mgreen\u001b[0m' },
          content: { cells: [{ outputs: [{ text: '\u001b[31mred' }] }] }
        },
        100000
      ) as any;
      expect(bounded.traceback).toEqual(['NameError: x', 'line']);
      expect(bounded.outputs[0].text).toBe('bold');
      expect(bounded.outputs[1].traceback).toEqual(['NameError: x']);
      expect(bounded.data['text/plain']).toBe('green');
      expect(bounded.content.cells[0].outputs[0].text).toBe('red');
    });

    it('keeps them elsewhere', () => {
      const result = {
        success: false,
        error: red,
        source: 'print("\\u001b[31m")',
        content: red,
        cells: [{ source: red }]
      };
      expect(boundResult(result, 100000)).toEqual(result);
    });
  });

  describe('cutting', () => {
    const message =
      'Some values were shortened to fit the result size limit (see "truncation"). To see more, read smaller parts (for example one cell) or print less output, and never write back shortened text.';

    /**
     * The expected bounded result.
     */
    const shortened = (value: JSONObject, truncation: JSONObject[]) => ({
      ...value,
      truncated: true,
      truncationNote: message,
      truncation
    });

    const range = (length: number) =>
      Array.from({ length }, (item, index) => `item-${index}`);

    it('first keeps a quarter of the limit at each end of the outputs', () => {
      const result = { success: true, outputs: [{ text: 'o'.repeat(89000) }] };
      expect(boundResult(result, 40000)).toEqual(
        shortened(
          {
            ...result,
            outputs: [
              { text: cut('o'.repeat(10000), 69000, 'o'.repeat(10000)) }
            ]
          },
          [{ path: 'outputs[0].text', omittedCharacters: 69000 }]
        )
      );
    });

    it('cuts outputs and tracebacks first, keeping 1000 characters at each end', () => {
      const text = 'H'.repeat(1000) + 'M'.repeat(3000) + 'T'.repeat(1000);
      const traceback = 'h'.repeat(1000) + 'm'.repeat(2500) + 't'.repeat(1000);
      const result = {
        success: true,
        source: 's'.repeat(3100),
        outputs: [{ output_type: 'stream', name: 'stdout', text }],
        traceback: [traceback]
      };
      const step1 = shortened(
        {
          ...result,
          outputs: [
            {
              output_type: 'stream',
              name: 'stdout',
              text: cut('H'.repeat(1000), 3000, 'T'.repeat(1000))
            }
          ],
          traceback: [cut('h'.repeat(1000), 2500, 't'.repeat(1000))]
        },
        [
          { path: 'outputs[0].text', omittedCharacters: 3000 },
          { path: 'traceback[0]', omittedCharacters: 2500 }
        ]
      );
      expect(boundResult(result, size(step1))).toEqual(step1);
      // The next step cuts every string, from the original text.
      expect(boundResult(result, size(step1) - 1)).toEqual(
        shortened(
          {
            ...result,
            source: cut('s'.repeat(500), 2100, 's'.repeat(500)),
            outputs: [
              {
                output_type: 'stream',
                name: 'stdout',
                text: cut('H'.repeat(500), 4000, 'T'.repeat(500))
              }
            ],
            traceback: [cut('h'.repeat(500), 3500, 't'.repeat(500))]
          },
          [
            { path: 'source', omittedCharacters: 2100 },
            { path: 'outputs[0].text', omittedCharacters: 4000 },
            { path: 'traceback[0]', omittedCharacters: 3500 }
          ]
        )
      );
    });

    it('does not cut strings of up to 2 * keep + 40 characters', () => {
      // The source keeps the first step, which cuts no output, from fitting.
      const result = {
        success: true,
        source: 's'.repeat(6000),
        outputs: [{ text: 'o'.repeat(2040) }, { text: 'p'.repeat(3000) }]
      };
      expect(boundResult(result, size(result) - 1)).toEqual(
        shortened(
          {
            ...result,
            outputs: [
              { text: 'o'.repeat(2040) },
              { text: cut('p'.repeat(1000), 1000, 'p'.repeat(1000)) }
            ]
          },
          [{ path: 'outputs[1].text', omittedCharacters: 1000 }]
        )
      );
    });

    it('then cuts all strings to 500 characters and arrays to 50 items', () => {
      const result = {
        success: false,
        content: 'c'.repeat(3000),
        items: range(60),
        traceback: range(60)
      };
      const expected = shortened(
        {
          ...result,
          content: cut('c'.repeat(500), 2000, 'c'.repeat(500)),
          items: range(50),
          traceback: range(60).slice(10)
        },
        [
          { path: 'content', omittedCharacters: 2000 },
          { path: 'items', omittedItems: 10 },
          { path: 'traceback', omittedItems: 10 }
        ]
      );
      expect(boundResult(result, size(expected))).toEqual(expected);
    });

    it('then cuts all strings to 150 characters and arrays to 10 items', () => {
      const result = {
        success: true,
        items: range(50),
        content: 'c'.repeat(1000)
      };
      const expected = shortened(
        {
          ...result,
          items: range(10),
          content: cut('c'.repeat(150), 700, 'c'.repeat(150))
        },
        [
          { path: 'items', omittedItems: 40 },
          { path: 'content', omittedCharacters: 700 }
        ]
      );
      expect(boundResult(result, size(expected))).toEqual(expected);
    });

    it('reports nested paths', () => {
      const result: JSONObject = {
        success: true,
        content: {
          cells: [
            { source: 'a' },
            { outputs: [{ data: { 'text/plain': 'z'.repeat(1500) } }] }
          ]
        },
        rows: [Array.from({ length: 600 }, (item, index) => index)]
      };
      const expected = shortened(
        {
          success: true,
          content: {
            cells: [
              { source: 'a' },
              {
                outputs: [
                  {
                    data: {
                      'text/plain': cut('z'.repeat(500), 500, 'z'.repeat(500))
                    }
                  }
                ]
              }
            ]
          },
          rows: [Array.from({ length: 50 }, (item, index) => index)]
        },
        [
          {
            path: 'content.cells[1].outputs[0].data.text/plain',
            omittedCharacters: 500
          },
          { path: 'rows[0]', omittedItems: 550 }
        ]
      );
      expect(boundResult(result, size(expected))).toEqual(expected);
    });

    it('keeps at most REPORT_LIMIT entries in the report and counts them all', () => {
      const outputs = Array.from({ length: Bounds.REPORT_LIMIT + 5 }, () => ({
        text: 'o'.repeat(3000)
      }));
      const bounded = boundResult({ success: true, outputs }, 60000) as any;
      expect(bounded.truncated).toBe(true);
      expect(bounded.truncation).toHaveLength(Bounds.REPORT_LIMIT);
      expect(bounded.truncationCount).toBe(Bounds.REPORT_LIMIT + 5);
      expect(bounded.outputs[Bounds.REPORT_LIMIT + 4].text).toBe(
        cut('o'.repeat(1000), 1000, 'o'.repeat(1000))
      );
      expect(size(bounded)).toBeLessThanOrEqual(60000);

      const complete = boundResult(
        { success: true, outputs: outputs.slice(0, Bounds.REPORT_LIMIT) },
        50000
      );
      expect(complete.truncation).toHaveLength(Bounds.REPORT_LIMIT);
      expect(complete).not.toHaveProperty('truncationCount');
    });

    it('fits the result within the limit after each step', () => {
      const result = {
        success: true,
        content: 'c'.repeat(10000),
        items: range(500),
        outputs: [{ text: 'o'.repeat(5000) }]
      };
      for (const limit of [20000, 12000, 8000, 6000, 3000, 2000, 1000]) {
        expect([limit, size(boundResult(result, limit)) <= limit]).toEqual([
          limit,
          true
        ]);
      }
    });

    it('cuts a value once, from the original text', () => {
      const result = {
        success: true,
        outputs: [{ text: 'o'.repeat(5000) }],
        content: 'c'.repeat(3000)
      };
      const expected = shortened(
        {
          ...result,
          outputs: [{ text: cut('o'.repeat(500), 4000, 'o'.repeat(500)) }],
          content: cut('c'.repeat(500), 2000, 'c'.repeat(500))
        },
        [
          { path: 'outputs[0].text', omittedCharacters: 4000 },
          { path: 'content', omittedCharacters: 2000 }
        ]
      );
      expect(boundResult(result, size(expected))).toEqual(expected);
    });
  });

  describe('preview fallback', () => {
    // The cutting steps do not change these cells.
    const cells = Array.from({ length: 10 }, (item, index) => ({
      id: `cell-${index}`,
      source: 'x'.repeat(340)
    }));

    it('returns the beginning of the JSON when nothing else fits', () => {
      const result = { success: true, cells };
      const text = JSON.stringify(result);
      const bounded = boundResult(result, 2000);
      expect(bounded).toEqual({
        success: true,
        truncated: true,
        message: `The result is ${text.length} characters long, above the 2000 characters limit. "preview" is the beginning of its JSON, with long values shortened.`,
        preview: expect.any(String)
      });
      expect(text.startsWith(bounded.preview as string)).toBe(true);
      expect((bounded.preview as string).length).toBeGreaterThan(1500);
      expect(size(bounded)).toBeLessThanOrEqual(2000);
    });

    it('reports the length of the original result', () => {
      const result = { success: true, cells, content: 'c'.repeat(100000) };
      const bounded = boundResult(result, 2000);
      expect(bounded.message).toContain(`The result is ${size(result)} `);
      expect(bounded.preview).toContain(
        JSON.stringify({
          success: true,
          cells: [cells[0]]
        }).slice(0, 50)
      );
      expect(bounded).not.toHaveProperty('truncation');
    });

    it('keeps the status fields', () => {
      expect(
        boundResult(
          {
            success: false,
            isError: true,
            error: 'e'.repeat(1000),
            other: 'dropped',
            cells
          },
          2000
        )
      ).toEqual({
        success: false,
        isError: true,
        error: cut('e'.repeat(150), 700, 'e'.repeat(150)),
        truncated: true,
        message: expect.any(String),
        preview: expect.any(String)
      });
    });

    it('reports no success for a pending result', () => {
      const bounded = boundResult(
        { status: 'pending', pendingId: 'call-1', tool: 't', cells },
        2000
      );
      expect(bounded).toEqual({
        status: 'pending',
        pendingId: 'call-1',
        truncated: true,
        message: expect.any(String),
        preview: expect.any(String)
      });
    });

    it('fits within the limit for text that needs escaping', () => {
      const quoted = Array.from({ length: 50 }, (item, index) => ({
        id: `cell-${index}`,
        source: 'print("a")\n'.repeat(300)
      }));
      const backslashes: JSONObject = {};
      for (let index = 0; index < 100; index++) {
        backslashes[`k${index}`] = '\\'.repeat(340);
      }
      for (const limit of [1000, 2000, 5000, 20000]) {
        for (const result of [
          { success: true, cells: quoted } as JSONObject,
          { success: true, data: backslashes }
        ]) {
          expect(size(boundResult(result, limit))).toBeLessThanOrEqual(limit);
        }
      }
    });
  });

  it('never changes its input', () => {
    const result = deepFreeze({
      success: true,
      content: 'c'.repeat(10000),
      items: Array.from({ length: 500 }, (item, index) => `item-${index}`),
      outputs: [
        {
          text: '\u001b[31m' + 'o'.repeat(5000),
          data: { 'image/png': png, 'text/plain': 'x' },
          metadata: { 'image/png': { width: 1 } }
        }
      ],
      cells: Array.from({ length: 50 }, () => ({ source: 'x'.repeat(3999) }))
    });
    const copy = JSON.parse(JSON.stringify(result));
    for (const limit of [0, 1000000, 300000, 200000, 20000, 5000, 1000]) {
      boundResult(result, limit);
    }
    expect(result).toEqual(copy);
  });
});
