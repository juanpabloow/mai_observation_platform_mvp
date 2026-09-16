"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { SEARCH_SHELL_CLS } from "@/components/ui/primitives";

/**
 * The Reuniones search field.
 *
 * Deliberately the SAME object as `ContactsSearch`: the shared `SEARCH_SHELL_CLS`
 * shell, a real `<form>` so Enter submits and it works before hydration, and a
 * pure URL-param writer so the server page stays the single source of truth.
 *
 * Typing is local; a navigation that CHANGES `q` (Back/Forward, a cleared
 * search, a deep link) re-seeds the box. The state is adjusted DURING render
 * against the tracked previous value — React's documented alternative to a
 * setState-in-effect.
 */
export function MeetingsSearch() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const q = searchParams.get("q") ?? "";

  const [draft, setDraft] = useState(q);
  const [lastQ, setLastQ] = useState(q);
  if (lastQ !== q) {
    setLastQ(q);
    if (draft !== q) setDraft(q);
  }

  const apply = (value: string) => {
    const p = new URLSearchParams(searchParams.toString());
    if (value) p.set("q", value);
    else p.delete("q");
    const qs = p.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        apply(draft.trim());
      }}
      className={`${SEARCH_SHELL_CLS} min-w-[15rem] max-w-[420px] flex-1`}
    >
      <svg viewBox="0 0 16 16" className="size-3.5 shrink-0 text-faint" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
        <circle cx="7" cy="7" r="4.4" />
        <path d="M10.4 10.4 14 14" strokeLinecap="round" />
      </svg>
      <input
        name="q"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Buscar por nombre, participante o contenido…"
        aria-label="Buscar reuniones"
        className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-faint"
      />
      {q ? (
        <button
          type="button"
          onClick={() => {
            setDraft("");
            apply("");
          }}
          aria-label="Limpiar búsqueda"
          className="u-tap shrink-0 rounded text-faint transition-colors hover:text-foreground"
        >
          ✕
        </button>
      ) : (
        <span
          aria-hidden
          className="u-mono hidden shrink-0 rounded-sm border border-line-strong bg-surface px-1.5 text-[0.625rem] leading-4 text-faint sm:inline"
        >
          ↵
        </span>
      )}
    </form>
  );
}
