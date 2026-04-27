import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
@Injectable()
export class UserService {
    constructor(private dataSource: DataSource) { }
    async getProfile(userId: number) {
        const user = await this.dataSource.query(
            `SELECT id, user_code, full_name, username, email, dob, 
              referral_code, vip_level, account_status, created_at
       FROM users
       WHERE id = $1`,
            [userId],
        );

        if (!user.length) {
            throw new NotFoundException('User not found');
        }

        const phones = await this.dataSource.query(
            `SELECT id, phone_number, is_primary, is_verified
       FROM user_phone_numbers
       WHERE user_id = $1`,
            [userId],
        );

        return {
            ...user[0],
            phones,
        };
    }

    // ---------------- UPDATE PROFILE ----------------
    async updateProfile(userId: number, dto: any) {
        const fields: any = [];
        const values: any = [];
        let index = 1;

        if (dto.full_name) {
            fields.push(`full_name = $${index++}`);
            values.push(dto.full_name);
        }

        if (dto.dob) {
            fields.push(`dob = $${index++}`);
            values.push(dto.dob);
        }

        if (dto.profile_image_url) {
            fields.push(`profile_image_url = $${index++}`);
            values.push(dto.profile_image_url);
        }

        if (!fields.length) {
            throw new BadRequestException('Nothing to update');
        }

        values.push(userId);

        await this.dataSource.query(
            `UPDATE users
       SET ${fields.join(', ')}, updated_at = NOW()
       WHERE id = $${index}`,
            values,
        );

        return { message: 'Profile updated successfully' };
    }

    // ---------------- ADD PHONE ----------------
    async addPhone(userId: number, phoneNumber: string) {
        const queryRunner = this.dataSource.createQueryRunner();

        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {

            // ✅ Regex validation (see below)
            const phoneRegex = /^[6-9]\d{9}$/;
            if (!phoneRegex.test(phoneNumber)) {
                throw new BadRequestException('Invalid phone number format');
            }
            // count existing phones
            const phones = await queryRunner.query(
                `SELECT * FROM user_phone_numbers WHERE user_id = $1`,
                [userId],
            );

            if (phones.length >= 3 && phoneNumber.length >= 3) {
                throw new BadRequestException('Maximum 3 phone numbers allowed');
            }

            // check duplicate
            const existing = phones.find(p => p.phone_number === phoneNumber);
            if (existing) {
                throw new BadRequestException('Phone already exists');
            }

            // first phone → primary
            const isPrimary = phones.length === 0;

            const result = await queryRunner.query(
                `INSERT INTO user_phone_numbers (user_id, phone_number, is_primary)
         VALUES ($1, $2, $3)
         RETURNING *`,
                [userId, phoneNumber, isPrimary],
            );

            await queryRunner.commitTransaction();

            return result[0];
        } catch (err: any) {
            await queryRunner.rollbackTransaction();
            if (err.code === '23505') {
                throw new BadRequestException('Phone number already exists');
            }
            throw err;
        } finally {
            await queryRunner.release();
        }
    }

    // ---------------- SET PRIMARY PHONE ----------------
    async setPrimaryPhone(userId: number, phoneId: number) {
        const queryRunner = this.dataSource.createQueryRunner();

        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            // check phone exists
            const phone = await queryRunner.query(
                `SELECT * FROM user_phone_numbers 
         WHERE id = $1 AND user_id = $2`,
                [phoneId, userId],
            );

            if (!phone.length) {
                throw new NotFoundException('Phone not found');
            }

            // remove old primary
            await queryRunner.query(
                `UPDATE user_phone_numbers
         SET is_primary = false
         WHERE user_id = $1`,
                [userId],
            );

            // set new primary
            await queryRunner.query(
                `UPDATE user_phone_numbers
         SET is_primary = true
         WHERE id = $1`,
                [phoneId],
            );

            await queryRunner.commitTransaction();

            return { message: 'Primary phone updated' };
        } catch (err) {
            await queryRunner.rollbackTransaction();
            throw err;
        } finally {
            await queryRunner.release();
        }
    }

    // ---------------- DELETE PHONE ----------------
    async   deletePhone(userId: number, phoneId: number) {
        const queryRunner = this.dataSource.createQueryRunner();

        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            const phones = await queryRunner.query(
                `SELECT * FROM user_phone_numbers WHERE user_id = $1`,
                [userId],
            );

            const phone = phones.find(p => p.id === String(phoneId));

            if (!phone) {
                throw new NotFoundException('Phone not found');
            }

            // prevent deleting only primary without replacement
            if (phone.is_primary && phones.length > 1) {
                throw new BadRequestException(
                    'Set another phone as primary before deleting',
                );
            }

            await queryRunner.query(
                `DELETE FROM user_phone_numbers WHERE id = $1`,
                [phoneId],
            );

            await queryRunner.commitTransaction();

            return { message: 'Phone deleted' };
        } catch (err) {
            await queryRunner.rollbackTransaction();
            throw err;
        } finally {
            await queryRunner.release();
        }
    }

    // ---------------- VERIFY PHONE (FUTURE READY) ----------------
    async verifyPhone(userId: number, phoneId: number) {
        await this.dataSource.query(
            `UPDATE user_phone_numbers
       SET is_verified = true
       WHERE id = $1 AND user_id = $2`,
            [phoneId, userId],
        );

        return { message: 'Phone verified' };
    }

    // ---------------- ADMIN: GET USER DETAILS ----------------
    async getUserDetailsByAdmin(userId: number) {
        const user = await this.dataSource.query(
            `SELECT id, user_code, full_name, username, email, vip_level, account_status
       FROM users
       WHERE id = $1`,
            [userId],
        );

        if (!user.length) {
            throw new NotFoundException('User not found');
        }

        const wallet = await this.dataSource.query(
            `SELECT * FROM wallets WHERE user_id = $1`,
            [userId],
        );

        const phones = await this.dataSource.query(
            `SELECT phone_number, is_primary, is_verified
       FROM user_phone_numbers
       WHERE user_id = $1`,
            [userId],
        );

        return {
            ...user[0],
            wallet: wallet[0] || null,
            phones,
        };
    }
    async getAllUsers() {
        const users = await this.dataSource.query(
            `SELECT to_jsonb(users) - 'password' AS user
FROM users`);  

        
        return users;
    }

}
