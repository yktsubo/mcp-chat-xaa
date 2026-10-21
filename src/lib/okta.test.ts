import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// openid-client の Issuer.discover と Client を置き換え、Okta に送る内容を確かめる
const grant = vi.fn();
const refresh = vi.fn();
const endSessionUrl = vi.fn((params: Record<string, string>) => `https://idp/logout?${new URLSearchParams(params)}`);
const Client = vi.fn(function (this: Record<string, unknown>, metadata: unknown, jwks: unknown) {
  Object.assign(this, { metadata, jwks, grant, refresh, endSessionUrl, issuer: { metadata: { token_endpoint: 'https://idp/token' } } });
});
const discover = vi.fn(async (issuer: string) => ({ issuer, Client }));
vi.mock('openid-client', () => ({ Issuer: { discover: (issuer: string) => discover(issuer) } }));

const authorizationServerMetadata = vi.fn();
vi.mock('./discovery', () => ({ authorizationServerMetadata: (i: string) => authorizationServerMetadata(i) }));

const { clearIssuerCache, clientCredentials, exchangeIdToken, logoutUrl, refreshLogin } = await import('./okta');

const KEY = { kty: 'RSA', kid: 'k1', alg: 'RS256', n: 'n', e: 'AQAB', d: 'd' };
const XAA = { issuer: 'https://idp.example.com/oauth2/x', resource: 'https://gw.example.com/mcp', scope: 'gateway:connect' };

beforeEach(() => {
  vi.stubEnv('OKTA_ISSUER', 'https://idp.example.com');
  vi.stubEnv('OKTA_CLIENT_ID', 'app');
  vi.stubEnv('OKTA_CLIENT_SECRET', 'secret');
  vi.stubEnv('OKTA_AI_AGENT_PRIVATE_KEY', '');
  vi.stubEnv('OKTA_AI_AGENT_ID', '');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  authorizationServerMetadata.mockResolvedValue({ authorization_grant_profiles_supported: ['urn:ietf:params:oauth:grant-profile:id-jag'] });
});

afterEach(() => {
  clearIssuerCache();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('clientCredentials', () => {
  it('uses the client secret when no private key is configured', () => {
    expect(clientCredentials('app')).toEqual({
      client: { client_id: 'app', client_secret: 'secret', token_endpoint_auth_method: 'client_secret_basic' },
    });
  });

  it('uses private_key_jwt with the AI agent key when it is configured', () => {
    vi.stubEnv('OKTA_AI_AGENT_PRIVATE_KEY', JSON.stringify(KEY));
    expect(clientCredentials('app')).toEqual({
      client: { client_id: 'app', token_endpoint_auth_method: 'private_key_jwt', token_endpoint_auth_signing_alg: 'RS256' },
      jwks: { keys: [KEY] },
    });
    vi.stubEnv('OKTA_AI_AGENT_PRIVATE_KEY', JSON.stringify({ ...KEY, alg: undefined }));
    expect(clientCredentials('app').client.token_endpoint_auth_signing_alg).toBe('RS256');
  });
});

describe('refreshLogin and logoutUrl', () => {
  it('refresh the login and build the RP-initiated logout URL with the Okta org issuer', async () => {
    refresh.mockResolvedValue({ id_token: 'new' });
    expect(await refreshLogin('rt')).toEqual({ id_token: 'new' });
    expect(refresh).toHaveBeenCalledWith('rt', { clientAssertionPayload: { aud: 'https://idp/token' } });

    expect(await logoutUrl('idt', 'https://app/')).toBe('https://idp/logout?id_token_hint=idt&post_logout_redirect_uri=https%3A%2F%2Fapp%2F');
    expect(await logoutUrl(undefined, 'https://app/')).toBe('https://idp/logout?post_logout_redirect_uri=https%3A%2F%2Fapp%2F');
    expect(discover).toHaveBeenCalledTimes(1); // メタデータは使い回す
    expect(discover).toHaveBeenCalledWith('https://idp.example.com');
  });

  it('discovers again after a failure', async () => {
    discover.mockRejectedValueOnce(new Error('offline'));
    await expect(refreshLogin('rt')).rejects.toThrow('offline');
    await refreshLogin('rt');
    expect(discover).toHaveBeenCalledTimes(2);
  });
});

describe('exchangeIdToken', () => {
  const idJag = { access_token: 'id-jag', issued_token_type: 'urn:ietf:params:oauth:token-type:id-jag', token_type: 'N_A' };

  it('exchanges the ID token for an ID-JAG, then for an access token, as the AI agent', async () => {
    vi.stubEnv('OKTA_AI_AGENT_ID', 'agent');
    grant.mockResolvedValueOnce(idJag).mockResolvedValueOnce({ access_token: 'at', expires_at: 123 });

    expect(await exchangeIdToken('idt', XAA)).toEqual({ access_token: 'at', expires_at: 123 });
    const audience = { clientAssertionPayload: { aud: 'https://idp/token' } };
    expect(grant).toHaveBeenNthCalledWith(
      1,
      {
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        requested_token_type: 'urn:ietf:params:oauth:token-type:id-jag',
        subject_token: 'idt',
        subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
        audience: XAA.issuer,
        resource: XAA.resource,
        scope: 'gateway:connect',
      },
      audience,
    );
    expect(grant).toHaveBeenNthCalledWith(2, { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: 'id-jag' }, audience);
    expect(discover.mock.calls.map((c) => c[0])).toEqual(['https://idp.example.com', XAA.issuer]);
    expect(Client.mock.calls.map((c) => (c[0] as { client_id: string }).client_id)).toEqual(['agent', 'agent']);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('acts as the login client when no AI agent ID is set, and omits an empty scope and a missing resource', async () => {
    grant.mockResolvedValueOnce(idJag).mockResolvedValueOnce({ access_token: 'at' });
    await exchangeIdToken('idt', { issuer: XAA.issuer, scope: '' });
    expect(grant.mock.calls[0][0]).not.toHaveProperty('scope');
    expect(grant.mock.calls[0][0]).not.toHaveProperty('resource');
    expect((Client.mock.calls[0][0] as { client_id: string }).client_id).toBe('app');
  });

  it('logs when the authorization server does not advertise ID-JAG, but still tries', async () => {
    authorizationServerMetadata.mockResolvedValue({});
    grant.mockResolvedValueOnce(idJag).mockResolvedValueOnce({ access_token: 'at' });
    await exchangeIdToken('idt', XAA);
    expect(JSON.parse(vi.mocked(console.warn).mock.calls[0][0])).toMatchObject({ event: 'xaa_profile_not_advertised', issuer: XAA.issuer });
  });

  it.each([
    [{ ...idJag, issued_token_type: 'urn:ietf:params:oauth:token-type:access_token' }],
    [{ ...idJag, token_type: 'Bearer' }],
    [{ ...idJag, token_type: undefined }],
    [{ ...idJag, access_token: undefined }],
  ])('refuses a token exchange response that is not an ID-JAG (%o)', async (response) => {
    grant.mockResolvedValueOnce(response);
    await expect(exchangeIdToken('idt', XAA)).rejects.toThrow(/Unexpected token exchange response/);
    expect(grant).toHaveBeenCalledTimes(1);
  });
});
