/**
 * THE sidebar row — shape, size and type, in one place.
 *
 * Three components render a row in the rail: the static nav links and the account button
 * (both in AppSidebar), and the badge-bearing Inbox link (its own component, because it
 * polls a count). They MUST be the same object, and the row HEIGHT is exactly what drifts
 * silently when they are three separate class strings — one of them sat at 40px for a
 * commit while the others went to 32, which reads as a single loose row in an otherwise
 * even list.
 *
 * It lives in its own module rather than in AppSidebar because AppSidebar imports
 * InboxTabLink: exporting the constant from there and importing it back would be a cycle.
 * A one-constant module is the honest fix; a duplicated string is not.
 *
 * 38px tall (10px of padding around a 17.5px line). The visual rework first took this to
 * the artboard's 32px (8px padding, 13.5px text); on a real screen that read as fine print
 * rather than as chrome, so it steps back up — still well inside the 42px it started from.
 *
 * The SIZING (padding, gap) stays with each caller, because the collapsed rail centres its
 * icon and has no label to space against.
 */
export const RAIL_ROW =
  "group relative mx-2.5 flex items-center rounded-[10px] text-[0.875rem] leading-[1.25] transition-colors";
