import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getServerSession = vi.fn();
vi.mock('next-auth', () => ({ getServerSession: (options: unknown) => getServerSession(options) }));
const refreshLogin = vi.fn();
vi.mock('./okta', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./okta')>()),
  refreshLogin: (token: string) => refreshLogin(token),
}));

const { authOptions, currentUser } = await import('./auth');

const now = () => Math.floor(Date.now() / 1000);

beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('authOptions', () => {
  it('signs in with Okta using PKCE, state and nonce, and asks for a refresh token', () => {
    const okta = authOptions.providers[0] as unknown as { id: string; options: Record<string, unknown> };
    expect(okta.id).toBe('okta');
    expect(okta.options.checks).toEqual(['pkce', 'state', 'nonce']);
    expect(okta.options.authorization).toEqual({ params: { scope: 'openid profile email offline_access' } });
  });

  it('keeps the username and Okta tokens from the sign-in', async () => {
    const token = await authOptions.callbacks!.jwt!({
      token: { sub: 'u1' },
      account: { id_token: 'idt', refresh_token: 'rt', expires_at: 100 },
      profile: { preferred_username: 'alice@example.com' },
    } as never);
    expect(token).toEqual({ sub: 'u1', username: 'alice@example.com', idToken: 'idt', refreshToken: 'rt', expiresAt: 100 });
  });

  it('keeps the tokens while they are fresh', async () => {
    const fresh = { sub: 'u1', idToken: 'idt', refreshToken: 'rt', expiresAt: now() + 600 };
    expect(await authOptions.callbacks!.jwt!({ token: fresh } as never)).toBe(fresh);
    expect(await authOptions.callbacks!.jwt!({ token: { sub: 'u1' } } as never)).toEqual({ sub: 'u1' });
    expect(refreshLogin).not.toHaveBeenCalled();
  });

  it('refreshes the tokens shortly before they expire', async () => {
    refreshLogin.mockResolvedValueOnce({ id_token: 'new-idt', refresh_token: 'new-rt', expires_at: 999 });
    const expiring = { sub: 'u1', idToken: 'idt', refreshToken: 'rt', expiresAt: now() + 30 };
    expect(await authOptions.callbacks!.jwt!({ token: expiring } as never)).toEqual({
      sub: 'u1',
      idToken: 'new-idt',
      refreshToken: 'new-rt',
      expiresAt: 999,
      error: undefined,
    });

    refreshLogin.mockResolvedValueOnce({ expires_at: 999 });
    expect(await authOptions.callbacks!.jwt!({ token: expiring } as never)).toMatchObject({ idToken: 'idt', refreshToken: 'rt' });
  });

  it('marks the session when the refresh is refused, without a refresh token there is nothing to do', async () => {
    refreshLogin.mockRejectedValue(new Error('invalid_grant'));
    const expired = { sub: 'u1', idToken: 'idt', refreshToken: 'rt', expiresAt: now() - 10 };
    expect(await authOptions.callbacks!.jwt!({ token: expired } as never)).toMatchObject({ error: 'RefreshFailed' });
    expect(JSON.parse(vi.mocked(console.warn).mock.calls[0][0])).toMatchObject({ event: 'login_refresh_failed', user: 'u1' });

    const noRefresh = { sub: 'u1', expiresAt: now() - 10 };
    expect(await authOptions.callbacks!.jwt!({ token: noRefresh } as never)).toBe(noRefresh);
  });

  it('gives the browser only the user ID and username', async () => {
    const session = await authOptions.callbacks!.session!({
      session: { user: { email: 'a@example.com' }, expires: '' },
      token: { sub: 'u1', username: 'alice', idToken: 'secret-idt', refreshToken: 'secret-rt' },
    } as never);
    expect(session).toEqual({ user: { email: 'a@example.com', id: 'u1', username: 'alice' }, expires: '' });
  });
});

describe('currentUser', () => {
  it('is undefined when nobody is signed in', async () => {
    getServerSession.mockResolvedValue(null);
    expect(await currentUser()).toBeUndefined();
    getServerSession.mockResolvedValue({ user: {} });
    expect(await currentUser()).toBeUndefined();
  });

  it.each([
    [{ id: 'u1', username: 'alice', email: 'a@example.com' }, 'alice'],
    [{ id: 'u1', email: 'a@example.com' }, 'a@example.com'],
    [{ id: 'u1' }, 'u1'],
  ])('shows the username, else the email, else the ID (%o)', async (user, name) => {
    getServerSession.mockResolvedValue({ user, idToken: 'idt' });
    expect(await currentUser()).toEqual({ id: 'u1', name, idToken: 'idt' });
  });

  it('reads the ID token on the server only, never refreshing there, and not after a failed refresh', async () => {
    getServerSession.mockResolvedValue(null);
    await currentUser();
    const options = getServerSession.mock.calls[0][0];
    const expiring = { sub: 'u1', idToken: 'idt', refreshToken: 'rt', expiresAt: now() + 30 };
    expect(await options.callbacks.jwt({ token: expiring })).toBe(expiring);
    expect(refreshLogin).not.toHaveBeenCalled();

    const session = { user: {}, expires: '' };
    expect(await options.callbacks.session({ session, token: { sub: 'u1', idToken: 'idt' } })).toMatchObject({ idToken: 'idt' });
    expect(await options.callbacks.session({ session, token: { sub: 'u1', idToken: 'idt', error: 'RefreshFailed' } })).toMatchObject({
      idToken: undefined,
    });
  });
});
