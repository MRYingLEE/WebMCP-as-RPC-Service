"""Serve the JupyterLite site of the integration tests (lite/_output).

Usage: python serve_lite.py PORT
"""

import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SITE = Path(__file__).parent / "lite" / "_output"


class Server(ThreadingHTTPServer):
    # A page loads about a hundred files at once: with the default backlog
    # of 5, macOS resets some connections and the app fails to load.
    request_queue_size = 128


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        """
        Do not log each request.
        """


if __name__ == "__main__":
    if not (SITE / "index.html").exists():
        sys.exit(f"{SITE} is missing: run `jlpm build:lite` first.")
    handler = partial(Handler, directory=SITE)
    Server(("127.0.0.1", int(sys.argv[1])), handler).serve_forever()
