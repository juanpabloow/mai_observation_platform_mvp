"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { SESSION_CHANNEL } from "@/lib/accessCopy";
import { mapAuthErrorParam } from "@/lib/auth-errors";
import {
  listMySessionsAction,
  reauthWithPasswordAction,
  revokeOtherSessionsAction,
  revokeSessionAction,
  startGoogleReauthAction,
  type SessionView,
  type SessionsPayload,
} from "@/lib/sessionActions";
import { Button, INPUT } from "@/components/ui/controls";
import { GoogleMark } from "@/components/access/AccessShell";

/**
 * Seguridad → Sesiones (4g desktop / 4h phone). The list is the person's REAL sessions
 * (listMySessionsAction); browser and system only when the User-Agent says so, never a
 * location. Closing THIS session is plain sign-out. Closing another one — or all the others
 * — asks for a recent authentication the server checks, with a method the account has
 * (password, or Google; a Google-only account never sees a password field).
 */
type Target = { kind: "current" } | { kind: "one"; s: SessionView } | { kind: "others"; count: number };

function DeviceIcon({ kind }: { kind: SessionView["kind"] }) {
  return (
    <span aria-hidden className="flex size-9 flex-none items-center justify-center rounded-[10px] bg-chip text-xs text-foreground/80">
      {kind === "phone" ? "Móvil" : kind === "computer" ? "PC" : "?"}
    </span>
  );
}

export function SessionsPanel({ pending, reauthError }: { pending: string | null; reauthError: string | null }) {
  const [state, setState] = useState<"loading" | "error" | "ok">("loading");
  const [data, setData] = useState<SessionsPayload | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [step, setStep] = useState<"confirm" | "auth">("confirm");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"go" | "google" | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(reauthError ? mapAuthErrorParam(reauthError) : null);
  const lastFocus = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const consumedPending = useRef(false);

  const fetchSessions = useCallback(async () => {
    const r = await listMySessionsAction().catch(() => ({ ok: false as const, error: "" }));
    if (r.ok) {
      setData(r.data);
      setState("ok");
      return r.data;
    }
    setState("error");
    return null;
  }, []);
  const load = useCallback(() => {
    setState("loading");
    return fetchSessions();
  }, [fetchSessions]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- setState is async (post-fetch), not a sync cascade
    void fetchSessions().then((d) => {
      // Back from a Google confirmation: reopen what the person was doing (one click left).
      if (!d || !pending || consumedPending.current) return;
      consumedPending.current = true;
      window.history.replaceState(null, "", "/settings/security/sessions");
      if (pending === "others" && d.others.length) setTarget({ kind: "others", count: d.others.length });
      else {
        const s = d.others.find((o) => o.id === pending);
        if (s) setTarget({ kind: "one", s });
      }
    });
  }, [fetchSessions, pending]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(t);
  }, [toast]);

  function open(t: Target) {
    lastFocus.current = document.activeElement as HTMLElement | null;
    setTarget(t);
    setStep("confirm");
    setPassword("");
    setAuthError(null);
    setBusy(null);
  }
  function close() {
    setTarget(null);
    setBusy(null);
    const f = lastFocus.current;
    window.setTimeout(() => f?.focus?.(), 30);
  }

  // Focus the dialog's first useful control; Escape cancels.
  useEffect(() => {
    if (!target) return;
    const t = window.setTimeout(() => {
      const el = dialogRef.current?.querySelector<HTMLElement>(step === "auth" ? "input[type=password], [data-primary]" : "[data-safe]");
      el?.focus();
    }, 30);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) close();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, step]);

  async function closeCurrent() {
    setBusy("go");
    try {
      await authClient.signOut();
    } catch {
      // The redirect below still leaves; the data layer rejects a stale cookie anyway.
    }
    try {
      const ch = new BroadcastChannel(SESSION_CHANNEL);
      ch.postMessage({ type: "ended", reason: "signed-out" });
      ch.close();
    } catch {
      // no BroadcastChannel
    }
    window.location.replace("/login?reason=signed-out");
  }

  async function revoke(t: Target) {
    const r = t.kind === "others" ? await revokeOtherSessionsAction() : await revokeSessionAction(t.kind === "one" ? t.s.id : "");
    if (!r.ok && "needsReauth" in r) {
      setStep("auth");
      setBusy(null);
      return;
    }
    if (!r.ok) {
      setAuthError(r.error);
      setBusy(null);
      return;
    }
    setToast(t.kind === "others" ? "Cerraste las demás sesiones" : `Sesión cerrada en ${t.kind === "one" ? t.s.device : ""}`);
    close();
    await load();
  }

  async function onPrimary() {
    if (!target || busy) return;
    setAuthError(null);
    if (target.kind === "current") return closeCurrent();
    setBusy("go");
    try {
      if (step === "confirm") {
        if (data?.recentAuth) return await revoke(target);
        setStep("auth");
        setBusy(null);
        return;
      }
      // auth step
      if (data && !data.methods.password) return await onGoogle();
      const a = await reauthWithPasswordAction(password);
      if (!a.ok) {
        setAuthError(a.error);
        setBusy(null);
        return;
      }
      setPassword("");
      setData((d) => (d ? { ...d, recentAuth: true } : d));
      await revoke(target);
    } catch {
      setAuthError("No pudimos completar la acción. Inténtalo otra vez.");
      setBusy(null);
    }
  }

  async function onGoogle() {
    if (!target || target.kind === "current") return;
    setBusy("google");
    setAuthError(null);
    try {
      const start = await startGoogleReauthAction();
      if (!start.ok) {
        setAuthError(start.error);
        setBusy(null);
        return;
      }
      const intent = target.kind === "others" ? "others" : target.s.id;
      const r = await authClient.signIn.social({
        provider: "google",
        callbackURL: `/settings/security/sessions?pending=${encodeURIComponent(intent)}`,
        errorCallbackURL: "/settings/security/sessions",
        additionalData: { [start.stateKey]: start.nonce },
        loginHint: start.email,
      });
      if (r.error) {
        setAuthError("No pudimos abrir Google. Inténtalo otra vez.");
        setBusy(null);
      }
      // else: on the way to Google.
    } catch {
      setAuthError("No pudimos abrir Google. Inténtalo otra vez.");
      setBusy(null);
    }
  }

  const others = data?.others ?? [];
  const gOnly = Boolean(data && !data.methods.password && data.methods.google);
  const noMethod = Boolean(data && !data.methods.password && !data.methods.google);
  const title = !target
    ? ""
    : target.kind === "current"
      ? "¿Cerrar sesión en este equipo?"
      : step === "auth"
        ? "Confirma que eres tú"
        : target.kind === "others"
          ? target.count === 1
            ? "¿Cerrar 1 sesión?"
            : `¿Cerrar ${target.count} sesiones?`
          : "¿Cerrar esta sesión?";
  const body = !target
    ? ""
    : target.kind === "current"
      ? "Volverás a la pantalla de inicio. Tus otras sesiones siguen abiertas. No hace falta confirmar tu identidad."
      : target.kind === "others"
        ? "Se cerrarán todas tus sesiones excepto la de este equipo. Quien las use tendrá que volver a entrar."
        : `Se cerrará la sesión en ${target.s.device}. Quien la use tendrá que volver a entrar.`;
  const cta =
    busy === "go"
      ? "Cerrando…"
      : busy === "google"
        ? "Esperando a Google…"
        : target?.kind === "current"
          ? "Cerrar sesión"
          : step === "auth"
            ? gOnly
              ? "Confirmar con Google"
              : "Confirmar y cerrar"
            : target?.kind === "others"
              ? "Cerrar las demás"
              : "Cerrar sesión";

  return (
    <div className="flex flex-col gap-[22px]">
      {pageError ? (
        <p role="alert" className="rounded-sch-control bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
          {pageError}{" "}
          <button type="button" className="underline" onClick={() => setPageError(null)}>
            Entendido
          </button>
        </p>
      ) : null}

      <section aria-labelledby="ss-current" className="flex flex-col gap-2">
        <h2 id="ss-current" className="m-0 text-[13px] font-normal text-muted">
          Esta sesión
        </h2>
        <div className="flex flex-col gap-3 border-y border-line py-3 sm:min-h-[60px] sm:flex-row sm:items-center sm:gap-3.5 sm:py-2">
          <div className="flex min-w-0 flex-1 items-center gap-3.5">
            {data ? <DeviceIcon kind={data.current.kind} /> : <span className="size-9 rounded-[10px] bg-chip" aria-hidden />}
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-[15px] text-foreground">{data?.current.device ?? "Este navegador"}</span>
              <span className="text-[13px] text-muted sm:truncate">
                {data?.current.type ? `${data.current.type} · activa ahora` : "Activa ahora"}
              </span>
            </span>
            <span className="flex-none rounded-md bg-success/10 px-2 py-[3px] text-[13px] text-success">● Este equipo</span>
          </div>
          <Button onClick={() => open({ kind: "current" })} className="w-full sm:w-auto" size="sm">
            <span className="sm:hidden">Cerrar sesión en este equipo</span>
            <span className="hidden sm:inline">Cerrar esta sesión</span>
          </Button>
        </div>
        <p className="m-0 text-[13px] text-muted">Cerrar esta sesión no pide confirmar tu identidad. Cerrar otras sí.</p>
      </section>

      <section aria-labelledby="ss-others" className="flex flex-col gap-2">
        <div className="flex min-h-8 items-center justify-between gap-3">
          <h2 id="ss-others" className="m-0 text-[13px] font-normal text-muted">
            Otras sesiones{state === "ok" && others.length ? ` · ${others.length}` : ""}
          </h2>
          {state === "ok" && others.length > 1 ? (
            <span className="hidden sm:block">
              <Button size="sm" onClick={() => open({ kind: "others", count: others.length })} className="!text-danger">
                Cerrar las demás
              </Button>
            </span>
          ) : null}
        </div>

        {state === "loading" ? (
          <div aria-busy="true" aria-label="Cargando sesiones" className="flex flex-col">
            {[220, 180, 200].map((w, i) => (
              <div key={w} className={`flex h-[60px] items-center gap-3.5 border-t border-line ${i === 2 ? "border-b" : ""}`}>
                <span className="size-9 rounded-[10px] bg-chip motion-safe:animate-pulse" />
                <span className="h-3 rounded-md bg-chip motion-safe:animate-pulse" style={{ width: w }} />
              </div>
            ))}
          </div>
        ) : null}

        {state === "error" ? (
          <div role="alert" className="flex flex-col gap-3 border-y border-line py-4 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-[15px] text-foreground/80">No pudimos cargar las otras sesiones. Tu sesión actual no se ve afectada.</span>
            <Button size="sm" onClick={() => void load()}>
              Reintentar
            </Button>
          </div>
        ) : null}

        {state === "ok" && others.length === 0 ? (
          <p className="m-0 border-y border-line py-[18px] text-[15px] text-muted">No hay otras sesiones abiertas. Solo estás conectado en este equipo.</p>
        ) : null}

        {state === "ok" && others.length > 0 ? (
          <ul className="m-0 flex list-none flex-col border-b border-line p-0">
            {others.map((s) => (
              <li key={s.id} className="flex min-h-[60px] items-center gap-3.5 border-t border-line py-2.5 sm:py-1">
                <span className="hidden sm:flex">
                  <DeviceIcon kind={s.kind} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-base text-foreground sm:text-[15px]">{s.device}</span>
                  <span className="text-[13px] text-muted sm:truncate">
                    <span className="sm:hidden">{s.lastActive} · </span>
                    {s.type}
                  </span>
                </span>
                <span className="hidden w-[180px] text-sm text-foreground/80 md:inline">{s.lastActive}</span>
                <Button size="sm" onClick={() => open({ kind: "one", s })} aria-label={`Cerrar sesión en ${s.device}`}>
                  Cerrar
                </Button>
              </li>
            ))}
          </ul>
        ) : null}

        {state === "ok" && others.length > 1 ? (
          <span className="sm:hidden">
            <Button onClick={() => open({ kind: "others", count: others.length })} className="!text-danger" block>
              Cerrar las demás sesiones
            </Button>
          </span>
        ) : null}
      </section>

      {toast ? (
        <div role="status" className="fixed bottom-6 left-4 right-4 z-50 rounded-xl bg-[#1C1D20] px-4 py-3.5 text-[15px] text-[#ECECEE] shadow-lg sm:left-1/2 sm:right-auto sm:-translate-x-1/2 sm:whitespace-nowrap sm:rounded-[10px] sm:text-sm">
          ✓ {toast}
        </div>
      ) : null}

      {target ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 sm:items-center sm:p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !busy) close();
          }}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="ss-dialog-title"
            className="flex w-full flex-col gap-3.5 rounded-t-[20px] bg-popover px-5 pb-[calc(20px+env(safe-area-inset-bottom))] pt-3 text-popover-foreground shadow-[0_12px_40px_rgba(0,0,0,.18)] sm:max-w-[420px] sm:rounded-[14px] sm:p-6"
          >
            <span aria-hidden className="h-1 w-9 self-center rounded-sm bg-line-strong sm:hidden" />
            <h2 id="ss-dialog-title" className="m-0 text-xl font-semibold tracking-[-.01em]">
              {title}
            </h2>
            {step === "confirm" || target.kind === "current" ? (
              <p className="m-0 text-base leading-normal text-foreground/80 sm:text-[15px]">{body}</p>
            ) : (
              <form
                className="flex flex-col gap-3.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  void onPrimary();
                }}
              >
                <p className="m-0 text-base leading-normal text-foreground/80 sm:text-[15px]">
                  {noMethod
                    ? "Tu cuenta entra solo con Google, y Google no nos confirma inicios de sesión recientes, así que por ahora no podemos verificar tu identidad para cerrar otras sesiones. Puedes cerrar la sesión de este equipo cuando quieras."
                    : gOnly
                      ? "Es una acción de seguridad. Tu cuenta entra con Google: confírmalo en la ventana de Google. No te lo pediremos de nuevo durante unos minutos."
                      : data?.methods.google
                        ? "Es una acción de seguridad. Escribe tu contraseña o usa Google para continuar. No te lo pediremos de nuevo durante unos minutos."
                        : "Es una acción de seguridad. Escribe tu contraseña para continuar. No te lo pediremos de nuevo durante unos minutos."}
                </p>
                {data?.methods.password ? (
                  <label className="flex flex-col gap-1.5">
                    <span className="text-[13px] text-foreground/80">Contraseña de {data.email}</span>
                    {/* Username for password managers (they pair it with the field below). */}
                    <input type="email" name="username" autoComplete="username" value={data.email} readOnly hidden />
                    <input
                      type="password"
                      name="password"
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => {
                        setPassword(e.target.value);
                        setAuthError(null);
                      }}
                      aria-invalid={authError ? true : undefined}
                      aria-describedby={authError ? "ss-auth-error" : undefined}
                      className={`${INPUT} !text-base`}
                    />
                  </label>
                ) : null}
                {authError ? (
                  <span id="ss-auth-error" role="alert" className="text-[13px] text-danger">
                    {authError}
                  </span>
                ) : null}
                {data?.methods.password && data.methods.google ? (
                  <button
                    type="button"
                    onClick={() => void onGoogle()}
                    disabled={busy !== null}
                    className="u-focus flex h-12 items-center justify-center gap-2.5 rounded-xl border border-line-strong bg-surface text-base text-foreground hover:bg-subtle sm:h-10 sm:justify-start sm:self-start sm:border-0 sm:bg-transparent sm:px-0 sm:text-sm sm:text-accent sm:hover:bg-transparent"
                  >
                    <span className="sm:hidden">
                      <GoogleMark />
                    </span>
                    Confirmar con Google en su lugar
                  </button>
                ) : null}
                <button type="submit" hidden />
              </form>
            )}
            {authError && step === "confirm" ? (
              <span role="alert" className="text-[13px] text-danger">
                {authError}
              </span>
            ) : null}
            <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
              <Button data-safe onClick={close} disabled={busy !== null}>
                Cancelar
              </Button>
              {!(step === "auth" && noMethod) ? (
                <button
                  type="button"
                  data-primary
                  onClick={() => void onPrimary()}
                  aria-busy={busy !== null || undefined}
                  disabled={busy !== null}
                  className="u-focus inline-flex h-12 items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-sch-destructive px-[18px] text-base font-semibold text-white hover:bg-sch-destructive-hover disabled:opacity-60 sm:h-11 sm:rounded-[10px] sm:text-[15px]"
                >
                  {step === "auth" && gOnly && busy === null ? <GoogleMark /> : null}
                  {cta}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
