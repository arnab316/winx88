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
      fields.push(`email = $${i++}`);
      values.push(dto.email);
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
    const users = await this.dataSource.query(
      `SELECT
         u.id, u.user_code, u.full_name, u.username, u.email,
         u.vip_level, u.account_status, u.is_email_verified,
         u.referral_code, u.created_at, u.last_login_at,
         w.balance, w.bonus_balance, w.total_deposited, w.total_withdrawn,
         (SELECT phone_number FROM user_phone_numbers
          WHERE user_id = u.id AND is_primary = true LIMIT 1) AS primary_phone
       FROM users u
       LEFT JOIN wallets w ON w.user_id = u.id
       ORDER BY u.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );

    const count = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total FROM users`,
    );

    return { data: users, total: count[0].total, page, limit };
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: SEARCH USERS
  // ═════════════════════════════════════════════════════════════
  async searchUser(search: string) {
    return this.dataSource.query(
      `SELECT
         u.id, u.user_code, u.full_name, u.username, u.email,
         u.vip_level, u.account_status, u.created_at,
         (SELECT phone_number FROM user_phone_numbers
          WHERE user_id = u.id AND is_primary = true LIMIT 1) AS primary_phone
       FROM users u
       WHERE u.full_name ILIKE $1
          OR u.username   ILIKE $1
          OR u.email      ILIKE $1
          OR u.user_code  ILIKE $1
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
}