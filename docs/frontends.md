# Frontends

The extension works the same way in each Jupyter frontend, but the frontends differ in what one page shows. The behavior below was checked with the [tested versions](../README.md#requirements).

## JupyterLab

- One page shows all the documents, so its tools reach all of them. The page has 21 tools.
- The status bar shows `WebMCP: <n> tools`. Click it to list the tools.
- `create_notebook` and the other jupyterlab-ai-commands tools open a document in the background: the current widget does not change. `open_document` brings the document to the front.
- `get_context` lists all the kernels of the server.

## Jupyter Notebook 7

Each page (`/tree`, `/notebooks/<path>`, `/edit/<path>`) is a separate application with its own 21 tools. `get_context` adds a `note` that tells the agent this.

- Work on a document from its page. On a `/notebooks/<path>` page, `get_context` (with `currentEditor`), `read_notebook`, `add_cell`, `run_cell`, `save_notebook`, and `execute_command` with `answer_dialog` work as in JupyterLab.
- On the `/tree` page, `list_directory`, `read_file` and `read_notebook` work.
- `open_document` opens the document in a new browser tab, and the result has `result: {type, disposed: true}`. The tools of the document are in that tab. A pop-up blocker can stop the new tab: Chrome blocks it unless pop-ups are allowed for the site.
- `create_notebook` on the `/tree` page returns success and opens the notebook in a new tab. When the browser blocks the tab, the kernel of the notebook runs with no page that uses it.
- Other tools that open a document that is not shown in the page can fail or never return (see [upstream issues](#upstream-issues)). For example, `create_file` on a notebook page stays pending.
- There is no status bar: run **Show WebMCP Tools** from the command palette.
- `get_context` lists all the kernels of the server, also the ones of other pages.

## JupyterLite

Install `jupyter_webmcp` in the environment that runs `jupyter lite build`: the build then includes the extension and jupyterlab-ai-commands. Serve the site from `localhost`, `127.0.0.1` or HTTPS.

- The lab UI (`/lab/index.html`) works like JupyterLab, with 21 tools and the status bar item. The notebooks UI (`/notebooks/index.html?path=<path>`, `/tree/index.html`) works like Jupyter Notebook 7.
- `get_context` gives `app: {name: "JupyterLite", version}` in both UIs. The `note` tells the notebooks UI apart.
- The kernels run in the browser tab: `get_context` lists only the kernels of its tab. The files are in the browser storage of the site, which all its tabs share.
- With the Pyodide kernel, `create_notebook` uses the kernel `python`, and errors have an `errorName` such as `<class 'ZeroDivisionError'>`.
- The Pyodide kernel ignores interrupts. `interrupt_kernel` returns the message "The interrupt was sent to the kernel." and a `warning`. `restart_kernel` stops the running code.
- `overrides.json` in the lite directory sets the defaults of the settings (see [settings](settings.md#defaults-for-a-deployment)). User settings are stored in the browser.

## Upstream issues

These issues are in other packages (jupyterlab-ai-commands 0.4.0 unless stated):

1. `execute-in-kernel` never returns when its kernel restarts, so a pending `run_code` call never settles (server kernels and JupyterLite).
2. The commands that open a document widget fail or hang in apps that show one document per page (Jupyter Notebook 7, the notebooks UI of JupyterLite): `create-file`, and `add-cell`, `set-cell-content`, `run-cell`, `delete-cell`, `save-notebook` and `set-file-content` on a document that is not open in the page. `create-notebook` returns, but it starts a kernel in a page that cannot show the notebook.
3. `create-notebook` and `create-file` fail when the file exists, but leave an `Untitled` file.
4. There are no commands to interrupt or restart a kernel by id (this extension adds them), and `add-cell` has no `position: "end"`: to append a cell, agents pass the id of the last cell.
5. For a missing path, the file and notebook commands open an error dialog and can stay pending.
6. `get-notebook-content` gives no cell ids for notebooks older than nbformat 4.5.
7. Argument descriptions say "If not provided, uses the active notebook" also where the tool requires the argument.
8. jupyterlite-ai 0.20.1 requires jupyterlab-ai-commands < 0.4, so the two packages cannot be installed together with this extension.
