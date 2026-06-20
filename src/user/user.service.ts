import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';

@Injectable()
export class UserService {
  constructor(private dataSource: DataSource) {}

  // ═════════════════════════════════════════════════════════════
  // USER: GET OWN PROFILE
  // ═════════════════════════════════════════════════════════════
  async getProfile(userId: number) {
    const user = await this.dataSource.query(
      `SELECT id, user_code, full_name, username, email, dob,
              profile_image_url, referral_code, vip_level,
              account_status, is_email_verified, created_at
       FROM users WHERE id = $1`,
      [userId],
    );
    if (!user.length) throw new NotFoundException('User not found');

    const phones = await this.dataSource.query(
      `SELECT id, phone_number, is_primary, is_verified
       FROM user_phone_numbers WHERE user_id = $1`,
      [userId],
    );

    return { ...user[0], phones };
  }

  // ═════════════════════════════════════════════════════════════
  // USER: UPDATE OWN PROFILE
  // ═════════════════════════════════════════════════════════════
  async updateProfile(userId: number, dto: any) {
    const fields: string[] = [];
    const values: any[] = [];
    let i = 1;

    if (dto.full_name !== undefined) {
      fields.push(`full_name = $${i++}`);
      values.push(dto.full_name);
    }
    if (dto.dob !== undefined) {
      fields.push(`dob = $${i++}`);
      values.push(dto.dob);
    }
    if (dto.profile_image_url !== undefined) {
      fields.push(`profile_image_url = $${i++}`);
      values.push(dto.profile_image_url);
    }
    if (dto.email !== undefined) {
      // Check if user has already updated their email once
  const userRow = await this.dataSource.query(
    `SELECT email, email_updated_at FROM users WHERE id = $1`,
    [userId],
  );
  if (!userRow.length) throw new NotFoundException('User not found');

  if (userRow[0].email_updated_at !== null) {
    throw new BadRequestException('Email can only be updated once. Please contact support.');
  }

  // Check email not already taken
  const emailCheck = await this.dataSource.query(
    `SELECT id FROM users WHERE email = $1 AND id != $2`,
    [dto.email, userId],
  );
  if (emailCheck.length) throw new BadRequestException('Email already in use');

  fields.push(`email = $${i++}`);
  values.push(dto.email);
  fields.push(`email_updated_at = NOW()`);  // mark as used
}

    if (!fields.length) throw new BadRequestException('Nothing to update');

    values.push(userId);
    await this.dataSource.query(
      `UPDATE users SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${i}`,
      values,
    );

    return { message: 'Profile updated successfully' };
  }

  // ═════════════════════════════════════════════════════════════
  // PHONE MANAGEMENT
  // ═════════════════════════════════════════════════════════════
  async addPhone(userId: number, phoneNumber: string) {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const phones = await qr.query(
        `SELECT * FROM user_phone_numbers WHERE user_id = $1`, [userId],
      );
      if (phones.length >= 3) {
        throw new BadRequestException('Maximum 3 phone numbers allowed');
      }
      if (phones.find((p: any) => p.phone_number === phoneNumber)) {
        throw new BadRequestException('Phone already exists');
      }

      const isPrimary = phones.length === 0;
      const result = await qr.query(
        `INSERT INTO user_phone_numbers (user_id, phone_number, is_primary)
         VALUES ($1,$2,$3) RETURNING *`,
        [userId, phoneNumber, isPrimary],
      );
      await qr.commitTransaction();
      return result[0];
    } catch (e: any) {
      await qr.rollbackTransaction();
      if (e.code === '23505') throw new BadRequestException('Phone number already exists');
      throw e;
    } finally {
      await qr.release();
    }
  }

  async setPrimaryPhone(userId: number, phoneId: number) {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const phone = await qr.query(
        `SELECT * FROM user_phone_numbers WHERE id = $1 AND user_id = $2`,
        [phoneId, userId],
      );
      if (!phone.length) throw new NotFoundException('Phone not found');

      await qr.query(
        `UPDATE user_phone_numbers SET is_primary = false WHERE user_id = $1`, [userId],
      );
      await qr.query(
        `UPDATE user_phone_numbers SET is_primary = true WHERE id = $1`, [phoneId],
      );
      await qr.commitTransaction();
      return { message: 'Primary phone updated' };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  async deletePhone(userId: number, phoneId: number) {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const phones = await qr.query(
        `SELECT * FROM user_phone_numbers WHERE user_id = $1`, [userId],
      );
      const phone = phones.find((p: any) => Number(p.id) === phoneId);
      if (!phone) throw new NotFoundException('Phone not found');

      if (phone.is_primary && phones.length > 1) {
        throw new BadRequestException('Set another phone as primary before deleting');
      }

      await qr.query(`DELETE FROM user_phone_numbers WHERE id = $1`, [phoneId]);
      await qr.commitTransaction();
      return { message: 'Phone deleted' };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  async verifyPhone(userId: number, phoneId: number) {
    await this.dataSource.query(
      `UPDATE user_phone_numbers SET is_verified = true WHERE id = $1 AND user_id = $2`,
      [phoneId, userId],
    );
    return { message: 'Phone verified' };
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: LIST ALL USERS
  // ═════════════════════════════════════════════════════════════
  async getAllUsers(page = 1, limit = 20) {
  const offset = (page - 1) * limit;
 
  const rows = await this.dataSource.query(
    `SELECT
       u.id,
       u.user_code,
       u.full_name,
       u.username,
       u.email,
       u.vip_level,
       vc.level_name          AS vip_level_name,
       vc.group_name          AS vip_group_name,
       u.account_status,
       u.is_email_verified,
       u.is_kyc_verified,
       u.referral_code,
       u.created_at,
       u.last_login_at,
 
       w.balance,
       w.bonus_balance,
       w.total_deposited,
       w.total_withdrawn,
 
       p.phone_number AS primary_phone,

       COALESCE((
         SELECT json_agg(json_build_object(
                  'id', upn.id, 'phone_number', upn.phone_number,
                  'is_primary', upn.is_primary, 'is_verified', upn.is_verified)
                  ORDER BY upn.is_primary DESC, upn.id ASC)
         FROM user_phone_numbers upn WHERE upn.user_id = u.id
       ), '[]'::json) AS phone_numbers,

       uv.status              AS kyc_status,
       uv.document_type       AS kyc_document_type,
       uv.rejection_reason    AS kyc_rejection_reason,
       uv.submission_count    AS kyc_submission_count,
       uv.updated_at          AS kyc_updated_at,
 
       COUNT(*) OVER() AS total_count
     FROM users u
     LEFT JOIN wallets w
       ON w.user_id = u.id
     LEFT JOIN vip_level_config vc
       ON vc.level = u.vip_level
     LEFT JOIN LATERAL (
       SELECT phone_number
       FROM user_phone_numbers
       WHERE user_id = u.id AND is_primary = true
       LIMIT 1
     ) p ON true
     LEFT JOIN user_verifications uv
       ON uv.user_id = u.id
     ORDER BY u.created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
 
  // total comes back on every row (same value); strip it from the rows themselves
  const total = rows.length ? Number(rows[0].total_count) : 0;
  const data = rows.map(({ total_count, ...rest }: any) => rest);
 
  return { data, total, page, limit };
}

  // ═════════════════════════════════════════════════════════════
  // ADMIN: SEARCH USERS
  // ═════════════════════════════════════════════════════════════
  async searchUser(search: string) {
    return this.dataSource.query(
      `SELECT
         u.id, u.user_code, u.full_name, u.username, u.email,
         u.vip_level,
         vc.level_name AS vip_level_name,
         vc.group_name AS vip_group_name,
         u.account_status, u.created_at,
         w.balance,
         w.bonus_balance,
         w.total_deposited,
         w.total_withdrawn,
         (SELECT phone_number FROM user_phone_numbers
          WHERE user_id = u.id AND is_primary = true LIMIT 1) AS primary_phone,
         COALESCE((
           SELECT json_agg(json_build_object(
                    'id', upn.id, 'phone_number', upn.phone_number,
                    'is_primary', upn.is_primary, 'is_verified', upn.is_verified)
                    ORDER BY upn.is_primary DESC, upn.id ASC)
           FROM user_phone_numbers upn WHERE upn.user_id = u.id
         ), '[]'::json) AS phone_numbers
       FROM users u
       LEFT JOIN wallets w ON w.user_id = u.id
       LEFT JOIN vip_level_config vc ON vc.level = u.vip_level
       WHERE u.full_name ILIKE $1
          OR u.username   ILIKE $1
          OR u.email      ILIKE $1
          OR u.user_code  ILIKE $1
          OR EXISTS (
               SELECT 1 FROM user_phone_numbers upn2
               WHERE upn2.user_id = u.id AND upn2.phone_number ILIKE $1
             )
       ORDER BY u.created_at DESC
       LIMIT 50`,
      [`%${search}%`],
    );
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: GET FULL USER DETAILS
  // ═════════════════════════════════════════════════════════════
  async getUserDetailsByAdmin(userId: number) {
    const user = await this.dataSource.query(
      `SELECT id, user_code, full_name, username, email, dob,
              profile_image_url, referral_code, vip_level,
              account_status, is_email_verified, last_login_at, created_at
       FROM users WHERE id = $1`,
      [userId],
    );
    if (!user.length) throw new NotFoundException('User not found');

    const [wallet, phones, coins] = await Promise.all([
      this.dataSource.query(
        `SELECT balance, bonus_balance, locked_balance,
                total_deposited, total_withdrawn, total_bet, total_win
         FROM wallets WHERE user_id = $1`,
        [userId],
      ),
      this.dataSource.query(
        `SELECT id, phone_number, is_primary, is_verified
         FROM user_phone_numbers WHERE user_id = $1`,
        [userId],
      ),
      this.dataSource.query(
        `SELECT total_coins, lifetime_coins FROM user_coins WHERE user_id = $1`,
        [userId],
      ),
    ]);

    return {
      ...user[0],
      wallet:  wallet[0]  ?? null,
      phones,
      coins:   coins[0]   ?? null,
    };
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: COMPLIANCE / LINKED-ACCOUNTS CHECK
  //   Surfaces the user's device fingerprints + IPs and any OTHER
  //   accounts that share a fingerprint or IP (fraud / duplicate
  //   accounts). Sources: user_login_events (register/login) and
  //   user_promotion_claims (existing fraud-check data).
  //   GET /user/admin/:userId/compliance?keyword=
  // ═════════════════════════════════════════════════════════════
  async getComplianceCheck(userId: number, keyword?: string) {
    const u = await this.dataSource.query(
      `SELECT id, user_code, username, full_name, email, password,
              account_status, created_at
         FROM users WHERE id = $1`,
      [userId],
    );
    if (!u.length) throw new NotFoundException('User not found');
    const user = u[0];

    // Distinct fingerprints + IPs for this user (login events + promo claims).
    const fpRows = await this.dataSource.query(
      `SELECT DISTINCT v FROM (
          SELECT device_fingerprint AS v FROM user_login_events     WHERE user_id = $1
          UNION SELECT device_fingerprint   FROM user_promotion_claims WHERE user_id = $1
       ) t WHERE v IS NOT NULL`,
      [userId],
    );
    const ipRows = await this.dataSource.query(
      `SELECT DISTINCT v FROM (
          SELECT ip_address AS v FROM user_login_events     WHERE user_id = $1
          UNION SELECT ip_address   FROM user_promotion_claims WHERE user_id = $1
       ) t WHERE v IS NOT NULL`,
      [userId],
    );
    const fingerprints = fpRows.map((r: any) => r.v);
    const registerIps = ipRows.map((r: any) => r.v);

    const phoneRows = await this.dataSource.query(
      `SELECT phone_number FROM user_phone_numbers
        WHERE user_id = $1 ORDER BY is_primary DESC, id ASC LIMIT 1`,
      [userId],
    );
    const contactNumber = phoneRows[0]?.phone_number ?? null;

    // Linked accounts: other users sharing any fingerprint or IP.
    const params: any[] = [userId];
    let i = 2;
    let keywordSql = '';
    if (keyword?.trim()) {
      keywordSql = `AND (u.username ILIKE $${i} OR u.user_code ILIKE $${i} OR u.full_name ILIKE $${i})`;
      params.push(`%${keyword.trim()}%`);
      i++;
    }

    const linked = await this.dataSource.query(
      `WITH tfp AS (
          SELECT device_fingerprint AS v FROM user_login_events     WHERE user_id = $1 AND device_fingerprint IS NOT NULL
          UNION SELECT device_fingerprint   FROM user_promotion_claims WHERE user_id = $1 AND device_fingerprint IS NOT NULL
       ),
       tip AS (
          SELECT ip_address AS v FROM user_login_events     WHERE user_id = $1 AND ip_address IS NOT NULL
          UNION SELECT ip_address   FROM user_promotion_claims WHERE user_id = $1 AND ip_address IS NOT NULL
       ),
       matches AS (
          SELECT e.user_id, 'FINGERPRINT' AS reason FROM user_login_events e
            WHERE e.user_id <> $1 AND e.device_fingerprint IN (SELECT v FROM tfp)
          UNION
          SELECT c.user_id, 'FINGERPRINT' FROM user_promotion_claims c
            WHERE c.user_id <> $1 AND c.device_fingerprint IN (SELECT v FROM tfp)
          UNION
          SELECT e.user_id, 'IP' FROM user_login_events e
            WHERE e.user_id <> $1 AND e.ip_address IN (SELECT v FROM tip)
          UNION
          SELECT c.user_id, 'IP' FROM user_promotion_claims c
            WHERE c.user_id <> $1 AND c.ip_address IN (SELECT v FROM tip)
       )
       SELECT u.id, u.user_code, u.username, u.full_name, u.email,
              u.account_status, u.created_at,
              ARRAY_AGG(DISTINCT m.reason ORDER BY m.reason) AS matched_on
         FROM matches m
         JOIN users u ON u.id = m.user_id
        WHERE 1 = 1 ${keywordSql}
        GROUP BY u.id, u.user_code, u.username, u.full_name, u.email,
                 u.account_status, u.created_at
        ORDER BY u.id ASC`,
      params,
    );

    return {
      user: {
        userId:         Number(user.id),
        memberId:       user.user_code,
        username:       user.username,
        name:           user.full_name,
        email:          user.email ?? null,
        contactNumber,
        passwordHash:   user.password,        // bcrypt hash (display only)
        fingerprints,
        registerIps,
        status:         user.account_status,
        registeredDate: user.created_at,
      },
      linked: linked.map((r: any) => ({
        userId:         Number(r.id),
        memberId:       r.user_code,
        username:       r.username,
        name:           r.full_name,
        email:          r.email ?? null,
        status:         r.account_status,
        registeredDate: r.created_at,
        matchedOn:      r.matched_on,          // e.g. ["FINGERPRINT","IP"]
      })),
      total: linked.length,
    };
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: EDIT ANY USER FIELD
  //   Admin can update: full_name, email, dob, username,
  //                     vip_level, account_status, password
  // ═════════════════════════════════════════════════════════════
  async adminEditUser(userId: number, dto: {
    full_name?:      string;
    email?:          string;
    username?:       string;
    dob?:            string;
    vip_level?:      number;
    account_status?: 'ACTIVE' | 'BLOCKED' | 'SUSPENDED';
    password?:       string;   // plain text — will be hashed
  }) {
    const existing = await this.dataSource.query(
      `SELECT id FROM users WHERE id = $1`, [userId],
    );
    if (!existing.length) throw new NotFoundException('User not found');

    const fields: string[] = [];
    const values: any[] = [];
    let i = 1;

    if (dto.full_name !== undefined) {
      fields.push(`full_name = $${i++}`);
      values.push(dto.full_name);
    }
    if (dto.email !== undefined) {
      // Check email not taken by another user
      if (dto.email) {
        const emailCheck = await this.dataSource.query(
          `SELECT id FROM users WHERE email = $1 AND id != $2`, [dto.email, userId],
        );
        if (emailCheck.length) throw new BadRequestException('Email already in use');
      }
      fields.push(`email = $${i++}`);
      values.push(dto.email || null);
    }
    if (dto.username !== undefined) {
      // Check username not taken
      const usernameCheck = await this.dataSource.query(
        `SELECT id FROM users WHERE username = $1 AND id != $2`, [dto.username, userId],
      );
      if (usernameCheck.length) throw new BadRequestException('Username already in use');
      fields.push(`username = $${i++}`);
      values.push(dto.username);
    }
    if (dto.dob !== undefined) {
      fields.push(`dob = $${i++}`);
      values.push(dto.dob || null);
    }
    if (dto.vip_level !== undefined) {
      if (dto.vip_level < 0 || dto.vip_level > 10) {
        throw new BadRequestException('vip_level must be between 0 and 10');
      }
      fields.push(`vip_level = $${i++}`);
      values.push(dto.vip_level);
    }
    if (dto.account_status !== undefined) {
      const valid = ['ACTIVE', 'BLOCKED', 'SUSPENDED'];
      if (!valid.includes(dto.account_status)) {
        throw new BadRequestException(`account_status must be one of: ${valid.join(', ')}`);
      }
      fields.push(`account_status = $${i++}`);
      values.push(dto.account_status);
    }
    if (dto.password !== undefined && dto.password.trim()) {
      if (dto.password.length < 6) {
        throw new BadRequestException('Password must be at least 6 characters');
      }
      const hashed = await bcrypt.hash(dto.password, 10);
      fields.push(`password = $${i++}`);
      values.push(hashed);
    }

    if (!fields.length) throw new BadRequestException('No fields to update');

    fields.push(`updated_at = NOW()`);
    values.push(userId);

    await this.dataSource.query(
      `UPDATE users SET ${fields.join(', ')} WHERE id = $${i}`,
      values,
    );

    // Return updated user (no password)
    return this.getUserDetailsByAdmin(userId);
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: SET PRIMARY PHONE FOR ANY USER
  // ═════════════════════════════════════════════════════════════
  async adminSetPrimaryPhone(userId: number, phoneId: number) {
    const phone = await this.dataSource.query(
      `SELECT * FROM user_phone_numbers WHERE id = $1 AND user_id = $2`,
      [phoneId, userId],
    );
    if (!phone.length) throw new NotFoundException('Phone not found for this user');

    await this.dataSource.query(
      `UPDATE user_phone_numbers SET is_primary = false WHERE user_id = $1`, [userId],
    );
    await this.dataSource.query(
      `UPDATE user_phone_numbers SET is_primary = true WHERE id = $1`, [phoneId],
    );

    return { message: 'Primary phone updated', phoneId };
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: ADD PHONE FOR ANY USER
  // ═════════════════════════════════════════════════════════════
  async adminAddPhone(userId: number, phoneNumber: string) {
    const existing = await this.dataSource.query(
      `SELECT id FROM users WHERE id = $1`, [userId],
    );
    if (!existing.length) throw new NotFoundException('User not found');

    return this.addPhone(userId, phoneNumber);
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: DELETE PHONE FOR ANY USER
  // ═════════════════════════════════════════════════════════════
  async adminDeletePhone(userId: number, phoneId: number) {
    const phone = await this.dataSource.query(
      `SELECT * FROM user_phone_numbers WHERE id = $1 AND user_id = $2`,
      [phoneId, userId],
    );
    if (!phone.length) throw new NotFoundException('Phone not found');

    await this.dataSource.query(
      `DELETE FROM user_phone_numbers WHERE id = $1`, [phoneId],
    );
    return { message: 'Phone deleted' };
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: UPDATE PHONE NUMBER FOR ANY USER
  //   Changes the phone_number of an existing entry. is_verified is
  //   optional: pass it to control the verified flag, otherwise it
  //   defaults to false (the number changed, so it must be re-verified).
  // ═════════════════════════════════════════════════════════════
  async adminUpdatePhone(
    userId: number,
    phoneId: number,
    phoneNumber: string,
    isVerified?: boolean,
  ) {
    if (!phoneNumber?.trim()) {
      throw new BadRequestException('phoneNumber is required');
    }
    const trimmed = phoneNumber.trim();
    const verified = isVerified ?? false;

    const phone = await this.dataSource.query(
      `SELECT id FROM user_phone_numbers WHERE id = $1 AND user_id = $2`,
      [phoneId, userId],
    );
    if (!phone.length) throw new NotFoundException('Phone not found for this user');

    // Reject if the number is already registered to ANY account (excluding the
    // row being edited) — mirrors the global one-number-per-account rule the
    // registration flow enforces. The DB unique index is only on
    // (user_id, phone_number), so it blocks same-user dupes but NOT the same
    // number across two users; this app-level check closes that gap.
    const dupe = await this.dataSource.query(
      `SELECT id FROM user_phone_numbers
        WHERE phone_number = $1 AND id != $2
        LIMIT 1`,
      [trimmed, phoneId],
    );
    if (dupe.length) throw new BadRequestException('Phone number already registered');

    try {
      await this.dataSource.query(
        `UPDATE user_phone_numbers
            SET phone_number = $1,
                is_verified  = $2,
                updated_at   = NOW()
          WHERE id = $3`,
        [trimmed, verified, phoneId],
      );
    } catch (e: any) {
      if (e.code === '23505') throw new BadRequestException('Phone number already exists');
      throw e;
    }

    return {
      message: 'Phone number updated',
      phoneId,
      phone_number: trimmed,
      is_verified: verified,
    };
  }

  // ═════════════════════════════════════════════════════════════
// ADMIN: VERIFY / UNVERIFY PHONE FOR ANY USER
// ═════════════════════════════════════════════════════════════
async adminVerifyPhone(
  userId: number,
  phoneId: number,
  isVerified = true,
) {
  const phone = await this.dataSource.query(
    `SELECT id, phone_number, is_verified
       FROM user_phone_numbers
      WHERE id = $1 AND user_id = $2`,
    [phoneId, userId],
  );
  if (!phone.length) throw new NotFoundException('Phone not found for this user');

  await this.dataSource.query(
    `UPDATE user_phone_numbers
        SET is_verified = $1,
            updated_at  = NOW()
      WHERE id = $2`,
    [isVerified, phoneId],
  );

  return {
    message: isVerified
      ? 'Phone marked as verified'
      : 'Phone marked as unverified',
    phoneId,
    phone_number: phone[0].phone_number,
    is_verified: isVerified,
  };
}
}