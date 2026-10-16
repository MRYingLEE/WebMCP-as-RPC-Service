import { expect, test } from '@jupyterlab/galata';
import {
  ALL_TOOLS,
  callTool,
  createNotebook,
  kernelStatus,
  runTool,
  setSetting,
  settle,
  startKernel,
  streamText,
  waitForTools
} from '../helpers';

test.beforeEach(async ({ page }) => {
  await waitForTools(page, ALL_TOOLS);
});

test('answer_dialog should refuse a queued dialog', async ({ page }) => {
  // The user has a dialog open.
  await page.locator('.jp-WebMCPStatus').click();
  await expect(page.locator('.jp-Dialog')).toHaveCount(1);
  const [user] = (await callTool(page, 'get_context')).dialogs;
  expect(user).toMatchObject({ title: 'WebMCP Tools', shown: true });

  // About has a single Close button but no text body: it is not an error.
  const pending = await callTool(page, 'execute_command', {
    command_id: 'help:about'
  });
  expect(pending).toMatchObject({
    status: 'pending',
    dialog: { buttons: ['Close'], shown: false }
  });
  expect(pending.message).toContain(
    `queued behind the dialog that is shown (${user.id})`
  );
  const about: string = pending.dialog.id;

  expect(await callTool(page, 'answer_dialog', { button: 0 })).toMatchObject({
    success: false,
    isError: true,
    error: 'Several dialogs are open (shown or queued): pass dialogId.',
    dialogs: [
      expect.objectContaining({ id: user.id, shown: true }),
      expect.objectContaining({ id: about, shown: false })
    ]
  });
  expect(
    await callTool(page, 'answer_dialog', { button: 'Close', dialogId: about })
  ).toMatchObject({
    success: false,
    error: `The dialog "${about}" is queued behind the dialog that is shown. Only the shown dialog can be answered.`
  });
  expect(
    await callTool(page, 'answer_dialog', {
      button: 0,
      dialogId: 'dialog-unknown'
    })
  ).toMatchObject({
    success: false,
    error: 'No open dialog with id "dialog-unknown".'
  });
  await expect(page.locator('.jp-Dialog .jp-Dialog-header')).toHaveText(
    'WebMCP Tools'
  );

  // Once the user closes the dialog, About is shown and can be answered.
  await page
    .locator('.jp-Dialog')
    .getByRole('button', { name: 'Close' })
    .click();
  await expect(
    page.locator('.jp-Dialog .jp-Dialog-header', { hasText: 'WebMCP Tools' })
  ).toHaveCount(0);
  const shown = await callTool(page, 'wait_for_result', {
    pendingId: pending.pendingId
  });
  expect(shown).toMatchObject({
    status: 'pending',
    dialog: { id: about, shown: true }
  });
  expect(shown.message).toMatch(/answer_dialog/);
  const answered = await callTool(page, 'answer_dialog', { button: 'close' });
  expect(answered).toMatchObject({
    success: true,
    answered: { dialogId: about, button: 'Close' }
  });
  await expect(page.locator('.jp-Dialog')).toHaveCount(0);
});

test('should not attribute the dialogs of the user to a pending call', async ({
  page
}) => {
  const kernelId = await startKernel(page);
  await setSetting(page, 'executionTimeout', 2);
  const running = await callTool(page, 'run_code', {
    kernelId,
    code: 'import time\ntime.sleep(6)\nprint("done")'
  });
  expect(running).toMatchObject({ status: 'pending' });

  // A dialog opened while no tool waits for the call is not the call's.
  await page.locator('.jp-WebMCPStatus').click();
  await expect(page.locator('.jp-Dialog')).toHaveCount(1);
  const waited = await callTool(page, 'wait_for_result', {
    pendingId: running.pendingId
  });
  expect(waited).toMatchObject({
    status: 'pending',
    pendingId: running.pendingId,
    dialogs: [expect.objectContaining({ title: 'WebMCP Tools' })]
  });
  expect(waited).not.toHaveProperty('dialog');

  const done = await settle(page, waited);
  expect(done).toMatchObject({ success: true, status: 'ok' });
  expect(streamText(done)).toBe('done\n');
  // The dialog of the user stays open.
  await expect(page.locator('.jp-Dialog')).toHaveCount(1);
  await page
    .locator('.jp-Dialog')
    .getByRole('button', { name: 'Close' })
    .click();
  await expect(page.locator('.jp-Dialog')).toHaveCount(0);

  // The stored result does not keep the dialogs of an earlier answer.
  const { dialogs, ...rest } = done;
  expect(dialogs).toEqual([expect.objectContaining({ title: 'WebMCP Tools' })]);
  expect(
    await callTool(page, 'wait_for_result', { pendingId: running.pendingId })
  ).toEqual(rest);
});

test('get_context should report busy kernels', async ({ page }) => {
  const kernelId = await startKernel(page);
  await setSetting(page, 'executionTimeout', 1);
  const running = await callTool(page, 'run_code', {
    kernelId,
    code: 'import time\ntime.sleep(5)'
  });
  expect(running).toMatchObject({ status: 'pending' });
  // The kernel list is refreshed by get_context, not by the next poll.
  await expect
    .poll(
      async () => {
        const context = await callTool(page, 'get_context');
        return context.kernels.find(
          (item: { id: string }) => item.id === kernelId
        )?.status;
      },
      { timeout: 3000 }
    )
    .toBe('busy');
  expect(await settle(page, running)).toMatchObject({ success: true });
});

test('should report and keep the error dialog of another client', async ({
  page
}) => {
  const kernelId = await startKernel(page);
  await setSetting(page, 'executionTimeout', 3);
  const running = await callTool(page, 'run_code', {
    kernelId,
    code: 'import time\ntime.sleep(10)\nprint("done")'
  });
  expect(running).toMatchObject({ status: 'pending' });

  // Another client of the page fails while the agent waits for the call.
  const [waited] = await Promise.all([
    callTool(page, 'wait_for_result', { pendingId: running.pendingId }),
    page.evaluate(async () => {
      await new Promise(resolve => setTimeout(resolve, 500));
      // The command never settles: do not wait for it.
      void (window as any).jupyterapp.commands
        .execute('jupyterlab-ai-commands:get-notebook-content', {
          notebookPath: 'missing.ipynb'
        })
        .catch(() => undefined);
    })
  ]);
  expect(waited).toMatchObject({
    status: 'pending',
    pendingId: running.pendingId,
    dialog: { title: 'File Load Error for missing.ipynb', shown: true }
  });
  expect(waited.message).toMatch(/probably failed/);
  await expect(page.locator('.jp-Dialog')).toHaveCount(1);

  // The error dialog is reported once: the next wait gets the result of the
  // call, and the dialog stays open.
  await setSetting(page, 'executionTimeout', 60);
  const done = await callTool(page, 'wait_for_result', {
    pendingId: running.pendingId
  });
  expect(done).toMatchObject({
    success: true,
    status: 'ok',
    dialogs: [expect.objectContaining({ id: waited.dialog.id })]
  });
  expect(streamText(done)).toBe('done\n');
  await expect(page.locator('.jp-Dialog')).toHaveCount(1);
  await page
    .locator('.jp-Dialog')
    .getByRole('button', { name: 'Close' })
    .click();
  await expect(page.locator('.jp-Dialog')).toHaveCount(0);
});

test.describe('kernel actions', () => {
  /**
   * Galata's kernel mock breaks the interrupt (it parses the empty 204
   * response as JSON) and the restart (it answers 201 instead of 200)
   * requests; the session mock still shuts the kernels down.
   */
  test.use({ kernels: null });

  test('should answer the dialog of a kernel restart', async ({ page }) => {
    const { path, widgetId, kernelId } = await createNotebook(
      page,
      'webmcp-restart'
    );
    try {
      await runTool(page, 'run_code', { kernelId, code: 'before = 1' });

      const pending = await callTool(page, 'execute_command', {
        command_id: 'notebook:restart-kernel',
        args: { semanticWidget: widgetId, activate: false }
      });
      expect(pending).toMatchObject({
        status: 'pending',
        tool: 'execute_command',
        dialog: {
          title: 'Restart Kernel?',
          buttons: ['Cancel', 'Restart'],
          shown: true
        }
      });
      expect(pending).not.toHaveProperty('success');
      expect(pending).not.toHaveProperty('isError');
      await expect(page.locator('.jp-Dialog')).toHaveCount(1);

      const context = await callTool(page, 'get_context');
      expect(context.dialogs).toEqual([
        expect.objectContaining({ id: pending.dialog.id })
      ]);
      expect(context.pending).toEqual([
        expect.objectContaining({
          pendingId: pending.pendingId,
          tool: 'execute_command',
          command: 'notebook:restart-kernel'
        })
      ]);

      // Waiting for a call blocked on a dialog reports the dialog again.
      expect(
        await callTool(page, 'wait_for_result', {
          pendingId: pending.pendingId
        })
      ).toMatchObject({
        status: 'pending',
        pendingId: pending.pendingId,
        dialog: { id: pending.dialog.id }
      });

      const wrong = await callTool(page, 'answer_dialog', { button: 7 });
      expect(wrong).toMatchObject({ success: false, isError: true });
      expect(wrong.error).toMatch(/^No button 7 in the dialog\./);
      await expect(page.locator('.jp-Dialog')).toHaveCount(1);

      // answer_dialog returns the result of the call that opened the dialog.
      const answered = await callTool(page, 'answer_dialog', {
        button: 'restart'
      });
      expect(answered.answered).toEqual({
        dialogId: pending.dialog.id,
        button: 'Restart'
      });
      expect(await settle(page, answered)).toMatchObject({
        success: true,
        result: true
      });
      await expect(page.locator('.jp-Dialog')).toHaveCount(0);
      expect((await callTool(page, 'get_context')).pending).toEqual([]);

      const after = await runTool(page, 'run_code', {
        kernelId,
        code: "print('before' in globals())"
      });
      expect(streamText(after)).toBe('False\n');

      expect(await callTool(page, 'answer_dialog', { button: 0 })).toEqual({
        success: false,
        isError: true,
        error: 'No dialog is open.',
        dialogs: []
      });

      expect(await runTool(page, 'restart_kernel', { kernelId })).toEqual({
        success: true,
        kernelId,
        message: 'The kernel was restarted.'
      });
      await expect(page.locator('.jp-Dialog')).toHaveCount(0);
    } finally {
      await page.contents.deleteFile(path);
    }
  });

  test('should report long runs as pending', async ({ page }) => {
    const { path, kernelId } = await createNotebook(page, 'webmcp-pending');
    try {
      await setSetting(page, 'executionTimeout', 1);

      const pending = await callTool(page, 'run_code', {
        kernelId,
        code: 'import time\ntime.sleep(3)\nprint("done")'
      });
      expect(pending).toMatchObject({ status: 'pending', tool: 'run_code' });
      expect(pending).not.toHaveProperty('success');
      expect(pending.message).toMatch(/wait_for_result/);

      const context = await callTool(page, 'get_context');
      expect(context.pending).toContainEqual(
        expect.objectContaining({
          pendingId: pending.pendingId,
          tool: 'run_code'
        })
      );

      const done = await settle(page, pending);
      expect(done).toMatchObject({ success: true, status: 'ok' });
      expect(streamText(done)).toBe('done\n');
      // A settled call stays available.
      expect(
        await callTool(page, 'wait_for_result', {
          pendingId: pending.pendingId
        })
      ).toEqual(done);

      const unknown = await callTool(page, 'wait_for_result', {
        pendingId: 'call-unknown'
      });
      expect(unknown).toEqual({
        success: false,
        isError: true,
        error: 'Unknown or expired pendingId "call-unknown".'
      });
    } finally {
      await page.contents.deleteFile(path);
    }
  });

  test('interrupt_kernel should stop a running cell', async ({ page }) => {
    const { path, kernelId } = await createNotebook(page, 'webmcp-interrupt');
    try {
      await setSetting(page, 'executionTimeout', 1);
      const added = await runTool(page, 'add_cell', {
        notebookPath: path,
        content: 'import time\ntime.sleep(60)'
      });
      const running = await callTool(page, 'run_cell', {
        notebookPath: path,
        cellId: added.cellId
      });
      expect(running).toMatchObject({ status: 'pending', tool: 'run_cell' });
      // An interrupt is lost if it reaches the kernel before the cell runs.
      await expect.poll(() => kernelStatus(page, path)).toBe('busy');

      // The kernel stops: no warning.
      expect(await runTool(page, 'interrupt_kernel', { kernelId })).toEqual({
        success: true,
        kernelId,
        message: 'The kernel was interrupted.'
      });
      const stopped = await settle(page, running);
      expect(stopped).toMatchObject({
        success: false,
        isError: true,
        status: 'error'
      });
      expect(stopped.error).toMatch(/^KeyboardInterrupt/);
    } finally {
      await page.contents.deleteFile(path);
    }
  });

  test('restart_kernel should report a failed restart', async ({ page }) => {
    const { path, kernelId } = await createNotebook(page, 'webmcp-broken');
    try {
      await page.route(/\/api\/kernels\/[^/]+\/restart/, route =>
        route.fulfill({ status: 500, body: 'broken' })
      );
      expect(await runTool(page, 'restart_kernel', { kernelId })).toEqual({
        success: false,
        isError: true,
        kernelId,
        error: 'The kernel could not be restarted.'
      });
    } finally {
      await page.unroute(/\/api\/kernels\/[^/]+\/restart/);
      await page.contents.deleteFile(path);
    }
  });

  test('restart_kernel should report a restart in progress', async ({
    page
  }) => {
    const { path, kernelId } = await createNotebook(page, 'webmcp-twice');
    try {
      await page.route(/\/api\/kernels\/[^/]+\/restart/, async route => {
        await new Promise(resolve => setTimeout(resolve, 3000));
        await route.continue();
      });
      const first = callTool(page, 'restart_kernel', { kernelId });
      await expect.poll(() => kernelStatus(page, path)).toBe('restarting');
      expect(await callTool(page, 'restart_kernel', { kernelId })).toEqual({
        success: false,
        isError: true,
        kernelId,
        error: 'A restart of this kernel is already in progress.'
      });
      expect(await settle(page, await first)).toMatchObject({
        success: true,
        kernelId,
        message: 'The kernel was restarted.'
      });
    } finally {
      await page.unroute(/\/api\/kernels\/[^/]+\/restart/);
      await page.contents.deleteFile(path);
    }
  });
});
