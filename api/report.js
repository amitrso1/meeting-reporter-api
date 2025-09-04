// api/report.js — תמלול + מיפוי דוברים + דו"ח חכם (CommonJS, הכל בקובץ)

// ---------- תמלול (AssemblyAI) ----------
async function transcribeWithSpeakersInline({ audioUrl, language = 'he' }) {
  const API_KEY = process.env.AIA_TRANSCRIBE_KEY;
  if (!API_KEY) throw new Error('Missing AIA_TRANSCRIBE_KEY');
  if (!audioUrl) throw new Error('audioUrl is required');

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

// ---------- עזר: HTML ----------
function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ---------- עזר: רשימת משתתפים (פסיקים/שורות/נקודה-פסיק) ----------
function parseParticipantsList(participantsText) {
  return String(participantsText || '')
    .split(/[,\u060C;|\n\r]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

// האם שם מהרשימה מופיע בטקסט (מלא או פרטי)
function findNameInText(names, text) {
  const t = String(text || '').toLowerCase();
  for (const name of names) {
    const parts = String(name).toLowerCase().split(/\s+/).filter(Boolean);
    if (parts.length > 1) {
      const full = parts.join(' ');
      if (t.includes(full)) return name;
    }
    if (parts.length > 0) {
      const first = parts[0];
      if (first.length >= 2 && t.includes(first)) return name;
    }
  }
  return null;
}

// מיפוי { תווית מקורית -> שם אנושי } (קודם לפי הופעת שם בטקסט, אח"כ לפי סדר)
function buildSpeakerMap(segments, participants) {
  const labelsOrder = [];
  const seenLabel = new Set();
  for (const s of segments) {
    if (!seenLabel.has(s.speaker)) {
      seenLabel.add(s.speaker);
      labelsOrder.push(s.speaker);
    }
  }

  const map = {};
  const assignedNames = new Set();

  for (const s of segments) {
    const label = s.speaker;
    if (map[label]) continue;
    const hit = findNameInText(participants, s.text);
    if (hit && !assignedNames.has(hit)) {
      map[label] = hit;
      assignedNames.add(hit);
    }
  }

  let pIdx = 0;
  for (const label of labelsOrder) {
    if (map[label]) continue;
    while (pIdx < participants.length && assignedNames.has(participants[pIdx])) pIdx++;
    if (pIdx < participants.length) {
      map[label] = participants[pIdx];
      assignedNames.add(participants[pIdx]);
      pIdx++;
    }
  }
  for (const label of labelsOrder) if (!map[label]) map[label] = label;
  return map;
}
function applySpeakerMap(segments, speakerMap) {
  return (segments || []).map(s => ({ ...s, speaker: speakerMap[s.speaker] || s.speaker }));
}

// ---------- דו״ח חכם עם LLM (OpenAI) ----------
async function generateReportItemsLLM({ transcriptText, meetingTitle, meetingDate }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('Missing OPENAI_API_KEY');

  // חיסכון: שולחים רק פתיח עד X תווים
  const MAX_CHARS = 6000;
  const text = String(transcriptText || '').slice(0, MAX_CHARS);

  const prompt = `
את/ה עורך/ת דו"חות ישיבות בעברית. קלט: תמלול פגישה בעברית.
החזר JSON בלבד עם השדות:
{
  "items": [
    { "topic": string, "decisions": string, "owner": string, "due": string }
  ],
  "summary": string
}

הנחיות:
- "items": 3–8 שורות תכל'ס. קצר ומדויק.
- אם לא צוין אחראי/לו"ז – השאר "—".
- ניסוח מקצועי, בעברית תקינה, ללא הקדמות/נימוקים נוספים.
כותרת: "${meetingTitle || ''}" | תאריך: "${meetingDate || ''}"

תמלול:
"""${text}"""
`.trim();

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'authorization': `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'את/ה ממיין/ת תמלול ומחזיר/ה JSON תקין בעברית.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.2
    })
  });
  if (!resp.ok) throw new Error('LLM call failed: ' + (await resp.text()));
  const data = await resp.json();
  let out;
  try {
    out = JSON.parse(data.choices?.[0]?.message?.content || '{}');
  } catch {
    out = { items: [], summary: '' };
  }
  if (!Array.isArray(out.items)) out.items = [];
  return out;
}

// ---------- ה־Handler הראשי ----------
module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // בדיקת בריאות
  if (req.method === 'GET') {
    try {
      const demo = String(process.env.DEMO_MODE || 'true').toLowerCase() === 'true';
      const hasTranscribeKey = !!process.env.AIA_TRANSCRIBE_KEY;
      const llmMode = String(process.env.LLM_MODE || 'false').toLowerCase() === 'true';
      const hasOpenAI = !!process.env.OPENAI_API_KEY;
      return res.status(200).json({ ok: true, demo, hasTranscribeKey, llmMode, hasOpenAI });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  }

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

    const demo = String(process.env.DEMO_MODE || 'true').toLowerCase() === 'true';
    const llmMode = String(process.env.LLM_MODE || 'false').toLowerCase() === 'true';

    // --- תמלול ---
    let transcript;
    if (demo) {
      transcript = {
        text: 'שלום לכולם, נתחיל בעדכון סטטוס ותיאום לוחות זמנים.',
        segments: [
          { start: 0.0, end: 2.5, speaker: 'A', text: 'שלום לכולם' },
          { start: 2.6, end: 8.0, speaker: 'B', text: 'נתחיל בעדכון הסטטוס' }
        ],
        speakers: ['A', 'B']
      };
    } else {
      transcript = await transcribeWithSpeakersInline({ audioUrl, language: 'he' });
    }

    // --- מיפוי דוברים ---
    const participantsList = parseParticipantsList(participants);
    const speakerMap = buildSpeakerMap(transcript.segments || [], participantsList);
    const remappedSegments = applySpeakerMap(transcript.segments || [], speakerMap);
    const attendees = Array.from(new Set([...participantsList, ...Object.values(speakerMap)]));

    // --- יצירת פריטי דו"ח חכמים (אופציונלי) ---
    let items = [
      { id: 1, topic: 'פתיחה', decisions: 'הצגת מטרות', owner: '—', due: '—' },
      { id: 2, topic: 'סטטוס', decisions: 'עדכון התקדמות', owner: '—', due: '—' }
    ];
    let summary = '';

    if (llmMode && !demo) {
      const { items: aiItems = [], summary: aiSummary = '' } =
        await generateReportItemsLLM({ transcriptText: transcript.text, meetingTitle, meetingDate });

      // נורמליזציה + הוספת מזהים
      items = (aiItems || []).slice(0, 8).map((it, idx) => ({
        id: idx + 1,
        topic: String(it.topic || '').trim() || '—',
        decisions: String(it.decisions || '').trim() || '—',
        owner: String(it.owner || '').trim() || '—',
        due: String(it.due || '').trim() || '—'
      }));
      if (items.length === 0) {
        items = [
          { id: 1, topic: 'פתיחה', decisions: '—', owner: '—', due: '—' }
        ];
      }
      summary = String(aiSummary || '').trim();
    }

    // --- HTML דו"ח ---
    const tableRows = items.map(r => `
      <tr>
        <td>${r.id}</td>
        <td>${escapeHtml(r.topic)}</td>
        <td>${escapeHtml(r.decisions)}</td>
        <td>${escapeHtml(r.owner)}</td>
        <td>${escapeHtml(r.due)}</td>
      </tr>
    `).join('');

    const html = `
<section dir="rtl" style="font-family: system-ui; line-height:1.6; max-width:860px; margin:auto;">
  <h1 style="margin:0 0 12px;">${escapeHtml(meetingTitle)} – סיכום פגישה מתאריך ${escapeHtml(meetingDate)}</h1>

  <h3 style="margin:12px 0 6px;">רשימת נוכחים</h3>
  <ul>${attendees.map(n => `<li>${escapeHtml(n)}</li>`).join('')}</ul>

  <h3 style="margin:12px 0 6px;">תקציר תמלול לפי דוברים${demo ? ' (דמו)' : ''}</h3>
  <div style="background:#f7f7f7; padding:10px; border-radius:8px;">
    ${remappedSegments.map(s => `
      <p style="margin:6px 0;"><strong>${escapeHtml(s.speaker)}:</strong> ${escapeHtml(s.text)}</p>
    `).join('')}
  </div>

  <h3 style="margin:12px 0 6px;">טבלת נושאים/החלטות/לו"ז ${llmMode && !demo ? '(אוטומטי)' : '(סקיצה)'}</h3>
  <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse; width:100%;">
    <thead><tr><th>מס'</th><th>נושא</th><th>תיאור/החלטות</th><th>אחראי</th><th>לו"ז</th></tr></thead>
    <tbody>${tableRows}</tbody>
  </table>

  ${summary ? `<h3 style="margin:12px 0 6px;">תקציר מנהלים</h3><p>${escapeHtml(summary)}</p>` : ''}

  <p style="margin-top:10px;">רשם/ת: ${escapeHtml(scribeName || '—')} | תפוצה: ${escapeHtml(distribution || '—')}</p>
  ${demo ? `<p style="font-size:0.9em; color:#666;">(מצב דמו פעיל – ללא עיבוד אמיתי)</p>` : ''}
</section>`.trim();

    // --- JSON מוחזר ---
    const data = {
      title: `${meetingTitle} – ${meetingDate}`,
      attendees: attendees.map(name => ({ name })),
      items,
      transcript: {
        speakers: attendees,
        segments: remappedSegments
      },
      summary,
      footer: { scribeName, distribution }
    };

    return res.status(200).json({ html, data });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'internal_error', details: String(e?.message || e) });
  }
};
