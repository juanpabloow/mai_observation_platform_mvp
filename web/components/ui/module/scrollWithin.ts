/**
 * Scroll an element into view inside its NEAREST scrolling container only.
 *
 * `Element.scrollIntoView` also scrolls every scrollable ancestor — including the app
 * shell's body, which is `overflow: hidden` but still programmatically scrollable — and
 * that shifted the whole interface (sidebar and header) out of place. Module screens
 * scroll inside their own content region, so that is the only box that should move.
 */
export function scrollWithin(el: HTMLElement, { block = "start", smooth = true }: { block?: "start" | "center"; smooth?: boolean } = {}) {
  let box: HTMLElement | null = el.parentElement;
  while (box) {
    const oy = getComputedStyle(box).overflowY;
    if ((oy === "auto" || oy === "scroll") && box.scrollHeight > box.clientHeight) break;
    box = box.parentElement;
  }
  if (!box) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const delta = el.getBoundingClientRect().top - box.getBoundingClientRect().top;
  const offset = block === "center" ? (box.clientHeight - el.getBoundingClientRect().height) / 2 : 16;
  box.scrollTo({ top: box.scrollTop + delta - offset, behavior: smooth && !reduce ? "smooth" : "auto" });
}
