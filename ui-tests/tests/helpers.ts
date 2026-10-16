import { expect, type Page } from '@playwright/test';

/**
 * A page with WebMCP tools: a Playwright page or a Galata page fixture.
 */
export type WebMCPPage = Pick<Page, 'webmcp'>;

/**
 * A tool result. The tools return JSON objects and report errors as data.
 */
export type ToolResult = Record<string, any>;

/**
 * The id of the main plugin and of its settings.
 */
export const PLUGIN_ID = 'jupyter-webmcp:plugin';

/**
 * The tools that the extension always registers.
 */
export const BUILTIN_TOOLS = [
  'answer_dialog',
  'execute_command',
  'get_context',
  'list_all_commands',
  'wait_for_result'
];

/**
 * The default tools, backed by jupyterlab-ai-commands and by the kernel
 * commands of the extension.
 */
export const DEFAULT_TOOLS = [
  'add_cell',
  'create_file',
  'create_notebook',
  'delete_cell',
  'edit_cell',
  'interrupt_kernel',
  'list_directory',
  'open_document',
  'read_cell',
  'read_file',
  'read_notebook',
  'restart_kernel',
  'run_cell',
  'run_code',
  'save_notebook',
  'write_file'
];

export const ALL_TOOLS = [...BUILTIN_TOOLS, ...DEFAULT_TOOLS].sort();

/**
 * The note of `get_context` on a page that shows one document.
 */
export const SINGLE_DOCUMENT_NOTE =
  'This page shows one document. Other documents open in their own browser tab, with their own tools.';

/**
 * The names of the tools registered on the page, sorted.
 */
export async function toolNames(page: WebMCPPage): Promise<string[]> {
  return (await page.webmcp.tools()).map(tool => tool.name).sort();
}

/**
 * Wait until the page registers exactly the given tools.
 */
export async function waitForTools(
  page: WebMCPPage,
  names: string[],
  timeout = 30000
): Promise<void> {
  await expect
    .poll(() => toolNames(page), { timeout })
    .toEqual([...names].sort());
}

/**
 * Call a tool of the page like an agent does.
 */
export async function callTool(
  page: WebMCPPage,
  name: string,
  input: Record<string, unknown> = {}
): Promise<ToolResult> {
  return (await page.webmcp.callTool(name, input)) as ToolResult;
}

/**
 * Call `wait_for_result` until a pending result is final. A call waiting
 * for a dialog is returned as is.
 */
export async function settle(
  page: WebMCPPage,
  result: ToolResult
): Promise<ToolResult> {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (result.status !== 'pending' || result.dialog) {
      return result;
    }
    result = await callTool(page, 'wait_for_result', {
      pendingId: result.pendingId,
      timeout: 10
    });
  }
  return result;
}

/**
 * Call a tool and wait for its final result.
 */
export async function runTool(
  page: WebMCPPage,
  name: string,
  input: Record<string, unknown> = {}
): Promise<ToolResult> {
  return settle(page, await callTool(page, name, input));
}

/**
 * The status of the kernel of the open document at `path`.
 */
export async function kernelStatus(
  page: WebMCPPage,
  path: string
): Promise<string | undefined> {
  const context = await callTool(page, 'get_context');
  return context.widgets.find((item: ToolResult) => item.path === path)?.kernel
    ?.status;
}

/**
 * The text of the stream outputs of a result.
 */
export function streamText(result: ToolResult): string {
  return (result.outputs ?? [])
    .filter((output: ToolResult) => output.output_type === 'stream')
    .map((output: ToolResult) =>
      Array.isArray(output.text) ? output.text.join('') : output.text
    )
    .join('');
}

/**
 * A file name that no other test uses.
 */
export function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

/**
 * Create a notebook with create_notebook and wait for its kernel to be
 * idle. Needs a page that opens documents in place (JupyterLab).
 */
export async function createNotebook(
  page: WebMCPPage,
  prefix: string
): Promise<{ path: string; widgetId: string; kernelId: string }> {
  const created = await runTool(page, 'create_notebook', {
    name: uniqueName(prefix)
  });
  expect(created).toMatchObject({ success: true });
  const path: string = created.notebookPath;
  await expect
    .poll(() => kernelStatus(page, path), { timeout: 60000 })
    .toBe('idle');
  const context = await callTool(page, 'get_context');
  const widget = context.widgets.find((item: ToolResult) => item.path === path);
  return { path, widgetId: widget.id, kernelId: widget.kernel.id };
}

/**
 * Start a kernel that no document uses.
 *
 * @returns the kernel id.
 */
export async function startKernel(page: WebMCPPage): Promise<string> {
  const started = await runTool(page, 'execute_command', {
    command_id: 'jupyterlab-ai-commands:start-kernel'
  });
  expect(started).toMatchObject({ success: true });
  return started.kernelId;
}

/**
 * Change a setting of the extension (JupyterLab with Galata).
 */
export async function setSetting(
  page: Pick<Page, 'evaluate'>,
  key: string,
  value: unknown
): Promise<void> {
  await page.evaluate(
    async ({ id, key, value }) => {
      const registry = await (window as any).galata.getPlugin(
        '@jupyterlab/apputils-extension:settings'
      );
      await registry.set(id, key, value);
    },
    { id: PLUGIN_ID, key, value }
  );
}
