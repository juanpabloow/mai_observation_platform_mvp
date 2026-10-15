import type { ConversationMode, MessageSender } from '../db/repositories/handoff.js';

export const CONTEXT_MESSAGE_LIMIT = 50;
export const CONTEXT_MESSAGE_CHARS = 2000;
export const CONTEXT_TOTAL_CHARS = 24000;

/** Narrow SQL projection: no metadata, agent identities, channel ids or failure details. */
export interface ContextMessage {
  id: string;
  sender: MessageSender;
  text: string;
  occurred_at: string;
  recorded_at: string;
  text_truncated: boolean;
}

export interface ContextSnapshot {
  conversation_id: string;
  mode: ConversationMode;
  through_message_id: string;
  latest_transition: {
    id: string;
    from_mode: ConversationMode;
    to_mode: ConversationMode;
    at: string;
  } | null;
  /** Newest first, bounded by the SQL LIMIT before any text leaves the database. */
  messages: ContextMessage[];
}

/** Bounded, chronological data, NOT new instructions or authorization. */
export function projectConversationContext(snapshot: ContextSnapshot) {
  let truncated = snapshot.messages.length > CONTEXT_MESSAGE_LIMIT;
  let chars = 0;
  const seen = new Set<string>();
  const selected: ContextMessage[] = [];
  if (snapshot.mode === 'bot') {
    for (const row of snapshot.messages.slice(0, CONTEXT_MESSAGE_LIMIT)) {
      if (row.id === snapshot.through_message_id || seen.has(row.id)) continue;
      seen.add(row.id);
      const text = row.text.slice(0, CONTEXT_MESSAGE_CHARS);
      if (chars + text.length > CONTEXT_TOTAL_CHARS) { truncated = true; break; }
      chars += text.length;
      const textTruncated = row.text_truncated || text.length < row.text.length;
      truncated ||= textTruncated;
      selected.push({
        id: row.id, sender: row.sender, text,
        occurred_at: row.occurred_at, recorded_at: row.recorded_at,
        text_truncated: textTruncated,
      });
    }
  }
  return {
    version: 1 as const,
    conversation_id: snapshot.conversation_id,
    mode: snapshot.mode,
    through_message_id: snapshot.through_message_id,
    latest_transition: snapshot.latest_transition,
    messages: selected.reverse(),
    truncated,
    history_is_authorization: false as const,
  };
}
