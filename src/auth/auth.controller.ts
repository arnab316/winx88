// import { Body, Controller, Post, Get, Param, UnauthorizedException, HttpException, HttpStatus, Res, Req, UseGuards, Inject } from '@nestjs/common';
// import { AuthService } from './auth.service';
// import { stat } from 'fs';
// import { Code } from 'typeorm';
// import type { Request, Response } from 'express';
// import { SuperAdminGuard } from 'src/common/guards/super-admin.guard';
// import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
// import { Logger } from 'winston';
// @Controller('auth')
// export class AuthController {
//   constructor(private authService: AuthService,

//     @Inject(WINSTON_MODULE_PROVIDER)
//     private readonly logger: Logger,) { }

//   @Post('/register')
//   async register(@Body() dto: any) {

//     try {
//       const result = await this.authService.register(dto);
//       return {
//         status: 'success',
//         Code: 201,
//         message: 'User registered successfully',
//         data: result,
//       }
//     } catch (error) {
//       console.error('Error during registration:', error);
//       throw error; // Rethrow the error to be handled by the caller
//     }
//   }
//   @Post('/login')
//   async login(@Body() dto: any, @Req() req: Request, @Res({ passthrough: true }) res: Response & typeof import('express').response) {
//     try {

//       this.logger.info('Login attempt started', {
//         context: AuthController.name,
//         mobile: dto.phone_number,
//         username: dto.username,
//         ip: req.ip,
//       });
//       const result = await this.authService.login(dto);

//       // Set accessToken in HttpOnly cookie
//       res.cookie('accessToken', result.accessToken, {
//         httpOnly: true,
//         secure: process.env.NODE_ENV === 'production', // true in prod (HTTPS only)
//         sameSite: 'strict',
//         maxAge: 15 * 60 * 1000, // 15 minutes
//       });

//       // Set refreshToken in HttpOnly cookie
//       res.cookie('refreshToken', result.refreshToken, {
//         httpOnly: true,
//         secure: process.env.NODE_ENV === 'production',
//         sameSite: 'strict',
//         maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
//       });
//       return {
//         status: 'success',
//         Code: 200,
//         message: 'User logged in successfully',
//         data: result,
//       }
//     } catch (error: any) {
//       this.logger.error('Error during login', {
//         context: AuthController.name,
//         message: error.message,
//         stack: error.stack,
//       });
//       console.error('Error during login:', error);
//       throw error; // Rethrow the error to be handled by the caller
//     }
//   }

//   @Post('refresh-token')
//   async refreshToken(@Req() req: Request, @Res({ passthrough: true }) res: Response & typeof import('express').response) {
//     const token = (req as any).cookies?.refreshToken;
//     if (!token) throw new UnauthorizedException('No refresh token');

//     const result = await this.authService.refreshToken({ refreshToken: token });

//     res.cookie('accessToken', result.accessToken, {
//       httpOnly: true,
//       secure: process.env.NODE_ENV === 'production',
//       sameSite: 'strict',
//       maxAge: 15 * 60 * 1000,
//     });

//     return { status: 'success' };
//   }

// @Post('logout')
// async logout(
//   @Body() dto: { refreshToken: string },
//   @Req() req: Request,
//   @Res({ passthrough: true })
//   res: Response & typeof import('express').response,
// ) {
//   try {
//     this.logger.info('Logout attempt started', {
//       context: AuthController.name,
//       ip: (req as any).ip,
//     });

//     const result = await this.authService.logout(dto);

//     res.clearCookie('accessToken');
//     res.clearCookie('refreshToken');

//     this.logger.info('User logged out successfully', {
//       context: AuthController.name,
//       body: dto.refreshToken,
//       ip: (req as any).ip,
//     });

//     return {
//       status: 'success',
//       ...result,
//     };
//   } catch (error: any) {
//     this.logger.error('Logout failed', {
//       context: AuthController.name,
//       ip: (req as any).ip,
//       message: error.message,
//       stack: error.stack,
//     });

//     throw error;
//   }
// }
//   @Get('/profile/:userId')
//   async getProfile(@Param('userId') userId: string) {
//     try {
//       const result = await this.authService.getProfile({ userId });
//       return {
//         status: 'success',
//         Code: 200,
//         message: 'User profile retrieved successfully',
//         data: result,
//       }
//     } catch (error) {
//       console.error('Error fetching profile:', error);
//       throw error;
//     }
//   }


//   @Post('admin-login')
//   async loginAdmin(@Body() dto: any, @Res({ passthrough: true }) res: Response & typeof import('express').response) {
//     try {
//       const result = await this.authService.adminLogin(dto);

//       res.cookie('accessToken', result.accessToken, {
//         httpOnly: true,
//         secure: process.env.NODE_ENV === 'production',
//         sameSite: 'strict',
//         maxAge: 15 * 60 * 1000,
//       });

//       res.cookie('refreshToken', result.refreshToken, {
//         httpOnly: true,
//         secure: process.env.NODE_ENV === 'production',
//         sameSite: 'strict',
//         maxAge: 7 * 24 * 60 * 60 * 1000,
//       });
//       return {
//         status: 'success',
//         code: 200,
//         message: 'Admin logged in successfully',
//         data: result,
//       };
//     } catch (error: any) {
//       console.error('Error during admin login:', error);

//       if (error instanceof UnauthorizedException) {
//         return {
//           status: 'error',
//           code: 401,
//           message: error.message,
//         };
//       }

//       return {
//         status: 'error',
//         code: 500,
//         message: 'Internal server error',
//       };
//     }
//   }
//   // New Login Register methods
//   // 🟢 Send OTP
//   @Post('send-otp')
//   async sendOtp(@Body() dto: any) {
//     try {
//       const result = await this.authService.initiateRegistration(dto);
//       return {
//         success: true,
//         message: result.message,
//       };
//     } catch (error: any) {
//       throw new HttpException(
//         {
//           success: false,
//           message: error.message || 'Failed to send OTP',
//         },
//         HttpStatus.BAD_REQUEST,
//       );
//     }
//   }

//   // 🔵 Verify OTP + Register
//   @Post('verify-otp-register')
//   async verifyOtpAndRegister(@Body() dto: any) {
//     try {
//       const result = await this.authService.verifyOtpAndRegister(dto);

//       return {
//         success: true,
//         message: result.message,
//       };
//     } catch (error: any) {
//       throw new HttpException(
//         {
//           success: false,
//           message: error.message || 'Registration failed',
//         },
//         HttpStatus.BAD_REQUEST,
//       );
//     }
//   }
//   @Post('admin-register')
//   @UseGuards(SuperAdminGuard)  // ← THE FIX: only SUPER_ADMIN can create admins

//   async adminRegister(@Body() dto: any) {
//     try {
//       const result = await this.authService.adminRegister(dto);
//       return {
//         status: 'success',
//         code: 201,
//         message: 'Admin registered successfully',
//         data: result,
//       };
//     } catch (error: any) {
//       console.error('Error during admin registration:', error);

//     }


//   }

// }


// src/auth/auth.controller.ts
import {
  Body, Controller, Post, Get, Param, Query,
  UnauthorizedException, HttpException, HttpStatus,
  Res, Req, UseGuards, Inject,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { SuperAdminGuard } from 'src/common/guards/super-admin.guard';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import type { Request, Response } from 'express';

@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    @Inject(WINSTON_MODULE_PROVIDER)
    private readonly logger: Logger,
  ) {}

  // ═════════════════════════════════════════════════════════════
  // REGISTER — No OTP required at signup
  //   User creates account with phone (UNVERIFIED).
  //   Phone verification is a separate step done after login.
  //
  //   POST /auth/register
  //   body: { full_name, username, phone_number, password, email? }
  // ═════════════════════════════════════════════════════════════
  @Post('register')
async register(
  @Body() dto: any,
  @Req() req: Request,
  @Res({ passthrough: true }) res: Response & typeof import('express').response,
) {
  this.logger.info('Registration attempt', {
    context: AuthController.name,
    username: dto.username,
    phone: dto.phone_number,
    ip: req.ip,
  });

  try {
    const result = await this.authService.register(dto);

    // 🍪 Set cookies — user is immediately authenticated after register
    res.cookie('accessToken', result.accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });
    res.cookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    this.logger.info('Registration + auto-login successful', {
      context: AuthController.name,
      userId: result.userId,
      username: result.username,
      phoneVerified: result.phoneVerified,
      ip: req.ip,
    });

    // Fraud tracking — capture IP + device fingerprint (best-effort).
    await this.authService.recordLoginEvent(
      result.userId,
      'REGISTER',
      req.ip,
      (req.headers['x-device-fingerprint'] as string) || undefined,
    );

    return {
      success: true,
      code: 201,
      message: result.message,
      data: result,
    };
  } catch (error: any) {
    this.logger.error('Registration failed', {
      context: AuthController.name,
      username: dto.username,
      phone: dto.phone_number,
      ip: req.ip,
      message: error.message,
      stack: error.stack,
    });
    throw new HttpException(
      { success: false, message: error.message || 'Registration failed' },
      error?.status || HttpStatus.BAD_REQUEST,
    );
  }
}


  // ═════════════════════════════════════════════════════════════
  // CHECK USERNAME — live availability check for signup forms
  //   (main site + partners portal type-as-you-go). Public.
  //   GET /auth/check-username?username=foo
  //   Same exact-match rule the register duplicate check uses.
  // ═════════════════════════════════════════════════════════════
  @Get('check-username')
  async checkUsername(@Query('username') username?: string) {
    const name = username?.trim();
    if (!name) {
      return {
        success: true,
        username: username ?? '',
        available: false,
        message: 'Username is required',
      };
    }
    const taken = await this.authService.isUsernameTaken(name);
    return {
      success: true,
      username: name,
      available: !taken,
      message: taken ? 'Username already exists' : 'Username is available',
    };
  }

  // ═════════════════════════════════════════════════════════════
  // SEND OTP — request phone verification after signup
  //   POST /auth/send-otp
  //   body: { phone_number, username? }
  // ═════════════════════════════════════════════════════════════
  @Post('send-otp')
  async sendOtp(@Body() dto: any, @Req() req: Request) {
    this.logger.info('OTP send requested', {
      context: AuthController.name,
      phone: dto.phone_number,
      ip: req.ip,
    });
    try {
      const result = await this.authService.sendOtp(dto);
      this.logger.info('OTP sent successfully', {
        context: AuthController.name,
        phone: dto.phone_number,
        ip: req.ip,
      });
      return { success: true, message: result.message };
    } catch (error: any) {
      this.logger.error('OTP send failed', {
        context: AuthController.name,
        phone: dto.phone_number,
        ip: req.ip,
        message: error.message,
      });
      throw new HttpException(
        { success: false, message: error.message || 'Failed to send OTP' },
        error?.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  // ═════════════════════════════════════════════════════════════
  // VERIFY PHONE — submit OTP to verify phone number
  //   Can be done any time after registration.
  //   POST /auth/verify-phone
  //   body: { phone_number, otp }
  // ═════════════════════════════════════════════════════════════
  @Post('verify-phone')
  async verifyPhone(@Body() dto: any, @Req() req: Request) {
    this.logger.info('Phone verification started', {
      context: AuthController.name,
      phone: dto.phone_number,
      ip: req.ip,
    });
    try {
      const result = await this.authService.verifyPhone(dto);
      this.logger.info('Phone verified successfully', {
        context: AuthController.name,
        phone: dto.phone_number,
        ip: req.ip,
      });
      return { success: true, message: result.message, phoneVerified: result.phoneVerified };
    } catch (error: any) {
      this.logger.error('Phone verification failed', {
        context: AuthController.name,
        phone: dto.phone_number,
        ip: req.ip,
        message: error.message,
      });
      throw new HttpException(
        { success: false, message: error.message || 'Verification failed' },
        error?.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  // ═════════════════════════════════════════════════════════════
  // LOGIN
  //   POST /auth/login
  //   body: { identifier, password }
  //   identifier = email | phone_number | username (any one)
  //   Response includes phoneVerified flag.
  // ═════════════════════════════════════════════════════════════
  @Post('login')
  async login(
    @Body() dto: any,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response & typeof import('express').response,
  ) {
    this.logger.info('Login attempt', {
      context: AuthController.name,
      identifier: dto.identifier || dto.phone_number || dto.username || dto.email,
      ip: req.ip,
    });
    try {
      const result = await this.authService.login(dto);

      res.cookie('accessToken', result.accessToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });
      res.cookie('refreshToken', result.refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });

      this.logger.info('Login successful', {
        context: AuthController.name,
        userId: result.user.id,
        username: result.user.username,
        phoneVerified: result.user.phoneVerified,
        ip: req.ip,
      });

      // Fraud tracking — capture IP + device fingerprint (best-effort).
      await this.authService.recordLoginEvent(
        result.user.id,
        'LOGIN',
        req.ip,
        (req.headers['x-device-fingerprint'] as string) || undefined,
      );

      return {
        success: true,
        code: 200,
        message: 'Logged in successfully',
        data: result,
      };
    } catch (error: any) {
      this.logger.error('Login failed', {
        context: AuthController.name,
        ip: req.ip,
        message: error.message,
      });
      throw new HttpException(
        { success: false, message: error.message || 'Login failed' },
        error?.status || HttpStatus.UNAUTHORIZED,
      );
    }
  }

  // ═════════════════════════════════════════════════════════════
  // REFRESH TOKEN
  //   POST /auth/refresh-token
  // ═════════════════════════════════════════════════════════════
  @Post('refresh-token')
  async refreshToken(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response & typeof import('express').response,
  ) {
    const token = (req as any).cookies?.refreshToken;
    if (!token) throw new UnauthorizedException('No refresh token');

    const result = await this.authService.refreshToken({ refreshToken: token });

    res.cookie('accessToken', result.accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 15 * 60 * 1000,
    });

    return { success: true };
  }

  // ═════════════════════════════════════════════════════════════
  // LOGOUT
  //   POST /auth/logout
  //   body: { refreshToken }
  // ═════════════════════════════════════════════════════════════
  @Post('logout')
  async logout(
    @Body() dto: { refreshToken: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response & typeof import('express').response,
  ) {
    this.logger.info('Logout attempt', { context: AuthController.name, ip: req.ip });
    try {
      const result = await this.authService.logout(dto);
      res.clearCookie('accessToken');
      res.clearCookie('refreshToken');
      this.logger.info('Logout successful', { context: AuthController.name, ip: req.ip });
      return { success: true, ...result };
    } catch (error: any) {
      this.logger.error('Logout failed', {
        context: AuthController.name,
        ip: req.ip,
        message: error.message,
      });
      throw error;
    }
  }

  // ═════════════════════════════════════════════════════════════
  // GET PROFILE (public-ish)
  //   GET /auth/profile/:userId
  // ═════════════════════════════════════════════════════════════
  @Get('profile/:userId')
  async getProfile(@Param('userId') userId: string) {
    try {
      const result = await this.authService.getProfile({ userId });
      return { success: true, code: 200, message: 'Profile retrieved', data: result };
    } catch (error: any) {
      throw new HttpException(
        { success: false, message: error.message || 'Failed' },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN LOGIN
  //   POST /auth/admin-login
  // ═════════════════════════════════════════════════════════════
  @Post('admin-login')
  async loginAdmin(
    @Body() dto: any,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response & typeof import('express').response,
  ) {
    this.logger.info('Admin login attempt', {
      context: AuthController.name,
      email: dto.email,
      ip: req.ip,
    });
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

      this.logger.info('Admin login successful', {
        context: AuthController.name,
        adminId: result.admin.id,
        role: result.admin.role,
        ip: req.ip,
      });

      return { success: true, code: 200, message: 'Admin logged in successfully', data: result };
    } catch (error: any) {
      this.logger.error('Admin login failed', {
        context: AuthController.name,
        email: dto.email,
        ip: req.ip,
        message: error.message,
      });
      throw new HttpException(
        { success: false, message: error.message || 'Login failed' },
        error?.status || HttpStatus.UNAUTHORIZED,
      );
    }
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN REGISTER (SUPER_ADMIN only)
  //   POST /auth/admin-register
  //   body: { full_name, email, password, role? }
  // ═════════════════════════════════════════════════════════════
  @Post('admin-register')
  @UseGuards(SuperAdminGuard)
  async adminRegister(@Body() dto: any, @Req() req: Request) {
    this.logger.info('Admin register attempt', {
      context: AuthController.name,
      email: dto.email,
      ip: req.ip,
    });
    try {
      const result = await this.authService.adminRegister(dto);
      this.logger.info('Admin registered', {
        context: AuthController.name,
        email: dto.email,
        ip: req.ip,
      });
      return { success: true, code: 201, message: result.message };
    } catch (error: any) {
      this.logger.error('Admin register failed', {
        context: AuthController.name,
        ip: req.ip,
        message: error.message,
      });
      throw new HttpException(
        { success: false, message: error.message || 'Registration failed' },
        error?.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  // ─── Legacy endpoint (backward compat) ──────────────────────
  // Old flow: verify-otp-register kept so existing Postman tests don't break
  // Now simply calls register() internally
  @Post('verify-otp-register')
  async verifyOtpAndRegister(@Body() dto: any, @Req() req: Request, @Res({ passthrough: true }) res: Response & typeof import('express').response) {

  return this.register(dto, req, res);
  }
  @Get('isuername-taken/:username')
  async isUsernameTaken(@Param('username') username: string) {
    try {
      const result = await this.authService.isUsernameTaken(username);
      return { success: true, code: 200, message: 'Check completed', data: { isTaken: result } };
    } catch (error: any) {
      throw new HttpException(
        { success: false, message: error.message || 'Failed to check username' },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    } 
  }


 
// 🟠 Step 1: send password-reset OTP via SMS (LAAFFIC)
@Post('forgot-password')
async forgotPassword(@Body() dto: { phone_number: string }) {
  try {
    const result = await this.authService.forgotPassword(dto);
    return { success: true, message: result.message };
  } catch (error: any) {
    throw new HttpException(
      { success: false, message: error.message || 'Failed to send reset OTP' },
      HttpStatus.BAD_REQUEST,
    );
  }
}
 
 
// 🟣 Step 2: verify the OTP → returns a short-lived resetToken
@Post('verify-reset-otp')
async verifyResetOtp(@Body() dto: { phone_number: string; otp: string }) {
  try {
    const result = await this.authService.verifyResetOtp(dto);
    return {
      success: true,
      message: result.message,
      resetToken: result.resetToken,
    };
  } catch (error: any) {
    throw new HttpException(
      { success: false, message: error.message || 'OTP verification failed' },
      HttpStatus.BAD_REQUEST,
    );
  }
}
 
 
// 🟢 Step 3: consume resetToken + set new password
@Post('reset-password')
async resetPassword(@Body() dto: { resetToken: string; new_password: string }) {
  try {
    const result = await this.authService.resetPassword(dto);
    return { success: true, message: result.message };
  } catch (error: any) {
    throw new HttpException(
      { success: false, message: error.message || 'Password reset failed' },
      HttpStatus.BAD_REQUEST,
    );
  }
}

// 🔑 Authenticated: a logged-in user changes their own password.
//   Requires the current password as proof of ownership (distinct from the
//   unauthenticated phone-OTP forgot/reset flow above).
//   POST /auth/change-password
//   body: { current_password, new_password }
@UseGuards(JwtAuthGuard)
@Post('change-password')
async changePassword(
  @Req() req: any,
  @Body() dto: { current_password: string; new_password: string },
) {
  try {
    const result = await this.authService.changePassword(req.user?.sub, dto);
    return { success: true, message: result.message };
  } catch (error: any) {
    throw new HttpException(
      { success: false, message: error.message || 'Failed to change password' },
      error?.status || HttpStatus.BAD_REQUEST,
    );
  }
}
}