import { Controller, Get, Query, UseGuards, UseInterceptors } from '@nestjs/common';

import { AdminGuard } from 'src/common/guards/admin.guard';
import { AdminService } from './admin.service';
@UseGuards(AdminGuard)
@Controller('admin')
export class AdminController {
    constructor(private adminService: AdminService) { }

    @Get('search-users')
    async searchUsers(  @Query('search') search: string,) {
        return this.adminService.searchUsers(search);
    }

}
