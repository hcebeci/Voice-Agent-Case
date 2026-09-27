"use strict";

/** Browser-safe Supabase configuration is supplied by start.py at /config.js. */
const applicationConfig = window.__APP_CONFIG__ ?? {};
const supabaseLibrary = window.supabase;
let supabaseClient = null;
if (applicationConfig.supabaseUrl && applicationConfig.supabasePublishableKey && supabaseLibrary) {
  try {
    supabaseClient = supabaseLibrary.createClient(applicationConfig.supabaseUrl, applicationConfig.supabasePublishableKey);
  } catch (error) {
    console.error("Could not initialize Supabase.", error);
  }
}

/** Explain how to start the UI when the generated browser configuration is absent. */
function missingConfigurationMessage() {
  if (window.location.protocol === "file:") {
    return "This page was opened as a file. Run `python3 start.py` and open http://127.0.0.1:8000 so the browser can load its Supabase configuration.";
  }
  return "Supabase configuration is missing. Check supabase/.env and restart start.py.";
}

const pageState = { agents: [], tools: [], editingAgentId: null, editingToolId: null, dashboard: null, liveSession: null, selectedSessionId: null, selectedAgentMetricsId: null, sessionDetailsPollTimer: null, sessionView: "transcript", traceZoom: 1 };
const elements = {
  authScreen: document.querySelector("#auth-screen"),
  appShell: document.querySelector("#app-shell"),
  signInForm: document.querySelector("#sign-in-form"),
  signInEmail: document.querySelector("#sign-in-email"),
  signInPassword: document.querySelector("#sign-in-password"),
  signInButton: document.querySelector("#sign-in-button"),
  authError: document.querySelector("#auth-error"),
  signOutButton: document.querySelector("#sign-out-button"),
  dashboardPage: document.querySelector("#dashboard-page"),
  agentsPage: document.querySelector("#agents-page"),
  toolsPage: document.querySelector("#tools-page"),
  sessionsPage: document.querySelector("#sessions-page"),
  sessionDetailsPage: document.querySelector("#session-details-page"),
  agentMetricsPage: document.querySelector("#agent-metrics-page"),
  dashboardCreateButton: document.querySelector("#dashboard-create-button"),
  sessionsTodayValue: document.querySelector("#sessions-today-value"),
  availableAgentsValue: document.querySelector("#available-agents-value"),
  activeAgentsValue: document.querySelector("#active-agents-value"),
  activeSessionsValue: document.querySelector("#active-sessions-value"),
  sleepingAgentsValue: document.querySelector("#sleeping-agents-value"),
  dashboardAgentList: document.querySelector("#dashboard-agent-list"),
  dashboardDate: document.querySelector("#dashboard-date"),
  sessionTimeline: document.querySelector("#session-timeline"),
  latestSessionList: document.querySelector("#latest-session-list"),
  allSessionList: document.querySelector("#all-session-list"),
  seeAllSessionsButton: document.querySelector("#see-all-sessions-button"),
  backToDashboardButton: document.querySelector("#back-to-dashboard-button"),
  backToSessionsButton: document.querySelector("#back-to-sessions-button"),
  sessionDetailsTitle: document.querySelector("#session-details-title"),
  sessionDetailsDescription: document.querySelector("#session-details-description"),
  sessionDetailsError: document.querySelector("#session-details-error"),
  sessionTurnCount: document.querySelector("#session-turn-count"),
  sessionAverageLatency: document.querySelector("#session-average-latency"),
  sessionP50Latency: document.querySelector("#session-p50-latency"),
  sessionP95Latency: document.querySelector("#session-p95-latency"),
  sessionInputTokens: document.querySelector("#session-input-tokens"),
  sessionOutputTokens: document.querySelector("#session-output-tokens"),
  sessionTurnList: document.querySelector("#session-turn-list"),
  sessionTraceList: document.querySelector("#session-trace-list"),
  sessionTraceViewport: document.querySelector("#session-trace-viewport"),
  sessionTraceDetail: document.querySelector("#session-trace-detail"),
  sessionToolList: document.querySelector("#session-tool-list"),
  sessionEventList: document.querySelector("#session-event-list"),
  agentMetricsTitle: document.querySelector("#agent-metrics-title"),
  agentMetricsDescription: document.querySelector("#agent-metrics-description"),
  agentMetricsError: document.querySelector("#agent-metrics-error"),
  agentTotalSessions: document.querySelector("#agent-total-sessions"),
  agentConcurrentSessions: document.querySelector("#agent-concurrent-sessions"),
  agentAverageInputTokens: document.querySelector("#agent-average-input-tokens"),
  agentAverageOutputTokens: document.querySelector("#agent-average-output-tokens"),
  agentLatencyList: document.querySelector("#agent-latency-list"),
  agentRecentSessionList: document.querySelector("#agent-recent-session-list"),
  list: document.querySelector("#agent-list"),
  emptyState: document.querySelector("#empty-state"),
  emptyTitle: document.querySelector("#empty-title"),
  emptyDescription: document.querySelector("#empty-description"),
  pageError: document.querySelector("#page-error"),
  searchInput: document.querySelector("#agent-search"),
  statusFilter: document.querySelector("#status-filter"),
  modal: document.querySelector("#agent-modal"),
  form: document.querySelector("#agent-form"),
  formError: document.querySelector("#form-error"),
  modalEyebrow: document.querySelector("#modal-eyebrow"),
  modalTitle: document.querySelector("#modal-title"),
  agentId: document.querySelector("#agent-id"),
  name: document.querySelector("#agent-name"),
  description: document.querySelector("#agent-description"),
  instructions: document.querySelector("#agent-instructions"),
  model: document.querySelector("#agent-model"),
  language: document.querySelector("#agent-language"),
  ttsModel: document.querySelector("#agent-tts-model"),
  callModal: document.querySelector("#call-modal"),
  callStatus: document.querySelector("#call-status"),
  callAgentName: document.querySelector("#call-agent-name"),
  callError: document.querySelector("#call-error"),
  muteCallButton: document.querySelector("#mute-call-button"),
  endCallButton: document.querySelector("#end-call-button"),
  remoteAudioContainer: document.querySelector("#remote-audio-container"),
  toolList: document.querySelector("#tool-list"),
  toolEmptyState: document.querySelector("#tool-empty-state"),
  toolPageError: document.querySelector("#tool-page-error"),
  toolModal: document.querySelector("#tool-modal"),
  toolForm: document.querySelector("#tool-form"),
  toolFormError: document.querySelector("#tool-form-error"),
  toolId: document.querySelector("#tool-id"),
  toolName: document.querySelector("#tool-name"),
  toolDescription: document.querySelector("#tool-description"),
  toolExecutionKey: document.querySelector("#tool-execution-key"),
  toolInputSchema: document.querySelector("#tool-input-schema"),
  toolEnabled: document.querySelector("#tool-enabled"),
  toolModalEyebrow: document.querySelector("#tool-modal-eyebrow"),
  toolModalTitle: document.querySelector("#tool-modal-title"),
  agentToolSelection: document.querySelector("#agent-tool-selection"),
};

/** Display the authenticated workspace and hide the sign-in form. */
function showApplication() {
  elements.authScreen.hidden = true;
  elements.appShell.hidden = false;
}

/** Return the user to the sign-in screen after logout or an expired session. */
function showAuthentication() {
  stopSessionDetailsPolling();
  elements.appShell.hidden = true;
  elements.authScreen.hidden = false;
}

/** Switch between the dashboard, agent list, and session history views. */
function showPage(pageId) {
  if (pageId !== "session-details-page") stopSessionDetailsPolling();
  [elements.dashboardPage, elements.agentsPage, elements.toolsPage, elements.sessionsPage, elements.sessionDetailsPage, elements.agentMetricsPage].forEach((page) => {
    page.hidden = page.id !== pageId;
  });
  document.querySelectorAll(".navigation-link[data-page]").forEach((link) => {
    const isCurrentPage = link.dataset.page === pageId;
    link.classList.toggle("active", isCurrentPage);
    if (isCurrentPage) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  const route = pageId === "session-details-page" && pageState.selectedSessionId
    ? `session/${pageState.selectedSessionId}`
    : pageId === "agent-metrics-page" && pageState.selectedAgentMetricsId
      ? `agent-metrics/${pageState.selectedAgentMetricsId}`
      : pageId.replace("-page", "");
  try {
    sessionStorage.setItem("agent-studio-navigation", JSON.stringify({
      pageId,
      sessionId: pageState.selectedSessionId,
      agentId: pageState.selectedAgentMetricsId,
    }));
  } catch {
    // Continue normally when the browser blocks session storage.
  }
  if (window.location.hash !== `#${route}`) window.history.replaceState(null, "", `#${route}`);
}

/** Display one authentication or API error in the relevant form. */
function showError(target, message) {
  target.textContent = message;
  target.hidden = false;
}

/** Clear a previous error message before starting a new request. */
function clearError(target) {
  target.textContent = "";
  target.hidden = true;
}

/** Sign in through Supabase Auth using the credentials entered by the user. */
async function signIn(event) {
  event.preventDefault();
  clearError(elements.authError);
  if (!supabaseClient) {
    showError(elements.authError, missingConfigurationMessage());
    return;
  }

  elements.signInButton.disabled = true;
  elements.signInButton.textContent = "Signing in...";
  try {
    const { error } = await supabaseClient.auth.signInWithPassword({
      email: elements.signInEmail.value.trim(),
      password: elements.signInPassword.value,
    });
    if (error) showError(elements.authError, error.message);
  } catch (error) {
    showError(elements.authError, error.message ?? "Sign-in failed. Check your connection.");
  } finally {
    elements.signInButton.disabled = false;
    elements.signInButton.textContent = "Sign in";
  }
}

/** Sign out and let Supabase clear the browser session. */
async function signOut() {
  if (supabaseClient) await supabaseClient.auth.signOut();
  pageState.agents = [];
  showAuthentication();
}

/** Call the deployed Edge Function with the current user's access token. */
async function callAgentsApi(path = "", options = {}) {
  if (!supabaseClient) throw new Error("Supabase configuration is missing.");
  const { data: sessionData } = await supabaseClient.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("Your session has expired. Please sign in again.");

  const response = await fetch(`${applicationConfig.supabaseUrl}/functions/v1/agents${path}`, {
    ...options,
    headers: {
      apikey: applicationConfig.supabasePublishableKey,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const responseBody = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(responseBody.error ?? "The agent request failed.");
  return responseBody;
}

/** Load the dashboard summary from the authenticated dashboard endpoint. */
async function loadDashboard() {
  try {
    const response = await callWorkspaceApi("dashboard");
    pageState.dashboard = response;
    renderDashboard(response);
  } catch (error) {
    showError(elements.pageError, error.message);
  }
}

/** Call another authenticated workspace Edge Function. */
async function callWorkspaceApi(functionName, path = "", options = {}) {
  if (!supabaseClient) throw new Error("Supabase configuration is missing.");
  const { data: sessionData } = await supabaseClient.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("Your session has expired. Please sign in again.");

  const response = await fetch(`${applicationConfig.supabaseUrl}/functions/v1/${functionName}${path}`, {
    ...options,
    headers: {
      apikey: applicationConfig.supabasePublishableKey,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const responseBody = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(responseBody.error ?? "The workspace request failed.");
  return responseBody;
}

/** Load the shared tool library or one agent's assignment state. */
async function loadTools(agentId = null) {
  try {
    const query = agentId ? `?agent_id=${encodeURIComponent(agentId)}` : "";
    const response = await callWorkspaceApi("tools", query);
    if (agentId) return response.tools ?? [];
    pageState.tools = response.tools ?? [];
    renderTools();
    return pageState.tools;
  } catch (error) {
    if (agentId) throw error;
    showError(elements.toolPageError ?? elements.pageError, error.message);
    return [];
  }
}

/** Render reusable backend capabilities as cards in the shared library. */
function renderTools() {
  if (!elements.toolList) return;
  const tools = pageState.tools;
  elements.toolList.innerHTML = tools.map((tool) => {
    const status = tool.is_enabled ? "Enabled" : "Disabled";
    return `<article class="tool-card"><div class="tool-card-header"><div><p class="eyebrow">SHARED TOOL</p><h2>${escapeHtml(tool.name)}</h2></div><span class="badge ${tool.is_enabled ? "sleeping" : "offline"}">${status}</span></div><p class="agent-description">${escapeHtml(tool.description || "No description yet.")}</p><div class="tool-card-meta"><span><strong>Key</strong> ${escapeHtml(tool.execution_key)}</span><span><strong>Updated</strong> ${escapeHtml(formatDateTime(tool.updated_at))}</span></div><details class="tool-schema"><summary>Input schema</summary><pre>${escapeHtml(JSON.stringify(tool.input_schema ?? {}, null, 2))}</pre></details><div class="card-actions"><button class="text-button" data-tool-action="edit" data-tool-id="${escapeHtml(tool.id)}" type="button">Edit</button><button class="text-button" data-tool-action="toggle" data-tool-id="${escapeHtml(tool.id)}" data-tool-enabled="${String(tool.is_enabled)}" type="button">${tool.is_enabled ? "Disable" : "Enable"}</button></div></article>`;
  }).join("");
  elements.toolEmptyState.hidden = tools.length > 0;
  elements.toolList.querySelectorAll("[data-tool-action='edit']").forEach((button) => button.addEventListener("click", () => openEditToolModal(button.dataset.toolId)));
  elements.toolList.querySelectorAll("[data-tool-action='toggle']").forEach((button) => button.addEventListener("click", () => void toggleTool(button.dataset.toolId, button.dataset.toolEnabled !== "true")));
}

/** Render enabled shared tools as assignment checkboxes in the agent editor. */
function renderAgentToolSelection(tools) {
  if (!elements.agentToolSelection) return;
  const enabledTools = tools.filter((tool) => tool.is_enabled);
  elements.agentToolSelection.innerHTML = enabledTools.length
    ? enabledTools.map((tool) => `<label class="tool-option"><input type="checkbox" data-agent-tool-id="${escapeHtml(tool.id)}" ${tool.assigned ? "checked" : ""} /><span><strong>${escapeHtml(tool.name)}</strong><small>${escapeHtml(tool.description || tool.execution_key)}</small></span></label>`).join("")
    : `<p class="field-help">No enabled shared tools are available yet. Create one from the Tools page.</p>`;
}

/** Load assignment flags for an agent and show them in the editor. */
async function loadAgentToolSelection(agentId = null) {
  const tools = agentId ? await loadTools(agentId) : pageState.tools.map((tool) => ({ ...tool, assigned: false }));
  renderAgentToolSelection(tools);
}

/** Read the selected shared tools from the agent editor. */
function selectedAgentToolAssignments() {
  return [...elements.agentToolSelection.querySelectorAll("input[data-agent-tool-id]:checked")].map((input) => ({ tool_id: input.dataset.agentToolId, configuration: {} }));
}

/** Load all sessions for the full-session history page. */
async function loadAllSessions(agentId = null) {
  try {
    const query = new URLSearchParams({ limit: "100" });
    if (agentId) query.set("agent_id", agentId);
    const response = await callWorkspaceApi("sessions", `?${query.toString()}`);
    renderSessionList(elements.allSessionList, response.sessions ?? [], "No sessions have been recorded yet.");
  } catch (error) {
    showError(elements.pageError, error.message);
  }
}

/** Load one session's transcript, traces, tools, events, and calculated metrics. */
/** Stop background updates when the session details page is no longer visible. */
function stopSessionDetailsPolling() {
  if (pageState.sessionDetailsPollTimer) {
    window.clearInterval(pageState.sessionDetailsPollTimer);
    pageState.sessionDetailsPollTimer = null;
  }
}

/** Refresh an in-progress session until LiveKit reports a terminal status. */
function startSessionDetailsPolling(sessionId) {
  if (pageState.sessionDetailsPollTimer || pageState.selectedSessionId !== sessionId) return;
  pageState.sessionDetailsPollTimer = window.setInterval(() => {
    if (document.hidden || pageState.selectedSessionId !== sessionId || elements.sessionDetailsPage.hidden) return;
    void loadSessionDetails(sessionId, { background: true });
  }, 5000);
}

/** Load one session and optionally refresh it without changing the current view. */
async function loadSessionDetails(sessionId, { background = false } = {}) {
  pageState.selectedSessionId = sessionId;
  clearError(elements.sessionDetailsError);
  if (!background) {
    pageState.traceZoom = 1;
    pageState.sessionView = "transcript";
    showPage("session-details-page");
  }
  try {
    const response = await callWorkspaceApi("sessions", `?id=${encodeURIComponent(sessionId)}`);
    renderSessionDetails(response);
    if (["connecting", "active"].includes(response.session?.status)) startSessionDetailsPolling(sessionId);
    else stopSessionDetailsPolling();
  } catch (error) {
    if (!background) showError(elements.sessionDetailsError, error.message);
  }
}

/** Render dashboard metric cards and its two session lists. */
function renderDashboard(dashboard) {
  const metrics = dashboard.metrics ?? {};
  elements.sessionsTodayValue.textContent = metrics.total_sessions_today ?? 0;
  elements.availableAgentsValue.textContent = metrics.available_agent_count ?? 0;
  elements.activeAgentsValue.textContent = metrics.active_agent_count ?? 0;
  elements.activeSessionsValue.textContent = metrics.active_session_count ?? 0;
  elements.sleepingAgentsValue.textContent = metrics.sleeping_agent_count ?? 0;
  elements.dashboardDate.textContent = formatDate(dashboard.date);
  renderSessionList(elements.sessionTimeline, dashboard.today_sessions ?? [], "No sessions today.");
  renderSessionList(elements.latestSessionList, dashboard.latest_sessions ?? [], "No sessions have been recorded yet.");
  renderDashboardAgentList(dashboard.agents ?? []);
}

/** Render dashboard agents as links into their performance summaries. */
function renderDashboardAgentList(agents) {
  if (!agents.length) {
    elements.dashboardAgentList.innerHTML = `<p class="session-empty">No agents have been created yet.</p>`;
    return;
  }
  elements.dashboardAgentList.innerHTML = agents.map(createDashboardAgentRowMarkup).join("");
  elements.dashboardAgentList.querySelectorAll("[data-agent-metrics-id]").forEach((row) => {
    row.addEventListener("click", () => void loadAgentMetrics(row.dataset.agentMetricsId));
  });
}

/** Build a dashboard row that shows runtime status and active session count. */
function createDashboardAgentRowMarkup(agent) {
  const activeSessions = agent.active_session_count ?? 0;
  return `<button class="agent-dashboard-row" data-agent-metrics-id="${escapeHtml(agent.id)}" type="button"><span class="agent-dashboard-avatar" aria-hidden="true">${escapeHtml(agent.name.slice(0, 1).toUpperCase())}</span><span class="session-row-content"><span class="session-row-title">${escapeHtml(agent.name)}</span><span class="session-row-meta">${escapeHtml(agent.runtime_status)} · ${activeSessions} active session${activeSessions === 1 ? "" : "s"}</span></span><span class="session-row-status">View metrics</span></button>`;
}

/** Load one agent's aggregate metrics and recent sessions. */
async function loadAgentMetrics(agentId) {
  pageState.selectedAgentMetricsId = agentId;
  clearError(elements.agentMetricsError);
  showPage("agent-metrics-page");
  try {
    const response = await callWorkspaceApi("agent-metrics", `?id=${encodeURIComponent(agentId)}`);
    renderAgentMetrics(response);
  } catch (error) {
    showError(elements.agentMetricsError, error.message);
  }
}

/** Restore the last visible page after a browser refresh. */
async function restoreLastPage() {
  let storedState;
  try {
    storedState = JSON.parse(sessionStorage.getItem("agent-studio-navigation") || "null");
  } catch {
    storedState = null;
  }
  const hashRoute = decodeURIComponent(window.location.hash.replace(/^#/, ""));
  if (hashRoute.startsWith("session/")) {
    await loadSessionDetails(hashRoute.slice("session/".length));
    return;
  }
  if (hashRoute.startsWith("agent-metrics/")) {
    await loadAgentMetrics(hashRoute.slice("agent-metrics/".length));
    return;
  }
  const hashPage = { dashboard: "dashboard-page", agents: "agents-page", tools: "tools-page", sessions: "sessions-page" }[hashRoute];
  if (hashPage) storedState = { pageId: hashPage };
  if (!storedState?.pageId) return;
  if (storedState.pageId === "session-details-page" && storedState.sessionId) {
    await loadSessionDetails(storedState.sessionId);
    return;
  }
  if (storedState.pageId === "agent-metrics-page" && storedState.agentId) {
    await loadAgentMetrics(storedState.agentId);
    return;
  }
  if (["dashboard-page", "agents-page"].includes(storedState.pageId)) {
    showPage(storedState.pageId);
    return;
  }
  if (storedState.pageId === "tools-page") {
    showPage("tools-page");
    await loadTools();
    return;
  }
  if (storedState.pageId === "sessions-page") {
    showPage("sessions-page");
    await loadAllSessions();
  }
}

/** Render aggregate usage, latency stages, and recent sessions for one agent. */
function renderAgentMetrics(details) {
  const agent = details.agent ?? {};
  const metrics = details.metrics ?? {};
  elements.agentMetricsTitle.textContent = `${agent.name ?? "Agent"} metrics`;
  elements.agentMetricsDescription.textContent = `${agent.language === "tr" ? "Turkish" : "English"} · ${agent.archived_at ? "offline" : "available for sessions"}`;
  elements.agentTotalSessions.textContent = metrics.total_session_count ?? 0;
  elements.agentConcurrentSessions.textContent = metrics.concurrent_session_count ?? 0;
  elements.agentAverageInputTokens.textContent = formatWholeNumber(metrics.average_input_tokens_per_session);
  elements.agentAverageOutputTokens.textContent = formatWholeNumber(metrics.average_output_tokens_per_session);

  const latencyByStage = metrics.latency_by_stage ?? {};
  const stageOrder = ["end_to_end", "stt", "llm", "tool", "tts", "agent_speaking"];
  const availableStages = stageOrder.filter((stage) => latencyByStage[stage]);
  elements.agentLatencyList.innerHTML = availableStages.length
    ? availableStages.map((stage) => {
      const summary = latencyByStage[stage];
      return `<div class="latency-stage-row"><strong>${escapeHtml(formatStageName(stage))}</strong><span>${formatLatency(summary.average_ms)}</span><span>${formatLatency(summary.p50_ms)}</span><span>${formatLatency(summary.p95_ms)}</span></div>`;
    }).join("")
    : `<p class="session-empty">No completed latency stages have been recorded yet.</p>`;
  if (availableStages.length) {
    elements.agentLatencyList.insertAdjacentHTML("afterbegin", `<div class="latency-stage-heading"><span>Stage</span><span>Average</span><span>p50</span><span>p95</span></div>`);
  }
  renderSessionList(elements.agentRecentSessionList, details.recent_sessions ?? [], "No sessions have been recorded for this agent yet.");
}

/** Format aggregate token values without showing unnecessary decimal places. */
function formatWholeNumber(value) {
  if (value == null || value === "") return "—";
  const numericValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numericValue) && numericValue >= 0 ? Math.round(numericValue).toLocaleString() : "—";
}

/** Convert trace identifiers into readable latency stage labels. */
function formatStageName(stage) {
  if (stage === "agent_speaking") return "Agent speaking duration";
  return stage.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

/** Render session rows consistently across the dashboard and history page. */
function renderSessionList(target, sessions, emptyMessage) {
  if (!sessions.length) {
    target.innerHTML = `<p class="session-empty">${emptyMessage}</p>`;
    return;
  }
  target.innerHTML = sessions.map(createSessionRowMarkup).join("");
  target.querySelectorAll("[data-session-id]").forEach((row) => {
    row.addEventListener("click", () => void loadSessionDetails(row.dataset.sessionId));
  });
}

/** Build a readable session row with its associated agent name and status. */
function createSessionRowMarkup(session) {
  const sessionAgent = Array.isArray(session.agents) ? session.agents[0] : session.agents;
  const agentName = sessionAgent?.name ?? "Unknown agent";
  const sessionDate = session.created_at ? new Date(session.created_at) : null;
  const sessionTime = sessionDate ? new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(sessionDate) : "Not started";
  const statusLabel = session.status.replaceAll("_", " ");
  return `<button class="session-row" data-session-id="${escapeHtml(session.id)}" type="button"><span class="session-indicator" aria-hidden="true"></span><span class="session-row-content"><span class="session-row-title">${escapeHtml(agentName)}</span><span class="session-row-meta">${escapeHtml(session.source)} · ${escapeHtml(sessionTime)}</span></span><span class="session-row-status">${escapeHtml(statusLabel)}</span></button>`;
}

/** Render the session detail sections from the normalized observability records. */
function renderSessionDetails(details) {
  const session = details.session ?? {};
  const sessionAgent = Array.isArray(session.agents) ? session.agents[0] : session.agents;
  const metrics = details.metrics ?? {};
  const turns = details.turns ?? [];
  const traces = details.traces ?? [];
  const events = details.events ?? [];
  const sessionStart = getSessionStartTimestamp(session, turns, traces, events);
  elements.sessionDetailsTitle.textContent = sessionAgent?.name ? `${sessionAgent.name} session` : "Session details";
  elements.sessionDetailsDescription.textContent = `${formatDateTime(session.created_at)} · ${session.status?.replaceAll("_", " ") ?? "unknown"}`;
  elements.sessionTurnCount.textContent = metrics.turn_count ?? 0;
  elements.sessionAverageLatency.textContent = formatLatency(metrics.average_latency_ms);
  elements.sessionP50Latency.textContent = formatLatency(metrics.p50_latency_ms);
  elements.sessionP95Latency.textContent = formatLatency(metrics.p95_latency_ms);
  elements.sessionInputTokens.textContent = formatWholeNumber(metrics.total_input_tokens);
  elements.sessionOutputTokens.textContent = formatWholeNumber(metrics.total_output_tokens);

  elements.sessionTurnList.innerHTML = turns.length
    ? turns.map((turn) => {
      const userTimestamp = turn.transcript_completed_at || turn.user_speech_stopped_at || turn.created_at;
      const agentTimestamp = turn.agent_first_audio_started_at || turn.response_ready_at || turn.created_at;
      return `<article class="turn-card"><div class="turn-card-heading"><strong>Turn ${turn.turn_number}</strong><span class="turn-timestamp">${formatTimestampWithElapsed(userTimestamp, sessionStart)}</span></div><div class="turn-message user-message"><span class="turn-speaker">User</span><div><p>${escapeHtml(turn.user_transcript || "Transcript pending")}</p><span class="message-timestamp">${formatTimestampWithElapsed(userTimestamp, sessionStart)}</span></div></div><div class="turn-message agent-message"><span class="turn-speaker">Agent</span><div><p>${escapeHtml(turn.agent_transcript || "Response pending")}</p><span class="message-timestamp">${formatTimestampWithElapsed(agentTimestamp, sessionStart)}</span></div></div><div class="turn-card-meta">Latency ${formatLatency(turn.total_latency_ms)} · ${escapeHtml(turn.status ?? "in progress")}</div></article>`;
    }).join("")
    : `<p class="session-empty">No conversation turns have been recorded yet.</p>`;

  const tools = details.tool_calls ?? [];
  renderTraceTimeline(elements.sessionTraceList, traces, sessionStart, session);
  elements.sessionToolList.hidden = true;

  elements.sessionToolList.innerHTML = tools.length
    ? `<div class="trace-tools-heading">Tool executions</div>${tools.map((tool) => `<div class="session-row"><span class="session-indicator" aria-hidden="true"></span><span class="session-row-content"><span class="session-row-title">${escapeHtml(tool.tool_name)}</span><span class="session-row-meta">${escapeHtml(tool.status)} · ${formatTimestampWithElapsed(tool.started_at, sessionStart)}</span></span><span class="session-row-status">${formatLatency(tool.duration_ms)}</span></div>`).join("")}`
    : `<p class="session-empty">No tools ran in this session.</p>`;

  elements.sessionEventList.innerHTML = events.length
    ? events.map((event) => {
      const payload = event.payload && Object.keys(event.payload).length ? `<details class="event-payload"><summary>View payload</summary><pre>${escapeHtml(JSON.stringify(event.payload, null, 2))}</pre></details>` : "";
      return `<div class="event-row"><div class="event-row-heading"><strong>${escapeHtml(event.event_type)}</strong><span>${formatTimestampWithElapsed(event.occurred_at, sessionStart)}</span></div><span>${escapeHtml(event.source)} · received ${formatDateTimeWithSeconds(event.received_at)}</span>${payload}</div>`;
    }).join("")
    : `<p class="session-empty">No events have been recorded yet.</p>`;

  setSessionView(pageState.sessionView ?? "transcript");
}

/** Adjust the processing timeline scale while keeping every span on one time axis. */
function setTraceZoom(action) {
  const timeline = elements.sessionTraceList;
  const traceData = timeline._traceData;
  if (!traceData) return;
  if (action === "reset") pageState.traceZoom = 1;
  if (action === "in") pageState.traceZoom = Math.min(4, (pageState.traceZoom ?? 1) * 1.5);
  if (action === "out") pageState.traceZoom = Math.max(1, (pageState.traceZoom ?? 1) / 1.5);
  renderTraceTimeline(timeline, traceData.traces, traceData.sessionStart, traceData.session);
  const zoomLabel = document.querySelector("#trace-zoom-label");
  if (zoomLabel) zoomLabel.textContent = `${Math.round(pageState.traceZoom * 100)}%`;
}

/** Select the earliest trustworthy timestamp as the session timeline origin. */
function getSessionStartTimestamp(session, turns, traces, events) {
  const candidates = [session.started_at, ...turns.map((turn) => turn.created_at), ...traces.map((trace) => trace.started_at), ...events.map((event) => event.occurred_at)].filter(Boolean).map((value) => new Date(value).getTime()).filter(Number.isFinite);
  return candidates.length ? Math.min(...candidates) : Date.now();
}

/** Render trace spans as bars positioned on one shared time axis. */
function renderTraceTimeline(target, traces, sessionStart, session) {
  const validTraces = traces.filter((trace) => trace.started_at);
  if (!validTraces.length) {
    target.innerHTML = `<p class="session-empty">No processing traces have been recorded yet.</p>`;
    target._traceData = null;
    target.closest(".trace-workspace")?.classList.remove("has-trace-detail");
    elements.sessionTraceDetail.hidden = true;
    return;
  }
  const sessionEnd = Math.max(
    new Date(session.ended_at || 0).getTime() || 0,
    ...validTraces.map((trace) => new Date(trace.ended_at || trace.started_at).getTime()),
  );
  const totalDuration = Math.max(sessionEnd - sessionStart, 1);
  const ticks = Array.from({ length: 6 }, (_, index) => {
    const offset = totalDuration * index / 5;
    return `<span>${formatElapsedMilliseconds(offset)}</span>`;
  }).join("");
  // The upper axis is the user's speech pattern; the lower axis contains the
  // complete agent pipeline, including STT, LLM, TTS, and agent speaking.
  const userTraceTypes = new Set(["trace.user_speaking"]);
  const userTraces = validTraces.filter((trace) => userTraceTypes.has(trace.event_type));
  const agentTraces = validTraces.filter((trace) => !userTraceTypes.has(trace.event_type));
  const traceIndex = new Map(validTraces.map((trace, index) => [trace, index]));
  const userLane = renderTraceSwimlane("User turn", userTraces, traceIndex, sessionStart, totalDuration);
  const agentLane = renderAgentTraceGroup(agentTraces, traceIndex, sessionStart, totalDuration);
  target.innerHTML = `<div class="trace-axis">${ticks}</div><section class="trace-track-group trace-user-group"><div class="trace-track-group-heading">User traces</div>${userLane}</section><section class="trace-track-group trace-agent-group"><div class="trace-track-group-heading">Agent traces</div>${agentLane}</section><div class="trace-cursor" data-trace-cursor hidden><span></span></div>`;
  target._traceRecords = validTraces;
  target._traceData = { traces, sessionStart, session };
  const zoom = pageState.traceZoom ?? 1;
  target.style.width = zoom > 1 ? `${zoom * 100}%` : "100%";
  target.style.minWidth = `${680 * zoom}px`;
  const zoomLabel = document.querySelector("#trace-zoom-label");
  if (zoomLabel) zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  target.closest(".trace-workspace")?.classList.remove("has-trace-detail");
  elements.sessionTraceDetail.hidden = true;
  bindTraceTimelineInteractions(target, totalDuration);
  target.onclick = (event) => {
    const bar = event.target.closest("[data-trace-index]");
    if (!bar || !target.contains(bar)) return;
    const trace = target._traceRecords?.[Number(bar.dataset.traceIndex)];
    if (trace) renderTraceDetail(trace, sessionStart);
  };
}

/** Render one speaker lane so user and agent speech are visually separated. */
function renderTraceSwimlane(label, traces, traceIndex, sessionStart, totalDuration) {
  const bars = traces.map((trace) => renderTraceBar(trace, traceIndex.get(trace), sessionStart, totalDuration)).join("");
  const emptyLabel = traces.length ? "" : `<span class="trace-lane-empty">No recorded spans</span>`;
  return `<div class="trace-swimlane"><div class="trace-swimlane-label">${escapeHtml(label)}</div><div class="trace-swimlane-track">${bars}${emptyLabel}</div></div>`;
}

/** Render the agent pipeline on one shared time axis without stacking spans over each other. */
function renderAgentTraceGroup(traces, traceIndex, sessionStart, totalDuration) {
  if (!traces.length) return renderTraceSwimlane("Agent turn", [], traceIndex, sessionStart, totalDuration);
  const groups = new Map();
  for (const trace of traces) {
    const component = groups.get(trace.event_type) ?? [];
    component.push(trace);
    groups.set(trace.event_type, component);
  }
  const firstStart = Math.min(...traces.map((trace) => new Date(trace.started_at).getTime()));
  const lastEnd = Math.max(...traces.map((trace) => new Date(trace.ended_at || trace.started_at).getTime()));
  const parent = renderTraceParentLane("Agent turn", firstStart, lastEnd, sessionStart, totalDuration);
  const componentRows = [...groups.values()]
    .map((component) => renderTraceLane(component, traceIndex, sessionStart, totalDuration))
    .join("");
  return `${parent}${componentRows}`;
}

/** Render a parent turn lane spanning all agent processing stages. */
function renderTraceParentLane(label, startedAt, endedAt, sessionStart, totalDuration) {
  const startOffset = Math.max(0, startedAt - sessionStart);
  const endOffset = Math.max(startOffset + 1, endedAt - sessionStart);
  const left = Math.min(99, startOffset / totalDuration * 100);
  const width = Math.max(1, Math.min(100 - left, (endOffset - startOffset) / totalDuration * 100));
  return `<div class="trace-parent-lane"><div class="trace-parent-label">${escapeHtml(label)}</div><div class="trace-parent-track"><span style="left:${left}%;width:${width}%"></span></div></div>`;
}

/** Render one processing lane while preserving its full event name for hover and details. */
function renderTraceLane(traces, traceIndex, sessionStart, totalDuration) {
  const traceName = traces[0].event_type.replace("trace.", "").replaceAll("_", " ");
  const bars = traces.map((trace) => renderTraceBar(trace, traceIndex.get(trace), sessionStart, totalDuration)).join("");
  const totalDurationMs = traces.reduce((total, trace) => total + (getTraceDurationMs(trace) ?? 0), 0);
  const spanCount = `${traces.length} span${traces.length === 1 ? "" : "s"}`;
  return `<div class="trace-lane"><div class="trace-lane-label" title="${escapeHtml(traceName)}">${escapeHtml(traceName)}</div><div class="trace-lane-track">${bars}</div><span class="trace-lane-duration">${spanCount} · ${formatLatency(totalDurationMs)}</span></div>`;
}

/** Build a clickable trace span with a complete hover label and precise positioning. */
function renderTraceBar(trace, index, sessionStart, totalDuration) {
  const startOffset = Math.max(0, new Date(trace.started_at).getTime() - sessionStart);
  const endOffset = Math.max(startOffset + 1, new Date(trace.ended_at || trace.started_at).getTime() - sessionStart);
  const left = Math.min(99, startOffset / totalDuration * 100);
  const width = Math.max(1, Math.min(100 - left, (endOffset - startOffset) / totalDuration * 100));
  const traceName = trace.event_type.replace("trace.", "").replaceAll("_", " ");
  const hoverLabel = `${trace.event_type} · ${formatTimestampWithElapsed(trace.started_at, sessionStart)} · ${formatLatency(getTraceDurationMs(trace))}`;
  return `<button class="trace-bar trace-${escapeHtml(trace.event_type.replace("trace.", ""))}" data-trace-index="${index}" type="button" style="left:${left}%;width:${width}%" title="${escapeHtml(hoverLabel)}" aria-label="${escapeHtml(hoverLabel)}">${escapeHtml(traceName)}</button>`;
}

/** Attach cursor, hover, and click behavior to the shared trace timeline. */
function bindTraceTimelineInteractions(target, totalDuration) {
  const viewport = elements.sessionTraceViewport;
  const cursor = target.querySelector("[data-trace-cursor]");
  let panStartX = null;
  let panStartScrollLeft = 0;
  viewport.onmousemove = (event) => {
    const track = event.target.closest(".trace-lane-track, .trace-swimlane-track") || target.querySelector(".trace-lane-track, .trace-swimlane-track");
    if (!track || !cursor) return;
    const trackBounds = track.getBoundingClientRect();
    const targetBounds = target.getBoundingClientRect();
    const x = Math.max(0, Math.min(trackBounds.width, event.clientX - trackBounds.left));
    const elapsed = Math.max(0, Math.min(totalDuration, x / Math.max(trackBounds.width, 1) * totalDuration));
    cursor.style.left = `${event.clientX - targetBounds.left + viewport.scrollLeft}px`;
    cursor.querySelector("span").textContent = formatElapsedMilliseconds(elapsed);
    cursor.hidden = false;
  };
  viewport.onmouseleave = () => {
    if (cursor) cursor.hidden = true;
  };
  viewport.onwheel = (event) => {
    event.preventDefault();
    setTraceZoom(event.deltaY < 0 ? "in" : "out");
  };
  viewport.onpointerdown = (event) => {
    if (event.button !== 0) return;
    if (event.target.closest(".trace-bar")) return;
    panStartX = event.clientX;
    panStartScrollLeft = viewport.scrollLeft;
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add("is-panning");
  };
  viewport.onpointermove = (event) => {
    if (panStartX == null) return;
    const distance = event.clientX - panStartX;
    viewport.scrollLeft = panStartScrollLeft - distance;
  };
  const finishPan = (event) => {
    if (panStartX == null) return;
    panStartX = null;
    viewport.classList.remove("is-panning");
    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
  };
  viewport.onpointerup = finishPan;
  viewport.onpointercancel = finishPan;
}

/** Show the complete span payload after a user clicks a trace bar. */
function renderTraceDetail(trace, sessionStart) {
  const startedAt = trace.started_at;
  const endedAt = trace.ended_at || trace.started_at;
  const metadata = trace.metadata && Object.keys(trace.metadata).length ? `<pre>${escapeHtml(JSON.stringify(trace.metadata, null, 2))}</pre>` : `<p class="trace-detail-empty">No attributes recorded.</p>`;
  const rawPayload = trace.raw_payload && Object.keys(trace.raw_payload).length ? `<pre>${escapeHtml(JSON.stringify(trace.raw_payload, null, 2))}</pre>` : `<p class="trace-detail-empty">No raw payload recorded.</p>`;
  elements.sessionTraceDetail.innerHTML = `<div class="trace-detail-header"><div><p class="eyebrow">TRACE DETAILS</p><h3>${escapeHtml(trace.event_type)}</h3></div><button class="icon-button" data-close-trace-detail type="button" aria-label="Close trace details">×</button></div><div class="trace-detail-grid"><div><span>Start time</span><strong>${escapeHtml(formatDateTimeWithSeconds(startedAt))}</strong></div><div><span>End time</span><strong>${escapeHtml(formatDateTimeWithSeconds(endedAt))}</strong></div><div><span>Elapsed start</span><strong>${escapeHtml(formatTimestampWithElapsed(startedAt, sessionStart))}</strong></div><div><span>Duration</span><strong>${escapeHtml(formatLatency(getTraceDurationMs(trace)))}</strong></div><div><span>Status</span><strong>${escapeHtml(trace.status || "unknown")}</strong></div><div><span>Turn</span><strong>${escapeHtml(trace.turn_id || "Session")}</strong></div></div><div class="trace-detail-attributes"><span>Attributes</span>${metadata}</div><div class="trace-detail-attributes"><span>Raw payload</span>${rawPayload}</div>`;
  elements.sessionTraceList.closest(".trace-workspace")?.classList.add("has-trace-detail");
  elements.sessionTraceDetail.hidden = false;
  elements.sessionTraceDetail.querySelector("[data-close-trace-detail]").addEventListener("click", () => {
    elements.sessionTraceDetail.hidden = true;
    elements.sessionTraceList.closest(".trace-workspace")?.classList.remove("has-trace-detail");
  });
  elements.sessionTraceDetail.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/** Prefer the persisted duration, falling back to timestamps for older records. */
function getTraceDurationMs(trace) {
  if (typeof trace.duration_ms === "number") return trace.duration_ms;
  if (!trace.started_at || !trace.ended_at) return null;
  return Math.max(0, new Date(trace.ended_at).getTime() - new Date(trace.started_at).getTime());
}

/** Switch between transcript, logs, and trace views without refetching data. */
function setSessionView(viewName) {
  pageState.sessionView = viewName;
  document.querySelectorAll("[data-session-view]").forEach((button) => {
    const selected = button.dataset.sessionView === viewName;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", String(selected));
  });
  document.querySelectorAll("[data-session-view-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.sessionViewPanel !== viewName;
  });
}

/** Format a millisecond value for compact metric cards and rows. */
function formatLatency(milliseconds) {
  return typeof milliseconds === "number" ? `${Math.round(milliseconds)} ms` : "—";
}

/** Format a timestamp with both wall-clock time and elapsed session time. */
function formatTimestampWithElapsed(value, sessionStart) {
  if (!value) return "Unknown time";
  const elapsed = Math.max(0, new Date(value).getTime() - sessionStart);
  return `${formatDateTimeWithSeconds(value)} · +${(elapsed / 1000).toFixed(2)}s`;
}

/** Format a timestamp with seconds for logs and transcript rows. */
function formatDateTimeWithSeconds(value) {
  if (!value) return "Unknown time";
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value));
}

/** Format an elapsed duration for trace-axis tick labels. */
function formatElapsedMilliseconds(milliseconds) {
  return `+${(milliseconds / 1000).toFixed(1)}s`;
}

/** Format a timestamp consistently across the session details page. */
function formatDateTime(value) {
  if (!value) return "Unknown time";
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

/** Format the selected dashboard date without exposing implementation details. */
function formatDate(dateValue) {
  if (!dateValue) return "";
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(new Date(`${dateValue}T00:00:00Z`));
}

/** Load agents from Supabase and render the current workspace. */
async function loadAgents() {
  try {
    clearError(elements.pageError);
    const response = await callAgentsApi();
    pageState.agents = response.agents ?? [];
    renderAgentList();
  } catch (error) {
    showError(elements.pageError, error.message);
    showApplication();
  }
}

/** Return the agents that match the current search and runtime-status filters. */
function getVisibleAgents() {
  const searchTerm = elements.searchInput.value.trim().toLowerCase();
  const selectedStatus = elements.statusFilter.value;
  return pageState.agents.filter((agent) => {
    const matchesSearch = [agent.name, agent.description].some((value) => value.toLowerCase().includes(searchTerm));
    const matchesStatus = selectedStatus === "all" || agent.runtime_status === selectedStatus;
    return matchesSearch && matchesStatus;
  });
}

/** Render cards or a useful empty state whenever agent data changes. */
function renderAgentList() {
  const visibleAgents = getVisibleAgents();
  elements.list.innerHTML = visibleAgents.map(createAgentCardMarkup).join("");
  elements.emptyState.hidden = visibleAgents.length > 0;
  const hasFilters = elements.searchInput.value || elements.statusFilter.value !== "all";
  elements.emptyTitle.textContent = hasFilters ? "No matching agents" : "No agents yet";
  elements.emptyDescription.textContent = hasFilters
    ? "Try a different search or status filter."
    : "Create your first agent to start shaping a voice experience.";
  elements.list.querySelectorAll("[data-action='edit']").forEach((button) => button.addEventListener("click", () => openEditModal(button.dataset.agentId)));
  elements.list.querySelectorAll("[data-action='metrics']").forEach((button) => button.addEventListener("click", () => loadAgentMetrics(button.dataset.agentId)));
  elements.list.querySelectorAll("[data-action='archive']").forEach((button) => button.addEventListener("click", () => archiveAgent(button.dataset.agentId)));
  elements.list.querySelectorAll("[data-action='activate']").forEach((button) => button.addEventListener("click", () => activateAgent(button.dataset.agentId)));
  elements.list.querySelectorAll("[data-action='call']").forEach((button) => button.addEventListener("click", () => startBrowserSession(button.dataset.agentId)));
}

/** Build a card that exposes the agent's purpose and the available actions. */
function createAgentCardMarkup(agent) {
  const initials = agent.name.split(" ").map((word) => word[0]).join("").slice(0, 2).toUpperCase();
  const updatedDate = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(agent.updated_at));
  const callAction = agent.runtime_status === "offline"
    ? ""
    : `<button class="text-button call-agent" data-action="call" data-agent-id="${agent.id}" type="button">Start call</button>`;
  const lifecycleAction = agent.runtime_status === "offline"
    ? `<button class="text-button" data-action="activate" data-agent-id="${agent.id}" type="button">Activate</button>`
    : `<button class="text-button delete" data-action="archive" data-agent-id="${agent.id}" type="button">Archive</button>`;
  return `<article class="agent-card"><div class="agent-card-header"><div class="agent-avatar" aria-hidden="true">${initials}</div><span class="badge ${agent.runtime_status}">${agent.runtime_status}</span></div><h2>${escapeHtml(agent.name)}</h2><p class="agent-description">${escapeHtml(agent.description || "No description yet.")}</p><div class="agent-meta"><span>${escapeHtml(agent.model)}</span><span>·</span><span>${agent.language === "tr" ? "Turkish" : "English"}</span><span>·</span><span>Updated ${updatedDate}</span></div><div class="card-actions"><button class="text-button" data-action="metrics" data-agent-id="${agent.id}" type="button">Metrics</button>${callAction}<button class="text-button" data-action="edit" data-agent-id="${agent.id}" type="button">Edit</button>${lifecycleAction}</div></article>`;
}

/** Escape user-entered text before putting it into card markup. */
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

/** Update a LiveKit session's persisted lifecycle status without hiding the call UI. */
async function updateBrowserSessionStatus(sessionId, status) {
  return callWorkspaceApi("livekit-session", `?id=${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}

/** Start a browser microphone session for one available agent. */
async function startBrowserSession(agentId) {
  if (pageState.liveSession) return;
  const agent = pageState.agents.find((candidate) => candidate.id === agentId);
  if (!agent || agent.runtime_status === "offline") return;
  if (!window.LivekitClient) {
    showError(elements.pageError, "The LiveKit browser client could not be loaded. Refresh the page and try again.");
    return;
  }

  clearError(elements.callError);
  elements.callModal.hidden = false;
  elements.callAgentName.textContent = `Connecting to ${agent.name}…`;
  elements.callStatus.textContent = "Connecting";
  elements.callStatus.className = "badge sleeping";
  elements.muteCallButton.disabled = true;

  try {
    const response = await callWorkspaceApi("livekit-session", "", {
      method: "POST",
      body: JSON.stringify({ agent_id: agent.id, source: "user_started" }),
    });
    const room = new window.LivekitClient.Room({ adaptiveStream: true, dynacast: true });
    pageState.liveSession = { room, sessionId: response.session_id, muted: false };

    room.on(window.LivekitClient.RoomEvent.TrackSubscribed, (track) => {
      if (track.kind !== window.LivekitClient.Track.Kind.Audio) return;
      const audioElement = track.attach();
      audioElement.autoplay = true;
      elements.remoteAudioContainer.appendChild(audioElement);
    });
    room.on(window.LivekitClient.RoomEvent.TrackUnsubscribed, (track) => track.detach());
    room.on(window.LivekitClient.RoomEvent.Disconnected, () => {
      if (pageState.liveSession) void finishBrowserSession("completed", false);
    });

    await room.connect(response.server_url, response.participant_token);
    await room.localParticipant.setMicrophoneEnabled(true);
    await updateBrowserSessionStatus(response.session_id, "active");
    elements.callAgentName.textContent = `Connected to ${agent.name}. Speak naturally and end the call when you are finished.`;
    elements.callStatus.textContent = "Active";
    elements.callStatus.className = "badge active";
    elements.muteCallButton.disabled = false;
    await room.startAudio().catch(() => undefined);
    await loadDashboard();
  } catch (error) {
    const sessionId = pageState.liveSession?.sessionId;
    if (sessionId) await updateBrowserSessionStatus(sessionId, "failed").catch(() => undefined);
    pageState.liveSession = null;
    showError(elements.callError, error.message ?? "Could not start the browser session.");
    elements.callStatus.textContent = "Failed";
    elements.callStatus.className = "badge offline";
  }
}

/** End the active browser call and persist its terminal session status. */
async function finishBrowserSession(status = "completed", disconnectRoom = true) {
  const liveSession = pageState.liveSession;
  if (!liveSession) {
    elements.callModal.hidden = true;
    return;
  }
  pageState.liveSession = null;
  if (disconnectRoom) await liveSession.room.disconnect();
  await updateBrowserSessionStatus(liveSession.sessionId, status).catch(() => undefined);
  elements.remoteAudioContainer.replaceChildren();
  elements.muteCallButton.disabled = true;
  elements.callModal.hidden = true;
  await Promise.all([loadAgents(), loadDashboard()]);
}

/** Toggle the local microphone while keeping the LiveKit room connected. */
async function toggleCallMute() {
  if (!pageState.liveSession) return;
  pageState.liveSession.muted = !pageState.liveSession.muted;
  await pageState.liveSession.room.localParticipant.setMicrophoneEnabled(!pageState.liveSession.muted);
  elements.muteCallButton.textContent = pageState.liveSession.muted ? "Unmute microphone" : "Mute microphone";
}

/** Open a blank form for a new agent. */
function openCreateModal() {
  pageState.editingAgentId = null;
  elements.form.reset();
  elements.agentId.value = "";
  elements.language.value = "en";
  elements.ttsModel.value = "inworld/inworld-tts-2";
  elements.modalEyebrow.textContent = "NEW AGENT";
  elements.modalTitle.textContent = "Create an agent";
  showModal();
  void loadAgentToolSelection();
}

/** Populate the form with one existing agent for editing. */
async function openEditModal(agentId) {
  const agent = pageState.agents.find((candidate) => candidate.id === agentId);
  if (!agent) return;
  pageState.editingAgentId = agent.id;
  elements.agentId.value = agent.id;
  elements.name.value = agent.name;
  elements.description.value = agent.description;
  elements.instructions.value = agent.instructions;
  elements.model.value = agent.model;
  elements.language.value = agent.language || "en";
  elements.ttsModel.value = agent.tts_model || "inworld/inworld-tts-2";
  elements.modalEyebrow.textContent = "EDIT AGENT";
  elements.modalTitle.textContent = "Edit agent";
  showModal();
  try {
    await loadAgentToolSelection(agent.id);
  } catch (error) {
    showError(elements.formError, error.message);
  }
}

/** Display the dialog and focus the first meaningful field. */
function showModal() {
  clearError(elements.formError);
  elements.modal.hidden = false;
  elements.name.focus();
}

/** Close the dialog and clear stale validation feedback. */
function closeModal() {
  elements.modal.hidden = true;
  clearError(elements.formError);
}

/** Validate and save either a new agent or the edited agent through the API. */
async function saveAgent(event) {
  event.preventDefault();
  clearError(elements.formError);
  const name = elements.name.value.trim();
  const instructions = elements.instructions.value.trim();
  if (!name || !instructions) {
    showError(elements.formError, "Add an agent name and instructions before saving.");
    return;
  }

  const agentDetails = {
    name,
    description: elements.description.value.trim(),
    instructions,
    model: elements.model.value,
    language: elements.language.value,
    tts_model: elements.ttsModel.value,
  };
  const isEditing = Boolean(pageState.editingAgentId);
  const requestPath = isEditing ? `?id=${encodeURIComponent(pageState.editingAgentId)}` : "";
  try {
    const response = await callAgentsApi(requestPath, {
      method: isEditing ? "PATCH" : "POST",
      body: JSON.stringify(agentDetails),
    });
    const savedAgentId = response.agent?.id ?? pageState.editingAgentId;
    if (savedAgentId) {
      await callWorkspaceApi("tools", `?agent_id=${encodeURIComponent(savedAgentId)}`, {
        method: "PUT",
        body: JSON.stringify({ assignments: selectedAgentToolAssignments() }),
      });
    }
    await loadAgents();
    await loadDashboard();
    await loadTools();
    closeModal();
  } catch (error) {
    showError(elements.formError, error.message);
  }
}

/** Open the shared-tool form with safe defaults for a new definition. */
function openCreateToolModal() {
  pageState.editingToolId = null;
  elements.toolForm.reset();
  elements.toolId.value = "";
  elements.toolInputSchema.value = "{}";
  elements.toolEnabled.checked = true;
  elements.toolModalEyebrow.textContent = "NEW TOOL";
  elements.toolModalTitle.textContent = "Create a tool";
  clearError(elements.toolFormError);
  elements.toolModal.hidden = false;
  elements.toolName.focus();
}

/** Populate the shared-tool form for an existing definition. */
function openEditToolModal(toolId) {
  const tool = pageState.tools.find((candidate) => candidate.id === toolId);
  if (!tool) return;
  pageState.editingToolId = tool.id;
  elements.toolId.value = tool.id;
  elements.toolName.value = tool.name;
  elements.toolDescription.value = tool.description ?? "";
  elements.toolExecutionKey.value = tool.execution_key;
  elements.toolInputSchema.value = JSON.stringify(tool.input_schema ?? {}, null, 2);
  elements.toolEnabled.checked = Boolean(tool.is_enabled);
  elements.toolModalEyebrow.textContent = "EDIT TOOL";
  elements.toolModalTitle.textContent = "Edit tool";
  clearError(elements.toolFormError);
  elements.toolModal.hidden = false;
  elements.toolName.focus();
}

/** Close the shared-tool dialog. */
function closeToolModal() {
  elements.toolModal.hidden = true;
  clearError(elements.toolFormError);
}

/** Validate and save a shared tool definition through the authenticated API. */
async function saveTool(event) {
  event.preventDefault();
  clearError(elements.toolFormError);
  const name = elements.toolName.value.trim();
  const executionKey = elements.toolExecutionKey.value.trim();
  if (!name || !executionKey) {
    showError(elements.toolFormError, "Add a tool name and execution key before saving.");
    return;
  }
  let inputSchema;
  try {
    inputSchema = JSON.parse(elements.toolInputSchema.value || "{}");
  } catch {
    showError(elements.toolFormError, "Input schema must contain valid JSON.");
    return;
  }
  if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) {
    showError(elements.toolFormError, "Input schema must be a JSON object.");
    return;
  }
  const toolDetails = {
    name,
    description: elements.toolDescription.value.trim(),
    execution_key: executionKey,
    input_schema: inputSchema,
    is_enabled: elements.toolEnabled.checked,
  };
  const isEditing = Boolean(pageState.editingToolId);
  try {
    await callWorkspaceApi("tools", isEditing ? `?id=${encodeURIComponent(pageState.editingToolId)}` : "", {
      method: isEditing ? "PATCH" : "POST",
      body: JSON.stringify(toolDetails),
    });
    await loadTools();
    closeToolModal();
  } catch (error) {
    showError(elements.toolFormError, error.message);
  }
}

/** Toggle availability without deleting a shared tool definition. */
async function toggleTool(toolId, enabled) {
  try {
    await callWorkspaceApi("tools", `?id=${encodeURIComponent(toolId)}`, {
      method: "PATCH",
      body: JSON.stringify({ is_enabled: enabled }),
    });
    await loadTools();
  } catch (error) {
    showError(elements.toolPageError, error.message);
  }
}

/** Archive an agent while retaining its sessions and audit history. */
async function archiveAgent(agentId) {
  const agent = pageState.agents.find((candidate) => candidate.id === agentId);
  if (!agent || !window.confirm(`Archive ${agent.name}? It will become offline.`)) return;
  try {
    await callAgentsApi(`?id=${encodeURIComponent(agentId)}`, { method: "DELETE" });
    await loadAgents();
    await loadDashboard();
  } catch (error) {
    showError(elements.formError, error.message);
  }
}

/** Restore an offline agent so it can receive new sessions again. */
async function activateAgent(agentId) {
  const agent = pageState.agents.find((candidate) => candidate.id === agentId);
  if (!agent || !window.confirm(`Activate ${agent.name}? It will become available for sessions.`)) return;
  try {
    await callAgentsApi(`?id=${encodeURIComponent(agentId)}`, {
      method: "PATCH",
      body: JSON.stringify({ archived_at: null }),
    });
    await loadAgents();
    await loadDashboard();
  } catch (error) {
    showError(elements.pageError, error.message);
  }
}

/** Start the authenticated application and keep it synchronized with auth state. */
async function initialiseApplication() {
  if (!supabaseClient) {
    showError(elements.authError, missingConfigurationMessage());
    return;
  }

  let initialRouteRestored = false;
  const restoreInitialRoute = () => {
    if (initialRouteRestored) return;
    initialRouteRestored = true;
    void restoreLastPage();
  };

  supabaseClient.auth.onAuthStateChange((event, session) => {
    if (session) {
      showApplication();
      void Promise.all([loadAgents(), loadDashboard(), loadTools()]);
      if (event === "INITIAL_SESSION") restoreInitialRoute();
    } else {
      showAuthentication();
    }
  });

  const { data, error } = await supabaseClient.auth.getSession();
  if (error) {
    showError(elements.authError, error.message);
  } else if (data.session) {
    showApplication();
    await Promise.all([loadAgents(), loadDashboard(), loadTools()]);
    restoreInitialRoute();
  }
}

elements.signInForm.addEventListener("submit", signIn);
elements.signOutButton.addEventListener("click", signOut);
document.querySelectorAll(".navigation-link[data-page]").forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    showPage(link.dataset.page);
  });
});
document.querySelector("#open-create-button").addEventListener("click", openCreateModal);
elements.dashboardCreateButton.addEventListener("click", openCreateModal);
document.querySelector("#empty-create-button").addEventListener("click", openCreateModal);
document.querySelector("#open-tool-create-button").addEventListener("click", openCreateToolModal);
document.querySelector("#empty-tool-create-button").addEventListener("click", openCreateToolModal);
elements.seeAllSessionsButton.addEventListener("click", async () => {
  showPage("sessions-page");
  await loadAllSessions();
});
elements.backToDashboardButton.addEventListener("click", () => showPage("dashboard-page"));
elements.backToSessionsButton.addEventListener("click", () => showPage("sessions-page"));
document.querySelector("#back-to-agents-button").addEventListener("click", () => showPage("agents-page"));
document.querySelector("#agent-see-all-sessions-button").addEventListener("click", async () => {
  showPage("sessions-page");
  await loadAllSessions(pageState.selectedAgentMetricsId);
});
document.querySelectorAll("[data-session-view]").forEach((button) => {
  button.addEventListener("click", () => setSessionView(button.dataset.sessionView));
});
document.querySelectorAll("[data-trace-zoom]").forEach((button) => {
  button.addEventListener("click", () => setTraceZoom(button.dataset.traceZoom));
});
elements.endCallButton.addEventListener("click", () => void finishBrowserSession("completed"));
elements.muteCallButton.addEventListener("click", () => void toggleCallMute());
document.querySelector("#close-modal-button").addEventListener("click", closeModal);
document.querySelector("#cancel-modal-button").addEventListener("click", closeModal);
elements.form.addEventListener("submit", saveAgent);
document.querySelector("#close-tool-modal-button").addEventListener("click", closeToolModal);
document.querySelector("#cancel-tool-modal-button").addEventListener("click", closeToolModal);
elements.toolForm.addEventListener("submit", saveTool);
elements.searchInput.addEventListener("input", renderAgentList);
elements.statusFilter.addEventListener("change", renderAgentList);
elements.modal.addEventListener("click", (event) => { if (event.target === elements.modal) closeModal(); });
elements.toolModal.addEventListener("click", (event) => { if (event.target === elements.toolModal) closeToolModal(); });
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!elements.modal.hidden) closeModal();
  if (!elements.toolModal.hidden) closeToolModal();
});

void initialiseApplication();

/** Refresh server-derived runtime badges after webhook-driven lifecycle changes. */
window.setInterval(() => {
  if (!elements.appShell.hidden) void Promise.all([loadAgents(), loadDashboard(), loadTools()]);
}, 15000);
