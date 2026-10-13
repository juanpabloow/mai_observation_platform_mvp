/**
 * How much of the LAYOUT viewport the on-screen keyboard covers, in px. iOS does not
 * resize the layout viewport for the keyboard (only the visual one), so a bottom-anchored
 * panel would keep its footer — Guardar — underneath it. Pure; see useKeyboardInset.
 */
export function keyboardInset(layoutHeight: number, visualHeight: number, visualOffsetTop: number): number {
  const covered = layoutHeight - visualHeight - visualOffsetTop;
  // Below ~60px it is browser chrome settling (URL bar), not a keyboard.
  return covered > 60 ? Math.round(covered) : 0;
}
