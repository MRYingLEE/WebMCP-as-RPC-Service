import { JupyterFrontEnd } from '@jupyterlab/application';
import { ISessionContext } from '@jupyterlab/apputils';
import { Kernel } from '@jupyterlab/services';
import { TranslationBundle } from '@jupyterlab/translation';
import { JSONObject } from '@lumino/coreutils';
import { CommandIDs } from './commands';
import { errorMessage, withTimeout } from './utils';

/**
 * Commands controlling a kernel by id, which core commands cannot do: they
 * act on the active notebook or console and ask for confirmation.
 */
export namespace KernelCommands {
  /**
   * Add the kernel commands to the application.
   */
  export function addCommands(
    app: JupyterFrontEnd,
    trans: TranslationBundle
  ): void {
    const describedBy = {
      args: {
        type: 'object',
        properties: {
          kernelId: {
            type: 'string',
            description: trans.__('The ID of a running kernel.')
          }
        },
        required: ['kernelId']
      }
    };
    app.commands.addCommand(CommandIDs.interruptKernel, {
      label: trans.__('Interrupt Kernel by ID'),
      caption: trans.__('Interrupt the code running in a kernel'),
      describedBy,
      execute: args =>
        Private.run(app, args.kernelId, async (session, kernel) => {
          const target = (session?.session?.kernel ?? kernel)!;
          const result: JSONObject = { message: 'The kernel was interrupted.' };
          await target.interrupt();
          if (await Private.staysBusy(target)) {
            result.message = 'The interrupt was sent to the kernel.';
            result.warning =
              'The kernel is still busy and may not support interrupts (for example Pyodide in JupyterLite): restart_kernel stops it.';
          }
          return result;
        })
    });
    app.commands.addCommand(CommandIDs.restartKernel, {
      label: trans.__('Restart Kernel by ID'),
      caption: trans.__('Restart a kernel without confirmation'),
      describedBy,
      execute: args =>
        Private.run(app, args.kernelId, async (session, kernel) => {
          if (session) {
            if (session.isRestarting) {
              throw new Error(
                'A restart of this kernel is already in progress.'
              );
            }
            // `restartKernel` logs failures instead of throwing them.
            await session.restartKernel();
            if (!session.isReady) {
              throw new Error('The kernel could not be restarted.');
            }
          } else {
            await kernel!.restart();
          }
          return { message: 'The kernel was restarted.' };
        })
    });
  }
}

/**
 * The namespace for module private data.
 */
namespace Private {
  /**
   * Milliseconds an interrupted kernel has to leave the busy status.
   */
  export const INTERRUPT_DELAY = 1000;

  /**
   * Run an action on a running kernel.
   *
   * The session of an open document is preferred, so that the document
   * updates its state as for an action from the UI. Other kernels get a
   * temporary connection.
   */
  export async function run(
    app: JupyterFrontEnd,
    kernelId: unknown,
    action: (
      session: ISessionContext | null,
      kernel: Kernel.IKernelConnection | null
    ) => Promise<JSONObject>
  ): Promise<JSONObject> {
    const id = String(kernelId ?? '');
    let kernel: Kernel.IKernelConnection | null = null;
    try {
      const { kernels } = app.serviceManager;
      await kernels.refreshRunning();
      const model = Array.from(kernels.running()).find(item => item.id === id);
      if (!model) {
        return {
          success: false,
          error: `No running kernel with id "${id}". The kernels are listed by get_context.`
        };
      }
      const session = findSession(app, id);
      if (!session) {
        // Leave the comms to the existing connections of the documents.
        kernel = kernels.connectTo({ model, handleComms: false });
      }
      return {
        success: true,
        kernelId: id,
        ...(await action(session, kernel))
      };
    } catch (error) {
      return { success: false, kernelId: id, error: errorMessage(error) };
    } finally {
      kernel?.dispose();
    }
  }

  /**
   * Whether a busy kernel is still busy after `INTERRUPT_DELAY`.
   */
  export async function staysBusy(
    kernel: Kernel.IKernelConnection
  ): Promise<boolean> {
    if (kernel.status === 'unknown') {
      // A new connection gets no status from a kernel that is already busy,
      // and the kernel answers its kernel info request only when free.
      return withTimeout(
        kernel.info.then(
          () => false,
          () => false
        ),
        INTERRUPT_DELAY,
        true
      );
    }
    if (kernel.status !== 'busy') {
      return false;
    }
    await new Promise<void>(resolve => {
      const done = () => {
        clearTimeout(timer);
        kernel.statusChanged.disconnect(onStatus);
        resolve();
      };
      const onStatus = (
        sender: Kernel.IKernelConnection,
        status: Kernel.Status
      ) => {
        if (status !== 'busy') {
          done();
        }
      };
      const timer = setTimeout(done, INTERRUPT_DELAY);
      kernel.statusChanged.connect(onStatus);
    });
    return kernel.status === 'busy';
  }

  /**
   * The session of an open document connected to a kernel.
   */
  function findSession(
    app: JupyterFrontEnd,
    kernelId: string
  ): ISessionContext | null {
    for (const widget of app.shell.widgets('main')) {
      const session = (widget as { sessionContext?: ISessionContext })
        .sessionContext;
      if (session?.session?.kernel?.id === kernelId) {
        return session;
      }
    }
    return null;
  }
}
