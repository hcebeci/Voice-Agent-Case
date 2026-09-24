"use strict";

/** Storage key keeps the persistence detail in one place for an API migration. */
const AGENTS_STORAGE_KEY = "voice-agent-case.agents";

const initialAgents = [
  {
    id: "customer-support-guide",
    name: "Customer support guide",
    description: "Helps customers solve common product questions with confidence.",
    instructions: "You are a calm and helpful customer support specialist.",
    model: "google/gemma-4-31b-it",
    status: "active",
    updatedAt: "2026-09-24T09:00:00.000Z",
  },
  {
    id: "appointment-concierge",
    name: "Appointment concierge",
    description: "Books appointments and makes scheduling feel effortless.",
    instructions: "You help people find and book the right appointment.",
    model: "openai/gpt-4.1-mini",
    status: "draft",
    updatedAt: "2026-09-23T09:00:00.000Z",
  },
];

const pageState = { agents: loadAgents(), editingAgentId: null };
const elements = {
  list: document.querySelector("#agent-list"),
  emptyState: document.querySelector("#empty-state"),
  emptyTitle: document.querySelector("#empty-title"),
  emptyDescription: document.querySelector("#empty-description"),
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
  status: document.querySelector("#agent-status"),
};

/** Read saved agents and recover gracefully if browser storage is unavailable. */
function loadAgents() {
  try {
    const savedAgents = window.localStorage.getItem(AGENTS_STORAGE_KEY);
    return savedAgents ? JSON.parse(savedAgents) : initialAgents;
  } catch (error) {
    console.warn("Could not load saved agents.", error);
    return initialAgents;
  }
}

/** Keep the current list available across page refreshes. */
function saveAgents() {
  window.localStorage.setItem(AGENTS_STORAGE_KEY, JSON.stringify(pageState.agents));
}

/** Return the agents that match the current search and status controls. */
function getVisibleAgents() {
  const searchTerm = elements.searchInput.value.trim().toLowerCase();
  const selectedStatus = elements.statusFilter.value;
  return pageState.agents.filter((agent) => {
    const matchesSearch = [agent.name, agent.description].some((value) => value.toLowerCase().includes(searchTerm));
    const matchesStatus = selectedStatus === "all" || agent.status === selectedStatus;
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
  elements.list.querySelectorAll("[data-action='delete']").forEach((button) => button.addEventListener("click", () => deleteAgent(button.dataset.agentId)));
}

/** Build a card that exposes the agent's purpose and the available actions. */
function createAgentCardMarkup(agent) {
  const initials = agent.name.split(" ").map((word) => word[0]).join("").slice(0, 2).toUpperCase();
  const updatedDate = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(agent.updatedAt));
  return `<article class="agent-card"><div class="agent-card-header"><div class="agent-avatar" aria-hidden="true">${initials}</div><span class="badge ${agent.status}">${agent.status}</span></div><h2>${escapeHtml(agent.name)}</h2><p class="agent-description">${escapeHtml(agent.description || "No description yet.")}</p><div class="agent-meta"><span>${escapeHtml(agent.model)}</span><span>·</span><span>Updated ${updatedDate}</span></div><div class="card-actions"><button class="text-button" data-action="edit" data-agent-id="${agent.id}" type="button">Edit</button><button class="text-button delete" data-action="delete" data-agent-id="${agent.id}" type="button">Delete</button></div></article>`;
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
  elements.status.value = agent.status;
  elements.modalEyebrow.textContent = "EDIT AGENT";
  elements.modalTitle.textContent = "Edit agent";
  showModal();
}

/** Display the dialog and focus the first meaningful field. */
function showModal() {
  elements.formError.hidden = true;
  elements.modal.hidden = false;
  elements.name.focus();
}

/** Close the dialog and clear stale validation feedback. */
function closeModal() {
  elements.modal.hidden = true;
  elements.formError.hidden = true;
}

/** Validate and save either a new agent or the edited agent. */
function saveAgent(event) {
  event.preventDefault();
  const name = elements.name.value.trim();
  const instructions = elements.instructions.value.trim();
  if (!name || !instructions) {
    elements.formError.textContent = "Add an agent name and instructions before saving.";
    elements.formError.hidden = false;
    return;
  }
  const agentDetails = { name, description: elements.description.value.trim(), instructions, model: elements.model.value, status: elements.status.value, updatedAt: new Date().toISOString() };
  if (pageState.editingAgentId) {
    pageState.agents = pageState.agents.map((agent) => agent.id === pageState.editingAgentId ? { ...agent, ...agentDetails } : agent);
  } else {
    pageState.agents = [{ id: `${slugify(name)}-${Date.now()}`, ...agentDetails }, ...pageState.agents];
  }
  saveAgents();
  renderAgentList();
  closeModal();
}

/** Convert an agent name into a stable, readable identifier. */
function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "agent";
}

/** Ask for confirmation before removing an agent from local storage. */
function deleteAgent(agentId) {
  const agent = pageState.agents.find((candidate) => candidate.id === agentId);
  if (!agent || !window.confirm(`Delete ${agent.name}? This cannot be undone.`)) return;
  pageState.agents = pageState.agents.filter((candidate) => candidate.id !== agentId);
  saveAgents();
  renderAgentList();
}

document.querySelector("#open-create-button").addEventListener("click", openCreateModal);
document.querySelector("#empty-create-button").addEventListener("click", openCreateModal);
document.querySelector("#close-modal-button").addEventListener("click", closeModal);
document.querySelector("#cancel-modal-button").addEventListener("click", closeModal);
elements.form.addEventListener("submit", saveAgent);
elements.searchInput.addEventListener("input", renderAgentList);
elements.statusFilter.addEventListener("change", renderAgentList);
elements.modal.addEventListener("click", (event) => { if (event.target === elements.modal) closeModal(); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !elements.modal.hidden) closeModal(); });

renderAgentList();
