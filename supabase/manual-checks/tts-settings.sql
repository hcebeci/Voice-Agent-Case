-- Confirm the selected LiveKit Inference TTS model for each agent.
select id, name, language, tts_model, updated_at
from public.agents
order by updated_at desc;

-- The MVP currently permits only the models exposed in the agent editor.
select id, name, tts_model
from public.agents
where tts_model not in ('cartesia/sonic-3', 'inworld/inworld-tts-2');
