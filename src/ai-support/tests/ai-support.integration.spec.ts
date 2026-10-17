import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import request from 'supertest';

import { AppModule } from '../../app.module';

/**
 * Integration tests for the AI support endpoints.
 *
 * These run against the DEV database and assert the two properties that
 * matter most and cannot be proved by types:
 *
 *   1. The endpoints are unreachable without BOTH the service key and a
 *      customer token.
 *   2. A customer can never read another customer's records, no matter what
 *      id is put in the URL.
 */
const KEY = 'test-ai-support-key';

describe('AI Support (integration)', () => {
  let app: INestApplication;
  let jwt: JwtService;
  let ds: DataSource;
  let userId: number;
  let token: string;

  beforeAll(async () => {
    process.env.AI_SUPPORT_API_KEY = KEY;
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();

    jwt = app.get(JwtService);
    ds = app.get<DataSource>(getDataSourceToken());

    const [u] = await ds.query(
      `SELECT id FROM users WHERE account_status = 'ACTIVE' ORDER BY id LIMIT 1`,
    );
    userId = Number(u.id);
    token = jwt.sign({ sub: userId, username: 'test', type: 'USER' });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  const get = (path: string) => request(app.getHttpServer()).get(path);
  const auth = (path: string) =>
    get(path).set('x-ai-support-key', KEY).set('Authorization', `Bearer ${token}`);

  describe('access control', () => {
    it('refuses a request with no service key', async () => {
      await get('/internal/ai-support/user/profile')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });

    it('refuses a wrong service key', async () => {
      await get('/internal/ai-support/user/profile')
        .set('x-ai-support-key', 'wrong')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });

    it('refuses a valid key with no customer token', async () => {
      await get('/internal/ai-support/user/profile')
        .set('x-ai-support-key', KEY)
        .expect(401);
    });

    it('refuses an admin token', async () => {
      const adminToken = jwt.sign({ sub: 1, type: 'ADMIN', role: 'SUPER_ADMIN' });
      await get('/internal/ai-support/user/profile')
        .set('x-ai-support-key', KEY)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(403);
    });

    it('allows a valid key plus a customer token', async () => {
      const res = await auth('/internal/ai-support/user/profile').expect(200);
      expect(res.body.customerId).toBe(userId);
    });
  });

  describe('customer isolation', () => {
    it('does not return another customer\'s deposit', async () => {
      const [other] = await ds.query(
        `SELECT id FROM deposits WHERE user_id <> $1 ORDER BY id DESC LIMIT 1`,
        [userId],
      );
      if (!other) return; // nothing to prove against on this database
      await auth(`/internal/ai-support/deposits/${other.id}`).expect(404);
    });

    it('does not return another customer\'s withdrawal', async () => {
      const [other] = await ds.query(
        `SELECT id FROM withdrawals WHERE user_id <> $1 ORDER BY id DESC LIMIT 1`,
        [userId],
      );
      if (!other) return;
      await auth(`/internal/ai-support/withdrawals/${other.id}`).expect(404);
    });
  });

  describe('payload safety', () => {
    it('masks the phone number and leaks no secrets', async () => {
      const res = await auth('/internal/ai-support/user/profile').expect(200);
      const body = JSON.stringify(res.body);
      expect(res.body.phoneMasked === null || /\*{4}/.test(res.body.phoneMasked)).toBe(true);
      expect(body).not.toMatch(/password|otp|secret|token/i);
    });

    it('returns no document contents from KYC', async () => {
      const res = await auth('/internal/ai-support/kyc/status').expect(200);
      // Assert on FIELD NAMES, not on a substring of the whole payload: the
      // guidance text legitimately contains words like "selfie" while
      // carrying no document data at all.
      const keys = Object.keys(res.body);
      expect(
        keys.filter((k) => /image|front|back|selfie|documentNumber|document_number/i.test(k)),
      ).toEqual([]);
      // And nothing that looks like a stored file.
      expect(JSON.stringify(res.body)).not.toMatch(/https?:\/\/\S+\.(jpg|jpeg|png|pdf)/i);
      expect(res.body).toHaveProperty('kycStatus');
    });
  });

  describe('read endpoints answer', () => {
    it.each([
      '/internal/ai-support/user/status',
      '/internal/ai-support/user/restrictions',
      '/internal/ai-support/kyc/status',
      '/internal/ai-support/wallet/summary',
      '/internal/ai-support/wallet/transactions?limit=5',
      '/internal/ai-support/deposits?limit=5',
      '/internal/ai-support/withdrawals?limit=5',
      '/internal/ai-support/withdrawals/eligibility',
      '/internal/ai-support/bets?limit=5',
      '/internal/ai-support/bets/pending?limit=5',
      '/internal/ai-support/promotions/active',
      '/internal/ai-support/bonuses?limit=5',
      '/internal/ai-support/bonuses/wagering',
    ])('GET %s', async (path) => {
      await auth(path).expect(200);
    });
  });

  describe('input validation', () => {
    it('rejects a limit above the cap', async () => {
      await auth('/internal/ai-support/deposits?limit=5000').expect(400);
    });

    it('rejects an unknown status filter', async () => {
      await auth('/internal/ai-support/deposits?status=HACKED').expect(400);
    });
  });
});
