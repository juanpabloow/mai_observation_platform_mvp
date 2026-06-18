"use client";

import { useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

/**
 * Client-only chart components for the workflow Analytics tab. Data is fetched
 * SERVER-side (the page runs the tenant-scoped repo queries) and passed in as
 * props — no query ever runs client-side. Recharts needs the DOM (Responsive
 * Container measures width), so these render after mount with a skeleton in the
 * meantime (also the loading state).
 *
 * THEMING: series colors are fixed mid-tones that read on BOTH light and dark
 * backgrounds (green/red/sky). Axis text, grid lines, and the tooltip surface use
 * the CL-4b CSS tokens, read live from the document so they flip with the theme
 * (and re-read on a prefers-color-scheme change). The tooltip uses var(--…)
 * directly (inline style resolves CSS vars).
 */

export interface ExecutionDayPoint {
  day: string;
  success: number;
  error: number;
  other: number;
}
export interface ConversationDayPoint {
  day: string;
  turns: number;
}

const SERIES = {
  success: "#22c55e", // green-500
  error: "#ef4444", // red-500
  other: "#a3a3a3", // neutral-400
  turns: "#0ea5e9", // sky-500
};

function useMounted(): boolean {
  const [m, setM] = useState(false);
  useEffect(() => setM(true), []);
  return m;
}

/** Read the CL-4b theme tokens live (concrete values, since Recharts sets SVG
 * attributes which don't resolve CSS var() — re-reads on theme change). */
function useChartTheme() {
  const [c, setC] = useState({ faint: "#8f8f8f", grid: "rgba(128,128,128,0.18)" });
  useEffect(() => {
    const read = () => {
      const s = getComputedStyle(document.documentElement);
      setC({
        faint: s.getPropertyValue("--faint").trim() || "#8f8f8f",
        grid: s.getPropertyValue("--line").trim() || "rgba(128,128,128,0.18)",
      });
    };
    read();
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", read);
    return () => mq.removeEventListener("change", read);
  }, []);
  return c;
}

function shortDay(day: string): string {
  return new Date(`${day}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function ChartSkeleton() {
  return <div className="h-72 w-full animate-pulse rounded-xl bg-subtle" />;
}

const tooltipStyle = {
  background: "var(--popover)",
  border: "1px solid var(--line)",
  borderRadius: 12,
  color: "var(--popover-foreground)",
  fontSize: 12,
  boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
} as const;

export function ExecutionsByStatusChart({ data }: { data: ExecutionDayPoint[] }) {
  const mounted = useMounted();
  const t = useChartTheme();
  if (!mounted) return <ChartSkeleton />;
  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={t.grid} vertical={false} />
          <XAxis
            dataKey="day"
            tickFormatter={shortDay}
            tick={{ fill: t.faint, fontSize: 11 }}
            stroke={t.grid}
            minTickGap={24}
            tickLine={false}
          />
          <YAxis
            allowDecimals={false}
            tick={{ fill: t.faint, fontSize: 11 }}
            stroke={t.grid}
            width={44}
            tickLine={false}
          />
          <Tooltip
            cursor={{ fill: t.grid }}
            contentStyle={tooltipStyle}
            labelStyle={{ color: "var(--faint)", marginBottom: 4 }}
            labelFormatter={(d) => new Date(`${d}T00:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
          />
          <Bar dataKey="success" stackId="s" fill={SERIES.success} name="Success" />
          <Bar dataKey="error" stackId="s" fill={SERIES.error} name="Error" />
          <Bar dataKey="other" stackId="s" fill={SERIES.other} name="Other" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function ConversationTurnsChart({ data }: { data: ConversationDayPoint[] }) {
  const mounted = useMounted();
  const t = useChartTheme();
  if (!mounted) return <ChartSkeleton />;
  return (
    <div className="h-60 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={t.grid} vertical={false} />
          <XAxis
            dataKey="day"
            tickFormatter={shortDay}
            tick={{ fill: t.faint, fontSize: 11 }}
            stroke={t.grid}
            minTickGap={24}
            tickLine={false}
          />
          <YAxis allowDecimals={false} tick={{ fill: t.faint, fontSize: 11 }} stroke={t.grid} width={44} tickLine={false} />
          <Tooltip
            cursor={{ fill: t.grid }}
            contentStyle={tooltipStyle}
            labelStyle={{ color: "var(--faint)", marginBottom: 4 }}
            labelFormatter={(d) => new Date(`${d}T00:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
          />
          <Bar dataKey="turns" fill={SERIES.turns} name="Turns" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
