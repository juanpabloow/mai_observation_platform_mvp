import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * COSTOS DE IA — a business's color in charts, chosen by the agency in «Clientes y workflows».
 *
 * `clients.chart_color` holds a SLOT of the validated palette ('s1'…'s8', see
 * src/analytics/chartColors.ts), never a raw hex: each slot has a light and a dark variant that
 * passed the palette checks, so no business can end up unreadable or indistinguishable.
 * NULL = automatic (the first free slot, by business name).
 *
 * Additive and nullable: code that does not know the column keeps working. Reversible.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE clients
      ADD COLUMN chart_color text
        CONSTRAINT clients_chart_color_check CHECK (chart_color IS NULL OR chart_color ~ '^s[1-8]$');
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`ALTER TABLE clients DROP COLUMN chart_color;`);
}
