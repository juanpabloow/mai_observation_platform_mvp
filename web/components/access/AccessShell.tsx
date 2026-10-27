import type { ReactNode } from "react";

/**
 * THE frame of every access screen (login 4a/4b, crear perfil 5a/5b, invitation states 2c/2g,
 * session closed 4e/4f/4i, sin acceso 4j). Approved look: a graphite ground with the brand
 * and a short line on the left, the form on a white card on the right; on a phone the
 * graphite becomes a top band and the card a sheet rising from the bottom.
 *
 * The access screens are deliberately theme-independent (always this light card on the
 * graphite ground, as approved) — they are outside the app and its light/dark preference.
 * It covers the root layout's content gutter (fixed, own scroll) so the frame reaches the
 * viewport edges on every screen size.
 */
export function Brand({ small = false }: { small?: boolean }) {
  return (
    <span className={`${small ? "text-[14px]" : "text-[15px]"} font-semibold tracking-[.02em] text-[#ECECEE]`}>
      MONTSERRAT<span className="text-[#E5484D]">_</span>AI
    </span>
  );
}

export function AccessShell({
  aside,
  mobileTop,
  children,
  width = 380,
}: {
  /** Left panel middle (desktop). Defaults to the platform line. */
  aside?: ReactNode;
  /** Extra lines under the brand on a phone (business · role, step bar). */
  mobileTop?: ReactNode;
  children: ReactNode;
  /** Content column width on desktop. */
  width?: 360 | 380 | 420;
}) {
  return (
    <div className="u-access fixed inset-0 z-0 flex flex-col overflow-y-auto bg-[#1C1D20] text-[#111] lg:flex-row lg:gap-3 lg:overflow-hidden lg:p-3">
      <aside className="hidden w-[460px] flex-none flex-col justify-between px-6 py-7 lg:flex">
        <Brand />
        <div className="flex flex-col gap-[22px]">
          {aside ?? (
            <h2 className="m-0 text-[34px] font-semibold leading-[1.15] tracking-[-.02em] text-[#ECECEE] [text-wrap:pretty]">
              Conversaciones, clientes y agenda en un solo lugar.
            </h2>
          )}
        </div>
        <span className="text-xs text-[#80808A]">© 2026 Montserrat AI</span>
      </aside>
      <div className="flex flex-col gap-2.5 px-5 pb-[18px] pt-6 lg:hidden">
        <Brand small />
        {mobileTop}
      </div>
      <main className="flex flex-1 justify-center rounded-t-[20px] bg-white px-5 pb-[calc(24px+env(safe-area-inset-bottom))] pt-7 lg:items-center lg:overflow-y-auto lg:rounded-xl lg:px-10 lg:py-10">
        <div className="flex w-full flex-col gap-4" style={{ maxWidth: width }}>
          {children}
        </div>
      </main>
    </div>
  );
}

/** Heading + optional lead, sized like the approved screens. */
export function AccessHeading({ title, lead, eyebrow }: { title: string; lead?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 lg:gap-1.5">
      {eyebrow}
      <h1 tabIndex={-1} className="m-0 text-[26px] font-semibold tracking-[-.02em] outline-none lg:text-[28px]">{title}</h1>
      {lead ? <p className="m-0 text-[15px] leading-[1.45] text-[#5E636B]">{lead}</p> : null}
    </div>
  );
}

/** Shared class strings — one place for the approved control sizes (44 px desktop, 48 px phone). */
export const ACC = {
  label: "text-[13px] text-[#3A3A3C]",
  input:
    "u-focus h-12 w-full min-w-0 rounded-xl border border-[#D6D7DA] bg-white px-3.5 text-base text-[#111] outline-none placeholder:text-[#8E8E93] aria-[invalid=true]:border-[#C62828] lg:h-11 lg:rounded-[10px]",
  fixed:
    "flex h-12 items-center justify-between gap-3 rounded-xl border border-[#E6E6E8] bg-[#F5F5F7] px-3.5 text-base text-[#3A3A3C] lg:h-11 lg:rounded-[10px]",
  primary:
    "u-focus inline-flex h-12 w-full items-center justify-center gap-2 whitespace-nowrap rounded-xl border-0 bg-[#111] px-4 text-base font-[590] text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-60 aria-busy:opacity-60 lg:h-11 lg:rounded-[10px] lg:text-[15px]",
  secondary:
    "u-focus inline-flex h-12 w-full items-center justify-center gap-2.5 whitespace-nowrap rounded-xl border border-[#D6D7DA] bg-white px-4 text-base text-[#111] transition-colors hover:bg-[#F5F5F7] disabled:cursor-not-allowed disabled:opacity-60 lg:h-11 lg:rounded-[10px] lg:text-[15px]",
  link: "u-focus rounded text-[#2F6BE4] hover:text-[#1F4FB0]",
  hint: "text-[13px] leading-[1.45] text-[#6E6E73]",
  error: "text-[13px] text-[#C62828]",
  divider: "flex items-center gap-3 text-xs text-[#8E8E93]",
  status: "flex flex-col gap-1 rounded-[10px] bg-[#F4F4F5] px-3.5 py-3 lg:rounded-[10px]",
} as const;

export function Divider({ children }: { children: ReactNode }) {
  return (
    <div className={ACC.divider}>
      <span className="h-px flex-1 bg-[#E6E6E8]" />
      {children}
      <span className="h-px flex-1 bg-[#E6E6E8]" />
    </div>
  );
}

/** A banner for a notice that arrived with the page (role=status) or an error (role=alert). */
export function Notice({ tone, title, children }: { tone: "info" | "success" | "warn" | "error"; title?: string; children: ReactNode }) {
  const tones = {
    info: "bg-[#F4F4F5] text-[#3A3D42]",
    success: "bg-[#E7F5EC] text-[#1E5C36]",
    warn: "bg-[#FFF4E0] text-[#7A4A00]",
    error: "bg-[#FDECEC] text-[#8E1F1F]",
  } as const;
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`flex flex-col gap-1 rounded-[10px] px-3.5 py-3 text-sm leading-[1.45] ${tones[tone]}`}>
      {title ? <span className="text-[14px] font-[590] text-[#111]">{title}</span> : null}
      <span>{children}</span>
    </div>
  );
}

export function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.6 13.3l7.9 6.1C12.4 13.7 17.7 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.7 6c4.5-4.2 6.9-10.3 6.9-17.7z" />
      <path fill="#FBBC05" d="M10.5 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.6 10.7l7.9-6.1z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.7-6c-2.1 1.4-4.9 2.3-8.2 2.3-6.3 0-11.6-4.2-13.5-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z" />
    </svg>
  );
}
