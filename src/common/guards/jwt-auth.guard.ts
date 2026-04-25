// src/common/guards/jwt-auth.guard.ts
import { Injectable, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class JwtAuthGuard {
  constructor(private jwtService: JwtService) {}

  canActivate(context: ExecutionContext): any {
    const request = context.switchToHttp().getRequest();

    // ✅ Try cookie first, fallback to Authorization header
    // const token = request.cookies?.refreshToken 
    //   || request.headers['authorization']?.split(' ')[1];
      const token = request.headers['authorization']?.split(' ')[1];
    if (!token) {
      throw new UnauthorizedException('No token provided');
    }

    try {
      const decoded = this.jwtService.verify(token);
      request.user = decoded;
      return true;
    } catch (e:any){
     console.error('JWT verification failed:', e);
      // throw new UnauthorizedException('Invalid or expired token');
    }
  }
}