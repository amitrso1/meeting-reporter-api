// api/report.js — גרסה עצמאית ללא require, CommonJS

async function transcribeWithSpeakersInline({ audioUrl, language = 'he' }) {
  const API_KEY = process.env.AIA_TRANSCRIBE_KEY;
  if (!API_KEY) throw new Error('Missing AIA_TRANSCRIBE_KEY');
  if (!audioUrl) throw new Error('audioUrl is required');

  // 1) יצירת משימת תמלול עם זיהוי דוברים
  const createRes = await fetch('https://api.assemblyai.com/v2/transcript', {
    method: 'POST',
    headers: { authorization: API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      audio_url: audioUrl,
      speaker_labels: true,
      language_code: language,
      punctuate: true,
      format_text: true
    })
  });
  if (!createRes.ok) throw new Error('AIA create failed: ' + (await createRes.text()));
  const { id } = await createRes.json();

  // 2) Polling קצר (קבצים קצרים כדי להספיק במסגרת זמן הפונקציה)
  let result, status = 'processing';
  const start = Date.now();
  while (Date.now() - start < 25000) {
    await new Promise(r => setTimeout(r, 2500));
    const getRes = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, {
      headers: { authorization: API_KEY }
    });
    result = await getRes.json();
    status = result.status;
    if (status === 'completed' || status === 'error') break;
  }
  if (status !== 'completed') throw new Error('Transcription not completed in time');

  const segments = (result.utterances || []).map(u => ({
    start: (u.start || 0) / 1000,
    end: (u.end || 0) / 1000,
    speaker: u.speaker || 'דובר',
    text: u.text || ''
  }));
  const speakers = Array.from(new Set(segments.map(s => s.speaker)));

  return {
    text: result.text || segments.map(s => s.text).join(' '),
    segments,
    speakers
  };
}

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    try {
      const demo = String(process.env.DEMO_MODE || 'true').toLowerCase() === 'true';
      const hasTranscribeKey = !!process.env.AIA_TRANSCRIBE_KEY;
      return res.status(200).json({ ok: true, demo, hasTranscribeKey });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const {
      meetingTitle = 'סיכום ישיבה',
      meetingDate = '',
      scribeName = '',
      distribution = '',
      participants = '',
      audioUrl = ''
    } = req.body || {};

    const demo = String(process.env.DEMO_MODE || 'true').toLowerCase() === 'true';

    let transcript;
    if (demo) {
      transcript = {
        text: 'שלום לכולם, נתחיל בעדכון סטטוס ותיאום לוחות זמנים.',
        segments: [
          { start: 0.0, end: 2.5, speaker: 'דובר 1', text: 'שלום לכולם' },
          { start: 2.6, end: 8.0, speaker: 'דובר 2', text: 'נתחיל בעדכון הסטטוס' }
        ],
        speakers: ['דובר 1', 'דובר 2']
      };
    } else {
      transcript = await transcribeWithSpeakersInline({ audioUrl, language: 'he' });
    }

    const attendeesManual = participants
      ? participants.split('\n').map(s => s.trim()).filter(Boolean)
      : [];
    const attendeesAuto = transcript.speakers || [];
    const attendees = Array.from(new Set([...attendeesManual, ...attendeesAuto]));

    const html = `
<section dir="rtl" style="font-family: system-ui; line-height:1.6; max-width:860px; margin:auto;">
  <h1 style="margin:0 0 12px;">${escapeHtml(meetingTitle)} – סיכום פגישה מתאריך ${escapeHtml(meetingDate)}</h1>

  <h3 style="margin:12px 0 6px;">רשימת נוכחים</h3>
  <ul>${attendees.map(n => `<li>${escapeHtml(n)}</li>`).join('')}</ul>

  <h3 style="margin:12px 0 6px;">תקציר תמלול לפי דוברים${demo ? ' (דמו)' : ''}</h3>
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
  ${demo ? `<p style="font-size:0.9em; color:#666;">(מצב דמו פעיל – ללא עיבוד אמיתי)</p>` : ''}
</section>`.trim();

    const data = {
      title: `${meetingTitle} – ${meetingDate}`,
      attendees: attendees.map(name => ({ name })),
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
