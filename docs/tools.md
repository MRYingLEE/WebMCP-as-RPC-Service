# Tools

The extension registers two kinds of tools: built-in tools, which only this extension provides, and command-backed tools, which run one command each. The [`tools` setting](settings.md) adds command-backed tools.

Hints: R = `readOnlyHint`, C = `consequentialHint`, U = `untrustedContentHint`. In the inputs, **bold** means required. The results follow the [result protocol](results.md).

## Built-in tools

These tools are always registered, unless [`disabledTools`](settings.md) names them. Tools from the settings cannot use their names.

| Tool                | Inputs                     | What it does                                                                                                         | Hints |
| ------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----- |
| `get_context`       | none                       | Describes the page: documents, current editor, kernels, file browser directory, dialogs, pending calls               | R, U  |
| `list_all_commands` | `query`, `limit` (50)      | Finds commands: every word of `query` must appear in the id, label, caption or usage                                 | R, U  |
| `execute_command`   | **`command_id`**, `args`   | Runs any command. `args` is an object or a JSON string                                                               | C, U  |
| `answer_dialog`     | **`button`**, `dialogId`   | Clicks a button (label or 0-based index) of the dialog that is shown, then returns the result of the call that waits | C, U  |
| `wait_for_result`   | **`pendingId`**, `timeout` | Waits for a pending call and returns its final result                                                                | R, U  |

### get_context

The result has these fields:

- `app`: the name and version of the application, for example `{"name": "Jupyter Notebook", "version": "7.6.3"}`.
- `fileBrowserPath`: the directory of the file browser, or `null` when the page has no file browser.
- `currentWidgetId`: the id of the current widget, or `null`.
- `currentEditor`: the editor of the current widget (the active cell of a notebook, a file editor or a console prompt), or `null`. It has `cellId` (in a notebook), `cursor: {line, column}` and, when text is selected, `selection: {start, end, text}`. Lines and columns start at 1, and `text` keeps 2000 characters.
- `widgets`: the widgets of the main area, as `{type, id, title, path, dirty, kernel: {id, name, status}, notebook: {cellCount, activeCellIndex, activeCellId, activeCellType}}`. Only the fields that apply are present. A disposed widget is `{type, disposed: true}`.
- `kernels`: the running kernels, as `{id, name, status}`. The list is refreshed first (2 seconds at most). The kernel of an open document has the status that the document shows.
- `dialogs`: the open dialogs (see [dialogs](results.md#dialogs)).
- `pending`: the calls that are still running, as `{pendingId, tool, command, seconds}`.
- `note`: only on a page that shows one document (Jupyter Notebook 7, the notebooks UI of JupyterLite).

### list_all_commands

The search ignores case. Blocked commands are not listed. The result is `{success, commandCount, commands}`, where `commandCount` is the number of matching commands and `commands` lists the first `limit` of them. Each command has:

- `id` and `label`, plus `caption` and `description` (the usage text) when they add text;
- `args`: the JSON schema of the arguments, without the arguments used only by the UI. It describes the arguments, it does not give values;
- `enabled`: whether the command is enabled now;
- `toggled`: for a toggle command, whether it is on now;
- `tool`: the tool that runs the command, if there is one.

### execute_command

`execute_command` does not check `args`. Most notebook and console commands act on the active document: to target another open notebook or console, add `"semanticWidget": "<widget id from get_context>"` and `"activate": false` to `args`. Only `notebook:*` and `console:*` commands take `semanticWidget` and `widgetId`. Other commands, such as the menu commands that run them, act on the current widget: with these arguments, `execute_command` returns an error and does not run the command.

## Default tools

These tools are registered while their command exists. `ai:` means `jupyterlab-ai-commands:`. Fixed arguments are hidden from the agent and always passed to the command.

| Tool               | Inputs                                                                   | Command                           | Fixed arguments                                              | Hints |
| ------------------ | ------------------------------------------------------------------------ | --------------------------------- | ------------------------------------------------------------ | ----- |
| `open_document`    | **`path`**, `factory`, `options`                                         | `docmanager:open`                 |                                                              |       |
| `list_directory`   | `path`, `includeHidden`                                                  | `ai:list-directory`               |                                                              | R, U  |
| `read_file`        | **`filePath`**                                                           | `ai:get-file-info`                | `background: true`, `createWidget: false`                    | R, U  |
| `write_file`       | **`filePath`**, **`content`**                                            | `ai:set-file-content`             | `background: true`, `save: true`, `showDiff: false`          | C     |
| `create_file`      | **`fileName`**, `fileType`, `content`, `cwd`                             | `ai:create-file`                  | `background: true`                                           |       |
| `create_notebook`  | **`name`**, `language`                                                   | `ai:create-notebook`              | `background: true`                                           |       |
| `read_notebook`    | **`notebookPath`**                                                       | `ai:get-notebook-content`         | `background: true`, `createWidget: false`                    | R, U  |
| `read_cell`        | **`notebookPath`**, **`cellId`**                                         | `ai:get-cell-info`                | `background: true`, `createWidget: false`                    | R, U  |
| `add_cell`         | **`notebookPath`**, `referenceCellId`, `content`, `cellType`, `position` | `ai:add-cell`                     | `background: true`                                           |       |
| `edit_cell`        | **`notebookPath`**, **`cellId`**, **`content`**                          | `ai:set-cell-content`             | `background: true`, `diffMode: "unified"`, `showDiff: false` | U     |
| `delete_cell`      | **`notebookPath`**, **`cellId`**                                         | `ai:delete-cell`                  | `background: true`                                           | C     |
| `run_cell`         | **`notebookPath`**, **`cellId`**                                         | `ai:run-cell`                     | `background: true`, `recordTiming: true`                     | C, U  |
| `save_notebook`    | **`notebookPath`**                                                       | `ai:save-notebook`                | `background: true`                                           |       |
| `run_code`         | **`kernelId`**, **`code`**, `stopOnError`                                | `ai:execute-in-kernel`            | `silent: false`, `storeHistory: true`                        | C, U  |
| `interrupt_kernel` | **`kernelId`**                                                           | `jupyter-webmcp:interrupt-kernel` |                                                              |       |
| `restart_kernel`   | **`kernelId`**                                                           | `jupyter-webmcp:restart-kernel`   |                                                              | C     |

- With jupyterlab-ai-commands, a page has 21 tools. Without it, 8 tools remain: the 5 built-in tools, `open_document` and the two kernel tools.
- `open_document` shows only the `path`, `factory` and `options` arguments of `docmanager:open`. It opens the file, or brings its tab to the front. On a page that shows one document, the document opens in a new browser tab and the result has `result: {type, disposed: true}`.
- The notebook tools require `notebookPath`: without it, jupyterlab-ai-commands uses the active notebook, so a call could edit another notebook.
- `read_notebook` gives no cell ids for a notebook older than nbformat 4.5 (see [upstream issues](frontends.md#upstream-issues)).
- `interrupt_kernel` and `restart_kernel` take the id of any running kernel and do not ask for confirmation. The kernel of an open document is controlled through the session of that document, so the document shows the new state. Other kernels get a temporary connection.
- After an interrupt, `interrupt_kernel` waits up to 1 second for the kernel to stop. When the kernel is still busy, the result has a `warning` that tells the agent to use `restart_kernel`.

## Input checks

Browsers do not check the input against the schema, and commands ignore unknown arguments. So the command-backed tools check the input before they run the command:

- An unknown argument is an error that lists the accepted arguments. This applies to every command that declares its arguments, also when all of them are fixed, so that a misnamed argument is an error and does not change the target of the command. A command that declares no arguments gets unknown arguments unchanged.
- A missing required argument is an error. `null` counts as missing. A blank string also counts as missing for a required argument named `id` or with a name that ends with `Id`, `ID`, `_id`, `name`, `Name`, `path` or `Path`: an empty path makes commands use the active document.
- A value of the wrong JSON type (`string`, `number`, `integer`, `boolean`, `array` or `object`) is an error.
- `null` for an optional argument is ignored. The arguments used only by the UI (`toolbar`, `isPalette`, `isLauncher`, `isContextMenu`, `_luminoEvent`) are ignored too.
