// src/game/bet-ticket.service.ts
//
// Generates a boarding-pass PDF ticket and uploads it to S3.
// Returns the full public S3 URL.
//
// Reuses the same bucket + credentials as the rest of the app:
//   AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_BUCKET_NAME
//
// S3 key:     tickets/BET-1748512345-7823.pdf
// Public URL: https://{bucket}.s3.{region}.amazonaws.com/tickets/BET-xxx.pdf
//
// NOTE: if your bucket blocks public ACLs, remove ACL:'public-read'
// and generate a presigned URL instead (getSignedUrl from @aws-sdk/s3-request-presigner).

import { Injectable, Logger } from '@nestjs/common';
import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import * as QRCode from 'qrcode';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const PDFDocument = require('pdfkit');

export interface BetTicketData {
  ticketId:        string;
  playerName:      string;
  gameName:        string;
  gameType:        string;
  roundCode:       string;
  betNumber:       string;
  betAmount:       string;
  potentialPayout: string;
  placedAt:        string;
  verifyUrl:       string;
}

@Injectable()
export class BetTicketService {
  private readonly logger = new Logger(BetTicketService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly region: string;

  constructor() {
    this.region = process.env.AWS_REGION!;
    this.bucket = process.env.AWS_BUCKET_NAME!;
    this.s3 = new S3Client({
      region: this.region,
      credentials: {
        accessKeyId:     process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      },
    });
  }

  // ── Generate PDF → upload to S3 → return public URL ───────
  async generate(data: BetTicketData): Promise<string> {
    const tmpPath = path.join(os.tmpdir(), `${data.ticketId}.pdf`);

    this.logger.log(`Generating ticket for ${data.ticketId}...`);
    try {
      await this.buildPdf(data, tmpPath);
      this.logger.log(`PDF built at ${tmpPath}`);
      const pdfBuffer = fs.readFileSync(tmpPath);
      const s3Key     = `tickets/${data.ticketId}.pdf`;

      await this.s3.send(new PutObjectCommand({
        Bucket:      this.bucket,
        Key:         s3Key,
        Body:        pdfBuffer,
        ContentType: 'application/pdf',
        // ACL removed — blocked by default on new AWS buckets.
        // File is accessible via the public URL below because
        // the bucket policy allows s3:GetObject on tickets/*
        // (see README). If bucket is fully private, use presigned URLs.
      }));

      const publicUrl =
        `https://${this.bucket}.s3.${this.region}.amazonaws.com/${s3Key}`;

      this.logger.log(`Ticket uploaded: ${publicUrl}`);
      return publicUrl;

    } catch (err: any) {
      this.logger.error(`Ticket generation FAILED for ${data.ticketId}: ${err?.message}`, err?.stack);
      throw err; // re-throw so controller logs the real error
    } finally {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }
  }

  // ── Format raw bet row → BetTicketData ────────────────────
  static formatFromBet(
    bet: {
      id:               number;
      bet_code:         string;
      bet_number:       string;
      bet_amount:       string | number;
      potential_payout: string | number;
      placed_at?:       Date;
    },
    extras: {
      playerName:  string;
      gameName:    string;
      digitLength: number;
      roundCode:   string;
      baseUrl:     string;
    },
  ): BetTicketData {
    const amt    = parseFloat(String(bet.bet_amount));
    const payout = parseFloat(String(bet.potential_payout));
    const placedAt = bet.placed_at ? new Date(bet.placed_at) : new Date();

    return {
      ticketId:        bet.bet_code,
      playerName:      extras.playerName,
      gameName:        extras.gameName,
      gameType:        `${extras.digitLength}D`,
      roundCode:       extras.roundCode,
      betNumber:       bet.bet_number,
      betAmount:       `BDT ${amt.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
      potentialPayout: `BDT ${payout.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
      placedAt:        placedAt.toLocaleString('en-GB', {
                         day: '2-digit', month: 'short', year: 'numeric',
                         hour: '2-digit', minute: '2-digit', second: '2-digit',
                       }),
      verifyUrl: `${extras.baseUrl}/ticket/${bet.bet_code}`,
    };
  }

  // ── Build the boarding-pass PDF (160x60mm) ─────────────────
  private async buildPdf(data: BetTicketData, outPath: string): Promise<void> {
    const W_PT = 453;
    const H_PT = 170;
    const STUB = 340;

    const C = {
      bgMain: '#100C22', bgStub:   '#14102A',
      gold:   '#C9A84C', goldLt:   '#F0C96A',
      purple: '#7B52C0', purpleDk: '#4A2F88',
      green:  '#2ECC71', greenDk:  '#0D3B27',
      gray:   '#7A7590', grayLt:   '#A09BB8',
      divider:'#2A2250', white:    '#FFFFFF',
    };

    const qrBuffer = await QRCode.toBuffer(data.verifyUrl, {
      width: 90, margin: 1,
      color: { dark: '#FFFFFF', light: '#14102A' },
    });

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: [W_PT, H_PT], margin: 0,
        info: { Title: `Bet Ticket - ${data.ticketId}`, Author: 'WINX-88' } });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end',  () => { fs.writeFileSync(outPath, Buffer.concat(chunks)); resolve(); });
      doc.on('error', reject);

      doc.rect(0,0,W_PT,H_PT).fill(C.bgMain);
      doc.rect(0,0,STUB,28).fill(C.purpleDk);
      doc.rect(0,0,W_PT,3).fill(C.gold);

      doc.font('Helvetica-Bold').fontSize(13).fillColor(C.goldLt).text('WINX-88',14,8,{lineBreak:false});
      doc.font('Helvetica').fontSize(6).fillColor('#C4AEFF').text('OFFICIAL BET TICKET',14,22,{lineBreak:false});

      doc.roundedRect(14,34,100,52,5).fill('#261E4A');
      doc.roundedRect(14,34,100,52,5).stroke(C.gold).lineWidth(0.8);
      doc.font('Helvetica').fontSize(6.5).fillColor(C.gold).text('BET NUMBER',0,40,{align:'center',width:128,lineBreak:false});
      doc.font('Helvetica-Bold').fontSize(30).fillColor(C.goldLt).text(data.betNumber,22,50,{lineBreak:false});

      doc.roundedRect(68,64,36,14,4).fill(C.purple);
      doc.font('Helvetica-Bold').fontSize(8).fillColor(C.white).text(data.gameType,68,68,{width:36,align:'center',lineBreak:false});

      const col1=128, col2=238;
      const rows:[string,string,string,number,number][] = [
        ['PLAYER',data.playerName,C.white,col1,34],['GAME',data.gameName,C.white,col1,64],
        ['ROUND',data.roundCode,C.grayLt,col1,94],['BET AMOUNT',data.betAmount,C.goldLt,col2,34],
        ['POTENTIAL WIN',data.potentialPayout,C.green,col2,64],['PLACED AT',data.placedAt,C.grayLt,col2,94],
      ];
      for (const [label,value,color,x,y] of rows) {
        doc.font('Helvetica').fontSize(5.5).fillColor(C.gray).text(label,x,y,{lineBreak:false});
        doc.font('Helvetica-Bold').fontSize(7).fillColor(color).text(value,x,y+10,{lineBreak:false,width:95});
      }

      for (const lineY of [58,88]) {
        doc.moveTo(col1,lineY).lineTo(STUB-10,lineY).strokeColor(C.divider).lineWidth(0.4).dash(3,{space:3}).stroke();
        doc.undash();
      }

      doc.roundedRect(14,143,72,18,6).fill(C.greenDk);
      doc.roundedRect(14,143,72,18,6).stroke(C.green).lineWidth(0.6);
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(C.green).text('BET PLACED',14,149,{width:72,align:'center',lineBreak:false});

      doc.moveTo(STUB,8).lineTo(STUB,H_PT-8).strokeColor(C.divider).lineWidth(0.7).dash(3,{space:3}).stroke();
      doc.undash();
      doc.circle(STUB,6,5).fill(C.bgMain);
      doc.circle(STUB,H_PT-6,5).fill(C.bgMain);
      doc.rect(STUB+1,3,W_PT-STUB-1,H_PT-3).fill(C.bgStub);
      doc.rect(STUB,0,W_PT-STUB,3).fill(C.gold);

      const qrSize=88, qrX=STUB+(W_PT-STUB-qrSize)/2;
      doc.image(qrBuffer,qrX,12,{width:qrSize,height:qrSize});
      doc.font('Helvetica').fontSize(5).fillColor(C.gray).text('TICKET ID',STUB,105,{width:W_PT-STUB,align:'center',lineBreak:false});
      doc.font('Helvetica-Bold').fontSize(5.5).fillColor(C.goldLt).text(data.ticketId,STUB,113,{width:W_PT-STUB,align:'center',lineBreak:false});
      doc.font('Helvetica').fontSize(5).fillColor(C.gray).text('scan to verify result',STUB,155,{width:W_PT-STUB,align:'center',lineBreak:false});

      doc.end();
    });
  }
}