import { of, throwError } from 'rxjs';
import { OroplayClient } from './oroplay.client';

/**
 * How OroplayClient.request reacts to a 401, which depends entirely on WHERE
 * the 401 came from:
 *
 *   from the API call      the token is stale — refresh it and retry once
 *   from /auth/createtoken the token endpoint is refusing to issue one, and
 *                          retrying just spends another of the one-per-ten-
 *                          seconds budget on the same refusal
 *
 * Both used to take the first branch, so a token endpoint answering 401 was
 * billed twice per request and discarded a usable cached token on the way.
 */
describe('OroplayClient — 401 handling', () => {
  const unauthorized = (body: unknown = '') => ({
    message: 'Request failed with status code 401',
    response: { status: 401, data: body, headers: {} },
  });

  const build = (tokenCache: any, http: any) =>
    new OroplayClient(
      http,
      { get: () => 'https://oroplay.test/api/v2' } as any,
      tokenCache,
    );

  it('does not retry when the TOKEN ENDPOINT refuses', async () => {
    // What production showed: createtoken answering 401, empty body,
    // X-Rate-Limit-Remaining: 0.
    const getToken = jest.fn().mockRejectedValue(unauthorized());
    const invalidate = jest.fn();
    const get = jest.fn();

    const client = build({ getToken, invalidate }, { get, post: jest.fn() });

    await expect(client.vendorList()).rejects.toMatchObject({
      response: { status: 401 },
    });

    expect(getToken).toHaveBeenCalledTimes(1); // not two
    expect(invalidate).not.toHaveBeenCalled(); // keeps any cached token
    expect(get).not.toHaveBeenCalled();
  });

  it('still refreshes and retries once when the API rejects the token', async () => {
    const getToken = jest.fn().mockResolvedValue('tok');
    const invalidate = jest.fn();
    const get = jest
      .fn()
      .mockReturnValueOnce(throwError(() => unauthorized('expired')))
      .mockReturnValueOnce(
        of({ data: { success: true, errorCode: 0, message: [] } }),
      );

    const client = build({ getToken, invalidate }, { get, post: jest.fn() });

    await expect(client.vendorList()).resolves.toEqual({
      success: true,
      errorCode: 0,
      message: [],
    });

    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('gives up after one retry rather than looping on a persistent 401', async () => {
    const getToken = jest.fn().mockResolvedValue('tok');
    const get = jest.fn(() => throwError(() => unauthorized('nope')));

    const client = build(
      { getToken, invalidate: jest.fn() },
      { get, post: jest.fn() },
    );

    await expect(client.vendorList()).rejects.toMatchObject({
      response: { status: 401 },
    });
    expect(get).toHaveBeenCalledTimes(2);
  });
});
