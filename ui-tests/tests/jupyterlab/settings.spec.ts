import { expect, galata, test } from '@jupyterlab/galata';
import {
  ALL_TOOLS,
  PLUGIN_ID,
  type ToolResult,
  callTool,
  setSetting,
  waitForTools
} from '../helpers';

/**
 * The error of a command refused by `blockedCommands`.
 */
function blocked(commandId: string): string {
  return `The command "${commandId}" is blocked by the WebMCP settings (blockedCommands).`;
}

test.describe('blockedCommands and disabledTools', () => {
  test.use({
    mockSettings: {
      ...galata.DEFAULT_SETTINGS,
      [PLUGIN_ID]: {
        blockedCommands: [
          'jupyterlab-ai-commands:run-*',
          'notebook:restart-kernel'
        ],
        disabledTools: ['list_directory']
      }
    }
  });

  test('should hide and refuse the commands', async ({ page }) => {
    const allowed = ALL_TOOLS.filter(
      name => name !== 'run_cell' && name !== 'list_directory'
    );
    await waitForTools(page, allowed);
    await expect(page.locator('.jp-WebMCPStatus')).toHaveText(
      `WebMCP: ${allowed.length} tools`
    );

    const listed = await callTool(page, 'list_all_commands', {
      query: 'jupyterlab-ai-commands',
      limit: 100
    });
    const ids = listed.commands.map((command: ToolResult) => command.id);
    expect(ids).toContain('jupyterlab-ai-commands:get-cell-info');
    expect(ids).not.toContain('jupyterlab-ai-commands:run-cell');

    // The defaults stay blocked when the user setting replaces the list.
    for (const commandId of [
      'jupyterlab-ai-commands:run-cell',
      'notebook:restart-kernel',
      'apputils:run-first-enabled'
    ]) {
      expect(
        await callTool(page, 'execute_command', { command_id: commandId })
      ).toEqual({ success: false, isError: true, error: blocked(commandId) });
    }
  });

  test('should follow the settings while the page is open', async ({
    page
  }) => {
    await waitForTools(
      page,
      ALL_TOOLS.filter(name => name !== 'run_cell' && name !== 'list_directory')
    );
    await setSetting(page, 'blockedCommands', []);
    await setSetting(page, 'disabledTools', ['get_*']);
    await waitForTools(
      page,
      ALL_TOOLS.filter(name => name !== 'get_context')
    );
    expect(
      await callTool(page, 'execute_command', {
        command_id: 'apputils:run-all-enabled'
      })
    ).toMatchObject({ error: blocked('apputils:run-all-enabled') });
  });
});

test.describe('tools setting', () => {
  test.use({
    mockSettings: {
      ...galata.DEFAULT_SETTINGS,
      [PLUGIN_ID]: {
        tools: [
          {
            command: 'jupyter-webmcp:interrupt-kernel',
            name: 'stop_kernel'
          },
          { command: 'jupyter-webmcp:restart-kernel', name: 'bad name!' },
          {
            command: 'docmanager:open',
            name: 'show_file',
            inputs: ['path'],
            required: ['path']
          },
          { command: 'docmanager:open', name: 'bad_inputs', inputs: 'path' }
        ],
        maxResultLength: 10
      }
    }
  });

  test('should add the valid tools and report the others', async ({ page }) => {
    await waitForTools(page, [...ALL_TOOLS, 'show_file', 'stop_kernel']);
    const tools = Object.fromEntries(
      (await page.webmcp.tools()).map(tool => [tool.name, tool])
    );
    expect(tools.stop_kernel).toMatchObject({
      description:
        'Interrupt the code running in a kernel. Runs the Jupyter command "jupyter-webmcp:interrupt-kernel".',
      inputSchema: { required: ['kernelId'], additionalProperties: false }
    });
    // "inputs" hides the other arguments of the command.
    expect(tools.show_file.inputSchema).toMatchObject({
      required: ['path'],
      additionalProperties: false
    });
    expect(
      Object.keys((tools.show_file.inputSchema as ToolResult).properties)
    ).toEqual(['path']);
    expect(
      await callTool(page, 'show_file', { path: 'a.txt', factory: 'Editor' })
    ).toEqual({
      success: false,
      isError: true,
      error: 'Unknown argument "factory". Accepted arguments: "path".'
    });

    await page.locator('.jp-WebMCPStatus').click();
    const dialog = page.locator('.jp-Dialog');
    await expect(dialog.locator('.jp-WebMCPToolList-warning')).toHaveText([
      'tools[1] is ignored: "name" must have 1 to 64 letters, digits, "_" or "-".',
      'tools[3] is ignored: "inputs" must be a list of argument names.'
    ]);
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toHaveCount(0);
  });

  test('should keep at least 1000 characters of a result', async ({ page }) => {
    await waitForTools(page, [...ALL_TOOLS, 'show_file', 'stop_kernel']);
    const result = await callTool(page, 'list_all_commands', { limit: 100 });
    expect(result).toMatchObject({ success: true, truncated: true });
    const length = JSON.stringify(result).length;
    expect(length).toBeLessThanOrEqual(1000);
    expect(length).toBeGreaterThan(500);
  });
});
