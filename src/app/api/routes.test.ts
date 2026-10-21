import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// API ルートのテスト。MCP の接続、認証、LLM はモックに置き換える
const currentUser = vi.fn();
vi.mock('@/lib/auth', () => ({ currentUser: () => currentUser(), authOptions: {} }));

const connectAll = vi.fn();
const load = vi.fn();
const deleteUserData = vi.fn();
vi.mock('@/lib/mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/mcp')>()),
  connectAll: (...args: unknown[]) => connectAll(...args),
  deleteUserData: (user: string) => deleteUserData(user),
  StoredOAuthProvider: { load: (...args: unknown[]) => load(...args) },
}));

const logoutUrl = vi.fn();
vi.mock('@/lib/okta', () => ({ logoutUrl: (...args: unknown[]) => logoutUrl(...args) }));

const checkChatLimit = vi.fn();
vi.mock('@/lib/ratelimit', () => ({ checkChatLimit: (user: string) => checkChatLimit(user) }));

const auth = vi.fn();
vi.mock('@ai-sdk/mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ai-sdk/mcp')>()),
  auth: (...args: unknown[]) => auth(...args),
}));

const streamText = vi.fn();
const convertToModelMessages = vi.fn(async () => [{ role: 'user', content: 'hi' }]);
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  streamText: (options: unknown) => streamText(options),
  convertToModelMessages: (...args: unknown[]) => convertToModelMessages(...(args as [])),
}));

const anthropicModel = vi.fn((id: string) => ({ provider: 'anthropic', id }));
const createAnthropic = vi.fn((_options?: unknown) => anthropicModel);
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: (options: unknown) => createAnthropic(options) }));
vi.mock('@ai-sdk/azure', () => ({ azure: (id: string) => ({ provider: 'azure', id }) }));

const chat = await import('./chat/route');
const status = await import('./mcp/route');
const connect = await import('./mcp/connect/route');
const callback = await import('./mcp/callback/route');
const logout = await import('./logout/route');
const clientMetadataDocument = await import('../oauth/client-metadata.json/route');

const GATEWAY = { name: 'gateway', label: 'Okta Agent Gateway', url: 'https://gw.example.com/mcp' };
const USER = { id: 'u1', name: 'alice', idToken: 'idt' };
// コールバックが使う StoredOAuthProvider の代わり（認可サーバーの情報は無い＝iss の確認は SDK に任せる）
const provider = () => ({ authorizationServerInformation: () => undefined });
const close = vi.fn(async () => []);

beforeEach(() => {
  vi.stubEnv('MCP_SERVERS', JSON.stringify([GATEWAY]));
  currentUser.mockResolvedValue(USER);
  checkChatLimit.mockResolvedValue({ success: true });
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const request = (path: string, init?: ConstructorParameters<typeof NextRequest>[1]) =>
  new NextRequest(`https://app.example.com${path}`, init);
const logged = (spy: unknown) => vi.mocked(spy as typeof console.error).mock.calls.map((c) => JSON.parse(c[0]));

describe('signed-out users', () => {
  it.each([
    ['chat', () => chat.POST(request('/api/chat', { method: 'POST', body: '{}' }))],
    ['status', () => status.GET(request('/api/mcp'))],
    ['connect', () => connect.GET(request('/api/mcp/connect?server=gateway'))],
  ])('cannot use %s', async (_, call) => {
    currentUser.mockResolvedValue(undefined);
    expect((await call()).status).toBe(401);
    expect(connectAll).not.toHaveBeenCalled();
  });
});

describe('GET /api/mcp', () => {
  it('returns each server status without authorization URLs', async () => {
    connectAll.mockResolvedValue({ statuses: [{ name: 'gateway', authorizeUrl: 'https://as/authorize' }], close });
    const res = await status.GET(request('/api/mcp'));
    expect(await res.json()).toEqual({ statuses: [{ name: 'gateway', label: 'Okta Agent Gateway', needsAuth: true }] });
    expect(connectAll).toHaveBeenCalledWith('https://app.example.com', USER);
    expect(close).toHaveBeenCalled();
  });
});

describe('GET /api/mcp/connect', () => {
  it('starts the authorization for the named server and redirects to it', async () => {
    connectAll.mockResolvedValue({ statuses: [{ name: 'gateway', authorizeUrl: 'https://as/authorize?x=1' }], close });
    const res = await connect.GET(request('/api/mcp/connect?server=gateway'));
    expect(connectAll).toHaveBeenCalledWith('https://app.example.com', USER, 'gateway');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://as/authorize?x=1');
  });

  it('goes back to the chat when nothing needs authorizing', async () => {
    connectAll.mockResolvedValue({ statuses: [], close });
    const res = await connect.GET(request('/api/mcp/connect'));
    expect(connectAll).toHaveBeenCalledWith('https://app.example.com', USER, '');
    expect(res.headers.get('location')).toBe('https://app.example.com/');
  });
});

describe('GET /api/mcp/callback', () => {
  it('exchanges the code, then tells the chat window and closes the tab', async () => {
    const stored = provider();
    load.mockResolvedValue(stored);
    const res = await callback.GET(request('/api/mcp/callback?code=c&state=gateway.s&iss=https%3A%2F%2Fas'));

    expect(load).toHaveBeenCalledWith(GATEWAY, 'https://app.example.com', 'u1');
    expect(auth).toHaveBeenCalledWith(stored, expect.objectContaining({
      serverUrl: GATEWAY.url,
      authorizationCode: 'c',
      callbackState: 'gateway.s',
      callbackIssuer: 'https://as',
    }));
    const html = await res.text();
    expect(html).toContain('Okta Agent Gateway に接続しました');
    expect(html).toContain('"type":"mcp-connected"');
    expect(logged(console.info)[0]).toMatchObject({ event: 'mcp_connected', server: 'gateway', user: 'u1' });
  });

  it('escapes the label in the page', async () => {
    vi.stubEnv('MCP_SERVERS', JSON.stringify([{ name: 'x', label: '<img src=x onerror=alert(1)>', url: 'https://x.example.com/mcp' }]));
    load.mockResolvedValue(provider());
    const html = await (await callback.GET(request('/api/mcp/callback?code=c&state=x.s'))).text();
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; に接続しました');
    expect(html).not.toContain('<img');
    expect(html).toContain('\\u003cimg');
  });

  it('names the server by its ID when it has no label', async () => {
    vi.stubEnv('MCP_SERVERS', JSON.stringify([{ name: 'notion', url: 'https://notion.example.com/mcp' }]));
    load.mockResolvedValue(provider());
    const res = await callback.GET(request('/api/mcp/callback?code=c&state=notion.s'));
    expect(await res.text()).toContain('notion に接続しました');
  });

  it('shows and logs why the exchange failed', async () => {
    load.mockResolvedValue(provider());
    auth.mockRejectedValue(new Error('The authorization code is invalid or has expired.'));
    const res = await callback.GET(request('/api/mcp/callback?code=c&state=gateway.s'));
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('invalid or has expired');
    expect(logged(console.error)[0]).toMatchObject({ event: 'mcp_oauth_callback_failed', server: 'gateway' });

    auth.mockRejectedValue('weird');
    expect(await (await callback.GET(request('/api/mcp/callback?code=c&state=gateway.s'))).text()).toContain('weird');
  });

  it.each([
    ['/api/mcp/callback?error=access_denied&error_description=denied&state=gateway.s', 'denied', 'access_denied'],
    ['/api/mcp/callback?code=c&state=other.s', '不正なコールバックです', 'unknown_state'],
    ['/api/mcp/callback?state=gateway.s', '不正なコールバックです', 'no_code'],
    ['/api/mcp/callback?code=c', '不正なコールバックです', 'unknown_state'],
  ])('rejects %s', async (path, message, error) => {
    const res = await callback.GET(request(path));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(message);
    expect(logged(console.warn)[0]).toMatchObject({ event: 'mcp_oauth_callback_rejected', error });
    expect(auth).not.toHaveBeenCalled();
  });

  it('rejects a callback without a signed-in user', async () => {
    currentUser.mockResolvedValue(undefined);
    expect((await callback.GET(request('/api/mcp/callback?code=c&state=gateway.s'))).status).toBe(400);
    expect(logged(console.warn)[0]).toMatchObject({ error: 'no_session' });
  });
});

describe('POST /api/chat', () => {
  const body = JSON.stringify({ messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] });

  beforeEach(() => {
    connectAll.mockResolvedValue({
      tools: { gateway__search: { description: 'search' } },
      statuses: [{ name: 'gateway', tools: 1 }, { name: 'notion', authorizeUrl: 'https://as/authorize' }],
      close,
    });
    streamText.mockReturnValue({ toUIMessageStreamResponse: () => new Response('stream') });
  });

  it('streams the reply with the MCP tools and connect tools', async () => {
    const res = await chat.POST(request('/api/chat', { method: 'POST', body }));
    expect(await res.text()).toBe('stream');

    const options = streamText.mock.calls[0][0];
    expect(Object.keys(options.tools)).toEqual(['gateway__search', 'notion__connect']);
    expect(options.model).toEqual({ provider: 'anthropic', id: 'claude-haiku-5-5' });
    expect(options.instructions).toContain('helpful assistant');
    expect(createAnthropic).toHaveBeenCalledWith({});
  });

  it('closes the MCP connections when the stream ends, aborts or fails', async () => {
    await chat.POST(request('/api/chat', { method: 'POST', body }));
    const options = streamText.mock.calls[0][0];
    options.onEnd();
    options.onAbort();
    options.onError({ error: new Error('overloaded') });
    expect(close).toHaveBeenCalledTimes(3);
    expect(logged(console.error)[0]).toMatchObject({ event: 'chat_failed', user: 'u1', error: 'Error: overloaded' });
  });

  it('logs failed tool calls, but not successful ones', async () => {
    await chat.POST(request('/api/chat', { method: 'POST', body }));
    const { onToolExecutionEnd } = streamText.mock.calls[0][0];
    onToolExecutionEnd({ toolCall: { toolName: 'gateway__search' }, toolOutput: { type: 'tool-result', output: 'ok' } });
    onToolExecutionEnd({ toolCall: { toolName: 'gateway__search' }, toolOutput: { type: 'tool-error', error: new Error('403') } });
    expect(logged(console.warn)).toEqual([expect.objectContaining({ event: 'tool_failed', tool: 'gateway__search', error: 'Error: 403' })]);
  });

  it('sends only an error summary to the browser', async () => {
    const toUIMessageStreamResponse = vi.fn((_options?: unknown) => new Response(''));
    streamText.mockReturnValue({ toUIMessageStreamResponse });
    await chat.POST(request('/api/chat', { method: 'POST', body }));
    const { onError } = toUIMessageStreamResponse.mock.calls[0][0] as unknown as { onError: (e: unknown) => string };
    expect(onError(new Error('rate limited'))).toBe('rate limited');
    expect(onError('?')).toBe('エラーが発生しました');
  });

  it('uses SYSTEM_PROMPT, ANTHROPIC_MODEL and ANTHROPIC_WORKSPACE_ID when set', async () => {
    vi.stubEnv('SYSTEM_PROMPT', 'Be brief.');
    vi.stubEnv('ANTHROPIC_MODEL', 'claude-sonnet-5-5');
    vi.stubEnv('ANTHROPIC_WORKSPACE_ID', 'wrkspc_x');
    await chat.POST(request('/api/chat', { method: 'POST', body }));
    const options = streamText.mock.calls[0][0];
    expect(options.instructions).toBe('Be brief.');
    expect(options.model).toEqual({ provider: 'anthropic', id: 'claude-sonnet-5-5' });
    expect(createAnthropic).toHaveBeenCalledWith({ headers: { 'anthropic-workspace-id': 'wrkspc_x' } });
  });

  it('refuses with 429 and Retry-After when the user sends too many messages', async () => {
    checkChatLimit.mockResolvedValue({ success: false, retryAfterSeconds: 42 });
    const res = await chat.POST(request('/api/chat', { method: 'POST', body }));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('42');
    expect((await res.json()).error).toContain('42 秒後');
    expect(checkChatLimit).toHaveBeenCalledWith('u1');
    expect(logged(console.warn)[0]).toMatchObject({ event: 'rate_limited', user: 'u1' });
    expect(connectAll).not.toHaveBeenCalled();
  });

  it('passes the signed-in user (with the ID token for XAA) to the MCP connections', async () => {
    await chat.POST(request('/api/chat', { method: 'POST', body }));
    expect(connectAll).toHaveBeenCalledWith('https://app.example.com', USER);
  });

  it('uses Azure OpenAI when AZURE_OPENAI_DEPLOYMENT is set', async () => {
    vi.stubEnv('AZURE_OPENAI_DEPLOYMENT', 'my-gpt');
    await chat.POST(request('/api/chat', { method: 'POST', body }));
    expect(streamText.mock.calls[0][0].model).toEqual({ provider: 'azure', id: 'my-gpt' });
  });
});

describe('POST /api/logout', () => {
  const post = (origin?: string) =>
    logout.POST(request('/api/logout', { method: 'POST', headers: origin ? { origin } : {} }));

  it('removes the MCP tokens and returns the Okta logout URL', async () => {
    logoutUrl.mockResolvedValue('https://idp/logout?id_token_hint=idt');
    const res = await post('https://app.example.com');
    expect(await res.json()).toEqual({ url: 'https://idp/logout?id_token_hint=idt' });
    expect(deleteUserData).toHaveBeenCalledWith('u1');
    expect(logoutUrl).toHaveBeenCalledWith('idt', 'https://app.example.com/');
    expect(logged(console.info)[0]).toMatchObject({ event: 'logout', user: 'u1' });
  });

  it('still signs out of the app when Okta cannot be reached', async () => {
    logoutUrl.mockRejectedValue(new Error('offline'));
    expect(await (await post('https://app.example.com')).json()).toEqual({ url: 'https://app.example.com/' });
    expect(logged(console.warn)[0]).toMatchObject({ event: 'okta_logout_url_failed' });
  });

  it('goes back to the app when nobody is signed in', async () => {
    currentUser.mockResolvedValue(undefined);
    expect(await (await post('https://app.example.com')).json()).toEqual({ url: 'https://app.example.com/' });
    expect(deleteUserData).not.toHaveBeenCalled();
  });

  it.each([undefined, 'https://evil.example.com'])('refuses requests from other sites (Origin: %s)', async (origin) => {
    expect((await post(origin)).status).toBe(403);
    expect(deleteUserData).not.toHaveBeenCalled();
  });
});

describe('GET /oauth/client-metadata.json', () => {
  it('publishes the CIMD document, whose URL is the client_id', async () => {
    const res = clientMetadataDocument.GET(request('/oauth/client-metadata.json'));
    expect(await res.json()).toEqual({
      client_id: 'https://app.example.com/oauth/client-metadata.json',
      client_name: 'MCP Chat',
      client_uri: 'https://app.example.com',
      redirect_uris: ['https://app.example.com/api/mcp/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
  });
});
