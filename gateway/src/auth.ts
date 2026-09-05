import {
  BufferJSON,
  initAuthCreds,
  type AuthenticationCreds,
  type SignalDataTypeMap,
  type SignalKeyStore,
  type SignalKeyStoreWithTransaction,
} from "@whiskeysockets/baileys";
import pino from "pino";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

/**
 * Registers live session credentials + signal keys inside Supabase
 * (`repli.gateway_sessions`) instead of local files, so the session
 * survives restarts on ephemeral hosts like Render's free tier.
 */

import type { Sql } from "postgres";

type KeysMap = Record<string, Record<string, unknown>>;

export class PgAuthState {
  private creds: AuthenticationCreds;
  private keys: KeysMap = {};
  private loaded: Promise<void>;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly restaurantId: string,
    private readonly sql: Sql | null
  ) {
    this.creds = initAuthCreds();
    this.loaded = this.load();
  }

  /** Resolves once previous session data (if any) has been restored. */
  get ready(): Promise<void> {
    return this.loaded;
  }

  get state(): { creds: AuthenticationCreds; keys: SignalKeyStore } {
    return {
      creds: this.creds,
      keys: this.keyStore(),
    };
  }

  saveCreds = (): Promise<void> => {
    return this.persist();
  };

  /** immediate flush (used on shutdown) */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.persist();
  }

  /**
   * Delete any stored session state for this restaurant so the next pairing
   * starts from completely fresh (unregistered) credentials that can show a
   * QR again. Used when the owner unlinks the device or we need a new QR.
   */
  async discard(): Promise<void> {
    if (this.sql == null) return;
    try {
      await this.sql`DELETE FROM repli.gateway_sessions
        WHERE restaurant_id = ${this.restaurantId} AND channel = 'whatsapp'`;
    } catch (err) {
      logger.warn(`session discard failed for ${this.restaurantId}: ${String(err)}`);
    }
  }

  private keyStore(): SignalKeyStore & SignalKeyStoreWithTransaction {
    return {
      get: async (type, ids) => {
        await this.loaded;
        const out: Record<string, unknown> = {};
        const bucket = this.keys[type] ?? {};
        for (const id of ids) {
          if (id in bucket) out[id] = bucket[id];
        }
        return out as never;
      },
      set: async (data) => {
        await this.loaded;
        const categories = Object.keys(data) as Array<keyof SignalDataTypeMap>;
        for (const category of categories) {
          const bucket = (this.keys[String(category)] ??= {});
          const entries = data[category] ?? {};
          for (const id of Object.keys(entries)) {
            const value = entries[id];
            if (value == null) {
              delete bucket[id];
            } else {
              bucket[id] = value;
            }
          }
        }
        this.schedulePersist();
      },
      clear: async () => {
        await this.loaded;
        this.keys = {};
        this.creds = initAuthCreds();
        this.schedulePersist();
      },
      isInTransaction: () => false,
      transaction: async <T>(exec: () => Promise<T>): Promise<T> => exec(),
    };
  }

  private schedulePersist(): void {
    if (this.sql == null) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.persist(), 800);
  }

  private async load(): Promise<void> {
    if (this.sql == null) return;
    try {
      const rows = await this.sql<Array<Record<string, string | null>>>`SELECT
        creds_json as "credsJson",
        keys_json as "keysJson"
        FROM repli.gateway_sessions
        WHERE restaurant_id = ${this.restaurantId} AND channel = 'whatsapp'`;
      const row = rows[0];
      if (!row) return;
      if (row.credsJson) this.creds = JSON.parse(row.credsJson, BufferJSON.reviver);
      if (row.keysJson) this.keys = JSON.parse(row.keysJson, BufferJSON.reviver);
      logger.info(`restored session state for ${this.restaurantId}`);
    } catch (err) {
      logger.warn(`session load failed for ${this.restaurantId}: ${String(err)}`);
    }
  }

  private async persist(): Promise<void> {
    if (this.sql == null) return;
    try {
      const credsJson = JSON.stringify(this.creds, BufferJSON.replacer);
      const keysJson = JSON.stringify(this.keys, BufferJSON.replacer);
      await this.sql`INSERT INTO repli.gateway_sessions
        (restaurant_id, channel, creds_json, keys_json, updated_at)
        VALUES (${this.restaurantId}, 'whatsapp', ${credsJson}, ${keysJson}, now())
        ON CONFLICT (restaurant_id, channel)
        DO UPDATE SET creds_json = EXCLUDED.creds_json,
          keys_json = EXCLUDED.keys_json,
          updated_at = now()`;
    } catch (err) {
      logger.warn(`session persist failed for ${this.restaurantId}: ${String(err)}`);
    }
  }
}