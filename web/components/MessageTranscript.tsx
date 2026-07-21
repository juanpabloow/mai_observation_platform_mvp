import { formatChatTime, formatDayLabel, localDayKey } from "@/lib/format";
import type { InboxMessageView } from "@/lib/inboxView";

const GROUP_GAP_MS = 3 * 60_000; // same sender within 3min stacks into one group

/**
 * The shared chat transcript used by BOTH the inbox thread drawer and the
 * execution-detail pane (H-8.2). Renders WhatsApp-style bubbles from
 * InboxMessageView[]: user left/neutral, bot right/emerald, human_agent
 * right/indigo (name once per consecutive-sender run), in-bubble bottom-right
 * timestamps, and date separators on day change.
 *
 * `onRetry` is optional — the inbox passes it (a failed own-send can be retried);
 * the read-only execution-detail transcript omits it. `highlightIds` marks the
 * messages that belong to a specific execution ("THIS EXECUTION"): those bubbles
 * get an amber ring, and — when `highlightLabel` is set (an id-precise match, not
 * the silent time-window fallback) — a centered "this execution" divider is shown
 * before the first highlighted message.
 */
export function MessageTranscript({
  messages,
  now,
  onRetry,
  highlightIds,
  highlightLabel = false,
}: {
  messages: InboxMessageView[];
  now: Date;
  onRetry?: (messageId: string) => void;
  highlightIds?: ReadonlySet<string>;
  highlightLabel?: boolean;
}) {
  if (messages.length === 0) {
    return <p className="py-8 text-center text-sm text-faint">No messages yet.</p>;
  }
  const firstHighlightId =
    highlightIds && highlightIds.size > 0
      ? messages.find((m) => highlightIds.has(m.id))?.id ?? null
      : null;

  // Build date separators + consecutive-sender runs; a "this execution" marker
  // (when labeled) breaks the run before the first highlighted message.
  const blocks: (Run | DateSep | Marker)[] = [];
  let lastDay: string | null = null;
  let run: Run | null = null;
  for (const m of messages) {
    const d = new Date(m.occurredAt);
    const day = localDayKey(d);
    if (day !== lastDay) {
      blocks.push({ type: "date", key: `date-${day}`, label: formatDayLabel(d, now) });
      lastDay = day;
      run = null;
    }
    if (highlightLabel && firstHighlightId && m.id === firstHighlightId) {
      blocks.push({ type: "marker", key: `marker-${m.id}`, label: "this execution" });
      run = null;
    }
    const prev = run?.items[run.items.length - 1];
    const sameRun =
      run !== null &&
      run.sender === m.sender &&
      prev !== undefined &&
      d.getTime() - new Date(prev.occurredAt).getTime() <= GROUP_GAP_MS;
    if (sameRun && run) {
      run.items.push(m);
    } else {
      run = { type: "run", key: `run-${m.id}`, sender: m.sender, items: [m] };
      blocks.push(run);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {blocks.map((b) =>
        b.type === "date" ? (
          <div key={b.key} className="my-1 flex justify-center">
            <span className="rounded-full bg-black/5 px-2.5 py-0.5 text-[11px] text-neutral-500 dark:bg-white/10 dark:text-muted">
              {b.label}
            </span>
          </div>
        ) : b.type === "marker" ? (
          <div key={b.key} className="my-1 flex justify-center">
            <span className="rounded-full bg-amber-400/15 px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wider text-amber-600 dark:text-amber-400">
              {b.label}
            </span>
          </div>
        ) : (
          <MessageRun key={b.key} run={b} onRetry={onRetry} highlightIds={highlightIds} />
        ),
      )}
    </div>
  );
}

interface Run {
  type: "run";
  key: string;
  sender: InboxMessageView["sender"];
  items: InboxMessageView[];
}
interface DateSep {
  type: "date";
  key: string;
  label: string;
}
interface Marker {
  type: "marker";
  key: string;
  label: string;
}

/** One consecutive-sender group: name once at the top, bubbles stacked tightly. */
function MessageRun({
  run,
  onRetry,
  highlightIds,
}: {
  run: Run;
  onRetry?: (id: string) => void;
  highlightIds?: ReadonlySet<string>;
}) {
  const isUser = run.sender === "user";
  const isAgent = run.sender === "human_agent";
  const agentName = isAgent ? run.items.find((m) => m.agentName)?.agentName ?? null : null;
  return (
    <div className={`flex flex-col gap-0.5 ${isUser ? "items-start" : "items-end"}`}>
      {isAgent && agentName ? (
        <span className="px-1 text-[11px] font-medium text-faint">{agentName}</span>
      ) : null}
      {run.items.map((m) => (
        <Bubble key={m.id} msg={m} onRetry={onRetry} highlighted={highlightIds?.has(m.id) ?? false} />
      ))}
    </div>
  );
}

/**
 * A single bubble. user → left neutral; bot → right emerald; human_agent → right
 * indigo (failed → red). Timestamp in-bubble bottom-right, small + muted. A
 * highlighted (this-execution) bubble gets an amber ring.
 */
function Bubble({
  msg,
  onRetry,
  highlighted,
}: {
  msg: InboxMessageView;
  onRetry?: (id: string) => void;
  highlighted: boolean;
}) {
  const isUser = msg.sender === "user";
  const isAgent = msg.sender === "human_agent";
  const sending = msg.status === "sending";
  const failed = msg.status === "failed";
  const time = formatChatTime(new Date(msg.occurredAt));

  const bubbleClass = isUser
    ? "bg-black/5 text-foreground dark:bg-white/10"
    : isAgent
      ? failed
        ? "bg-red-600/90 text-red-50"
        : "bg-indigo-600 text-indigo-50"
      : "bg-emerald-700 text-emerald-50";
  const metaClass = isUser
    ? "text-faint"
    : isAgent
      ? failed
        ? "text-red-100/80"
        : "text-indigo-100/80"
      : "text-emerald-100/80";

  const body =
    msg.text && msg.text.trim() !== ""
      ? msg.text
      : msg.contentType && msg.contentType !== "text"
        ? `[${msg.contentType}]`
        : "…";

  return (
    <div
      className={`max-w-[70%] rounded-xl px-3 py-2 text-sm leading-snug shadow-sm ${bubbleClass} ${
        sending ? "opacity-70" : ""
      } ${highlighted ? "ring-2 ring-amber-400/70" : ""}`}
    >
      <span className="whitespace-pre-wrap break-words align-middle">{body}</span>
      {failed && msg.failureDetail ? (
        <span className="mt-1 block rounded bg-black/20 px-1.5 py-1 text-[11px] text-red-50">
          {msg.failureDetail}
        </span>
      ) : null}
      <span className={`ml-2 inline-flex items-center gap-1.5 align-middle text-[10px] ${metaClass}`}>
        {sending ? <span>sending…</span> : null}
        {failed && onRetry ? (
          <button
            type="button"
            onClick={() => onRetry(msg.id)}
            className="rounded bg-white/20 px-1 text-[10px] font-medium text-white hover:bg-white/30"
          >
            Retry
          </button>
        ) : null}
        <span>{time}</span>
      </span>
    </div>
  );
}
