"use strict";
const voiceRows = document.querySelector("#voice-rows");
const voiceSearch = document.querySelector("#voice-search");
const voiceCount = document.querySelector("#voice-count");
const voiceAudio = document.querySelector("#demo-audio");
const voiceStatus = document.querySelector("#demo-status");
let libraryVoices = [];
let activeVoice = null;
let playRequest = 0;

function clearPlayingVoice() {
  if (!activeVoice) return;
  activeVoice.button.textContent = "▶";
  activeVoice.button.setAttribute("aria-pressed", "false");
  activeVoice.button.setAttribute("aria-label", `Play ${activeVoice.name} by ${activeVoice.provider}`);
  activeVoice.row.classList.remove("is-playing");
  activeVoice = null;
}

function stopVoicePreview() {
  playRequest++;
  voiceAudio.pause();
  voiceAudio.removeAttribute("src");
  voiceAudio.load();
  clearPlayingVoice();
}

async function playLibraryVoice(voice) {
  const toggleOff = activeVoice === voice;
  stopVoicePreview();
  if (toggleOff) { voiceStatus.textContent = "Preview paused."; return; }
  const request = playRequest;
  activeVoice = voice;
  voice.button.textContent = "Ⅱ";
  voice.button.setAttribute("aria-pressed", "true");
  voice.button.setAttribute("aria-label", `Pause ${voice.name} by ${voice.provider}`);
  voice.row.classList.add("is-playing");
  voiceStatus.textContent = `Loading ${voice.name} by ${voice.provider}…`;
  voiceAudio.src = voice.preview_url;
  try {
    await voiceAudio.play();
    if (request === playRequest) voiceStatus.textContent = `Playing ${voice.name} by ${voice.provider} · ${voice.preview_note || "English sample"}`;
  } catch (error) {
    if (request !== playRequest) return;
    stopVoicePreview();
    voiceStatus.textContent = `Could not play ${voice.name}. Please try again.`;
  }
}

function renderVoiceLibrary() {
  stopVoicePreview();
  voiceStatus.textContent = "";
  voiceRows.replaceChildren();
  const query = voiceSearch.value.trim().toLowerCase();
  const visible = libraryVoices.filter(voice => `${voice.name} ${voice.provider} ${voice.gender}`.toLowerCase().includes(query));
  voiceCount.textContent = `${visible.length} of ${libraryVoices.length} voices`;
  for (const voice of visible) {
    const row = document.createElement("tr");
    const previewCell = row.insertCell();
    const button = document.createElement("button");
    button.type = "button";
    button.className = "play-button";
    button.textContent = "▶";
    button.disabled = !voice.preview_url;
    button.setAttribute("aria-pressed", "false");
    button.setAttribute("aria-label", `Play ${voice.name} by ${voice.provider}`);
    if (!voice.preview_url) button.title = "No hosted sample available";
    Object.assign(voice, { row, button });
    button.addEventListener("click", () => void playLibraryVoice(voice));
    button.addEventListener("keydown", event => {
      if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
      event.preventDefault();
      const buttons = Array.from(voiceRows.querySelectorAll("button:not(:disabled)"));
      const offset = event.key === "ArrowDown" ? 1 : -1;
      buttons[(buttons.indexOf(button) + offset + buttons.length) % buttons.length]?.focus();
    });
    previewCell.append(button);
    const nameCell = row.insertCell();
    nameCell.className = "voice-name";
    nameCell.textContent = voice.name;
    const description = document.createElement("span");
    description.className = "voice-description";
    description.textContent = voice.description;
    nameCell.append(description);
    row.insertCell().textContent = "Multilingual";
    row.insertCell().textContent = voice.gender;
    const provider = document.createElement("span");
    provider.className = "provider";
    const mark = document.createElement("span");
    mark.className = "provider-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = voice.provider === "Google" ? "G" : "x";
    provider.append(mark, document.createTextNode(voice.provider));
    row.insertCell().append(provider);
    voiceRows.append(row);
  }
  if (!visible.length) voiceStatus.textContent = "No voices match your search.";
}

voiceSearch.addEventListener("input", renderVoiceLibrary);
voiceAudio.addEventListener("ended", () => { clearPlayingVoice(); voiceStatus.textContent = "Preview finished."; });
voiceAudio.addEventListener("error", () => {
  if (!activeVoice) return;
  const name = activeVoice.name;
  stopVoicePreview();
  voiceStatus.textContent = `The hosted sample for ${name} is unavailable. Please try again.`;
});
window.addEventListener("pagehide", stopVoicePreview);

(async () => {
  try {
    const response = await fetch("voice-catalog.json", { cache: "no-cache" });
    if (!response.ok) throw new Error("Catalog unavailable");
    const catalog = await response.json();
    libraryVoices = catalog.models.flatMap(model => model.voices.map(voice => ({ ...voice, provider: model.provider })));
    libraryVoices.sort((a, b) => a.name.localeCompare(b.name) || a.provider.localeCompare(b.provider));
    renderVoiceLibrary();
  } catch (error) {
    voiceCount.textContent = "Voices unavailable";
    voiceStatus.textContent = "Could not load the voice library. Refresh the page to try again.";
  }
})();
