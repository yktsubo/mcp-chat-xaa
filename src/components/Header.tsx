'use client';

import { signOut } from 'next-auth/react';

// ログアウト: MCP のトークンを消して Okta のログアウト URL を受け取り、アプリのセッションを消してから Okta へ移る
async function logout() {
  const res = await fetch('/api/logout', { method: 'POST' });
  const { url } = (await res.json().catch(() => ({}))) as { url?: string };
  await signOut({ redirect: false });
  window.location.href = url ?? '/';
}

// アプリ名、ログイン中のユーザー名、ログアウトボタン
export function Header({ user }: { user?: string }) {
  return (
    <header className="flex shrink-0 items-center justify-between gap-4 border-b-4 border-indigo-500 bg-gradient-to-r from-slate-950 via-slate-900 to-indigo-950 px-6 py-3 text-white">
      <h1 className="text-lg font-semibold">MCP Chat</h1>
      {user && (
        <div className="flex items-center gap-3 text-sm">
          <span className="hidden text-white/80 sm:block">{user}</span>
          <button
            onClick={() => void logout()}
            className="rounded-md border border-white/25 bg-white/10 px-3 py-1.5 font-medium hover:bg-white/20"
          >
            ログアウト
          </button>
        </div>
      )}
    </header>
  );
}
