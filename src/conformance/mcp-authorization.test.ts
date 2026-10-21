// MCP Authorization（2025-11-25）と、その元になっている RFC への準拠テスト。
// https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
// アプリの API ルートと @ai-sdk/mcp を実際に動かし、相手役（認可サーバー・MCP サーバー）が受け取ったリクエストを検査する。
import { createHash } from 'crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fakeAuthorizationServer,
  fakeMcpServer,
  fakeProtectedResourceMetadata,
  findRequests,
  requests,
  resetFakes,
  rfc8414MetadataUrl,
  route,
} from './fakes';

const currentUser = vi.fn();
vi.mock('@/lib/auth', () => ({ currentUser: () => currentUser() }));

const { clearDiscoveryCache } = await import('@/lib/discovery');
const { MemoryStore, setStore } = await import('@/lib/store');
const { connectAll } = await import('@/lib/mcp');
const connect = await import('@/app/api/mcp/connect/route');
const callback = await import('@/app/api/mcp/callback/route');
const clientMetadataDocument = await import('@/app/oauth/client-metadata.json/route');

const APP = 'https://app.example.com';
const MCP = 'https://mcp.example.com/mcp';
const PRM = 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp';
const ISSUER = 'https://as.example.com/tenant1';
const USER = { id: 'u1', name: 'alice' };

function useServers(servers: Record<string, unknown>[]) {
  vi.stubEnv('MCP_SERVERS', JSON.stringify(servers));
}

/** 「接続」を押したときと同じく、認可を始めてリダイレクト先（認可 URL）を得る */
async function startConnect(name = 'mcp') {
  const res = await connect.GET(new NextRequest(`${APP}/api/mcp/connect?server=${name}`));
  return new URL(res.headers.get('location')!);
}

/** 認可サーバーからのリダイレクト（コールバック）を受ける */
function finishCallback(params: Record<string, string>) {
  return callback.GET(new NextRequest(`${APP}/api/mcp/callback?${new URLSearchParams(params)}`));
}

/** 標準的な構成: 401 の WWW-Authenticate で Protected Resource Metadata を示す MCP サーバーと、その認可サーバー */
function standardSetup(
  metadata: Record<string, unknown> = {},
  challenge = `Bearer resource_metadata="${PRM}", scope="files:read"`,
  insufficientScope?: string,
) {
  fakeMcpServer({ url: MCP, token: 'mcp-access-token', challenge, insufficientScope });
  fakeProtectedResourceMetadata(PRM, { resource: MCP, authorization_servers: [ISSUER], scopes_supported: ['files:read', 'files:write'] });
  return fakeAuthorizationServer({ issuer: ISSUER, metadata });
}

let store: InstanceType<typeof MemoryStore>;

beforeEach(() => {
  resetFakes();
  clearDiscoveryCache();
  store = new MemoryStore();
  setStore(store);
  currentUser.mockResolvedValue(USER);
  useServers([{ name: 'mcp', url: MCP, client_id: 'app-client', client_secret: 'app-secret', issuer: ISSUER }]);
  for (const level of ['info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Authorization Server Discovery（RFC 9728 / RFC 8414）', () => {
  it('[MCP Auth / RFC 9728 §5.1] 401 の WWW-Authenticate に resource_metadata があれば、その URL から Protected Resource Metadata を取得する', async () => {
    const custom = 'https://mcp.example.com/custom/resource-metadata';
    fakeMcpServer({ url: MCP, token: 'x', challenge: `Bearer resource_metadata="${custom}"` });
    fakeProtectedResourceMetadata(custom, { resource: MCP, authorization_servers: [ISSUER] });
    fakeAuthorizationServer({ issuer: ISSUER });

    await startConnect();
    expect(findRequests('GET', custom).length).toBeGreaterThan(0);
    expect(requests.filter((r) => r.url.includes('/.well-known/oauth-protected-resource'))).toHaveLength(0);
  });

  it('[MCP Auth / RFC 9728 §3] resource_metadata が無ければ、パス付きの well-known、ルートの well-known の順に試す', async () => {
    fakeMcpServer({ url: MCP, token: 'x', challenge: 'Bearer' });
    route('GET', PRM, () => [404, '']);
    fakeProtectedResourceMetadata('https://mcp.example.com/.well-known/oauth-protected-resource', {
      resource: MCP,
      authorization_servers: [ISSUER],
    });
    fakeAuthorizationServer({ issuer: ISSUER });

    await startConnect();
    const order = requests.filter((r) => r.url.includes('oauth-protected-resource')).map((r) => r.url);
    expect(order.slice(0, 2)).toEqual([PRM, 'https://mcp.example.com/.well-known/oauth-protected-resource']);
    expect((await startConnect()).origin).toBe('https://as.example.com');
  });

  it('[MCP Auth / RFC 8414 §3.1・§5] パス付きの issuer は、oauth-authorization-server（パス挿入）→ openid-configuration（パス挿入）→ openid-configuration（末尾追加）の順に探す', async () => {
    fakeMcpServer({ url: MCP, token: 'x', challenge: `Bearer resource_metadata="${PRM}"` });
    fakeProtectedResourceMetadata(PRM, { resource: MCP, authorization_servers: [ISSUER] });
    route('GET', rfc8414MetadataUrl(ISSUER), () => [404, '']);
    route('GET', 'https://as.example.com/.well-known/oauth-authorization-server', () => [404, '']); // ライブラリが追加で試す
    route('GET', 'https://as.example.com/.well-known/openid-configuration/tenant1', () => [404, '']);
    fakeAuthorizationServer({ issuer: ISSUER, metadataUrl: `${ISSUER}/.well-known/openid-configuration` });

    const url = await startConnect();
    expect(url.origin + url.pathname).toBe(`${ISSUER}/authorize`);
    const tried = requests.filter((r) => r.url.startsWith('https://as.example.com/') && r.method === 'GET').map((r) => r.url);
    expect(tried.indexOf(rfc8414MetadataUrl(ISSUER))).toBeLessThan(tried.indexOf('https://as.example.com/.well-known/openid-configuration/tenant1'));
    expect(tried.indexOf('https://as.example.com/.well-known/openid-configuration/tenant1')).toBeLessThan(
      tried.indexOf(`${ISSUER}/.well-known/openid-configuration`),
    );
  });

  it('[MCP Auth / RFC 8414 §3.1] パスの無い issuer は、oauth-authorization-server → openid-configuration の順に探す', async () => {
    const root = 'https://as2.example.com';
    useServers([{ name: 'mcp', url: MCP, client_id: 'app-client', client_secret: 'app-secret', issuer: root }]);
    fakeMcpServer({ url: MCP, token: 'x', challenge: `Bearer resource_metadata="${PRM}"` });
    fakeProtectedResourceMetadata(PRM, { resource: MCP, authorization_servers: [root] });
    route('GET', `${root}/.well-known/oauth-authorization-server`, () => [404, '']);
    fakeAuthorizationServer({ issuer: root, metadataUrl: `${root}/.well-known/openid-configuration` });

    expect((await startConnect()).origin).toBe(root);
    const tried = requests.filter((r) => r.url.startsWith(root) && r.method === 'GET').map((r) => r.url);
    expect(tried.slice(0, 2)).toEqual([`${root}/.well-known/oauth-authorization-server`, `${root}/.well-known/openid-configuration`]);
  });

  it('[失敗][RFC 9728 §3.3] Protected Resource Metadata の resource がこの MCP サーバーでなければ、認可を始めない', async () => {
    fakeMcpServer({ url: MCP, token: 'x', challenge: `Bearer resource_metadata="${PRM}"` });
    fakeProtectedResourceMetadata(PRM, { resource: 'https://other.example.com/mcp', authorization_servers: [ISSUER] });
    fakeAuthorizationServer({ issuer: ISSUER });

    const location = await startConnect();
    expect(location.toString()).toBe(`${APP}/`);
    expect(findRequests('GET', rfc8414MetadataUrl(ISSUER))).toHaveLength(0);
  });

  it('[失敗][RFC 8414 §3.3] メタデータの issuer が認可サーバーの issuer と違えば使わない（mix-up 対策）', async () => {
    standardSetup({ issuer: 'https://evil.example.com' });
    const location = await startConnect();
    expect(location.toString()).toBe(`${APP}/`);
  });
});

describe('Authorization Code Protection（PKCE, RFC 7636 / OAuth 2.1）', () => {
  it('[MCP Auth / OAuth 2.1 §4.1.1] 認可リクエストは S256 の code_challenge を付け、トークンリクエストの code_verifier と対応する', async () => {
    standardSetup();
    const url = await startConnect();
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const challenge = url.searchParams.get('code_challenge')!;
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);

    await finishCallback({ code: 'auth-code', state: url.searchParams.get('state')!, iss: ISSUER });
    const [tokenRequest] = findRequests('POST', `${ISSUER}/token`);
    const verifier = tokenRequest.form.get('code_verifier')!;
    expect(verifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/); // RFC 7636 §4.1
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(challenge); // RFC 7636 §4.2
  });

  it('[失敗][MCP Auth] 認可サーバーのメタデータに code_challenge_methods_supported が無ければ、認可を始めない', async () => {
    standardSetup({ code_challenge_methods_supported: undefined });
    expect((await startConnect()).toString()).toBe(`${APP}/`);
  });

  it('[失敗][MCP Auth] S256 に対応していない認可サーバーでは、認可を始めない', async () => {
    standardSetup({ code_challenge_methods_supported: ['plain'] });
    expect((await startConnect()).toString()).toBe(`${APP}/`);
  });
});

describe('Resource Parameter（RFC 8707）', () => {
  it('[MCP Auth / RFC 8707 §2] 認可リクエストとトークンリクエストの両方に、MCP サーバーの正規の URI を resource として付ける', async () => {
    standardSetup();
    const url = await startConnect();
    expect(url.searchParams.get('resource')).toBe(MCP);

    await finishCallback({ code: 'auth-code', state: url.searchParams.get('state')!, iss: ISSUER });
    expect(findRequests('POST', `${ISSUER}/token`)[0].form.get('resource')).toBe(MCP);
  });
});

describe('Authorization request と callback（OAuth 2.1 / RFC 9207）', () => {
  it('[OAuth 2.1 §4.1.1] 認可リクエストは response_type=code、client_id、登録済みの redirect_uri、state を持つ', async () => {
    standardSetup();
    const url = await startConnect();
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('app-client');
    expect(url.searchParams.get('redirect_uri')).toBe(`${APP}/api/mcp/callback`);
    expect(url.searchParams.get('state')).toMatch(/^mcp\./);
  });

  it('[OAuth 2.1 §4.1.3] トークンリクエストは authorization_code、同じ redirect_uri、クライアント認証（client_secret_basic）を使う', async () => {
    standardSetup();
    const url = await startConnect();
    await finishCallback({ code: 'auth-code', state: url.searchParams.get('state')!, iss: ISSUER });

    const [tokenRequest] = findRequests('POST', `${ISSUER}/token`);
    expect(tokenRequest.form.get('grant_type')).toBe('authorization_code');
    expect(tokenRequest.form.get('code')).toBe('auth-code');
    expect(tokenRequest.form.get('redirect_uri')).toBe(`${APP}/api/mcp/callback`);
    expect(tokenRequest.headers.authorization).toBe(`Basic ${Buffer.from('app-client:app-secret').toString('base64')}`);
  });

  it('[RFC 6749 §2.3.1] 認可サーバーが client_secret_post だけに対応していれば、ID とシークレットを本文で送る', async () => {
    standardSetup({ token_endpoint_auth_methods_supported: ['client_secret_post'] });
    const url = await startConnect();
    await finishCallback({ code: 'auth-code', state: url.searchParams.get('state')!, iss: ISSUER });
    const [tokenRequest] = findRequests('POST', `${ISSUER}/token`);
    expect(tokenRequest.headers.authorization).toBeUndefined();
    expect(tokenRequest.form.get('client_id')).toBe('app-client');
    expect(tokenRequest.form.get('client_secret')).toBe('app-secret');
  });

  it('[RFC 6749 §2.3.1 / 付録 B] Basic 認証の ID とシークレットは、フォーム形式でエンコードしてから Base64 にする', async () => {
    useServers([{ name: 'mcp', url: MCP, client_id: 'app client', client_secret: 'p@ss:word', issuer: ISSUER }]);
    standardSetup();
    const url = await startConnect();
    await finishCallback({ code: 'auth-code', state: url.searchParams.get('state')!, iss: ISSUER });
    const auth = findRequests('POST', `${ISSUER}/token`)[0].headers.authorization as string;
    expect(Buffer.from(auth.replace('Basic ', ''), 'base64').toString()).toBe('app+client:p%40ss%3Aword');
  });

  it('[RFC 6749 §2.1 / §3.2.1] 公開クライアントは client_id を本文に入れ、Authorization ヘッダーもシークレットも送らない', async () => {
    useServers([{ name: 'mcp', url: MCP }]);
    standardSetup();
    const url = await startConnect();
    await finishCallback({ code: 'auth-code', state: url.searchParams.get('state')!, iss: ISSUER });
    const [tokenRequest] = findRequests('POST', `${ISSUER}/token`);
    expect(tokenRequest.headers.authorization).toBeUndefined();
    expect(tokenRequest.form.get('client_id')).toBe('registered-client');
    expect(tokenRequest.form.has('client_secret')).toBe(false);
  });

  it('[失敗][MCP Auth / OAuth 2.1 §7.12] state が一致しないコールバックは捨て、トークンを要求しない', async () => {
    standardSetup();
    await startConnect();
    const res = await finishCallback({ code: 'auth-code', state: 'mcp.forged', iss: ISSUER });
    expect(res.status).toBe(500);
    expect(findRequests('POST', `${ISSUER}/token`)).toHaveLength(0);
  });

  it('[失敗][RFC 9207 §2.4] コールバックの iss が認可サーバーと違えば、トークンを要求しない（mix-up 対策）', async () => {
    standardSetup();
    const url = await startConnect();
    const res = await finishCallback({ code: 'auth-code', state: url.searchParams.get('state')!, iss: 'https://evil.example.com' });
    expect(res.status).toBe(500);
    expect(findRequests('POST', `${ISSUER}/token`)).toHaveLength(0);
  });

  it('[失敗][RFC 9207 §2.4] 認可サーバーが iss を付けると宣言している（authorization_response_iss_parameter_supported）のに、コールバックに iss が無ければ、トークンを要求しない', async () => {
    standardSetup();
    const url = await startConnect();
    const res = await finishCallback({ code: 'auth-code', state: url.searchParams.get('state')! });
    expect(res.status).toBe(400);
    expect(findRequests('POST', `${ISSUER}/token`)).toHaveLength(0);
  });

  it('[RFC 9207 §2.4] 認可サーバーが iss を宣言していなければ、iss の無いコールバックも受け付ける', async () => {
    standardSetup({ authorization_response_iss_parameter_supported: false });
    const url = await startConnect();
    const res = await finishCallback({ code: 'auth-code', state: url.searchParams.get('state')! });
    expect(res.status).toBe(200);
    expect(findRequests('POST', `${ISSUER}/token`)).toHaveLength(1);
  });

  it('[失敗][OAuth 2.1 §4.1.2.1] 認可サーバーがエラーを返したら（access_denied など）、トークンを要求しない', async () => {
    standardSetup();
    const url = await startConnect();
    const res = await finishCallback({ error: 'access_denied', state: url.searchParams.get('state')! });
    expect(res.status).toBe(400);
    expect(findRequests('POST', `${ISSUER}/token`)).toHaveLength(0);
  });

  it('[失敗][RFC 6749 §5.2] トークンエンドポイントのエラー（invalid_grant）を、そのまま失敗として扱う', async () => {
    fakeMcpServer({ url: MCP, token: 'x', challenge: `Bearer resource_metadata="${PRM}"` });
    fakeProtectedResourceMetadata(PRM, { resource: MCP, authorization_servers: [ISSUER] });
    fakeAuthorizationServer({ issuer: ISSUER, token: () => [400, { error: 'invalid_grant', error_description: 'expired' }] });

    const url = await startConnect();
    const res = await finishCallback({ code: 'auth-code', state: url.searchParams.get('state')!, iss: ISSUER });
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('expired');
  });
});

describe('Scope Selection Strategy', () => {
  it('[MCP Auth] WWW-Authenticate の scope があれば、それを要求する', async () => {
    standardSetup();
    expect((await startConnect()).searchParams.get('scope')).toBe('files:read');
  });

  it('[MCP Auth] scope が無ければ、Protected Resource Metadata の scopes_supported をすべて要求する', async () => {
    standardSetup({}, `Bearer resource_metadata="${PRM}"`);
    expect((await startConnect()).searchParams.get('scope')).toBe('files:read files:write');
  });
});

describe('Access Token Usage（RFC 6750 / OAuth 2.1 §5）', () => {
  it('[MCP Auth] MCP サーバーへのすべてのリクエストに Authorization: Bearer を付け、URL には載せない', async () => {
    standardSetup();
    const url = await startConnect();
    await finishCallback({ code: 'auth-code', state: url.searchParams.get('state')!, iss: ISSUER });

    const mcp = await connectAll(APP, USER);
    expect(mcp.statuses).toEqual([{ name: 'mcp', tools: 1 }]);
    await mcp.close();

    const toServer = requests.filter((r) => r.url.startsWith(MCP) && r.headers.authorization);
    expect(toServer.length).toBeGreaterThanOrEqual(2);
    for (const r of toServer) {
      expect(r.headers.authorization).toBe('Bearer mcp-access-token');
      expect(r.url).not.toContain('mcp-access-token');
    }
  });
});

describe('Refresh（OAuth 2.1 §4.3 / RFC 8707）', () => {
  /** 接続を済ませたあと、MCP サーバーが最初のトークンを期限切れとして拒否する構成にする */
  async function connectThenExpire(refresh: () => [number, unknown]) {
    fakeMcpServer({ url: MCP, token: 'refreshed-token', challenge: `Bearer resource_metadata="${PRM}"` });
    fakeProtectedResourceMetadata(PRM, { resource: MCP, authorization_servers: [ISSUER] });
    fakeAuthorizationServer({
      issuer: ISSUER,
      token: (req) =>
        req.form.get('grant_type') === 'refresh_token'
          ? (refresh() as [number, unknown])
          : [200, { access_token: 'first-token', token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt' }],
    });
    const url = await startConnect();
    await finishCallback({ code: 'auth-code', state: url.searchParams.get('state')!, iss: ISSUER });
    requests.length = 0;
  }

  it('[MCP Auth / RFC 8707 §2.2] 拒否されたトークンは、refresh_token とクライアント認証、resource を付けて更新し、新しいトークンで続ける', async () => {
    await connectThenExpire(() => [200, { access_token: 'refreshed-token', token_type: 'Bearer', expires_in: 3600 }]);

    const mcp = await connectAll(APP, USER);
    expect(mcp.statuses).toEqual([{ name: 'mcp', tools: 1 }]);
    await mcp.close();

    const [refresh] = findRequests('POST', `${ISSUER}/token`);
    expect(refresh.form.get('grant_type')).toBe('refresh_token');
    expect(refresh.form.get('refresh_token')).toBe('rt');
    expect(refresh.form.get('resource')).toBe(MCP);
    expect(refresh.headers.authorization).toBe(`Basic ${Buffer.from('app-client:app-secret').toString('base64')}`);
    expect((await store.get('mcp:u1:mcp')).tokens).toMatchObject({ access_token: 'refreshed-token' });
  });

  it('[失敗][RFC 6749 §5.2] 更新が拒否されたら（invalid_grant）、古いトークンを使わず、接続し直しを求める', async () => {
    await connectThenExpire(() => [400, { error: 'invalid_grant' }]);
    const mcp = await connectAll(APP, USER);
    expect(mcp.statuses[0].tools).toBeUndefined();
    expect(findRequests('POST', `${ISSUER}/token`)[0].form.get('grant_type')).toBe('refresh_token');
    expect((await store.get('mcp:u1:mcp')).tokens).toBeUndefined();
  });
});

describe('Scope Challenge Handling（step-up）', () => {
  it('[MCP Auth / RFC 6750 §3.1] 403 insufficient_scope を受けたら、求められた scope で認可し直す', async () => {
    standardSetup();
    const url = await startConnect();
    await finishCallback({ code: 'auth-code', state: url.searchParams.get('state')!, iss: ISSUER });

    // ツールの呼び出しが 403 insufficient_scope で拒否される
    resetFakes();
    clearDiscoveryCache();
    standardSetup({}, undefined, 'files:read files:write');
    const mcp = await connectAll(APP, USER);
    await expect(mcp.tools.mcp__search.execute!({}, { toolCallId: '1', messages: [] } as never)).rejects.toThrow();
    await mcp.close();

    // 「接続」で、求められた scope を付けた認可リクエストになる
    const stepUp = await startConnect();
    expect(stepUp.searchParams.get('scope')).toBe('files:read files:write');
    expect(stepUp.searchParams.get('resource')).toBe(MCP);
  });
});

describe('Client Registration Approaches', () => {
  it('[MCP Auth] 事前登録したクライアントがあれば、それを使い、動的登録はしない', async () => {
    standardSetup({ client_id_metadata_document_supported: true });
    expect((await startConnect()).searchParams.get('client_id')).toBe('app-client');
    expect(findRequests('POST', `${ISSUER}/register`)).toHaveLength(0);
  });

  it('[MCP Auth / CIMD] 事前登録が無く、認可サーバーが対応していれば、Client ID Metadata Document の URL を client_id にする', async () => {
    useServers([{ name: 'mcp', url: MCP }]);
    standardSetup({ client_id_metadata_document_supported: true });
    expect((await startConnect()).searchParams.get('client_id')).toBe(`${APP}/oauth/client-metadata.json`);
    expect(findRequests('POST', `${ISSUER}/register`)).toHaveLength(0);
  });

  it('[MCP Auth / RFC 7591] どちらも使えなければ、動的クライアント登録（公開クライアント、登録したリダイレクト URI）を使う', async () => {
    useServers([{ name: 'mcp', url: MCP }]);
    standardSetup();
    const url = await startConnect();
    expect(url.searchParams.get('client_id')).toBe('registered-client');

    const registration = JSON.parse(findRequests('POST', `${ISSUER}/register`)[0].body);
    expect(registration).toMatchObject({
      redirect_uris: [`${APP}/api/mcp/callback`],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  });

  it('[CIMD §3・§4] 文書は client_id が自分の URL と完全に一致し、client_id、client_name、redirect_uris を含む', async () => {
    const res = clientMetadataDocument.GET(new NextRequest(`${APP}/oauth/client-metadata.json`));
    const doc = await res.json();
    expect(doc.client_id).toBe(`${APP}/oauth/client-metadata.json`);
    expect(new URL(doc.client_id).protocol).toBe('https:');
    expect(doc.client_name).toBeTruthy();
    expect(doc.redirect_uris).toEqual([`${APP}/api/mcp/callback`]);
  });

  it('[失敗][MCP Auth / CIMD] https でなければ CIMD は使わない（認可サーバーが文書を取得できないため）', async () => {
    useServers([{ name: 'mcp', url: MCP }]);
    standardSetup({ client_id_metadata_document_supported: true });
    const res = await connect.GET(new NextRequest('http://localhost:3000/api/mcp/connect?server=mcp'));
    expect(new URL(res.headers.get('location')!).searchParams.get('client_id')).toBe('registered-client');
  });
});

describe('Communication Security', () => {
  it('[MCP Auth / OAuth 2.1 §1.5] リダイレクト URI は https（ローカルでは localhost）', async () => {
    standardSetup();
    expect(new URL((await startConnect()).searchParams.get('redirect_uri')!).protocol).toBe('https:');
    const local = await connect.GET(new NextRequest('http://localhost:3000/api/mcp/connect?server=mcp'));
    expect(new URL(new URL(local.headers.get('location')!).searchParams.get('redirect_uri')!).hostname).toBe('localhost');
  });
});
