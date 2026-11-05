-- Only identifiers are stored. Speech is generated remotely by LiveKit Inference.
alter table public.agents drop constraint if exists agents_tts_model_check;
alter table public.agents add constraint agents_tts_model_check
  check (tts_model in ('cartesia/sonic-3', 'inworld/inworld-tts-2', 'xai/tts-1', 'google/gemini-3.8-flash-tts'));

-- Preserve existing provider settings; restrict new providers to the verified catalog.
alter table public.agents add constraint agents_multilingual_voice_check
  check (voice is null or tts_model in ('cartesia/sonic-3', 'inworld/inworld-tts-2')
    or (tts_model = 'xai/tts-1' and voice in ('altair', 'ara', 'atlas', 'carina', 'castor', 'celeste', 'cosmo', 'eve', 'helios', 'helix', 'iris', 'kepler', 'leo', 'lumen', 'luna', 'lux', 'naksh', 'orion', 'perseus', 'rex', 'rigel', 'sal', 'sirius', 'ursa', 'zagan', 'zenith')) or (tts_model = 'google/gemini-3.8-flash-tts' and voice in ('Achernar', 'Achird', 'Algenib', 'Algieba', 'Alnilam', 'Aoede', 'Autonoe', 'Callirrhoe', 'Charon', 'Despina', 'Enceladus', 'Erinome', 'Fenrir', 'Gacrux', 'Iapetus', 'Kore', 'Laomedeia', 'Leda', 'Orus', 'Puck', 'Pulcherrima', 'Rasalgethi', 'Sadachbia', 'Sadaltager', 'Schedar', 'Sulafat', 'Umbriel', 'Vindemiatrix', 'Zephyr', 'Zubenelgenubi')));

comment on column public.agents.voice is 'Hosted provider voice ID; no voice audio or model files are stored.';
