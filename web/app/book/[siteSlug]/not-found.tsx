/** The ONE answer for every unavailable booking page (unknown slug, inactive site,
 * default client, scheduling disabled, kill switch) — identical, so nothing is learnt
 * from which one it was. Same v3 look as the booking page (`.pb3`). */
export default function BookingNotFound() {
  return (
    <main
      lang="es"
      className="pb3 -m-[var(--content-pad)] flex min-h-[calc(100%_+_var(--content-pad)_*_2)] flex-none flex-col items-start justify-center gap-2 px-6 py-16"
    >
      <div className="mx-auto flex w-full max-w-[560px] flex-col gap-2">
        <h1 className="m-0 font-pb-serif text-[32px] font-normal leading-[1.08]">Esta página de reservas no está disponible</h1>
        <p className="m-0 text-[15.5px] leading-[1.5] text-pb-muted">Revisa el enlace o comunícate directamente con el negocio.</p>
      </div>
    </main>
  );
}
