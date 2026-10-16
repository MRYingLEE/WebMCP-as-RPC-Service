"""Server configuration for integration tests.

!! Never use this configuration in production because it
opens the server to the world and provide access to JupyterLab
JavaScript objects through the global window variable.
"""
from tempfile import mkdtemp

from jupyterlab.galata import configure_jupyter_server

configure_jupyter_server(c)

# Ignore the settings of the user, also in Jupyter Notebook.
c.LabServerApp.user_settings_dir = mkdtemp(prefix="galata-settings-")
c.LabServerApp.workspaces_dir = mkdtemp(prefix="galata-workspaces-")

# Uncomment to set server log level to debug level
# c.ServerApp.log_level = "DEBUG"
