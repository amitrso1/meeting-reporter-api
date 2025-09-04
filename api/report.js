// api/report.js — הכל בקובץ: תמלול + מיפוי דוברים + דו"ח חכם + Async fallback (CommonJS)

// ============================= תמלול (AssemblyAI) =============================
async function createTranscriptJob({ audioUrl, language = 'he' }) {
  const API_KEY = process.env.AIA_TRANSCRIBE_KEY;
  if (!API_KEY) throw new Error('Missing AIA_TRANSCRIBE_KEY');
  if (!audioUrl) throw new Error('audioUrl is required');

  const resp = await fetch('https://api.assemblyai.com/v2/transcript', {
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
  if (!resp.ok) throw new Error('AIA create failed: ' + (await resp.text()));
  const json = await resp.json();
  return json.id;
}

async function fetchTranscriptResult(id) {
  const API_KEY = process.env.AIA_TRANSCRIBE_KEY;
  const resp = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, {
    headers: { authorization: API_KEY }
  });
  if (!resp.ok) throw new Error('AIA fetch failed: ' + (await resp.text()));
  return await resp.json();
}

function normalizeTranscript(result) {
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

async function transcribeWithSpeakersInline({ audioUrl, language = 'he', pollMs = 25000 }) {
  const id = await createTranscriptJob({ audioUrl, language });
  const start = Date.now();
  let status = 'processing', result = null;

  while (Date.now() - start < pollMs) {
    await new Promise(r => setTimeout(r, 2500));
    const json = await fetchTranscriptResult(id);
    status = json.status;
    if (status === 'completed') {
      result = normalizeTranscript(json);
      return { status, transcript: result, id };
    }
    if (status === 'error') {
      const err = json.error || 'unknown error';
      throw new Error('Transcription error: ' + err);
    }
  }
  // לא הושלם בזמן — נחזיר מצב עיבוד + id כדי שהלקוח יוכל לפול
  return { status: 'processing', id };
}

// ============================= עזר: HTML/טקסט =============================
function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// רשימת משתתפים (תמיכה בפסיקים/נקודה-פסיק/שורות)
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
    if (!seenLabel.has(s.speaker)) { seenLabel.add(s.speaker); labelsOrder.push(s.speaker); }
  }

  const map = {};
  const assigned = new Set();

  // לפי הופעת שם בטקסט
  for (const s of segments) {
    const label = s.speaker;
    if (map[label]) continue;
    const hit = findNameInText(participants, s.text);
    if (hit && !assigned.has(hit)) { map[label] = hit; assigned.add(hit); }
  }

  // לפי סדר הופעה
  let p = 0;
  for (const label of labelsOrder) {
    if (map[label]) continue;
    while (p < participants.length && assigned.has(participants[p])) p++;
    if (p < participants.length) { map[label] = participants[p]; assigned.add(participants[p]); p++; }
  }

  // מי שנותר — נשמור תווית
  for (const label of labelsOrder) if (!map[label]) map[label] = label;
  return map;
}

function applySpeakerMap(segments, speakerMap) {
  return (segments || []).map(s => ({ ...s, speaker: speakerMap[s.speaker] || s.speaker }));
}

function buildStructuredTranscript(segments) {
  const toTime = s => {
    const m = Math.floor(s/60), sec = Math.round(s%60).toString().padStart(2,'0');
    return `${m}:${sec}`;
  };
  return (segments || []).map(s => `[${toTime(s.start)}] ${s.speaker}: ${s.text}`).join('\n');
}

// ============================= דו״ח חכם (OpenAI) =============================
async function generateReportItemsLLM({ transcriptText, meetingTitle, meetingDate }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('Missing OPENAI_API_KEY');

  const MAX_CHARS = 9000;
  const text = String(transcriptText || '').slice(0, MAX_CHARS);

  const prompt = `
את/ה עורך/ת דו"חות ישיבות בעברית. קלט: תמלול מפורק לפי דוברים וזמנים.
החזר JSON בלבד עם השדות:
{
  "items": [
    { "topic": string, "decisions": string, "owner": string, "due": string }
  ],
  "summary": string
}

הנחיות:
- הפק 3–6 פריטים תמציתיים.
- "topic": כותרת קצרה וברורה.
- "decisions": מה הוחלט/מה נדרש.
- "owner": אחראי אם הוזכר; אחרת "—".
- "due": תאריך/טווח אם הוזכר; אחרת "—".
- אין טקסט חופשי מעבר ל-JSON.

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
      temperature: 0.4
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

// ============================= בניית דו״ח =============================
function buildReportHtml({ meetingTitle, meetingDate, attendees, remappedSegments, items, summary, demo, llmMode }) {
  const rows = items.map(r => `
      <tr>
        <td>${r.id}</td>
        <td>${escapeHtml(r.topic)}</td>
        <td>${escapeHtml(r.decisions)}</td>
        <td>${escapeHtml(r.owner)}</td>
        <td>${escapeHtml(r.due)}</td>
      </tr>
  `).join('');

  return `
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
    <tbody>${rows}</tbody>
  </table>

  ${summary ? `<h3 style="margin:12px 0 6px;">תקציר מנהלים</h3><p>${escapeHtml(summary)}</p>` : ''}

  <p style="margin-top:10px;">רשם/ת: — | תפוצה: —</p>
  ${demo ? `<p style="font-size:0.9em; color:#666;">(מצב דמו פעיל – ללא עיבוד אמיתי)</p>` : ''}
</section>`.trim();
}

function buildResponsePayload({ meetingTitle, meetingDate, attendees, remappedSegments, items, summary, footer }) {
  return {
    title: `${meetingTitle} – ${meetingDate}`,
    attendees: attendees.map(name => ({ name })),
    items,
    transcript: { speakers: attendees, segments: remappedSegments },
    summary,
    footer
  };
}

// ============================= Handler ראשי =============================
module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET:
  // 1) בלי פרמטרים: בריאות (demo/llm/keys)
  // 2) עם ?id=... : מנסה להביא תוצאה מ-AssemblyAI ולהחזיר דו"ח אם מוכן
  const url = new URL(req.url, 'http://x'); // בסיס פיקטיבי ל-URL
  const id = url.searchParams.get('id');

  if (req.method === 'GET') {
    try {
      const demo = String(process.env.DEMO_MODE || 'true').toLowerCase() === 'true';
      const llmMode = String(process.env.LLM_MODE || 'false').toLowerCase() === 'true';
      const hasTranscribeKey = !!process.env.AIA_TRANSCRIBE_KEY;
      const hasOpenAI = !!process.env.OPENAI_API_KEY;

      if (id && hasTranscribeKey) {
        const json = await fetchTranscriptResult(id);
        if (json.status !== 'completed') {
          return res.status(202).json({ status: json.status, id });
        }
        // מוכן — נבנה דו"ח מלא מינימלי (ללא פרטים מהלקוח, כי GET לא מכיל אותם)
        const transcript = normalizeTranscript(json);
        const participantsList = []; // אין לנו כאן את רשימת המשתתפים – זה Polling בסיסי
        const speakerMap = buildSpeakerMap(transcript.segments || [], participantsList);
        const remappedSegments = applySpeakerMap(transcript.segments || [], speakerMap);
        const attendees = Array.from(new Set([...participantsList, ...Object.values(speakerMap)]));

        // פריטים אוטומטיים (אם LLM_MODE פעיל)
        let items = [
          { id: 1, topic: 'פתיחה', decisions: '—', owner: '—', due: '—' }
        ];
        let summary = '';
        if (llmMode && !demo && hasOpenAI) {
          const structured = buildStructuredTranscript(remappedSegments);
          const llm = await generateReportItemsLLM({ transcriptText: structured, meetingTitle: '', meetingDate: '' });
          items = (llm.items || []).slice(0, 8).map((it, i) => ({
            id: i + 1,
            topic: String(it.topic || '').trim() || '—',
            decisions: String(it.decisions || '').trim() || '—',
            owner: String(it.owner || '').trim() || '—',
            due: String(it.due || '').trim() || '—'
          }));
          summary = String(llm.summary || '').trim();
          if (items.length === 0) items = [{ id: 1, topic: 'פתיחה', decisions: '—', owner: '—', due: '—' }];
        }

        const html = buildReportHtml({
          meetingTitle: 'דו״ח ממוזג',
          meetingDate: '',
          attendees,
          remappedSegments,
          items,
          summary,
          demo,
          llmMode
        });

        const data = buildResponsePayload({
          meetingTitle: 'דו״ח ממוזג',
          meetingDate: '',
          attendees,
          remappedSegments,
          items,
          summary,
          footer: { scribeName: '', distribution: '' }
        });

        return res.status(200).json({ html, data });
      }

      // בריאות
      return res.status(200).json({ ok: true, demo, llmMode, hasTranscribeKey, hasOpenAI });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // POST — עם נתוני הפגישה
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
    const pollMs = Math.max(5000, parseInt(String(process.env.POLL_MS || '25000'), 10) || 25000);

    // --- תמלול ---
    let transcript, transcriptId;

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
      const resT = await transcribeWithSpeakersInline({ audioUrl, language: 'he', pollMs });
      transcriptId = resT.id;
      if (resT.status === 'processing') {
        // לא הושלם בזמן — נחזיר 202 למנגנון פולינג בצד לקוח
        return res.status(202).json({
          status: 'processing',
          transcriptId,
          next: `GET ${req.url.split('?')[0]}?id=${encodeURIComponent(transcriptId)}`
        });
      }
      transcript = resT.transcript;
    }

    // --- מיפוי דוברים ---
    const participantsList = parseParticipantsList(participants);
    const speakerMap = buildSpeakerMap(transcript.segments || [], participantsList);
    const remappedSegments = applySpeakerMap(transcript.segments || [], speakerMap);
    const attendees = Array.from(new Set([...participantsList, ...Object.values(speakerMap)]));

    // --- פריטי דו"ח (LLM או סקיצה) ---
    let items = [
      { id: 1, topic: 'פתיחה', decisions: 'הצגת מטרות', owner: '—', due: '—' },
      { id: 2, topic: 'סטטוס', decisions: 'עדכון התקדמות', owner: '—', due: '—' }
    ];
    let summary = '';

    if (llmMode && !demo) {
      const structured = buildStructuredTranscript(remappedSegments);
      const { items: aiItems = [], summary: aiSummary = '' } =
        await generateReportItemsLLM({ transcriptText: structured, meetingTitle, meetingDate });

      items = (aiItems || []).slice(0, 8).map((it, idx) => ({
        id: idx + 1,
        topic: String(it.topic || '').trim() || '—',
        decisions: String(it.decisions || '').trim() || '—',
        owner: String(it.owner || '').trim() || '—',
        due: String(it.due || '').trim() || '—'
      }));
      if (items.length === 0) {
        items = [{ id: 1, topic: 'פתיחה', decisions: '—', owner: '—', due: '—' }];
      }
      summary = String(aiSummary || '').trim();
    }

    // --- HTML + JSON ---
    const html = buildReportHtml({
      meetingTitle, meetingDate,
      attendees, remappedSegments, items, summary,
      demo, llmMode
    });

    const data = buildResponsePayload({
      meetingTitle, meetingDate,
      attendees, remappedSegments, items, summary,
      footer: { scribeName, distribution }
    });

    return res.status(200).json({ html, data, ...(transcriptId ? { transcriptId } : {}) });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'internal_error', details: String(e?.message || e) });
  }
};
