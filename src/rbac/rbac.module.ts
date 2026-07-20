import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RbacService } from './rbac.service';
import { RbacController } from './rbac.controller';
import { PermissionsGuard } from '../common/guards/permissions.guard';

/**
 * @Global so RbacService (and thus PermissionsGuard) is resolvable from any
 * module's controllers without re-importing — every admin route can use
 * @UseGuards(AdminGuard, PermissionsGuard) + @RequirePermissions.
 *
 * Imports AuthModule for JwtModule (AdminGuard needs JwtService). AuthModule
 * does NOT import RbacModule, so there is no cycle; AuthService reaches
 * RbacService via the @Global export.
 */
@Global()
@Module({
  imports: [AuthModule],
  controllers: [RbacController],
  providers: [RbacService, PermissionsGuard],
  exports: [RbacService],
})
export class RbacModule {}
