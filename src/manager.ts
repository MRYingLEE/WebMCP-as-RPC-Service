import { ILabShell, JupyterFrontEnd } from '@jupyterlab/application';
import { IDefaultFileBrowser } from '@jupyterlab/filebrowser';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { TranslationBundle } from '@jupyterlab/translation';
import { CommandRegistry } from '@lumino/commands';
import { IDisposable } from '@lumino/disposable';
import { Signal } from '@lumino/signaling';
import { LOG_PREFIX } from './commands';
import { CommandExecutor } from './execution';
import { IModelContextTool } from './modelcontext';
import {
  DEFAULT_TOOLS,
  ICommandToolSpec,
  toToolName,
  validateSpec
} from './specs';
import { IWebMCPRegistry } from './tokens';
import { Tools } from './tools';
import {
  errorMessage,
  globMatcher,
  globToRegExp,
  isGlob,
  safely
} from './utils';

/**
 * Keeps the registered WebMCP tools in sync with the settings and with the
 * command registry.
 */
export class ToolManager implements IDisposable {
  /**
   * Construct a new manager.
   */
  constructor(options: ToolManager.IOptions) {
    this._app = options.app;
    this._registry = options.registry;
    this._trans = options.trans;
    this._executor = new CommandExecutor({
      commands: options.app.commands,
      isBlocked: id => this.isBlocked(id),
      timeout: () => this._config.executionTimeout * 1000
    });
    this._toolOptions = {
      app: options.app,
      executor: this._executor,
      isBlocked: id => this.isBlocked(id),
      toolFor: id => this._toolFor(id),
      maxResultLength: () => this._config.maxResultLength,
      fileBrowser: options.fileBrowser ?? null,
      labShell: options.labShell ?? null,
      trans: options.trans
    };
  }

  /**
   * The error that prevents the tools from being registered, if any.
   */
  get error(): string | null {
    return this._error;
  }

  /**
   * Translated problems found in the configured tools.
   */
  get warnings(): readonly string[] {
    return this._warnings;
  }

  /**
   * The registered tools, with the command they run (`null` for the
   * built-in tools).
   */
  get tools(): ReadonlyMap<string, string | null> {
    const tools = new Map<string, string | null>();
    for (const [name, entry] of this._registered) {
      tools.set(name, entry.command);
    }
    return tools;
  }

  /**
   * Whether the manager is disposed.
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Whether tools must not run a command (it matches `blockedCommands`).
   */
  isBlocked(commandId: string): boolean {
    return this._blocked(commandId);
  }

  /**
   * Start syncing the tools with the settings and the commands.
   */
  start(settings: ISettingRegistry.ISettings): void {
    this._readSettings(settings);
    settings.changed.connect(this._onSettingsChanged, this);
    this._app.commands.commandChanged.connect(this._onCommandChanged, this);
    this._registry.changed.connect(this._onRegistryChanged, this);
    this.sync();
  }

  /**
   * Remove every tool and report an error. Used when the tools cannot start,
   * for example when the settings cannot be loaded (the defaults would drop
   * the blocked commands).
   */
  fail(reason: unknown): void {
    this._error = errorMessage(reason);
    this._unregisterAll();
  }

  /**
   * Schedule a synchronization of the registered tools.
   *
   * Requests are batched, and synchronizations never overlap.
   */
  sync(): void {
    if (!this._registry.isAvailable || this._error || this._isDisposed) {
      return;
    }
    if (this._syncing) {
      this._pending = true;
      return;
    }
    this._syncing = new Promise(resolve => setTimeout(resolve, 0))
      .then(() => {
        // Requests made before this point are covered by this pass.
        this._pending = false;
        return this._sync();
      })
      .catch(error => {
        console.error(`${LOG_PREFIX} Failed to sync the tools:`, error);
      })
      .finally(() => {
        this._syncing = null;
        if (this._pending) {
          this._pending = false;
          this.sync();
        }
      });
  }

  /**
   * Dispose of the resources held by the manager.
   */
  dispose(): void {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    this._unregisterAll();
    this._executor.dispose();
    Signal.clearData(this);
  }

  private _onSettingsChanged(settings: ISettingRegistry.ISettings): void {
    this._readSettings(settings);
    this.sync();
  }

  private _onCommandChanged(
    sender: CommandRegistry,
    args: CommandRegistry.ICommandChangedArgs
  ): void {
    // Labels and states change often; only the set of commands matters.
    if (args.type === 'added' || args.type === 'removed') {
      this.sync();
    }
  }

  /**
   * Retry the tools whose names were taken, since other extensions may have
   * released them.
   */
  private _onRegistryChanged(): void {
    if (this._retry) {
      this.sync();
    }
  }

  private _readSettings(settings: ISettingRegistry.ISettings): void {
    const config = Private.toConfig(settings.composite);
    // Administrators set guardrails as defaults (overrides.json): keep them
    // when the user settings replace these lists.
    for (const key of ['blockedCommands', 'disabledTools'] as const) {
      const defaults = Private.strings(
        safely(() => settings.default(key), undefined)
      );
      config[key] = Array.from(new Set([...defaults, ...config[key]]));
    }
    this._config = config;
    this._blocked = globMatcher(config.blockedCommands);
    this._disabled = globMatcher(config.disabledTools);
  }

  /**
   * The tools to register, by name.
   */
  private _desired(warnings: string[]): Map<string, Private.IDesired> {
    const trans = this._trans;
    const desired = new Map<string, Private.IDesired>();
    for (const tool of Tools.builtinTools(this._toolOptions)) {
      if (!this._disabled(tool.name)) {
        desired.set(tool.name, {
          key: 'builtin',
          command: null,
          build: () => Promise.resolve(tool)
        });
      }
    }

    const specs: ICommandToolSpec[] = [];
    const replaced = new Set<string>();
    this._config.tools.forEach((spec, index) => {
      const error = validateSpec(spec, trans);
      if (error) {
        warnings.push(trans.__('tools[%1] is ignored: %2.', index, error));
        return;
      }
      specs.push(spec);
      if (spec.name) {
        replaced.add(spec.name);
      }
    });
    specs.push(...DEFAULT_TOOLS.filter(spec => !replaced.has(spec.name!)));

    const { commands } = this._app;
    const ids = commands.listCommands().sort();
    for (const spec of specs) {
      const glob = isGlob(spec.command);
      let matching: string[] = [];
      if (glob) {
        const pattern = globToRegExp(spec.command);
        matching = ids.filter(id => pattern.test(id));
      } else if (commands.hasCommand(spec.command)) {
        matching = [spec.command];
      }
      for (const id of matching) {
        if (this.isBlocked(id)) {
          continue;
        }
        const name = spec.name ?? toToolName(id);
        if (desired.has(name) || Tools.BUILTIN_NAMES.includes(name)) {
          if (!glob) {
            warnings.push(
              trans.__(
                'The tool "%1" for "%2" is ignored: another tool has this name.',
                name,
                id
              )
            );
          }
          continue;
        }
        if (this._disabled(name)) {
          continue;
        }
        desired.set(name, {
          key: JSON.stringify([id, spec]),
          command: id,
          build: () => Tools.commandTool(this._toolOptions, spec, id, name)
        });
      }
    }
    return desired;
  }

  private async _sync(): Promise<void> {
    const warnings: string[] = [];
    const desired = this._desired(warnings);
    for (const [name, entry] of this._registered) {
      if (desired.get(name)?.key !== entry.key) {
        entry.registration.dispose();
        this._registered.delete(name);
      }
    }
    let retry = false;
    for (const [name, entry] of desired) {
      if (this._registered.has(name)) {
        continue;
      }
      try {
        const registration = await this._registry.registerTool(
          await entry.build()
        );
        if (this._error || this._isDisposed) {
          // `fail` or `dispose` was called during the registration.
          registration.dispose();
          return;
        }
        this._registered.set(name, { ...entry, registration });
      } catch (error) {
        retry = true;
        warnings.push(
          this._trans.__(
            'The tool "%1" could not be registered: %2',
            name,
            errorMessage(error)
          )
        );
      }
    }
    for (const warning of warnings) {
      if (!this._warnings.includes(warning)) {
        console.warn(`${LOG_PREFIX} ${warning}`);
      }
    }
    this._warnings = warnings;
    this._retry = retry;
  }

  private _toolFor(commandId: string): string | undefined {
    for (const [name, entry] of this._registered) {
      if (entry.command === commandId) {
        return name;
      }
    }
    return undefined;
  }

  private _unregisterAll(): void {
    for (const entry of this._registered.values()) {
      entry.registration.dispose();
    }
    this._registered.clear();
  }

  private _app: JupyterFrontEnd;
  private _registry: IWebMCPRegistry;
  private _trans: TranslationBundle;
  private _executor: CommandExecutor;
  private _toolOptions: Tools.IOptions;
  private _config = Private.toConfig({});
  private _blocked: (commandId: string) => boolean = () => false;
  private _disabled: (name: string) => boolean = () => false;
  private _registered = new Map<string, Private.IRegistered>();
  private _warnings: string[] = [];
  private _retry = false;
  private _error: string | null = null;
  private _syncing: Promise<void> | null = null;
  private _pending = false;
  private _isDisposed = false;
}

/**
 * A namespace for `ToolManager` statics.
 */
export namespace ToolManager {
  /**
   * Options to create a manager.
   */
  export interface IOptions {
    /**
     * The application.
     */
    app: JupyterFrontEnd;
    /**
     * The registry the tools are registered with.
     */
    registry: IWebMCPRegistry;
    /**
     * The translation bundle.
     */
    trans: TranslationBundle;
    /**
     * The default file browser, if any.
     */
    fileBrowser?: IDefaultFileBrowser | null;
    /**
     * The JupyterLab shell, if the app has one.
     */
    labShell?: ILabShell | null;
  }
}

/**
 * The namespace for module private data.
 */
namespace Private {
  /**
   * The extension settings, mirroring the settings schema.
   */
  export interface IConfig {
    /**
     * Command-backed tools added to the defaults; a tool with the name of a
     * default tool replaces it.
     */
    tools: ICommandToolSpec[];
    /**
     * Glob patterns of tool names that are not registered.
     */
    disabledTools: string[];
    /**
     * Glob patterns of command ids that tools never run.
     */
    blockedCommands: string[];
    /**
     * Seconds after which a running call is reported as pending (`0` waits
     * forever).
     */
    executionTimeout: number;
    /**
     * Maximum length of a tool result, in JSON characters.
     */
    maxResultLength: number;
  }

  /**
   * Bounds of the numeric settings; the schema only states them in its
   * descriptions.
   */
  export const MAX_EXECUTION_TIMEOUT = 3600;
  export const MIN_RESULT_LENGTH = 1000;

  /**
   * The strings of a list, or none when the value is not a list.
   */
  export function strings(value: unknown): string[] {
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
  }

  /**
   * Read the configuration from the settings, ignoring invalid values.
   */
  export function toConfig(composite: unknown): IConfig {
    const values = (composite ?? {}) as Record<string, unknown>;
    const number = (value: unknown, fallback: number): number =>
      typeof value === 'number' && value >= 0 ? value : fallback;
    return {
      tools: Array.isArray(values.tools) ? values.tools : [],
      disabledTools: strings(values.disabledTools),
      blockedCommands: strings(values.blockedCommands),
      executionTimeout: Math.min(
        MAX_EXECUTION_TIMEOUT,
        number(values.executionTimeout, 20)
      ),
      maxResultLength: Math.max(
        MIN_RESULT_LENGTH,
        number(values.maxResultLength, 40000)
      )
    };
  }

  /**
   * A tool to register.
   */
  export interface IDesired {
    /**
     * Changes when the tool must be registered again.
     */
    key: string;
    /**
     * The command run by the tool, `null` for built-in tools.
     */
    command: string | null;
    /**
     * Build the tool.
     */
    build: () => Promise<IModelContextTool>;
  }

  /**
   * A registered tool.
   */
  export interface IRegistered extends IDesired {
    /**
     * Removes the tool.
     */
    registration: IDisposable;
  }
}
