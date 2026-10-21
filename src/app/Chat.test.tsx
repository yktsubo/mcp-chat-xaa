// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// AI Elements の部品（ライブラリ）は単純な要素に置き換え、チャット画面のふるまいだけを確かめる
const responseProps: Record<string, unknown>[] = [];
vi.mock('@/components/ai-elements/conversation', () => ({
  Conversation: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ConversationContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ConversationScrollButton: () => null,
}));
vi.mock('@/components/ai-elements/message', () => ({
  Message: ({ from, children }: { from: string; children: ReactNode }) => <div data-from={from}>{children}</div>,
  MessageContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  MessageResponse: ({ children, ...props }: { children: ReactNode }) => {
    responseProps.push(props);
    return <div data-testid="markdown">{children}</div>;
  },
}));
vi.mock('@/components/ai-elements/prompt-input', () => ({
  PromptInput: ({ onSubmit, children }: { onSubmit: (m: { text: string }) => void; children: ReactNode }) => (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ text: (e.currentTarget.elements.namedItem('message') as HTMLTextAreaElement).value });
      }}
    >
      {children}
    </form>
  ),
  PromptInputTextarea: (props: { placeholder: string }) => <textarea name="message" {...props} />,
  PromptInputFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PromptInputSubmit: () => <button type="submit">送信</button>,
}));
vi.mock('@/components/ai-elements/tool', () => ({
  Tool: ({ children }: { children: ReactNode }) => <div data-testid="tool">{children}</div>,
  ToolHeader: ({ type, toolName, state }: { type: string; toolName?: string; state: string }) => (
    <div>{`${toolName ?? type} ${state}`}</div>
  ),
  ToolContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ToolInput: () => null,
  ToolOutput: () => null,
  getStatusBadge: (state: string) => <span>{state}</span>,
}));

const signIn = vi.fn();
const getSession = vi.fn(async () => ({}));
vi.mock('next-auth/react', () => ({
  signIn: (...args: unknown[]) => signIn(...args),
  getSession: () => getSession(),
  signOut: vi.fn(),
}));

const sendMessage = vi.fn();
let chatState: Record<string, unknown>;
let chatOptions: { onFinish: () => void };
vi.mock('@ai-sdk/react', () => ({
  useChat: (options: { onFinish: () => void }) => {
    chatOptions = options;
    return { sendMessage, stop: vi.fn(), status: 'ready', error: undefined, messages: [], ...chatState };
  },
}));

const { default: Chat, Login } = await import('./Chat');

const STATUSES = [
  { name: 'gateway', label: 'Okta Agent Gateway', tools: 22, needsAuth: false },
  { name: 'jira', label: 'Jira', tools: 5, needsAuth: false, stepUp: true },
  { name: 'notion', label: 'Notion', needsAuth: true },
  { name: 'broken', label: 'Broken', needsAuth: false, error: 'ECONNREFUSED' },
];
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  chatState = {};
  responseProps.length = 0;
  fetchMock = vi.fn(async () => Response.json({ statuses: STATUSES }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const text = (id: string, role: 'user' | 'assistant', value: string) => ({ id, role, parts: [{ type: 'text', text: value }] });

describe('Login', () => {
  it('signs in with Okta', () => {
    render(<Login />);
    fireEvent.click(screen.getByRole('button', { name: 'ログイン' }));
    expect(signIn).toHaveBeenCalledWith('okta');
  });
});

describe('Chat', () => {
  it('shows the chat right away and loads the MCP server status afterwards', async () => {
    render(<Chat />);
    expect(screen.getByText('確認中…')).toBeInTheDocument();
    expect(await screen.findByText('✅ 22 ツール')).toBeInTheDocument();
    expect(screen.getByText('未接続')).toBeInTheDocument();
    expect(screen.getByText('⚠️ ECONNREFUSED')).toBeInTheDocument();
    expect(screen.getByText('✅ 5 ツール（追加の権限が必要）')).toBeInTheDocument();
    expect(screen.getByText('まだありません')).toBeInTheDocument();
    // 状態の確認の前に、ログインのトークンを更新しておく（XAA の交換に使う）
    expect(getSession).toHaveBeenCalled();
  });

  it('shows no servers when the status cannot be read', async () => {
    fetchMock.mockResolvedValue(Response.json({}));
    render(<Chat />);
    await waitFor(() => expect(screen.queryByText('確認中…')).not.toBeInTheDocument());
  });

  it('renders replies as hardened Markdown', async () => {
    chatState.messages = [text('1', 'user', 'こんにちは'), text('2', 'assistant', '**どうぞ**')];
    render(<Chat />);
    await screen.findByText('✅ 22 ツール');
    expect(screen.getByText('こんにちは').closest('[data-from]')).toHaveAttribute('data-from', 'user');
    expect(screen.getByText('**どうぞ**').closest('[data-from]')).toHaveAttribute('data-from', 'assistant');

    const props = responseProps.at(-1) as { linkSafety: unknown; rehypePlugins: [unknown, [unknown, Record<string, unknown>]] };
    expect(props.linkSafety).toEqual({ enabled: true });
    expect(props.rehypePlugins[1][1]).toMatchObject({
      defaultOrigin: window.location.origin,
      allowedProtocols: ['https', 'http'],
      allowedImagePrefixes: [],
      allowDataImages: false,
    });
  });

  it('shows tool calls in the reply and in the recent tools panel', async () => {
    chatState.messages = [
      {
        id: '1',
        role: 'assistant',
        parts: [
          { type: 'step-start' },
          { type: 'dynamic-tool', toolName: 'gateway__searchJira', toolCallId: 'a', state: 'output-available', input: {}, output: 'ok' },
          { type: 'tool-notion__search', toolCallId: 'b', state: 'input-available', input: {} },
        ],
      },
    ];
    render(<Chat />);
    await screen.findByText('✅ 22 ツール');
    expect(screen.getAllByTestId('tool')).toHaveLength(2);
    expect(screen.getByText('gateway__searchJira output-available')).toBeInTheDocument();
    expect(screen.getByText('tool-notion__search input-available')).toBeInTheDocument();
    // 右パネル: 新しい順
    const recent = screen.getAllByTitle(/__/).map((el) => el.textContent);
    expect(recent).toEqual(['notion__search', 'gateway__searchJira']);
  });

  it('shows a connect button when the model asks to connect a server', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    chatState.messages = [
      {
        id: '1',
        role: 'assistant',
        parts: [
          { type: 'tool-notion__connect', toolCallId: 'a', state: 'input-available', input: {} },
          { type: 'tool-notion__connect', toolCallId: 'b', state: 'output-available', input: {}, output: '' },
          { type: 'tool-gateway__connect', toolCallId: 'c', state: 'output-available', input: {}, output: '' },
          { type: 'tool-unknown__connect', toolCallId: 'd', state: 'output-available', input: {}, output: '' },
        ],
      },
    ];
    render(<Chat />);
    await screen.findByText('✅ 22 ツール');

    fireEvent.click(screen.getByRole('button', { name: 'Notion に接続' }));
    expect(open).toHaveBeenCalledWith('/api/mcp/connect?server=notion', '_blank');
    expect(screen.getByRole('button', { name: 'Okta Agent Gateway: 接続済み' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'unknown に接続' })).toBeEnabled();
    expect(screen.getByText('まだありません')).toBeInTheDocument();
  });

  it('sends what the user typed, but not an empty message', async () => {
    render(<Chat />);
    const box = screen.getByPlaceholderText(/メッセージ/);
    fireEvent.submit(box.closest('form')!);
    expect(sendMessage).not.toHaveBeenCalled();

    fireEvent.change(box, { target: { value: 'Jira を探して' } });
    getSession.mockClear();
    fireEvent.submit(box.closest('form')!);
    expect(getSession).toHaveBeenCalled();
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ text: 'Jira を探して' }));
  });

  it('shows chat errors, taking the message out of API error responses', async () => {
    chatState.error = new Error('rate limited');
    const { unmount } = render(<Chat />);
    expect(screen.getByText('⚠️ rate limited')).toBeInTheDocument();
    unmount();

    chatState.error = new Error(JSON.stringify({ error: '回数の上限に達しました' }));
    const second = render(<Chat />);
    expect(screen.getByText('⚠️ 回数の上限に達しました')).toBeInTheDocument();
    second.unmount();

    chatState.error = new Error(JSON.stringify({ detail: 'x' }));
    render(<Chat />);
    expect(screen.getByText('⚠️ {"detail":"x"}')).toBeInTheDocument();
  });

  it('reloads the status after a reply, when a connection finishes, and when the window gets focus', async () => {
    render(<Chat />);
    await screen.findByText('✅ 22 ツール');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => chatOptions.onFinish());
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // 別のオリジンや別の種類のメッセージは無視する
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { origin: 'https://evil.example', data: { type: 'mcp-connected' } }));
      window.dispatchEvent(new MessageEvent('message', { origin: window.location.origin, data: { type: 'other' } }));
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await act(async () =>
      window.dispatchEvent(
        new MessageEvent('message', { origin: window.location.origin, data: { type: 'mcp-connected', server: 'notion', label: 'Notion' } }),
      ),
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(screen.getByText('✅ Notion に接続しました。もう一度依頼してください。')).toBeInTheDocument();

    // 次の送信でお知らせは消える
    fireEvent.change(screen.getByPlaceholderText(/メッセージ/), { target: { value: 'もう一度' } });
    fireEvent.submit(screen.getByPlaceholderText(/メッセージ/).closest('form')!);
    expect(screen.queryByText(/に接続しました/)).not.toBeInTheDocument();
  });

  it('stops listening when it is removed', async () => {
    const { unmount } = render(<Chat />);
    await screen.findByText('✅ 22 ツール');
    unmount();
    window.dispatchEvent(new Event('focus'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
