"use client";

import Link from "next/link";
import h from "./agencyHome.module.css";
import type { AgencyHome, HomeBusiness, HomeReview } from "@/lib/agencyHome";
import { ClientsWorkflowsView } from "@/components/ClientsWorkflowsView";

/**
 * The agency's home: greeting, «Para revisar» (only when something is pending), every business
 * with its doors AND its management (the former «Clientes y workflows»: create, rename, color,
 * logo, modules, members, delete, move workflows), and the agency tools with one status line.
 */

const nf = new Intl.NumberFormat("es-CO");
const usd = (v: number) => `US$ ${v.toLocaleString("es-CO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dateFmt = new Intl.DateTimeFormat("es-CO", { weekday: "long", day: "numeric", month: "long", timeZone: "America/Bogota" });

function Svg({ children }: { children: React.ReactNode }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}
const I = {
  inbox: <Svg><path d="M2.5 9.5h3l1 1.5h3l1-1.5h3M3.5 3.5h9l1 6v3h-11v-3z" /></Svg>,
  chart: <Svg><path d="M3 13.5h10M4.5 11V8M8 11V4.5M11.5 11V6.5" /></Svg>,
  agenda: <Svg><rect x="2.5" y="3.5" width="11" height="10" rx="2" /><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" /></Svg>,
  clients: <Svg><circle cx="6" cy="5.5" r="2.2" /><path d="M2.5 13c.4-2.2 1.8-3.5 3.5-3.5s3.1 1.3 3.5 3.5M10.5 4a2 2 0 0 1 0 4M11.5 9.6c1.1.4 1.8 1.6 2 3.4" /></Svg>,
  money: <Svg><circle cx="8" cy="8" r="5.5" /><path d="M9.8 6.2c-.3-.6-1-1-1.8-1-1 0-1.8.6-1.8 1.4 0 1.9 3.6 1 3.6 2.9 0 .8-.8 1.4-1.8 1.4-.8 0-1.5-.4-1.8-1M8 4v8" /></Svg>,
  bolt: <Svg><path d="M8.8 2 3.5 9h4l-.8 5 5.3-7h-4z" /></Svg>,
  arrow: <Svg><path d="M3.5 8h9M9 4.5 12.5 8 9 11.5" /></Svg>,
  warn: <Svg><path d="M8 2.2 14.2 13H1.8z" /><path d="M8 6.5v3M8 11.2v.1" /></Svg>,
  chat: <Svg><path d="M3 3.5h10v7H7l-3 2.5v-2.5H3z" /></Svg>,
  plug: <Svg><path d="M6 2.5v3M10 2.5v3M4.5 5.5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11.5v2" /></Svg>,
};
const REVIEW_ICON: Record<HomeReview["kind"], React.ReactNode> = { inbox: I.chat, plan: I.warn, openai: I.warn };

export function AgencyHomeView({ home, firstName, today }: { home: AgencyHome; firstName: string | null; today: string }) {
  const date = dateFmt.format(new Date(today));
  const { plan } = home.agency;
  const byId = new Map<string, HomeBusiness>(home.businesses.map((b) => [b.id, b]));

  const planLine =
    plan === null
      ? "Sin conexión de n8n activa"
      : plan.limit === null
        ? `${nf.format(plan.used)} en el ciclo · plan sin configurar`
        : `${Math.round(plan.usedPct ?? 0)} % del plan${plan.projectedPct !== null ? ` · cierre ~${Math.round(plan.projectedPct)} %` : ""}`;

  return (
    <main className={h.page}>
      <header className={h.head}>
        <div>
          <p className={h.date}>{date.charAt(0).toUpperCase() + date.slice(1)}</p>
          <h1 className={h.title}>{firstName ? `Hola, ${firstName}` : "Hola"}</h1>
        </div>
      </header>

      {home.review.length > 0 ? (
        <section aria-labelledby="home-review" className={`${h.card} ${h.review}`}>
          <h2 id="home-review" className={h.label}>
            Para revisar
          </h2>
          <ul>
            {home.review.map((r) => (
              <li key={`${r.kind}-${r.href}-${r.text}`}>
                <span className={r.kind === "inbox" ? h.iconInfo : h.iconWarn}>{REVIEW_ICON[r.kind]}</span>
                <span className={h.reviewText}>{r.text}</span>
                <Link href={r.href} className={`${h.reviewLink} u-focus`}>
                  {r.action} {I.arrow}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <ClientsWorkflowsView
        folders={home.manage.folders}
        looseWorkflows={home.manage.looseWorkflows}
        clientOptions={home.manage.clientOptions}
        enabledModules={home.manage.enabledModules}
        r2Enabled={home.manage.r2Enabled}
        colorOf={(id) => byId.get(id)?.color ?? null}
        renderMeta={(f) => {
          const b = byId.get(f.id);
          if (!b || b.workflows === 0) return "Sin flujos asignados";
          return `${nf.format(b.executions30d)} ejecuciones en 30 días · ${b.workflows} flujo${b.workflows === 1 ? "" : "s"}`;
        }}
        renderDoors={(f) => {
          const b = byId.get(f.id);
          return (
            <nav aria-label={`Accesos de ${f.name}`} className={h.doors}>
              {b?.hasInbox ? (
                <Link href={`/clients/${f.id}/inbox`} className={`${h.door} u-focus`}>
                  {I.inbox} Inbox
                  {b.pending > 0 ? (
                    <span className={h.count} aria-label={`${b.pending} pendientes`}>
                      {b.pending}
                    </span>
                  ) : null}
                </Link>
              ) : null}
              <Link href={`/clients/${f.id}/analytics`} className={`${h.door} u-focus`}>
                {I.chart} Dashboard
              </Link>
              {b?.hasAgenda ? (
                <Link href={`/clients/${f.id}/scheduling/agenda`} className={`${h.door} u-focus`}>
                  {I.agenda} Agenda
                </Link>
              ) : null}
            </nav>
          );
        }}
      />

      <section aria-labelledby="home-agency">
        <h2 id="home-agency" className={h.label}>
          Agencia
        </h2>
        <div className={`${h.card} ${h.tools}`}>
          <Link href="/costos-ia" className={`${h.tool} u-focus`}>
            <span className={h.toolIcon}>{I.money}</span>
            <span>
              <span className={h.toolName}>Costos de IA</span>
              <span className={h.toolLine}>
                {home.agency.billedMonthUsd === null ? "Tokens y dinero de los bots" : `${usd(home.agency.billedMonthUsd)} facturado este mes`}
              </span>
            </span>
          </Link>
          <Link href="/costos-ia?vista=ejecuciones" className={`${h.tool} u-focus`}>
            <span className={h.toolIcon}>{I.bolt}</span>
            <span>
              <span className={h.toolName}>Ejecuciones</span>
              <span className={`${h.toolLine} ${plan?.projectedPct != null && plan.projectedPct > 100 ? h.bad : ""}`}>{planLine}</span>
            </span>
          </Link>
          <Link href="/settings/connections" className={`${h.tool} u-focus`}>
            <span className={h.toolIcon}>{I.plug}</span>
            <span>
              <span className={h.toolName}>Conexiones de n8n</span>
              <span className={h.toolLine}>
                {nf.format(home.agency.workflows)} {home.agency.workflows === 1 ? "flujo sincronizado" : "flujos sincronizados"}
              </span>
            </span>
          </Link>
          <Link href="/settings/team" className={`${h.tool} u-focus`}>
            <span className={h.toolIcon}>{I.clients}</span>
            <span>
              <span className={h.toolName}>Equipo</span>
              <span className={h.toolLine}>Miembros y permisos</span>
            </span>
          </Link>
        </div>
      </section>
    </main>
  );
}
