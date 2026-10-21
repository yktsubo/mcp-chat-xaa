import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { checkResourceAllowed, resourceUrlFromServerUrl } from '@modelcontextprotocol/sdk/shared/auth-utils.js';

// MCP の認可仕様どおりのメタデータ取得（MCP 公式 SDK の関数を使う）。結果は少しの間キャッシュする。
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map<string, { value: Promise<unknown>; expires: number }>();

function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as Promise<T>;
  const value = load();
  value.catch(() => cache.delete(key)); // 失敗したら次回もう一度取得する
  cache.set(key, { value, expires: Date.now() + CACHE_MS });
  return value;
}

/** テスト用: キャッシュを消す */
export function clearDiscoveryCache() {
  cache.clear();
}

export type ResourceInfo = { resource: string; authorizationServers: string[] };

/**
 * MCP サーバーの Protected Resource Metadata（RFC 9728）。
 * `resource` がこの MCP サーバーを指していなければ使わない（別のサーバー向けのメタデータを信用しない）。
 */
export function resourceInfo(serverUrl: string): Promise<ResourceInfo> {
  return cached(`prm:${serverUrl}`, async () => {
    const metadata = await discoverOAuthProtectedResourceMetadata(serverUrl);
    const allowed = checkResourceAllowed({
      requestedResource: resourceUrlFromServerUrl(serverUrl),
      configuredResource: metadata.resource,
    });
    if (!allowed) throw new Error(`Protected resource ${metadata.resource} does not match ${serverUrl}`);
    return { resource: metadata.resource, authorizationServers: metadata.authorization_servers ?? [] };
  });
}

/**
 * この MCP サーバーで使う認可サーバー。メタデータの authorization_servers から選ぶ。
 * expected（設定値）があれば、それが一覧に含まれていることを確かめる。
 */
export async function authorizationServerFor(serverUrl: string, expected?: string): Promise<string> {
  const { authorizationServers } = await resourceInfo(serverUrl);
  if (expected) {
    if (!authorizationServers.includes(expected)) {
      throw new Error(`Authorization server ${expected} is not listed for ${serverUrl}`);
    }
    return expected;
  }
  if (!authorizationServers[0]) throw new Error(`No authorization server is listed for ${serverUrl}`);
  return authorizationServers[0];
}

/** 認可サーバーのメタデータ（RFC 8414 / OpenID Connect Discovery） */
export function authorizationServerMetadata(issuer: string) {
  return cached(`as:${issuer}`, async () => {
    const metadata = await discoverAuthorizationServerMetadata(issuer);
    if (!metadata) throw new Error(`No authorization server metadata for ${issuer}`);
    return metadata;
  });
}
