-- 003_call_state.sql — per-call conversation state, persisted server-side.
-- AgentPhone's conversationState is not settable from webhook responses
-- (undocumented mechanism), so the calls row is the source of truth.

alter table calls add column state jsonb;
