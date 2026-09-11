const nodemailer = require('nodemailer');

const FIREBASE_API_KEY = 'AIzaSyBlp-SsWSfVik4Mnix-ifFDkaiswr2pCik';
const DATABASE_URL = 'https://dispatch-rotation-tracker-default-rtdb.firebaseio.com';
const REPORT_RECIPIENT = 'kyle.pizer@verity-it.com';

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
    hour12: false
  }).formatToParts(new Date());
  const map = {};
  parts.forEach(p => { map[p.type] = p.value; });
  return { hour: parseInt(map.hour, 10), minute: parseInt(map.minute, 10) };
}

async function main(){
  // This workflow is scheduled twice (to cover both EST and EDT) so it never drifts
  // an hour off after Daylight Saving changes. Only the run that's actually landing
  // near 11:55 PM Eastern right now should go ahead and send.
  const { hour, minute } = nowInEastern();
  if(!(hour === 23 && minute >= 50)){
    console.log(`Skipping this run — it's ${hour}:${String(minute).padStart(2,'0')} Eastern, not the target window.`);
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

  const ticketsRes = await fetch(`${DATABASE_URL}/dispatch/tickets.json?auth=${idToken}`);
  const ticketsObj = (await ticketsRes.json()) || {};
  const tickets = Object.values(ticketsObj).sort((a, b) => (a.num || 0) - (b.num || 0));

  const dateLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  }).format(new Date());

  let bodyText, bodyHtml;
  if(tickets.length === 0){
    bodyText = 'No tickets were dispatched today.';
    bodyHtml = '<p>No tickets were dispatched today.</p>';
  } else {
    const rows = tickets.map(t => {
      const created = new Date(t.createdAt);
      const timeLabel = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
      }).format(created);
      return {
        num: t.num,
        title: t.title || '',
        priority: t.priority || '',
        assignedTo: t.assignedToName || 'Unassigned',
        time: timeLabel
      };
    });

    bodyText = rows.map(r =>
      `#${String(r.num).padStart(4,'0')}  ${r.title}  [${r.priority}]  -> ${r.assignedTo}  (${r.time})`
    ).join('\n');

    bodyHtml = `
      <table cellpadding="6" cellspacing="0" style="border-collapse:collapse; font-family:sans-serif; font-size:13px;">
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
    text: bodyText,
    html: `<h2>Dispatch Report — ${dateLabel}</h2>${bodyHtml}`
  });

  console.log('Report sent to ' + REPORT_RECIPIENT);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
