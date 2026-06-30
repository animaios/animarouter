import { getDb } from "../db/index.js";
import { decrypt, encrypt, maskKey } from "../lib/crypto.js";

export interface OutboundTransportRecord {
  id: number;
  transportId: string;
  name: string;
  endpointUrl: string;
  maskedAuthKey: string;
  allowedHosts: string;
  placementRegion: string | null;
  enabled: boolean;
  lastDeployedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface OutboundTransportRow {
  id: number;
  transport_id: string;
  name: string;
  endpoint_url: string;
  encrypted_auth_key: string;
  iv: string;
  auth_tag: string;
  allowed_hosts: string;
  placement_region: string | null;
  enabled: number;
  last_deployed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RelayTransportSecret {
  endpointUrl: string;
  authKey: string;
}

export interface UpsertOutboundTransportInput {
  transportId?: string;
  name: string;
  endpointUrl: string;
  authKey: string;
  allowedHosts?: string;
  placementRegion?: string | null;
  enabled?: boolean;
  lastDeployedAt?: string;
}

function normalizeEndpointUrl(endpointUrl: string): string {
  return endpointUrl.replace(/\/+$/, "");
}

function toRecord(row: OutboundTransportRow): OutboundTransportRecord {
  let maskedAuthKey = "[decrypt failed]";
  try {
    maskedAuthKey = maskKey(
      decrypt(row.encrypted_auth_key, row.iv, row.auth_tag),
    );
  } catch {
    // Keep the transport visible in the dashboard so the user can redeploy it.
  }

  return {
    id: row.id,
    transportId: row.transport_id,
    name: row.name,
    endpointUrl: row.endpoint_url,
    maskedAuthKey,
    allowedHosts: row.allowed_hosts,
    placementRegion: row.placement_region,
    enabled: row.enabled === 1,
    lastDeployedAt: row.last_deployed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listOutboundTransports(): OutboundTransportRecord[] {
  const rows = getDb()
    .prepare(`
    SELECT * FROM outbound_transports
    ORDER BY enabled DESC, updated_at DESC, id DESC
  `)
    .all() as OutboundTransportRow[];
  return rows.map(toRecord);
}

export function getEnabledCloudflareWorkerTransport():
  | RelayTransportSecret
  | undefined {
  const row = getDb()
    .prepare(`
    SELECT * FROM outbound_transports
    WHERE transport_id = 'cloudflare-worker' AND enabled = 1
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `)
    .get() as OutboundTransportRow | undefined;
  if (!row) return undefined;

  return {
    endpointUrl: normalizeEndpointUrl(row.endpoint_url),
    authKey: decrypt(row.encrypted_auth_key, row.iv, row.auth_tag),
  };
}

export function upsertOutboundTransport(
  input: UpsertOutboundTransportInput,
): OutboundTransportRecord {
  const transportId = input.transportId ?? "cloudflare-worker";
  const endpointUrl = normalizeEndpointUrl(input.endpointUrl);
  const encrypted = encrypt(input.authKey);
  const now = input.lastDeployedAt ?? new Date().toISOString();

  getDb()
    .prepare(`
    INSERT INTO outbound_transports (
      transport_id, name, endpoint_url, encrypted_auth_key, iv, auth_tag,
      allowed_hosts, placement_region, enabled, last_deployed_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(transport_id, endpoint_url) DO UPDATE SET
      name = excluded.name,
      encrypted_auth_key = excluded.encrypted_auth_key,
      iv = excluded.iv,
      auth_tag = excluded.auth_tag,
      allowed_hosts = excluded.allowed_hosts,
      placement_region = excluded.placement_region,
      enabled = excluded.enabled,
      last_deployed_at = excluded.last_deployed_at,
      updated_at = excluded.updated_at
  `)
    .run(
      transportId,
      input.name,
      endpointUrl,
      encrypted.encrypted,
      encrypted.iv,
      encrypted.authTag,
      input.allowedHosts ?? "*",
      input.placementRegion ?? null,
      input.enabled === false ? 0 : 1,
      now,
      now,
    );

  const row = getDb()
    .prepare(`
    SELECT * FROM outbound_transports
    WHERE transport_id = ? AND endpoint_url = ?
  `)
    .get(transportId, endpointUrl) as OutboundTransportRow;

  return toRecord(row);
}
