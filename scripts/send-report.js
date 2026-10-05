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
  const withinWindow = hour === 23 && minute >= 50;
  const withinPauseWindow = minutesIntoDay >= PAUSE_TIME_MINUTES && minutesIntoDay < PAUSE_TIME_MINUTES + 60;
  const forceSend = process.env.FORCE_SEND === 'true';
  const forcePause = process.env.FORCE_PAUSE === 'true';
  const doReport = forceSend || (withinWindow && isWeekday);
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
    await applyScheduledPauses(idToken);
  }
  if(!doReport){
    return;
  }

  // Fetch each board's tickets
  const boardRows = {};
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
  }

  const dateLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  }).format(new Date());

  const bodyText = BOARD_DEFS.map(def => renderBoardSectionText(def.label, boardRows[def.key])).join('\n\n');
  const bodyHtml = BOARD_DEFS.map(def => renderBoardSectionHtml(def.label, boardRows[def.key])).join('');

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
    html: `<h2>Dispatch Report — ${dateLabel}</h2>${bodyHtml}`
  });

  console.log('Report sent to ' + REPORT_RECIPIENT);

  if(!(withinWindow && isWeekday)){
    console.log('Force-tested outside the real weeknight window — leaving the boards untouched (no reset).');
    return;
  }

  // Reset every board's tickets and rotation pointer in one combined update
  const resetPatch = {};
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
