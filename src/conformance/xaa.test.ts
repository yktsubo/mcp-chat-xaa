// XAA（Cross App Access）の準拠テスト。
// - IETF Identity Assertion JWT Authorization Grant（draft-ietf-oauth-identity-assertion-authz-grant）
// - MCP Enterprise-Managed Authorization（io.modelcontextprotocol/enterprise-managed-authorization）
// - RFC 8693（Token Exchange）、RFC 7523（JWT Bearer / private_key_jwt）、RFC 6750（Bearer）
// openid-client と MCP 公式 SDK を実際に動かし、偽の Okta と Agent Gateway が受け取ったリクエストを検査する。
import { generateKeyPairSync, verify } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeMcpServer, fakeProtectedResourceMetadata, findRequests, requests, resetFakes, route, type Recorded } from './fakes';

const { clearDiscoveryCache } = await import('@/lib/discovery');
const { clearIssuerCache } = await import('@/lib/okta');
const { MemoryStore, setStore } = await import('@/lib/store');
const { connectAll } = await import('@/lib/mcp');

const ORG = 'https://idp.example.com';
const ORG_TOKEN = `${ORG}/oauth2/v1/token`;
const RESOURCE_AS = `${ORG}/oauth2/aus1`;
const RESOURCE_TOKEN = `${RESOURCE_AS}/v1/token`;
const GATEWAY = 'https://gw.example.com/mcp/servers/demo';
const PRM = 'https://gw.example.com/.well-known/oauth-protected-resource/mcp/servers/demo';
const APP = 'https://app.example.com';
const USER = { id: 'u1', idToken: 'user-id-token' };

const ID_JAG_RESPONSE = {
  access_token: 'the-id-jag',
  issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
  token_type: 'N_A',
  expires_in: 300,
};

type Reply = [number, unknown?];

function oidcMetadata(issuer: string, tokenEndpoint: string, extra: Record<string, unknown> = {}) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/v1/authorize`,
    token_endpoint: tokenEndpoint,
    jwks_uri: `${issuer}/v1/keys`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    code_challenge_methods_supported: ['S256'],
    ...extra,
  };
}

/** 偽の Okta（Org 認可サーバーと、vMCP の認可サーバー）と Agent Gateway */
function setup({
  orgToken = () => [200, ID_JAG_RESPONSE],
  resourceToken = () => [200, { access_token: 'xaa-access-token', token_type: 'Bearer', expires_in: 3600 }],
  prm = { resource: GATEWAY, authorization_servers: [RESOURCE_AS] },
  insufficientScope,
}: {
  orgToken?: (req: Recorded) => Reply;
  resourceToken?: (req: Recorded) => Reply;
  prm?: Record<string, unknown>;
  insufficientScope?: string;
} = {}) {
  route('GET', `${ORG}/.well-known/openid-configuration`, () => [200, oidcMetadata(ORG, ORG_TOKEN, { end_session_endpoint: `${ORG}/oauth2/v1/logout` })]);
  route('POST', ORG_TOKEN, orgToken);
  const resourceMetadata = oidcMetadata(RESOURCE_AS, RESOURCE_TOKEN, {
    grant_types_supported: ['authorization_code', 'urn:ietf:params:oauth:grant-type:jwt-bearer'],
    authorization_grant_profiles_supported: ['urn:ietf:params:oauth:grant-profile:id-jag'],
  });
  route('GET', `${ORG}/.well-known/oauth-authorization-server/oauth2/aus1`, () => [200, resourceMetadata]);
  route('GET', `${RESOURCE_AS}/.well-known/openid-configuration`, () => [200, resourceMetadata]);
  route('POST', RESOURCE_TOKEN, resourceToken);
  fakeProtectedResourceMetadata(PRM, prm);
  fakeMcpServer({ url: GATEWAY, token: 'xaa-access-token', insufficientScope });
}

function useGateway(extra: Record<string, unknown> = {}) {
  vi.stubEnv('MCP_SERVERS', JSON.stringify([{ name: 'gateway', url: GATEWAY, auth: 'xaa', scope: 'gateway:connect', ...extra }]));
}

const tokenExchange = () => findRequests('POST', ORG_TOKEN)[0];
const jwtBearer = () => findRequests('POST', RESOURCE_TOKEN)[0];
const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString());

beforeEach(() => {
  resetFakes();
  clearDiscoveryCache();
  clearIssuerCache();
  setStore(new MemoryStore());
  vi.stubEnv('OKTA_ISSUER', ORG);
  vi.stubEnv('OKTA_CLIENT_ID', 'agent-app');
  vi.stubEnv('OKTA_CLIENT_SECRET', 'agent-secret');
  vi.stubEnv('OKTA_AI_AGENT_ID', '');
  vi.stubEnv('OKTA_AI_AGENT_PRIVATE_KEY', '');
  useGateway();
  for (const level of ['info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('ID-JAG の取得（Token Exchange）', () => {
  it('[ID-JAG §4.3 / RFC 8693 §2.1] 必須のパラメーター（grant_type、requested_token_type、subject_token、subject_token_type、audience）をフォーム形式で送る', async () => {
    setup();
    await connectAll(APP, USER);
    const req = tokenExchange();
    expect(req.headers['content-type']).toContain('application/x-www-form-urlencoded');
    expect(req.form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
    expect(req.form.get('requested_token_type')).toBe('urn:ietf:params:oauth:token-type:id-jag');
    expect(req.form.get('subject_token')).toBe('user-id-token');
    expect(req.form.get('subject_token_type')).toBe('urn:ietf:params:oauth:token-type:id_token');
  });

  it('[MCP EMA §4] audience は MCP サーバーの認可サーバーの issuer（Protected Resource Metadata で確認したもの）', async () => {
    setup();
    await connectAll(APP, USER);
    expect(findRequests('GET', PRM).length).toBeGreaterThan(0);
    expect(tokenExchange().form.get('audience')).toBe(RESOURCE_AS);
    expect(tokenExchange().form.get('scope')).toBe('gateway:connect');
  });

  it('[ID-JAG §4.3 / MCP EMA §4] resource は OPTIONAL。既定では付けず、付ける設定のときは MCP サーバーの識別子（RFC 9728 の resource）にする', async () => {
    setup();
    await connectAll(APP, USER);
    expect(tokenExchange().form.has('resource')).toBe(false);

    resetFakes();
    clearDiscoveryCache();
    setStore(new MemoryStore());
    useGateway({ xaa_resource: true });
    setup();
    await connectAll(APP, USER);
    expect(tokenExchange().form.get('resource')).toBe(GATEWAY);
  });

  it('[ID-JAG §4.3 / RFC 6749 §2.3.1] クライアントとして認証する（client_secret_basic）', async () => {
    setup();
    await connectAll(APP, USER);
    expect(tokenExchange().headers.authorization).toBe(`Basic ${Buffer.from('agent-app:agent-secret').toString('base64')}`);
    expect(tokenExchange().form.has('client_secret')).toBe(false);
  });

  it('[ID-JAG §9.1] OKTA_AI_AGENT_ID があれば、AI エージェントとして交換する', async () => {
    vi.stubEnv('OKTA_AI_AGENT_ID', 'wlp-agent');
    setup();
    await connectAll(APP, USER);
    expect(tokenExchange().headers.authorization).toBe(`Basic ${Buffer.from('wlp-agent:agent-secret').toString('base64')}`);
  });

  it('[失敗][ID-JAG §4.3.4] 応答の issued_token_type が ID-JAG でなければ受け取らず、先へ進まない', async () => {
    setup({ orgToken: () => [200, { ...ID_JAG_RESPONSE, issued_token_type: 'urn:ietf:params:oauth:token-type:access_token' }] });
    const { statuses } = await connectAll(APP, USER);
    expect(statuses[0].error).toMatch(/Unexpected token exchange response/);
    expect(findRequests('POST', RESOURCE_TOKEN)).toHaveLength(0);
    expect(findRequests('POST', GATEWAY)).toHaveLength(0);
  });

  it('[失敗][ID-JAG §4.3.4] 応答の token_type が N_A でなければ（そのまま使えるトークンとして返されたら）受け取らない', async () => {
    setup({ orgToken: () => [200, { ...ID_JAG_RESPONSE, token_type: 'Bearer' }] });
    const { statuses } = await connectAll(APP, USER);
    expect(statuses[0].error).toMatch(/token_type=Bearer/);
    expect(findRequests('POST', RESOURCE_TOKEN)).toHaveLength(0);
  });

  it('[失敗][RFC 6749 §5.2] Okta が交換を拒否したら（invalid_grant）、エラーを記録して MCP サーバーを呼ばない', async () => {
    setup({ orgToken: () => [400, { error: 'invalid_grant', error_description: 'policy denied' }] });
    const { statuses } = await connectAll(APP, USER);
    expect(statuses[0].error).toMatch(/invalid_grant/);
    expect(JSON.parse(vi.mocked(console.error).mock.calls.at(-1)![0])).toMatchObject({ event: 'xaa_exchange_failed', server: 'gateway' });
    expect(findRequests('POST', GATEWAY)).toHaveLength(0);
  });

  it('[失敗] ID トークンが無ければ、Okta に問い合わせない（ログインし直しを求める）', async () => {
    setup();
    const { statuses } = await connectAll(APP, { id: 'u1' });
    expect(statuses[0].error).toContain('ログインし直してください');
    expect(findRequests('POST', ORG_TOKEN)).toHaveLength(0);
  });
});

describe('認可サーバーの確認（Protected Resource Metadata）', () => {
  it('[失敗][MCP EMA §1.2 / RFC 9728] 設定した認可サーバーがメタデータに無ければ、トークンを要求しない', async () => {
    useGateway({ issuer: 'https://evil.example.com/oauth2/x' });
    setup();
    const { statuses } = await connectAll(APP, USER);
    expect(statuses[0].error).toMatch(/is not listed/);
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  });

  it('[失敗][RFC 9728 §3.3] メタデータの resource がこの MCP サーバーでなければ、トークンを要求しない', async () => {
    setup({ prm: { resource: 'https://other.example.com/mcp', authorization_servers: [RESOURCE_AS] } });
    const { statuses } = await connectAll(APP, USER);
    expect(statuses[0].error).toMatch(/does not match/);
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  });

  it('[失敗] メタデータに認可サーバーが無ければ、トークンを要求しない', async () => {
    setup({ prm: { resource: GATEWAY } });
    expect((await connectAll(APP, USER)).statuses[0].error).toMatch(/No authorization server/);
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(0);
  });
});

describe('アクセストークンの取得（JWT Bearer）と利用', () => {
  it('[ID-JAG §4.4 / RFC 7523 §2.1] ID-JAG を assertion にした jwt-bearer グラントを、MCP サーバーの認可サーバーに送る', async () => {
    setup();
    await connectAll(APP, USER);
    const req = jwtBearer();
    expect(req.form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(req.form.get('assertion')).toBe('the-id-jag');
    expect(req.headers.authorization).toBe(`Basic ${Buffer.from('agent-app:agent-secret').toString('base64')}`);
  });

  it('[MCP Auth / RFC 6750 §2.1] 得たアクセストークンを Authorization: Bearer で MCP サーバーに送る', async () => {
    setup();
    const { statuses, close } = await connectAll(APP, USER);
    await close();
    expect(statuses).toEqual([{ name: 'gateway', tools: 1 }]);
    const calls = findRequests('POST', GATEWAY);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.headers.authorization).toBe('Bearer xaa-access-token');
  });

  it('[失敗][RFC 6749 §5.2] MCP サーバーの認可サーバーが拒否したら、MCP サーバーを呼ばない', async () => {
    setup({ resourceToken: () => [400, { error: 'invalid_grant', error_description: 'ID-JAG expired' }] });
    const { statuses } = await connectAll(APP, USER);
    expect(statuses[0].error).toMatch(/invalid_grant/);
    expect(findRequests('POST', GATEWAY)).toHaveLength(0);
  });

  it('[MCP Auth / RFC 6750 §3.1] 403 insufficient_scope で求められたスコープを足して、交換し直す', async () => {
    setup({ insufficientScope: 'gateway:connect jira:write' });
    const first = await connectAll(APP, USER);
    await expect(first.tools.gateway__search.execute!({}, { toolCallId: '1', messages: [] } as never)).rejects.toThrow();
    await first.close();

    requests.length = 0;
    await connectAll(APP, USER);
    expect(tokenExchange().form.get('scope')).toBe('gateway:connect jira:write');
  });
});

describe('private_key_jwt（RFC 7523 §2.2・§3）', () => {
  it('[RFC 7523 §2.2・§3] AI エージェントの鍵で署名したクライアントアサーションで認証する（iss = sub = client_id、aud、exp、jti）', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    vi.stubEnv('OKTA_AI_AGENT_PRIVATE_KEY', JSON.stringify({ ...privateKey.export({ format: 'jwk' }), kid: 'agent-key', alg: 'RS256' }));
    vi.stubEnv('OKTA_CLIENT_SECRET', '');
    setup();
    await connectAll(APP, USER);

    for (const [req, endpoint] of [[tokenExchange(), ORG_TOKEN], [jwtBearer(), RESOURCE_TOKEN]] as const) {
      expect(req.headers.authorization).toBeUndefined();
      expect(req.form.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
      const assertion = req.form.get('client_assertion')!;
      const [header, payload, signature] = assertion.split('.');
      expect(decode(header)).toMatchObject({ alg: 'RS256', kid: 'agent-key' });

      const claims = decode(payload);
      expect(claims.iss).toBe('agent-app');
      expect(claims.sub).toBe('agent-app');
      expect(claims.aud).toBe(endpoint); // RFC 7523 §3（トークンエンドポイントの URL。Okta が求める形）
      expect(claims.exp).toBeGreaterThan(Date.now() / 1000);
      expect(claims.jti).toBeTruthy();

      const valid = verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url'));
      expect(valid).toBe(true);
    }
    // jti は使い捨て
    expect(decode(tokenExchange().form.get('client_assertion')!.split('.')[1]).jti).not.toBe(
      decode(jwtBearer().form.get('client_assertion')!.split('.')[1]).jti,
    );
  });
});

describe('認可サーバーの宣言', () => {
  it('[MCP EMA §6] ID-JAG への対応を宣言していない認可サーバーは記録に残す（交換は試みる）', async () => {
    // 宣言（authorization_grant_profiles_supported）の無いメタデータにする
    route('GET', `${ORG}/.well-known/openid-configuration`, () => [200, oidcMetadata(ORG, ORG_TOKEN)]);
    route('POST', ORG_TOKEN, () => [200, ID_JAG_RESPONSE]);
    route('GET', `${ORG}/.well-known/oauth-authorization-server/oauth2/aus1`, () => [200, oidcMetadata(RESOURCE_AS, RESOURCE_TOKEN)]);
    route('GET', `${RESOURCE_AS}/.well-known/openid-configuration`, () => [200, oidcMetadata(RESOURCE_AS, RESOURCE_TOKEN)]);
    route('POST', RESOURCE_TOKEN, () => [200, { access_token: 'xaa-access-token', token_type: 'Bearer', expires_in: 3600 }]);
    fakeProtectedResourceMetadata(PRM, { resource: GATEWAY, authorization_servers: [RESOURCE_AS] });
    fakeMcpServer({ url: GATEWAY, token: 'xaa-access-token' });

    const { statuses } = await connectAll(APP, USER);
    expect(statuses).toEqual([{ name: 'gateway', tools: 1 }]);
    const warned = vi.mocked(console.warn).mock.calls.map((c) => JSON.parse(c[0]));
    expect(warned).toContainEqual(expect.objectContaining({ event: 'xaa_profile_not_advertised', issuer: RESOURCE_AS }));
  });
});
