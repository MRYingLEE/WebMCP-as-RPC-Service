import { Dialog, showDialog, showErrorMessage } from '@jupyterlab/apputils';
import { CommandRegistry } from '@lumino/commands';
import { JSONObject, PromiseDelegate } from '@lumino/coreutils';
import { Widget } from '@lumino/widgets';
import { Dialogs } from '../dialogs';
import { CommandExecutor } from '../execution';
import { shown, sleep, waitFor } from './utils';

const never = (): Promise<never> => new Promise(() => undefined);

const DIALOG_ID = expect.stringMatching(/^dialog-\d+$/);
const CALL_ID = expect.stringMatching(/^call-\d+$/);

/**
 * Launch a dialog as a user action would, ignoring its rejection on flush.
 */
function launch(options: Partial<Dialog.IOptions<unknown>>): Dialog<unknown> {
  const dialog = new Dialog(options);
  dialog.launch().catch(() => undefined);
  return dialog;
}

/**
 * A command asking for confirmation, like a kernel restart.
 */
function confirmCommand(title = 'Restart Kernel?') {
  return async () => {
    const result = await showDialog({
      title,
      body: 'All variables will be lost.',
      buttons: [Dialog.cancelButton(), Dialog.okButton({ label: 'Restart' })]
    });
    return result.button.accept ? 'restarted' : 'cancelled';
  };
}

describe('CommandExecutor', () => {
  let commands: CommandRegistry;
  let blocked: Set<string>;
  let timeout: number;
  let executor: CommandExecutor;

  const add = (
    id: string,
    execute: CommandRegistry.CommandFunc<unknown>,
    isEnabled?: CommandRegistry.CommandFunc<boolean>
  ) => commands.addCommand(id, { execute, isEnabled });

  const run = (id: string, args: JSONObject = {}, signal?: AbortSignal) =>
    executor.execute(id, args, { tool: 'test_tool', signal });

  beforeEach(() => {
    commands = new CommandRegistry();
    blocked = new Set();
    timeout = 2000;
    executor = new CommandExecutor({
      commands,
      isBlocked: id => blocked.has(id),
      timeout: () => timeout
    });
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    executor.dispose();
    Dialog.flush();
    await sleep(0);
    jest.restoreAllMocks();
  });

  describe('#execute()', () => {
    it('refuses unknown commands', async () => {
      expect(await run('test:missing')).toEqual({
        success: false,
        error:
          'Unknown command "test:missing". Use list_all_commands to find the available commands.'
      });
      expect(executor.pendingCalls()).toEqual([]);
    });

    it('refuses blocked commands without running them', async () => {
      const execute = jest.fn(() => 'ran');
      add('test:blocked', execute);
      blocked.add('test:blocked');
      expect(await run('test:blocked')).toEqual({
        success: false,
        error:
          'The command "test:blocked" is blocked by the WebMCP settings (blockedCommands).'
      });
      expect(execute).not.toHaveBeenCalled();
    });

    it('passes the args to the command', async () => {
      const execute = jest.fn(() => 'ok');
      add('test:args', execute);
      await run('test:args', { path: 'a.ipynb', count: 2 });
      expect(execute).toHaveBeenCalledWith({ path: 'a.ipynb', count: 2 });
    });

    it('wraps plain results', async () => {
      const values: unknown[] = [42, 'text', [1, 2], { a: 1 }, undefined, null];
      add('test:value', () => values.shift());
      expect(await run('test:value')).toEqual({ success: true, result: 42 });
      expect(await run('test:value')).toEqual({
        success: true,
        result: 'text'
      });
      expect(await run('test:value')).toEqual({
        success: true,
        result: [1, 2]
      });
      expect(await run('test:value')).toEqual({
        success: true,
        result: { a: 1 }
      });
      expect(await run('test:value')).toEqual({ success: true, result: null });
      expect(await run('test:value')).toEqual({ success: true, result: null });
    });

    it('describes widgets returned by commands', async () => {
      const widget = new Widget();
      widget.id = 'test-widget';
      widget.title.label = 'Test';
      add('test:widget', () => widget);
      expect(await run('test:widget')).toEqual({
        success: true,
        result: { type: 'Widget', id: 'test-widget', title: 'Test' }
      });
      widget.dispose();
    });

    it('returns results with a boolean success flat', async () => {
      add('test:flat', () => ({ success: true, cellId: 'abc' }));
      expect(await run('test:flat')).toEqual({ success: true, cellId: 'abc' });
    });

    it('adds an error to failed results without one', async () => {
      const values = [
        { success: false, error: 'kept', message: 'ignored' },
        { success: false, message: 'Cell not found' },
        { success: false, errorName: 'ValueError', errorValue: 'bad value' },
        { success: false }
      ];
      add('test:failed', () => values.shift());
      expect(await run('test:failed')).toEqual({
        success: false,
        error: 'kept',
        message: 'ignored'
      });
      expect(await run('test:failed')).toEqual({
        success: false,
        message: 'Cell not found',
        error: 'Cell not found'
      });
      expect(await run('test:failed')).toEqual({
        success: false,
        errorName: 'ValueError',
        errorValue: 'bad value',
        error: 'ValueError: bad value'
      });
      expect(await run('test:failed')).toEqual({
        success: false,
        error: 'The command failed.'
      });
    });

    it('converts objects without a prototype', async () => {
      add('test:bare', () => Object.assign(Object.create(null), { a: 1 }));
      await expect(run('test:bare')).resolves.toEqual({
        success: true,
        result: { a: 1 }
      });
      expect(executor.pendingCalls()).toEqual([]);
    });

    it('returns serialization errors as data', async () => {
      const widget = new Widget();
      Object.defineProperty(widget, 'id', {
        get: () => {
          throw new Error('no id');
        }
      });
      add('test:broken-widget', () => widget);
      await expect(run('test:broken-widget')).resolves.toEqual({
        success: false,
        error: 'no id'
      });
      expect(executor.pendingCalls()).toEqual([]);
      widget.dispose();
    });

    it('returns thrown errors as data', async () => {
      add('test:throw', () => {
        throw new Error('boom');
      });
      add('test:reject', () => Promise.reject(new Error('async boom')));
      add('test:reject-string', () => Promise.reject('plain reason'));
      add('test:reject-empty', () => Promise.reject(new TypeError()));
      expect(await run('test:throw')).toEqual({
        success: false,
        error: 'boom'
      });
      expect(await run('test:reject')).toEqual({
        success: false,
        error: 'async boom'
      });
      expect(await run('test:reject-string')).toEqual({
        success: false,
        error: 'plain reason'
      });
      expect(await run('test:reject-empty')).toEqual({
        success: false,
        error: 'TypeError'
      });
    });

    it('warns when the command is not enabled', async () => {
      add(
        'test:disabled',
        () => 'ran',
        () => false
      );
      expect(await run('test:disabled')).toEqual({
        success: true,
        result: 'ran',
        warning: expect.stringMatching(
          /^The command "test:disabled" was not enabled .* or acted on the last active notebook or console\. Check get_context\.$/
        )
      });
    });

    it('does not warn when a disabled command fails', async () => {
      add(
        'test:disabled-fail',
        () => Promise.reject(new Error('no notebook')),
        () => false
      );
      expect(await run('test:disabled-fail')).toEqual({
        success: false,
        error: 'no notebook'
      });
    });

    it('does not warn in a pending result', async () => {
      add('test:disabled-slow', never, () => false);
      timeout = 20;
      expect(await run('test:disabled-slow')).toEqual({
        status: 'pending',
        pendingId: CALL_ID,
        tool: 'test_tool',
        message: expect.stringContaining('wait_for_result')
      });
    });

    it('does not warn when a widget is targeted', async () => {
      add(
        'notebook:targeted',
        () => 'ran',
        () => false
      );
      add(
        'console:targeted',
        () => 'ran',
        () => false
      );
      expect(await run('notebook:targeted', { widgetId: 'nb-1' })).toEqual({
        success: true,
        result: 'ran'
      });
      expect(await run('console:targeted', { semanticWidget: 'nb-1' })).toEqual(
        { success: true, result: 'ran' }
      );
    });

    it('refuses widget arguments for other commands', async () => {
      const execute = jest.fn(() => 'ran');
      add('editmenu:clear-all', execute);
      for (const key of ['semanticWidget', 'widgetId']) {
        expect(await run('editmenu:clear-all', { [key]: 'nb-1' })).toEqual({
          success: false,
          error:
            'Only notebook:* and console:* commands take "semanticWidget" and "widgetId"; "editmenu:clear-all" acts on the current widget. Use the matching notebook:* or console:* command.'
        });
      }
      expect(execute).not.toHaveBeenCalled();
    });

    it('treats isEnabled errors as enabled', async () => {
      add(
        'test:broken-enabled',
        () => 'ran',
        () => {
          throw new Error('no context');
        }
      );
      expect(await run('test:broken-enabled')).toEqual({
        success: true,
        result: 'ran'
      });
    });

    it('returns a pending status after the timeout', async () => {
      add('test:slow', never);
      timeout = 30;
      const start = Date.now();
      const result = await run('test:slow');
      expect(Date.now() - start).toBeLessThan(1000);
      expect(result).toEqual({
        status: 'pending',
        pendingId: CALL_ID,
        tool: 'test_tool',
        message: expect.stringContaining('wait_for_result')
      });
    });

    it('returns a pending status when the agent cancels the call', async () => {
      add('test:slow', never);
      timeout = 5000;
      const controller = new AbortController();
      const start = Date.now();
      const promise = run('test:slow', {}, controller.signal);
      await sleep(10);
      controller.abort();
      expect(await promise).toMatchObject({
        status: 'pending',
        pendingId: CALL_ID
      });
      expect(Date.now() - start).toBeLessThan(1000);
    });

    it('does not run the command for an aborted signal', async () => {
      const execute = jest.fn(never);
      add('test:slow', execute);
      timeout = 5000;
      const controller = new AbortController();
      controller.abort();
      const start = Date.now();
      expect(await run('test:slow', {}, controller.signal)).toEqual({
        success: false,
        error: 'The tool call was cancelled.'
      });
      expect(Date.now() - start).toBeLessThan(1000);
      expect(execute).not.toHaveBeenCalled();
      expect(executor.pendingCalls()).toEqual([]);
    });

    it('only checks the command it runs against blockedCommands', async () => {
      const danger = jest.fn(() => 'ran');
      commands.addCommand('test:danger', { execute: danger });
      add('test:forward', () => commands.execute('test:danger'));
      blocked.add('test:danger');
      expect(await run('test:forward')).toEqual({
        success: true,
        result: 'ran'
      });
      expect(danger).toHaveBeenCalledTimes(1);
    });
  });

  describe('#wait()', () => {
    it('returns the final result once the command settles', async () => {
      const done = new PromiseDelegate<string>();
      add('test:slow', () => done.promise);
      timeout = 20;
      const pending = await run('test:slow');
      expect(pending.status).toBe('pending');
      timeout = 2000;
      const waiting = executor.wait(pending.pendingId as string, 2000);
      done.resolve('finished');
      expect(await waiting).toEqual({ success: true, result: 'finished' });
    });

    it('keeps the result of settled calls', async () => {
      const done = new PromiseDelegate<string>();
      add('test:slow', () => done.promise);
      timeout = 20;
      const pending = await run('test:slow');
      done.resolve('finished');
      await sleep(0);
      const id = pending.pendingId as string;
      expect(await executor.wait(id, 1)).toEqual({
        success: true,
        result: 'finished'
      });
      expect(await executor.wait(id, 1)).toEqual({
        success: true,
        result: 'finished'
      });
    });

    it('never lets callers change the stored result', async () => {
      const done = new PromiseDelegate<string>();
      add('test:slow', () => done.promise);
      timeout = 20;
      const pending = await run('test:slow');
      done.resolve('finished');
      const id = pending.pendingId as string;
      const first = await executor.wait(id, 1000);
      first.result = 'changed';
      first.dialogs = [{ id: 'dialog-closed' }];
      expect(await executor.wait(id, 1000)).toEqual({
        success: true,
        result: 'finished'
      });
    });

    it('returns the failure of the command', async () => {
      const done = new PromiseDelegate<string>();
      add('test:slow', () => done.promise);
      timeout = 20;
      const pending = await run('test:slow');
      done.reject(new Error('kernel died'));
      expect(await executor.wait(pending.pendingId as string, 1000)).toEqual({
        success: false,
        error: 'kernel died'
      });
    });

    it('refuses unknown ids', async () => {
      expect(await executor.wait('call-999', 10)).toEqual({
        success: false,
        error: 'Unknown or expired pendingId "call-999".'
      });
    });

    it('caps the wait to the execution timeout', async () => {
      add('test:slow', never);
      timeout = 30;
      const pending = await run('test:slow');
      const id = pending.pendingId as string;
      let start = Date.now();
      expect(await executor.wait(id, 60_000)).toMatchObject({
        status: 'pending',
        pendingId: id
      });
      expect(Date.now() - start).toBeLessThan(1000);
      start = Date.now();
      expect(await executor.wait(id, 0)).toMatchObject({ status: 'pending' });
      expect(Date.now() - start).toBeLessThan(1000);
    });

    it('waits less than the execution timeout when asked', async () => {
      add('test:slow', never);
      timeout = 20;
      const pending = await run('test:slow');
      timeout = 60_000;
      const start = Date.now();
      expect(
        await executor.wait(pending.pendingId as string, 30)
      ).toMatchObject({ status: 'pending' });
      expect(Date.now() - start).toBeLessThan(1000);
    });

    it('waits forever when the execution timeout is 0', async () => {
      add('test:late', () => sleep(150).then(() => 'late'));
      timeout = 0;
      expect(await run('test:late')).toEqual({ success: true, result: 'late' });

      const done = new PromiseDelegate<string>();
      add('test:slow', () => done.promise);
      timeout = 20;
      const pending = await run('test:slow');
      timeout = 0;
      const waiting = executor.wait(pending.pendingId as string, 0);
      setTimeout(() => done.resolve('finished'), 150);
      expect(await waiting).toEqual({ success: true, result: 'finished' });
    });

    it('honors the wait timeout when the execution timeout is 0', async () => {
      add('test:slow', never);
      timeout = 20;
      const pending = await run('test:slow');
      timeout = 0;
      expect(
        await executor.wait(pending.pendingId as string, 30)
      ).toMatchObject({ status: 'pending' });
    });

    it('returns a pending status when the agent cancels the wait', async () => {
      add('test:slow', never);
      timeout = 20;
      const pending = await run('test:slow');
      timeout = 5000;
      const controller = new AbortController();
      const waiting = executor.wait(
        pending.pendingId as string,
        5000,
        controller.signal
      );
      await sleep(10);
      controller.abort();
      expect(await waiting).toMatchObject({
        status: 'pending',
        pendingId: pending.pendingId
      });
    });

    it('reports the open dialog of the call at once', async () => {
      add('test:confirm', confirmCommand());
      const pending = await run('test:confirm');
      const dialog = pending.dialog as JSONObject;
      expect(dialog.id).toEqual(DIALOG_ID);
      const start = Date.now();
      expect(
        await executor.wait(pending.pendingId as string, 5000)
      ).toMatchObject({
        status: 'pending',
        pendingId: pending.pendingId,
        dialog: { id: dialog.id }
      });
      expect(Date.now() - start).toBeLessThan(1000);
    });
  });

  describe('dialogs', () => {
    it('reports a dialog opened by the command as pending', async () => {
      add('test:confirm', confirmCommand());
      expect(await run('test:confirm')).toEqual({
        status: 'pending',
        pendingId: CALL_ID,
        tool: 'test_tool',
        message:
          'A dialog opened while the call ran, and the call probably waits for an answer. Click a button with answer_dialog (or ask the user if it is not from this call); the call then continues.',
        dialog: {
          id: DIALOG_ID,
          title: 'Restart Kernel?',
          body: 'All variables will be lost.',
          buttons: ['Cancel', 'Restart'],
          shown: true
        }
      });
      expect(Dialogs.attached()).toHaveLength(1);
    });

    it('reports the value of a dialog input', async () => {
      const body = new Widget();
      const input = document.createElement('input');
      input.value = 'Untitled.ipynb';
      body.node.appendChild(input);
      add('test:rename', () =>
        showDialog({ title: 'Rename', body, buttons: [Dialog.okButton()] })
      );
      expect(await run('test:rename')).toMatchObject({
        dialog: { title: 'Rename', input: 'Untitled.ipynb' }
      });
    });

    it('never reports the value of a password input', async () => {
      const body = new Widget();
      const password = document.createElement('input');
      password.type = 'password';
      password.value = 'secret';
      body.node.appendChild(password);
      add('test:login', () =>
        showDialog({ title: 'Login', body, buttons: [Dialog.okButton()] })
      );
      const pending = await run('test:login');
      expect(pending.dialog).toEqual(
        expect.not.objectContaining({ input: expect.anything() })
      );
      const user = document.createElement('input');
      user.value = 'me';
      body.node.appendChild(user);
      const [dialog] = Dialogs.all();
      expect(Dialogs.describe(dialog).input).toBe('me');
      expect(JSON.stringify(Dialogs.describe(dialog))).not.toContain('secret');
    });

    it('answers by label, case-insensitive, and returns the final result', async () => {
      add('test:confirm', confirmCommand());
      const pending = await run('test:confirm');
      const id = (pending.dialog as JSONObject).id;
      expect(await executor.answer('  RESTART ', undefined)).toEqual({
        success: true,
        result: 'restarted',
        answered: { dialogId: id, button: 'Restart' }
      });
      expect(Dialogs.attached()).toEqual([]);
      expect(executor.pendingCalls()).toEqual([]);
    });

    it('answers by index', async () => {
      add('test:confirm', confirmCommand());
      const pending = await run('test:confirm');
      expect(await executor.answer(0, undefined)).toEqual({
        success: true,
        result: 'cancelled',
        answered: {
          dialogId: (pending.dialog as JSONObject).id,
          button: 'Cancel'
        }
      });
    });

    it('refuses unknown buttons and keeps the dialog usable', async () => {
      add('test:confirm', confirmCommand());
      await run('test:confirm');
      for (const button of [2, -1, 0.5, 'Nope']) {
        expect(await executor.answer(button, undefined)).toEqual({
          success: false,
          error: `No button ${JSON.stringify(button)} in the dialog. Buttons: ["Cancel","Restart"].`,
          dialog: expect.objectContaining({ buttons: ['Cancel', 'Restart'] })
        });
      }
      expect(Dialogs.attached()).toHaveLength(1);
      expect(await executor.answer(1, undefined)).toMatchObject({
        success: true,
        result: 'restarted'
      });
    });

    it('reports a dialog that does not close', async () => {
      const body = new Widget();
      const input = document.createElement('input');
      input.className = 'jp-mod-error';
      body.node.appendChild(input);
      const dialog = launch({
        title: 'Name',
        body,
        buttons: [Dialog.cancelButton(), Dialog.okButton()]
      });
      await shown(dialog, 'Name');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      expect(await executor.answer('Ok', undefined)).toMatchObject({
        success: false,
        error: expect.stringContaining('did not close'),
        dialog: { title: 'Name' }
      });
      expect(dialog.isDisposed).toBe(false);
      expect(await executor.answer('Cancel', undefined)).toMatchObject({
        success: true
      });
      expect(dialog.isDisposed).toBe(true);
    });

    it('reports when no dialog is open', async () => {
      expect(await executor.answer('Ok', undefined)).toEqual({
        success: false,
        error: 'No dialog is open.',
        dialogs: []
      });
    });

    it('asks for dialogId when several dialogs are open', async () => {
      // The launch queue shows one dialog at a time: attach the second one
      // directly, without buttons since the focus traps of two dialogs with
      // a focused button call each other forever.
      const first = launch({ title: 'First', buttons: [Dialog.okButton()] });
      const second = new Dialog({ title: 'Second', buttons: [] });
      Widget.attach(second, document.body);
      await shown(first, 'First');
      await shown(second, 'Second');
      const result = await executor.answer('Ok', undefined);
      expect(result).toMatchObject({
        success: false,
        error: 'Several dialogs are open (shown or queued): pass dialogId.'
      });
      expect(result.dialogs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: Dialogs.idOf(first), title: 'First' }),
          expect.objectContaining({ id: Dialogs.idOf(second), title: 'Second' })
        ])
      );
      expect(await executor.answer('Ok', Dialogs.idOf(first))).toEqual({
        success: true,
        answered: { dialogId: Dialogs.idOf(first), button: 'Ok' }
      });
      expect(first.isDisposed).toBe(true);
      second.dispose();
    });

    it('refuses an unknown dialogId', async () => {
      const only = launch({ title: 'Only', buttons: [Dialog.okButton()] });
      await shown(only, 'Only');
      expect(await executor.answer('Ok', 'dialog-unknown')).toMatchObject({
        success: false,
        error: 'No open dialog with id "dialog-unknown".',
        dialogs: [expect.objectContaining({ title: 'Only' })]
      });
    });

    it('only answers dialogs that are shown', async () => {
      const first = launch({ title: 'First', buttons: [Dialog.okButton()] });
      const second = launch({ title: 'Second', buttons: [Dialog.okButton()] });
      await shown(first, 'First');
      expect(second.isAttached).toBe(false);
      const queued = Dialogs.idOf(second);
      const dialogs = [
        expect.objectContaining({ id: Dialogs.idOf(first), shown: true }),
        expect.objectContaining({ id: queued, shown: false })
      ];
      expect(await executor.answer('Ok', queued)).toEqual({
        success: false,
        error: `The dialog "${queued}" is queued behind the dialog that is shown. Only the shown dialog can be answered.`,
        dialogs
      });
      expect(await executor.answer('Ok', undefined)).toEqual({
        success: false,
        error: 'Several dialogs are open (shown or queued): pass dialogId.',
        dialogs
      });
      expect(first.isDisposed).toBe(false);
      expect(second.isDisposed).toBe(false);
      expect(await executor.answer('Ok', Dialogs.idOf(first))).toEqual({
        success: true,
        answered: { dialogId: Dialogs.idOf(first), button: 'Ok' }
      });
      await shown(second, 'Second');
      expect(await executor.answer('Ok', undefined)).toEqual({
        success: true,
        answered: { dialogId: queued, button: 'Ok' }
      });
    });

    it('names the only dialog when it is not shown yet', async () => {
      const dialog = new Dialog({
        title: 'Later',
        buttons: [Dialog.okButton()]
      });
      const id = Dialogs.idOf(dialog);
      expect(await executor.answer('Ok', undefined)).toEqual({
        success: false,
        error: `The dialog "${id}" is queued behind the dialog that is shown. Only the shown dialog can be answered.`,
        dialogs: [expect.objectContaining({ id, shown: false })]
      });
      dialog.dispose();
    });

    it('never answers the dialog of the user for a queued dialog of a call', async () => {
      const user = launch({
        title: 'Close without saving?',
        body: 'The notebook has unsaved changes.',
        buttons: [
          Dialog.cancelButton(),
          Dialog.warnButton({ label: 'Discard' }),
          Dialog.okButton({ label: 'Save' })
        ]
      });
      await shown(user, 'Close without saving?');
      const userId = Dialogs.idOf(user);
      add('test:shutdown', confirmCommand('Shut down kernel?'));
      const pending = await run('test:shutdown');
      const agentId = (pending.dialog as JSONObject).id as string;
      expect(agentId).not.toBe(userId);
      expect(pending).toEqual({
        status: 'pending',
        pendingId: CALL_ID,
        tool: 'test_tool',
        message: `A dialog opened while the call ran, queued behind the dialog that is shown (${userId}). That dialog must be closed first: answer it with answer_dialog and its dialogId if it comes from one of your calls (for example an error dialog), else ask the user. Then call wait_for_result.`,
        dialog: expect.objectContaining({
          id: agentId,
          buttons: ['Cancel', 'Restart'],
          shown: false
        })
      });
      const start = Date.now();
      expect(
        await executor.wait(pending.pendingId as string, 5000)
      ).toMatchObject({
        status: 'pending',
        message: expect.stringContaining(
          `queued behind the dialog that is shown (${userId})`
        ),
        dialog: { id: agentId, shown: false }
      });
      expect(Date.now() - start).toBeLessThan(1000);

      const dialogs = [
        expect.objectContaining({
          id: userId,
          buttons: ['Cancel', 'Discard', 'Save'],
          shown: true
        }),
        expect.objectContaining({
          id: agentId,
          buttons: ['Cancel', 'Restart'],
          shown: false
        })
      ];
      expect(await executor.answer(1, undefined)).toEqual({
        success: false,
        error: 'Several dialogs are open (shown or queued): pass dialogId.',
        dialogs
      });
      expect(await executor.answer('Restart', agentId)).toEqual({
        success: false,
        error: `The dialog "${agentId}" is queued behind the dialog that is shown. Only the shown dialog can be answered.`,
        dialogs
      });
      expect(user.isDisposed).toBe(false);
      expect(executor.pendingCalls()).toEqual([
        expect.objectContaining({ pendingId: pending.pendingId })
      ]);

      // The user closes their dialog: the dialog of the call is shown.
      user.resolve(0);
      const agent = Dialogs.all().find(item => Dialogs.idOf(item) === agentId)!;
      await shown(agent, 'Shut down kernel?');
      expect(await executor.answer('Restart', undefined)).toEqual({
        success: true,
        result: 'restarted',
        answered: { dialogId: agentId, button: 'Restart' }
      });
      expect(executor.pendingCalls()).toEqual([]);
    });

    it('answers a dialog that no call opened', async () => {
      const dialog = new Dialog({
        title: 'Hello',
        buttons: [Dialog.cancelButton(), Dialog.okButton()]
      });
      const shown = dialog.launch();
      await sleep(10);
      expect(await executor.answer(1, undefined)).toEqual({
        success: true,
        answered: { dialogId: Dialogs.idOf(dialog), button: 'Ok' }
      });
      expect((await shown).button.label).toBe('Ok');
    });

    it('reports the next dialog of the call after an answer', async () => {
      add('test:wizard', async () => {
        const first = await showDialog({
          title: 'Step 1',
          buttons: [Dialog.okButton({ label: 'Next' })]
        });
        const second = await showDialog({
          title: 'Step 2',
          buttons: [Dialog.cancelButton(), Dialog.okButton({ label: 'Finish' })]
        });
        return [first.button.label, second.button.label];
      });
      const step1 = await run('test:wizard');
      expect(step1).toMatchObject({ dialog: { title: 'Step 1' } });
      const step2 = await executor.answer('Next', undefined);
      expect(step2).toMatchObject({
        status: 'pending',
        pendingId: step1.pendingId,
        dialog: { title: 'Step 2', buttons: ['Cancel', 'Finish'] },
        answered: { button: 'Next' }
      });
      expect(await executor.answer('finish', undefined)).toEqual({
        success: true,
        result: ['Next', 'Finish'],
        answered: {
          dialogId: (step2.dialog as JSONObject).id,
          button: 'Finish'
        }
      });
    });

    it('returns a pending status when the answered call keeps running', async () => {
      add('test:confirm-then-slow', async () => {
        await showDialog({ title: 'Run all?', buttons: [Dialog.okButton()] });
        return never();
      });
      const pending = await run('test:confirm-then-slow');
      timeout = 30;
      expect(await executor.answer('Ok', undefined)).toMatchObject({
        status: 'pending',
        pendingId: pending.pendingId,
        message: expect.stringContaining('wait_for_result'),
        answered: { button: 'Ok' }
      });

      add('test:confirm-then-slow-2', async () => {
        await showDialog({ title: 'Again?', buttons: [Dialog.okButton()] });
        return never();
      });
      await run('test:confirm-then-slow-2');
      timeout = 5000;
      const controller = new AbortController();
      controller.abort();
      expect(
        await executor.answer('Ok', undefined, controller.signal)
      ).toMatchObject({ status: 'pending', answered: { button: 'Ok' } });
    });

    it('continues the call that opened the dialog', async () => {
      add('test:slow', never);
      add('test:confirm', confirmCommand());
      timeout = 30;
      const slow = await run('test:slow');
      expect(slow).toMatchObject({ status: 'pending' });
      const pending = await run('test:confirm');
      expect(pending).toMatchObject({ dialog: { title: 'Restart Kernel?' } });
      expect(await executor.answer('Restart', undefined)).toEqual({
        success: true,
        result: 'restarted',
        answered: {
          dialogId: (pending.dialog as JSONObject).id,
          button: 'Restart'
        }
      });
      expect(executor.pendingCalls()).toEqual([
        expect.objectContaining({ pendingId: slow.pendingId })
      ]);
    });

    it('does not link a dialog opened while no tool waits', async () => {
      add('test:slow', never);
      timeout = 20;
      const pending = await run('test:slow');
      const id = pending.pendingId as string;
      const dialog = launch({
        title: 'User dialog',
        buttons: [Dialog.cancelButton(), Dialog.okButton()]
      });
      await sleep(10);
      const result = await executor.wait(id, 30);
      expect(result).toMatchObject({
        status: 'pending',
        pendingId: id,
        message: expect.stringContaining('wait_for_result')
      });
      expect(result.dialog).toBeUndefined();
      expect(await executor.answer('Ok', undefined)).toEqual({
        success: true,
        answered: { dialogId: Dialogs.idOf(dialog), button: 'Ok' }
      });
      expect(executor.pendingCalls()).toEqual([
        expect.objectContaining({ pendingId: id })
      ]);
    });

    it('leaves an error dialog opened while no tool waits', async () => {
      const done = new PromiseDelegate<string>();
      add('test:slow', () => done.promise);
      timeout = 20;
      const pending = await run('test:slow');
      showErrorMessage('User error', 'Not related').catch(() => undefined);
      await waitFor(() =>
        Dialogs.attached().some(
          dialog => Dialogs.text(dialog).title === 'User error'
        )
      );
      done.resolve('finished');
      expect(await executor.wait(pending.pendingId as string, 1000)).toEqual({
        success: true,
        result: 'finished'
      });
      expect(
        Dialogs.attached().map(dialog => Dialogs.text(dialog).title)
      ).toEqual(['User error']);
    });

    it('does not attribute a dialog while several calls are waited for', async () => {
      add('test:slow', never);
      add('test:confirm', confirmCommand());
      timeout = 20;
      const slow = await run('test:slow');
      timeout = 300;
      const waiting = executor.wait(slow.pendingId as string, 300);
      const confirm = await run('test:confirm');
      const result = await waiting;
      for (const pending of [confirm, result]) {
        expect(pending).toMatchObject({
          status: 'pending',
          message: expect.stringContaining('wait_for_result')
        });
        expect(pending.dialog).toBeUndefined();
      }
      const [dialog] = Dialogs.all();
      expect(await executor.answer('Restart', undefined)).toEqual({
        success: true,
        answered: { dialogId: Dialogs.idOf(dialog), button: 'Restart' }
      });
      expect(await executor.wait(confirm.pendingId as string, 1000)).toEqual({
        success: true,
        result: 'restarted'
      });
    });

    it('attributes a dialog to a call waited for by several tools', async () => {
      const done = new PromiseDelegate<void>();
      add('test:late-confirm', async () => {
        await done.promise;
        return confirmCommand()();
      });
      timeout = 20;
      const pending = await run('test:late-confirm');
      timeout = 2000;
      const id = pending.pendingId as string;
      const waits = [executor.wait(id, 2000), executor.wait(id, 2000)];
      done.resolve();
      for (const result of await Promise.all(waits)) {
        expect(result).toMatchObject({
          status: 'pending',
          pendingId: id,
          dialog: { title: 'Restart Kernel?' }
        });
      }
    });

    it('continues each of two calls waiting for a dialog', async () => {
      add('test:first', confirmCommand('First?'));
      add('test:second', confirmCommand('Second?'));
      const first = await run('test:first');
      const second = await run('test:second');
      const firstDialog = first.dialog as JSONObject;
      const secondDialog = second.dialog as JSONObject;
      expect(first).toMatchObject({
        status: 'pending',
        dialog: { title: 'First?', shown: true }
      });
      expect(second).toMatchObject({
        status: 'pending',
        message: expect.stringContaining(
          `queued behind the dialog that is shown (${firstDialog.id})`
        ),
        dialog: { shown: false }
      });
      expect(secondDialog.id).not.toBe(firstDialog.id);
      expect(
        await executor.wait(second.pendingId as string, 1000)
      ).toMatchObject({
        status: 'pending',
        pendingId: second.pendingId,
        dialog: { id: secondDialog.id }
      });
      expect(await executor.answer('Restart', undefined)).toMatchObject({
        success: false,
        error: 'Several dialogs are open (shown or queued): pass dialogId.'
      });
      expect(
        await executor.answer('Restart', firstDialog.id as string)
      ).toEqual({
        success: true,
        result: 'restarted',
        answered: { dialogId: firstDialog.id, button: 'Restart' }
      });
      await shown(
        Dialogs.all().find(item => Dialogs.idOf(item) === secondDialog.id)!,
        'Second?'
      );
      expect(
        await executor.answer('Cancel', secondDialog.id as string)
      ).toEqual({
        success: true,
        result: 'cancelled',
        answered: { dialogId: secondDialog.id, button: 'Cancel' }
      });
      expect(executor.pendingCalls()).toEqual([]);
    });

    it('does not return again a result that the agent already got', async () => {
      let dialog: Dialog<unknown> | undefined;
      add('test:notify', () => {
        dialog = launch({
          title: 'Done',
          buttons: [Dialog.cancelButton(), Dialog.okButton()]
        });
        return 'done';
      });
      expect(await run('test:notify')).toEqual({
        success: true,
        result: 'done'
      });
      expect(dialog!.isDisposed).toBe(false);
      expect(await executor.answer('Ok', undefined)).toEqual({
        success: true,
        answered: { dialogId: Dialogs.idOf(dialog!), button: 'Ok' }
      });
    });

    it('returns the result of a call that settled while its dialog was open', async () => {
      const done = new PromiseDelegate<string>();
      add('test:confirm-in-background', () => {
        launch({ title: 'Continue?', buttons: [Dialog.okButton()] });
        return done.promise;
      });
      const pending = await run('test:confirm-in-background');
      expect(pending).toMatchObject({ dialog: { title: 'Continue?' } });
      done.resolve('finished');
      await sleep(0);
      expect(await executor.answer('Ok', undefined)).toEqual({
        success: true,
        result: 'finished',
        answered: { dialogId: (pending.dialog as JSONObject).id, button: 'Ok' }
      });
    });

    it('reports an error dialog as pending and leaves it open', async () => {
      add('test:open-broken', () => {
        showErrorMessage(
          'File Load Error',
          'Unreadable Notebook: bad.ipynb'
        ).catch(() => undefined);
        return never();
      });
      const pending = await run('test:open-broken');
      expect(pending).toEqual({
        status: 'pending',
        pendingId: CALL_ID,
        tool: 'test_tool',
        message:
          'An error dialog opened while the call ran, so the call probably failed. Read the dialog, then close it with answer_dialog (or ask the user if it is not from this call).',
        dialog: {
          id: DIALOG_ID,
          title: 'File Load Error',
          body: 'Unreadable Notebook: bad.ipynb',
          buttons: ['Close'],
          shown: true
        }
      });
      expect(Dialogs.attached()).toHaveLength(1);
      expect(executor.pendingCalls()).toEqual([
        expect.objectContaining({ pendingId: pending.pendingId })
      ]);
    });

    it('keeps the real result of a call after an error dialog of another client', async () => {
      const done = new PromiseDelegate<string>();
      add('test:slow', () => done.promise);
      timeout = 20;
      const id = (await run('test:slow')).pendingId as string;
      timeout = 5000;
      const waiting = executor.wait(id, 5000);
      showErrorMessage('Error', 'Another client failed').catch(() => undefined);
      const pending = await waiting;
      expect(pending).toMatchObject({
        status: 'pending',
        pendingId: id,
        message: expect.stringContaining('probably failed'),
        dialog: { title: 'Error', body: 'Another client failed' }
      });
      // The error dialog is reported once: the next wait gets the result.
      setTimeout(() => done.resolve('finished'), 300);
      const start = Date.now();
      expect(await executor.wait(id, 5000)).toEqual({
        success: true,
        result: 'finished'
      });
      expect(Date.now() - start).toBeGreaterThanOrEqual(250);
      expect(
        Dialogs.attached().map(dialog => Dialogs.text(dialog).title)
      ).toEqual(['Error']);
    });

    it('reports an open error dialog again after a wait times out', async () => {
      add('test:open-broken', () => {
        showErrorMessage('File Load Error', 'Unreadable').catch(
          () => undefined
        );
        return never();
      });
      const pending = await run('test:open-broken');
      const start = Date.now();
      expect(
        await executor.wait(pending.pendingId as string, 200)
      ).toMatchObject({
        status: 'pending',
        message: expect.stringContaining('probably failed'),
        dialog: { id: (pending.dialog as JSONObject).id }
      });
      expect(Date.now() - start).toBeGreaterThanOrEqual(150);
    });

    it('reports a new dialog of a call after its error dialog', async () => {
      const next = new PromiseDelegate<void>();
      add('test:error-then-confirm', async () => {
        showErrorMessage('Warning', 'Some files were skipped').catch(
          () => undefined
        );
        await next.promise;
        return confirmCommand()();
      });
      const pending = await run('test:error-then-confirm');
      expect(pending).toMatchObject({ dialog: { title: 'Warning' } });
      const waiting = executor.wait(pending.pendingId as string, 5000);
      next.resolve();
      const warning = (pending.dialog as JSONObject).id as string;
      const queued = await waiting;
      expect(queued).toMatchObject({
        status: 'pending',
        message: expect.stringContaining(
          `queued behind the dialog that is shown (${warning})`
        ),
        dialog: { shown: false }
      });
      expect((queued.dialog as JSONObject).id).not.toBe(warning);
      expect(await executor.answer('Close', warning)).toMatchObject({
        status: 'pending',
        dialog: {
          id: (queued.dialog as JSONObject).id,
          title: 'Restart Kernel?',
          shown: true
        },
        answered: { dialogId: warning, button: 'Close' }
      });
    });

    it('answers an error dialog without waiting for the execution timeout', async () => {
      add('test:open-broken', () => {
        showErrorMessage('File Load Error', 'Unreadable').catch(
          () => undefined
        );
        return never();
      });
      timeout = 5000;
      const pending = await run('test:open-broken');
      const start = Date.now();
      expect(await executor.answer('Close', undefined)).toEqual({
        status: 'pending',
        pendingId: pending.pendingId,
        tool: 'test_tool',
        message:
          'The error dialog is closed, but the call has not settled: it probably failed and may never settle. Call wait_for_result only if you still expect a result; get_context lists the call in pending until it settles.',
        answered: {
          dialogId: (pending.dialog as JSONObject).id,
          button: 'Close'
        }
      });
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(900);
      expect(elapsed).toBeLessThan(2000);
      expect(Dialogs.all()).toEqual([]);
    });

    it('reports the next queued dialog of a call after an answer', async () => {
      add('test:two-errors', () => {
        showErrorMessage('First', 'One').catch(() => undefined);
        showErrorMessage('Second', 'Two').catch(() => undefined);
        return never();
      });
      const pending = await run('test:two-errors');
      expect(pending).toMatchObject({ dialog: { title: 'First' } });
      expect(
        await executor.answer(
          'Close',
          (pending.dialog as JSONObject).id as string
        )
      ).toEqual({
        status: 'pending',
        pendingId: pending.pendingId,
        tool: 'test_tool',
        message: expect.stringContaining('probably failed'),
        dialog: expect.objectContaining({ body: 'Two', shown: true }),
        answered: {
          dialogId: (pending.dialog as JSONObject).id,
          button: 'Close'
        }
      });
    });

    it('reports a dialog that the call opens right after another one', async () => {
      add('test:two-confirms', async () => {
        const first = confirmCommand('First')();
        await sleep(10);
        const second = confirmCommand('Second')();
        return [await first, await second];
      });
      const pending = await run('test:two-confirms');
      expect(pending).toMatchObject({ dialog: { title: 'First' } });
      const start = Date.now();
      const dialogId = (pending.dialog as JSONObject).id as string;
      expect(await executor.answer('Restart', dialogId)).toMatchObject({
        status: 'pending',
        pendingId: pending.pendingId,
        dialog: { title: 'Second', shown: true }
      });
      expect(Date.now() - start).toBeLessThan(1000);
    });

    it('returns the failure that follows an answered error dialog', async () => {
      add('test:open-broken', async () => {
        await showErrorMessage('File Load Error', 'Unreadable');
        throw new Error('Could not open');
      });
      const pending = await run('test:open-broken');
      expect(pending).toMatchObject({ dialog: { title: 'File Load Error' } });
      expect(await executor.answer('Close', undefined)).toEqual({
        success: false,
        error: 'Could not open',
        answered: {
          dialogId: (pending.dialog as JSONObject).id,
          button: 'Close'
        }
      });
    });

    it('reports a single Close dialog with a widget body as pending', async () => {
      // Like help:about, which is not an error.
      const body = new Widget();
      body.node.textContent = 'Version 4.6.0';
      add('test:about', () =>
        showDialog({
          title: 'About JupyterLab',
          body,
          buttons: [Dialog.cancelButton({ label: 'Close' })]
        })
      );
      expect(await run('test:about')).toEqual({
        status: 'pending',
        pendingId: CALL_ID,
        tool: 'test_tool',
        message: expect.stringContaining('answer_dialog'),
        dialog: {
          id: DIALOG_ID,
          title: 'About JupyterLab',
          body: 'Version 4.6.0',
          buttons: ['Close'],
          shown: true
        }
      });
      const [dialog] = Dialogs.attached();
      expect(Dialogs.isError(dialog)).toBe(false);
      expect(await executor.answer('Close', undefined)).toMatchObject({
        success: true,
        answered: { dialogId: Dialogs.idOf(dialog), button: 'Close' }
      });
      expect(executor.pendingCalls()).toEqual([]);
    });

    it('leaves open a single Close dialog with a widget body of a settled command', async () => {
      let dialog: Dialog<unknown> | undefined;
      add('test:show-about', () => {
        const body = new Widget();
        body.node.textContent = 'Version 4.6.0';
        dialog = launch({
          title: 'About JupyterLab',
          body,
          buttons: [Dialog.cancelButton({ label: 'Close' })]
        });
        return 'shown';
      });
      expect(await run('test:show-about')).toEqual({
        success: true,
        result: 'shown'
      });
      expect(dialog!.isDisposed).toBe(false);
    });

    it('treats only text dialogs with a single reject button as errors', async () => {
      showErrorMessage('Error', 'Text body').catch(() => undefined);
      const close = new Widget();
      close.node.textContent = 'Widget body';
      const dialogs = [
        Dialogs.all()[0],
        new Dialog({
          title: 'Text',
          body: 'Text body',
          buttons: [Dialog.cancelButton({ label: 'Close' })]
        }),
        new Dialog({
          title: 'Widget',
          body: close,
          buttons: [Dialog.cancelButton({ label: 'Close' })]
        }),
        new Dialog({
          title: 'Ok',
          body: 'Text body',
          buttons: [Dialog.okButton()]
        }),
        new Dialog({
          title: 'Two',
          body: 'Text body',
          buttons: [Dialog.cancelButton(), Dialog.okButton()]
        })
      ];
      expect(dialogs.map(Dialogs.isError)).toEqual([
        true,
        true,
        false,
        false,
        false
      ]);
    });

    it('does not close the dialogs of a settled call', async () => {
      add('test:save-broken', () => {
        showErrorMessage('Save Error', 'Disk full').catch(() => undefined);
        return Promise.reject(new Error('Could not save'));
      });
      const failure = { success: false, error: 'Could not save' };
      expect(await run('test:save-broken')).toEqual(failure);
      const [dialog] = Dialogs.attached();
      expect(Dialogs.text(dialog)).toEqual({
        title: 'Save Error',
        body: 'Disk full'
      });

      // A dialog of a new call is queued behind it, and the agent closes it.
      add('test:confirm', confirmCommand());
      const queued = await run('test:confirm');
      expect(queued).toMatchObject({
        status: 'pending',
        message: expect.stringContaining(
          `queued behind the dialog that is shown (${Dialogs.idOf(dialog)}). That dialog must be closed first: answer it with answer_dialog and its dialogId if it comes from one of your calls`
        ),
        dialog: { shown: false }
      });
      expect(await executor.answer('Close', Dialogs.idOf(dialog))).toEqual({
        success: true,
        answered: { dialogId: Dialogs.idOf(dialog), button: 'Close' }
      });
      await waitFor(() => Dialogs.attached().length === 1);
      expect(
        await executor.wait(queued.pendingId as string, 1000)
      ).toMatchObject({
        status: 'pending',
        dialog: { title: 'Restart Kernel?', shown: true }
      });
    });

    it('keeps waiting when the dialog closes before it is reported', async () => {
      add('test:flash', async () => {
        const dialog = launch({
          title: 'Working',
          buttons: [Dialog.okButton()]
        });
        setTimeout(() => dialog.dispose(), 10);
        await sleep(150);
        return 'done';
      });
      expect(await run('test:flash')).toEqual({
        success: true,
        result: 'done'
      });
    });

    it('reports the next dialog after a dialog closed before it is reported', async () => {
      add('test:flash-then-confirm', async () => {
        const dialog = launch({
          title: 'Working',
          buttons: [Dialog.okButton()]
        });
        setTimeout(() => dialog.dispose(), 10);
        await sleep(100);
        return confirmCommand()();
      });
      timeout = 1000;
      const result = await run('test:flash-then-confirm');
      expect(result).toMatchObject({
        status: 'pending',
        dialog: { title: 'Restart Kernel?', shown: true }
      });
      expect(await executor.answer('Restart', undefined)).toMatchObject({
        success: true,
        result: 'restarted'
      });
    });

    it('times out after a dialog closed before it is reported', async () => {
      add('test:flash-then-hang', () => {
        const dialog = launch({
          title: 'Working',
          buttons: [Dialog.okButton()]
        });
        setTimeout(() => dialog.dispose(), 10);
        return never();
      });
      timeout = 200;
      const result = await run('test:flash-then-hang');
      expect(result).toMatchObject({
        status: 'pending',
        message: expect.stringContaining('wait_for_result')
      });
      expect(result.dialog).toBeUndefined();
    });

    it('reports the title of a queued dialog', async () => {
      const user = launch({
        title: 'User dialog',
        buttons: [Dialog.okButton()]
      });
      await sleep(10);
      add('test:confirm', confirmCommand());
      const result = await run('test:confirm');
      // Disposing a queued dialog after the dialog before it leaves an
      // unhandled rejection in apputils: show it first.
      user.resolve(0);
      expect(result).toMatchObject({
        status: 'pending',
        dialog: { title: 'Restart Kernel?', shown: false }
      });
    });
  });

  describe('#pendingCalls()', () => {
    it('lists the calls that are still running', async () => {
      const done = new PromiseDelegate<string>();
      add('test:slow', () => done.promise);
      timeout = 20;
      expect(executor.pendingCalls()).toEqual([]);
      const pending = await run('test:slow');
      expect(executor.pendingCalls()).toEqual([
        {
          pendingId: pending.pendingId,
          tool: 'test_tool',
          command: 'test:slow',
          seconds: 0
        }
      ]);
      done.resolve('finished');
      await sleep(0);
      expect(executor.pendingCalls()).toEqual([]);
    });
  });

  describe('pruning', () => {
    /**
     * Start a call that settles after it is reported as pending.
     */
    async function settledCall(): Promise<string> {
      const done = new PromiseDelegate<string>();
      const id = `test:settled-${Math.random()}`;
      add(id, () => done.promise);
      const saved = timeout;
      timeout = 20;
      const pending = await run(id);
      timeout = saved;
      done.resolve('finished');
      await sleep(0);
      return pending.pendingId as string;
    }

    it('forgets settled calls after 10 minutes', async () => {
      const id = await settledCall();
      const now = Date.now();
      const spy = jest.spyOn(Date, 'now');
      spy.mockReturnValue(now + 9 * 60 * 1000);
      expect(await executor.wait(id, 1)).toEqual({
        success: true,
        result: 'finished'
      });
      spy.mockReturnValue(now + 11 * 60 * 1000);
      expect(await executor.wait(id, 1)).toMatchObject({
        success: false,
        error: expect.stringContaining('Unknown or expired')
      });
    });

    it('keeps at most 50 settled calls that returned a pending result', async () => {
      add('test:quick', () => 'ok');
      const id = await settledCall();
      // The agent gets these results at once: they are not kept.
      for (let i = 0; i < 60; i++) {
        await run('test:quick');
      }
      for (let i = 0; i < 49; i++) {
        await settledCall();
      }
      expect(await executor.wait(id, 1)).toEqual({
        success: true,
        result: 'finished'
      });
      await settledCall();
      expect(await executor.wait(id, 1)).toMatchObject({
        success: false,
        error: expect.stringContaining('Unknown or expired')
      });
    });

    it('never drops a running call', async () => {
      add('test:slow', never);
      add('test:quick', () => 'ok');
      timeout = 5;
      const ids: string[] = [];
      for (let i = 0; i < 55; i++) {
        ids.push((await run('test:slow')).pendingId as string);
      }
      for (let i = 0; i < 60; i++) {
        await run('test:quick');
      }
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now + 60 * 60 * 1000);
      await run('test:quick');
      expect(executor.pendingCalls().map(call => call.pendingId)).toEqual(ids);
      expect(await executor.wait(ids[0], 1)).toMatchObject({
        status: 'pending',
        pendingId: ids[0]
      });
    });
  });

  describe('#dispose()', () => {
    it('stops tracking dialogs and forgets the calls', async () => {
      add('test:slow', never);
      add('test:confirm', confirmCommand());
      timeout = 20;
      const pending = await run('test:slow');
      expect(executor.isDisposed).toBe(false);
      executor.dispose();
      executor.dispose();
      expect(executor.isDisposed).toBe(true);
      expect(executor.pendingCalls()).toEqual([]);
      expect(await executor.wait(pending.pendingId as string, 1)).toMatchObject(
        { success: false }
      );
      timeout = 100;
      const result = await run('test:confirm');
      expect(result).toMatchObject({ status: 'pending' });
      expect(result.dialog).toBeUndefined();
      expect(Dialogs.attached()).toHaveLength(1);
    });
  });
});
