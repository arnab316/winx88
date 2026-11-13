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
import { LiveSuperAdminGuard } from 'src/common/guards/live-super-admin.guard';
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
 *
 * SUPER_ADMIN ONLY, and not via AdminGuard alone — that gate passes every
 * admin account (CS, SUPPORT, OPERATOR, …). What these routes return is the
 * plaintext address books of players, which is to say the names and phone
 * numbers of thousands of people who have no account here and never agreed to
 * anything. The narrowest audience that can still do the job is the right one.
 *
 * LiveSuperAdminGuard resolves the role from the database rather than the JWT,
 * so revoking someone's super-admin takes effect on their next request instead
 * of whenever their token happens to expire.
 */
@Controller('contacts/admin')
@UseGuards(AdminGuard, LiveSuperAdminGuard)
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

  /**
   * One player's uploaded book — what the Contacts tab of the member dialog
   * reads. Paginated and searchable, because a single address book is commonly
   * 500–2,000 rows and the dialog cannot render that in one page.
   */
  @Get('user/:userId')
  async forUser(
    @Param('userId') userId: number,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('search') search?: string,
    @Query('matched') matched?: 'yes' | 'no',
  ) {
    return this.wrap(() =>
      this.admin.forUser(Number(userId), { page, limit, search, matched }),
    );
  }

  /** Counts + last upload for one player, for the tab header. */
  @Get('user/:userId/summary')
  async userSummary(@Param('userId') userId: number) {
    return this.wrap(() => this.admin.userSummary(Number(userId)));
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
