// api/report.js  (CommonJS)

const { transcribeWithSpeakers } = require('./_transcribe.js');

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

module.exports = async function handler(req, res) {
  // CORS בסיסי
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET') return res.status(200).json({ ok: true, message: 'report API is alive' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const {
      meetingTitle = 'סיכום ישיבה',
      meetingDate = '',
      scribeName = '',
      distribution = '',
      participants = '',
      audioUrl = ''
    } = req.body || {};

    const DEMO = String(process.env.DEMO_MODE || 'true').toLowerCase() === 'true';
    // לעזרה באבחון אפשר להדפיס:
    console.log('DEMO_MODE =', DEMO);

    let transcript;
    if (!DEMO) {
      if (!audioUrl) {
        return res.status(400).json({ error: 'audioUrl is required when DEMO_MODE=false' });
      }
      transcript = await transcribeWithSpeakers({ audioUrl, language: 'he' });
    } else {
      transcript = {
        text: 'שלום לכולם, נתחיל בעדכון סטטוס ותיאום לוחות זמנים.',
        segments: [
          { start: 0.0, end: 2.5, speaker: 'דובר 1', text: 'שלום לכולם' },
          { start: 2.6, end: 8.0, speaker: 'דובר 2', text: 'נתחיל בעדכון הסטטוס' }
        ],
        speakers: ['דובר 1', 'דובר 2']
      };
    }

    const attendeesAuto = transcript.speakers || [];
    const attendeesManual = participants
      ? participants.split('\n').map(s => s.trim()).filter(Boolean)
      : [];
    const allAttendees = Array.from(new Set([...attendeesManual, ...attendeesAuto]));

    const html = `
<section dir="rtl" style="font-family: system-ui; line-height:1.6; max-width:860px; margin:auto;">
  <h1 style="margin:0 0 12px;">${meetingTitle} – סיכום פגישה מתאריך ${meetingDate}</h1>

  <h3 style="margin:12px 0 6px;">רשימת נוכחים</h3>
  <ul>${allAttendees.map(n => `<li>${escapeHtml(n)}</li>`).join('')}</ul>

  <h3 style="margin:12px 0 6px;">תקציר תמלול לפי דוברים${DEMO ? ' (דמו)' : ''}</h3>
  <div style="background:#f7f7f7; padding:10px; border-radius:8px;">
    ${transcript.segments.map(s => `
      <p style="margin:6px 0;"><strong>${escapeHtml(s.speaker)}:</strong> ${escapeHtml(s.text)}</p>
    `).join('')}
  </div>

  <h3 style="margin:12px 0 6px;">טבלת נושאים/החלטות/לו"ז (סקיצה)</h3>
  <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse; width:100%;">
    <thead><tr><th>מס'</th><th>נושא</th><th>תיאור/החלטות</th><th>אחראי</th><th>לו"ז</th></tr></thead>
    <tbody>
      <tr><td>1</td><td>פתיחה</td><td>הצגת מטרות הפגישה</td><td>—</td><td>—</td></tr>
      <tr><td>2</td><td>סטטוס</td><td>עדכון התקדמות ותלויות</td><td>—</td><td>—</td></tr>
    </tbody>
  </table>

  <p style="margin-top:10px;">רשם/ת: ${escapeHtml(scribeName || '—')} | תפוצה: ${escapeHtml(distribution || '—')}</p>
  ${DEMO ? `<p style="font-size:0.9em; color:#666;">(מצב דמו פעיל – ללא עיבוד אמיתי)</p>` : ''}
</section>`.trim();

    const data = {
      title: `${meetingTitle} – ${meetingDate}`,
      attendees: allAttendees.map(name => ({ name })),
      items: [
        { id: 1, topic: 'פתיחה', decisions: 'הצגת מטרות', owner: '', due: '' },
        { id: 2, topic: 'סטטוס', decisions: 'עדכון התקדמות', owner: '', due: '' }
      ],
      transcript: {
        speakers: transcript.speakers,
        segments: transcript.segments
      },
      footer: { scribeName, distribution }
    };

    return res.status(200).json({ html, data });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'internal_error', details: String(e?.message || e) });
  }
};
