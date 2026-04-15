import { Body, Controller, Post,Get, Param, UnauthorizedException, HttpException, HttpStatus, Res, Req } from '@nestjs/common';
import { AuthService } from './auth.service';
import { stat } from 'fs';
import { Code } from 'typeorm';
import { Response } from 'express';

@Controller('auth')
export class AuthController {
    constructor(private authService: AuthService) {}

   @Post('/register')
    async register(@Body() dto: any) {

        try{
            const result = await this.authService.register(dto);
             return {
                status: 'success',
                Code: 201,
                message: 'User registered successfully',
                data: result,
             }
        }catch(error){
            console.error('Error during registration:', error);
            throw error; // Rethrow the error to be handled by the caller
        }
    }
    @Post('/login')
    async login(@Body() dto: any,  @Res({ passthrough: true }) res: Response & typeof import('express').response) {
         try{
            const result = await this.authService.login(dto);

             // Set accessToken in HttpOnly cookie
      res.cookie('accessToken', result.accessToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production', // true in prod (HTTPS only)
        sameSite: 'strict',
        maxAge: 15 * 60 * 1000, // 15 minutes
      });

      // Set refreshToken in HttpOnly cookie
      res.cookie('refreshToken', result.refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      });
             return {
                status: 'success',
                Code: 200,
                message: 'User logged in successfully',
                data: result,
             }
        }catch(error){
            console.error('Error during login:', error);
            throw error; // Rethrow the error to be handled by the caller
        }
    }

@Post('refresh-token')
async refreshToken(@Req() req: Request, @Res({ passthrough: true }) res: Response & typeof import('express').response) {
  const token = (req as any).cookies?.refreshToken;
  if (!token) throw new UnauthorizedException('No refresh token');

  const result = await this.authService.refreshToken({ refreshToken: token });

  res.cookie('accessToken', result.accessToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 15 * 60 * 1000,
  });

  return { status: 'success' };
}

   @Post('logout')
  async logout(@Body() dto: { refreshToken: string },  @Res({ passthrough: true }) res: Response & typeof import('express').response) {
    const result = await this.authService.logout(dto);

     res.clearCookie('accessToken');
    res.clearCookie('refreshToken');
    return {
      status: 'success',
      ...result,
    };
  }
  @Get('/profile/:userId')
  async getProfile(@Param('userId') userId: string) {
      try {
        const result = await this.authService.getProfile({ userId });
        return{
            status: 'success',
            Code: 200,
            message: 'User profile retrieved successfully',
            data: result,
        }
      } catch (error) {
        console.error('Error fetching profile:', error);
        throw error;
      }
  }


   @Post('admin-login')
  async loginAdmin(@Body() dto: any, @Res({ passthrough: true }) res: Response & typeof import('express').response) {
    try {
      const result = await this.authService.adminLogin(dto);

       res.cookie('accessToken', result.accessToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 15 * 60 * 1000,
      });

      res.cookie('refreshToken', result.refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });
      return {
        status: 'success',
        code: 200,
        message: 'Admin logged in successfully',
        data: result,
      };
    } catch (error : any) {
      console.error('Error during admin login:', error);

      if (error instanceof UnauthorizedException) {
        return {
          status: 'error',
          code: 401,
          message: error.message,
        };
      }

      return {
        status: 'error',
        code: 500,
        message: 'Internal server error',
      };
    }
  }
// New Login Register methods
   // 🟢 Send OTP
  @Post('send-otp')
  async sendOtp(@Body() dto: any) {
    try {
      const result = await this.authService.initiateRegistration(dto);
      return {
        success: true,
        message: result.message,
      };
    } catch (error:any) {
      throw new HttpException(
        {
          success: false,
          message: error.message || 'Failed to send OTP',
        },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  // 🔵 Verify OTP + Register
  @Post('verify-otp-register')
  async verifyOtpAndRegister(@Body() dto: any) {
    try {
      const result = await this.authService.verifyOtpAndRegister(dto);

      return {
        success: true,
        message: result.message,
      };
    } catch (error:any) {
      throw new HttpException(
        {
          success: false,
          message: error.message || 'Registration failed',
        },
        HttpStatus.BAD_REQUEST,
      );
    }
  }
@Post('admin-register')
  async adminRegister(@Body() dto: any) {
    try {
      const result = await this.authService.adminRegister(dto);
      return {
        status: 'success',
        code: 201,
        message: 'Admin registered successfully',
        data: result,
      };
    } catch (error : any) {
      console.error('Error during admin registration:', error); 

    }


  }

}