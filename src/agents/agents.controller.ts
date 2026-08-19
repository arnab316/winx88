// src/agent/agent.controller.ts
import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  ParseIntPipe,
  BadRequestException,
  UsePipes,
  ValidationPipe,
  Inject,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AgentsService } from './agents.service';
import {
  CreateAgentDto,
  UpdateAgentDto,
  ListAgentsQueryDto,
} from './dto/agent.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import { memoryStorage } from 'multer';
import { S3Service } from '../wallet/s3.service';
import type { Request, Response } from 'express';
@Controller('agents')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class AgentsController {
  constructor(
    private agentService: AgentsService,
    private readonly s3: S3Service,
    @Inject(WINSTON_MODULE_PROVIDER)
    private readonly logger: Logger,
  ) {}

  // ════════════════════════════════════════════════════════════
  // USER ROUTES
  // ════════════════════════════════════════════════════════════

  // GET /agents/deposit-agent?gatewayId=1
  //   Called by the user when they click "Deposit" and pick bKash/Nagad/Rocket
  //   Returns the agent number they should send money to (with rotation logic)
  @UseGuards(JwtAuthGuard)
  @Get('deposit-agent')
  async getDepositAgent(
    @Req() req: any,
    @Query('gatewayId', ParseIntPipe) gatewayId: number,
  ) {
     this.logger.info('Deposit agent fetch started', {
      context: AgentsController.name,
      userId: req.user?.sub,
      gatewayId,
      ip: (req as any).ip,
    });
    const userId = req.user.sub;
    // Fix: need to verify the token to extract userId, because JwtAuthGuard only checks validity but doesn't attach user info to req
    // const userId = 7; 
    const result = await this.agentService.getAgentForDeposit(userId, gatewayId);
    return { status: 'success', data: result };
  }

  // ════════════════════════════════════════════════════════════
  // ADMIN ROUTES
  // ════════════════════════════════════════════════════════════

  // GET /agents/admin?status=ACTIVE&gatewayId=1&page=1&limit=20
  // @UseGuards(AdminGuard)
  @Get('admin')
  async list(@Query() q: ListAgentsQueryDto, @Req() req: any) {
    
   try {
     this.logger.info('Agent list fetch started', {
      context: AgentsController.name,
      userId: req.user?.sub,  
      query: q,
      ip: (req as any).ip,
    });
     const result = await this.agentService.listAgents(q);
    return { status: 'success', ...result };
   } catch (error:any) {
    this.logger.error('Error occurred while listing agents', {
      context: AgentsController.name,
      ip: (req as any).ip,
      message: error.message,
      stack: error.stack,
    });
    throw error;
   }
  }

  // POST /agents/admin/qr-image   form-data: image=<file>
  //   Step 1 of adding a QR destination. Upload the merchant poster, then pass
  //   the returned url as `qrImageUrl` on POST /agents/admin.
  @UseGuards(AdminGuard)
  @Post('admin/qr-image')
  @UseInterceptors(
    FileInterceptor('image', {
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/webp'];
        if (allowed.includes(file.mimetype)) cb(null, true);
        else cb(new BadRequestException('Only JPG, PNG, WEBP allowed'), false);
      },
    }),
  )
  async uploadQrImage(@UploadedFile() image: Express.Multer.File) {
    if (!image) {
      throw new BadRequestException(
        'QR image is required. Send as form-data with key "image"',
      );
    }
    const url = await this.s3.uploadAgentQr(image);
    return { status: 'success', data: { qrImageUrl: url } };
  }

  // POST /agents/admin
  @UseGuards(AdminGuard)
  @Post('admin')
  async create(@Req() req: any, @Body() dto: CreateAgentDto) {
    const adminId = req.user.sub;
    const agent = await this.agentService.createAgent(dto, adminId);
    return { status: 'success', message: 'Agent created', data: agent };
  }

  // PATCH /agents/admin/:id
  @UseGuards(AdminGuard)
  @Patch('admin/:id')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateAgentDto,
  ) {
    const agent = await this.agentService.updateAgent(id, dto);
    return { status: 'success', message: 'Agent updated', data: agent };
  }

  // DELETE /agents/admin/:id           → soft delete (INACTIVE)
  // DELETE /agents/admin/:id?hard=true → hard delete (only if no deposits used it)
  @UseGuards(AdminGuard)
  @Delete('admin/:id')
  async remove(
    @Param('id', ParseIntPipe) id: number,
    @Query('hard') hard?: string,
  ) {
    const hardDelete = hard === 'true';
    const result = await this.agentService.deleteAgent(id, hardDelete);
    return { status: 'success', ...result };
  }

  // POST /agents/admin/bulk-upload
  //   form-data: file = <xlsx file>
  @UseGuards(AdminGuard)
  @Post('admin/bulk-upload')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB cap
      fileFilter: (_req, file, cb) => {
        const ok =
          file.mimetype ===
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
          file.mimetype === 'application/vnd.ms-excel' ||
          /\.xlsx?$/i.test(file.originalname);
        cb(ok ? null : new BadRequestException('Only .xlsx/.xls files allowed'), ok);
      },
    }),
  )
  async bulkUpload(
    @Req() req: any,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('No file uploaded (field name: file)');
    const adminId = req.user.sub;
    const result = await this.agentService.bulkUploadFromExcel(file.buffer, adminId);
    return { status: 'success', ...result };
  }
}