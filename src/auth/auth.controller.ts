import { Body, Controller, Post,Get, Param, UnauthorizedException, HttpException, HttpStatus } from '@nestjs/common';
import { AuthService } from './auth.service';
import { stat } from 'fs';
import { Code } from 'typeorm';

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
    async login(@Body() dto: any) {
         try{
            const result = await this.authService.login(dto);
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
  async refreshToken(@Body() dto: { refreshToken: string }) {
    const result = await this.authService.refreshToken(dto);
    return {
      status: 'success',
      ...result,
    };
  }

   @Post('logout')
  async logout(@Body() dto: { refreshToken: string }) {
    const result = await this.authService.logout(dto);
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
  async loginAdmin(@Body() dto: any) {
    try {
      const result = await this.authService.adminLogin(dto);
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

}
