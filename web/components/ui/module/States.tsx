import type { ReactNode } from "react";

/**
 * The STATES every module screen can be in, drawn the same way everywhere:
 *
 *   SkeletonRows      loading (route loading.tsx and in-place refreshes)
 *   LoadError         the data could not be read — with a working «Reintentar»
 *   EmptyState        the business has nothing here yet — with the first action
 *   NoResults         filters / search hide everything — with a way back
 *   ReadOnlyBanner    you may look but not change (a real role rule, never a guess)
 *   NoAccess          you cannot open this screen at all (rendered by not-found.tsx, so
 *                     the response stays a 404 and reveals nothing about the client)
 *
 * Read-only and no-access are deliberately different objects: one is a page with a
 * notice, the other is not a page.
 */

export function SkeletonRows({ rows = 6, label = "Cargando…" }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-0 px-4 py-4 sm:px-6">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} aria-hidden className="flex h-[48px] items-center gap-4 border-b border-line-soft">
          <span className="h-3 w-[34%] rounded bg-chip motion-safe:animate-pulse" />
          <span className="h-3 w-[18%] rounded bg-chip motion-safe:animate-pulse" />
          <span className="ml-auto h-3 w-[10%] rounded bg-chip motion-safe:animate-pulse" />
        </div>
      ))}
    </div>
  );
}

function Block({ icon, title, body, children, tone = "neutral" }: { icon: ReactNode; title: string; body?: ReactNode; children?: ReactNode; tone?: "neutral" | "danger" }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
      <span aria-hidden className={`mb-1 inline-flex size-10 items-center justify-center rounded-full ${tone === "danger" ? "bg-danger/10 text-danger" : "bg-chip text-muted"}`}>
        {icon}
      </span>
      <p className="text-[0.9375rem] font-semibold text-foreground">{title}</p>
      {body ? <div className="max-w-md text-[0.8438rem] leading-relaxed text-muted">{body}</div> : null}
      {children ? <div className="mt-2 flex flex-wrap items-center justify-center gap-2">{children}</div> : null}
    </div>
  );
}

const ico = { viewBox: "0 0 16 16", className: "size-[1.125rem]", fill: "none", stroke: "currentColor", strokeWidth: 1.5 } as const;

export function LoadError({ body, children }: { body?: ReactNode; children?: ReactNode }) {
  return (
    <div role="alert">
      <Block
        tone="danger"
        icon={
          <svg {...ico}>
            <path d="M8 2.2 14.3 13H1.7z" strokeLinejoin="round" />
            <path d="M8 6.4v3" strokeLinecap="round" />
            <circle cx="8" cy="11.2" r=".5" fill="currentColor" />
          </svg>
        }
        title="No se pudo cargar"
        body={body ?? "No pudimos leer los datos. Comprueba la conexión y vuelve a intentarlo; no se ha perdido nada."}
      >
        {children}
      </Block>
    </div>
  );
}

export function EmptyState({ title, body, children }: { title: string; body?: ReactNode; children?: ReactNode }) {
  return (
    <Block
      icon={
        <svg {...ico}>
          <rect x="2.5" y="3" width="11" height="10" rx="2" />
          <path d="M5 6.5h6M5 9.5h3.5" />
        </svg>
      }
      title={title}
      body={body}
    >
      {children}
    </Block>
  );
}

export function NoResults({ body, children }: { body?: ReactNode; children?: ReactNode }) {
  return (
    <div role="status">
      <Block
        icon={
          <svg {...ico}>
            <circle cx="7" cy="7" r="4.4" />
            <path d="M10.4 10.4 13.6 13.6" />
          </svg>
        }
        title="Sin resultados"
        body={body ?? "Nada coincide con la búsqueda o el filtro."}
      >
        {children}
      </Block>
    </div>
  );
}

export function ReadOnlyBanner({ children }: { children: ReactNode }) {
  return (
    <div role="note" className="mx-4 mt-3 flex items-start gap-2.5 rounded-sch-control border border-line bg-subtle px-3.5 py-2.5 text-[0.8125rem] text-muted sm:mx-6">
      <svg aria-hidden viewBox="0 0 16 16" className="mt-0.5 size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="7" width="10" height="7" rx="1.6" />
        <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
      </svg>
      <span>
        <strong className="font-semibold text-foreground">Solo lectura.</strong> {children}
      </span>
    </div>
  );
}

export function NoAccess({ children }: { children?: ReactNode }) {
  return (
    <Block
      icon={
        <svg {...ico}>
          <circle cx="8" cy="8" r="5.6" />
          <path d="M4.1 11.9 11.9 4.1" />
        </svg>
      }
      title="No puedes abrir esta sección"
      body="No existe o tu acceso no la incluye. Si crees que deberías verla, pide a la persona responsable del negocio que revise tu rol."
    >
      {children}
    </Block>
  );
}
