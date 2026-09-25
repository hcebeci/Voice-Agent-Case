"""Run the local agent management UI.

The UI uses the Supabase publishable key from the local environment file and
keeps the secret key out of browser responses.
"""

import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


UI_DIRECTORY = Path(__file__).resolve().parent / "ui"
SERVER_HOST = "127.0.0.1"
SERVER_PORT = 8000
SUPABASE_ENVIRONMENT_FILE = Path(__file__).resolve().parent / "supabase" / ".env"


def read_environment_values() -> dict[str, str]:
    """Read simple KEY=value entries without exposing backend-only secrets."""

    if not SUPABASE_ENVIRONMENT_FILE.exists():
        return {}

    values: dict[str, str] = {}
    for line in SUPABASE_ENVIRONMENT_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        values[name.strip()] = value.strip().strip("\"'")
    return values


class AgentManagerRequestHandler(SimpleHTTPRequestHandler):
    """Serve UI files and a browser-safe runtime configuration endpoint."""

    def do_GET(self) -> None:  # noqa: N802 - required by BaseHTTPRequestHandler
        if self.path == "/config.js":
            environment_values = read_environment_values()
            public_config = {
                "supabaseUrl": environment_values.get("SUPABASE_URL", ""),
                "supabasePublishableKey": environment_values.get(
                    "SUPABASE_PUBLISHABLE_KEY", ""
                ),
            }
            response_body = (
                "window.__APP_CONFIG__ = "
                + json.dumps(public_config)
                + ";\n"
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript")
            self.send_header("Content-Length", str(len(response_body)))
            self.end_headers()
            self.wfile.write(response_body)
            return

        super().do_GET()


def start_user_interface() -> None:
    """Serve the agent management pages until the user stops the process."""

    request_handler = lambda *handler_arguments: AgentManagerRequestHandler(
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
