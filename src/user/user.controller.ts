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
} from '@nestjs/common';
import { UserService } from './user.service';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
@UseGuards(JwtAuthGuard)
@Controller('user')
export class UserController {
    constructor(private userService: UserService) { }

    @Get('profile')
    async getProfile(@Req() req) {
        try {
            const userId = req.user?.sub;
            const user = await this.userService.getProfile(userId);
            return {
                success: true,
                message: 'User profile retrieved successfully',
                data: user,
            }
        } catch (error) {
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

  // ---------------- VERIFY PHONE ----------------
  @Patch('phone/:phoneId/verify')
  async verifyPhone(@Req() req, @Param('phoneId') phoneId: string) {
    try {
      const userId = req.user?.sub;

      if (!userId) {
        throw new BadRequestException('User not authenticated');
      }

      const result = await this.userService.verifyPhone(
        userId,
        Number(phoneId),
      );

      return {
        status: 'success',
        code: 200,
        message: result.message,
      };
    } catch (error:any) {
      console.error('Error verifying phone:', error);

      return {
        status: 'error',
        code: error.status || 500,
        message: error.message || 'Internal server error',
      };
    }
  }
}
