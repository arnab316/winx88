// import {
//   Controller,
//   Post,
//   Delete,
//   Patch,
//   Param,
//   Req,
//   Body,
//   UseGuards,
//   BadRequestException,
//   Get,
//   Inject,
// } from '@nestjs/common';
// import { UserService } from './user.service';
// import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
// import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
// import { Logger } from 'winston';
// import type { Request, Response } from 'express';

// @UseGuards(JwtAuthGuard)
// @Controller('user')
// export class UserController {
//   constructor(
//     private userService: UserService,
//     @Inject(WINSTON_MODULE_PROVIDER)
//     private readonly logger: Logger,
//   ) { }

// @Get('profile')
// async getProfile(@Req() req) {
//   try {
//     const userId = req.user?.sub;

//     this.logger.info('Profile fetch started', {
//       context: UserController.name,
//       userId,
//       ip: (req as any).ip,
//     });

//     const user = await this.userService.getProfile(userId);

//     this.logger.info('Profile fetched successfully', {
//       context: UserController.name,
//       userId,
//       ip: (req as any).ip,
//     });

//     return {
//       success: true,
//       message: 'User profile retrieved successfully',
//       data: user,
//     };
//   } catch (error: any) {
//     this.logger.error('Profile fetch failed', {
//       context: UserController.name,
//       userId: req.user?.sub,
//       ip: (req as any).ip,
//       message: error.message,
//       stack: error.stack,
//     });

//     throw error;
//   }
// }
//     @Post('update-profile')
//     async updateProfile(@Req() req, @Body() dto: any) {
//         try {
//             const userId = req.user?.id;
//             const user = await this.userService.updateProfile(userId, dto);
//             return {
//                 success: true,
//                 message: 'Profile updated successfully',
//                 data: user,
//             }
//         } catch (error) {
//             throw error;
//         }
//     }

//     @Post('add-phone')
//     async addPhoneNumber(@Req() req, @Body() dto:{ phoneNumber: string }) {
//         try {
//             const userId = req.user?.sub;
//             const user = await this.userService.addPhone(userId, dto.phoneNumber);
//             return {
//                 success: true,
//                 message: 'Phone number added successfully',
//                 data: user,
//             }


//         } catch (error) {
//             throw error;
//         }
//     }
//      @Patch('phone/:phoneId/primary')
//   async setPrimaryPhone(@Req() req, @Param('phoneId') phoneId: string) {
//     try {
//       const userId = req.user?.sub; // from JWT

//       if (!userId) {
//         throw new BadRequestException('User not authenticated');
//       }

//       const result = await this.userService.setPrimaryPhone(
//         userId,
//         Number(phoneId),
//       );

//       return {
//         status: 'success',
//         code: 200,
//         message: result.message,
//       };
//     } catch (error:any) {
//       console.error('Error setting primary phone:', error);

//       return {
//         status: 'error',
//         code: error.status || 500,
//         message: error.message || 'Internal server error',
//       };
//     }
//   }

//   // ---------------- DELETE PHONE ----------------
//   @Delete('phone/:phoneId')
//   async deletePhone(@Req() req, @Param('phoneId') phoneId: string) {
//     try {
//       const userId = req.user?.sub;

//       if (!userId) {
//         throw new BadRequestException('User not authenticated');
//       }

//       const result = await this.userService.deletePhone(
//         userId,
//         Number(phoneId),
//       );

//       return {
//         status: 'success',
//         code: 200,
//         message: result.message,
//       };
//     } catch (error:any) {
//       console.error('Error deleting phone:', error);

//       return {
//         status: 'error',
//         code: error.status || 500,
//         message: error.message || 'Internal server error',
//       };
//     }
//   }

//   @Patch('phone/:phoneId/verify')
// async verifyPhone(@Req() req, @Param('phoneId') phoneId: string) {
//   try {
//     const userId = req.user?.sub;

//     this.logger.info('Phone verification started', {
//       context: UserController.name,
//       userId,
//       phoneId,
//       ip: (req as any).ip,
//     });

//     if (!userId) {
//       this.logger.warn('Unauthenticated phone verification attempt', {
//         context: UserController.name,
//         phoneId,
//         ip: (req as any).ip,
//       });

//       throw new BadRequestException('User not authenticated');
//     }

//     const result = await this.userService.verifyPhone(
//       userId,
//       Number(phoneId),
//     );

//     this.logger.info('Phone verified successfully', {
//       context: UserController.name,
//       userId,
//       phoneId,
//       ip: (req as any).ip,
//     });

//     return {
//       status: 'success',
//       code: 200,
//       message: result.message,
//     };
//   } catch (error: any) {
//     this.logger.error('Phone verification failed', {
//       context: UserController.name,
//       userId: req.user?.sub,
//       phoneId,
//       ip: (req as any).ip,
//       message: error.message,
//       stack: error.stack,
//     });

//     return {
//       status: 'error',
//       code: error.status || 500,
//       message: error.message || 'Internal server error',
//     };
//   }
// }
//   @Get('all')
//   async getAllUsers() {
//     try {
//       const users = await this.userService.getAllUsers();
//       return {
//         success: true,
//         message: 'Users retrieved successfully',
//         data: users,
//       };
//     } catch (error) {
//       throw error;
//     }}
//   @Get('user-details/:userId')
//     async getUserDetailsByAdmin(@Req() req, @Param('userId') userId: string) {
//         try {
//             const result = await this.userService.getUserDetailsByAdmin(
//                 Number(userId),
//             );  
//             return {
//                 status: 'success',
//                 code: 200,  
//                 message: 'User details retrieved successfully',
//                 data: result,
//             };
//         } catch (error:any) {
//             console.error('Error retrieving user details:', error); 
//         }
//       }

      
// }



// src/user/user.controller.ts
import {
  Controller,
  Post,
  Delete,
  Patch,
  Param,
  Req,
  Body,
  Query,
  UseGuards,
  BadRequestException,
  Get,
  Inject,
  ParseIntPipe,
  DefaultValuePipe,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { UserService } from './user.service';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { AdminGuard } from 'src/common/guards/admin.guard';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';

@UseGuards(JwtAuthGuard)
@Controller('user')
export class UserController {
  constructor(
    private userService: UserService,
    @Inject(WINSTON_MODULE_PROVIDER)
    private readonly logger: Logger,
  ) {}

  // ╔═══════════════════════════════════════════════════════════╗
  // ║                    USER ROUTES (JWT)                      ║
  // ╚═══════════════════════════════════════════════════════════╝

  // GET /user/profile
  @Get('profile')
  async getProfile(@Req() req: any) {
    const userId = req.user?.sub;
    this.logger.info('Profile fetch started', {
      context: UserController.name, userId, ip: req.ip,
    });
    try {
      const data = await this.userService.getProfile(userId);
      this.logger.info('Profile fetched successfully', {
        context: UserController.name, userId, ip: req.ip,
      });
      return { success: true, message: 'User profile retrieved successfully', data };
    } catch (error: any) {
      this.logger.error('Profile fetch failed', {
        context: UserController.name, userId, ip: req.ip,
        message: error.message, stack: error.stack,
      });
      throw new HttpException(
        { success: false, message: error?.message || 'Failed' },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // POST /user/update-profile
  // body: { full_name?, email?, dob?, profile_image_url? }
  @Post('update-profile')
  async updateProfile(@Req() req: any, @Body() dto: any) {
    const userId = req.user?.sub;   // BUG FIX: was req.user?.id
    this.logger.info('Profile update started', {
      context: UserController.name, userId, ip: req.ip,
      fields: Object.keys(dto),
    });
    try {
      const data = await this.userService.updateProfile(userId, dto);
      this.logger.info('Profile updated successfully', {
        context: UserController.name, userId, ip: req.ip,
      });
      return { success: true, message: 'Profile updated successfully', data };
    } catch (error: any) {
      this.logger.error('Profile update failed', {
        context: UserController.name, userId, ip: req.ip,
        message: error.message, stack: error.stack,
      });
      throw new HttpException(
        { success: false, message: error?.message || 'Failed' },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // POST /user/add-phone
  @Post('add-phone')
  async addPhoneNumber(@Req() req: any, @Body() dto: { phoneNumber: string }) {
    const userId = req.user?.sub;
    this.logger.info('Add phone started', {
      context: UserController.name, userId, ip: req.ip,
    });
    try {
      const data = await this.userService.addPhone(userId, dto.phoneNumber);
      this.logger.info('Phone added successfully', {
        context: UserController.name, userId, ip: req.ip,
      });
      return { success: true, message: 'Phone number added successfully', data };
    } catch (error: any) {
      this.logger.error('Add phone failed', {
        context: UserController.name, userId, ip: req.ip,
        message: error.message, stack: error.stack,
      });
      throw new HttpException(
        { success: false, message: error?.message || 'Failed' },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // PATCH /user/phone/:phoneId/primary
  @Patch('phone/:phoneId/primary')
  async setPrimaryPhone(
    @Req() req: any,
    @Param('phoneId', ParseIntPipe) phoneId: number,
  ) {
    const userId = req.user?.sub;
    this.logger.info('Set primary phone started', {
      context: UserController.name, userId, phoneId, ip: req.ip,
    });
    try {
      const data = await this.userService.setPrimaryPhone(userId, phoneId);
      this.logger.info('Primary phone set successfully', {
        context: UserController.name, userId, phoneId, ip: req.ip,
      });
      return { success: true, code: 200, message: data.message };
    } catch (error: any) {
      this.logger.error('Set primary phone failed', {
        context: UserController.name, userId, phoneId, ip: req.ip,
        message: error.message, stack: error.stack,
      });
      throw new HttpException(
        { success: false, message: error?.message || 'Failed' },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // DELETE /user/phone/:phoneId
  @Delete('phone/:phoneId')
  async deletePhone(
    @Req() req: any,
    @Param('phoneId', ParseIntPipe) phoneId: number,
  ) {
    const userId = req.user?.sub;
    this.logger.info('Delete phone started', {
      context: UserController.name, userId, phoneId, ip: req.ip,
    });
    try {
      const data = await this.userService.deletePhone(userId, phoneId);
      this.logger.info('Phone deleted successfully', {
        context: UserController.name, userId, phoneId, ip: req.ip,
      });
      return { success: true, code: 200, message: data.message };
    } catch (error: any) {
      this.logger.error('Delete phone failed', {
        context: UserController.name, userId, phoneId, ip: req.ip,
        message: error.message, stack: error.stack,
      });
      throw new HttpException(
        { success: false, message: error?.message || 'Failed' },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // PATCH /user/phone/:phoneId/verify
  @Patch('phone/:phoneId/verify')
  async verifyPhone(
    @Req() req: any,
    @Param('phoneId', ParseIntPipe) phoneId: number,
  ) {
    const userId = req.user?.sub;
    this.logger.info('Phone verification started', {
      context: UserController.name, userId, phoneId, ip: req.ip,
    });
    try {
      const data = await this.userService.verifyPhone(userId, phoneId);
      this.logger.info('Phone verified successfully', {
        context: UserController.name, userId, phoneId, ip: req.ip,
      });
      return { success: true, code: 200, message: data.message };
    } catch (error: any) {
      this.logger.error('Phone verification failed', {
        context: UserController.name, userId, phoneId, ip: req.ip,
        message: error.message, stack: error.stack,
      });
      throw new HttpException(
        { success: false, message: error?.message || 'Failed' },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ╔═══════════════════════════════════════════════════════════╗
  // ║                    ADMIN ROUTES                           ║
  // ║  All below require AdminGuard + class-level JwtAuthGuard  ║
  // ╚═══════════════════════════════════════════════════════════╝

  // GET /user/admin/all?page=1&limit=20
  @UseGuards(AdminGuard)
  @Get('admin/all')
  async getAllUsers(
    @Req() req: any,
    @Query('page',  new DefaultValuePipe(1),  ParseIntPipe) page:  number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    this.logger.info('Admin: list users started', {
      context: UserController.name, adminId: req.user?.sub,
      page, limit, ip: req.ip,
    });
    try {
      const data = await this.userService.getAllUsers(page, limit);
      this.logger.info('Admin: users listed', {
        context: UserController.name, adminId: req.user?.sub,
        total: data.total, ip: req.ip,
      });
      return { success: true, message: 'Users retrieved successfully', ...data };
    } catch (error: any) {
      this.logger.error('Admin: list users failed', {
        context: UserController.name, adminId: req.user?.sub,
        ip: req.ip, message: error.message, stack: error.stack,
      });
      throw new HttpException(
        { success: false, message: error?.message || 'Failed' },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // GET /user/admin/search?q=alice
  @UseGuards(AdminGuard)
  @Get('admin/search')
  async searchUser(@Req() req: any, @Query('q') q: string) {
    this.logger.info('Admin: search users started', {
      context: UserController.name, adminId: req.user?.sub,
      query: q, ip: req.ip,
    });
    try {
      if (!q?.trim()) throw new BadRequestException('Search query required');
      const data = await this.userService.searchUser(q.trim());
      this.logger.info('Admin: search completed', {
        context: UserController.name, adminId: req.user?.sub,
        query: q, results: data.length, ip: req.ip,
      });
      return { success: true, count: data.length, data };
    } catch (error: any) {
      this.logger.error('Admin: search users failed', {
        context: UserController.name, adminId: req.user?.sub,
        query: q, ip: req.ip, message: error.message,
      });
      throw new HttpException(
        { success: false, message: error?.message || 'Failed' },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // GET /user/admin/:userId
  // (replaces old /user/user-details/:userId)
  @UseGuards(AdminGuard)
  @Get('admin/:userId')
  async getUserDetailsByAdmin(
    @Req() req: any,
    @Param('userId', ParseIntPipe) userId: number,
  ) {
    this.logger.info('Admin: get user details started', {
      context: UserController.name, adminId: req.user?.sub,
      targetUserId: userId, ip: req.ip,
    });
    try {
      const data = await this.userService.getUserDetailsByAdmin(userId);
      this.logger.info('Admin: user details fetched', {
        context: UserController.name, adminId: req.user?.sub,
        targetUserId: userId, ip: req.ip,
      });
      return { success: true, code: 200, message: 'User details retrieved successfully', data };
    } catch (error: any) {
      this.logger.error('Admin: get user details failed', {
        context: UserController.name, adminId: req.user?.sub,
        targetUserId: userId, ip: req.ip,
        message: error.message, stack: error.stack,
      });
      throw new HttpException(
        { success: false, message: error?.message || 'Failed' },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // GET /user/admin/:userId/compliance?keyword=
  //   Fraud / linked-accounts check: the user's own device fingerprints +
  //   IPs, plus other accounts sharing any fingerprint or IP.
  @UseGuards(AdminGuard)
  @Get('admin/:userId/compliance')
  async complianceCheck(
    @Req() req: any,
    @Param('userId', ParseIntPipe) userId: number,
    @Query('keyword') keyword?: string,
  ) {
    try {
      const data = await this.userService.getComplianceCheck(userId, keyword);
      return { success: true, code: 200, message: 'Compliance check', data };
    } catch (error: any) {
      throw new HttpException(
        { success: false, message: error?.message || 'Failed' },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // PATCH /user/admin/:userId
  // body: { full_name?, email?, username?, dob?,
  //         vip_level?, account_status?, password? }
  // Password is plain text — service hashes before saving.
  // account_status: 'ACTIVE' | 'BLOCKED' | 'SUSPENDED'
  @UseGuards(AdminGuard)
  @Patch('admin/:userId')
  async adminEditUser(
    @Req() req: any,
    @Param('userId', ParseIntPipe) userId: number,
    @Body() dto: {
      full_name?:      string;
      email?:          string;
      username?:       string;
      dob?:            string;
      vip_level?:      number;
      account_status?: 'ACTIVE' | 'BLOCKED' | 'SUSPENDED';
      password?:       string;
    },
  ) {
    // Never log the password — log other field names only
    const fieldsChanged = Object.keys(dto).filter(k => k !== 'password');
    this.logger.info('Admin: edit user started', {
      context: UserController.name, adminId: req.user?.sub,
      targetUserId: userId, fields: fieldsChanged,
      passwordReset: !!dto.password, ip: req.ip,
    });
    try {
      const data = await this.userService.adminEditUser(userId, dto);
      this.logger.info('Admin: user edited successfully', {
        context: UserController.name, adminId: req.user?.sub,
        targetUserId: userId, fields: fieldsChanged, ip: req.ip,
      });
      return { success: true, message: 'User updated successfully', data };
    } catch (error: any) {
      this.logger.error('Admin: edit user failed', {
        context: UserController.name, adminId: req.user?.sub,
        targetUserId: userId, ip: req.ip,
        message: error.message, stack: error.stack,
      });
      throw new HttpException(
        { success: false, message: error?.message || 'Failed' },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // PATCH /user/admin/:userId/phone/:phoneId/primary
  @UseGuards(AdminGuard)
  @Patch('admin/:userId/phone/:phoneId/primary')
  async adminSetPrimaryPhone(
    @Req() req: any,
    @Param('userId',  ParseIntPipe) userId:  number,
    @Param('phoneId', ParseIntPipe) phoneId: number,
  ) {
    this.logger.info('Admin: set primary phone started', {
      context: UserController.name, adminId: req.user?.sub,
      targetUserId: userId, phoneId, ip: req.ip,
    });
    try {
      const data = await this.userService.adminSetPrimaryPhone(userId, phoneId);
      this.logger.info('Admin: primary phone set', {
        context: UserController.name, adminId: req.user?.sub,
        targetUserId: userId, phoneId, ip: req.ip,
      });
      return { success: true, message: data.message };
    } catch (error: any) {
      this.logger.error('Admin: set primary phone failed', {
        context: UserController.name, adminId: req.user?.sub,
        targetUserId: userId, phoneId, ip: req.ip,
        message: error.message,
      });
      throw new HttpException(
        { success: false, message: error?.message || 'Failed' },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // POST /user/admin/:userId/phone
  // body: { phoneNumber: string }
  @UseGuards(AdminGuard)
  @Post('admin/:userId/phone')
  async adminAddPhone(
    @Req() req: any,
    @Param('userId', ParseIntPipe) userId: number,
    @Body('phoneNumber') phoneNumber: string,
  ) {
    this.logger.info('Admin: add phone started', {
      context: UserController.name, adminId: req.user?.sub,
      targetUserId: userId, ip: req.ip,
    });
    try {
      if (!phoneNumber) throw new BadRequestException('phoneNumber is required');
      const data = await this.userService.adminAddPhone(userId, phoneNumber);
      this.logger.info('Admin: phone added', {
        context: UserController.name, adminId: req.user?.sub,
        targetUserId: userId, ip: req.ip,
      });
      return { success: true, message: 'Phone added', data };
    } catch (error: any) {
      this.logger.error('Admin: add phone failed', {
        context: UserController.name, adminId: req.user?.sub,
        targetUserId: userId, ip: req.ip, message: error.message,
      });
      throw new HttpException(
        { success: false, message: error?.message || 'Failed' },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // DELETE /user/admin/:userId/phone/:phoneId
  @UseGuards(AdminGuard)
  @Delete('admin/:userId/phone/:phoneId')
  async adminDeletePhone(
    @Req() req: any,
    @Param('userId',  ParseIntPipe) userId:  number,
    @Param('phoneId', ParseIntPipe) phoneId: number,
  ) {
    this.logger.info('Admin: delete phone started', {
      context: UserController.name, adminId: req.user?.sub,
      targetUserId: userId, phoneId, ip: req.ip,
    });
    try {
      const data = await this.userService.adminDeletePhone(userId, phoneId);
      this.logger.info('Admin: phone deleted', {
        context: UserController.name, adminId: req.user?.sub,
        targetUserId: userId, phoneId, ip: req.ip,
      });
      return { success: true, message: data.message };
    } catch (error: any) {
      this.logger.error('Admin: delete phone failed', {
        context: UserController.name, adminId: req.user?.sub,
        targetUserId: userId, phoneId, ip: req.ip, message: error.message,
      });
      throw new HttpException(
        { success: false, message: error?.message || 'Failed' },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }


  // PATCH /user/admin/:userId/phone/:phoneId
  // body: { phoneNumber: string }
  @UseGuards(AdminGuard)
  @Patch('admin/:userId/phone/:phoneId')
  async adminUpdatePhone(
    @Req() req: any,
    @Param('userId',  ParseIntPipe) userId:  number,
    @Param('phoneId', ParseIntPipe) phoneId: number,
    @Body('phoneNumber') phoneNumber: string,
  ) {
    this.logger.info('Admin: update phone started', {
      context: UserController.name, adminId: req.user?.sub,
      targetUserId: userId, phoneId, ip: req.ip,
    });
    try {
      if (!phoneNumber) throw new BadRequestException('phoneNumber is required');
      const data = await this.userService.adminUpdatePhone(userId, phoneId, phoneNumber);
      this.logger.info('Admin: phone updated', {
        context: UserController.name, adminId: req.user?.sub,
        targetUserId: userId, phoneId, ip: req.ip,
      });
      return { success: true, message: data.message, data };
    } catch (error: any) {
      this.logger.error('Admin: update phone failed', {
        context: UserController.name, adminId: req.user?.sub,
        targetUserId: userId, phoneId, ip: req.ip,
        message: error.message, stack: error.stack,
      });
      throw new HttpException(
        { success: false, message: error?.message || 'Failed' },
        error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @UseGuards(AdminGuard)
@Patch('admin/:userId/phone/:phoneId/verify')
async adminVerifyPhone(
  @Req() req: any,
  @Param('userId',  ParseIntPipe) userId:  number,
  @Param('phoneId', ParseIntPipe) phoneId: number,
  @Body() dto: { isVerified?: boolean } = {},
) {
  const isVerified = dto.isVerified ?? true;

  this.logger.info('Admin: verify phone started', {
    context: UserController.name,
    adminId: req.user?.sub,
    targetUserId: userId,
    phoneId,
    isVerified,
    ip: req.ip,
  });

  try {
    const data = await this.userService.adminVerifyPhone(
      userId,
      phoneId,
      isVerified,
    );

    this.logger.info('Admin: phone verification updated', {
      context: UserController.name,
      adminId: req.user?.sub,
      targetUserId: userId,
      phoneId,
      isVerified,
      ip: req.ip,
    });

    return { success: true, message: data.message, data };
  } catch (error: any) {
    this.logger.error('Admin: verify phone failed', {
      context: UserController.name,
      adminId: req.user?.sub,
      targetUserId: userId,
      phoneId,
      isVerified,
      ip: req.ip,
      message: error.message,
      stack: error.stack,
    });
    throw new HttpException(
      { success: false, message: error?.message || 'Failed' },
      error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
}

}
