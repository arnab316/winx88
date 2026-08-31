// src/auth/auth.service.ts
import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { generateUserCode, generateUsername, generateReferralCode } from './utils';
import { JwtService } from '@nestjs/jwt';
import { TwilioService } from '../twilio/twilio.service';
import { PromotionEngineService } from '../promotion/promotion-engine.service';
import { LaafficService } from '../laaffic/laaffic.service';
import { assertPhoneAvailable } from '../common/phone.util';
import { MetaCapiService } from '../meta/meta-capi.service';
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private dataSource: DataSource,
    private jwtService: JwtService,
    private twilioService: TwilioService,
    private promotionEngine: PromotionEngineService,
    private laafficService: LaafficService,
    // Meta conversions. From the @Global MetaModule, so no import cycle.
    private readonly metaCapi: MetaCapiService,
  ) {}

  // ─── Fraud tracking: log REGISTER/LOGIN with IP + device fingerprint ──
  //   Best-effort — must NEVER throw / block auth. The admin Compliance
  //   panel reads these to group accounts sharing an IP or fingerprint.
  async recordLoginEvent(
    userId: number,
    eventType: 'REGISTER' | 'LOGIN',
    ip?: string,
    fingerprint?: string,
  ): Promise<void> {
    try {
      await this.dataSource.query(
        `INSERT INTO user_login_events
           (user_id, event_type, ip_address, device_fingerprint)
         VALUES ($1, $2, $3, $4)`,
        [userId, eventType, ip ?? null, fingerprint ?? null],
      );
    } catch (e: any) {
      this.logger.warn(`recordLoginEvent failed: ${e?.message}`);
    }
  }

  // ═════════════════════════════════════════════════════════════
  // REGISTER — No OTP required
  //   Creates account immediately with phone as UNVERIFIED.
  //   User can log in right away.
  //   OTP verification is a separate step done later.
  // ═════════════════════════════════════════════════════════════
/**
 * @param originHeader Browser Origin (or Referer) of the signup request. We run
 *   more than one public domain, and for a player with no other attribution the
 *   useful answer to "where did they come from" is which site they used. Taken
 *   from the header rather than the payload so it needs no frontend change and
 *   cannot be spoofed by editing the request body.
 */
async register(dto: any, originHeader?: string) {
  const { full_name, username, phone_number, password, email } = dto;

  if (!full_name || !username || !phone_number || !password) {
    throw new BadRequestException('full_name, username, phone_number, password are required');
  }
  if (password.length < 6) {
    throw new BadRequestException('Password must be at least 6 characters');
  }

  const qr = this.dataSource.createQueryRunner();
  await qr.connect();
  await qr.startTransaction();

  try {
    // Check username not taken
    const usernameTaken = await qr.query(
      `SELECT 1 FROM users WHERE username = $1 LIMIT 1`, [username],
    );
    if (usernameTaken.length) throw new BadRequestException('Username already taken');

    // Check phone not already registered — on ANY account, as primary OR
    // secondary. Compared digits-only so "+8801969552779", "8801969552779"
    // and "01969552779" all count as the same number.
    await assertPhoneAvailable(qr, phone_number, {
      message: 'Phone number already registered',
    });

    // Check email if provided
    if (email) {
      const emailTaken = await qr.query(
        `SELECT 1 FROM users WHERE email = $1 LIMIT 1`, [email],
      );
      if (emailTaken.length) throw new BadRequestException('Email already in use');
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const userCode = await this.generateUniqueUserCode(qr, username);
    // This user's own permanent invite code, so they can refer others.
    const referralCode = await this.generateUniqueReferralCode(qr, username || full_name);

    // Create user
    const result = await qr.query(
      `INSERT INTO users (full_name, email, password, user_code, username, referral_code, signup_domain)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        full_name, email ?? null, hashedPassword, userCode, username, referralCode,
        this.hostFromOrigin(originHeader),
      ],
    );
    const userId = result[0].id;

    // Add phone as UNVERIFIED
    await qr.query(
      `INSERT INTO user_phone_numbers (user_id, phone_number, is_primary, is_verified)
       VALUES ($1,$2,true,false)`,
      [userId, phone_number],
    );

    // Create wallet
    await qr.query(`INSERT INTO wallets (user_id) VALUES ($1)`, [userId]);

    // Signup bonus if applicable
    await this.promotionEngine.tryAwardSignupBonus(qr, userId);

    // ✅ Generate tokens — auto-login after register (inside transaction so it rolls back on failure)
    const payload = { sub: userId, role: 'USER' };
    const accessToken  = this.jwtService.sign(payload, { expiresIn: '7d' });
    const refreshToken = this.jwtService.sign(payload, { expiresIn: '7d' });
    const hashedToken  = await bcrypt.hash(refreshToken, 10);

    await qr.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
       VALUES ($1,$2,NOW() + INTERVAL '7 days')`,
      [userId, hashedToken],
    );

    await qr.commitTransaction();

    this.logger.log(
      `User registered + auto-logged-in: userId=${userId} username=${username} phone=${phone_number}`,
    );

    // Refer-a-friend: if they arrived via an invite link, open the referral.
    // Runs AFTER commit in its own transaction so a referral problem (bad code,
    // race, etc.) can never roll back or block the registration itself.
    const refCode = (dto.ref_code ?? dto.ref ?? dto.referrerCode ?? '')
      .toString()
      .trim();
    if (refCode) {
      await this.attachReferralOnSignup(userId, refCode);
    }

    // Affiliate attribution — a SEPARATE system from refer-a-friend above. If
    // the user arrived via an affiliate tracking link (?aff=<affiliate user_code>),
    // record the downline edge in `referrals` ONLY. It does NOT touch
    // referred_by_user_id / friend_referrals / the ৳500 bonus. Best-effort,
    // post-commit, in its own transaction so it can never break registration.
    const affCode = (dto.aff_code ?? dto.aff ?? dto.affiliateCode ?? '')
      .toString()
      .trim();
    if (affCode) {
      await this.attachAffiliateOnSignup(userId, affCode);
    }

    // Marketing channel — a THIRD, separate attribution axis from the two
    // above. Identifies which paid-ad campaign (?channel=) a player arrived
    // through, for third-party media-buyer reporting. No payout is attached.
    // Same post-commit, best-effort contract as the two systems above.
    const chCode = (dto.channel ?? dto.channel_code ?? '').toString().trim();
    const chClickUid = (dto.cid ?? dto.click_id ?? '').toString().trim();
    if (chCode) {
      await this.attachChannelOnSignup(userId, chCode, chClickUid);
    }

    return {
      message: 'Account created successfully. Please verify your phone number.',
      userId,
      username,
      userCode,
      phoneVerified: false,
      accessToken,
      refreshToken,
      user: {
        id:            userId,
        username,
        fullName:      full_name,
        accountStatus: 'ACTIVE',
        phoneVerified: false,
        primaryPhone:  phone_number,
      },
    };
  } catch (e) {
    await qr.rollbackTransaction();
    this.logger.error(
      `Registration failed for username=${username} phone=${phone_number}: ${(e as any).message}`,
    );
    throw e;
  } finally {
    await qr.release();
  }
}

  // Pick a user_code that isn't taken yet. The base (WINX88<YY><3-letter
  // username>) is clean for the common case; on collision (e.g. two
  // usernames sharing the first 3 letters) append a short numeric suffix.
  // Runs on the caller's query runner so it shares the registration
  // transaction. user_code doubles as the affiliate code (?aff=<user_code>).
  private async generateUniqueUserCode(qr: any, username: string): Promise<string> {
    const base = generateUserCode(username);
    const exists = await qr.query(
      `SELECT 1 FROM users WHERE user_code = $1 LIMIT 1`,
      [base],
    );
    if (!exists.length) return base;

    for (let attempt = 2; attempt < 20; attempt++) {
      const code = `${base}${attempt}`;
      const clash = await qr.query(
        `SELECT 1 FROM users WHERE user_code = $1 LIMIT 1`,
        [code],
      );
      if (!clash.length) return code;
    }
    // Astronomically unlikely; widen the random space and accept it.
    return `${base}${Math.floor(1000 + Math.random() * 9000)}`;
  }

  // ─── Referral helpers (refer-a-friend system) ───────────────────────────

  // Pick a referral_code that isn't taken yet. The DB enforces uniqueness;
  // this just avoids the obvious clashes before insert. Runs on the caller's
  // query runner so it shares the registration transaction.
  private async generateUniqueReferralCode(qr: any, seed: string): Promise<string> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const code = generateReferralCode(seed);
      const exists = await qr.query(
        `SELECT 1 FROM users WHERE referral_code = $1 LIMIT 1`,
        [code],
      );
      if (!exists.length) return code;
    }
    // Astronomically unlikely; widen the random space and accept it.
    return generateReferralCode(seed) + Math.floor(1000 + Math.random() * 9000);
  }

  // Live referral rules from referral_config, with safe fallbacks.
  private async loadReferralConfig(qr: any): Promise<Record<string, number>> {
    const rows = await qr.query(
      `SELECT config_key, config_value FROM referral_config`,
    );
    const c: Record<string, number> = {};
    for (const r of rows) c[r.config_key] = Number(r.config_value);
    return {
      bonus_amount:          c.bonus_amount          ?? 500,
      wagering_multiplier:   c.wagering_multiplier   ?? 10,
      referrer_deposit_min:  c.referrer_deposit_min  ?? 1000,
      referee_deposit_min:   c.referee_deposit_min   ?? 1000,
      referrer_turnover_min: c.referrer_turnover_min ?? 2250,
      referee_turnover_min:  c.referee_turnover_min  ?? 4500,
      window_hours:          c.window_hours          ?? 168,
    };
  }

  // Best-effort: link the new referee to the referrer and open a PENDING
  // referral with a config snapshot. NEVER throws — registration already
  // committed by the time this runs.
  private async attachReferralOnSignup(
    refereeUserId: number,
    refCode: string,
  ): Promise<void> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      // Resolve the referrer by invite code — active accounts only, never self.
      const referrerRows = await qr.query(
        `SELECT id FROM users
          WHERE referral_code = $1 AND account_status = 'ACTIVE' AND id <> $2
          LIMIT 1`,
        [refCode, refereeUserId],
      );
      if (!referrerRows.length) {
        await qr.rollbackTransaction();
        this.logger.warn(
          `Referral signup: invalid/ineligible ref_code="${refCode}" refereeId=${refereeUserId}`,
        );
        return;
      }
      const referrerId = Number(referrerRows[0].id);

      const cfg = await this.loadReferralConfig(qr);

      // Snapshot the referrer's one-time lifetime turnover unlock. If already
      // unlocked, their turnover target is satisfied for this referral upfront.
      const statusRows = await qr.query(
        `SELECT referrer_turnover_unlocked FROM referral_status WHERE user_id = $1`,
        [referrerId],
      );
      const referrerWasUnlocked = statusRows.length
        ? Boolean(statusRows[0].referrer_turnover_unlocked)
        : false;

      // Link referee → referrer (the shared tree column; only if still unset).
      await qr.query(
        `UPDATE users SET referred_by_user_id = $1
          WHERE id = $2 AND referred_by_user_id IS NULL`,
        [referrerId, refereeUserId],
      );

      // The referrer's deposit minimum is a LIFETIME total (business rule
      // 2026-07-07): every approved deposit they have EVER made counts, so the
      // counter does NOT restart per referee. Seed the row with their lifetime
      // total; onDeposit() keeps adding new approvals on top.
      const [dep] = await qr.query(
        `SELECT COALESCE(SUM(amount), 0) AS total
           FROM deposits WHERE user_id = $1 AND status = 'APPROVED'`,
        [referrerId],
      );
      const referrerDepositTotal = Number(dep.total);

      // A 0 (or negative) minimum is satisfied at creation — there is no
      // deposit/bet event that would otherwise ever flip its `*_met` flag, so
      // without this a "0 turnover/deposit" rule would never complete.
      const referrerDepMet  = cfg.referrer_deposit_min <= 0
        || referrerDepositTotal >= cfg.referrer_deposit_min;
      const refereeDepMet   = cfg.referee_deposit_min <= 0;
      const referrerTurnMet = referrerWasUnlocked || cfg.referrer_turnover_min <= 0;
      const refereeTurnMet  = cfg.referee_turnover_min <= 0;

      // Open the referral. ON CONFLICT keeps it safe if a row already exists
      // for this referee (a user can only be referred once).
      await qr.query(
        `INSERT INTO friend_referrals (
           referrer_user_id, referee_user_id, started_at, expires_at,
           referrer_was_unlocked,
           referrer_deposit_total,
           referrer_deposit_met, referee_deposit_met,
           referrer_turnover_met, referee_turnover_met,
           config_bonus_amount, config_wagering_mult,
           config_referrer_dep_min, config_referee_dep_min,
           config_referrer_turn_min, config_referee_turn_min,
           config_window_hours, status
         ) VALUES (
           $1, $2, NOW(), NOW() + make_interval(hours => $3::int),
           $4, $15, $11, $12, $13, $14, $5, $6, $7, $8, $9, $10, $3::int, 'PENDING'
         )
         ON CONFLICT (referee_user_id) DO NOTHING`,
        [
          referrerId, refereeUserId, cfg.window_hours, referrerWasUnlocked,
          cfg.bonus_amount, cfg.wagering_multiplier,
          cfg.referrer_deposit_min, cfg.referee_deposit_min,
          cfg.referrer_turnover_min, cfg.referee_turnover_min,
          referrerDepMet, refereeDepMet, referrerTurnMet, refereeTurnMet,
          referrerDepositTotal,
        ],
      );

      // Bump the referrer's lifetime "sent" counter.
      await qr.query(
        `INSERT INTO referral_status (user_id, total_referrals_sent)
         VALUES ($1, 1)
         ON CONFLICT (user_id) DO UPDATE
           SET total_referrals_sent = referral_status.total_referrals_sent + 1,
               updated_at = NOW()`,
        [referrerId],
      );

      await qr.commitTransaction();
      this.logger.log(
        `Referral opened: referrerId=${referrerId} refereeId=${refereeUserId} ref_code="${refCode}"`,
      );
    } catch (e: any) {
      await qr.rollbackTransaction();
      this.logger.warn(
        `attachReferralOnSignup failed (refCode="${refCode}", refereeId=${refereeUserId}): ${e?.message}`,
      );
    } finally {
      await qr.release();
    }
  }

  // ─── Affiliate downline (SEPARATE from refer-a-friend) ───────────────────
  //
  // Records the affiliate→referee edge in `referrals` only. The affiliate code
  // is the affiliate's `users.user_code`. The referrer must be an ACTIVE
  // affiliate (affiliate_users.is_active) and never self. NEVER touches
  // referred_by_user_id / friend_referrals / referral_status, and awards no
  // bonus — that's the refer-a-friend system's job, kept fully independent.
  // Best-effort: never throws (registration has already committed).
  private async attachAffiliateOnSignup(
    refereeUserId: number,
    affCode: string,
  ): Promise<void> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      // Resolve the affiliate by user_code — active affiliates only, never self.
      const rows = await qr.query(
        `SELECT au.user_id
           FROM affiliate_users au
           JOIN users u ON u.id = au.user_id
          WHERE u.user_code = $1 AND au.is_active = true AND u.id <> $2
          LIMIT 1`,
        [affCode, refereeUserId],
      );
      if (!rows.length) {
        await qr.rollbackTransaction();
        this.logger.warn(
          `Affiliate signup: invalid/ineligible aff_code="${affCode}" refereeId=${refereeUserId}`,
        );
        return;
      }
      const affiliateUserId = Number(rows[0].user_id);

      // One affiliate edge per referee; never overwrite an existing attribution.
      await qr.query(
        `INSERT INTO referrals (referrer_user_id, referee_user_id)
         SELECT $1, $2
          WHERE NOT EXISTS (SELECT 1 FROM referrals WHERE referee_user_id = $2)`,
        [affiliateUserId, refereeUserId],
      );

      await qr.commitTransaction();
      this.logger.log(
        `Affiliate downline attached: affiliateUserId=${affiliateUserId} refereeId=${refereeUserId} aff_code="${affCode}"`,
      );
    } catch (e: any) {
      await qr.rollbackTransaction();
      this.logger.warn(
        `attachAffiliateOnSignup failed (affCode="${affCode}", refereeId=${refereeUserId}): ${e?.message}`,
      );
    } finally {
      await qr.release();
    }
  }

  /**
   * Tag a new player with the paid-ad campaign they arrived through.
   *
   * Separate from both systems above: no payout, no downline — this only feeds
   * the third-party media-buyer report. Written with raw SQL here rather than
   * by injecting ChannelsService, which would create an AuthModule ↔
   * ChannelsModule circular dependency.
   *
   * FIRST TOUCH WINS — ON CONFLICT DO NOTHING on the user_id primary key, so a
   * later signup attempt through a different campaign can never rewrite where
   * a player originally came from. That is what makes the numbers defensible
   * when a vendor disputes an invoice.
   *
   * An unregistered code is still recorded (is_unknown), matching the click
   * side: a typo in a live campaign must be visible, not silently dropped.
   */
  private async attachChannelOnSignup(
    userId: number,
    channelCode: string,
    clickUid?: string,
  ): Promise<void> {
    const code = channelCode.trim().toLowerCase().slice(0, 64);
    if (!code) return;
    try {
      const chRows = await this.dataSource.query(
        `SELECT id, vendor_id FROM marketing_channels WHERE code = $1 LIMIT 1`,
        [code],
      );
      const channel = chRows[0] ?? null;

      // Only honour a click id that actually belongs to this channel —
      // otherwise a forged `cid` could credit another campaign's click.
      let clickId: number | null = null;
      if (clickUid) {
        const clickRows = await this.dataSource.query(
          `SELECT id FROM marketing_clicks
            WHERE click_uid = $1 AND channel_code = $2 LIMIT 1`,
          [clickUid, code],
        );
        clickId = clickRows.length ? Number(clickRows[0].id) : null;
      }

      await this.dataSource.query(
        `INSERT INTO user_channel_attribution
           (user_id, channel_code, channel_id, vendor_id, click_id, is_unknown, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (user_id) DO NOTHING`,
        [
          userId,
          code,
          channel?.id ?? null,
          channel?.vendor_id ?? null,
          clickId,
          !channel,
          clickId ? 'REDIRECT' : 'PARAM',
        ],
      );

      // Meta conversion for the signup. Runs after the attribution row exists,
      // since enqueue resolves the pixel through it. No-op when the campaign
      // has no pixel bound, and never throws.
      const chQr = this.dataSource.createQueryRunner();
      await chQr.connect();
      try {
        await this.metaCapi.enqueue(chQr, {
          eventName: 'CompleteRegistration',
          eventId: MetaCapiService.eventIdFor('reg', userId),
          userId,
        });
      } finally {
        await chQr.release();
      }

      this.logger.log(
        `Channel attributed: userId=${userId} channel="${code}" ` +
          `clickId=${clickId ?? '-'} unknown=${!channel}`,
      );
    } catch (e: any) {
      this.logger.warn(
        `attachChannelOnSignup failed (channel="${code}", userId=${userId}): ${e?.message}`,
      );
    }
  }

  // ═════════════════════════════════════════════════════════════
  // SEND OTP — for phone verification (after registration)
  //   Same rate limiting as before.
  //   Works for both new registrations and re-verification.
  // ═════════════════════════════════════════════════════════════
  async sendOtp(dto: any) {
    const { phone_number, username } = dto;

    if (!phone_number) throw new BadRequestException('phone_number is required');

    // If username provided, validate they match (security: prevent OTP spam)
    if (username) {
      const user = await this.dataSource.query(
        `SELECT u.id FROM users u
         JOIN user_phone_numbers p ON p.user_id = u.id
         WHERE u.username = $1 AND p.phone_number = $2 LIMIT 1`,
        [username, phone_number],
      );
      if (!user.length) {
        throw new BadRequestException('Username and phone number do not match');
      }
    }

    // Rate limit: 60s cooldown
    const recentOtp = await this.dataSource.query(
      `SELECT created_at FROM user_otps
       WHERE phone_number = $1 ORDER BY id DESC LIMIT 1`,
      [phone_number],
    );
    if (recentOtp.length) {
      const timeLeft = 60000 - (Date.now() - new Date(recentOtp[0].created_at).getTime());
      if (timeLeft > 0) {
        throw new BadRequestException(
          `Please wait ${Math.ceil(timeLeft / 1000)} seconds before requesting another OTP`,
        );
      }
    }

    // Daily limit: max 5 OTPs per phone per day
    const dailyCount = await this.dataSource.query(
      `SELECT COUNT(*) AS count FROM user_otps
       WHERE phone_number = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
      [phone_number],
    );
    if (parseInt(dailyCount[0].count) >= 5) {
      throw new BadRequestException('Too many OTP requests today. Try again tomorrow.');
    }

    const otp = this.generateOtp();

    // Expiry computed by the DB: a JS UTC ISO string written into the
    // timestamp-without-tz column reads as local clock time, so on any
    // non-UTC database the OTP would look hours expired immediately.
    await this.dataSource.query(
      `INSERT INTO user_otps (phone_number, otp, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '5 minutes')`,
      [phone_number, otp],
    );

    // if (process.env.NODE_ENV !== 'production') {
    //   this.logger.log(`[DEV OTP] ${phone_number}: ${otp}`);
    // } else {
    //   try {
    //     await this.twilioService.sendWhatsAppOtp(phone_number, otp);
    //   } catch (err: any) {
    //     this.logger.error(`OTP send failed: ${err.message}`);
    //     throw new BadRequestException('Failed to send OTP. Please try again.');
    //   }
    // }

    return { message: 'OTP sent successfully' };
  }

  // ═════════════════════════════════════════════════════════════
  // VERIFY PHONE — user submits OTP after receiving it
  //   Marks their phone as verified in user_phone_numbers.
  //   Can be done any time after registration.
  // ═════════════════════════════════════════════════════════════
  async verifyPhone(dto: any) {
    const { phone_number, otp } = dto;

    if (!phone_number || !otp) {
      throw new BadRequestException('phone_number and otp are required');
    }

    // Find latest unused OTP
    const otpRecord = await this.dataSource.query(
      `SELECT *,
              EXTRACT(EPOCH FROM (expires_at - NOW())) * 1000 AS ms_remaining
       FROM user_otps
       WHERE phone_number = $1 AND is_used = false
       ORDER BY id DESC LIMIT 1`,
      [phone_number],
    );

    if (!otpRecord.length) throw new BadRequestException('No OTP found. Please request a new one.');

    const record = otpRecord[0];

    if (record.attempts >= 5) throw new BadRequestException('Too many attempts. Request a new OTP.');
    if (parseFloat(record.ms_remaining) <= 0) throw new BadRequestException('OTP expired. Request a new one.');

    if (record.otp !== String(otp)) {
      await this.dataSource.query(
        `UPDATE user_otps SET attempts = attempts + 1 WHERE id = $1`, [record.id],
      );
      throw new BadRequestException('Invalid OTP');
    }

    // Mark OTP used
    await this.dataSource.query(
      `UPDATE user_otps SET is_used = true WHERE id = $1`, [record.id],
    );

    // Mark phone as verified
    await this.dataSource.query(
      `UPDATE user_phone_numbers SET is_verified = true
       WHERE phone_number = $1`,
      [phone_number],
    );

    this.logger.log(`Phone verified: ${phone_number}`);

    return { message: 'Phone number verified successfully', phoneVerified: true };
  }

  // ═════════════════════════════════════════════════════════════
  // LOGIN
  //   identifier = email | phone_number | username
  //   Returns phoneVerified boolean so frontend knows status.
  // ═════════════════════════════════════════════════════════════
  async login(dto: any) {
    const { identifier, phone_number, email, username, password } = dto;

    if (!password) throw new UnauthorizedException('Password is required');

    // Support both new `identifier` field and old separate fields
    const loginId = identifier || email || phone_number || username;
    if (!loginId) throw new UnauthorizedException('Email, phone number, or username is required');

    let userRows: any[];

    // Try phone
    userRows = await this.dataSource.query(
      `SELECT u.* FROM users u
       JOIN user_phone_numbers p ON p.user_id = u.id
       WHERE p.phone_number = $1 AND p.is_primary = true LIMIT 1`,
      [loginId],
    );
   // check  account status 
      if (userRows.length && userRows[0].account_status !== 'ACTIVE') {
        throw new UnauthorizedException(`Account is ${userRows[0].account_status}`);
      }

    // Try email
    if (!userRows.length) {
      userRows = await this.dataSource.query(
        `SELECT * FROM users WHERE email = $1 LIMIT 1`, [loginId],
      );
    }

    // Try username
    if (!userRows.length) {
      userRows = await this.dataSource.query(
        `SELECT * FROM users WHERE username = $1 LIMIT 1`, [loginId],
      );
    }

    if (!userRows.length) throw new UnauthorizedException('User not found');

    const u = userRows[0];

    const isValid = await bcrypt.compare(password, u.password);
    if (!isValid) throw new UnauthorizedException('Invalid password');

    if (u.account_status !== 'ACTIVE') {
      throw new UnauthorizedException(`Account is ${u.account_status}`);
    }

    // Check phone verification status
    const phoneRow = await this.dataSource.query(
      `SELECT is_verified, phone_number FROM user_phone_numbers
       WHERE user_id = $1 AND is_primary = true LIMIT 1`,
      [u.id],
    );
    const phoneVerified    = phoneRow.length ? Boolean(phoneRow[0].is_verified) : false;
    const primaryPhone     = phoneRow.length ? phoneRow[0].phone_number : null;
   
    // Update last login
    await this.dataSource.query(
      `UPDATE users SET last_login_at = NOW() WHERE id = $1`, [u.id],
    );

    // Generate tokens
    const payload = { sub: u.id, role: 'USER' };
    const accessToken  = this.jwtService.sign(payload, { expiresIn: '7d' });
    const refreshToken = this.jwtService.sign(payload, { expiresIn: '7d' });
    const hashedToken  = await bcrypt.hash(refreshToken, 10);

    await this.dataSource.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
       VALUES ($1,$2,NOW() + INTERVAL '7 days')`,
      [u.id, hashedToken],
    );

    return {
      accessToken,
      refreshToken,
      user: {
        id:            u.id,
        username:      u.username,
        fullName:      u.full_name,
        vipLevel:      u.vip_level,
        accountStatus: u.account_status,
        phoneVerified,             // ← frontend uses this to show verify banner
        primaryPhone,
      },
    };
  }

  // ═════════════════════════════════════════════════════════════
  // REFRESH TOKEN
  // ═════════════════════════════════════════════════════════════
  async refreshToken(dto: any) {
    const decoded = this.jwtService.decode(dto.refreshToken) as any;
    if (!decoded) throw new UnauthorizedException('Invalid token');

    const tokens = await this.dataSource.query(
      `SELECT * FROM refresh_tokens WHERE user_id = $1 AND is_revoked = false`,
      [decoded.sub],
    );

    let valid = false;
    for (const t of tokens) {
      const match = await bcrypt.compare(dto.refreshToken, t.token_hash);
      if (match) { valid = true; break; }
    }

    if (!valid) throw new UnauthorizedException('Invalid refresh token');

    // Re-check the account status on every refresh. Login already rejects
    // non-ACTIVE accounts, but a player suspended mid-session would otherwise
    // keep minting fresh access tokens off a refresh token issued before the
    // suspension.
    const statusRows = await this.dataSource.query(
      `SELECT account_status FROM users WHERE id = $1 LIMIT 1`,
      [decoded.sub],
    );
    if (!statusRows.length) throw new UnauthorizedException('User not found');
    if (statusRows[0].account_status !== 'ACTIVE') {
      throw new UnauthorizedException(`Account is ${statusRows[0].account_status}`);
    }

    const newAccessToken = this.jwtService.sign(
      { sub: decoded.sub }, { expiresIn: '15m' },
    );

    return { accessToken: newAccessToken };
  }

  // ═════════════════════════════════════════════════════════════
  // LOGOUT
  // ═════════════════════════════════════════════════════════════
  async logout(dto: any) {
    if (!dto?.refreshToken) throw new UnauthorizedException('Refresh token is required');

    let decoded: any;
    try {
      decoded = this.jwtService.verify(dto.refreshToken);
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    await this.dataSource.query(
      `UPDATE refresh_tokens SET is_revoked = true WHERE user_id = $1`,
      [decoded.sub],
    );

    return { message: 'Logged out successfully' };
  }

  // ═════════════════════════════════════════════════════════════
  // GET PROFILE
  // ═════════════════════════════════════════════════════════════
  async getProfile(dto: any) {
    if (!dto.userId) throw new UnauthorizedException('User ID is required');

    const user = await this.dataSource.query(
      `SELECT full_name, email, username, profile_image_url,
              account_status, user_code, referral_code
       FROM users WHERE id = $1`,
      [dto.userId],
    );
    return user[0];
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN LOGIN
  // ═════════════════════════════════════════════════════════════
  async adminLogin(dto: any) {
    const admin = await this.dataSource.query(
      `SELECT * FROM admin_users WHERE email = $1`, [dto.email],
    );
    if (!admin.length) throw new UnauthorizedException('Admin not found');

    const a = admin[0];
    const isValid = await bcrypt.compare(dto.password, a.password);
    if (!isValid) throw new UnauthorizedException('Invalid password');

    if (a.status && a.status !== 'ACTIVE') {
      throw new UnauthorizedException(`Admin account is ${a.status}`);
    }

    // RBAC: resolve roles + effective permissions (AWS-style) for this admin.
    const access = await this.loadAdminAccess(a.id, a.role);

    const payload = {
      sub: a.id,
      type: 'ADMIN',
      role: a.role ?? 'ADMIN', // legacy primary role (kept for SuperAdminGuard etc.)
      roles: access.roles,     // full role set (groups)
    };
    const accessToken  = this.jwtService.sign(payload, { expiresIn: '7d' });
    const refreshToken = this.jwtService.sign(payload, { expiresIn: '7d' });
    const hashedToken  = await bcrypt.hash(refreshToken, 10);

    await this.dataSource.query(
      `INSERT INTO admin_refresh_tokens (admin_id, token_hash, expires_at)
       VALUES ($1,$2,NOW() + INTERVAL '7 days')`,
      [a.id, hashedToken],
    );

    return {
      accessToken,
      refreshToken,
      admin: {
        id: a.id,
        name: a.name,
        email: a.email,
        // role code string; the frontend's super-admin check compares this
        // (and/or is_super_admin). Full object available via role_id/role_name.
        role: access.primaryRole?.code ?? a.role,
        role_id: access.primaryRole?.id ?? null,
        role_name: access.primaryRole?.name ?? null,
        is_super_admin: access.isSuperAdmin,
        // [{ section: 'all_members', actions: ['view','filter'] }, …] —
        // ignored by the frontend when is_super_admin is true.
        permissions: access.sections,
      },
      roles: access.roles,            // ['CS'] (an admin can hold several)
      permissions: access.permissions, // legacy map { all_members: ['view'], … }
    };
  }

  // Roles + effective permissions for an admin. `permissions` is the legacy
  // map shape; `sections` is the [{ section, actions[] }] array the admin
  // frontend consumes. Resilient: if the RBAC tables don't exist yet
  // (migration not run), fall back to the legacy role so login never breaks.
  private async loadAdminAccess(
    adminId: number,
    legacyRole?: string,
  ): Promise<{
    roles: string[];
    isSuperAdmin: boolean;
    primaryRole: { id: number; code: string; name: string } | null;
    permissions: Record<string, string[]>;
    sections: Array<{ section: string; actions: string[] }>;
  }> {
    try {
      const roleRows = await this.dataSource.query(
        `SELECT ar.id, ar.code, ar.name
           FROM admin_user_roles aur
           JOIN admin_roles ar ON ar.id = aur.role_id
          WHERE aur.admin_id = $1
          ORDER BY (ar.code = 'SUPER_ADMIN') DESC, aur.assigned_at ASC`,
        [adminId],
      );
      const roles: string[] = roleRows.map((r: any) => r.code);
      const isSuperAdmin = roles.includes('SUPER_ADMIN') || legacyRole === 'SUPER_ADMIN';
      const primaryRole = roleRows.length
        ? { id: Number(roleRows[0].id), code: roleRows[0].code, name: roleRows[0].name }
        : null;

      const permRows = await this.dataSource.query(
        `SELECT DISTINCT p.resource, p.action
           FROM admin_user_roles aur
           JOIN admin_role_permissions arp ON arp.role_id = aur.role_id
           JOIN admin_permissions p        ON p.id = arp.permission_id
          WHERE aur.admin_id = $1`,
        [adminId],
      );
      const permissions: Record<string, string[]> = {};
      for (const r of permRows) (permissions[r.resource] ??= []).push(r.action);
      const sections = Object.entries(permissions)
        .filter(([section]) => !['roles', 'admins'].includes(section)) // internal
        .map(([section, actions]) => ({ section, actions: [...actions].sort() }))
        .sort((x, y) => x.section.localeCompare(y.section));

      return {
        roles: roles.length ? roles : (legacyRole ? [legacyRole] : []),
        isSuperAdmin,
        primaryRole,
        permissions,
        sections,
      };
    } catch {
      return {
        roles: legacyRole ? [legacyRole] : [],
        isSuperAdmin: legacyRole === 'SUPER_ADMIN',
        primaryRole: null,
        permissions: {},
        sections: [],
      };
    }
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN REGISTER
  // ═════════════════════════════════════════════════════════════
  async adminRegister(dto: any) {
    const hashed = await bcrypt.hash(dto.password, 10);
    await this.dataSource.query(
      `INSERT INTO admin_users (name, email, password, role) VALUES ($1,$2,$3,$4)`,
      [dto.full_name, dto.email, hashed, dto.role ?? 'ADMIN'],
    );
    return { message: 'Admin registered successfully' };
  }

  // ─── Private helpers ─────────────────────────────────────────

  /**
   * Reduce an Origin/Referer header to a bare hostname for `users.signup_domain`
   * — "https://winx88.net/register?x=1" becomes "winx88.net". Returns null for
   *  anything unparseable (a same-origin or server-to-server call sends no
   *  Origin at all), which the member list renders as Direct with no name.
   */
  private hostFromOrigin(origin?: string): string | null {
    const raw = (origin ?? '').trim();
    if (!raw) return null;
    try {
      return new URL(raw).hostname.replace(/^www\./, '').slice(0, 120) || null;
    } catch {
      // Bare host with no scheme, e.g. "winx88.net"
      const bare = raw.replace(/^www\./, '').split('/')[0].split(':')[0].trim();
      return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(bare) ? bare.slice(0, 120) : null;
    }
  }

  private generateOtp(): string {
    const crypto = require('crypto');
    return crypto.randomInt(100000, 1000000).toString();
  }

  // Legacy: kept for backward compat — calls register internally
  async initiateRegistration(dto: any) {
    return this.sendOtp(dto);
  }

  // Legacy: kept for backward compat
  async verifyOtpAndRegister(dto: any) {
    return this.register(dto);
  }

     async isUsernameTaken(username: string): Promise<boolean> {
        const result = await this.dataSource.query(
            `SELECT 1 FROM users WHERE username = $1 LIMIT 1`,
            [username],
        );

        return result.length > 0;
    }

    /**
 * Step 1: User submits their phone number to request a password reset.
 * - Verifies the phone belongs to an actual user
 * - Throttles requests (60s cooldown, 5/day) — same rules as registration
 * - Generates a 6-digit OTP, stores it with purpose='PASSWORD_RESET'
 * - Sends it via LAAFFIC SMS
 *
 * Response is deliberately the same whether the phone exists or not in some
 * apps, to avoid user enumeration. Here we throw so the FE shows a clear error;
 * if you want the safer behavior, swap the throw for a silent return.
 */
async forgotPassword(dto: { phone_number: string }) {
  const rawInput = dto.phone_number?.trim();
 
  if (!rawInput) {
    throw new BadRequestException('phone_number is required');
  }
 
  // Phone as the user sent it (may have leading "+"). Used for DB lookups
  // and for storing the OTP row, so verifyResetOtp finds it.
  const phone_number = rawInput;
 
  // Phone in LAAFFIC format — no "+", just digits (e.g. 8801712345678).
  const laafficNumber = rawInput.replace(/^\+/, '');
 
  // 1. Confirm the phone is registered as someone's primary number.
  //    Match BOTH with-"+" and without-"+", in case stored format differs.
  const userRow = await this.dataSource.query(
    `SELECT u.id
       FROM users u
       JOIN user_phone_numbers up ON up.user_id = u.id
      WHERE (up.phone_number = $1 OR up.phone_number = $2)
        AND up.is_primary = true
      LIMIT 1`,
    [phone_number, laafficNumber],
  );
 
  if (!userRow.length) {
    throw new BadRequestException('No account found for this phone number');
  }
 
  // 2. 60-second cooldown (per phone, per purpose).
  const recent = await this.dataSource.query(
    `SELECT created_at FROM user_otps
      WHERE phone_number = $1 AND purpose = 'PASSWORD_RESET'
      ORDER BY id DESC LIMIT 1`,
    [phone_number],
  );
  if (recent.length) {
    const lastSentAt = new Date(recent[0].created_at).getTime();
    const cooldown = 60 * 1000;
    const wait = cooldown - (Date.now() - lastSentAt);
    if (wait > 0) {
      throw new BadRequestException(
        `Please wait ${Math.ceil(wait / 1000)}s before requesting another OTP`,
      );
    }
  }
 
  // 3. Daily limit: 5 reset OTPs per phone per 24h.
  const dayCount = await this.dataSource.query(
    `SELECT COUNT(*)::int AS count FROM user_otps
      WHERE phone_number = $1
        AND purpose = 'PASSWORD_RESET'
        AND created_at > NOW() - INTERVAL '24 hours'`,
    [phone_number],
  );
  if (dayCount[0].count >= 52) {
    throw new BadRequestException('Too many reset attempts today. Try again tomorrow.');
  }
 
  // 4. Generate + store OTP (stored under the original form, e.g. "+8801712...").
  //    Expiry computed by the DB — see the phone-verify insert above for why
  //    (JS UTC ISO string vs timestamp-without-tz breaks on non-UTC DBs).
  const otp = this.generateOtp();

  const inserted = await this.dataSource.query(
    `INSERT INTO user_otps (phone_number, otp, expires_at, purpose)
     VALUES ($1, $2, NOW() + INTERVAL '5 minutes', 'PASSWORD_RESET')
     RETURNING id`,
    [phone_number, otp],
  );
  const otpRowId: number = inserted[0].id;
 
  // 5. Send via LAAFFIC — always WITHOUT the leading "+".
  try {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[DEV RESET OTP] ${laafficNumber}: ${otp}`);
    } else {

      const msgId = await this.laafficService.sendPasswordResetOtp(laafficNumber, otp);
      if (msgId) {
        await this.dataSource.query(
          `UPDATE user_otps SET provider_msg_id = $1 WHERE id = $2`,
          [msgId, otpRowId],
        );
      }
    }
  } catch (err: any) {
    console.error('LAAFFIC send failed:', err);
    throw new BadRequestException('Failed to send OTP. Please try again.');
  }
 
  return { message: 'OTP sent successfully' };
}
 
 
/**
 * Step 2: User submits the OTP they received.
 * On success returns a short-lived JWT (resetToken) that the FE must send back
 * with the new password. This avoids putting the OTP itself on the final
 * reset endpoint, and limits the window for reuse.
 */
async verifyResetOtp(dto: { phone_number: string; otp: string }) {
  const rawInput = dto.phone_number?.trim();
  const { otp } = dto;
 
  if (!rawInput || !otp) {
    throw new BadRequestException('phone_number and otp are required');
  }
 
  const phone_number = rawInput;                  // form used at insert time
  const laafficNumber = rawInput.replace(/^\+/, ''); // alternate form
 
  const otpRows = await this.dataSource.query(
    `SELECT id, otp, attempts, is_used,
            EXTRACT(EPOCH FROM (expires_at - NOW())) * 1000 AS ms_remaining
       FROM user_otps
      WHERE (phone_number = $1 OR phone_number = $2)
        AND purpose = 'PASSWORD_RESET'
        AND is_used = false
      ORDER BY id DESC
      LIMIT 1`,
    [phone_number, laafficNumber],
  );
 
  if (!otpRows.length) {
    throw new BadRequestException('No OTP found. Please request again.');
  }
 
  const record = otpRows[0];
 
  if (record.attempts >= 5) {
    throw new BadRequestException('Too many attempts. Request a new OTP.');
  }
  if (parseFloat(record.ms_remaining) <= 0) {
    throw new BadRequestException('OTP expired');
  }
  if (record.otp !== otp) {
    await this.dataSource.query(
      `UPDATE user_otps SET attempts = attempts + 1 WHERE id = $1`,
      [record.id],
    );
    throw new BadRequestException('Invalid OTP');
  }
 
  await this.dataSource.query(
    `UPDATE user_otps SET is_used = true WHERE id = $1`,
    [record.id],
  );
 
  const userRow = await this.dataSource.query(
    `SELECT u.id
       FROM users u
       JOIN user_phone_numbers up ON up.user_id = u.id
      WHERE (up.phone_number = $1 OR up.phone_number = $2)
        AND up.is_primary = true
      LIMIT 1`,
    [phone_number, laafficNumber],
  );
  if (!userRow.length) {
    throw new BadRequestException('User not found');
  }
 
  const resetToken = this.jwtService.sign(
    { sub: userRow[0].id, scope: 'password_reset' },
    { expiresIn: '10m' },
  );
 
  return { message: 'OTP verified', resetToken };
}

 
 
/**
 * Step 3: Consume the reset token + new password.
 */
async resetPassword(dto: { resetToken: string; new_password: string }) {
  const { resetToken, new_password } = dto;
 
  if (!resetToken || !new_password) {
    throw new BadRequestException('resetToken and new_password are required');
  }
  if (new_password.length < 8) {
    throw new BadRequestException('Password must be at least 8 characters');
  }
 
  let payload: any;
  try {
    payload = this.jwtService.verify(resetToken);
  } catch {
    throw new UnauthorizedException('Invalid or expired reset token');
  }
 
  if (payload?.scope !== 'password_reset' || !payload?.sub) {
    throw new UnauthorizedException('Invalid reset token');
  }
 
  const hashed = await bcrypt.hash(new_password, 10);
 
  await this.dataSource.query(
    `UPDATE users SET password = $1, updated_at = NOW() WHERE id = $2`,
    [hashed, payload.sub],
  );
 
  // Kill all existing sessions — anyone using a stolen refresh token is out.
  await this.dataSource.query(
    `UPDATE refresh_tokens SET is_revoked = true WHERE user_id = $1`,
    [payload.sub],
  );
 
  return { message: 'Password reset successfully' };
}

/**
 * Authenticated password change for a logged-in user.
 * Requires the current password as proof of ownership — distinct from the
 * unauthenticated phone-OTP forgot/reset flow above. Revokes all sessions on
 * success so a changed password logs the account out everywhere (mirrors
 * resetPassword).
 */
async changePassword(
  userId: number,
  dto: { current_password: string; new_password: string },
) {
  const { current_password, new_password } = dto ?? ({} as any);

  if (!userId) {
    throw new UnauthorizedException('Not authenticated');
  }
  if (!current_password || !new_password) {
    throw new BadRequestException('current_password and new_password are required');
  }
  if (new_password.length < 8) {
    throw new BadRequestException('Password must be at least 8 characters');
  }
  if (current_password === new_password) {
    throw new BadRequestException('New password must be different from the current password');
  }

  const rows = await this.dataSource.query(
    `SELECT password FROM users WHERE id = $1`,
    [userId],
  );
  if (!rows.length) {
    throw new UnauthorizedException('User not found');
  }

  // Verify the current password. Guard against accounts with no password set.
  const currentHash: string | null = rows[0].password;
  const ok = currentHash
    ? await bcrypt.compare(current_password, currentHash)
    : false;
  if (!ok) {
    throw new BadRequestException('Current password is incorrect');
  }

  const hashed = await bcrypt.hash(new_password, 10);
  await this.dataSource.query(
    `UPDATE users SET password = $1, updated_at = NOW() WHERE id = $2`,
    [hashed, userId],
  );

  // Log out everywhere — any old/stolen refresh token is now dead.
  await this.dataSource.query(
    `UPDATE refresh_tokens SET is_revoked = true WHERE user_id = $1`,
    [userId],
  );

  return { message: 'Password changed successfully' };
}
}


