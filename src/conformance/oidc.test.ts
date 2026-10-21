// ログイン（OpenID Connect）の準拠テスト。
// - OpenID Connect Core 1.0（認可コードフロー、ID トークンの検証）、OAuth 2.1 / RFC 7636（PKCE）
// - RFC 6749 §6（リフレッシュ）、OpenID Connect RP-Initiated Logout 1.0
// next-auth のログイン処理（AuthHandler）と openid-client を実際に動かし、偽の Okta が受け取ったリクエストを検査する。
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'crypto';
import { resolve } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findRequests, resetFakes, route, type Recorded } from './fakes';

// next-auth のログイン処理の本体（アプリの /api/auth/* のルートハンドラーが呼ぶ AuthHandler）。
// next-auth はこれを exports で公開していないので、ファイルのパスで読み込む
type AuthHandlerFn = (params: {
  req: Record<string, unknown>;
  options: unknown;
}) => Promise<{ status?: number; redirect?: string; body?: unknown; cookies?: { name: string; value: string }[] }>;
const coreModule = resolve(process.cwd(), 'node_modules/next-auth/core/index.js');

const ISSUER = 'https://idp.example.com';
const TOKEN = `${ISSUER}/oauth2/v1/token`;
const APP = 'https://app.example.com';
const CALLBACK = `${APP}/api/auth/callback/okta`;

const signingKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** 偽の Okta が発行する ID トークン（RS256 で署名） */
function idToken(claims: Record<string, unknown>, key: KeyObject = signingKey.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'RS256', kid: 'idp-key', typ: 'JWT' })}.${b64({ iss: ISSUER, aud: 'app-client', sub: 'user-1', iat: now, exp: now + 3600, ...claims })}`;
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), key).toString('base64url')}`;
}

/** 偽の Okta（Org 認可サーバー） */
function fakeOkta(token: (req: Recorded, nonce: string) => [number, unknown]) {
  route('GET', `${ISSUER}/.well-known/openid-configuration`, () => [
    200,
    {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/oauth2/v1/authorize`,
      token_endpoint: TOKEN,
      jwks_uri: `${ISSUER}/oauth2/v1/keys`,
      end_session_endpoint: `${ISSUER}/oauth2/v1/logout`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'private_key_jwt'],
    },
  ]);
  route('GET', `${ISSUER}/oauth2/v1/keys`, () => [
    200,
    { keys: [{ ...signingKey.publicKey.export({ format: 'jwk' }), kid: 'idp-key', alg: 'RS256', use: 'sig' }] },
  ]);
  route('POST', TOKEN, (req) => token(req, nonce));
}

let nonce = '';

type Result = { redirect?: string; cookies: { name: string; value: string }[] };

/** next-auth のログイン処理を、ブラウザの代わりに Cookie を引き継ぎながら呼ぶ */
async function signInFlow(env: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  const { AuthHandler } = (await import(coreModule)) as { AuthHandler: AuthHandlerFn };
  const { authOptions } = await import('@/lib/auth');
  // ルートハンドラー（NextAuth(...)）と同じく、NEXTAUTH_SECRET を鍵として渡す
  const options = { ...authOptions, secret: process.env.NEXTAUTH_SECRET };
  const jar = new Map<string, string>();

  async function call(action: string, init: { method?: string; body?: Record<string, string>; query?: Record<string, string> } = {}): Promise<Result & { body?: unknown }> {
    const res = await AuthHandler({
      req: {
        method: init.method ?? 'GET',
        action,
        providerId: action === 'csrf' ? undefined : 'okta',
        body: init.body,
        query: init.query ?? {},
        cookies: Object.fromEntries(jar),
        headers: { host: 'app.example.com' },
      },
      options,
    });
    const cookies = res.cookies ?? [];
    for (const c of cookies) jar.set(c.name, c.value);
    return { redirect: res.redirect, cookies, body: res.body };
  }

  const { csrfToken } = (await call('csrf')).body as { csrfToken: string };
  const signin = await call('signin', { method: 'POST', body: { csrfToken, callbackUrl: APP } });
  const authorize = new URL(signin.redirect!);
  nonce = authorize.searchParams.get('nonce') ?? '';
  return {
    authorize,
    callback: (query: Record<string, string>) => call('callback', { query }),
    authOptions,
  };
}

const ENV = {
  NEXTAUTH_URL: APP,
  NEXTAUTH_SECRET: 'test-secret-test-secret-test-secret-00',
  OKTA_ISSUER: ISSUER,
  OKTA_CLIENT_ID: 'app-client',
  OKTA_CLIENT_SECRET: 'app-secret',
  OKTA_AI_AGENT_PRIVATE_KEY: '',
};

const okTokens = (extra: Record<string, unknown> = {}) => (_: Recorded, n: string): [number, unknown] => [
  200,
  { access_token: 'at', token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt', id_token: idToken({ nonce: n, ...extra }) },
];

beforeEach(() => {
  resetFakes();
  for (const level of ['info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Authentication Request（OIDC Core §3.1.2.1 / RFC 7636）', () => {
  it('[OIDC Core §3.1.2.1 / RFC 7636 §4.3] 認可リクエストは response_type=code、scope=openid…、client_id、redirect_uri、state、nonce、S256 の code_challenge を持つ', async () => {
    fakeOkta(okTokens());
    const { authorize } = await signInFlow(ENV);
    expect(authorize.origin + authorize.pathname).toBe(`${ISSUER}/oauth2/v1/authorize`);
    expect(authorize.searchParams.get('response_type')).toBe('code');
    expect(authorize.searchParams.get('scope')!.split(' ')).toEqual(['openid', 'profile', 'email', 'offline_access']);
    expect(authorize.searchParams.get('client_id')).toBe('app-client');
    expect(authorize.searchParams.get('redirect_uri')).toBe(CALLBACK);
    expect(authorize.searchParams.get('state')).toBeTruthy();
    expect(authorize.searchParams.get('nonce')).toBeTruthy();
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('Token Request と ID トークンの検証（OIDC Core §3.1.3）', () => {
  it('[OIDC Core §3.1.3.1 / RFC 7636 §4.5] 認可コード、同じ redirect_uri、code_verifier（challenge と対応）を、クライアント認証付きで送り、ログインが成立する', async () => {
    fakeOkta(okTokens());
    const { authorize, callback } = await signInFlow(ENV);
    const res = await callback({ code: 'auth-code', state: authorize.searchParams.get('state')! });
    expect(res.redirect).toBe(APP);
    expect(res.cookies.some((c) => c.name.endsWith('next-auth.session-token') && c.value)).toBe(true);

    const [req] = findRequests('POST', TOKEN);
    expect(req.form.get('grant_type')).toBe('authorization_code');
    expect(req.form.get('code')).toBe('auth-code');
    expect(req.form.get('redirect_uri')).toBe(CALLBACK);
    expect(createHash('sha256').update(req.form.get('code_verifier')!).digest('base64url')).toBe(authorize.searchParams.get('code_challenge'));
    expect(req.headers.authorization).toBe(`Basic ${Buffer.from('app-client:app-secret').toString('base64')}`);
  });

  it('[RFC 7523 §2.2・§3] AI エージェントの鍵があれば、認可コードの交換も private_key_jwt（aud はトークンエンドポイント）で行う', async () => {
    const agent = generateKeyPairSync('rsa', { modulusLength: 2048 });
    fakeOkta(okTokens());
    const { authorize, callback } = await signInFlow({
      ...ENV,
      OKTA_CLIENT_SECRET: '',
      OKTA_AI_AGENT_PRIVATE_KEY: JSON.stringify({ ...agent.privateKey.export({ format: 'jwk' }), kid: 'agent', alg: 'RS256' }),
    });
    expect((await callback({ code: 'auth-code', state: authorize.searchParams.get('state')! })).redirect).toBe(APP);

    const [req] = findRequests('POST', TOKEN);
    expect(req.headers.authorization).toBeUndefined();
    expect(req.form.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    const claims = JSON.parse(Buffer.from(req.form.get('client_assertion')!.split('.')[1], 'base64url').toString());
    expect(claims).toMatchObject({ iss: 'app-client', sub: 'app-client', aud: TOKEN });
  });

  it.each([
    ['[失敗][OIDC Core §3.1.3.7 (11)] nonce が認可リクエストと違う', { nonce: 'forged' }],
    ['[失敗][OIDC Core §3.1.3.7 (3)] aud がこのクライアントでない', { aud: 'other-client' }],
    ['[失敗][OIDC Core §3.1.3.7 (2)] iss が Okta の issuer でない', { iss: 'https://evil.example.com' }],
    ['[失敗][OIDC Core §3.1.3.7 (9)] 期限切れ', { exp: Math.floor(Date.now() / 1000) - 600 }],
  ])('%s ID トークンは受け付けず、ログインさせない', async (_, claims) => {
    fakeOkta(okTokens(claims));
    const { authorize, callback } = await signInFlow(ENV);
    const res = await callback({ code: 'auth-code', state: authorize.searchParams.get('state')! });
    expect(findRequests('POST', TOKEN)).toHaveLength(1); // トークンまでは受け取り、ID トークンの検証で拒否している
    expect(res.redirect).toContain('/api/auth/error');
    expect(res.cookies.some((c) => c.name.endsWith('next-auth.session-token') && c.value)).toBe(false);
  });

  it('[失敗][OIDC Core §3.1.3.7 (6)] 署名が Okta の鍵で検証できない ID トークンは受け付けない', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    fakeOkta((_, n) => [200, { access_token: 'at', token_type: 'Bearer', id_token: idToken({ nonce: n }, other.privateKey) }]);
    const { authorize, callback } = await signInFlow(ENV);
    const res = await callback({ code: 'auth-code', state: authorize.searchParams.get('state')! });
    expect(findRequests('POST', TOKEN)).toHaveLength(1);
    expect(res.redirect).toContain('/api/auth/error');
  });

  it('[失敗][OAuth 2.1 §7.12 / RFC 6749 §10.12] state が一致しないコールバックでは、トークンを要求しない', async () => {
    fakeOkta(okTokens());
    const { callback } = await signInFlow(ENV);
    const res = await callback({ code: 'auth-code', state: 'forged' });
    expect(res.redirect).toContain('/api/auth/error');
    expect(findRequests('POST', TOKEN)).toHaveLength(0);
  });
});

describe('Refresh（RFC 6749 §6）', () => {
  it('[RFC 6749 §6] 期限が近い ID トークンは、grant_type=refresh_token とクライアント認証で更新する', async () => {
    fakeOkta(() => [200, { access_token: 'at2', token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt2', id_token: idToken({}) }]);
    const { authOptions } = await signInFlow(ENV);
    const expiring = { sub: 'user-1', idToken: 'old', refreshToken: 'rt1', expiresAt: Math.floor(Date.now() / 1000) + 10 };
    const refreshed = await authOptions.callbacks!.jwt!({ token: expiring } as never);

    const [req] = findRequests('POST', TOKEN);
    expect(req.form.get('grant_type')).toBe('refresh_token');
    expect(req.form.get('refresh_token')).toBe('rt1');
    expect(req.headers.authorization).toBe(`Basic ${Buffer.from('app-client:app-secret').toString('base64')}`);
    expect(refreshed).toMatchObject({ refreshToken: 'rt2', idToken: expect.stringMatching(/^ey/) });
  });

  it('[失敗][RFC 6749 §5.2] 更新が拒否されたら（invalid_grant）、セッションに失敗を記録する', async () => {
    fakeOkta(() => [400, { error: 'invalid_grant', error_description: 'revoked' }]);
    const { authOptions } = await signInFlow(ENV);
    const expiring = { sub: 'user-1', idToken: 'old', refreshToken: 'rt1', expiresAt: Math.floor(Date.now() / 1000) + 10 };
    expect(await authOptions.callbacks!.jwt!({ token: expiring } as never)).toMatchObject({ error: 'RefreshFailed' });
  });
});

describe('RP-Initiated Logout 1.0', () => {
  it('[RP-Initiated Logout §2] end_session_endpoint に id_token_hint、post_logout_redirect_uri、client_id を付ける', async () => {
    fakeOkta(okTokens());
    await signInFlow(ENV);
    const { logoutUrl } = await import('@/lib/okta');
    const url = new URL(await logoutUrl('the-id-token', `${APP}/`));
    expect(url.origin + url.pathname).toBe(`${ISSUER}/oauth2/v1/logout`);
    expect(url.searchParams.get('id_token_hint')).toBe('the-id-token');
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe(`${APP}/`);
    expect(url.searchParams.get('client_id')).toBe('app-client');
  });
});
