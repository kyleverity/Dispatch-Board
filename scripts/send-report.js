const nodemailer = require('nodemailer');

const FIREBASE_API_KEY = 'AIzaSyBlp-SsWSfVik4Mnix-ifFDkaiswr2pCik';
const DATABASE_URL = 'https://dispatch-rotation-tracker-default-rtdb.firebaseio.com';
const REPORT_RECIPIENT = 'kyle.pizer@verity-it.com';

const BOARD_DEFS = [
  { key: 'helpdesk', label: 'Help Desk', techsPath: 'dispatch/techs', ticketsPath: 'dispatch/tickets', metaPath: 'dispatch/meta' },
  { key: 'intake', label: 'Intake', techsPath: 'dispatch/intakeTechs', ticketsPath: 'dispatch/intakeTickets', metaPath: 'dispatch/intakeMeta' }
];

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function nowInEastern(){
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
    hour12: false
  }).formatToParts(new Date());
  const map = {};
  parts.forEach(p => { map[p.type] = p.value; });
  return { hour: parseInt(map.hour, 10), minute: parseInt(map.minute, 10), weekday: map.weekday };
}

function todayKeyEastern(){
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const map = {};
  parts.forEach(p => { map[p.type] = p.value; });
  return `${map.year}-${map.month}-${map.day}`;
}

function timeLabelFor(iso){
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  }).format(new Date(iso));
}

// Techs who get paused automatically each afternoon. They're unpaused again by the
// nightly reset below (and by the page itself if it happens to do the reset first).
const AUTO_PAUSE_SCHEDULE = [
  { boardKey: 'helpdesk', name: 'Arpita' }
];
const PAUSE_TIME_MINUTES = 15 * 60 + 30; // 3:30 PM Eastern

async function applyScheduledPauses(idToken){
  for(const entry of AUTO_PAUSE_SCHEDULE){
    const def = BOARD_DEFS.find(b => b.key === entry.boardKey);
    const techsRes = await fetch(`${DATABASE_URL}/${def.techsPath}.json?auth=${idToken}`);
    const techsObj = (await techsRes.json()) || {};
    const sorted = Object.entries(techsObj).sort((a, b) => (a[1].order || 0) - (b[1].order || 0));
    const idx = sorted.findIndex(([, t]) => t.name === entry.name);
    if(idx === -1){
      console.log(`Scheduled pause: couldn't find ${entry.name} on ${def.label} — skipping.`);
      continue;
    }
    const id = sorted[idx][0];

    // Paths are relative to the "dispatch" node, since the PATCH targets it directly.
    const techsKey = def.techsPath.replace(/^dispatch\//, '');
    const metaKey = def.metaPath.replace(/^dispatch\//, '');
    const patch = {};
    patch[`${techsKey}/${id}/active`] = false;

    // If she's the one on deck, move the pointer to the next active tech after her
    // in the rotation order (wrapping around) rather than back to the top.
    const metaRes = await fetch(`${DATABASE_URL}/${def.metaPath}.json?auth=${idToken}`);
    const meta = (await metaRes.json()) || {};
    if(meta.nextTechId === id){
      let nextId = null;
      for(let i = 1; i <= sorted.length; i++){
        const candidate = sorted[(idx + i) % sorted.length];
        if(candidate[0] !== id && candidate[1].active){
          nextId = candidate[0];
          break;
        }
      }
      patch[`${metaKey}/nextTechId`] = nextId;
    }

    const res = await fetch(`${DATABASE_URL}/dispatch.json?auth=${idToken}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    });
    if(!res.ok){
      throw new Error(`Scheduled pause failed for ${entry.name}: ` + (await res.text()));
    }
    console.log(`Paused ${entry.name} on ${def.label} for the rest of the day.`);
  }
}

// Builds the per-tech ticket counts for one board. Everyone on the board is listed
// (even with 0 tickets), plus anyone named on a ticket who has since been removed.
function buildLeaderboard(techsObj, rows){
  const counts = new Map();
  Object.values(techsObj || {})
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .forEach(t => { if(t && t.name) counts.set(t.name, 0); });
  rows.forEach(r => {
    if(r.assignedTo === 'Unassigned') return;
    counts.set(r.assignedTo, (counts.get(r.assignedTo) || 0) + 1);
  });
  const list = Array.from(counts, ([name, count]) => ({ name, count }));
  // Highest count first; ties keep rotation order (sort is stable).
  list.sort((a, b) => b.count - a.count);
  // Ties share a rank (1, 2, 2, 4 ...).
  list.forEach((p, i) => {
    p.rank = (i > 0 && list[i - 1].count === p.count) ? list[i - 1].rank : i + 1;
  });
  return list;
}

const MEDALS = { 1: '🥇', 2: '🥈', 3: '🥉' };

function renderLeaderboardText(label, board){
  const total = board.reduce((n, p) => n + p.count, 0);
  if(board.length === 0 || total === 0){
    return `${label} — Tickets by Tech\n  No tickets were dispatched today.`;
  }
  const width = Math.max(...board.map(p => p.name.length));
  const lines = board.map(p =>
    `  ${String(p.rank).padStart(2)}. ${p.name.padEnd(width)}  ${p.count}`
  );
  return `${label} — Tickets by Tech\n${lines.join('\n')}\n  ${'Total'.padEnd(width + 4)}  ${total}`;
}

function renderLeaderboardHtml(label, board){
  const total = board.reduce((n, p) => n + p.count, 0);
  if(board.length === 0 || total === 0){
    return `<h3>${escapeHtml(label)} — Tickets by Tech</h3><p>No tickets were dispatched today.</p>`;
  }
  const max = Math.max(...board.map(p => p.count));
  return `
    <h3>${escapeHtml(label)} — Tickets by Tech</h3>
    <table cellpadding="6" cellspacing="0" style="border-collapse:collapse; font-family:sans-serif; font-size:13px; margin-bottom:20px; min-width:360px;">
      <tr style="text-align:left; border-bottom:2px solid #333;">
        <th>Rank</th><th>Tech</th><th style="text-align:right;">Tickets</th><th></th>
      </tr>
      ${board.map(p => `
        <tr style="border-bottom:1px solid #ddd;">
          <td>${p.count > 0 && MEDALS[p.rank] ? MEDALS[p.rank] + ' ' : ''}${p.rank}</td>
          <td>${escapeHtml(p.name)}</td>
          <td style="text-align:right; font-weight:bold;">${p.count}</td>
          <td style="width:140px;"><div style="background:#E8A93A; height:10px; width:${Math.round((p.count / max) * 130)}px;"></div></td>
        </tr>`).join('')}
      <tr style="border-top:2px solid #333; font-weight:bold;">
        <td></td><td>Total</td><td style="text-align:right;">${total}</td><td></td>
      </tr>
    </table>
  `;
}

// ---------------------------------------------------------------------------
// Combined pie chart (everyone on both boards).
// Email apps can't run scripts or show drawn shapes, so the pie is made as a small
// PNG image right here (no extra packages needed) and attached inside the email.
// ---------------------------------------------------------------------------
const zlib = require('zlib');

const RAMPS = {
  helpdesk: ['#184f95', '#3987e5', '#256abf', '#6da7ec', '#9ec5f4'],   // blues
  intake:   ['#a83f10', '#eb6834', '#f3a07a'],                         // oranges
  both:     ['#0f7a52', '#1baf7a', '#8fdcbc']                          // greens
};

function hexToRgb(h){
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function colorFor(group, i, n){
  const ramp = RAMPS[group];
  if(i < ramp.length) return ramp[i];
  // More techs than ramp steps: reuse the ramp from the start (labels still tell them apart).
  return ramp[i % ramp.length];
}

// One slice per person across both boards. Anyone on both boards (e.g. Chalcie) gets a
// single slice with their tickets added together.
function buildPieSlices(boardLeaders){
  const people = new Map();
  BOARD_DEFS.forEach(def => {
    (boardLeaders[def.key] || []).forEach(p => {
      const e = people.get(p.name) || { name: p.name, count: 0, boards: new Set() };
      e.count += p.count;
      e.boards.add(def.key);
      people.set(p.name, e);
    });
  });
  const groupOf = e => e.boards.size > 1 ? 'both' : (e.boards.has('helpdesk') ? 'helpdesk' : 'intake');
  const order = ['helpdesk', 'both', 'intake'];
  const slices = [];
  order.forEach(g => {
    const members = Array.from(people.values()).filter(e => groupOf(e) === g && e.count > 0);
    members.sort((a, b) => b.count - a.count);   // stable: ties keep rotation order
    members.forEach((e, i) => slices.push({ name: e.name, count: e.count, group: g, color: colorFor(g, i, members.length) }));
  });
  return slices;
}

const PIE_GROUP_LABELS = { helpdesk: 'Help Desk', both: 'Both boards', intake: 'Intake' };

// 5x7 pixel digits so the counts can be drawn on the slices without any font files.
const DIGITS = {
  '0': ['01110','10001','10011','10101','11001','10001','01110'],
  '1': ['00100','01100','00100','00100','00100','00100','01110'],
  '2': ['01110','10001','00001','00010','00100','01000','11111'],
  '3': ['11110','00001','00001','01110','00001','00001','11110'],
  '4': ['00010','00110','01010','10010','11111','00010','00010'],
  '5': ['11111','10000','11110','00001','00001','10001','01110'],
  '6': ['00110','01000','10000','11110','10001','10001','01110'],
  '7': ['11111','00001','00010','00100','01000','01000','01000'],
  '8': ['01110','10001','10001','01110','10001','10001','01110'],
  '9': ['01110','10001','10001','01111','00001','00010','01100']
};

let CRC_TABLE = null;
function crc32(buf){
  if(!CRC_TABLE){
    CRC_TABLE = new Int32Array(256);
    for(let n = 0; n < 256; n++){
      let c = n;
      for(let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for(let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 255] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}
function pngChunk(type, data){
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(width, height, rgba){
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8-bit RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for(let y = 0; y < height; y++){
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

// Draws the pie at 420x420 (shown at 210 wide in the email, so it stays sharp on
// high-resolution screens). Slices start at 12 o'clock and run clockwise.
function renderPiePng(slices){
  const S = 420, SS = 3, cx = S / 2, cy = S / 2, R = S / 2 - 4, GAP = 3, SCALE = 3;
  const total = slices.reduce((n, s) => n + s.count, 0);
  const bounds = [];
  let acc = 0;
  slices.forEach(s => { const start = acc; acc += s.count / total * Math.PI * 2; bounds.push([start, acc]); });

  // Text layer: each slice's count, drawn in black or white depending on the slice color.
  const textMask = new Uint8Array(S * S);   // 0 none, 1 dark text, 2 light text
  slices.forEach((s, i) => {
    if(s.count / total < 0.05) return;
    const label = String(s.count);
    const w = label.length * 5 + (label.length - 1);
    const mid = (bounds[i][0] + bounds[i][1]) / 2;
    const rr = slices.length === 1 ? 0 : R * 0.64;
    const tx = Math.round(cx + rr * Math.sin(mid) - w * SCALE / 2);
    const ty = Math.round(cy - rr * Math.cos(mid) - 7 * SCALE / 2);
    const [r, g, b] = hexToRgb(s.color);
    const mark = (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? 1 : 2;
    for(let d = 0; d < label.length; d++){
      const glyph = DIGITS[label[d]];
      for(let gy = 0; gy < 7; gy++) for(let gx = 0; gx < 5; gx++){
        if(glyph[gy][gx] !== '1') continue;
        for(let py = 0; py < SCALE; py++) for(let px = 0; px < SCALE; px++){
          const x = tx + (d * 6 + gx) * SCALE + px, y = ty + gy * SCALE + py;
          if(x >= 0 && x < S && y >= 0 && y < S) textMask[y * S + x] = mark;
        }
      }
    }
  });

  const rgba = Buffer.alloc(S * S * 4);
  const colors = slices.map(s => hexToRgb(s.color));
  for(let y = 0; y < S; y++){
    for(let x = 0; x < S; x++){
      let rs = 0, gs = 0, bs = 0, hits = 0;
      for(let sy = 0; sy < SS; sy++){
        for(let sx = 0; sx < SS; sx++){
          const fx = x + (sx + 0.5) / SS, fy = y + (sy + 0.5) / SS;
          const dx = fx - cx, dy = fy - cy;
          const r = Math.sqrt(dx * dx + dy * dy);
          if(r > R) continue;
          hits++;
          const t = textMask[y * S + x];
          if(t){
            if(t === 1){ rs += 11; gs += 11; bs += 11; } else { rs += 255; gs += 255; bs += 255; }
            continue;
          }
          let phi = Math.atan2(dx, -dy);
          if(phi < 0) phi += Math.PI * 2;
          let idx = bounds.findIndex(b => phi < b[1]);
          if(idx === -1) idx = slices.length - 1;
          let gap = false;
          if(slices.length > 1){
            const nearest = Math.min(phi - bounds[idx][0], bounds[idx][1] - phi);
            const wrapNearest = Math.min(nearest, (idx === 0 ? Math.PI * 2 - phi : Infinity), (idx === slices.length - 1 ? phi : Infinity));
            gap = Math.min(nearest, wrapNearest) * r < GAP / 2;
          }
          if(gap){ rs += 255; gs += 255; bs += 255; }
          else { rs += colors[idx][0]; gs += colors[idx][1]; bs += colors[idx][2]; }
        }
      }
      const o = (y * S + x) * 4;
      if(hits){
        rgba[o] = Math.round(rs / hits); rgba[o + 1] = Math.round(gs / hits); rgba[o + 2] = Math.round(bs / hits);
        rgba[o + 3] = Math.round(255 * hits / (SS * SS));
      }
    }
  }
  return encodePng(S, S, rgba);
}

function renderPieLegendHtml(slices){
  const total = slices.reduce((n, s) => n + s.count, 0);
  return ['helpdesk', 'both', 'intake'].map(g => {
    const rows = slices.filter(s => s.group === g);
    if(rows.length === 0) return '';
    return `
      <div style="font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:#52514e; margin:10px 0 3px;">${PIE_GROUP_LABELS[g]}</div>
      <table cellpadding="0" cellspacing="0" style="border-collapse:collapse; font-size:13px; min-width:210px;">
        ${rows.map(s => `
          <tr>
            <td style="padding:2px 8px 2px 0;"><div style="width:11px; height:11px; background:${s.color};"></div></td>
            <td style="padding:2px 14px 2px 0;">${escapeHtml(s.name)}</td>
            <td style="padding:2px 12px 2px 0; text-align:right; font-weight:bold;">${s.count}</td>
            <td style="padding:2px 0; text-align:right; color:#52514e;">${Math.round(s.count / total * 100)}%</td>
          </tr>`).join('')}
      </table>`;
  }).join('');
}

function renderBoardSectionText(label, rows){
  if(rows.length === 0){
    return `${label}\n  No tickets were dispatched today.`;
  }
  const lines = rows.map(r =>
    `  #${String(r.num).padStart(4,'0')}  ${r.title}  [${r.priority}]  -> ${r.assignedTo}  (${r.time})`
  );
  return `${label}\n${lines.join('\n')}`;
}

function renderBoardSectionHtml(label, rows){
  if(rows.length === 0){
    return `<h3>${escapeHtml(label)}</h3><p>No tickets were dispatched today.</p>`;
  }
  return `
    <h3>${escapeHtml(label)}</h3>
    <table cellpadding="6" cellspacing="0" style="border-collapse:collapse; font-family:sans-serif; font-size:13px; margin-bottom:20px;">
      <tr style="text-align:left; border-bottom:2px solid #333;">
        <th>#</th><th>Ticket</th><th>Priority</th><th>Assigned To</th><th>Time</th>
      </tr>
      ${rows.map(r => `
        <tr style="border-bottom:1px solid #ddd;">
          <td>#${String(r.num).padStart(4,'0')}</td>
          <td>${escapeHtml(r.title)}</td>
          <td>${escapeHtml(r.priority)}</td>
          <td>${escapeHtml(r.assignedTo)}</td>
          <td>${r.time}</td>
        </tr>`).join('')}
    </table>
  `;
}

async function main(){
  // This workflow is scheduled twice per job (to cover both EST and EDT) so it never
  // drifts an hour off after Daylight Saving changes. Only the run that's actually
  // landing in the right Eastern-time window does anything:
  //   - 3:30-4:29 PM  -> apply the scheduled pauses (e.g. Arpita leaving at 3:30)
  //   - 11:50-11:59 PM -> send the report, then reset the boards for the new day
  // Both only happen Monday through Friday (by the Eastern-time calendar day). That
  // also keeps the pause from firing on a weekend, which would leave Arpita paused
  // until the next weeknight reset.
  const { hour, minute, weekday } = nowInEastern();
  const isWeekday = weekday !== 'Sat' && weekday !== 'Sun';
  const minutesIntoDay = hour * 60 + minute;
  // 9:00-11:59 PM Eastern (dispatching stops at 5 PM Central, so 9 PM is safely after).
  // The workflow tries several times in this stretch, because GitHub often starts
  // scheduled runs late (or occasionally drops one). The lastReportDate marker below
  // makes sure extra attempts never send a second report.
  const withinWindow = hour >= 21 && hour <= 23;
  // 3:30-5:29 PM Eastern. Several attempts run in this stretch (GitHub often starts
  // scheduled runs late or drops one); the lastPauseDate marker below makes sure only
  // the first one pauses, so a later manual unpause isn't undone.
  const withinPauseWindow = minutesIntoDay >= PAUSE_TIME_MINUTES && minutesIntoDay < PAUSE_TIME_MINUTES + 120;
  const forceSend = process.env.FORCE_SEND === 'true';
  const forcePause = process.env.FORCE_PAUSE === 'true';
  let doReport = forceSend || (withinWindow && isWeekday);
  const doPause = forcePause || (withinPauseWindow && isWeekday);

  if(forceSend) console.log('Force-send enabled — skipping the report time-window check.');
  if(forcePause) console.log('Force-pause enabled — skipping the pause time-window check.');
  if(!doReport && !doPause){
    const why = (!isWeekday && (withinWindow || withinPauseWindow)) ? 'weekend — no report or reset' : 'not a target window';
    console.log(`Skipping this run — it's ${weekday} ${hour}:${String(minute).padStart(2,'0')} Eastern (${why}).`);
    return;
  }

  const signInRes = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: process.env.DISPATCH_EMAIL,
      password: process.env.DISPATCH_PASSWORD,
      returnSecureToken: true
    })
  });
  const signInData = await signInRes.json();
  if(!signInData.idToken){
    throw new Error('Firebase sign-in failed: ' + JSON.stringify(signInData));
  }
  const idToken = signInData.idToken;

  if(doPause){
    let alreadyPaused = false;
    if(!forcePause){
      const pRes = await fetch(`${DATABASE_URL}/dispatch/lastPauseDate.json?auth=${idToken}`);
      alreadyPaused = (await pRes.json()) === todayKeyEastern();
    }
    if(alreadyPaused){
      console.log("Today's scheduled pause was already applied — nothing more to do.");
    } else {
      await applyScheduledPauses(idToken);
      if(!forcePause){
        const mRes = await fetch(`${DATABASE_URL}/dispatch.json?auth=${idToken}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lastPauseDate: todayKeyEastern() })
        });
        if(!mRes.ok) throw new Error('Could not record pause marker: ' + (await mRes.text()));
      }
    }
  }

  // Several attempts are scheduled each night. If an earlier one already sent tonight's
  // report (and reset the boards), this one has nothing to do. Manual force-sends skip
  // this check so you can still test whenever you like.
  if(doReport && !forceSend){
    const sentRes = await fetch(`${DATABASE_URL}/dispatch/lastReportDate.json?auth=${idToken}`);
    const lastReportDate = await sentRes.json();
    if(lastReportDate === todayKeyEastern()){
      console.log(`Tonight's report was already sent (${lastReportDate}) — nothing more to do.`);
      doReport = false;
    }
  }
  if(!doReport){
    return;
  }

  // Fetch each board's tickets
  const boardRows = {};
  const boardLeaders = {};
  for(const def of BOARD_DEFS){
    const res = await fetch(`${DATABASE_URL}/${def.ticketsPath}.json?auth=${idToken}`);
    const obj = (await res.json()) || {};
    const tickets = Object.values(obj).sort((a, b) => (a.num || 0) - (b.num || 0));
    boardRows[def.key] = tickets.map(t => ({
      num: t.num,
      title: t.title || '',
      priority: t.priority || '',
      assignedTo: t.assignedToName || 'Unassigned',
      time: timeLabelFor(t.createdAt)
    }));
    const techsRes = await fetch(`${DATABASE_URL}/${def.techsPath}.json?auth=${idToken}`);
    const techsObj = (await techsRes.json()) || {};
    boardLeaders[def.key] = buildLeaderboard(techsObj, boardRows[def.key]);
  }

  const dateLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  }).format(new Date());

  const leaderText = BOARD_DEFS.map(def => renderLeaderboardText(def.label, boardLeaders[def.key])).join('\n\n');
  let leaderHtml = BOARD_DEFS.map(def => renderLeaderboardHtml(def.label, boardLeaders[def.key])).join('');

  // Combined pie of everyone on both boards, shown to the right of the two tables.
  // If anything goes wrong drawing it, the report still goes out with just the tables.
  const attachments = [];
  try {
    const slices = buildPieSlices(boardLeaders);
    if(slices.length > 0){
      attachments.push({ filename: 'tickets-pie.png', content: renderPiePng(slices), cid: 'ticketspie', contentType: 'image/png' });
      leaderHtml = `
        <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr>
          <td valign="top">${leaderHtml}</td>
          <td valign="top" style="padding-left:36px;">
            <h3 style="font-family:sans-serif;">Everyone — Share of Tickets</h3>
            <img src="cid:ticketspie" width="210" height="210" alt="Share of tickets by tech" style="display:block;" />
            <div style="font-family:sans-serif;">${renderPieLegendHtml(slices)}</div>
          </td>
        </tr></table>`;
    }
  } catch(err){
    console.log('Could not draw the pie chart — sending the report without it: ' + err.message);
  }
  const detailText = BOARD_DEFS.map(def => renderBoardSectionText(def.label, boardRows[def.key])).join('\n\n');
  const detailHtml = BOARD_DEFS.map(def => renderBoardSectionHtml(def.label, boardRows[def.key])).join('');
  const bodyText = `LEADERBOARD\n\n${leaderText}\n\nALL TICKETS\n\n${detailText}`;
  const bodyHtml = `<h2 style="font-family:sans-serif; margin-bottom:4px;">Leaderboard</h2>${leaderHtml}<h2 style="font-family:sans-serif; margin-bottom:4px;">All Tickets</h2>${detailHtml}`;

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD
    }
  });

  await transporter.sendMail({
    from: `Dispatch Tracker <${process.env.GMAIL_USER}>`,
    to: REPORT_RECIPIENT,
    subject: `Dispatch Report — ${dateLabel}`,
    text: `Dispatch Report — ${dateLabel}\n\n${bodyText}`,
    html: `<h2>Dispatch Report — ${dateLabel}</h2>${bodyHtml}`,
    attachments
  });

  console.log('Report sent to ' + REPORT_RECIPIENT);

  if(!(withinWindow && isWeekday)){
    console.log('Force-tested outside the real weeknight window — leaving the boards untouched (no reset).');
    return;
  }

  // Reset every board's tickets and rotation pointer in one combined update
  const resetPatch = {};
  resetPatch.lastReportDate = todayKeyEastern(); // marks tonight as done so retries skip
  for(const def of BOARD_DEFS){
    const techsRes = await fetch(`${DATABASE_URL}/${def.techsPath}.json?auth=${idToken}`);
    const techsObj = (await techsRes.json()) || {};
    const sortedTechs = Object.entries(techsObj).sort((a, b) => (a[1].order || 0) - (b[1].order || 0));
    const firstTechId = sortedTechs.length ? sortedTechs[0][0] : null;

    // Paths are like "dispatch/tickets" / "dispatch/intakeTickets" — strip the
    // leading "dispatch/" since the PATCH below targets the dispatch node itself.
    const ticketsKey = def.ticketsPath.replace(/^dispatch\//, '');
    const metaKey = def.metaPath.replace(/^dispatch\//, '');

    resetPatch[ticketsKey] = null;
    resetPatch[metaKey] = {
      nextTechId: firstTechId,
      nextTicketNum: 1,
      lastResetDate: todayKeyEastern()
    };

    // Bring any auto-paused techs back so they're available in the morning
    const techsKey = def.techsPath.replace(/^dispatch\//, '');
    AUTO_PAUSE_SCHEDULE.filter(s => s.boardKey === def.key).forEach(s => {
      const match = sortedTechs.find(([, t]) => t.name === s.name);
      if(match){
        resetPatch[`${techsKey}/${match[0]}/active`] = true;
        console.log(`Unpausing ${s.name} (${def.label}) for the new day.`);
      }
    });
  }

  const resetRes = await fetch(`${DATABASE_URL}/dispatch.json?auth=${idToken}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(resetPatch)
  });
  if(!resetRes.ok){
    throw new Error('Reset failed: ' + (await resetRes.text()));
  }
  console.log('Both boards reset for the new day — rotations back to the top.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
