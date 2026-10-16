/**
 * The id of the main plugin, also the id of its settings.
 */
export const PLUGIN_ID = 'jupyter-webmcp:plugin';

/**
 * The prefix of the messages logged by the extension.
 */
export const LOG_PREFIX = '[jupyter-webmcp]';

/**
 * The command ids of the extension.
 */
export namespace CommandIDs {
  export const showTools = 'jupyter-webmcp:show-tools';

  export const interruptKernel = 'jupyter-webmcp:interrupt-kernel';

  export const restartKernel = 'jupyter-webmcp:restart-kernel';
}
