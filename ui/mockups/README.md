# Live-call dashboard mockups

Open `/mockups/` from the existing UI server (`python3 start.py` on port 8000), or open `index.html` directly in a browser. No dependencies or authentication are required.

- `operations.html`: metrics, active-agent shortcuts, and a live-call list beside a call inspector on wide screens.
- `workspace.html`: agent cards, agent-specific call lists, context, and a conversation inspector.
- `console.html`: a dark, dense call queue with agent shortcuts, workspace signals, and a call inspector.

All pages use the same fictional data. Select agents or calls, search by customer/agent/session, filter calls needing attention, switch transcript/traces/tools/events, and pause/resume the simulated stream. Durations update each second; an illustrative stream notice appears after 15 seconds. No real sessions, audio, databases, or LiveKit connections are accessed. Agent shortcuts open the agent workspace prototype.

The files are isolated from the production UI. Responsive layouts stack the inspector below the call list on smaller screens. The prototypes use system fonts and CSS graphics, with no external assets or network dependencies.

Validation: JavaScript syntax checked with `node --check`; browser checks covered agent switching, selecting calls, case-insensitive search, attention filtering, detail tabs, pause/resume, and mobile rendering.
