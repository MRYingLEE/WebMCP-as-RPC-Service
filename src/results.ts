import { MainAreaWidget } from '@jupyterlab/apputils';
import { DocumentWidget } from '@jupyterlab/docregistry';
import { NotebookPanel } from '@jupyterlab/notebook';
import { JSONArray, JSONObject, JSONValue } from '@lumino/coreutils';
import { Widget } from '@lumino/widgets';
import { safely } from './utils';

/**
 * A readable type for a widget, taken from its CSS class (for example
 * `jp-NotebookPanel`) since constructor names are minified in production
 * builds. Generic wrappers report the class of their content.
 */
export function widgetType(widget: Widget): string {
  const specific = (node: HTMLElement) =>
    Array.from(node.classList).filter(
      name =>
        /^jp-[A-Z]/.test(name) &&
        !Private.GENERIC_CLASSES.some(generic => name.startsWith(generic))
    );
  let classes = specific(widget.node);
  // A main area widget whose content failed to load has no content.
  if (
    classes.length === 0 &&
    widget instanceof MainAreaWidget &&
    widget.content
  ) {
    classes = specific(widget.content.node);
  }
  return classes.pop()?.slice('jp-'.length) ?? 'Widget';
}

/**
 * Describe a widget with a few JSON-serializable fields.
 *
 * Jupyter Notebook opens documents in a new browser tab and disposes the
 * widget of the current page, which is then reported as disposed.
 */
export function describeWidget(widget: Widget): JSONObject {
  const info: JSONObject = { type: widgetType(widget) };
  if (widget.isDisposed) {
    info.disposed = true;
    return info;
  }
  if (widget.id) {
    info.id = widget.id;
  }
  info.title = widget.title.label;
  if (widget instanceof DocumentWidget) {
    info.path = widget.context.path;
    info.dirty = widget.context.model.dirty;
  }
  const session = (widget as Partial<Pick<NotebookPanel, 'sessionContext'>>)
    .sessionContext;
  const kernel = session?.session?.kernel;
  if (session && kernel) {
    info.kernel = {
      id: kernel.id,
      name: kernel.name,
      status: session.kernelDisplayStatus
    };
  }
  if (widget instanceof NotebookPanel) {
    const notebook = widget.content;
    info.notebook = {
      cellCount: notebook.widgets.length,
      activeCellIndex: notebook.activeCellIndex,
      activeCellId: notebook.activeCell?.model.id ?? null,
      activeCellType: notebook.activeCell?.model.type ?? null
    };
  }
  return info;
}

/**
 * Convert a value into JSON: widgets (also nested ones) become a
 * descriptor, other values go through a JSON round trip with a string
 * fallback.
 */
export function toJSON(value: unknown): JSONValue {
  if (value instanceof Widget) {
    return describeWidget(value);
  }
  if (value === undefined) {
    return null;
  }
  try {
    const text = JSON.stringify(value, (key, item) =>
      item instanceof Widget ? describeWidget(item) : item
    );
    return text === undefined ? null : (JSON.parse(text) as JSONValue);
  } catch {
    return safely(() => String(value), '[value that cannot be serialized]');
  }
}

/**
 * Convert a command result into a tool result.
 *
 * Results that already report a boolean `success` (the convention of
 * jupyterlab-ai-commands) are returned flat; other values are wrapped as
 * `{success: true, result}`.
 */
export function toToolResult(value: unknown): JSONObject {
  const json = toJSON(value);
  if (
    json !== null &&
    typeof json === 'object' &&
    !Array.isArray(json) &&
    typeof json.success === 'boolean'
  ) {
    if (json.success === false && json.error === undefined) {
      const reason = json.errorName
        ? [json.errorName, json.errorValue].filter(Boolean).join(': ')
        : json.message;
      json.error = typeof reason === 'string' ? reason : 'The command failed.';
    }
    return json;
  }
  return { success: true, result: json };
}

/**
 * Size limits applied by `boundResult`.
 */
export namespace Bounds {
  /**
   * Limits applied to the values of a result.
   */
  export interface ILimits {
    /**
     * Characters kept at each end of the strings of outputs and tracebacks.
     */
    outputs: number;
    /**
     * Characters kept at each end of the other strings.
     */
    strings: number;
    /**
     * Items kept in arrays (the last ones for tracebacks).
     */
    items: number;
  }

  /**
   * Rich MIME data longer than this is replaced by a placeholder when the
   * bundle has a `text/plain` alternative.
   */
  export const RICH_LIMIT = 2000;

  /**
   * The cutting steps, tried in order until the result fits, after a step
   * that keeps a quarter of the limit at each end of the outputs.
   */
  export const STEPS: readonly ILimits[] = [
    { outputs: 1000, strings: Infinity, items: Infinity },
    { outputs: 500, strings: 500, items: 50 },
    { outputs: 150, strings: 150, items: 10 }
  ];

  /**
   * Maximum number of entries in the `truncation` report.
   */
  export const REPORT_LIMIT = 20;
}

/**
 * Make a result fit within `maxLength` characters of JSON.
 *
 * Binary and long redundant MIME data are always replaced by a placeholder.
 * A longer result is cut step by step (see `Bounds.STEPS`), with each cut
 * reported in `truncation`; as a last resort it becomes a preview of its
 * JSON.
 */
export function boundResult(result: JSONObject, maxLength: number): JSONObject {
  const compact = Private.compactOutputs(result, false) as JSONObject;
  const length = JSON.stringify(compact).length;
  if (maxLength <= 0 || length <= maxLength) {
    return compact;
  }
  let value = compact;
  // Keep more of a long output when the limit allows it.
  const steps = [
    { outputs: Math.floor(maxLength / 4), strings: Infinity, items: Infinity },
    ...Bounds.STEPS
  ];
  for (const limits of steps) {
    // Each step cuts the compact result, so that a value is cut once.
    const report: JSONObject[] = [];
    value = Private.cut(compact, '', report, limits, false) as JSONObject;
    const bounded: JSONObject = {
      ...value,
      truncated: true,
      truncationNote:
        'Some values were shortened to fit the result size limit (see "truncation"). To see more, read smaller parts (for example one cell) or print less output, and never write back shortened text.',
      truncation: report.slice(0, Bounds.REPORT_LIMIT)
    };
    if (report.length > Bounds.REPORT_LIMIT) {
      bounded.truncationCount = report.length;
    }
    if (JSON.stringify(bounded).length <= maxLength) {
      return bounded;
    }
  }
  return Private.preview(value, length, maxLength);
}

/**
 * The namespace for module private data.
 */
namespace Private {
  /**
   * Class prefixes shared by all main area widgets, which do not tell what
   * they are.
   */
  export const GENERIC_CLASSES = [
    'jp-Activity',
    'jp-Document',
    'jp-MainAreaWidget'
  ];

  /**
   * MIME types whose data is never useful as text for an agent.
   */
  const BINARY_MIME =
    /^(image\/(?!svg)|audio\/|video\/|application\/(pdf|octet-stream))/;

  /**
   * Keys of MIME bundles.
   */
  const MIME_TYPE =
    /^(application|audio|font|image|model|text|video)\/[\w.+-]+$/i;

  /**
   * Keys that hold kernel outputs, where escape codes and long text are
   * common.
   */
  const OUTPUT_KEYS = new Set(['outputs', 'traceback']);

  /**
   * ANSI escape sequences, such as the colors of tracebacks.
   */
  // eslint-disable-next-line no-control-regex
  const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

  /**
   * Length of the marker that replaces the middle of a cut string.
   */
  const MARKER_LENGTH = 40;

  /**
   * Replace binary and long redundant MIME data, and strip escape codes
   * from outputs.
   */
  export function compactOutputs(
    value: JSONValue,
    inOutput: boolean
  ): JSONValue {
    if (typeof value === 'string') {
      return inOutput ? value.replace(ANSI, '') : value;
    }
    if (Array.isArray(value)) {
      return value.map(item => compactOutputs(item, inOutput));
    }
    if (value === null || typeof value !== 'object') {
      return value;
    }
    const keys = Object.keys(value);
    const bundle = keys.length > 0 && keys.every(key => MIME_TYPE.test(key));
    const hasText = bundle && typeof value['text/plain'] === 'string';
    const copy: JSONObject = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) {
        continue;
      }
      // Output metadata is keyed by MIME type too, but holds no data.
      if (key === 'metadata') {
        copy[key] = item;
        continue;
      }
      const size = bundle ? JSON.stringify(item).length : 0;
      if (
        bundle &&
        (BINARY_MIME.test(key) ||
          (hasText && key !== 'text/plain' && size > Bounds.RICH_LIMIT))
      ) {
        const hint = hasText ? '; see text/plain' : '';
        copy[key] = `[omitted ${key} data, ${size} characters${hint}]`;
        continue;
      }
      copy[key] = compactOutputs(
        item as JSONValue,
        inOutput || OUTPUT_KEYS.has(key) || bundle
      );
    }
    return copy;
  }

  /**
   * Cut the middle of long strings and the items of long arrays; the last
   * items of tracebacks are kept, since they hold the error.
   */
  export function cut(
    value: JSONValue,
    path: string,
    report: JSONObject[],
    limits: Bounds.ILimits,
    inOutput: boolean
  ): JSONValue {
    if (typeof value === 'string') {
      const keep = inOutput ? limits.outputs : limits.strings;
      if (value.length <= 2 * keep + MARKER_LENGTH) {
        return value;
      }
      const omitted = value.length - 2 * keep;
      report.push({ path, omittedCharacters: omitted });
      return `${value.slice(0, keep)}\n[... ${omitted} characters omitted ...]\n${value.slice(-keep)}`;
    }
    if (Array.isArray(value)) {
      const fromEnd = /traceback$/.test(path);
      const start = fromEnd ? Math.max(0, value.length - limits.items) : 0;
      const kept: JSONArray = value
        .slice(start, start + limits.items)
        .map((item, index) =>
          cut(item, `${path}[${start + index}]`, report, limits, inOutput)
        );
      if (value.length > limits.items) {
        report.push({ path, omittedItems: value.length - limits.items });
      }
      return kept;
    }
    if (value === null || typeof value !== 'object') {
      return value;
    }
    const copy: JSONObject = {};
    for (const [key, item] of Object.entries(value)) {
      copy[key] = cut(
        item as JSONValue,
        path ? `${path}.${key}` : key,
        report,
        limits,
        inOutput || OUTPUT_KEYS.has(key)
      );
    }
    return copy;
  }

  /**
   * The beginning of the JSON of a cut result, with its status fields.
   *
   * @param length - The length of the JSON of the result before the cuts.
   */
  export function preview(
    value: JSONObject,
    length: number,
    maxLength: number
  ): JSONObject {
    const result: JSONObject = {};
    for (const key of ['success', 'isError', 'status', 'pendingId', 'error']) {
      if (value[key] !== undefined) {
        result[key] = value[key];
      }
    }
    result.truncated = true;
    result.message = `The result is ${length} characters long, above the ${maxLength} characters limit. "preview" is the beginning of its JSON, with long values shortened.`;
    // Escaping can make the preview longer than the text it holds.
    const text = JSON.stringify(value);
    let low = 0;
    let high = text.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      result.preview = text.slice(0, middle);
      if (JSON.stringify(result).length <= maxLength) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    result.preview = text.slice(0, low);
    return result;
  }
}
