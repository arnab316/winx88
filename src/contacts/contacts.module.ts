import { Module } from '@nestjs/common';
import { AuthModule } from 'src/auth/auth.module';
import { AdminGuard } from 'src/common/guards/admin.guard';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { LiveSuperAdminGuard } from 'src/common/guards/live-super-admin.guard';
import { ContactsController } from './contacts.controller';
import { ContactsService } from './contacts.service';
import { ContactsAdminController } from './contacts-admin.controller';
import { ContactsAdminService } from './contacts-admin.service';

/**
 * Device address books uploaded by the mobile app.
 *
 * Reads and writes `device_contacts` and `device_contact_syncs` through the
 * default DataSource (migration 2400000000000). Imports AuthModule only for
 * JwtModule, which the two guards need.
 */
@Module({
  imports: [AuthModule],
  controllers: [ContactsController, ContactsAdminController],
  providers: [
    ContactsService,
    ContactsAdminService,
    JwtAuthGuard,
    AdminGuard,
    LiveSuperAdminGuard,
  ],
  exports: [ContactsService],
})
export class ContactsModule {}
