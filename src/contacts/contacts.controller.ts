import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { ContactsService } from './contacts.service';
import { SyncContactsDto } from './dto/sync-contacts.dto';

/**
 * Player-facing address-book endpoints.
 *
 *   POST   /contacts/sync        → upload one chunk of the device's contacts
 *   GET    /contacts/me/summary  → what we hold for this player
 *   DELETE /contacts/me          → erase it
 *
 * Every route is behind JwtAuthGuard, so the uploader is taken from the token
 * (`req.user.sub`) and never from the body. That is the whole authorisation
 * model here: a client cannot attribute an address book to another account,
 * because there is no field in which to try.
 */
@Controller('contacts')
@UseGuards(JwtAuthGuard)
export class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

  /**
   * Called once per chunk after the player grants READ_CONTACTS.
   *
   * Safe to call again with the same chunk: the upsert is keyed on
   * (player, number), so a retry after a dropped connection re-stores the
   * same rows rather than duplicating them.
   */
  @Post('sync')
  async sync(@Req() req: any, @Body() body: SyncContactsDto) {
    try {
      const data = await this.contacts.sync(Number(req.user.sub), body);
      return { success: true, data };
    } catch (e: any) {
      throw new HttpException(
        { success: false, message: e?.message || 'Contact sync failed' },
        e?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('me/summary')
  async mySummary(@Req() req: any) {
    try {
      const data = await this.contacts.mySummary(Number(req.user.sub));
      return { success: true, data };
    } catch (e: any) {
      throw new HttpException(
        { success: false, message: e?.message || 'Failed' },
        e?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * The app calls this when it finds the Contacts permission revoked.
   *
   * Android does not tell a server that a permission was withdrawn, so
   * without this the data would outlive the consent indefinitely.
   */
  @Delete('me')
  async deleteMine(@Req() req: any) {
    try {
      const data = await this.contacts.deleteMine(Number(req.user.sub));
      return { success: true, data };
    } catch (e: any) {
      throw new HttpException(
        { success: false, message: e?.message || 'Failed' },
        e?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
