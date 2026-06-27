// import { Injectable, ExecutionContext, UnauthorizedException, ForbiddenException } from '@nestjs/common';
// import { JwtService } from '@nestjs/jwt';

// @Injectable()
// export class AdminGuard {
//   constructor(private jwtService: JwtService) {}

//   canActivate(context: ExecutionContext): boolean {
//     const request = context.switchToHttp().getRequest();

//     const authHeader = request.headers['authorization'];

//     if (!authHeader) {
//       throw new UnauthorizedException('No token provided');
//     }

//     const token = authHeader.split(' ')[1];

//     if (!token) {
//       throw new UnauthorizedException('Invalid token format');
//     }

//     try {
//       const decoded = this.jwtService.verify(token);

//       if (decoded.role !== 'ADMIN') {
//         throw new ForbiddenException('Admin access only');
//       }

//       request.user = decoded; // { sub: adminId, role: 'ADMIN' }
//       return true;
//     } catch (err) {
//       if (err instanceof ForbiddenException) throw err;
//       throw new UnauthorizedException('Invalid or expired token');
//     }
//   }
// }


import { Injectable, ExecutionContext, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class AdminGuard {
  constructor(private jwtService: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();

    // ✅ Try cookie first, fallback to Authorization header
    const token = request.cookies?.accessToken
      || request.headers['authorization']?.split(' ')[1];

    if (!token) {
      throw new UnauthorizedException('No token provided');
    }

    try {
      const decoded = this.jwtService.verify(token);

      // Any admin account passes this gate (ADMIN, SUPER_ADMIN, CS, SUPPORT,
      // TL, OPERATOR, …). Fine-grained access is enforced per-route by
      // PermissionsGuard + @RequirePermissions. Only player tokens are rejected.
      // Admin tokens carry type='ADMIN' (new) or a non-USER role (legacy).
      const isAdmin =
        decoded.type === 'ADMIN' || (decoded.role && decoded.role !== 'USER');
      if (!isAdmin) {
        throw new ForbiddenException('Admin access only');
      }

      request.user = decoded; // { sub, role, roles?, type? }
      request.admin = { id: decoded.sub, role: decoded.role };
      return true;
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}