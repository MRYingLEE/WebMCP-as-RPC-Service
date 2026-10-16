import { JupyterFrontEnd } from '@jupyterlab/application';
import { Dialog } from '@jupyterlab/apputils';
import { Kernel } from '@jupyterlab/services';
import { nullTranslator } from '@jupyterlab/translation';
import { CommandRegistry } from '@lumino/commands';
import { Signal } from '@lumino/signaling';
import { Dialogs } from '../dialogs';
import { IModelContext, IModelContextTool } from '../modelcontext';

/**
 * The translation bundle of the tests.
 */
export const trans = nullTranslator.load('jupyter_webmcp');

/**
 * Resolve after `ms` milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Wait until a condition is true, for at most 3 seconds.
 */
export async function waitFor(condition: () => boolean): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > 3000) {
      throw new Error('Timed out');
    }
    await sleep(5);
  }
}

/**
 * Wait until a dialog is shown with its title: the header is a ReactWidget
 * that renders in a later task.
 */
export function shown(dialog: Dialog<unknown>, title: string): Promise<void> {
  return waitFor(
    () => dialog.isAttached && Dialogs.text(dialog).title === title
  );
}

/**
 * A tool that returns nothing.
 */
export function tool(name: string): IModelContextTool {
  return { name, description: `The ${name} tool.`, execute: () => null };
}

/**
 * Freeze a value and everything it contains, so that a mutation throws.
 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/**
 * A fake `document.modelContext` that follows the WebMCP rules: duplicate
 * names are refused and aborting the signal removes the tool.
 */
export class FakeModelContext implements IModelContext {
  tools = new Map<string, IModelContextTool>();
  /**
   * Names passed to `registerTool`, in order.
   */
  registered: string[] = [];
  /**
   * The signals passed to `registerTool`, by tool name.
   */
  signals = new Map<string, AbortSignal | undefined>();
  active = 0;
  maxActive = 0;
  /**
   * Milliseconds each registration takes.
   */
  delay = 0;
  /**
   * When set, registrations wait for this promise.
   */
  gate: Promise<void> | null = null;
  /**
   * When set, registrations reject with this error.
   */
  error: Error | null = null;

  async registerTool(
    tool: IModelContextTool,
    options: { signal?: AbortSignal } = {}
  ): Promise<void> {
    const { signal } = options;
    this.registered.push(tool.name);
    this.signals.set(tool.name, signal);
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.delay > 0) {
        await sleep(this.delay);
      }
      if (this.gate) {
        await this.gate;
      }
      if (this.error) {
        throw this.error;
      }
      if (this.tools.has(tool.name)) {
        throw new Error(`Duplicate tool name "${tool.name}"`);
      }
      this.tools.set(tool.name, tool);
      signal?.addEventListener('abort', () => this.tools.delete(tool.name), {
        once: true
      });
    } finally {
      this.active--;
    }
  }

  /**
   * Call a registered tool like a browser does.
   */
  call(
    name: string,
    input: Record<string, unknown> = {},
    signal?: AbortSignal
  ): Promise<any> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`No tool "${name}"`);
    }
    return Promise.resolve(tool.execute(input, { signal }));
  }
}

/**
 * A fake kernel connection.
 */
export interface IFakeKernel {
  id: string;
  name: string;
  status: Kernel.Status;
  statusChanged: Signal<IFakeKernel, Kernel.Status>;
  info: Promise<unknown>;
  interrupt: jest.Mock<Promise<void>, []>;
  restart: jest.Mock<Promise<void>, []>;
  dispose: jest.Mock<void, []>;
}

/**
 * Create a fake kernel connection.
 */
export function fakeKernel(id: string, status: Kernel.Status = 'idle') {
  const kernel = {
    id,
    name: 'python3',
    status,
    info: Promise.resolve({}),
    interrupt: jest.fn(() => Promise.resolve()),
    restart: jest.fn(() => Promise.resolve()),
    dispose: jest.fn()
  } as unknown as IFakeKernel;
  kernel.statusChanged = new Signal(kernel);
  return kernel;
}

/**
 * Create a fake application with commands, main area widgets and running
 * kernels. The state can change after the creation.
 */
export function createApp(options: createApp.IOptions = {}) {
  const commands = options.commands ?? new CommandRegistry();
  const state = {
    widgets: options.widgets ?? [],
    current: options.current ?? null,
    kernels: options.kernels ?? []
  };
  const connection = fakeKernel('connection');
  const kernels = {
    refreshRunning: jest.fn(() => Promise.resolve()),
    running: jest.fn(() => state.kernels[Symbol.iterator]()),
    connectTo: jest.fn(() => connection)
  };
  const shell = {
    get currentWidget() {
      return state.current;
    },
    widgets: jest.fn((area?: string) =>
      (area === 'main' ? state.widgets : [])[Symbol.iterator]()
    )
  };
  const app = {
    commands,
    shell,
    serviceManager: { kernels },
    name: 'JupyterLab',
    version: '4.6.0'
  } as unknown as JupyterFrontEnd;
  return { app, commands, connection, kernels, shell, state };
}

/**
 * A namespace for `createApp` statics.
 */
export namespace createApp {
  /**
   * The initial state of the fake application.
   */
  export interface IOptions {
    commands?: CommandRegistry;
    widgets?: unknown[];
    current?: unknown;
    kernels?: Kernel.IModel[];
  }
}
