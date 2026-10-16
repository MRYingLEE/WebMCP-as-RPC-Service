/**
 * Tests of the lab UI of JupyterLite, which shows all the documents in one
 * page like JupyterLab.
 */
import { expect, test } from '@playwright/test';
import {
  ALL_TOOLS,
  type ToolResult,
  callTool,
  kernelStatus,
  runTool,
  streamText,
  waitForTools
} from '../helpers';

/**
 * A notebook of the site. Each test has a new browser storage with it.
 */
const PATH = 'webmcp.ipynb';

test('the lab UI should edit and run a notebook in the page', async ({
  page
}) => {
  await page.goto('/lab/index.html');
  await waitForTools(page, ALL_TOOLS, 60000);

  const context = await callTool(page, 'get_context');
  expect(context).toMatchObject({
    success: true,
    app: { name: 'JupyterLite' },
    fileBrowserPath: '',
    dialogs: [],
    pending: []
  });
  // The lab UI opens documents in the page: there is no note about tabs.
  expect(context).not.toHaveProperty('note');

  // The notebook opens in the background, in the same page.
  const added = await runTool(page, 'add_cell', {
    notebookPath: PATH,
    content: 'print(6 * 7)'
  });
  expect(added).toMatchObject({ success: true, cellType: 'code' });
  // Pyodide is downloaded before the kernel is ready.
  await expect
    .poll(() => kernelStatus(page, PATH), { timeout: 180000 })
    .toBe('idle');
  const run = await runTool(page, 'run_cell', {
    notebookPath: PATH,
    cellId: added.cellId
  });
  expect(run).toMatchObject({
    success: true,
    status: 'ok',
    cellId: added.cellId
  });
  expect(streamText(run)).toBe('42\n');

  const { widgets } = await callTool(page, 'get_context');
  expect(
    widgets.find((widget: ToolResult) => widget.path === PATH)
  ).toMatchObject({
    type: 'NotebookPanel',
    id: expect.stringMatching(/./),
    kernel: { name: 'python', status: 'idle' }
  });
});
