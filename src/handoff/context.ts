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
  /**
   * JP-2 — when the PLATFORM last handed this conversation back to the bot automatically (the
   * auto-return sweep), ISO-8601, else null. Lets the n8n prompt avoid immediately re-escalating the
   * same issue the moment it gets the conversation back (ping-pong). Null for a conversation that was
   * never auto-returned.
   */
  auto_returned_at: string | null;
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
    auto_returned_at: snapshot.auto_returned_at,
    messages: selected.reverse(),
    truncated,
    history_is_authorization: false as const,
  };
}

// ── AT-3: the optional `origin` block ────────────────────────────────────────────
// What the ad PROMISED + the campaign brief (business configuration written by the client),
// so a bot handling a conversation that came from an ad can skip the organic discovery flow.
// Added ONLY when the campaigns module is on and the conversation's contact has an ad touch
// inside the client's brief window (decided by the TOUCH, never by origin_kind). Absent → the
// response is byte-for-byte what it was before AT-3. The block carries NO ids the bot does not
// need (no ctwa_clid, no external ad/campaign ids, no internal ad/campaign uuids, no counts).

/** Ad copy truncation — the ad's promise is bounded before it is injected into a prompt. */
export const ORIGIN_AD_HEADLINE_CHARS = 200;
export const ORIGIN_AD_BODY_CHARS = 1000;

export interface ContextOriginAd {
  /** AT-2b person-set Ads Manager name, null when empty. */
  name: string | null;
  headline: string | null;
  body: string | null;
  /** AT-2b per-ad note the assistant reads with the brief, null when empty. */
  bot_note: string | null;
}

export interface ContextOriginCampaign {
  name: string;
  /** The campaign brief the client wrote in the UI; null when none was written. */
  bot_brief: string | null;
  /** The service the campaign points the bot at — the bot's handle to book it. */
  target_service: { id: string; name: string } | null;
  promotion: { title: string; description: string | null } | null;
}

export interface ContextOrigin {
  source_type: 'ad' | 'post';
  ad: ContextOriginAd;
  /** null when the driving ad has no campaign yet (the bot still gets the ad text). */
  campaign: ContextOriginCampaign | null;
}

/** The raw SQL row readConversationOrigin selects (one driving touch's ad + its campaign). */
export interface OriginSnapshot {
  source_type: 'ad' | 'post';
  ad_name: string | null;
  ad_headline: string | null;
  ad_body: string | null;
  ad_bot_note: string | null;
  /** campaigns.name is NOT NULL, so a null here is the "no campaign" discriminator. */
  campaign_name: string | null;
  campaign_bot_brief: string | null;
  service_id: string | null;
  service_name: string | null;
  /** promotions.name (NOT NULL), exposed to the bot as the promotion `title`. */
  promo_title: string | null;
  promo_description: string | null;
}

/** Shape + bound one driving touch into the `origin` block. Pure, so the exact key set is
 *  unit-testable and no stray database field can ever ride along. */
export function projectConversationOrigin(row: OriginSnapshot): ContextOrigin {
  return {
    source_type: row.source_type,
    ad: {
      name: row.ad_name,
      headline: row.ad_headline === null ? null : row.ad_headline.slice(0, ORIGIN_AD_HEADLINE_CHARS),
      body: row.ad_body === null ? null : row.ad_body.slice(0, ORIGIN_AD_BODY_CHARS),
      bot_note: row.ad_bot_note,
    },
    campaign: row.campaign_name === null ? null : {
      name: row.campaign_name,
      bot_brief: row.campaign_bot_brief,
      target_service: row.service_id === null ? null : { id: row.service_id, name: row.service_name! },
      promotion: row.promo_title === null ? null : { title: row.promo_title, description: row.promo_description },
    },
  };
}
