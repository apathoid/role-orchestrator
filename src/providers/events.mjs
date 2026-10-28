import { AGENT_EVENT_TYPES } from './provider.mjs';

export function normalizeAgentEvent(event) {
  if (!event || typeof event !== 'object') return null;
  if (Object.values(AGENT_EVENT_TYPES).includes(event.type)) return event;
  switch (event.type) {
    case 'reasoning_summary': return { type: 'reasoning', text: event.text ?? '' };
    case 'commentary': return { type: 'commentary', text: event.text ?? '' };
    case 'task_plan_progress': return { type: 'plan_update', items: event.items ?? [] };
    case 'prompt_profile': return { type: 'prompt_profile', profile: event.profile };
    case 'activity': return { type: 'activity', activity: event.activity };
    case 'usage': return { type: 'usage', usage: event.usage, usageObservation: event.usageObservation ?? null, contextWindow: event.contextWindow ?? null };
    case 'tool_event': return { type: 'tool_call', update: event.update, observation: event.observation ?? null };
    case 'native_update': return { type: 'content_block', update: event.update };
    default: return { type: 'progress', payload: event };
  }
}
