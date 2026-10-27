"use client";

import { useMemo, useState } from "react";
import { initialsOf } from "@/lib/personName";
import { LAST_BUSINESS_COOKIE } from "@/lib/accessCopy";

function rememberBusiness(id: string) {
  document.cookie = `${LAST_BUSINESS_COOKIE}=${encodeURIComponent(id)}; Path=/; Max-Age=${60 * 60 * 24 * 180}; SameSite=Lax`;
}

const TINTS = ["#DCE7F7", "#E3F0E4", "#EFE3F3", "#F5EAD9", "#E5EEF0", "#F3E3E3"];

export function BusinessPicker({
  items,
}: {
  items: { id: string; name: string; logoUrl: string | null; href: string; last: boolean }[];
}) {
  const [q, setQ] = useState("");
  const sorted = useMemo(() => [...items].sort((a, b) => Number(b.last) - Number(a.last)), [items]);
  const shown = useMemo(() => {
    const needle = q.trim().toLocaleLowerCase("es");
    return needle ? sorted.filter((i) => i.name.toLocaleLowerCase("es").includes(needle)) : sorted;
  }, [q, sorted]);

  return (
    <div className="flex flex-col gap-[18px]">
      {items.length > 5 ? (
        <label className="flex flex-col gap-1.5">
          <span className="sr-only">Buscar negocio</span>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar negocio"
            className="u-focus h-12 rounded-xl border-0 bg-[#F2F2F4] px-3.5 text-base text-[#111] outline-none placeholder:text-[#8E8E93] lg:h-11 lg:rounded-[10px] lg:text-[15px]"
          />
        </label>
      ) : null}
      <ul className="m-0 flex list-none flex-col p-0">
        {shown.map((i, idx) => (
          <li key={i.id}>
            <a
              href={i.href}
              onClick={() => rememberBusiness(i.id)}
              className={`u-focus flex h-[60px] items-center gap-3.5 rounded-[10px] px-3 transition-colors hover:bg-[#F6F6F7] ${i.last ? "bg-[#F6F6F7]" : ""}`}
            >
              <span
                aria-hidden
                className="flex size-9 flex-none items-center justify-center overflow-hidden rounded-[10px] text-[13px] font-semibold text-[#111]"
                style={{ background: TINTS[idx % TINTS.length] }}
              >
                {i.logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- the client's own uploaded logo
                  <img src={i.logoUrl} alt="" className="size-full object-cover" />
                ) : (
                  initialsOf(i.name)
                )}
              </span>
              <span className="min-w-0 flex-1 truncate text-[15px] text-[#111]">{i.name}</span>
              {i.last ? <span className="text-[13px] text-[#6E6E73]">Último acceso</span> : null}
              <span aria-hidden className="text-lg text-[#8E8E93]">
                ›
              </span>
            </a>
          </li>
        ))}
        {shown.length === 0 ? <li className="px-3 py-4 text-[15px] text-[#5E636B]">Ningún negocio coincide con «{q}».</li> : null}
      </ul>
    </div>
  );
}
