"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { TURNSTILE_ACTION } from "@/lib/turnstileVerify";

/**
 * Cloudflare Turnstile, rendered explicitly into an inline element — no popup, no new
 * tab, so it works inside Instagram's / WhatsApp's in-app browsers. The token it hands
 * back is only a CLAIM: the server verifies it with Cloudflare (lib/turnstileVerify.ts)
 * and never trusts this component's opinion. Renders nothing unless the page passed a
 * site key (i.e. PUBLIC_BOOKING_TURNSTILE_ENABLED with NEXT_PUBLIC_TURNSTILE_SITE_KEY).
 */

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileApi {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  reset: (id?: string) => void;
  remove: (id?: string) => void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<void> | null = null;
function loadScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.turnstile) return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = new Promise<void>((resolve, reject) => {
      const s = document.createElement("script");
      s.src = SCRIPT_SRC;
      s.async = true;
      s.defer = true;
      s.onload = () => resolve();
      s.onerror = () => {
        scriptPromise = null;
        reject(new Error("turnstile script failed"));
      };
      document.head.appendChild(s);
    });
  }
  return scriptPromise;
}

export interface TurnstileHandle {
  /** Discard the current token and ask Cloudflare for a fresh one (tokens are single-use). */
  reset: () => void;
}

export const TurnstileField = forwardRef<TurnstileHandle, { siteKey: string; onToken: (token: string | null) => void }>(
  function TurnstileField({ siteKey, onToken }, ref) {
    const host = useRef<HTMLDivElement>(null);
    const widgetId = useRef<string | null>(null);
    const [failed, setFailed] = useState(false);
    // Keep the latest callback without re-rendering the widget on every parent render.
    const tokenCb = useRef(onToken);
    tokenCb.current = onToken;

    useImperativeHandle(ref, () => ({
      reset: () => {
        tokenCb.current(null);
        if (widgetId.current && window.turnstile) window.turnstile.reset(widgetId.current);
      },
    }));

    useEffect(() => {
      let cancelled = false;
      loadScript()
        .then(() => {
          if (cancelled || !host.current || !window.turnstile) return;
          widgetId.current = window.turnstile.render(host.current, {
            sitekey: siteKey,
            action: TURNSTILE_ACTION,
            language: "es",
            size: "flexible",
            appearance: "always",
            callback: (token: string) => tokenCb.current(token),
            "expired-callback": () => tokenCb.current(null),
            "error-callback": () => {
              tokenCb.current(null);
              return true;
            },
          });
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
      return () => {
        cancelled = true;
        if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current);
        widgetId.current = null;
      };
    }, [siteKey]);

    return (
      <div className="flex flex-col gap-1.5">
        <div ref={host} className="min-h-[65px]" />
        {failed ? (
          <p role="alert" className="text-xs text-danger">
            No se pudo cargar la verificación de seguridad. Revisa tu conexión y recarga la página.
          </p>
        ) : null}
      </div>
    );
  },
);
