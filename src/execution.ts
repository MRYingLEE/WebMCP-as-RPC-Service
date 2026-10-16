import { Dialog } from '@jupyterlab/apputils';
import { CommandRegistry } from '@lumino/commands';
import {
  JSONObject,
  PromiseDelegate,
  ReadonlyJSONObject
} from '@lumino/coreutils';
import { IDisposable } from '@lumino/disposable';
import { Signal } from '@lumino/signaling';
import { Dialogs } from './dialogs';
import { toToolResult } from './results';
import { errorMessage, safely } from './utils';

/**
 * Runs commands for agents. A call that opens a dialog or runs past the
 * timeout returns a pending result and keeps running, since MCP bridges may
 * run one call at a time and cannot cancel it; `wait` and `answer` continue
 * the call.
 */
export class CommandExecutor implements IDisposable {
  /**
   * Construct a new executor.
   */
  constructor(options: CommandExecutor.IOptions) {
    this._commands = options.commands;
    this._isBlocked = options.isBlocked;
    this._timeout = options.timeout;
    Dialog.tracker.widgetAdded.connect(this._onDialogAdded, this);
  }

  /**
   * Whether the executor is disposed.
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Dispose of the resources held by the executor.
   */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    this._calls.clear();
    this._settled.length = 0;
    this._owners.clear();
    Signal.clearData(this);
  }

  /**
   * Run a command on behalf of a tool.
   */
  async execute(
    commandId: string,
    args: ReadonlyJSONObject,
    options: CommandExecutor.IExecuteOptions
  ): Promise<JSONObject> {
    const commands = this._commands;
    if (!commands.hasCommand(commandId)) {
      return {
        success: false,
        error: `Unknown command "${commandId}". Use list_all_commands to find the available commands.`
      };
    }
    if (this._isBlocked(commandId)) {
      return {
        success: false,
        error: `The command "${commandId}" is blocked by the WebMCP settings (blockedCommands).`
      };
    }
    const targeted =
      args[Private.WIDGET_ARG] !== undefined ||
      args[Private.SEMANTIC_WIDGET_ARG] !== undefined;
    // Other commands, such as the menu commands that delegate to them,
    // ignore these arguments and act on the current widget.
    if (targeted && !/^(notebook|console):/.test(commandId)) {
      return {
        success: false,
        error: `Only notebook:* and console:* commands take "${Private.SEMANTIC_WIDGET_ARG}" and "${Private.WIDGET_ARG}"; "${commandId}" acts on the current widget. Use the matching notebook:* or console:* command.`
      };
    }
    if (options.signal?.aborted) {
      return { success: false, error: 'The tool call was cancelled.' };
    }
    // `isEnabled` ignores the arguments that target a widget that is not
    // the active one, so it would report such calls as disabled.
    const enabled =
      targeted || safely(() => commands.isEnabled(commandId, args), true);
    const call = this._start(options.tool, commandId, args);
    const result = await this._settle(call, this._timeout(), options.signal);
    // A pending call is running or waits for its dialog: it did something.
    if (!enabled && result.success === true) {
      result.warning = `The command "${commandId}" was not enabled when it ran (for example because no matching document was active): it may have done nothing, or acted on the last active notebook or console. Check get_context.`;
    }
    return result;
  }

  /**
   * Wait for a pending call.
   *
   * @param timeout - Maximum time in milliseconds, capped to the execution
   * timeout.
   */
  async wait(
    pendingId: string,
    timeout: number,
    signal?: AbortSignal
  ): Promise<JSONObject> {
    this._prune();
    const call = this._calls.get(pendingId);
    if (!call) {
      return {
        success: false,
        error: `Unknown or expired pendingId "${pendingId}".`
      };
    }
    return this._settle(call, Private.cap(timeout, this._timeout()), signal);
  }

  /**
   * Click a button of the dialog that is shown. When the dialog opened
   * during a call whose result the agent did not get yet, return the result
   * of that call like `wait` does.
   */
  async answer(
    button: string | number,
    dialogId: string | undefined,
    signal?: AbortSignal
  ): Promise<JSONObject> {
    // Queued dialogs count: the agent must not click the dialog of the user
    // when the dialog of its call is queued behind it.
    const all = Dialogs.all();
    const found = Private.findDialog(all, dialogId);
    if ('error' in found) {
      return {
        success: false,
        error: found.error,
        dialogs: all.map(Dialogs.describe)
      };
    }
    const { dialog } = found;
    const call = this._owners.get(dialog);
    const isError = Dialogs.isError(dialog);
    const clicked = Dialogs.answer(dialog, button);
    if ('error' in clicked) {
      return {
        success: false,
        error: clicked.error,
        dialog: Dialogs.describe(dialog)
      };
    }
    const answered = { dialogId: Dialogs.idOf(dialog), button: clicked.label };
    if (!call || call.returned) {
      return { success: true, answered };
    }
    if (Dialogs.attached().length === 0 && this._dialogsOf(call).length > 0) {
      // Dialog.launch shows the next queued dialog a few ticks later.
      await this._race(call, 0, signal);
    }
    // A call that showed an error dialog has often failed and never settles.
    const timeout = isError
      ? Private.cap(Private.ERROR_ANSWER_WAIT, this._timeout())
      : this._timeout();
    const result = await this._settle(call, timeout, signal);
    if (isError && result.status === 'pending' && !result.dialog) {
      result.message =
        'The error dialog is closed, but the call has not settled: it probably failed and may never settle. Call wait_for_result only if you still expect a result; get_context lists the call in pending until it settles.';
    }
    return { ...result, answered };
  }

  /**
   * The calls that are still running.
   */
  pendingCalls(): JSONObject[] {
    const now = Date.now();
    return Array.from(this._calls.values())
      .filter(call => !call.result)
      .map(call => ({
        pendingId: call.id,
        tool: call.tool,
        command: call.command,
        seconds: Math.round((now - call.startedAt) / 1000)
      }));
  }

  private _start(
    tool: string,
    commandId: string,
    args: ReadonlyJSONObject
  ): Private.ICall {
    const call: Private.ICall = {
      id: `call-${++this._counter}`,
      tool,
      command: commandId,
      startedAt: Date.now(),
      settled: new PromiseDelegate<void>()
    };
    this._calls.set(call.id, call);
    void Promise.resolve()
      .then(() => this._commands.execute(commandId, args))
      .then(toToolResult)
      .catch(error => ({ success: false, error: errorMessage(error) }))
      .then(result => this._finish(call, result));
    return call;
  }

  /**
   * Store the result of a call.
   */
  private _finish(call: Private.ICall, result: JSONObject): void {
    call.result = result;
    call.settledAt = Date.now();
    call.settled.resolve();
    if (call.pending) {
      this._settled.push(call);
      this._prune();
    } else {
      // The agent gets the result at once and has no pendingId.
      this._calls.delete(call.id);
    }
  }

  private async _settle(
    call: Private.ICall,
    timeout: number,
    signal?: AbortSignal
  ): Promise<JSONObject> {
    const deadline = timeout > 0 ? Date.now() + timeout : Infinity;
    for (;;) {
      if (call.result) {
        call.returned = true;
        return { ...call.result };
      }
      const dialog = this._dialogsOf(call).find(
        item => !this._reported.has(item)
      );
      if (dialog) {
        if (dialog.isAttached && Dialogs.isError(dialog)) {
          // An error dialog may not come from the call: report it once, then
          // wait for the result as usual.
          this._reported.add(dialog);
        }
        return this._pending(call, dialog);
      }
      const outcome = await this._race(call, deadline - Date.now(), signal);
      if (outcome === 'dialog') {
        // Give the command a chance to settle and the dialog to show, while
        // the next dialogs of the call are still linked to it.
        await this._race(call, Private.DIALOG_DELAY, signal);
      } else if (outcome !== 'result' && !call.result) {
        return this._pending(call, this._dialogsOf(call)[0]);
      }
    }
  }

  /**
   * Wait for the call to settle, for a dialog of the call, for the timeout
   * or for the cancellation of the tool call.
   */
  private async _race(
    call: Private.ICall,
    timeout: number,
    signal?: AbortSignal
  ): Promise<'result' | 'dialog' | 'timeout' | 'cancel'> {
    const waiter: Private.IWaiter = { call, notify: () => undefined };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: () => void = () => undefined;
    try {
      return await Promise.race([
        call.settled.promise.then(() => 'result' as const),
        new Promise<'dialog'>(resolve => {
          waiter.notify = () => resolve('dialog');
          this._waiters.push(waiter);
        }),
        new Promise<'timeout'>(resolve => {
          if (timeout !== Infinity) {
            timer = setTimeout(() => resolve('timeout'), Math.max(0, timeout));
          }
        }),
        new Promise<'cancel'>(resolve => {
          onAbort = () => resolve('cancel');
          if (signal?.aborted) {
            onAbort();
          }
          signal?.addEventListener('abort', onAbort, { once: true });
        })
      ]);
    } finally {
      this._waiters.splice(this._waiters.indexOf(waiter), 1);
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private _pending(call: Private.ICall, dialog?: Dialog<unknown>): JSONObject {
    call.pending = true;
    const result: JSONObject = {
      status: 'pending',
      pendingId: call.id,
      tool: call.tool
    };
    if (!dialog) {
      const seconds = Math.round((Date.now() - call.startedAt) / 1000);
      result.message = `The call is still running after ${seconds} seconds and continues in the background. Call wait_for_result with this pendingId to get its result. To stop running code, interrupt the kernel.`;
      return result;
    }
    if (!dialog.isAttached) {
      const shown = Dialogs.attached()
        .map(item => Dialogs.idOf(item))
        .join(', ');
      result.message = `A dialog opened while the call ran, queued behind the dialog that is shown (${shown}). That dialog must be closed first: answer it with answer_dialog and its dialogId if it comes from one of your calls (for example an error dialog), else ask the user. Then call wait_for_result.`;
    } else if (Dialogs.isError(dialog)) {
      result.message =
        'An error dialog opened while the call ran, so the call probably failed. Read the dialog, then close it with answer_dialog (or ask the user if it is not from this call).';
    } else {
      result.message =
        'A dialog opened while the call ran, and the call probably waits for an answer. Click a button with answer_dialog (or ask the user if it is not from this call); the call then continues.';
    }
    result.dialog = Dialogs.describe(dialog);
    return result;
  }

  /**
   * The dialogs that opened during a call, shown or queued, in order.
   */
  private _dialogsOf(call: Private.ICall): Dialog<unknown>[] {
    return Array.from(this._owners.keys()).filter(
      dialog => this._owners.get(dialog) === call
    );
  }

  /**
   * Attribute a new dialog to the call being waited for, if there is exactly
   * one. The dialog can also come from the user or another client, so it is
   * only reported, never closed. Other dialogs are only listed in `dialogs`.
   */
  private _onDialogAdded(sender: unknown, dialog: Dialog<unknown>): void {
    const calls = new Set(this._waiters.map(waiter => waiter.call));
    if (calls.size !== 1) {
      return;
    }
    const [call] = calls;
    if (call.result) {
      return;
    }
    this._owners.set(dialog, call);
    dialog.disposed.connect(this._onDialogDisposed, this);
    for (const waiter of this._waiters) {
      waiter.notify();
    }
  }

  private _onDialogDisposed(dialog: Dialog<unknown>): void {
    this._owners.delete(dialog);
  }

  /**
   * Forget the oldest settled calls beyond the limit and the calls that
   * settled a while ago. Running calls are never forgotten.
   */
  private _prune(): void {
    const now = Date.now();
    const settled = this._settled;
    while (
      settled.length > Private.MAX_SETTLED ||
      (settled.length > 0 && now - settled[0].settledAt! > Private.RETENTION)
    ) {
      this._calls.delete(settled.shift()!.id);
    }
  }

  private _commands: CommandRegistry;
  private _isBlocked: (commandId: string) => boolean;
  private _timeout: () => number;
  private _calls = new Map<string, Private.ICall>();
  private _settled: Private.ICall[] = [];
  private _owners = new Map<Dialog<unknown>, Private.ICall>();
  private _reported = new WeakSet<Dialog<unknown>>();
  private _waiters: Private.IWaiter[] = [];
  private _counter = 0;
  private _isDisposed = false;
}

/**
 * A namespace for `CommandExecutor` statics.
 */
export namespace CommandExecutor {
  /**
   * Options to create an executor.
   */
  export interface IOptions {
    /**
     * The command registry.
     */
    commands: CommandRegistry;
    /**
     * Whether agents are forbidden to run a command.
     */
    isBlocked: (commandId: string) => boolean;
    /**
     * Time in milliseconds after which a running call is reported as
     * pending; `0` waits forever.
     */
    timeout: () => number;
  }

  /**
   * Options for `execute`.
   */
  export interface IExecuteOptions {
    /**
     * Name of the tool running the command.
     */
    tool: string;
    /**
     * Aborted when the agent cancels the tool call.
     */
    signal?: AbortSignal;
  }
}

/**
 * The namespace for module private data.
 */
namespace Private {
  /**
   * A command run on behalf of an agent.
   */
  export interface ICall {
    id: string;
    tool: string;
    command: string;
    startedAt: number;
    settledAt?: number;
    result?: JSONObject;
    /**
     * Whether a tool returned a pending result for the call.
     */
    pending?: boolean;
    /**
     * Whether a tool returned the result to the agent.
     */
    returned?: boolean;
    /**
     * Resolved when the call gets its result.
     */
    settled: PromiseDelegate<void>;
  }

  /**
   * A tool waiting for a call.
   */
  export interface IWaiter {
    call: ICall;
    notify: () => void;
  }

  /**
   * Arguments of core notebook and console commands that target a widget
   * by id (`CellBarExtension.WIDGET_ID_ARG` and `SemanticCommand.WIDGET`).
   */
  export const WIDGET_ARG = 'widgetId';
  export const SEMANTIC_WIDGET_ARG = 'semanticWidget';

  /**
   * Milliseconds to wait after a dialog appears before reporting it.
   */
  export const DIALOG_DELAY = 50;

  /**
   * Maximum milliseconds `answer` waits for a call after closing its error
   * dialog.
   */
  export const ERROR_ANSWER_WAIT = 1000;

  /**
   * Milliseconds a settled call stays available to `wait`.
   */
  export const RETENTION = 10 * 60 * 1000;

  /**
   * Maximum number of settled calls kept, among the calls that returned a
   * pending result.
   */
  export const MAX_SETTLED = 50;

  /**
   * The dialog an agent answers: the one given by id, or the only one.
   */
  export function findDialog(
    all: Dialog<unknown>[],
    dialogId: string | undefined
  ): { dialog: Dialog<unknown> } | { error: string } {
    if (all.length === 0) {
      return { error: 'No dialog is open.' };
    }
    let dialog: Dialog<unknown> | undefined;
    if (dialogId) {
      dialog = all.find(item => Dialogs.idOf(item) === dialogId);
    } else if (all.length === 1) {
      dialog = all[0];
    } else {
      return {
        error: 'Several dialogs are open (shown or queued): pass dialogId.'
      };
    }
    if (!dialog) {
      return { error: `No open dialog with id "${dialogId}".` };
    }
    if (!dialog.isAttached) {
      return {
        error: `The dialog "${Dialogs.idOf(dialog)}" is queued behind the dialog that is shown. Only the shown dialog can be answered.`
      };
    }
    return { dialog };
  }

  /**
   * A wait in milliseconds, capped to the execution timeout (`0` waits
   * forever).
   */
  export function cap(timeout: number, limit: number): number {
    return limit > 0 && (timeout <= 0 || timeout > limit) ? limit : timeout;
  }
}
