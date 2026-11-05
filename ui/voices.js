"use strict";

/** Hosted metadata and samples only: no audio is persisted by this application. */
window.HostedVoicePicker = class HostedVoicePicker {
  constructor({ model, voice, audio, details, status }) {
    Object.assign(this, { model, voice, audio, details, status });
    this.models = [];
    model.addEventListener("change", () => this.renderVoices());
    voice.addEventListener("change", () => this.renderPreview());
    audio.addEventListener("error", () => {
      status.textContent = "The hosted sample is unavailable. You can still save this voice and test it in a call.";
    });
  }

  async load(modelId = "xai/tts-1", voiceId = null) {
    this.stop();
    this.model.disabled = true;
    this.voice.disabled = true;
    this.status.textContent = "Loading multilingual voices…";
    try {
      if (!this.models.length) {
        const response = await fetch("voice-catalog.json", { cache: "no-cache" });
        if (!response.ok) throw new Error("Could not load voices. Reopen the editor to retry.");
        this.models = (await response.json()).models;
      }
      this.model.replaceChildren();
      for (const item of this.models) this.model.add(new Option(`${item.provider} · ${item.name}`, item.id));
      if (!this.models.some(item => item.id === modelId)) {
        const legacy = { "inworld/inworld-tts-2": "Inworld TTS 2", "cartesia/sonic-3": "Cartesia Sonic 3" };
        if (!legacy[modelId]) throw new Error("The saved TTS model is no longer supported. Choose a multilingual model.");
        this.model.add(new Option(`${legacy[modelId]} · saved setting`, modelId));
      }
      this.model.value = modelId;
      this.model.disabled = false;
      this.renderVoices(voiceId);
    } catch (error) {
      this.status.textContent = error.message;
      throw error;
    }
  }

  renderVoices(voiceId = null) {
    this.stop();
    const selected = this.models.find(item => item.id === this.model.value);
    this.voice.replaceChildren();
    if (selected) {
      for (const item of selected.voices) this.voice.add(new Option(`${item.name} · ${item.gender}`, item.id));
      this.voice.value = selected.voices.some(item => item.id === voiceId) ? voiceId : selected.default_voice;
    } else {
      const defaults = { "inworld/inworld-tts-2": "Ashley", "cartesia/sonic-3": "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc" };
      const value = voiceId || defaults[this.model.value];
      this.voice.add(new Option(`Saved voice · ${value}`, value));
    }
    this.voice.disabled = false;
    this.renderPreview();
  }

  renderPreview() {
    this.stop();
    const model = this.models.find(item => item.id === this.model.value);
    const selected = model?.voices.find(item => item.id === this.voice.value);
    this.details.textContent = selected ? `Multilingual · English and Turkish. ${selected.description}` : "Your existing voice setting is preserved. Choose Google or xAI to browse multilingual voices.";
    if (selected?.preview_url) {
      this.audio.src = selected.preview_url;
      this.audio.hidden = false;
      this.status.textContent = selected.preview_note || "English sample hosted by LiveKit. This voice also supports Turkish. Use the player to listen.";
    } else {
      this.status.textContent = selected ? "No hosted sample is available here. Save and use Test a conversation to hear this voice in your selected language." : "";
    }
  }

  stop() {
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    this.audio.hidden = true;
  }
};
