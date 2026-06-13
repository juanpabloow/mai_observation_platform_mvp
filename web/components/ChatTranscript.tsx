import type { ConversationTurnRow } from "@worker/db/repositories/conversationTurns.js";
import { formatChatTime, formatDayLabel, localDayKey } from "@/lib/format";

function hasText(value: string | null): value is string {
  return value !== null && value.trim() !== "";
}

/** One chat bubble: inbound (user, left, gray) or outbound (AI, right, green). */
function Bubble({ side, text, time }: { side: "in" | "out"; text: string; time: string }) {
  const out = side === "out";
  return (
    <div className={`flex ${out ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[78%] rounded-2xl px-3 py-2 shadow-sm ${
          out
            ? "rounded-br-sm bg-emerald-700/90 text-emerald-50"
            : "rounded-bl-sm bg-neutral-200 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
        }`}
      >
        <div className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed">
          {text}
        </div>
        <div className={`mt-1 text-right text-[10px] ${out ? "text-emerald-100/70" : "text-neutral-500"}`}>
          {time}
        </div>
      </div>
    </div>
  );
}

/**
 * Renders a list of conversation turns (already ordered oldest→newest) as a chat
 * transcript: date dividers on calendar-day change, user→inbound + AI→outbound
 * bubbles, and partial turns (only the present side renders — never empty
 * bubbles). Server component, reused by the full conversation thread (C3) and
 * the execution-detail side panel (C4).
 *
 * `highlightExecutionId` rings the turn derived from that execution and marks it
 * with data-focus="true" so a scroll container can center it on open.
 */
export function ChatTranscript({
  turns,
  now,
  highlightExecutionId,
}: {
  turns: ConversationTurnRow[];
  now: Date;
  highlightExecutionId?: string;
}) {
  const groups: { key: string; label: string; turns: ConversationTurnRow[] }[] = [];
  for (const t of turns) {
    const key = localDayKey(t.turn_timestamp);
    const last = groups[groups.length - 1];
    if (!last || last.key !== key) {
      groups.push({ key, label: formatDayLabel(t.turn_timestamp, now), turns: [t] });
    } else {
      last.turns.push(t);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {groups.map((group) => (
        <div key={group.key} className="flex flex-col gap-2">
          <div className="my-2 flex justify-center">
            <span className="rounded-full bg-black/5 px-3 py-1 text-xs text-neutral-500 dark:bg-white/5 dark:text-neutral-400">
              {group.label}
            </span>
          </div>
          {group.turns.map((t) => {
            const time = formatChatTime(t.turn_timestamp);
            const focused = highlightExecutionId !== undefined && t.execution_id === highlightExecutionId;
            return (
              <div
                key={t.id}
                data-focus={focused ? "true" : undefined}
                className={`flex flex-col gap-1 ${
                  focused ? "-mx-1 rounded-xl bg-amber-400/10 px-1.5 py-2 ring-1 ring-amber-400/40" : ""
                }`}
              >
                {focused ? (
                  <div className="text-center text-[10px] font-medium uppercase tracking-wider text-amber-500/90 dark:text-amber-400/80">
                    this execution
                  </div>
                ) : null}
                {hasText(t.user_message) ? <Bubble side="in" text={t.user_message} time={time} /> : null}
                {hasText(t.ai_response) ? <Bubble side="out" text={t.ai_response} time={time} /> : null}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
