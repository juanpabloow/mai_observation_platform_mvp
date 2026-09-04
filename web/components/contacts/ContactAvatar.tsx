import { avatarColor } from "@/lib/avatarColor";
import { conversationAvatarLabel } from "@/lib/inboxView";

/**
 * A contact's identity DISC — a two-tone gradient sphere carrying their initials.
 *
 * Extracted from the contacts page, where it was a local function, because the
 * redesign draws it on four surfaces (the table row, the contact panel header, the
 * inbox queue, the thread) and a disc defined per screen is how the same person ends
 * up 26px and teal in one place and 30px and purple in another.
 *
 * The tone is derived from the contact's own identifier (see lib/avatarColor.ts), so
 * it is stable across reloads and re-sorts without anything being stored — and the
 * SEED is the name when there is one, else the channel id, so a contact who later gets
 * a name keeps the colour they had while they were just a phone number.
 *
 * `aria-hidden` on purpose: the disc is a recognition aid and always sits beside the
 * name it stands for, so announcing "C R" before the name would be noise.
 */
export function ContactAvatar({
  name,
  fallback,
  size = 26,
}: {
  name: string | null;
  fallback: string;
  /**
   * Diameter in px. The design uses 40 (panel header), 30 (table / queue row) and
   * 26 (thread), and the initials have to scale with it — a 9.5px label in a 40px
   * disc looks like a mistake. The ratio below is the artboard's at all three sizes.
   */
  size?: 26 | 30 | 38 | 40;
}) {
  const label = conversationAvatarLabel(fallback, name);
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, fontSize: Math.round(size * 0.335 * 100) / 100 }}
      className={`u-mono flex shrink-0 items-center justify-center rounded-full font-semibold ${avatarColor(
        name?.trim() ? name : fallback,
      )}`}
    >
      {label}
    </span>
  );
}
