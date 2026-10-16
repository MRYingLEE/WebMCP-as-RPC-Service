import { expect, test } from '@jupyterlab/galata';
import { ALL_TOOLS, PLUGIN_ID, callTool, waitForTools } from '../helpers';

test.beforeEach(async ({ page }) => {
  await waitForTools(page, ALL_TOOLS);
});

test('the status bar item should list the tools', async ({ page }) => {
  const status = page.locator('.jp-WebMCPStatus');
  await expect(status).toHaveText(`WebMCP: ${ALL_TOOLS.length} tools`);
  await expect(status).toHaveAttribute('role', 'button');
  await expect(status).not.toHaveClass(/jp-mod-unavailable/);

  await status.click();
  const dialog = page.locator('.jp-Dialog');
  await expect(dialog.locator('.jp-Dialog-header')).toHaveText('WebMCP Tools');
  const items = dialog.locator('.jp-WebMCPToolList-item');
  await expect(items).toHaveCount(ALL_TOOLS.length);
  await expect(items.filter({ hasText: 'run_cell' })).toHaveText(
    'run_cell jupyterlab-ai-commands:run-cell'
  );
  await expect(items.filter({ hasText: 'get_context' })).toHaveText(
    'get_context'
  );
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);

  // The item works with the keyboard.
  await status.focus();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('other extensions should register tools with the registry', async ({
  page
}) => {
  const status = page.locator('.jp-WebMCPStatus');
  const registered = await page.evaluate(async id => {
    const registry = await (window as any).galata.getPlugin(id);
    const tool = {
      name: 'echo',
      description: 'Return the text.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } }
      },
      execute: (input: { text?: string }) => ({ echoed: input.text })
    };
    (window as any).echoTool = await registry.registerTool(tool);
    let duplicate = '';
    try {
      await registry.registerTool(tool);
    } catch (error) {
      duplicate = (error as Error).message;
    }
    return {
      isAvailable: registry.isAvailable,
      toolNames: registry.toolNames,
      duplicate
    };
  }, PLUGIN_ID);
  expect(registered).toEqual({
    isAvailable: true,
    toolNames: [...ALL_TOOLS, 'echo'].sort(),
    duplicate: 'A WebMCP tool named "echo" is already registered.'
  });
  await waitForTools(page, [...ALL_TOOLS, 'echo']);
  await expect(status).toHaveText(`WebMCP: ${ALL_TOOLS.length + 1} tools`);
  expect(await callTool(page, 'echo', { text: 'hello' })).toEqual({
    echoed: 'hello'
  });

  // Disposing the registration removes the tool.
  await page.evaluate(() => (window as any).echoTool.dispose());
  await waitForTools(page, ALL_TOOLS);
  await expect(status).toHaveText(`WebMCP: ${ALL_TOOLS.length} tools`);
});
