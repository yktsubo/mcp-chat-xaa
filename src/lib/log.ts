// サーバーのログ。1 行の JSON を標準出力・標準エラーに出す（Vercel の Logs 画面で、レベルや中身で絞り込める）。
// トークン、シークレット、認可コードは渡さないこと。

type Fields = Record<string, unknown>;

/** Error をログに出せる形にする（想定外のエラーだけスタックも残す） */
export function errorFields(error: unknown, withStack = false): Fields {
  if (!(error instanceof Error)) return { error: String(error) };
  return { error: `${error.name}: ${error.message}`, ...(withStack && error.stack ? { stack: error.stack } : {}) };
}

function write(level: 'info' | 'warn' | 'error', event: string, fields: Fields) {
  const line = JSON.stringify({ level, event, time: new Date().toISOString(), ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);
}

export const log = {
  info: (event: string, fields: Fields = {}) => write('info', event, fields),
  warn: (event: string, fields: Fields = {}) => write('warn', event, fields),
  error: (event: string, fields: Fields = {}) => write('error', event, fields),
};
