"""Run the local agent management UI.

The UI is intentionally dependency-free so it can be used before a backend is
connected. Agent definitions are stored in the browser's local storage.
"""

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


UI_DIRECTORY = Path(__file__).resolve().parent / "ui"
SERVER_HOST = "127.0.0.1"
SERVER_PORT = 8000


def start_user_interface() -> None:
    """Serve the agent management pages until the user stops the process."""

    request_handler = lambda *handler_arguments: SimpleHTTPRequestHandler(
        *handler_arguments, directory=str(UI_DIRECTORY)
    )
    server = ThreadingHTTPServer((SERVER_HOST, SERVER_PORT), request_handler)
    print(f"Agent manager available at http://{SERVER_HOST}:{SERVER_PORT}")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping agent manager.")
    finally:
        server.server_close()


if __name__ == "__main__":
    start_user_interface()
