/**
 * In-process Postgres for testing the Supabase migrations.
 *
 * Boots PGlite (Postgres compiled to WASM), installs a minimal Supabase
 * environment (roles, default privileges, auth schema — see supabase-shim.sql),
 * then applies every file in supabase/migrations in order, exactly as
 * `supabase db push` would. Queries can then be executed as `anon`, an
 * `authenticated` user (with a chosen MFA level) or `service_role`, so RLS,
 * grants and SECURITY DEFINER boundaries are exercised for real.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';

const here = path.dirname(fileURLToPath(import.meta.url));

export const MIGRATIONS_DIR = path.resolve(here, '../../../../supabase/migrations');
export const SEED_PATH = path.resolve(here, '../../../../supabase/seed.sql');
const SHIM_PATH = path.join(here, 'supabase-shim.sql');

export type Actor =
  | { readonly kind: 'anon' }
  | { readonly kind: 'user'; readonly id: string; readonly aal?: 'aal1' | 'aal2' }
  | { readonly kind: 'service' };

export const anon: Actor = { kind: 'anon' };
export const service: Actor = { kind: 'service' };
export const user = (id: string, aal: 'aal1' | 'aal2' = 'aal1'): Actor => ({ kind: 'user', id, aal });

export interface PgError {
  readonly code: string;
  readonly message: string;
  readonly detail: string | undefined;
}

export interface CreateUserOptions {
  readonly username?: string;
  readonly email?: string;
  readonly emailConfirmed?: boolean;
  /** Backdates the account (auth.users.created_at) by this many days. */
  readonly ageDays?: number;
  /** Grants this much karma through the ledger (so tiers update). */
  readonly karma?: number;
  readonly locale?: 'en' | 'fr';
  readonly homeZone?: string;
}

let userCounter = 0;

export class TestDb {
  private readonly pg: PGlite;

  private constructor(pg: PGlite) {
    this.pg = pg;
  }

  /** Fresh database with the shim and all migrations applied. */
  static async create(): Promise<TestDb> {
    const pg = await PGlite.create();
    await pg.exec(await readFile(SHIM_PATH, 'utf8'));
    for (const file of await listMigrations()) {
      try {
        await pg.exec(await readFile(path.join(MIGRATIONS_DIR, file), 'utf8'));
      } catch (error) {
        throw new Error(`Migration ${file} failed: ${(error as Error).message}`, { cause: error });
      }
    }
    return new TestDb(pg);
  }

  /** Applies supabase/seed.sql (the local-development demo data). */
  async applySeed(): Promise<void> {
    await this.pg.exec(await readFile(SEED_PATH, 'utf8'));
  }

  async close(): Promise<void> {
    await this.pg.close();
  }

  /** Runs SQL as the database owner (bypasses RLS — use for setup only). */
  async sql<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.pg.query<T>(sql, params);
    return result.rows;
  }

  async sqlOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
    const rows = await this.sql<T>(sql, params);
    if (rows.length !== 1) throw new Error(`Expected one row, got ${rows.length}: ${sql}`);
    return rows[0] as T;
  }

  /**
   * Runs SQL as an API role, the way PostgREST would: `SET ROLE` plus the
   * request JWT claims that auth.uid()/auth.jwt() read.
   */
  async as<T = Record<string, unknown>>(actor: Actor, sql: string, params: unknown[] = []): Promise<T[]> {
    const role = actor.kind === 'anon' ? 'anon' : actor.kind === 'service' ? 'service_role' : 'authenticated';
    const claims =
      actor.kind === 'user'
        ? { sub: actor.id, role, aal: actor.aal ?? 'aal1' }
        : { role };
    await this.pg.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(claims)]);
    await this.pg.exec(`set role ${role}`);
    try {
      const result = await this.pg.query<T>(sql, params);
      return result.rows;
    } finally {
      await this.pg.exec('reset role');
      await this.pg.query(`select set_config('request.jwt.claims', '', false)`);
    }
  }

  async asOne<T = Record<string, unknown>>(actor: Actor, sql: string, params: unknown[] = []): Promise<T> {
    const rows = await this.as<T>(actor, sql, params);
    if (rows.length !== 1) throw new Error(`Expected one row, got ${rows.length}: ${sql}`);
    return rows[0] as T;
  }

  /** Executes as `actor` and returns the Postgres error it raised (throws if none). */
  async expectError(actor: Actor, sql: string, params: unknown[] = []): Promise<PgError> {
    try {
      await this.as(actor, sql, params);
    } catch (error) {
      const e = error as { code?: string; message?: string; detail?: string };
      return { code: e.code ?? '', message: e.message ?? '', detail: e.detail };
    }
    throw new Error(`Expected an error from: ${sql}`);
  }

  /** Creates an auth user; the sign-up trigger creates the profile. */
  async createUser(options: CreateUserOptions = {}): Promise<string> {
    userCounter += 1;
    const username = options.username ?? `user_${userCounter}_${crypto.randomUUID().slice(0, 5)}`;
    const email = options.email ?? `${username.toLowerCase()}@example.test`;
    const metadata: Record<string, string> = { username, locale: options.locale ?? 'en' };
    if (options.homeZone) metadata.home_zone = options.homeZone;

    const { id } = await this.sqlOne<{ id: string }>(
      `insert into auth.users (email, email_confirmed_at, raw_user_meta_data, created_at)
       values ($1, case when $2 then now() end, $3::jsonb, now() - make_interval(days => $4))
       returning id`,
      [email, options.emailConfirmed ?? true, JSON.stringify(metadata), options.ageDays ?? 60],
    );
    if (options.karma) await this.giveKarma(id, options.karma);
    return id;
  }

  /** Adds karma through the ledger, exactly as settlement would. */
  async giveKarma(userId: string, amount: number): Promise<void> {
    await this.sql(
      `select private.reconcile('test_grant:' || gen_random_uuid(), $1, 'karma', 'test_grant', 'test', null, $2)`,
      [userId, amount],
    );
  }

  async setConfig(key: string, value: unknown): Promise<void> {
    await this.sql(`update public.app_config set value = $2::jsonb where key = $1`, [key, JSON.stringify(value)]);
  }

  async profile(userId: string): Promise<Record<string, unknown>> {
    return this.sqlOne(`select * from public.profiles where id = $1`, [userId]);
  }

  async integrity(userId: string): Promise<number> {
    const { integrity } = await this.sqlOne<{ integrity: number }>(`select private.integrity($1) as integrity`, [userId]);
    return integrity;
  }
}

async function listMigrations(): Promise<string[]> {
  const files = await readdir(MIGRATIONS_DIR);
  return files.filter((f) => /^\d{14}_[a-z0-9_]+\.sql$/.test(f)).sort();
}
