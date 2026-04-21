// src/common/guards/super-admin.guard.ts
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

/**
 * Stricter than AdminGuard — only SUPER_ADMIN can pass.
 * Used for destructive ops like creating other admin accounts.
 */
@Injectable()
export class SuperAdminGuard implements CanActivate {
  constructor(private jwtService: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const auth = req.headers['authorization'];
    if (!auth) throw new UnauthorizedException('No token provided');

    const token = auth.split(' ')[1];
    if (!token) throw new UnauthorizedException('Invalid token format');

    let decoded: any;
    try {
      decoded = this.jwtService.verify(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    if (decoded.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('Super admin access required');
    }

    req.user = decoded;
    return true;
  }
}