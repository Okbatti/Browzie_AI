// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.warn('Warning: GEMINI_API_KEY is not set. Requests to Gemini will fail until you set GEMINI_API_KEY in .env.');
}

// Controls how much page text is forwarded in the context (tune for cost)
const MAX_SNIPPET_CHARS = 25000; // allow large page captures
const MAX_PROMPT_CHARS = 40000; // safety cap for the final prompt sent to Gemini

// Helper: safely build a small context block from pageContext
function buildContextBlock(pageContext) {
  if (!pageContext) return '';

  const parts = [];
  if (pageContext.title) parts.push(`Page title: ${pageContext.title}`);
  if (pageContext.url) parts.push(`URL: ${pageContext.url}`);
  if (pageContext.metaDescription) parts.push(`Description: ${pageContext.metaDescription}`);
  if (pageContext.publishedDate) parts.push(`Published: ${pageContext.publishedDate}`);
  if (pageContext.headings && pageContext.headings.length) parts.push(`Headings: ${pageContext.headings.slice(0,6).join(' | ')}`);
  if (pageContext.topLinks && pageContext.topLinks.length) {
    const links = pageContext.topLinks.slice(0,4).map(l => `${(l.text || '').slice(0,30)} -> ${l.href}`).join(' ; ');
    parts.push(`Top links: ${links}`);
  }
  if (typeof pageContext.wordCount === 'number') parts.push(`Approx. word count: ${pageContext.wordCount}`);

  let block = parts.join('\n') + (parts.length ? '\n\n' : '');

  // include a truncated snippet if present
  if (pageContext.mainTextSnippet) {
    let snippet = ('' + pageContext.mainTextSnippet);
    if (snippet.length > MAX_SNIPPET_CHARS) snippet = snippet.slice(0, MAX_SNIPPET_CHARS) + '\n\n...[truncated]';
    block += `Page snippet:\n${snippet}\n\n`;
  }

  // selected text
  if (pageContext.selectedText) {
    const sel = ('' + pageContext.selectedText).slice(0, 1000);
    block += `Selected text:\n${sel}\n\n`;
  }

  return block;
}

// POST /api/generate
// body: { prompt, selectedText, mode, task, targetLanguage, pageContext }
app.post('/api/generate', async (req, res) => {
  try {
    const { prompt, selectedText, mode, task, targetLanguage, pageContext } = req.body;

    // Debug: log incoming pageContext summary (server console)
    if (pageContext) {
      console.log('[server] incoming pageContext ->', {
        url: pageContext.url,
        title: pageContext.title,
        wordCount: pageContext.wordCount,
        selectedTextSnippet: pageContext.selectedText ? (pageContext.selectedText.slice(0, 80) + (pageContext.selectedText.length > 80 ? '...' : '')) : undefined
      });
    } else {
      console.log('[server] incoming request without pageContext');
    }

    const contextBlock = buildContextBlock(pageContext);

    // Build the user request
    const userRequest = (prompt && String(prompt).trim()) || (selectedText ? `Explain: "${selectedText}"` : 'Please help with the page content.');

    // Compose final prompt and enforce a maximum length
    let finalPrompt = `You are a helpful assistant. Use the page context below to answer the user's request. Prefer information present in the context and avoid inventing facts beyond it unless the user asks you to infer.\n\n${contextBlock}\nUser request: ${userRequest}`;

    if (finalPrompt.length > MAX_PROMPT_CHARS) {
      finalPrompt = finalPrompt.slice(0, MAX_PROMPT_CHARS) + '\n\n...[final prompt truncated due to size]';
    }

    // Build the Gemini REST request payload
    const payload = {
      contents: [
        {
          parts: [
            { text: finalPrompt }
          ]
        }
      ]
    };

    // Ensure API key present
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ ok: false, error: 'GEMINI_API_KEY not configured on server.' });
    }

    // Call Gemini REST API
    const r = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': GEMINI_API_KEY
        },
        body: JSON.stringify(payload)
      }
    );

    if (!r.ok) {
      const bodyText = await r.text().catch(() => '<unable to read body>');
      console.error(`[server] Gemini API error ${r.status}:`, bodyText);
      return res.status(502).json({ ok: false, error: `Upstream Gemini API error ${r.status}`, details: bodyText });
    }

    const data = await r.json().catch(err => {
      console.error('[server] failed to parse Gemini response as JSON', err);
      return null;
    });

    const text =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      data?.output?.[0]?.content?.parts?.[0]?.text ||
      data?.text ||
      (data ? JSON.stringify(data) : '');

    // Return a consistent shape
    res.json({ ok: true, text, raw: data });
  } catch (err) {
    console.error('[server] unexpected error in /api/generate', err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// POST /api/summarize
// body: { pageContext: {...}, length: 'short'|'medium'|'long' }
app.post('/api/summarize', async (req, res) => {
  try {
    const { pageContext, length = 'medium' } = req.body;

    // Debug: log incoming pageContext summary
    if (pageContext) {
      console.log('[server] summarize request for', pageContext.url || pageContext.title || '(no-url)');
    } else {
      console.log('[server] summarize request with no pageContext');
    }

    const lengthMap = {
      short: 'about 50-80 words',
      medium: 'about 120-180 words',
      long: 'about 300-500 words'
    };
    const target = lengthMap[length] || lengthMap['medium'];

    const contextBlock = buildContextBlock(pageContext);

    const finalPrompt = `You are a helpful assistant. Produce a clear human-readable summary of the webpage described below. Keep the summary to ${target}. Focus on key points, exact product names, prices, and any numerical details found on the page. Format the summary in plain text (no HTML). If the page contains multiple sections, include short bullet points for each major section.\n\n${contextBlock}\nSummary:`;

    let promptToSend = finalPrompt;
    if (promptToSend.length > MAX_PROMPT_CHARS) {
      promptToSend = promptToSend.slice(0, MAX_PROMPT_CHARS) + '\n\n...[truncated]';
    }

    const payload = {
      contents: [
        {
          parts: [
            { text: promptToSend }
          ]
        }
      ]
    };

    if (!GEMINI_API_KEY) {
      return res.status(500).json({ ok: false, error: 'GEMINI_API_KEY not configured' });
    }

    const r = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': GEMINI_API_KEY
        },
        body: JSON.stringify(payload)
      }
    );

    if (!r.ok) {
      const bodyText = await r.text().catch(() => '<unable to read>');
      console.error('[server] Gemini summarize error', r.status, bodyText);
      return res.status(502).json({ ok: false, error: 'Upstream Gemini error', details: bodyText });
    }

    const data = await r.json();
    const text =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      data?.output?.[0]?.content?.parts?.[0]?.text ||
      data?.text ||
      JSON.stringify(data);

    return res.json({ ok: true, text, raw: data });
  } catch (err) {
    console.error('Error in /api/summarize', err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

app.listen(PORT, () => console.log(`Proxy running on http://localhost:${PORT}`));
