"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

const WORDS = ["conversaciones", "reservas", "reseñas", "clientes", "recordatorios"] as const;
const ROTATE_MS = 2600;

/**
 * The login's left panel: «Tus conversaciones, en un solo lugar.» with the word rotating
 * through what the platform keeps together. The rotation is decoration — screen readers get
 * the whole sentence once — and it stays on the first word for people who ask for less motion
 * (the slide-in itself is switched off by the .u-access reduced-motion rule).
 */
export function LoginAside() {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => setIndex((i) => (i + 1) % WORDS.length), ROTATE_MS);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <>
      <h2 className="m-0 text-[40px] font-semibold leading-[1.08] tracking-[-.025em] text-[#ECECEE]">
        <span className="sr-only">Tus conversaciones, reservas, reseñas y clientes, en un solo lugar.</span>
        <span aria-hidden="true">
          Tus{" "}
          <span key={index} className="u-access-word text-white">
            {WORDS[index]}
          </span>
          ,<br />
          en un solo lugar.
        </span>
      </h2>
      <p className="m-0 max-w-[340px] text-[15px] leading-[1.5] text-[#8E8F96]">
        WhatsApp, agenda y reseñas trabajando juntos mientras atiendes tu negocio.
      </p>
    </>
  );
}

const noSubscribe = () => () => {};
function greetingNow(): string {
  const hour = new Date().getHours();
  return hour < 12 ? "Buenos días" : hour < 19 ? "Buenas tardes" : "Buenas noches";
}

/**
 * «Buenos días / Buenas tardes / Buenas noches» by the visitor's own clock. The server can't
 * know that clock, so it renders an empty line of the same height and the browser fills it in
 * (no hydration mismatch, no layout shift).
 */
export function TimeGreeting() {
  const greeting = useSyncExternalStore(noSubscribe, greetingNow, () => null);
  return <p className="m-0 min-h-[20px] text-[14px] leading-[20px] text-[#6E6E73]">{greeting ?? " "}</p>;
}
