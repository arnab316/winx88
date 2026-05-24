// src/ticket/ticket.controller.ts
//
// QR code on every bet ticket links to:
//   GET /ticket/:betCode/view  → HTML status page (user scans this)
//   GET /ticket/:betCode       → JSON API (frontend uses this)

import {
  Controller, Get, Param, Res, HttpStatus,
} from '@nestjs/common';
import { TicketService } from './ticket.service';
import type { Response } from 'express';

@Controller('ticket')
export class TicketController {
  constructor(private readonly ticketService: TicketService) {}

  // JSON API
  @Get(':betCode')
  async verifyTicket(@Param('betCode') betCode: string) {
    const data = await this.ticketService.verifyTicket(betCode);
    return { statusCode: HttpStatus.OK, message: 'Ticket verified', data };
  }

  // HTML page — what user sees when scanning QR
  @Get(':betCode/view')
  async verifyTicketHtml(
    @Param('betCode') betCode: string,
    @Res() res: Response,
  ) {
    let data: any = null;
    let error: string | null = null;
    try {
      data = await this.ticketService.verifyTicket(betCode);
    } catch (e: any) {
      error = e?.message || 'Ticket not found';
    }
    res.setHeader('Content-Type', 'text/html');
    res.status(200).send(renderPage(betCode, data, error));
  }
}

// ─────────────────────────────────────────────────────────────
function fmt(iso: string | null | undefined, opts?: any): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
    ...opts,
  });
}

function fmtMoney(val: any): string {
  return 'BDT ' + parseFloat(val).toLocaleString('en-IN', { minimumFractionDigits: 2 });
}

function renderPage(betCode: string, d: any, error: string | null): string {
  // ── Round status pill ──────────────────────────────────────
  const roundMeta: Record<string, { color: string; icon: string; label: string; desc: string }> = {
    OPEN:             { color: '#00e676', icon: '🟢', label: 'OPEN',             desc: 'Betting is currently open' },
    CLOSED:           { color: '#f0c96a', icon: '🔒', label: 'CLOSED',           desc: 'Betting closed — awaiting result' },
    RESULT_PUBLISHED: { color: '#00e5ff', icon: '📢', label: 'RESULT PUBLISHED', desc: 'Winning number has been declared' },
    SETTLED:          { color: '#7b52c0', icon: '✅', label: 'SETTLED',          desc: 'All bets have been paid out' },
  };

  // ── Bet status pill ────────────────────────────────────────
  const betMeta: Record<string, { color: string; icon: string }> = {
    PLACED:    { color: '#f0c96a', icon: '⏳' },
    WON:       { color: '#00e676', icon: '🏆' },
    LOST:      { color: '#ff4757', icon: '❌' },
    CANCELLED: { color: '#7a7590', icon: '🚫' },
  };

  const rs   = d?.round_status ?? 'UNKNOWN';
  const rm   = roundMeta[rs] ?? { color: '#7a7590', icon: '❓', label: rs, desc: '' };
  const bs   = d?.result_status ?? 'PLACED';
  const bm   = betMeta[bs] ?? { color: '#7a7590', icon: '❓' };

  const now       = Date.now();
  const closeTime = d?.close_time ? new Date(d.close_time).getTime() : 0;
  const drawTime  = d?.draw_time  ? new Date(d.draw_time).getTime()  : 0;

  // Countdown helpers
  function countdown(target: number): string {
    const s = Math.max(0, Math.floor((target - now) / 1000));
    if (s === 0) return 'now';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1">
  <title>WINX-88 · Ticket ${betCode}</title>
  <link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Rajdhani:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    :root{
      --bg:#07080f;--card:#0d0f1c;--card2:#111328;
      --border:#1e2240;--gold:#c9a84c;--goldlt:#f0c96a;
      --purple:#7b52c0;--muted:#6b6890;--text:#e8e4ff;
      --mono:'Share Tech Mono',monospace;--sans:'Rajdhani',sans-serif;
    }
    *{margin:0;padding:0;box-sizing:border-box;}
    body{
      background:var(--bg);color:var(--text);font-family:var(--sans);
      min-height:100vh;display:flex;flex-direction:column;
      align-items:center;padding:20px 16px 40px;
    }
    body::before{
      content:'';position:fixed;inset:0;pointer-events:none;
      background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,0.07) 2px,rgba(0,0,0,0.07) 4px);
    }
    /* header */
    .logo{font-family:var(--sans);font-weight:700;font-size:24px;color:var(--goldlt);letter-spacing:4px;margin-bottom:2px;margin-top:8px;}
    .logo-sub{font-family:var(--mono);font-size:10px;color:var(--muted);letter-spacing:2px;margin-bottom:24px;}
    /* card */
    .card{background:var(--card);border:1px solid var(--border);border-radius:14px;width:100%;max-width:400px;overflow:hidden;}
    /* section */
    .sec{padding:18px 20px;border-bottom:1px solid var(--border);}
    .sec:last-child{border-bottom:none;}
    .sec-title{font-family:var(--mono);font-size:10px;color:var(--muted);letter-spacing:2px;text-transform:uppercase;margin-bottom:12px;}
    /* round status banner */
    .round-banner{
      padding:16px 20px;
      display:flex;align-items:center;gap:12px;
    }
    .round-icon{font-size:28px;line-height:1;}
    .round-label{font-weight:700;font-size:18px;letter-spacing:1px;}
    .round-desc{font-family:var(--mono);font-size:11px;color:var(--muted);margin-top:2px;}
    /* bet number hero */
    .bet-hero{text-align:center;padding:20px;}
    .bet-hero-label{font-family:var(--mono);font-size:10px;color:var(--muted);letter-spacing:2px;margin-bottom:6px;}
    .bet-hero-num{font-family:var(--mono);font-size:52px;color:var(--goldlt);letter-spacing:10px;line-height:1;}
    .game-badge{display:inline-block;background:var(--purple);color:#fff;font-family:var(--mono);font-size:11px;padding:3px 10px;border-radius:4px;margin-top:8px;}
    /* bet status */
    .bet-status{
      display:flex;align-items:center;gap:8px;
      padding:10px 14px;border-radius:8px;border:1px solid;
      font-family:var(--mono);font-size:13px;font-weight:bold;letter-spacing:1px;
      width:fit-content;
    }
    /* result box */
    .result-box{
      text-align:center;padding:16px;
      background:rgba(0,229,118,0.06);border-radius:8px;
      border:1px solid rgba(0,229,118,0.2);
    }
    .result-label{font-family:var(--mono);font-size:10px;color:var(--muted);letter-spacing:2px;margin-bottom:6px;}
    .result-num{font-family:var(--mono);font-size:40px;color:#00e676;letter-spacing:8px;}
    /* rows */
    .row{display:flex;justify-content:space-between;align-items:flex-start;padding:8px 0;border-bottom:1px solid rgba(30,34,64,0.6);}
    .row:last-child{border-bottom:none;}
    .rk{font-family:var(--mono);font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;}
    .rv{font-family:var(--mono);font-size:12px;color:var(--text);text-align:right;max-width:58%;}
    .rv.gold{color:var(--goldlt);}
    .rv.green{color:#00e676;}
    .rv.cyan{color:#00e5ff;}
    /* timeline */
    .timeline{display:flex;flex-direction:column;gap:10px;}
    .tl-item{display:flex;gap:12px;align-items:flex-start;}
    .tl-dot{width:10px;height:10px;border-radius:50%;margin-top:3px;flex-shrink:0;}
    .tl-dot.done{background:#00e676;}
    .tl-dot.active{background:var(--goldlt);box-shadow:0 0 6px var(--goldlt);}
    .tl-dot.pending{background:var(--border);}
    .tl-label{font-family:var(--mono);font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;}
    .tl-val{font-family:var(--mono);font-size:12px;color:var(--text);}
    .tl-countdown{font-size:11px;color:var(--goldlt);}
    /* footer */
    .footer{margin-top:20px;font-family:var(--mono);font-size:10px;color:var(--muted);text-align:center;letter-spacing:1px;}
    .footer span{color:#00e676;}
    /* error */
    .err{background:var(--card);border:1px solid #ff4757;border-radius:14px;padding:40px 24px;text-align:center;max-width:400px;width:100%;}
    .err-icon{font-size:48px;margin-bottom:12px;}
    .err-title{font-size:20px;font-weight:700;color:#ff4757;margin-bottom:8px;}
    .err-code{font-family:var(--mono);font-size:12px;color:var(--muted);}
  </style>
</head>
<body>
<div class="logo">WINX-88</div>
<div class="logo-sub">TICKET VERIFICATION</div>

${error ? `
<div class="err">
  <div class="err-icon">🔍</div>
  <div class="err-title">Ticket Not Found</div>
  <div class="err-code">${betCode}</div>
  <div class="err-code" style="margin-top:8px;color:#7a7590">This ticket code is invalid or does not exist.</div>
</div>
` : `
<div class="card">

  <!-- ROUND STATUS BANNER -->
  <div class="round-banner" style="background:${rm.color}18;border-bottom:1px solid ${rm.color}33;">
    <div class="round-icon">${rm.icon}</div>
    <div>
      <div class="round-label" style="color:${rm.color}">${rm.label}</div>
      <div class="round-desc">${rm.desc}</div>
    </div>
  </div>

  <!-- BET NUMBER HERO -->
  <div class="bet-hero">
    <div class="bet-hero-label">YOUR BET NUMBER</div>
    <div class="bet-hero-num">${d.bet_number}</div>
    <div><span class="game-badge">${d.digit_length}D &middot; ${d.game_name}</span></div>
  </div>

  <!-- BET STATUS -->
  <div class="sec">
    <div class="sec-title">Bet Status</div>
    <div class="bet-status" style="color:${bm.color};border-color:${bm.color};background:${bm.color}18">
      ${bm.icon} &nbsp;${bs}
      ${bs === 'WON' ? `&nbsp;· You won ${fmtMoney(d.potential_payout)}!` : ''}
    </div>
  </div>

  <!-- RESULT (if declared) -->
  ${d.result_number ? `
  <div class="sec">
    <div class="sec-title">Winning Number</div>
    <div class="result-box">
      <div class="result-label">DECLARED RESULT</div>
      <div class="result-num">${d.result_number}</div>
      ${bs === 'WON' ? `<div style="color:#00e676;font-family:var(--mono);font-size:12px;margin-top:8px">🏆 Your number matched!</div>` : ''}
      ${bs === 'LOST' ? `<div style="color:#ff4757;font-family:var(--mono);font-size:12px;margin-top:8px">Your number did not match</div>` : ''}
    </div>
  </div>
  ` : ''}

  <!-- ROUND TIMELINE -->
  <div class="sec">
    <div class="sec-title">Round Timeline</div>
    <div class="timeline">
      <div class="tl-item">
        <div class="tl-dot done"></div>
        <div>
          <div class="tl-label">Betting Opened</div>
          <div class="tl-val">${fmt(d.open_time)}</div>
        </div>
      </div>
      <div class="tl-item">
        <div class="tl-dot ${now > closeTime ? 'done' : 'active'}"></div>
        <div>
          <div class="tl-label">Betting Closed</div>
          <div class="tl-val">${fmt(d.close_time)}</div>
          ${now < closeTime ? `<div class="tl-countdown">closes in ${countdown(closeTime)}</div>` : ''}
        </div>
      </div>
      <div class="tl-item">
        <div class="tl-dot ${d.result_number ? 'done' : now > drawTime ? 'active' : 'pending'}"></div>
        <div>
          <div class="tl-label">Draw Time</div>
          <div class="tl-val">${fmt(d.draw_time)}</div>
          ${!d.result_number && now < drawTime ? `<div class="tl-countdown">result in ${countdown(drawTime)}</div>` : ''}
          ${!d.result_number && now > drawTime ? `<div class="tl-countdown" style="color:#f0c96a">result pending...</div>` : ''}
        </div>
      </div>
      <div class="tl-item">
        <div class="tl-dot ${rs === 'SETTLED' ? 'done' : 'pending'}"></div>
        <div>
          <div class="tl-label">Settlement</div>
          <div class="tl-val">${d.settled_at ? fmt(d.settled_at) : rs === 'SETTLED' ? 'Completed' : 'Pending'}</div>
        </div>
      </div>
    </div>
  </div>

  <!-- BET DETAILS -->
  <div class="sec">
    <div class="sec-title">Bet Details</div>
    <div class="row"><span class="rk">Round</span><span class="rv">${d.round_code}</span></div>
    <div class="row"><span class="rk">Bet Amount</span><span class="rv gold">${fmtMoney(d.bet_amount)}</span></div>
    <div class="row"><span class="rk">Multiplier</span><span class="rv">×${parseFloat(d.payout_multiplier)}</span></div>
    <div class="row"><span class="rk">Potential Win</span><span class="rv green">${fmtMoney(d.potential_payout)}</span></div>
    <div class="row"><span class="rk">Placed At</span><span class="rv">${fmt(d.placed_at)}</span></div>
  </div>

  <!-- TICKET CODE -->
  <div class="sec" style="background:rgba(123,82,192,0.05);text-align:center;">
    <div class="sec-title" style="text-align:center">Ticket ID</div>
    <div style="font-family:var(--mono);font-size:12px;color:var(--goldlt);word-break:break-all">${d.bet_code}</div>
  </div>

</div>

<div class="footer">
  <span>✓ VERIFIED</span> &nbsp;·&nbsp; winx-88.com &nbsp;·&nbsp; ${new Date().toLocaleDateString('en-GB')}
</div>
`}
</body>
</html>`;
}