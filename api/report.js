export default async function handler(req, res) {
  // ===== CORS רחב =====
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Requested-With, Accept, Origin'
  );

  if (req.method === 'OPTIONS') {
    // Preflight
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    // בדיקת חיים
    return res.status(200).json({ ok: true, message: 'report API is alive' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // ===== קריאת גוף הבקשה בבטחה =====
    // לפעמים req.body לא קיים בפונקציות Node של Vercel, אז נקרא ידנית מהזרם.
    let body = {};
    if (req.body && typeof req.body === 'object') {
      body = req.body;
    } else {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString('utf8') || '';
      if (raw.trim()) {
        try { body = JSON.parse(raw); } catch (e) { /* JSON לא תקין */ }
      }
    }

    const {
      meetingTitle = 'סיכום ישיבה',
      meetingDate = '',
      scribeName = '',
      distribution = '',
      participants = '',
      audioUrl = ''
    } = body;

    // ===== מצב דמו בלבד (ללא תמלול אמיתי) =====
    const demoHtml = `
<section dir="rtl" style="font-family: system-ui; line-height:1.6; max-width:860px; margin:auto;">
  <h1 style="margin:0 0 12px;">${escapeHtml(meetingTitle)} – סיכום פגישה מתאריך ${escapeHtml(meetingDate)}</h1>

  <h3 style="margin:12px 0 6px;">רשימת נוכחים</h3>
  <pre style="background:#f6f6f6; padding:8px; border-radius:8px;">${escapeHtml(participants || '—')}</pre>

  <h3 style="margin:12px 0 6px;">תקציר תמלול לפי דוברים (דמו)</h3>
  <div style="background:#f7f7f7; padding:10px; border-radius:8px;">
    <p style="margin:6px 0;"><strong>דובר 1:</strong> שלום לכולם</p>
    <p style="margin:6px 0;"><strong>דובר 2:</strong> נתחיל בעדכון הסטטוס</p>
  </div>

  <h3 style="margin:12px 0 6px;">טבלת נושאים/החלטות/לו"ז (דמו)</h3>
  <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse; width:100%;">
    <thead><tr><th>מס'</th><th>נושא</th><th>תיאור/החלטות</th><th>אחראי</th><th>לו"ז</th></tr></thead>
    <tbody>
      <tr><td>1</td><td>פתיחה</td><td>סקירת מטרות הפגישה</td><td>—</td><td>—</td></tr>
      <tr><td>2</td><td>סטטוס</td><td>עדכון התקדמות בפרויקט</td><td>—</td><td>—</td></tr>
    </tbody>
  </table>

  <p style="margin-top:10px;">רשם/ת: ${escapeHtml(scribeName || '—')} | תפוצה: ${escapeHtml(distribution || '—')}</p>
  <p style="font-size:0.9em; color:#666;">(דמו: לא עיבדנו את הקובץ בפועל) audioUrl: ${escapeHtml(audioUrl || '—')}</p>
</section>`.trim();

    const demoData = {
      title: `${meetingTitle} – ${meetingDate}`,
      attendees: participants
        ? participants.split('\n').map(s => s.trim()).filter(Boolean).map(name => ({ name }))
        : [],
      items: [
        { id: 1, topic: 'פתיחה', decisions: 'סקירת מטרות', owner: '', due: '' },
        { id: 2, topic: 'סטטוס', decisions: 'עדכון התקדמות', owner: '', due: '' }
      ],
      footer: { scribeName, distribution }
    };

    return res.status(200).json({ html: demoHtml, data: demoData });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'internal_error', details: String(e?.message || e) });
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;');
}
