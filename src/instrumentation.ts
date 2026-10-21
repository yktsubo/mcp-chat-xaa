import type { Instrumentation } from 'next';
import { errorFields, log } from './lib/log';

// Next.js が捕まえたサーバー側の想定外のエラー（ページ・API・ミドルウェア）をすべて記録する
export const onRequestError: Instrumentation.onRequestError = (error, request, context) => {
  log.error('request_error', {
    method: request.method,
    path: request.path,
    route: context.routePath,
    routeType: context.routeType,
    ...errorFields(error, true),
  });
};
