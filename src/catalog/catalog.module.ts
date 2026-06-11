import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { AdminGuard } from 'src/common/guards/admin.guard';
import { AuthModule } from 'src/auth/auth.module';

@Module({
  imports: [AuthModule], // AdminGuard needs JwtService (exported by AuthModule)
  controllers: [CatalogController],
  providers: [CatalogService, AdminGuard],
})
export class CatalogModule {}
