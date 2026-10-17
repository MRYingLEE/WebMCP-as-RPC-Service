#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const [requestedName, ...extraArgs] = process.argv.slice(2);

if (requestedName === '--help' || extraArgs.length > 0) {
  console.log(
    'Usage: node examples/create-and-run-notebook.mjs [notebook-name]\n' +
      'Set WEBMCP_CDP_URL or WEBMCP_PAGE to target a different Chrome page.'
  );
  process.exit(requestedName === '--help' ? 0 : 1);
}

const name = requestedName ?? `webmcp-fibonacci-${Date.now()}`;
if (!/^[A-Za-z0-9_-]+$/.test(name)) {
  console.error('The notebook name must contain only letters, numbers, "_" or "-".');
  process.exit(1);
}

const cliPath = fileURLToPath(new URL('./webmcp-cli.mjs', import.meta.url));
const cdpUrl = process.env.WEBMCP_CDP_URL ?? 'http://127.0.0.1:9222';
const page = process.env.WEBMCP_PAGE ?? '/jupyter-webmcp/';

function callTool(tool, input) {
  const output = execFileSync(
    process.execPath,
    [
      cliPath,
      '--cdp',
      cdpUrl,
      '--page',
      page,
      'call',
      tool,
      JSON.stringify(input)
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const result = JSON.parse(output);
  if (result.success === false) {
    throw new Error(`${tool} failed: ${result.error ?? JSON.stringify(result)}`);
  }
  return result;
}

try {
  const workflowStarted = performance.now();
  const created = callTool('create_notebook', { name, language: 'python' });
  if (!created.notebookPath) {
    throw new Error('create_notebook did not return a notebookPath.');
  }

  const cells = [
    { label: 'Initialize sequence', content: 'fibonacci = [0, 1]' },
    {
      label: 'Generate remaining values',
      content:
        'for _ in range(8):\n' +
        '    fibonacci.append(fibonacci[-1] + fibonacci[-2])'
    },
    {
      label: 'Verify and display result',
      content:
        'expected = [0, 1, 1, 2, 3, 5, 8, 13, 21, 34]\n' +
        'assert fibonacci == expected\n' +
        'fibonacci'
    }
  ];
  const cellIds = [];
  let referenceCellId;
  for (const cell of cells) {
    const input = {
      notebookPath: created.notebookPath,
      cellType: 'code',
      content: cell.content
    };
    if (referenceCellId) {
      input.referenceCellId = referenceCellId;
      input.position = 'below';
    }
    const added = callTool('add_cell', input);
    if (!added.cellId) {
      throw new Error('add_cell did not return a cellId.');
    }
    referenceCellId = added.cellId;
    cellIds.push(added.cellId);
  }

  const cellRuns = [];
  for (const [index, cellId] of cellIds.entries()) {
    const started = performance.now();
    const run = callTool('run_cell', {
      notebookPath: created.notebookPath,
      cellId
    });
    const elapsedMs = Number((performance.now() - started).toFixed(1));
    if (run.status !== 'ok') {
      throw new Error(
        `run_cell for "${cells[index].label}" did not complete successfully: ${JSON.stringify(run)}`
      );
    }
    cellRuns.push({
      label: cells[index].label,
      cellId,
      elapsedMs,
      outputs: run.outputs ?? []
    });
  }

  const expectedOutput = '[0, 1, 1, 2, 3, 5, 8, 13, 21, 34]';
  const finalOutput = cellRuns
    .at(-1)
    .outputs.map(output => output.text ?? output.data?.['text/plain'] ?? '')
    .join('\n');
  if (!finalOutput.includes(expectedOutput)) {
    throw new Error(`The final cell did not produce ${expectedOutput}.`);
  }

  callTool('save_notebook', { notebookPath: created.notebookPath });
  console.log(
    JSON.stringify(
      {
        notebookPath: created.notebookPath,
        cellRuns,
        totalElapsedMs: Number((performance.now() - workflowStarted).toFixed(1))
      },
      null,
      2
    )
  );
} catch (error) {
  const message = error.stderr?.toString().trim() || error.message;
  console.error(message);
  process.exitCode = 1;
}
