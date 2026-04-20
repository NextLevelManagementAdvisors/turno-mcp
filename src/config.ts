import "dotenv/config";
import { resolve } from "node:path";

const trueish = (v: string | undefined, def = false): boolean => {
  if (v === undefined) return def;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
};

export const config = {
  TRANSPORT: (process.env.TRANSPORT ?? "stdio") as "stdio" | "http",

  // HTTP mode
  HOST: process.env.HOST ?? "127.0.0.1",
  PORT: Number(process.env.PORT ?? 3007),
  PUBLIC_HOST: process.env.TURNO_PUBLIC_HOST ?? "turno.nlma.io",
  ENROLL_ENABLED: trueish(process.env.ENROLL_ENABLED, true),

  // Tenant storage
  TURNO_ENCRYPTION_KEY: process.env.TURNO_ENCRYPTION_KEY ?? "",
  TURNO_DATA_DIR: resolve(process.env.TURNO_DATA_DIR ?? "./data"),
  TURNO_TENANTS_FILE: resolve(
    process.env.TURNO_TENANTS_FILE ?? "./data/tenants.json",
  ),

  // Turno API
  TURNO_BASE_URL: (process.env.TURNO_BASE_URL ?? "https://api.turnoverbnb.com/v2").replace(/\/+$/, ""),

  // stdio mode
  TURNO_API_TOKEN: process.env.TURNO_API_TOKEN ?? "",
  TURNO_PARTNER_ID: process.env.TURNO_PARTNER_ID ?? "",
} as const;

export type Config = typeof config;
