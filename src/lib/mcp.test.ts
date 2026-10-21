import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createMCPClient = vi.fn();
const auth = vi.fn();
vi.mock('@ai-sdk/mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ai-sdk/mcp')>()),
  createMCPClient: (config: unknown) => createMCPClient(config),
  auth: (...args: unknown[]) => auth(...args),
}));

const resourceInfo = vi.fn();
const authorizationServerFor = vi.fn();
const authorizationServerMetadata = vi.fn();
vi.mock('./discovery', () => ({
  resourceInfo: (...a: unknown[]) => resourceInfo(...a),
  authorizationServerFor: (...a: unknown[]) => authorizationServerFor(...a),
  authorizationServerMetadata: (...a: unknown[]) => authorizationServerMetadata(...a),
}));

const exchangeIdToken = vi.fn();
vi.mock('./okta', () => ({ exchangeIdToken: (...a: unknown[]) => exchangeIdToken(...a) }));

const { UnauthorizedError } = await import('@ai-sdk/mcp');
const { MemoryStore, setStore } = await import('./store');
const mcp = await import('./mcp');
const { StoredOAuthProvider, connectAll, connectTools, createMcpFetch, mcpFetch, mcpServers, publicStatuses } = mcp;

const GATEWAY = {
  name: 'gateway',
  label: 'Okta Agent Gateway',
  url: 'https://gw.example.com/mcp',
  description: 'Jira',
  auth: 'xaa',
  issuer: 'https://idp.example.com/oauth2/x',
  scope: 'gateway:connect',
};
const NOTION = { name: 'notion', url: 'https://notion.example.com/mcp' };
const PREREGISTERED = { name: 'pre', url: 'https://pre.example.com/mcp', client_id: 'cid', client_secret: 'secret', issuer: 'https://as' };
const HTTPS = 'https://app.example.com';
const LOCAL = 'http://localhost:3000';
const USER = { id: 'u1', idToken: 'id-token' };
const now = () => Math.floor(Date.now() / 1000);

let store: InstanceType<typeof MemoryStore>;

beforeEach(() => {
  store = new MemoryStore();
  setStore(store);
  vi.stubEnv('MCP_SERVERS', JSON.stringify([GATEWAY, NOTION, PREREGISTERED]));
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  resourceInfo.mockResolvedValue({ resource: GATEWAY.url, authorizationServers: [GATEWAY.issuer] });
  authorizationServerFor.mockResolvedValue('https://as.example.com');
  authorizationServerMetadata.mockResolvedValue({ client_id_metadata_document_supported: false });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  createMCPClient.mockReset();
  auth.mockReset();
  exchangeIdToken.mockReset();
});

const logged = (spy: unknown) => vi.mocked(spy as typeof console.info).mock.calls.map((c) => JSON.parse(c[0]));
const client = (tools: Record<string, unknown> = {}) => ({ tools: vi.fn(async () => tools), close: vi.fn(async () => {}) });

describe('mcpServers', () => {
  it('reads MCP_SERVERS, or nothing when it is unset', () => {
    expect(mcpServers().map((s) => s.name)).toEqual(['gateway', 'notion', 'pre']);
    vi.stubEnv('MCP_SERVERS', '');
    expect(mcpServers()).toEqual([]);
  });
});

describe('clientMetadata', () => {
  it('describes this app as an OAuth client, for registration and its CIMD document', () => {
    expect(mcp.clientMetadata(HTTPS)).toEqual({
      client_name: 'MCP Chat',
      client_uri: HTTPS,
      redirect_uris: [`${HTTPS}/api/mcp/callback`],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
    expect(mcp.clientMetadataDocumentUrl(HTTPS)).toBe(`${HTTPS}/oauth/client-metadata.json`);
  });
});

describe('StoredOAuthProvider', () => {
  it('uses the pre-registered client first, bound to its authorization server', async () => {
    const provider = await StoredOAuthProvider.load(PREREGISTERED, HTTPS, 'u1');
    expect(provider.clientInformation()).toEqual({ client_id: 'cid', client_secret: 'secret', issuer: 'https://as' });
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe('client_secret_basic');
    expect(provider.isClientInformationDynamicallyRegistered()).toBe(false);
    expect(provider.redirectUrl).toBe(`${HTTPS}/api/mcp/callback`);
  });

  it('then a client it registered before', async () => {
    await store.set('mcp:u1:notion', { client: { client_id: 'dyn' } });
    const provider = await StoredOAuthProvider.load(NOTION, HTTPS, 'u1');
    expect(provider.clientInformation()).toEqual({ client_id: 'dyn' });
    expect(provider.isClientInformationDynamicallyRegistered()).toBe(true);
    expect(authorizationServerMetadata).not.toHaveBeenCalled();
  });

  it('then CIMD, when the authorization server supports it and the app is on https', async () => {
    authorizationServerMetadata.mockResolvedValue({ client_id_metadata_document_supported: true });
    const provider = await StoredOAuthProvider.load(NOTION, HTTPS, 'u1');
    expect(authorizationServerFor).toHaveBeenCalledWith(NOTION.url, undefined);
    // SDK が求めるとおり、使う認可サーバーと結び付ける
    expect(provider.clientInformation()).toEqual({ client_id: `${HTTPS}/oauth/client-metadata.json`, issuer: 'https://as.example.com' });
    expect(provider.isClientInformationDynamicallyRegistered()).toBe(false);

    // ローカル（http）では認可サーバーが文書を取得できないので使わない
    expect((await StoredOAuthProvider.load(NOTION, LOCAL, 'u1')).clientInformation()).toBeUndefined();
  });

  it('and finally leaves dynamic registration to the SDK, as a public client', async () => {
    expect((await StoredOAuthProvider.load(NOTION, HTTPS, 'u1')).clientInformation()).toBeUndefined();
    expect((await StoredOAuthProvider.load(NOTION, HTTPS, 'u1')).clientMetadata.token_endpoint_auth_method).toBe('none');
    authorizationServerFor.mockRejectedValue(new Error('no metadata'));
    expect((await StoredOAuthProvider.load(NOTION, HTTPS, 'u1')).clientInformation()).toBeUndefined();

    const provider = await StoredOAuthProvider.load(NOTION, LOCAL, 'u1');
    await provider.saveClientInformation({ client_id: 'dyn' });
    expect((await StoredOAuthProvider.load(NOTION, LOCAL, 'u1')).clientInformation()).toEqual({ client_id: 'dyn' });
    expect((await StoredOAuthProvider.load(NOTION, LOCAL, 'u2')).clientInformation()).toBeUndefined();
  });

  it('saves state and PKCE only when the user started the connection', async () => {
    const checking = await StoredOAuthProvider.load(NOTION, LOCAL, 'u1');
    await checking.saveState('notion.old');
    await checking.saveCodeVerifier('old');
    expect(await store.get('mcp:u1:notion')).toEqual({});

    const connecting = await StoredOAuthProvider.load(NOTION, LOCAL, 'u1', true);
    const state = connecting.state();
    expect(state).toMatch(/^notion\.[0-9a-f-]{36}$/);
    await connecting.saveState(state);
    await connecting.saveCodeVerifier('verifier');

    const callback = await StoredOAuthProvider.load(NOTION, LOCAL, 'u1');
    expect(callback.storedState()).toBe(state);
    expect(callback.codeVerifier()).toBe('verifier');
  });

  it('remembers the authorization server between the start and the callback', async () => {
    const info = { authorizationServerUrl: 'https://as', tokenEndpoint: 'https://as/token' };
    await (await StoredOAuthProvider.load(NOTION, LOCAL, 'u1')).saveAuthorizationServerInformation(info);
    expect((await StoredOAuthProvider.load(NOTION, LOCAL, 'u1')).authorizationServerInformation()).toEqual(info);
  });

  it('stores tokens without the ID token, and clears the pending authorization and step-up', async () => {
    await store.set('mcp:u1:notion', { stepUpScope: 'write' });
    const provider = await StoredOAuthProvider.load(NOTION, LOCAL, 'u1', true);
    expect(provider.stepUpScope).toBe('write');
    await provider.saveState('notion.s');
    await provider.saveCodeVerifier('v');
    await provider.saveTokens({ access_token: 'at', token_type: 'Bearer', refresh_token: 'rt', id_token: 'idt' });

    expect(provider.tokens()).toEqual({ access_token: 'at', token_type: 'Bearer', refresh_token: 'rt' });
    expect(await store.get('mcp:u1:notion')).toEqual({ tokens: { access_token: 'at', token_type: 'Bearer', refresh_token: 'rt' } });
    expect(provider.codeVerifier()).toBe('');
    expect(provider.stepUpScope).toBeUndefined();

    provider.hideTokens();
    expect(provider.tokens()).toBeUndefined();
  });

  it('forgets credentials the server rejected', async () => {
    const provider = await StoredOAuthProvider.load(NOTION, LOCAL, 'u1', true);
    await provider.saveClientInformation({ client_id: 'dyn' });
    await provider.saveTokens({ access_token: 'at', token_type: 'Bearer' });
    await provider.saveCodeVerifier('v');

    await provider.invalidateCredentials('tokens');
    expect(provider.tokens()).toBeUndefined();
    expect(provider.clientInformation()).toEqual({ client_id: 'dyn' });

    await provider.invalidateCredentials('all');
    expect(await store.get('mcp:u1:notion')).toEqual({});
  });

  it('hands the authorization URL back to the caller instead of redirecting', async () => {
    const provider = await StoredOAuthProvider.load(NOTION, LOCAL, 'u1');
    provider.redirectToAuthorization(new URL('https://as/authorize?x=1'));
    expect(provider.authorizationUrl?.toString()).toBe('https://as/authorize?x=1');
  });
});

describe('createMcpFetch', () => {
  it('passes successful responses through untouched', async () => {
    const ok = new Response('ok');
    vi.stubGlobal('fetch', vi.fn(async () => ok));
    expect(await mcpFetch('https://as/token')).toBe(ok);
  });

  it('rewraps errors as a standard Response and logs token endpoint failures', async () => {
    const body = JSON.stringify({ error: 'invalid_grant' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 400, statusText: 'Bad Request' })));

    const res = await mcpFetch(new Request('https://as/token?x=1', { method: 'POST' }));
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(body);
    expect(logged(console.error)[0]).toMatchObject({ event: 'oauth_token_request_failed', url: 'https://as/token', status: 400 });

    vi.mocked(console.error).mockClear();
    await mcpFetch('https://gw.example.com/mcp');
    expect(console.error).not.toHaveBeenCalled();
  });

  it('reports the scopes asked for in a 403 insufficient_scope challenge', async () => {
    const challenge = (header: string) =>
      new Response('', { status: 403, headers: { 'WWW-Authenticate': header } });
    const onInsufficientScope = vi.fn(async () => {});
    const fetchFn = createMcpFetch(onInsufficientScope);

    vi.stubGlobal('fetch', vi.fn(async () => challenge('Bearer error="insufficient_scope", scope="files:read files:write"')));
    expect((await fetchFn('https://gw.example.com/mcp')).status).toBe(403);
    expect(onInsufficientScope).toHaveBeenCalledWith('files:read files:write');
    expect(logged(console.info)[0]).toMatchObject({ event: 'mcp_insufficient_scope', scope: 'files:read files:write' });

    onInsufficientScope.mockClear();
    vi.stubGlobal('fetch', vi.fn(async () => challenge('Bearer error="invalid_token"')));
    await fetchFn('https://gw.example.com/mcp');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));
    await fetchFn('https://gw.example.com/mcp');
    expect(onInsufficientScope).not.toHaveBeenCalled();
  });
});

describe('connectAll with OAuth servers', () => {
  beforeEach(() => vi.stubEnv('MCP_SERVERS', JSON.stringify([NOTION])));

  it('collects tools as <server>__<tool> and closes the clients', async () => {
    const notion = client({ search: { description: 'search' } });
    createMCPClient.mockResolvedValue(notion);

    const result = await connectAll(LOCAL, USER);
    expect(Object.keys(result.tools)).toEqual(['notion__search']);
    expect(result.statuses).toEqual([{ name: 'notion', tools: 1 }]);
    expect(createMCPClient.mock.calls[0][0].transport).toMatchObject({ type: 'http', url: NOTION.url });

    await result.close();
    expect(notion.close).toHaveBeenCalled();
  });

  it('returns the authorization URL when the server is not connected yet', async () => {
    createMCPClient.mockImplementation(async ({ transport }) => {
      transport.authProvider.redirectToAuthorization(new URL('https://notion.example.com/authorize'));
      throw new UnauthorizedError();
    });
    expect((await connectAll(LOCAL, USER)).statuses).toEqual([{ name: 'notion', authorizeUrl: 'https://notion.example.com/authorize' }]);
  });

  it('reports servers that cannot be reached, and logs all but plain 401s', async () => {
    createMCPClient.mockRejectedValueOnce(new Error('ECONNREFUSED')).mockRejectedValueOnce(new UnauthorizedError());
    expect((await connectAll(LOCAL, USER)).statuses).toEqual([{ name: 'notion', error: 'ECONNREFUSED' }]);
    expect(logged(console.warn)[0]).toMatchObject({ event: 'mcp_connect_failed', server: 'notion' });

    vi.mocked(console.warn).mockClear();
    expect((await connectAll(LOCAL, USER)).statuses[0].error).toBeDefined();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('connects only the named server, and only then lets it start an authorization', async () => {
    createMCPClient.mockImplementation(async ({ transport }) => {
      await transport.authProvider.saveState('notion.s');
      throw new UnauthorizedError();
    });
    vi.stubEnv('MCP_SERVERS', JSON.stringify([NOTION, PREREGISTERED]));
    await connectAll(LOCAL, USER, 'notion');
    expect(createMCPClient).toHaveBeenCalledTimes(1);
    expect(await store.get('mcp:u1:notion')).toEqual({ state: 'notion.s' });
  });

  it('remembers a 403 insufficient_scope, and offers to grant the extra permission', async () => {
    createMCPClient.mockImplementation(async ({ transport }) => {
      // ツールの呼び出しで 403 が返った、という状況を再現する
      vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403, headers: { 'WWW-Authenticate': 'Bearer error="insufficient_scope", scope="write"' } })));
      await transport.fetch('https://notion.example.com/mcp');
      return client();
    });
    await connectAll(LOCAL, USER);
    expect(await store.get('mcp:u1:notion')).toEqual({ stepUpScope: 'write' });

    createMCPClient.mockResolvedValue(client({ search: {} }));
    expect((await connectAll(LOCAL, USER)).statuses).toEqual([{ name: 'notion', tools: 1, stepUp: true }]);
  });

  it('re-authorizes with the asked-for scopes when the user presses connect (step-up)', async () => {
    await store.set('mcp:u1:notion', { tokens: { access_token: 'old', token_type: 'Bearer' }, stepUpScope: 'read write' });
    auth.mockImplementation(async (provider) => {
      expect(provider.tokens()).toBeUndefined(); // 手元のトークンでは済ませず、認可から始める
      provider.redirectToAuthorization(new URL('https://as/authorize?scope=read+write'));
      return 'REDIRECT';
    });

    const result = await connectAll(LOCAL, USER, 'notion');
    expect(auth).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ serverUrl: NOTION.url, scope: 'read write' }));
    expect(result.statuses).toEqual([{ name: 'notion', authorizeUrl: 'https://as/authorize?scope=read+write' }]);
    expect(createMCPClient).not.toHaveBeenCalled();
  });

  it('connects normally when the step-up needs no redirect', async () => {
    await store.set('mcp:u1:notion', { stepUpScope: 'write' });
    auth.mockResolvedValue('AUTHORIZED');
    createMCPClient.mockResolvedValue(client());
    expect((await connectAll(LOCAL, USER, 'notion')).statuses).toEqual([{ name: 'notion', tools: 0, stepUp: true }]);
  });
});

describe('connectAll with XAA servers', () => {
  beforeEach(() => vi.stubEnv('MCP_SERVERS', JSON.stringify([GATEWAY])));
  const issued = (token: string) => ({ access_token: token, expires_at: now() + 3600 });

  it('exchanges the ID token with the authorization server confirmed by the metadata, without resource by default', async () => {
    exchangeIdToken.mockResolvedValue(issued('xaa-token'));
    createMCPClient.mockResolvedValue(client({ searchJira: {} }));

    const result = await connectAll(LOCAL, USER);
    expect(resourceInfo).toHaveBeenCalledWith(GATEWAY.url);
    expect(authorizationServerFor).toHaveBeenCalledWith(GATEWAY.url, GATEWAY.issuer);
    expect(exchangeIdToken).toHaveBeenCalledWith('id-token', { issuer: 'https://as.example.com', scope: 'gateway:connect' });
    expect(createMCPClient.mock.calls[0][0].transport).toMatchObject({ url: GATEWAY.url, headers: { Authorization: 'Bearer xaa-token' } });
    expect(result.statuses).toEqual([{ name: 'gateway', tools: 1 }]);
  });

  it('adds resource (the MCP server identifier from the metadata) when xaa_resource is set', async () => {
    vi.stubEnv('MCP_SERVERS', JSON.stringify([{ ...GATEWAY, xaa_resource: true }]));
    exchangeIdToken.mockResolvedValue(issued('xaa-token'));
    createMCPClient.mockResolvedValue(client());
    await connectAll(LOCAL, USER);
    expect(exchangeIdToken).toHaveBeenCalledWith('id-token', expect.objectContaining({ resource: GATEWAY.url }));
  });

  it('reuses the token until shortly before it expires', async () => {
    await store.set('mcp:u1:gateway', { tokens: { access_token: 'cached', expires_at: now() + 3600 } });
    createMCPClient.mockResolvedValue(client());
    await connectAll(LOCAL, { id: 'u1' });
    expect(exchangeIdToken).not.toHaveBeenCalled();
    expect(createMCPClient.mock.calls[0][0].transport.headers).toEqual({ Authorization: 'Bearer cached' });

    await store.set('mcp:u1:gateway', { tokens: { access_token: 'cached', expires_at: now() + 30 } });
    exchangeIdToken.mockResolvedValue(issued('fresh'));
    await connectAll(LOCAL, USER);
    expect(exchangeIdToken).toHaveBeenCalledTimes(1);
  });

  it('does not trust a cached token without an expiry', async () => {
    await store.set('mcp:u1:gateway', { tokens: { access_token: 'cached' } });
    exchangeIdToken.mockResolvedValue(issued('fresh'));
    createMCPClient.mockResolvedValue(client());
    await connectAll(LOCAL, USER);
    expect(createMCPClient.mock.calls[0][0].transport.headers).toEqual({ Authorization: 'Bearer fresh' });
  });

  it('asks only for the challenged scopes when the server has none configured', async () => {
    vi.stubEnv('MCP_SERVERS', JSON.stringify([{ ...GATEWAY, scope: undefined }]));
    await store.set('mcp:u1:gateway', { stepUpScope: 'jira:write' });
    exchangeIdToken.mockResolvedValue(issued('t'));
    createMCPClient.mockResolvedValue(client());
    await connectAll(LOCAL, USER);
    expect(exchangeIdToken).toHaveBeenCalledWith('id-token', expect.objectContaining({ scope: 'jira:write' }));
  });

  it('asks to sign in again when there is no ID token', async () => {
    expect((await connectAll(LOCAL, { id: 'u1' })).statuses[0].error).toContain('ログインし直してください');
  });

  it('logs and reports exchanges that Okta refuses', async () => {
    exchangeIdToken.mockRejectedValue(new Error('invalid_target'));
    expect((await connectAll(LOCAL, USER)).statuses).toEqual([{ name: 'gateway', error: 'invalid_target' }]);
    expect(logged(console.error)[0]).toMatchObject({ event: 'xaa_exchange_failed', server: 'gateway', scope: 'gateway:connect' });
  });

  it('drops a token the MCP server rejects, so the next request exchanges again', async () => {
    exchangeIdToken.mockResolvedValue(issued('bad'));
    createMCPClient.mockRejectedValue(new Error('HTTP 401'));
    await connectAll(LOCAL, USER);
    expect((await store.get('mcp:u1:gateway')).tokens).toBeUndefined();
  });

  it('adds the scopes asked for by insufficient_scope, and falls back when Okta refuses them', async () => {
    createMCPClient.mockResolvedValue(client());
    await store.set('mcp:u1:gateway', { tokens: { access_token: 'cached', expires_at: now() + 3600 }, stepUpScope: 'jira:write' });
    exchangeIdToken.mockResolvedValueOnce(issued('wider'));
    await connectAll(LOCAL, USER);
    expect(exchangeIdToken).toHaveBeenLastCalledWith('id-token', expect.objectContaining({ scope: 'gateway:connect jira:write' }));
    expect(await store.get('mcp:u1:gateway')).toEqual({ tokens: expect.objectContaining({ access_token: 'wider' }) });

    // 拒否されたら、まだ使えるトークンで続ける
    await store.set('mcp:u1:gateway', { stepUpScope: 'admin' });
    exchangeIdToken.mockRejectedValueOnce(new Error('access_denied'));
    await connectAll(LOCAL, USER);
    expect(logged(console.warn).at(-1)).toMatchObject({ event: 'xaa_step_up_denied', scope: 'gateway:connect admin' });
    expect(createMCPClient.mock.calls.at(-1)![0].transport.headers).toEqual({ Authorization: 'Bearer wider' });

    // 使えるトークンが無ければ、元のスコープで交換し直す
    await store.set('mcp:u1:gateway', { tokens: { access_token: 'old', expires_at: now() - 10 }, stepUpScope: 'admin' });
    exchangeIdToken.mockRejectedValueOnce(new Error('access_denied')).mockResolvedValueOnce(issued('base'));
    await connectAll(LOCAL, USER);
    expect(exchangeIdToken).toHaveBeenLastCalledWith('id-token', expect.objectContaining({ scope: 'gateway:connect' }));
  });

  it('requests no scope when none is configured', async () => {
    vi.stubEnv('MCP_SERVERS', JSON.stringify([{ ...GATEWAY, scope: undefined }]));
    exchangeIdToken.mockResolvedValue(issued('t'));
    createMCPClient.mockResolvedValue(client());
    await connectAll(LOCAL, USER);
    expect(exchangeIdToken).toHaveBeenCalledWith('id-token', expect.objectContaining({ scope: '' }));
  });
});

describe('connectTools', () => {
  it('offers a connect tool for servers that need connecting or more permission', async () => {
    const tools = connectTools([
      { name: 'gateway', tools: 3 },
      { name: 'gateway', authorizeUrl: 'https://as/authorize' },
      { name: 'notion', tools: 1, stepUp: true },
      { name: 'unknown', authorizeUrl: 'https://as/authorize' },
    ]);
    expect(Object.keys(tools)).toEqual(['gateway__connect', 'notion__connect', 'unknown__connect']);
    expect(tools.gateway__connect.description).toContain('Connect the "gateway" MCP server (Jira)');
    expect(tools.notion__connect.description).toContain('additional permission');
    expect(tools.unknown__connect.description).toContain('(unknown)');

    const run = (name: string) => tools[name].execute!({}, { toolCallId: '1', messages: [] } as never);
    expect(await run('gateway__connect')).toContain('Okta Agent Gateway に接続');
    expect(await run('unknown__connect')).toContain('unknown に接続');
  });
});

describe('publicStatuses', () => {
  it('hides authorization URLs and adds display labels', () => {
    expect(
      publicStatuses([
        { name: 'gateway', tools: 2 },
        { name: 'notion', authorizeUrl: 'https://as/authorize' },
      ]),
    ).toEqual([
      { name: 'gateway', label: 'Okta Agent Gateway', tools: 2, needsAuth: false },
      { name: 'notion', label: 'notion', needsAuth: true },
    ]);
  });
});

describe('deleteUserData', () => {
  it('removes everything stored for the user, and nothing for others', async () => {
    await store.set('mcp:u1:gateway', { tokens: { access_token: 'a' } });
    await store.set('mcp:u1:notion', { client: { client_id: 'c' } });
    await store.set('mcp:u2:notion', { client: { client_id: 'c' } });
    await mcp.deleteUserData('u1');
    expect(await store.get('mcp:u1:gateway')).toEqual({});
    expect(await store.get('mcp:u1:notion')).toEqual({});
    expect(await store.get('mcp:u2:notion')).toEqual({ client: { client_id: 'c' } });
  });
});
