import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * Better Auth core tables (user / session / account / verification).
 *
 * The SQL below is the EXACT output of `npx @better-auth/cli generate` for our
 * auth config (email+password and the optional Google provider both use this
 * same schema). We keep it inside OUR migration system — rather than running
 * Better Auth's own `migrate` — so every schema change is tracked, reversible,
 * and applied via `npm run migrate`, consistent with the rest of the DB.
 *
 * Identifiers are intentionally quoted camelCase ("emailVerified", "userId",
 * ...) because that is exactly what Better Auth queries at runtime — do not
 * change the casing. These tables are independent of the app tables (tenants,
 * executions, conversation_turns, …) and touch none of them.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    create table "user" (
      "id" text not null primary key,
      "name" text not null,
      "email" text not null unique,
      "emailVerified" boolean not null,
      "image" text,
      "createdAt" timestamptz default CURRENT_TIMESTAMP not null,
      "updatedAt" timestamptz default CURRENT_TIMESTAMP not null
    );

    create table "session" (
      "id" text not null primary key,
      "expiresAt" timestamptz not null,
      "token" text not null unique,
      "createdAt" timestamptz default CURRENT_TIMESTAMP not null,
      "updatedAt" timestamptz not null,
      "ipAddress" text,
      "userAgent" text,
      "userId" text not null references "user" ("id") on delete cascade
    );

    create table "account" (
      "id" text not null primary key,
      "accountId" text not null,
      "providerId" text not null,
      "userId" text not null references "user" ("id") on delete cascade,
      "accessToken" text,
      "refreshToken" text,
      "idToken" text,
      "accessTokenExpiresAt" timestamptz,
      "refreshTokenExpiresAt" timestamptz,
      "scope" text,
      "password" text,
      "createdAt" timestamptz default CURRENT_TIMESTAMP not null,
      "updatedAt" timestamptz not null
    );

    create table "verification" (
      "id" text not null primary key,
      "identifier" text not null,
      "value" text not null,
      "expiresAt" timestamptz not null,
      "createdAt" timestamptz default CURRENT_TIMESTAMP not null,
      "updatedAt" timestamptz default CURRENT_TIMESTAMP not null
    );

    create index "session_userId_idx" on "session" ("userId");
    create index "account_userId_idx" on "account" ("userId");
    create index "verification_identifier_idx" on "verification" ("identifier");
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Drop in FK-safe order (account + session reference user). Indexes drop with
  // their tables.
  pgm.sql(`
    drop table if exists "account";
    drop table if exists "session";
    drop table if exists "verification";
    drop table if exists "user";
  `);
}
