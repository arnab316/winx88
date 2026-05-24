// src/game/bet-ticket.service.ts
//
// Generates a boarding-pass-style bet ticket PDF.
// Called from ScheduleController.placeBetWithTicket() after placeBet() commits.
//
// REQUIRED npm packages:
//   npm install pdfkit qrcode @types/qrcode
//
// Tickets are written to {cwd}/public/tickets/ and served at /tickets/*
// via ServeStaticModule (wire that in AppModule — see game.module.ts notes).
// In production, swap the local file write for an S3 upload + signed URL.

import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as QRCode from 'qrcode';

// PDFKit loaded via require so a fresh checkout without the dep installed
// doesn't crash module loading (it only fails when generate() is called).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PDFDocument = require('pdfkit');

export interface BetTicketData {
  ticketId: string; // BET-<timestamp>-<rand>
  playerName: string;
  gameName: string;
  gameType: string; // '1D' | '3D' | '4D' | '5D'
  roundCode: string;
  betNumber: string;
  betAmount: string; // formatted, e.g. "BDT 500.00"
  potentialPayout: string; // formatted, e.g. "BDT 45,000.00"
  placedAt: string; // human-readable
  verifyUrl: string; // deep-link for QR code
}

@Injectable()
export class BetTicketService {
  private readonly logger = new Logger(BetTicketService.name);

  // Where tickets are stored on disk. Mount a volume here in prod, or swap for S3.
  private readonly ticketsDir = path.join(process.cwd(), 'public', 'tickets');

  constructor() {
    if (!fs.existsSync(this.ticketsDir)) {
      fs.mkdirSync(this.ticketsDir, { recursive: true });
    }
  }

  /**
   * Generate a PDF ticket and return the public URL path.
   * @returns e.g. "/tickets/BET-1748512345-7823.pdf"
   */
  async generate(data: BetTicketData): Promise<string> {
    const filename = `${data.ticketId}.pdf`;
    const filePath = path.join(this.ticketsDir, filename);
    const publicUrl = `/tickets/${filename}`;

    try {
      await this.buildPdf(data, filePath);
      this.logger.log(`Ticket generated: ${filename}`);
      return publicUrl;
    } catch (err) {
      this.logger.error(`Ticket generation failed for ${data.ticketId}`, err as any);
      throw err;
    }
  }

  /** Delete a ticket file (call on bet cancellation / purge). */
  async delete(ticketId: string): Promise<void> {
    const filePath = path.join(this.ticketsDir, `${ticketId}.pdf`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  // ── PRIVATE: build the PDF (boarding-pass layout, 160x60mm) ──
  private async buildPdf(data: BetTicketData, outPath: string): Promise<void> {
    const W_PT = 453; // 160mm in points
    const H_PT = 170; // 60mm  in points
    const STUB = 340; // stub starts at x=340pt

    const C = {
      bgMain: '#100C22',
      bgStub: '#14102A',
      gold: '#C9A84C',
      goldLt: '#F0C96A',
      purple: '#7B52C0',
      purpleDk: '#4A2F88',
      green: '#2ECC71',
      greenDk: '#0D3B27',
      gray: '#7A7590',
      grayLt: '#A09BB8',
      divider: '#2A2250',
      white: '#FFFFFF',
    };

    const qrBuffer = await QRCode.toBuffer(data.verifyUrl, {
      width: 90,
      margin: 1,
      color: { dark: '#FFFFFF', light: '#14102A' },
    });

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({
        size: [W_PT, H_PT],
        margin: 0,
        info: {
          Title: `Bet Ticket - ${data.ticketId}`,
          Author: 'WINX-88',
          Subject: 'Bet Ticket',
        },
      });

      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => {
        fs.writeFileSync(outPath, Buffer.concat(chunks));
        resolve();
      });
      doc.on('error', reject);

      // Background
      doc.rect(0, 0, W_PT, H_PT).fill(C.bgMain);

      // Header band (left panel width)
      doc.rect(0, 0, STUB, 28).fill(C.purpleDk);

      // Gold top stripe (full width)
      doc.rect(0, 0, W_PT, 3).fill(C.gold);

      // Site name
      doc
        .font('Helvetica-Bold')
        .fontSize(13)
        .fillColor(C.goldLt)
        .text('WINX-88', 14, 8, { lineBreak: false });

      // Tagline
      doc
        .font('Helvetica')
        .fontSize(6)
        .fillColor('#C4AEFF')
        .text('OFFICIAL BET TICKET', 14, 22, { lineBreak: false });

      // Hero: bet number box
      doc.roundedRect(14, 34, 100, 52, 5).fill('#261E4A');
      doc.roundedRect(14, 34, 100, 52, 5).stroke(C.gold).lineWidth(0.8);

      doc
        .font('Helvetica')
        .fontSize(6.5)
        .fillColor(C.gold)
        .text('BET NUMBER', 0, 40, { align: 'center', width: 128, lineBreak: false });

      doc
        .font('Helvetica-Bold')
        .fontSize(30)
        .fillColor(C.goldLt)
        .text(data.betNumber, 22, 50, { lineBreak: false });

      // Game type badge
      doc.roundedRect(68, 64, 36, 14, 4).fill(C.purple);
      doc
        .font('Helvetica-Bold')
        .fontSize(8)
        .fillColor(C.white)
        .text(data.gameType, 68, 68, { width: 36, align: 'center', lineBreak: false });

      // Two-column info grid
      const col1 = 128;
      const col2 = 238;
      const rows: [string, string, string, number, number][] = [
        ['PLAYER', data.playerName, C.white, col1, 34],
        ['GAME', data.gameName, C.white, col1, 64],
        ['ROUND', data.roundCode, C.grayLt, col1, 94],
        ['BET AMOUNT', data.betAmount, C.goldLt, col2, 34],
        ['POTENTIAL WIN', data.potentialPayout, C.green, col2, 64],
        ['PLACED AT', data.placedAt, C.grayLt, col2, 94],
      ];

      for (const [label, value, color, x, y] of rows) {
        doc
          .font('Helvetica')
          .fontSize(5.5)
          .fillColor(C.gray)
          .text(label, x, y, { lineBreak: false });
        doc
          .font('Helvetica-Bold')
          .fontSize(7)
          .fillColor(color)
          .text(value, x, y + 10, { lineBreak: false, width: 95 });
      }

      // Divider lines between info rows
      for (const lineY of [58, 88]) {
        doc
          .moveTo(col1, lineY)
          .lineTo(STUB - 10, lineY)
          .strokeColor(C.divider)
          .lineWidth(0.4)
          .dash(3, { space: 3 })
          .stroke();
        doc.undash();
      }

      // Status badge
      doc.roundedRect(14, 143, 72, 18, 6).fill(C.greenDk);
      doc.roundedRect(14, 143, 72, 18, 6).stroke(C.green).lineWidth(0.6);
      doc
        .font('Helvetica-Bold')
        .fontSize(7.5)
        .fillColor(C.green)
        .text('BET PLACED', 14, 149, { width: 72, align: 'center', lineBreak: false });

      // Vertical tear line
      doc
        .moveTo(STUB, 8)
        .lineTo(STUB, H_PT - 8)
        .strokeColor(C.divider)
        .lineWidth(0.7)
        .dash(3, { space: 3 })
        .stroke();
      doc.undash();

      // Notch circles
      doc.circle(STUB, 6, 5).fill(C.bgMain);
      doc.circle(STUB, H_PT - 6, 5).fill(C.bgMain);

      // Stub background
      doc.rect(STUB + 1, 3, W_PT - STUB - 1, H_PT - 3).fill(C.bgStub);

      // Gold stripe on stub
      doc.rect(STUB, 0, W_PT - STUB, 3).fill(C.gold);

      // QR code
      const qrSize = 88;
      const qrX = STUB + (W_PT - STUB - qrSize) / 2;
      doc.image(qrBuffer, qrX, 12, { width: qrSize, height: qrSize });

      // Ticket ID under QR
      doc
        .font('Helvetica')
        .fontSize(5)
        .fillColor(C.gray)
        .text('TICKET ID', STUB, 105, { width: W_PT - STUB, align: 'center', lineBreak: false });
      doc
        .font('Helvetica-Bold')
        .fontSize(5.5)
        .fillColor(C.goldLt)
        .text(data.ticketId, STUB, 113, { width: W_PT - STUB, align: 'center', lineBreak: false });

      // Scan label
      doc
        .font('Helvetica')
        .fontSize(5)
        .fillColor(C.gray)
        .text('scan to verify result', STUB, 155, {
          width: W_PT - STUB,
          align: 'center',
          lineBreak: false,
        });

      doc.end();
    });
  }

  // ── HELPER: raw bet row -> BetTicketData ──────────────────
  static formatFromBet(
    bet: {
      id: number;
      bet_code: string;
      bet_number: string;
      bet_amount: string | number;
      potential_payout: string | number;
      placed_at?: Date;
    },
    extras: {
      playerName: string;
      gameName: string;
      digitLength: number;
      roundCode: string;
      baseUrl: string; // e.g. "https://winx-88.com"
    },
  ): BetTicketData {
    const amt = parseFloat(String(bet.bet_amount));
    const payout = parseFloat(String(bet.potential_payout));
    const placedAt = bet.placed_at ? new Date(bet.placed_at) : new Date();

    return {
      ticketId: bet.bet_code,
      playerName: extras.playerName,
      gameName: extras.gameName,
      gameType: `${extras.digitLength}D`,
      roundCode: extras.roundCode,
      betNumber: bet.bet_number,
      betAmount: `BDT ${amt.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
      potentialPayout: `BDT ${payout.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
      placedAt: placedAt.toLocaleString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
      verifyUrl: `${extras.baseUrl}/ticket/${bet.bet_code}`,
    };
  }
}