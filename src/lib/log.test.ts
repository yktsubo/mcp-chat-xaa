import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorFields, log } from './log';

afterEach(() => vi.restoreAllMocks());

describe('log', () => {
  it('writes one JSON line per event to the stream matching the level', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    log.info('started', { user: 'u1' });
    log.warn('slow');
    log.error('failed', { status: 500 });

    expect(JSON.parse(info.mock.calls[0][0])).toMatchObject({ level: 'info', event: 'started', user: 'u1' });
    expect(JSON.parse(warn.mock.calls[0][0])).toMatchObject({ level: 'warn', event: 'slow' });
    expect(JSON.parse(error.mock.calls[0][0])).toMatchObject({ level: 'error', event: 'failed', status: 500 });
    expect(JSON.parse(info.mock.calls[0][0]).time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('errorFields', () => {
  it('summarizes an Error, with the stack only when asked', () => {
    const error = new TypeError('boom');
    expect(errorFields(error)).toEqual({ error: 'TypeError: boom' });
    expect(errorFields(error, true)).toMatchObject({ error: 'TypeError: boom', stack: expect.stringContaining('boom') });
  });

  it('stringifies anything that is not an Error', () => {
    expect(errorFields('oops')).toEqual({ error: 'oops' });
  });
});
