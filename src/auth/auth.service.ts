import { Injectable, UnauthorizedException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { generateUserCode, generateUsername } from './utils';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class AuthService {
    constructor(
        private dataSource: DataSource
        , private jwtService: JwtService) { }


    // Old Register and Login methods (email + password)
    async register(dto: any) {
        const queryRunner = this.dataSource.createQueryRunner();
        try {
            await queryRunner.connect();
            await queryRunner.startTransaction();
            const saltRounds = 10;
            const hashedPassword = await bcrypt.hash(dto.password, saltRounds);
            const userCode = generateUserCode(dto.full_name);
            const username = generateUsername(dto.full_name, dto.email);
            const result = await queryRunner.query(
                'INSERT INTO users (full_name,email,  password, user_code, username) VALUES ($1, $2, $3, $4, $5)',
                [dto.full_name, dto.email, hashedPassword, userCode, username],
            )
            const userId = result[0].id;
            //  create wallet
            await queryRunner.query(
                `INSERT INTO wallets (user_id) VALUES ($1)`,
                [userId],
            );

            await queryRunner.commitTransaction();



        } catch (error) {
            // Handle errors and rollback transaction if necessary
            await queryRunner.rollbackTransaction();
            console.error('Error during registration:', error);
            throw error; // Rethrow the error to be handled by the caller
        }
    }



  
async login(dto: any) {
    try {
        const { phone_number, email, password } = dto;

        if (!password) {
            throw new UnauthorizedException('Password is required');
        }

        let user: any[];

        // ✅ Login with phone
        if (phone_number) {
            user = await this.dataSource.query(
                `SELECT u.* FROM users u
                 JOIN user_phone_numbers up 
                 ON u.id = up.user_id
                 WHERE up.phone_number = $1
                 AND up.is_primary = true
                 LIMIT 1`,
                [phone_number],
            );
        }

        // ✅ Login with email
        else if (email) {
            user = await this.dataSource.query(
                `SELECT * FROM users WHERE email = $1 LIMIT 1`,
                [email],
            );
        }

        // ❌ Neither provided
        else {
            throw new UnauthorizedException('Email or phone number is required');
        }

        if (!user || !user.length) {
            throw new UnauthorizedException('User not found');
        }

        const u = user[0];

        // 🔒 Password check
        const isValid = await bcrypt.compare(password, u.password);
        if (!isValid) {
            throw new UnauthorizedException('Invalid password');
        }

        // 🚫 Optional: check account status
        if (u.account_status !== 'ACTIVE') {
            throw new UnauthorizedException(`Account is ${u.account_status}`);
        }

        // 🎟️ Generate tokens
        const payload = {
            sub: u.id,
            role: 'USER',
        };

        const accessToken = this.jwtService.sign(payload, {
            expiresIn: '15m',
        });

        const refreshToken = this.jwtService.sign(payload, {
            expiresIn: '7d',
        });

        const hashedToken = await bcrypt.hash(refreshToken, 10);

        // 💾 Store refresh token
        await this.dataSource.query(
            `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
             VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
            [u.id, hashedToken],
        );

        return {
            accessToken,
            refreshToken,
            user: {
                id: u.id,
                username: u.username,
            },
        };

    } catch (error) {
        console.error('Error during login:', error);
        throw error;
    }
}


    async refreshToken(dto: any) {
        const decoded = this.jwtService.decode(dto.refreshToken) as any;

        if (!decoded) {
            throw new UnauthorizedException('Invalid token');
        }

        const userId = decoded.sub;

        const tokens = await this.dataSource.query(
            `SELECT * FROM refresh_tokens WHERE user_id = $1 AND is_revoked = false`,
            [userId],
        );

        let valid = false;

        for (const t of tokens) {
            const match = await bcrypt.compare(dto.refreshToken, t.token_hash);
            if (match) {
                valid = true;
                break;
            }
        }

        if (!valid) {
            throw new UnauthorizedException('Invalid refresh token');
        }

        const newAccessToken = this.jwtService.sign(
            { sub: userId },
            { expiresIn: '15m' },
        );

        return {
            accessToken: newAccessToken,
        };
    }

    async logout(dto: any) {
        const decoded = this.jwtService.decode(dto.refreshToken) as any;

        await this.dataSource.query(
            `UPDATE refresh_tokens SET is_revoked = true WHERE user_id = $1`,
            [decoded.sub],
        );

        return { message: 'Logged out successfully' };
    }


    async getProfile(dto: any) {
        try {

            if (!dto.userId) {
                throw new UnauthorizedException('User ID is required');
            }
            const user = await this.dataSource.query(
                'SELECT full_name, email, username,profile_image_url,account_status,user_code,referral_code FROM users WHERE id = $1',
                [dto.userId],
            );
            return user[0];
        } catch (error) {
            console.error('Error fetching profile:', error);
            throw error;

        }
    }


    async adminLogin(dto: any) {
        const admin = await this.dataSource.query(
            `SELECT * FROM admin_users WHERE email = $1`,
            [dto.email],
        );

        if (!admin.length) {
            throw new UnauthorizedException('Admin not found');
        }

        const a = admin[0];

        const isValid = await bcrypt.compare(dto.password, a.password);

        if (!isValid) {
            throw new UnauthorizedException('Invalid password');
        }

        const payload = {
            sub: a.id,
            role: 'ADMIN',
        };

        const accessToken = this.jwtService.sign(payload, {
            expiresIn: '15m',
        });

        const refreshToken = this.jwtService.sign(payload, {
            expiresIn: '7d',
        });

        const hashedToken = await bcrypt.hash(refreshToken, 10);

        await this.dataSource.query(
            `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
            [a.id, hashedToken],
        );

        return {
            accessToken,
            refreshToken,
            admin: {
                id: a.id,
                email: a.email,
            },
        };
    }

    async adminRegister(dto: any) {
        const queryRunner = this.dataSource.createQueryRunner();


        try {
            await queryRunner.connect();
            await queryRunner.startTransaction();
            const saltRounds = 10;
            const hashedPassword = await bcrypt.hash(dto.password, saltRounds);

            await queryRunner.query(
                'INSERT INTO admin_users (name ,email,  password, role) VALUES ($1, $2, $3, $4)',
                [dto.full_name, dto.email, hashedPassword, 'ADMIN'],
            );


            await queryRunner.commitTransaction();


        } catch (error) {
            await queryRunner.rollbackTransaction();
            console.error('Error during admin registration:', error);
            throw error; // Rethrow the error to be handled by the caller       
        }

    }

    async isUsernameTaken(username: string): Promise<boolean> {
        const result = await this.dataSource.query(
            `SELECT 1 FROM users WHERE username = $1 LIMIT 1`,
            [username],
        );

        return result.length > 0;
    }

    async initiateRegistration(dto: any) {
        const { username, phone_number } = dto;

        // check username
        const isTaken = await this.isUsernameTaken(username);
        if (isTaken) {
            throw new Error('Username already taken');
        }

        // check phone exists
        const phoneExists = await this.dataSource.query(
            `SELECT 1 FROM user_phone_numbers WHERE phone_number = $1 LIMIT 1`,
            [phone_number],
        );

        if (phoneExists.length) {
            throw new Error('Phone number already registered');
        }

        // generate OTP
        const otp = '123456'; // 🔥 dev mode (later random)

        // store OTP
        // await this.dataSource.query(
        //     `INSERT INTO user_otps (phone_number, otp, expires_at)
        //  VALUES ($1, $2, NOW() + INTERVAL '5 minutes')`,
        //     [phone_number, otp],
        // );

        const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 mins

        await this.dataSource.query(
            `INSERT INTO user_otps (phone_number, otp, expires_at)
             VALUES ($1, $2, $3)`,
            [phone_number, otp, expiresAt],
        );

        // TODO: WhatsApp send (Meta API)
        console.log(`OTP for ${phone_number}: ${otp}`);

        return {
            message: 'OTP sent successfully',
        };
    }

    async verifyOtpAndRegister(dto: any) {
        const queryRunner = this.dataSource.createQueryRunner();

        try {
            await queryRunner.connect();
            await queryRunner.startTransaction();

            const { phone_number, otp } = dto;

            // ✅ Step 1: Get latest OTP
            const otpRecord = await queryRunner.query(
                `SELECT * FROM user_otps
             WHERE phone_number = $1
             AND is_used = false
             ORDER BY id DESC LIMIT 1`,
                [phone_number],
            );

            if (!otpRecord.length) {
                throw new Error('No OTP found. Please request again.');
            }

            const record = otpRecord[0];

            // ✅ Step 2: Attempt limit
            if (record.attempts >= 5) {
                throw new Error('Too many attempts. Try again later.');
            }

            // ✅ Step 3: Expiry check
            if (Date.now() > new Date(record.expires_at).getTime()) {
                throw new Error('OTP expired');
            }

            // ✅ Step 4: Validate OTP
            if (record.otp !== otp) {
                await queryRunner.query(
                    `UPDATE user_otps 
                 SET attempts = attempts + 1 
                 WHERE id = $1`,
                    [record.id],
                );

                throw new Error('Invalid OTP');
            }

            // ✅ Step 5: Mark OTP used
            await queryRunner.query(
                `UPDATE user_otps 
             SET is_used = true 
             WHERE id = $1`,
                [record.id],
            );

            // ✅ Step 6: OPTIONAL EMAIL LOGIC
            let email: string | null = null;

            if (dto.email) {
                // check duplicate email
                const existingEmail = await queryRunner.query(
                    `SELECT 1 FROM users WHERE email = $1 LIMIT 1`,
                    [dto.email],
                );

                if (existingEmail.length) {
                    throw new Error('Email already in use');
                }

                email = dto.email;
            }

            // ✅ Step 7: Hash password
            const hashedPassword = await bcrypt.hash(dto.password, 10);

            // ✅ Step 8: Generate user code
            const userCode = generateUserCode(dto.full_name);

            // ✅ Step 9: Insert user
            const result = await queryRunner.query(
                `INSERT INTO users 
            (full_name, email, password, user_code, username)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id`,
                [
                    dto.full_name,
                    email, // 👈 NULL if not provided
                    hashedPassword,
                    userCode,
                    dto.username,
                ],
            );

            const userId = result[0].id;

            // ✅ Step 10: Insert phone
            await queryRunner.query(
                `INSERT INTO user_phone_numbers 
            (user_id, phone_number, is_primary, is_verified)
            VALUES ($1, $2, true, true)`,
                [userId, phone_number],
            );

            // ✅ Step 11: Create wallet
            await queryRunner.query(
                `INSERT INTO wallets (user_id) VALUES ($1)`,
                [userId],
            );

            await queryRunner.commitTransaction();

            return {
                message: 'User registered successfully',
            };

        } catch (error) {
            await queryRunner.rollbackTransaction();
            console.error('Registration error:', error);
            throw error;
        } finally {
            await queryRunner.release();
        }
    }
}
