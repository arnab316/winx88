import { Controller, Get, Query, UseGuards, UseInterceptors } from '@nestjs/common';

import { AdminGuard } from 'src/common/guards/admin.guard';
import { AdminService } from './admin.service';
@UseGuards(AdminGuard)
@Controller('admin')
export class AdminController {
    constructor(private adminService: AdminService) { }

    // GET /admin/search-users?search=alice&from=2026-06-01&to=2026-06-19
    //   search, from and to are all optional; from/to filter on registration
    //   date (created_at) and `to` is inclusive of the whole day.
    @Get('search-users')
    async searchUsers(
        @Query('search') search?: string,
        @Query('from') from?: string,
        @Query('to') to?: string,
    ) {
        return this.adminService.searchUsers(search, from, to);
    }

}
