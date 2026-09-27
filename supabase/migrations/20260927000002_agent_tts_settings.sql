-- Store the per-agent LiveKit Inference TTS model selection.
alter table public.agents
  add column if not exists tts_model text not null default 'inworld/inworld-tts-2';

update public.agents
set tts_model = 'inworld/inworld-tts-2'
where tts_model = 'cartesia/sonic-3';

alter table public.agents
  alter column tts_model set default 'inworld/inworld-tts-2';

alter table public.agents
  drop constraint if exists agents_tts_model_check;

alter table public.agents
  add constraint agents_tts_model_check
  check (tts_model in ('cartesia/sonic-3', 'inworld/inworld-tts-2'));

comment on column public.agents.tts_model is 'LiveKit Inference TTS model used by this agent.';
