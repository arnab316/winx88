import {
  Controller,
  Post,
  Delete,
  Patch,
  Param,
  Req,
  Body,
  UseGuards,
  BadRequestException,
  Get,
  Inject,
} from '@nestjs/common';
import { UserService } from './user.service';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import type { Request, Response } from 'express';

@UseGuards(JwtAuthGuard)
@Controller('user')
export class UserController {
  constructor(
    private userService: UserService,
    @Inject(WINSTON_MODULE_PROVIDER)
    private readonly logger: Logger,
  ) { }

@Get('profile')
async getProfile(@Req() req) {
  try {
    const userId = req.user?.sub;

    this.logger.info('Profile fetch started', {
      context: UserController.name,
      userId,
      ip: (req as any).ip,
    });

    const user = await this.userService.getProfile(userId);

    this.logger.info('Profile fetched successfully', {
      context: UserController.name,
      userId,
      ip: (req as any).ip,
    });

    return {
      success: true,
      message: 'User profile retrieved successfully',
      data: user,
    };
  } catch (error: any) {
    this.logger.error('Profile fetch failed', {
      context: UserController.name,
      userId: req.user?.sub,
      ip: (req as any).ip,
      message: error.message,
      stack: error.stack,
    });

    throw error;
  }
}
    @Post('update-profile')
    async updateProfile(@Req() req, @Body() dto: any) {
        try {
            const userId = req.user?.id;
            const user = await this.userService.updateProfile(userId, dto);
            return {
                success: true,
                message: 'Profile updated successfully',
                data: user,
            }
        } catch (error) {
            throw error;
        }
    }

    @Post('add-phone')
    async addPhoneNumber(@Req() req, @Body() dto:{ phoneNumber: string }) {
        try {
            const userId = req.user?.sub;
            const user = await this.userService.addPhone(userId, dto.phoneNumber);
            return {
                success: true,
                message: 'Phone number added successfully',
                data: user,
            }


        } catch (error) {
            throw error;
        }
    }
     @Patch('phone/:phoneId/primary')
  async setPrimaryPhone(@Req() req, @Param('phoneId') phoneId: string) {
    try {
      const userId = req.user?.sub; // from JWT

      if (!userId) {
        throw new BadRequestException('User not authenticated');
      }

      const result = await this.userService.setPrimaryPhone(
        userId,
        Number(phoneId),
      );

      return {
        status: 'success',
        code: 200,
        message: result.message,
      };
    } catch (error:any) {
      console.error('Error setting primary phone:', error);

      return {
        status: 'error',
        code: error.status || 500,
        message: error.message || 'Internal server error',
      };
    }
  }

  // ---------------- DELETE PHONE ----------------
  @Delete('phone/:phoneId')
  async deletePhone(@Req() req, @Param('phoneId') phoneId: string) {
    try {
      const userId = req.user?.sub;

      if (!userId) {
        throw new BadRequestException('User not authenticated');
      }

      const result = await this.userService.deletePhone(
        userId,
        Number(phoneId),
      );

      return {
        status: 'success',
        code: 200,
        message: result.message,
      };
    } catch (error:any) {
      console.error('Error deleting phone:', error);

      return {
        status: 'error',
        code: error.status || 500,
        message: error.message || 'Internal server error',
      };
    }
  }

  @Patch('phone/:phoneId/verify')
async verifyPhone(@Req() req, @Param('phoneId') phoneId: string) {
  try {
    const userId = req.user?.sub;

    this.logger.info('Phone verification started', {
      context: UserController.name,
      userId,
      phoneId,
      ip: (req as any).ip,
    });

    if (!userId) {
      this.logger.warn('Unauthenticated phone verification attempt', {
        context: UserController.name,
        phoneId,
        ip: (req as any).ip,
      });

      throw new BadRequestException('User not authenticated');
    }

    const result = await this.userService.verifyPhone(
      userId,
      Number(phoneId),
    );

    this.logger.info('Phone verified successfully', {
      context: UserController.name,
      userId,
      phoneId,
      ip: (req as any).ip,
    });

    return {
      status: 'success',
      code: 200,
      message: result.message,
    };
  } catch (error: any) {
    this.logger.error('Phone verification failed', {
      context: UserController.name,
      userId: req.user?.sub,
      phoneId,
      ip: (req as any).ip,
      message: error.message,
      stack: error.stack,
    });

    return {
      status: 'error',
      code: error.status || 500,
      message: error.message || 'Internal server error',
    };
  }
}
  @Get('all')
  async getAllUsers() {
    try {
      const users = await this.userService.getAllUsers();
      return {
        success: true,
        message: 'Users retrieved successfully',
        data: users,
      };
    } catch (error) {
      throw error;
    }}
  @Get('user-details/:userId')
    async getUserDetailsByAdmin(@Req() req, @Param('userId') userId: string) {
        try {
            const result = await this.userService.getUserDetailsByAdmin(
                Number(userId),
            );  
            return {
                status: 'success',
                code: 200,  
                message: 'User details retrieved successfully',
                data: result,
            };
        } catch (error:any) {
            console.error('Error retrieving user details:', error); 
        }
      }

      
}
