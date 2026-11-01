import { of, throwError } from 'rxjs';
import { OroplayTokenCache } from './token-cache.service';

/**
 * The cache in front of OroPlay's createtoken, which the live account limits
 * to one call per 10 seconds and which it blocks accounts for abusing.
 *
 * Every case here is about CALL COUNT, because that is the thing that broke
 * production: the token itself was always valid, but it was fetched on every
 * request and the lobby 500'd on a 429.
 */
describe('OroplayTokenCache', () => {
  const CONFIG = {
    OROPLAY_API_ENDPOINT: 'https://oroplay.test/api/v2',
    OROPLAY_CLIENT_ID: 'id',
    OROPLAY_CLIENT_SECRET: 'secret',
  } as Record<string, string>;

  const build = (post: jest.Mock) =>
    new OroplayTokenCache(
      { post } as any,
      { get: (k: string) => CONFIG[k] } as any,
    );

  const ok = (body: Record<string, unknown>) => of({ data: body });
  const now = () => Math.floor(Date.now() / 1000);

  describe('a usable expiry', () => {
    it('fetches once and serves the cache after that', async () => {
      const post = jest.fn(() => ok({ token: 't1', expiration: now() + 3600 }));
      const cache = build(post);

      expect(await cache.getToken()).toBe('t1');
      expect(await cache.getToken()).toBe('t1');
      expect(await cache.getToken()).toBe('t1');
      expect(post).toHaveBeenCalledTimes(1);
    });

    it('reads an expiry sent in milliseconds', async () => {
      const post = jest.fn(() => ok({ token: 't1', expiration: Date.now() + 3_600_000 }));
      const cache = build(post);

      await cache.getToken();
      await cache.getToken();
      expect(post).toHaveBeenCalledTimes(1);
    });

    it('reads a RELATIVE lifetime, which used to disable the cache', async () => {
      // 3600 is not a timestamp. Assigned raw it made every comparison false,
      // so each call re-authenticated and the account went over quota.
      const post = jest.fn(() => ok({ token: 't1', expiration: 3600 }));
      const cache = build(post);

      await cache.getToken();
      await cache.getToken();
      await cache.getToken();
      expect(post).toHaveBeenCalledTimes(1);
    });

    it('refetches once the token is genuinely near expiry', async () => {
      // 30s left is inside the 60s refresh margin.
      const post = jest
        .fn()
        .mockReturnValueOnce(ok({ token: 't1', expiration: now() + 30 }))
        .mockReturnValueOnce(ok({ token: 't2', expiration: now() + 3600 }));
      const cache = build(post);

      expect(await cache.getToken()).toBe('t1');
      expect(await cache.getToken()).toBe('t2');
      expect(post).toHaveBeenCalledTimes(2);
    });
  });

  describe('an unusable expiry', () => {
    it.each([
      ['missing', undefined],
      ['null', null],
      ['zero', 0],
      ['not a number', 'soon'],
      ['already past', 1_000_000_000],
    ])('still caches when expiration is %s', async (_label, expiration) => {
      const post = jest.fn(() => ok({ token: 't1', expiration }));
      const cache = build(post);

      await cache.getToken();
      await cache.getToken();
      await cache.getToken();
      // The fallback TTL applies rather than NaN, which compared false and
      // meant no caching at all.
      expect(post).toHaveBeenCalledTimes(1);
    });
  });

  describe('concurrency', () => {
    it('collapses a burst into a single createtoken', async () => {
      let resolve!: (v: any) => void;
      const pending = new Promise((r) => (resolve = r));
      const post = jest.fn(() => ({
        subscribe: (o: any) => {
          void pending.then(() => {
            o.next({ data: { token: 't1', expiration: now() + 3600 } });
            o.complete();
          });
          return { unsubscribe() {} };
        },
      }));
      const cache = build(post as any);

      const all = Promise.all([
        cache.getToken(),
        cache.getToken(),
        cache.getToken(),
        cache.getToken(),
      ]);
      resolve(null);

      expect(await all).toEqual(['t1', 't1', 't1', 't1']);
      expect(post).toHaveBeenCalledTimes(1);
    });
  });

  describe('after a 429', () => {
    const quota = () =>
      throwError(() => ({
        message: 'Request failed with status code 429',
        response: {
          status: 429,
          headers: { 'retry-after': '10' },
          data: 'API calls quota exceeded! maximum admitted 1 per 10s.',
        },
      }));

    it('does not immediately retry, which is what kept the quota pinned', async () => {
      const post = jest.fn(quota);
      const cache = build(post);

      await expect(cache.getToken()).rejects.toThrow();
      await expect(cache.getToken()).rejects.toThrow();
      await expect(cache.getToken()).rejects.toThrow();
      expect(post).toHaveBeenCalledTimes(1);
    });

    it('keeps serving a token that is stale but not yet expired', async () => {
      // 30s left: inside the refresh margin, so a refresh is attempted, but
      // the token still works. A 429 must not take the lobby down with it.
      const post = jest
        .fn()
        .mockReturnValueOnce(ok({ token: 't1', expiration: now() + 30 }))
        .mockImplementationOnce(quota);
      const cache = build(post);

      expect(await cache.getToken()).toBe('t1');
      expect(await cache.getToken()).toBe('t1');
      expect(post).toHaveBeenCalledTimes(2);
    });

    it('recovers on the next call once the cooldown has passed', async () => {
      jest.useFakeTimers();
      try {
        const post = jest
          .fn()
          .mockImplementationOnce(quota)
          .mockReturnValueOnce(ok({ token: 't2', expiration: now() + 3600 }));
        const cache = build(post);

        await expect(cache.getToken()).rejects.toThrow();
        jest.advanceTimersByTime(11_000);
        expect(await cache.getToken()).toBe('t2');
        expect(post).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
