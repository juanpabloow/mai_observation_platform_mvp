import { PageShell } from "@/components/ui/PageShell";
import { StaffHeaderCard, type StaffHeaderSlots } from "./StaffHeaderCard";
import { StaffTab, type StaffTabProps } from "./StaffTab";

/**
 * STAFF — the operational roster, under SCHEDULING.
 *
 * It briefly lived inside Team, which was the wrong home: Team answers "who can log into
 * the platform and with what role", and a barber is not a user — they are a bookable
 * resource with hours, services and a performance record. Everything that hangs off this
 * screen (the agenda lane, working_hours, staff_services, schedule_exceptions) is
 * scheduling data, so the screen belongs beside the agenda.
 *
 * NO TAB STRIP. It carried three tabs — Equipo / Turnos / Ausencias — of which two were
 * STUBS that rendered "Coming soon": Turnos needs a published-rota model (a barber has
 * weekly `working_hours` today, not shifts) and Ausencias needs a request-and-approval
 * flow on top of `schedule_exceptions`, which stores blocked time with no requester, state
 * or decision. They are gone rather than kept as placeholders, because a tab that opens an
 * empty panel spends a click to tell you the feature does not exist — the absence says it
 * better. When either model lands, the strip comes back with something behind it.
 *
 * Dropping the strip also made this a SERVER component: the only state it held was which
 * tab was open.
 */
export function StaffWorkspace({
  clientId,
  staff,
}: {
  clientId: string;
  /** null when the client has no site — a barber belongs to one. */
  staff: StaffTabProps | null;
}) {
  // The screen's name, drawn inside StaffHeaderCard so the card is one box. The roster
  // fills in the controls (search + the primary action), which are the part only it knows.
  //
  // NO COUNT, NO SCOPE LINE. The roster's number is the "Todos N" facet pill in the list
  // card, one row down and clickable; the client is named by the breadcrumb, which is the
  // app's answer to "whose data am I looking at" on every screen.
  const slots: StaffHeaderSlots = { title: "Equipo" };

  return (
    <main className="flex min-h-0 w-full flex-1 flex-col">
      {/* `surface="canvas"`: this screen is NOT one card. PageShell contributes the region
          (flex, min-h-0, flex-1) and lets the layout's canvas show through; the cards below
          are the page's own, so there is no card inside a card and no doubled border.
          `relative` makes this the drawer's positioning context, which is what lets the
          drawer run the FULL height of the region. */}
      <PageShell surface="canvas" className="relative">
        {staff ? (
          <StaffTab clientId={clientId} header={slots} {...staff} />
        ) : (
          // The one real empty state: no site, so there is nowhere for a member to belong.
          // It keeps the header card so the screen does not lose its title and its
          // silhouette while it has nothing to list.
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            <StaffHeaderCard slots={slots} />
            <PageShell>
              <div className="flex min-h-0 flex-1 items-center justify-center p-10">
                <div className="flex max-w-sm flex-col items-center gap-1 text-center">
                  <p className="text-sm font-medium text-muted">Todavía no hay equipo</p>
                  <p className="text-sm text-faint">
                    Este cliente no tiene sede, y un miembro del equipo pertenece a una.
                    Crea una sede en Configuración de agenda primero.
                  </p>
                </div>
              </div>
            </PageShell>
          </div>
        )}
      </PageShell>
    </main>
  );
}
