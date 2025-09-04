// api/_transcribe.js  (CommonJS)

async function transcribeWithSpeakers({ audioUrl, language = 'he' }) {
  const API_KEY = process.env.AIA_TRANSCRIBE_KEY;
  if (!API_KEY) throw new Error('Missing AIA_TRANSCRIBE_KEY');

  // 1) יצירת משימת תמלול עם דיאריזציה
  const createRes = await fetch('https://api.assemblyai.com/v2/transcript', {
    method: 'POST',
    headers: {
      authorization: API_KEY,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      audio_url: audioUrl,
      speaker_labels: true,
      language_code: language,
      punctuate: true,
      format_text: true
    })
  });
  if (!createRes.ok) {
    const t = await createRes.text();
    throw new Error('AIA create failed: ' + t);
  }
  const { id } = await createRes.json();

  // 2) Polling קצר (מתאים לקבצים קצרים)
  let status = 'processing';
  let result = null;
  const started = Date.now();
  while (Date.now() - started < 25000) { // עד ~25 שניות
    await new Promise(r => setTimeout(r, 2500));
    const getRes = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, {
      headers: { authorization: API_KEY }
    });
    result = await getRes.json();
    status = result.status;
    if (status === 'completed' || status === 'error') break;
  }
  if (status !== 'completed') {
    throw new Error('Transcription not completed in time (try shorter audio)');
  }

  // 3) החזרת מבנה אחיד
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

module.exports = { transcribeWithSpeakers };
