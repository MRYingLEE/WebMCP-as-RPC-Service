# Settings

Change the settings in **Settings → Settings Editor → WebMCP**. Use the JSON editor for `tools`. The **Show WebMCP Tools** command lists the registered tools and the problems found in the settings.

| Setting            | Default                                                      | Description                                                                                                                  |
| ------------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `tools`            | `[]`                                                         | Command-backed tools added to the default tools. A tool with the name of a default tool replaces it                          |
| `disabledTools`    | `[]`                                                         | Names of the tools that are not registered, built-in tools included. Globs with `*` and `?`                                  |
| `blockedCommands`  | `["apputils:run-all-enabled", "apputils:run-first-enabled"]` | Ids of the commands that the tools never run or list. No tool is made for them. Globs with `*` and `?`                       |
| `executionTimeout` | `20`                                                         | Seconds after which a running call returns a pending result and continues in the background. `0` waits forever; at most 3600 |
| `maxResultLength`  | `40000`                                                      | Maximum length of a result, in JSON characters. A value below 1000 counts as 1000                                            |

## Tool specs

An entry of `tools` has these fields:

| Field         | Description                                                                                                                                                                                                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`     | A command id, or a glob that makes one tool for each matching command. With a glob, the only other field allowed is `annotations`                                                                                                                                                            |
| `name`        | The tool name: 1 to 64 letters, digits, `_` or `-`. Prefer `_`: some MCP clients change `-`. By default, the command id with each run of other characters replaced by one `_`, without a leading or trailing `_` (at most 64 characters), so `notebook:run-cell` becomes `notebook_run_cell` |
| `description` | The description for the agent. By default, `<caption, label or id>. Runs the Jupyter command "<id>".`                                                                                                                                                                                        |
| `args`        | Fixed arguments, hidden from the agent and always passed to the command                                                                                                                                                                                                                      |
| `inputs`      | The arguments shown to the agent, to hide the other arguments of a command with a large schema. By default, all the arguments                                                                                                                                                                |
| `required`    | Arguments that the agent must give, in addition to the ones that the command requires                                                                                                                                                                                                        |
| `annotations` | `readOnlyHint`, `consequentialHint` and `untrustedContentHint`. By default, `consequentialHint` for commands with a verb such as delete, run, restart or shut-down                                                                                                                           |

- The input schema comes from the `describedBy` arguments of the command, without the arguments used only by the UI, the fixed arguments and the arguments not in `inputs`. A `required` argument that the command does not declare is added as `{}` (any value). The tools check the input against this schema (see [input checks](tools.md#input-checks)).
- A tool is registered only while its command exists, and the tools are updated when commands are added or removed.
- An invalid entry is ignored, and a warning shows in the **Show WebMCP Tools** dialog and the browser console. The other entries still apply.
- When two entries give the same name, the first one wins. A glob skips the names that are already taken. The names of the built-in tools cannot be used.

## Examples

Expose the commands of an extension:

```json
{
  "tools": [{ "command": "my-extension:*" }]
}
```

Keep globs narrow: every tool and its schema goes to the agent.

Name a tool, fix arguments, or require arguments:

```json
{
  "tools": [
    {
      "name": "dark_theme",
      "command": "apputils:change-theme",
      "description": "Switch Jupyter to the dark theme.",
      "args": { "theme": "JupyterLab Dark" }
    },
    {
      "name": "show_directory",
      "command": "filebrowser:go-to-path",
      "description": "Show a directory to the user in the file browser.",
      "required": ["path"]
    }
  ]
}
```

Without `path`, `filebrowser:go-to-path` shows the root directory: `required` makes the agent give one.

Replace a default tool, for example to show the user a diff of each cell edit. Copy the fields of the default tool that you keep:

```json
{
  "tools": [
    {
      "name": "edit_cell",
      "command": "jupyterlab-ai-commands:set-cell-content",
      "description": "Replace the whole source of a notebook cell. The user sees a diff and can reject it. Not saved: call save_notebook.",
      "args": { "background": true, "diffMode": "unified", "showDiff": true },
      "required": ["notebookPath", "cellId", "content"],
      "annotations": { "untrustedContentHint": true }
    }
  ]
}
```

Keep only the dedicated tools:

```json
{
  "disabledTools": ["execute_command", "list_all_commands"]
}
```

Block commands that delete files or open a terminal:

```json
{
  "blockedCommands": [
    "jupyterlab-ai-commands:delete-*",
    "docmanager:delete*",
    "filebrowser:delete",
    "terminal:*"
  ]
}
```

Forbid code execution. Menu commands (`*menu:*`) run the commands of the current document, so block them too (the `apputils:run-*` commands, which run other commands, are blocked by default). This list comes from the commands of JupyterLab 4.6 with jupyterlab-ai-commands 0.4; other extensions add more:

```json
{
  "blockedCommands": [
    "*menu:*",
    "jupyterlab-ai-commands:execute-in-kernel",
    "jupyterlab-ai-commands:run-cell",
    "notebook:run-*",
    "notebook:restart-*",
    "console:run-*",
    "console:inject",
    "fileeditor:run-*",
    "debugger:run-in-console",
    "toc:run-cells",
    "terminal:*"
  ]
}
```

Lower `maxResultLength`, for example to `20000`, to save context.

## Defaults for a deployment

Set the defaults of a deployment in `overrides.json`, with the key `"jupyter-webmcp:plugin"`:

- for JupyterLab and Jupyter Notebook, in `<sys-prefix>/share/jupyter/lab/settings/overrides.json`;
- for JupyterLite, in the `overrides.json` of the lite directory, before `jupyter lite build`.

```json
{
  "jupyter-webmcp:plugin": {
    "blockedCommands": [
      "apputils:run-all-enabled",
      "apputils:run-first-enabled",
      "terminal:*"
    ],
    "disabledTools": ["execute_command"]
  }
}
```

`blockedCommands` and `disabledTools` are the union of their default (the schema default, or the value of `overrides.json`) and the user value. Users can add entries, but cannot remove the default ones. So the two `apputils:run-*` commands stay blocked unless `overrides.json` sets a `blockedCommands` list without them. Users can still change the other settings.

The Jupyter server checks the user settings against the schema. When they do not match it (for example `"blockedCommands": "terminal:*"`, which is not a list), the server ignores the whole user file, and the defaults apply. The warning is only in the server log. When the settings cannot be loaded at all, the extension registers no tool, and **Show WebMCP Tools** shows the error.
