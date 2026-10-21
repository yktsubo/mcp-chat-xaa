// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ページ、レイアウト、ヘッダー、Next.js のフック
const currentUser = vi.fn();
vi.mock('@/lib/auth', () => ({ currentUser: () => currentUser(), authOptions: { providers: [] } }));
vi.mock('./Chat', () => ({ default: () => <p>chat</p>, Login: () => <p>login</p> }));
vi.mock('next/font/google', () => ({ Geist: () => ({ variable: 'font-geist' }) }));
const signOut = vi.fn(async (_options?: unknown) => undefined);
vi.mock('next-auth/react', () => ({ signOut: (options: unknown) => signOut(options) }));
const nextAuth = vi.fn((_options?: unknown) => 'handler');
vi.mock('next-auth', () => ({ default: (options: unknown) => nextAuth(options) }));

const { default: Home } = await import('./page');
const { default: RootLayout, metadata } = await import('./layout');
const { Header } = await import('@/components/Header');
const { onRequestError } = await import('@/instrumentation');
const nextAuthRoute = await import('./api/auth/[...nextauth]/route');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Home', () => {
  it('shows the chat and the username to a signed-in user', async () => {
    currentUser.mockResolvedValue({ id: 'u1', name: 'alice' });
    render(await Home());
    expect(screen.getByText('chat')).toBeInTheDocument();
    expect(screen.getByText('alice')).toBeInTheDocument();
  });

  it('asks everyone else to sign in', async () => {
    currentUser.mockResolvedValue(undefined);
    render(await Home());
    expect(screen.getByText('login')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ログアウト' })).not.toBeInTheDocument();
  });
});

describe('Header', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubLocation() {
    const location = { href: 'https://app.example.com/' };
    vi.stubGlobal('location', location);
    Object.defineProperty(window, 'location', { value: location, configurable: true });
    return location;
  }

  it('signs out of the app and then of Okta (RP-initiated logout)', async () => {
    const fetch = vi.fn(async () => Response.json({ url: 'https://idp/logout?id_token_hint=x' }));
    vi.stubGlobal('fetch', fetch);
    const location = stubLocation();

    render(<Header user="alice" />);
    expect(screen.getByRole('heading', { name: 'MCP Chat' })).toBeInTheDocument();
    expect(screen.getByText('alice')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ログアウト' }));

    await waitFor(() => expect(location.href).toBe('https://idp/logout?id_token_hint=x'));
    expect(fetch).toHaveBeenCalledWith('/api/logout', { method: 'POST' });
    expect(signOut).toHaveBeenCalledWith({ redirect: false });
  });

  it('still signs out of the app when the logout API fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('oops', { status: 500 })));
    const location = stubLocation();
    render(<Header user="alice" />);
    fireEvent.click(screen.getByRole('button', { name: 'ログアウト' }));
    await waitFor(() => expect(location.href).toBe('/'));
    expect(signOut).toHaveBeenCalled();
  });
});

describe('RootLayout', () => {
  it('renders the page in Japanese with the app title', () => {
    const html = renderToStaticMarkup(<RootLayout>content</RootLayout>);
    expect(html).toContain('lang="ja"');
    expect(html).toContain('font-geist');
    expect(html).toContain('content');
    expect(metadata.title).toBe('MCP Chat');
  });
});

describe('next-auth route', () => {
  it('serves sign-in for GET and POST', () => {
    expect(nextAuthRoute.GET).toBe('handler');
    expect(nextAuthRoute.POST).toBe('handler');
  });
});

describe('onRequestError', () => {
  it('logs unexpected server errors with the route', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    onRequestError(
      new Error('boom'),
      { path: '/api/chat', method: 'POST', headers: {} },
      { routerKind: 'App Router', routePath: '/api/chat', routeType: 'route', renderSource: undefined, revalidateReason: undefined } as never,
    );
    expect(JSON.parse(error.mock.calls[0][0])).toMatchObject({
      level: 'error',
      event: 'request_error',
      method: 'POST',
      path: '/api/chat',
      route: '/api/chat',
      routeType: 'route',
      error: 'Error: boom',
    });
  });
});
