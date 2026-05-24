// src/ticket/ticket.controller.ts
//
// Public JSON endpoint — no auth required.
// QR code on the ticket links to the FRONTEND:
//   https://winx-88.com/ticket/:betCode
//
// The frontend page calls this backend endpoint to get the data:
//   GET http://15.207.97.72:3000/ticket/:betCode
//
// Returns full bet + round + result info for the ticket page.

import { Controller, Get, Param, HttpStatus } from '@nestjs/common';
import { TicketService } from './ticket.service';

@Controller('ticket')
export class TicketController {
  constructor(private readonly ticketService: TicketService) {}

  // GET /ticket/BET-1779643668910-6237
  @Get(':betCode')
  async verifyTicket(@Param('betCode') betCode: string) {
    const data = await this.ticketService.verifyTicket(betCode);
    return {
      statusCode: HttpStatus.OK,
      message: 'Ticket verified',
      data,
    };
  }
}