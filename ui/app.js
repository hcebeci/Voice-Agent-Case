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

const pageState = { agents: [], editingAgentId: null, dashboard: null };
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
  sessionsPage: document.querySelector("#sessions-page"),
  dashboardCreateButton: document.querySelector("#dashboard-create-button"),
  sessionsTodayValue: document.querySelector("#sessions-today-value"),
  availableAgentsValue: document.querySelector("#available-agents-value"),
  activeAgentsValue: document.querySelector("#active-agents-value"),
  sleepingAgentsValue: document.querySelector("#sleeping-agents-value"),
  dashboardDate: document.querySelector("#dashboard-date"),
  sessionTimeline: document.querySelector("#session-timeline"),
  latestSessionList: document.querySelector("#latest-session-list"),
  allSessionList: document.querySelector("#all-session-list"),
  seeAllSessionsButton: document.querySelector("#see-all-sessions-button"),
  backToDashboardButton: document.querySelector("#back-to-dashboard-button"),
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
};

/** Display the authenticated workspace and hide the sign-in form. */
function showApplication() {
  elements.authScreen.hidden = true;
  elements.appShell.hidden = false;
}

/** Return the user to the sign-in screen after logout or an expired session. */
function showAuthentication() {
  elements.appShell.hidden = true;
  elements.authScreen.hidden = false;
}

/** Switch between the dashboard, agent list, and session history views. */
function showPage(pageId) {
  [elements.dashboardPage, elements.agentsPage, elements.sessionsPage].forEach((page) => {
    page.hidden = page.id !== pageId;
  });
  document.querySelectorAll(".navigation-link[data-page]").forEach((link) => {
    const isCurrentPage = link.dataset.page === pageId;
    link.classList.toggle("active", isCurrentPage);
    if (isCurrentPage) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
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
    showError(elements.authError, "Supabase configuration is missing. Check supabase/.env.");
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

/** Load all sessions for the full-session history page. */
async function loadAllSessions() {
  try {
    const response = await callWorkspaceApi("sessions", "?limit=100");
    renderSessionList(elements.allSessionList, response.sessions ?? [], "No sessions have been recorded yet.");
  } catch (error) {
    showError(elements.pageError, error.message);
  }
}

/** Render dashboard metric cards and its two session lists. */
function renderDashboard(dashboard) {
  const metrics = dashboard.metrics ?? {};
  elements.sessionsTodayValue.textContent = metrics.total_sessions_today ?? 0;
  elements.availableAgentsValue.textContent = metrics.available_agent_count ?? 0;
  elements.activeAgentsValue.textContent = metrics.active_agent_count ?? 0;
  elements.sleepingAgentsValue.textContent = metrics.sleeping_agent_count ?? 0;
  elements.dashboardDate.textContent = formatDate(dashboard.date);
  renderSessionList(elements.sessionTimeline, dashboard.today_sessions ?? [], "No sessions today.");
  renderSessionList(elements.latestSessionList, dashboard.latest_sessions ?? [], "No sessions have been recorded yet.");
}

/** Render session rows consistently across the dashboard and history page. */
function renderSessionList(target, sessions, emptyMessage) {
  if (!sessions.length) {
    target.innerHTML = `<p class="session-empty">${emptyMessage}</p>`;
    return;
  }
  target.innerHTML = sessions.map(createSessionRowMarkup).join("");
}

/** Build a readable session row with its associated agent name and status. */
function createSessionRowMarkup(session) {
  const sessionAgent = Array.isArray(session.agents) ? session.agents[0] : session.agents;
  const agentName = sessionAgent?.name ?? "Unknown agent";
  const sessionDate = session.created_at ? new Date(session.created_at) : null;
  const sessionTime = sessionDate ? new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(sessionDate) : "Not started";
  const statusLabel = session.status.replaceAll("_", " ");
  return `<div class="session-row"><span class="session-indicator" aria-hidden="true"></span><div class="session-row-content"><div class="session-row-title">${escapeHtml(agentName)}</div><div class="session-row-meta">${escapeHtml(session.source)} · ${escapeHtml(sessionTime)}</div></div><span class="session-row-status">${escapeHtml(statusLabel)}</span></div>`;
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
  elements.list.querySelectorAll("[data-action='archive']").forEach((button) => button.addEventListener("click", () => archiveAgent(button.dataset.agentId)));
  elements.list.querySelectorAll("[data-action='activate']").forEach((button) => button.addEventListener("click", () => activateAgent(button.dataset.agentId)));
}

/** Build a card that exposes the agent's purpose and the available actions. */
function createAgentCardMarkup(agent) {
  const initials = agent.name.split(" ").map((word) => word[0]).join("").slice(0, 2).toUpperCase();
  const updatedDate = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(agent.updated_at));
  const lifecycleAction = agent.runtime_status === "offline"
    ? `<button class="text-button" data-action="activate" data-agent-id="${agent.id}" type="button">Activate</button>`
    : `<button class="text-button delete" data-action="archive" data-agent-id="${agent.id}" type="button">Archive</button>`;
  return `<article class="agent-card"><div class="agent-card-header"><div class="agent-avatar" aria-hidden="true">${initials}</div><span class="badge ${agent.runtime_status}">${agent.runtime_status}</span></div><h2>${escapeHtml(agent.name)}</h2><p class="agent-description">${escapeHtml(agent.description || "No description yet.")}</p><div class="agent-meta"><span>${escapeHtml(agent.model)}</span><span>·</span><span>Updated ${updatedDate}</span></div><div class="card-actions"><button class="text-button" data-action="edit" data-agent-id="${agent.id}" type="button">Edit</button>${lifecycleAction}</div></article>`;
}

/** Escape user-entered text before putting it into card markup. */
function escapeHtml(value) {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

/** Open a blank form for a new agent. */
function openCreateModal() {
  pageState.editingAgentId = null;
  elements.form.reset();
  elements.agentId.value = "";
  elements.modalEyebrow.textContent = "NEW AGENT";
  elements.modalTitle.textContent = "Create an agent";
  showModal();
}

/** Populate the form with one existing agent for editing. */
function openEditModal(agentId) {
  const agent = pageState.agents.find((candidate) => candidate.id === agentId);
  if (!agent) return;
  pageState.editingAgentId = agent.id;
  elements.agentId.value = agent.id;
  elements.name.value = agent.name;
  elements.description.value = agent.description;
  elements.instructions.value = agent.instructions;
  elements.model.value = agent.model;
  elements.modalEyebrow.textContent = "EDIT AGENT";
  elements.modalTitle.textContent = "Edit agent";
  showModal();
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
  };
  const isEditing = Boolean(pageState.editingAgentId);
  const requestPath = isEditing ? `?id=${encodeURIComponent(pageState.editingAgentId)}` : "";
  try {
    await callAgentsApi(requestPath, {
      method: isEditing ? "PATCH" : "POST",
      body: JSON.stringify(agentDetails),
    });
    await loadAgents();
    await loadDashboard();
    closeModal();
  } catch (error) {
    showError(elements.formError, error.message);
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
    showError(elements.authError, "Supabase configuration is missing. Check supabase/.env.");
    return;
  }

  supabaseClient.auth.onAuthStateChange((_event, session) => {
    if (session) {
      showApplication();
      void Promise.all([loadAgents(), loadDashboard()]);
    } else {
      showAuthentication();
    }
  });

  const { data, error } = await supabaseClient.auth.getSession();
  if (error) {
    showError(elements.authError, error.message);
  } else if (data.session) {
    showApplication();
    await Promise.all([loadAgents(), loadDashboard()]);
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
elements.seeAllSessionsButton.addEventListener("click", async () => {
  showPage("sessions-page");
  await loadAllSessions();
});
elements.backToDashboardButton.addEventListener("click", () => showPage("dashboard-page"));
document.querySelector("#close-modal-button").addEventListener("click", closeModal);
document.querySelector("#cancel-modal-button").addEventListener("click", closeModal);
elements.form.addEventListener("submit", saveAgent);
elements.searchInput.addEventListener("input", renderAgentList);
elements.statusFilter.addEventListener("change", renderAgentList);
elements.modal.addEventListener("click", (event) => { if (event.target === elements.modal) closeModal(); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !elements.modal.hidden) closeModal(); });

void initialiseApplication();
