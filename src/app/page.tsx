import { Header } from '@/components/Header';
import { currentUser } from '@/lib/auth';
import Chat, { Login } from './Chat';

// ログイン状態はセッション Cookie だけで判定する（MCP サーバーには接続しないので待ち時間がない）
export default async function Home() {
  const user = await currentUser();
  return (
    <>
      <Header user={user?.name} />
      {user ? <Chat /> : <Login />}
    </>
  );
}
