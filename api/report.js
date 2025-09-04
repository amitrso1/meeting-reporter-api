export default async function handler(req, res) {
  // נאפשר CORS בסיסי (כדי שהדפדפן יוכל לקרוא ל-API הזה)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // בדיקה פשוטה: אם פונים עם GET נחזיר "חי"
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, message: 'report API is alive' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // נקרא את הגוף שנשלח מהלקוח (Lovable)
    const {
      meetingTitle = 'סיכום ישיבה',
      meetingDate = '',
      scribeName = '',
      distribution = '',
      participants = '',
      audioUrl = ''
    } = req.body || {};

    // נבנה HTML דמו
    const demoHtml = `
<section dir="rtl" style="font-family: system-ui; line-height:1.6; max-width:860px; margin:auto;">
  <h1>${meetingTitle} – סיכום פגישה מתאריך ${meetingDate}</h1>
  <h3>רשימת נוכחים</h3>
  <pre>${participants || '—'}</pre>
  <h3>טבלת נושאים/החלטות/לו"ז (דמו)</h3>
  <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse; width:100%;">
    <thead><tr><th>מס'</th><th>נושא</th><th>תיאור/החלטות</th><th>אחראי</th><th>לו"ז</th></tr></thead>
    <tbody>
      <tr><td>1</td><td>פתיחה</td><td>סקירת מטרות הפגישה</td><td>—</td><td>—</td></tr>
      <tr><td>2</td><td>סטטוס</td><td>עדכון התקדמות בפרויקט</td><td>—</td><td>—</td></tr>
    </tbody>
  </table>
  <p>רשם/ת: ${scribeName || '—'} | תפוצה: ${distribution || '—'}</p>
  <p style="font-size:0.9em; color:#666;">(דמו: לא עיבדנו את הקובץ בפועל) audioUrl: ${audioUrl || '—'}</p>
</section>`;

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
