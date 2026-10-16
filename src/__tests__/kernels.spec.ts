import { SessionContext } from '@jupyterlab/apputils';
import { Signal } from '@lumino/signaling';
import { CommandIDs } from '../commands';
import { KernelCommands } from '../kernels';
import { createApp, fakeKernel, trans } from './utils';

const { interruptKernel: INTERRUPT, restartKernel: RESTART } = CommandIDs;

/**
 * A fake application with the kernel commands.
 */
function setup(kernelIds: string[] = [], widgets: unknown[] = []) {
  const fake = createApp({
    widgets,
    kernels: kernelIds.map(id => ({ id, name: 'python3' }))
  });
  KernelCommands.addCommands(fake.app, trans);
  return fake;
}

/**
 * A fake document widget connected to a kernel.
 */
function documentWidget(kernelId: string) {
  const kernel = fakeKernel(kernelId);
  const sessionContext = {
    session: { kernel },
    isReady: true,
    isRestarting: false,
    restartKernel: jest.fn(() => Promise.resolve())
  };
  return { kernel, sessionContext, widget: { sessionContext } };
}

describe('KernelCommands', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('adds the commands with a kernelId argument', async () => {
    const { commands } = setup();
    expect(commands.label(INTERRUPT)).toBe('Interrupt Kernel by ID');
    expect(commands.label(RESTART)).toBe('Restart Kernel by ID');
    for (const id of [INTERRUPT, RESTART]) {
      expect(await commands.describedBy(id)).toEqual({
        args: {
          type: 'object',
          properties: {
            kernelId: {
              type: 'string',
              description: 'The ID of a running kernel.'
            }
          },
          required: ['kernelId']
        }
      });
    }
  });

  it('returns an error for an unknown or missing kernel id', async () => {
    const { commands, kernels } = setup(['k1']);
    for (const id of [INTERRUPT, RESTART]) {
      expect(await commands.execute(id, { kernelId: 'nope' })).toEqual({
        success: false,
        error:
          'No running kernel with id "nope". The kernels are listed by get_context.'
      });
    }
    expect(await commands.execute(INTERRUPT, {})).toMatchObject({
      success: false,
      error: expect.stringContaining('No running kernel with id ""')
    });
    expect(kernels.connectTo).not.toHaveBeenCalled();
  });

  it('refreshes the running kernels before looking up the id', async () => {
    const { commands, connection, kernels, state } = setup();
    kernels.refreshRunning.mockImplementation(() => {
      state.kernels = [{ id: 'k-new', name: 'python3' }];
      return Promise.resolve();
    });
    expect(await commands.execute(INTERRUPT, { kernelId: 'k-new' })).toEqual({
      success: true,
      kernelId: 'k-new',
      message: 'The kernel was interrupted.'
    });
    expect(connection.interrupt).toHaveBeenCalled();
  });

  it('acts through the session of an open document', async () => {
    const doc = documentWidget('k1');
    const { commands, kernels, shell } = setup(['k1'], [{}, doc.widget]);
    expect(await commands.execute(INTERRUPT, { kernelId: 'k1' })).toEqual({
      success: true,
      kernelId: 'k1',
      message: 'The kernel was interrupted.'
    });
    expect(shell.widgets).toHaveBeenCalledWith('main');
    expect(doc.kernel.interrupt).toHaveBeenCalledTimes(1);
    expect(await commands.execute(RESTART, { kernelId: 'k1' })).toEqual({
      success: true,
      kernelId: 'k1',
      message: 'The kernel was restarted.'
    });
    expect(doc.sessionContext.restartKernel).toHaveBeenCalledTimes(1);
    expect(doc.kernel.restart).not.toHaveBeenCalled();
    expect(kernels.connectTo).not.toHaveBeenCalled();
  });

  it('uses a temporary connection for other kernels', async () => {
    const other = documentWidget('k-other');
    const { commands, connection, kernels, state } = setup(
      ['k1', 'k-other'],
      [other.widget, { sessionContext: { session: null } }]
    );
    expect(await commands.execute(INTERRUPT, { kernelId: 'k1' })).toMatchObject(
      {
        success: true
      }
    );
    expect(kernels.connectTo).toHaveBeenCalledWith({
      model: state.kernels[0],
      handleComms: false
    });
    expect(connection.interrupt).toHaveBeenCalledTimes(1);
    expect(await commands.execute(RESTART, { kernelId: 'k1' })).toMatchObject({
      success: true
    });
    expect(connection.restart).toHaveBeenCalledTimes(1);
    expect(connection.dispose).toHaveBeenCalledTimes(2);
    expect(other.kernel.interrupt).not.toHaveBeenCalled();
    expect(other.sessionContext.restartKernel).not.toHaveBeenCalled();
  });

  it('warns when the kernel stays busy after an interrupt', async () => {
    jest.useFakeTimers();
    const doc = documentWidget('k1');
    doc.kernel.status = 'busy';
    const { commands } = setup(['k1'], [doc.widget]);
    let settled = false;
    const result = commands.execute(INTERRUPT, { kernelId: 'k1' });
    void result.then(() => (settled = true));
    await jest.advanceTimersByTimeAsync(500);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1000);
    expect(settled).toBe(true);
    expect(await result).toEqual({
      success: true,
      kernelId: 'k1',
      message: 'The interrupt was sent to the kernel.',
      warning:
        'The kernel is still busy and may not support interrupts (for example Pyodide in JupyterLite): restart_kernel stops it.'
    });
  });

  it('warns when a busy kernel does not answer a new connection', async () => {
    jest.useFakeTimers();
    const { commands, connection } = setup(['k1']);
    // A new connection does not get the status of a kernel already busy.
    connection.status = 'unknown';
    connection.info = new Promise(() => undefined);
    let settled = false;
    const result = commands.execute(INTERRUPT, { kernelId: 'k1' });
    void result.then(() => (settled = true));
    await jest.advanceTimersByTimeAsync(500);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1000);
    expect(await result).toEqual({
      success: true,
      kernelId: 'k1',
      message: 'The interrupt was sent to the kernel.',
      warning:
        'The kernel is still busy and may not support interrupts (for example Pyodide in JupyterLite): restart_kernel stops it.'
    });
  });

  it('does not warn when a new connection gets the kernel info', async () => {
    const { commands, connection } = setup(['k1']);
    connection.status = 'unknown';
    expect(await commands.execute(INTERRUPT, { kernelId: 'k1' })).toEqual({
      success: true,
      kernelId: 'k1',
      message: 'The kernel was interrupted.'
    });
    connection.info = Promise.reject(new Error('Kernel info reply errored'));
    connection.info.catch(() => undefined);
    expect(await commands.execute(INTERRUPT, { kernelId: 'k1' })).toEqual({
      success: true,
      kernelId: 'k1',
      message: 'The kernel was interrupted.'
    });
  });

  it('does not warn when the kernel leaves the busy status', async () => {
    const doc = documentWidget('k1');
    doc.kernel.status = 'busy';
    doc.kernel.interrupt.mockImplementation(() => {
      setTimeout(() => {
        doc.kernel.status = 'idle';
        doc.kernel.statusChanged.emit('idle');
      }, 10);
      return Promise.resolve();
    });
    const { commands } = setup(['k1'], [doc.widget]);
    const start = Date.now();
    expect(await commands.execute(INTERRUPT, { kernelId: 'k1' })).toEqual({
      success: true,
      kernelId: 'k1',
      message: 'The kernel was interrupted.'
    });
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('returns errors as data and disposes the temporary connection', async () => {
    const { commands, connection } = setup(['k1']);
    connection.interrupt.mockImplementation(() =>
      Promise.reject(new Error('Kernel is dead'))
    );
    connection.restart.mockImplementation(() =>
      Promise.reject(new Error('Restart failed'))
    );
    expect(await commands.execute(INTERRUPT, { kernelId: 'k1' })).toEqual({
      success: false,
      kernelId: 'k1',
      error: 'Kernel is dead'
    });
    expect(await commands.execute(RESTART, { kernelId: 'k1' })).toEqual({
      success: false,
      kernelId: 'k1',
      error: 'Restart failed'
    });
    expect(connection.dispose).toHaveBeenCalledTimes(2);
  });

  it('returns the errors of the kernel manager as data', async () => {
    const { commands, connection, kernels } = setup(['k1']);
    kernels.refreshRunning.mockImplementationOnce(() =>
      Promise.reject(new Error('Server unreachable'))
    );
    expect(await commands.execute(INTERRUPT, { kernelId: 'k1' })).toEqual({
      success: false,
      kernelId: 'k1',
      error: 'Server unreachable'
    });
    kernels.connectTo.mockImplementationOnce(() => {
      throw new Error('No connection');
    });
    expect(await commands.execute(RESTART, { kernelId: 'k1' })).toEqual({
      success: false,
      kernelId: 'k1',
      error: 'No connection'
    });
    expect(connection.dispose).not.toHaveBeenCalled();
  });

  it('reports a restart already in progress', async () => {
    const doc = documentWidget('k1');
    doc.sessionContext.isRestarting = true;
    const { commands } = setup(['k1'], [doc.widget]);
    expect(await commands.execute(RESTART, { kernelId: 'k1' })).toEqual({
      success: false,
      kernelId: 'k1',
      error: 'A restart of this kernel is already in progress.'
    });
    expect(doc.sessionContext.restartKernel).not.toHaveBeenCalled();
  });

  it('reports a failed restart through a real SessionContext', async () => {
    // `SessionContext.restartKernel` logs the restart error and resolves.
    const logged = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const kernel = {
      id: 'k1',
      status: 'dead',
      restart: jest.fn(() => Promise.reject(new Error('Restart failed')))
    };
    const sessionContext = Object.create(SessionContext.prototype);
    Object.assign(sessionContext, {
      _session: { kernel },
      _isRestarting: false,
      _isReady: true,
      _statusChanged: new Signal(sessionContext),
      _kernelChanged: new Signal(sessionContext)
    });
    const { commands } = setup(['k1'], [{ sessionContext }]);
    expect(await commands.execute(RESTART, { kernelId: 'k1' })).toEqual({
      success: false,
      kernelId: 'k1',
      error: 'The kernel could not be restarted.'
    });
    expect(kernel.restart).toHaveBeenCalled();
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
