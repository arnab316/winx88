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

    async register(dto: any) {
        const queryRunner = this.dataSource.createQueryRunner();
        try {
            await queryRunner.connect();
            await queryRunner.startTransaction();
            const saltRounds = 10;
            const hashedPassword = await bcrypt.hash(dto.password, saltRounds);
            const userCode = generateUserCode(dto.full_name, dto.email);
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

            const user = await this.dataSource.query(
                'SELECT * FROM users WHERE email = $1',
                [dto.email],
            );
            if (!user.length) {
                throw new UnauthorizedException('User not found');
            }
            const u = user[0];

            const isValid = await bcrypt.compare(dto.password, u.password);
            if (!isValid) {
                throw new UnauthorizedException('Invalid password');
            }
            // generate tokens
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
            // store in DB
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
            throw error; // Rethrow the error to be handled by the caller }

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


    try{
        await queryRunner.connect();
        await queryRunner.startTransaction();
        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(dto.password, saltRounds);

        await queryRunner.query(
            'INSERT INTO admin_users (name ,email,  password, role) VALUES ($1, $2, $3, $4)',
            [dto.full_name, dto.email, hashedPassword, 'ADMIN'],
        );
        

        await queryRunner.commitTransaction();


    }catch(error){
        await queryRunner.rollbackTransaction();
        console.error('Error during admin registration:', error);
        throw error; // Rethrow the error to be handled by the caller       
    }
    
}


}
