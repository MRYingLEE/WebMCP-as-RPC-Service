#!/usr/bin/env bash
# Build the JupyterLite site of the integration tests in lite/_output, in an
# environment of its own: the JupyterLite packages break JupyterLab.
# WEBMCP_LABEXTENSION is the built extension (default: the one of the repo).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
EXTENSION=$(cd "${WEBMCP_LABEXTENSION:-$HERE/../jupyter_webmcp/labextension}" && pwd)
cd "$HERE/lite"
rm -rf _output .jupyterlite.doit.db
uvx --from "jupyterlite-core[contents]==0.8.6" \
  --with jupyterlite-pyodide-kernel==0.8.6 \
  --with jupyterlab-ai-commands==0.4.0 \
  jupyter-lite build \
  --contents contents \
  --LiteBuildConfig.federated_extensions="$EXTENSION"
