// פונקציית תמלול אמיתית מול AssemblyAI, עם דוברים
// התוצאה מוחזרת במבנה אחיד: { text, segments: [{start, end, speaker, text}], speakers: [...] }

export async function transcribeWithSpeakers({ audioUrl, language = 'he' }) {
  const API_KEY = process.env.AIA_TRANSCRIBE_KEY;
  if (!API_KEY) throw new Error('Missing AIA_TRANSCRIBE_KEY');

  // 1) שולחים בקשה להתחיל תמלול (async) עם דוברים
  const createRes = await fetch('https://api.assemblyai.com/v2/transcript', {
    method: 'POST',
    headers: {
      'authorization': API_KEY,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      audio_url: audioUrl,          // ישירות מה-Lovable
      speaker_labels: true,         // זיהוי דוברים
      language_code: 'he',          // עברית – חוסך זיהוי שפה
      punctuate: true,              // פיסוק
      format_text: true             // טקסט נוח לקריאה
      // אפשרויות חסכון: dual_channel במידת הצורך, או boosting אם ידועים שמות וכו'
    })
  });
  if (!createRes.ok) {
    const t = await createRes.text();
    throw new Error('AIA create failed: ' + t);
  }
  const { id } = await createRes.json();

  // 2) ממתינים לסיום (polling קצר לקבצים קצרים)
  // הערה: פונקציה רצה על Vercel, אז נשמור על המתנה קצרה. בדמו – קבצים עד ~90 שניות.
  let status = 'processing';
  let result = null;
  const started = Date.now();
  while (Date.now() - started < 25000) { // עד ~25 שניות
    await new Promise(r => setTimeout(r, 2500));
    const getRes = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, {
      headers: { 'authorization': API_KEY }
    });
    result = await getRes.json();
    status = result.status;
    if (status === 'completed' || status === 'error') break;
  }
  if (status !== 'completed') {
    throw new Error('Transcription not completed in time (try shorter audio)');
  }

  // 3) בניית מבנה אחיד (segments עם דוברים)
  // AssemblyAI מחזיר "utterances" כשמבקשים speaker_labels
  const segments = (result.utterances || []).map(u => ({
    start: u.start / 1000, // אלפיות → שניות
    end:   u.end   / 1000,
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
