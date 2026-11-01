import { OroplayClient } from './oroplay.client';

/**
 * The vendor-list cache in front of OroPlay.
 *
 * Both /oroplay/vendors and /oroplay/vendors/grouped used to call upstream on
 * every request, so a busy lobby meant a steady stream of calls into an API
 * that allows one token per ten seconds. As with the token cache, every
 * assertion here is about CALL COUNT.
 */
describe('OroplayClient.vendorList', () => {
  const vendors = [
    { vendorCode: 'pragmatic', type: 2, name: 'Pragmatic Play' },
    { vendorCode: 'board-poker', type: 6, name: 'Poker' },
  ];

  /** A client with `request` stubbed — only the caching wrapper is of interest. */
  const build = (request: jest.Mock) => {
    const client = Object.create(OroplayClient.prototype) as OroplayClient;
    Object.assign(client, {
      logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
      vendorCache: null,
      vendorInFlight: null,
      request,
    });
    return client;
  };

  const ok = () => Promise.resolve({ success: true, errorCode: 0, message: vendors });

  it('calls upstream once and serves the cache afterwards', async () => {
    const request = jest.fn(ok);
    const client = build(request);

    await client.vendorList();
    await client.vendorList();
    await client.vendorList();

    expect(request).toHaveBeenCalledTimes(1);
  });

  it('returns the vendors unchanged', async () => {
    const client = build(jest.fn(ok));
    await expect(client.vendorList()).resolves.toEqual({
      success: true,
      errorCode: 0,
      message: vendors,
    });
  });

  it('collapses a burst of lobby loads into one call', async () => {
    let resolve!: (v: any) => void;
    const request = jest.fn(() => new Promise((r) => (resolve = r)));
    const client = build(request as any);

    const all = Promise.all([
      client.vendorList(),
      client.vendorList(),
      client.vendorList(),
      client.vendorList(),
    ]);
    resolve({ success: true, errorCode: 0, message: vendors });

    await all;
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('serves the last good list when a refresh fails', async () => {
    jest.useFakeTimers();
    try {
      const request = jest
        .fn()
        .mockImplementationOnce(ok)
        .mockImplementationOnce(() => Promise.reject(new Error('429 quota exceeded')));
      const client = build(request);

      await client.vendorList();
      jest.advanceTimersByTime(6 * 60 * 1000); // past the TTL

      // The refresh fails, but the lobby still renders.
      await expect(client.vendorList()).resolves.toEqual({
        success: true,
        errorCode: 0,
        message: vendors,
      });
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('propagates the failure when there is nothing cached to fall back on', async () => {
    const request = jest.fn(() => Promise.reject(new Error('429 quota exceeded')));
    const client = build(request);

    await expect(client.vendorList()).rejects.toThrow('429 quota exceeded');
  });

  it('refreshes once the TTL has passed', async () => {
    jest.useFakeTimers();
    try {
      const request = jest.fn(ok);
      const client = build(request);

      await client.vendorList();
      jest.advanceTimersByTime(6 * 60 * 1000);
      await client.vendorList();

      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});
