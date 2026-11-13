import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from 'src/common/guards/admin.guard';
import { ContactsAdminService } from './contacts-admin.service';

/**
 * Admin views over the uploaded address books.
 *
 *   GET /contacts/admin/stats          → headline counts
 *   GET /contacts/admin/list           → paginated rows, searchable
 *   GET /contacts/admin/syncs          → the upload log (consent receipts)
 *   GET /contacts/admin/user/:userId   → one player's uploaded book
 *
 * These exist so the data is visible in the product rather than only through
 * a SQL client. A support agent asked "where did you get my number?" needs
 * `syncs` to answer it, and an answer that requires database access is an
 * answer nobody gives.
 */
@Controller('contacts/admin')
@UseGuards(AdminGuard)
export class ContactsAdminController {
  constructor(private readonly admin: ContactsAdminService) {}

  @Get('stats')
  async stats() {
    return this.wrap(() => this.admin.stats());
  }

  @Get('list')
  async list(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('search') search?: string,
    @Query('userId') userId?: number,
    @Query('matched') matched?: 'yes' | 'no',
  ) {
    return this.wrap(() =>
      this.admin.list({ page, limit, search, userId, matched }),
    );
  }

  @Get('syncs')
  async syncs(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('userId') userId?: number,
  ) {
    return this.wrap(() => this.admin.syncs(page, limit, userId));
  }

  @Get('user/:userId')
  async forUser(@Param('userId') userId: number) {
    return this.wrap(() => this.admin.forUser(Number(userId)));
  }

  private async wrap<T>(run: () => Promise<T>) {
    try {
      return { success: true, data: await run() };
    } catch (e: any) {
      throw new HttpException(
        { success: false, message: e?.message || 'Failed' },
        e?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
