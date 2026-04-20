import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { decryptSecret, encryptSecret, type EncryptedValue } from "./crypto.js";

const TENANT_ID_PREFIX = "tnt_";
const BEARER_PREFIX = "trn_";

/** Discriminated union lets us add OAuth later without reshaping existing tenants. */
export type TenantCredential =
  | {
      kind: "api_token";
      apiTokenEncrypted: EncryptedValue;
      /** Optional TBNB-Partner-ID UUID. Only sent as header when present. */
      partnerId?: string;
    }
  | {
      kind: "oauth";
      accessTokenEncrypted: EncryptedValue;
      refreshTokenEncrypted: EncryptedValue;
      expiresAt: string; // ISO
      partnerId?: string;
    };

export interface Tenant {
  id: string;
  label: string;
  bearerHash: string;
  credential: TenantCredential;
  baseUrl: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface TenantSummary {
  id: string;
  label: string;
  credentialKind: TenantCredential["kind"];
  baseUrl: string;
  createdAt: string;
  lastUsedAt?: string;
}

export function generateTenantId(): string {
  return TENANT_ID_PREFIX + randomBytes(6).toString("hex");
}

export function generateBearer(): string {
  return BEARER_PREFIX + randomBytes(32).toString("hex");
}

export function hashBearer(bearer: string): string {
  return createHash("sha256").update(bearer).digest("hex");
}

interface SerializedEncrypted {
  iv: string;
  tag: string;
  ciphertext: string;
}

interface SerializedCredentialApiToken {
  kind: "api_token";
  api_token_encrypted: SerializedEncrypted;
  partner_id?: string;
}

interface SerializedCredentialOAuth {
  kind: "oauth";
  access_token_encrypted: SerializedEncrypted;
  refresh_token_encrypted: SerializedEncrypted;
  expires_at: string;
  partner_id?: string;
}

type SerializedCredential = SerializedCredentialApiToken | SerializedCredentialOAuth;

interface SerializedTenant {
  id: string;
  label: string;
  bearer_hash: string;
  credential: SerializedCredential;
  base_url: string;
  created_at: string;
  last_used_at?: string;
}

function serEnc(v: EncryptedValue): SerializedEncrypted {
  return {
    iv: v.iv.toString("hex"),
    tag: v.tag.toString("hex"),
    ciphertext: v.ciphertext.toString("hex"),
  };
}

function deEnc(v: SerializedEncrypted): EncryptedValue {
  return {
    iv: Buffer.from(v.iv, "hex"),
    tag: Buffer.from(v.tag, "hex"),
    ciphertext: Buffer.from(v.ciphertext, "hex"),
  };
}

function serialize(t: Tenant): SerializedTenant {
  let credential: SerializedCredential;
  if (t.credential.kind === "api_token") {
    credential = {
      kind: "api_token",
      api_token_encrypted: serEnc(t.credential.apiTokenEncrypted),
      partner_id: t.credential.partnerId,
    };
  } else {
    credential = {
      kind: "oauth",
      access_token_encrypted: serEnc(t.credential.accessTokenEncrypted),
      refresh_token_encrypted: serEnc(t.credential.refreshTokenEncrypted),
      expires_at: t.credential.expiresAt,
      partner_id: t.credential.partnerId,
    };
  }
  return {
    id: t.id,
    label: t.label,
    bearer_hash: t.bearerHash,
    credential,
    base_url: t.baseUrl,
    created_at: t.createdAt,
    last_used_at: t.lastUsedAt,
  };
}

function deserialize(raw: SerializedTenant): Tenant {
  let credential: TenantCredential;
  if (raw.credential.kind === "api_token") {
    credential = {
      kind: "api_token",
      apiTokenEncrypted: deEnc(raw.credential.api_token_encrypted),
      partnerId: raw.credential.partner_id,
    };
  } else {
    credential = {
      kind: "oauth",
      accessTokenEncrypted: deEnc(raw.credential.access_token_encrypted),
      refreshTokenEncrypted: deEnc(raw.credential.refresh_token_encrypted),
      expiresAt: raw.credential.expires_at,
      partnerId: raw.credential.partner_id,
    };
  }
  return {
    id: raw.id,
    label: raw.label,
    bearerHash: raw.bearer_hash,
    credential,
    baseUrl: raw.base_url,
    createdAt: raw.created_at,
    lastUsedAt: raw.last_used_at,
  };
}

export interface CreateApiTokenTenantParams {
  id?: string;
  label: string;
  apiToken: string;
  partnerId?: string;
  baseUrl: string;
}

export class TenantStore {
  private tenants = new Map<string, Tenant>();
  private hashIndex = new Map<string, string>();

  constructor(private readonly path: string) {}

  load(): void {
    if (!existsSync(this.path)) return;
    const raw = JSON.parse(readFileSync(this.path, "utf8"));
    if (!Array.isArray(raw)) return;
    for (const r of raw) {
      const t = deserialize(r as SerializedTenant);
      this.tenants.set(t.id, t);
      this.hashIndex.set(t.bearerHash, t.id);
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = this.path + ".tmp";
    const arr = Array.from(this.tenants.values()).map(serialize);
    writeFileSync(tmp, JSON.stringify(arr, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  createWithApiToken(params: CreateApiTokenTenantParams): { tenant: Tenant; bearer: string } {
    const id = params.id ?? generateTenantId();
    if (this.tenants.has(id)) {
      throw new Error(`tenant ${id} already exists`);
    }
    const bearer = generateBearer();
    const tenant: Tenant = {
      id,
      label: params.label,
      bearerHash: hashBearer(bearer),
      credential: {
        kind: "api_token",
        apiTokenEncrypted: encryptSecret(params.apiToken),
        partnerId: params.partnerId || undefined,
      },
      baseUrl: params.baseUrl,
      createdAt: new Date().toISOString(),
    };
    this.tenants.set(id, tenant);
    this.hashIndex.set(tenant.bearerHash, id);
    this.save();
    return { tenant, bearer };
  }

  getByBearer(bearer: string): Tenant | null {
    const id = this.hashIndex.get(hashBearer(bearer));
    if (!id) return null;
    return this.tenants.get(id) ?? null;
  }

  getById(id: string): Tenant | null {
    return this.tenants.get(id) ?? null;
  }

  touch(id: string): void {
    const t = this.tenants.get(id);
    if (!t) return;
    t.lastUsedAt = new Date().toISOString();
    this.save();
  }

  delete(id: string): boolean {
    const t = this.tenants.get(id);
    if (!t) return false;
    this.tenants.delete(id);
    this.hashIndex.delete(t.bearerHash);
    this.save();
    return true;
  }

  list(): TenantSummary[] {
    return Array.from(this.tenants.values()).map((t) => ({
      id: t.id,
      label: t.label,
      credentialKind: t.credential.kind,
      baseUrl: t.baseUrl,
      createdAt: t.createdAt,
      lastUsedAt: t.lastUsedAt,
    }));
  }

  /** Returns the decrypted Turno bearer token to use on outbound API calls. */
  decryptApiToken(tenant: Tenant): string {
    if (tenant.credential.kind === "api_token") {
      return decryptSecret(tenant.credential.apiTokenEncrypted);
    }
    // OAuth path — for now just return the access token; refresh handling comes later.
    return decryptSecret(tenant.credential.accessTokenEncrypted);
  }
}
