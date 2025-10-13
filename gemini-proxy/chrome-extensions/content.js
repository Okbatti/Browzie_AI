// === content.js (UI-improved + suggestions for selected words; click-to-send enabled) ===
// Kept existing functionality, added nicer animations, overlay/backdrop, keyboard shortcuts (Esc), smoother icon drop,
// improved responsive placement for left icon stack, prompt box open/close animation, small accessibility tweaks,
// AND: added "Suggested questions" based on the highlighted/selected word.
// CHANGE: clicking a suggested question now triggers an immediate request (single-click sends).

function getMetaContent(name) {
  const el = document.querySelector(`meta[name="${name}"]`) || document.querySelector(`meta[property="${name}"]`);
  return el ? (el.content || el.getAttribute('content') || '') : '';
}

function getHeadings(limit = 10) {
  const heads = [];
  document.querySelectorAll('h1,h2,h3').forEach(h => {
    if (heads.length < limit) {
      const t = (h.innerText || '').trim();
      if (t) heads.push(t);
    }
  });
  return heads;
}

function extractMainText(maxChars = 60000) {
  function isVisible(el) {
    if (!el) return false;
    try {
      const style = window.getComputedStyle(el);
      return style && style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
    } catch {
      return false;
    }
  }

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: node => {
      const text = (node.nodeValue || '').trim();
      if (text.length < 30) return NodeFilter.FILTER_SKIP;
      if (!isVisible(node.parentElement)) return NodeFilter.FILTER_SKIP;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  let buffer = '';
  while (walker.nextNode()) {
    buffer += walker.currentNode.nodeValue.trim() + '\n';
    if (buffer.length > maxChars) {
      buffer += '\n...[truncated]';
      break;
    }
  }

  if (!buffer || buffer.trim().length < 300) {
    const bodyText = (document.body.innerText || '').replace(/\s{2,}/g, ' ').trim();
    buffer = bodyText.slice(0, maxChars);
  }

  return buffer;
}

function getTopLinks(limit = 8) {
  const links = [];
  const seen = new Set();
  Array.from(document.querySelectorAll('a[href]')).some(a => {
    const href = a.href;
    if (!href || seen.has(href)) return false;
    seen.add(href);
    links.push({ text: (a.innerText || '').trim().slice(0, 60), href });
    return links.length >= limit;
  });
  return links;
}

function getPageContext() {
  const selectedText = (window.getSelection && window.getSelection().toString()) || '';
  const title = (document.title || '').trim();
  const url = location.href;
  const metaDescription = getMetaContent('description') || getMetaContent('og:description') || '';
  const publishedDate = getMetaContent('article:published_time') || getMetaContent('og:updated_time') || '';
  const headings = getHeadings(8);
  const mainTextSnippet = extractMainText(25000);
  const topLinks = getTopLinks(6);
  const words = mainTextSnippet ? mainTextSnippet.split(/\s+/).length : 0;

  return {
    title, url, metaDescription, publishedDate,
    headings, topLinks, wordCount: words,
    mainTextSnippet, selectedText
  };
}

// ---------- Utility: produce suggestions for a selected word ----------
function extractQuestionsFromPageForWord(word, pageText) {
  // Return an array of question strings (already trimmed) that mention the word.
  if (!word || !pageText) return [];

  const w = word.trim().toLowerCase();
  // match segments that end with a '?' (capture the whole sentence up to '?')
  const questionRegex = /[^?!.]*\?+/g;
  const matches = pageText.match(questionRegex) || [];
  const filtered = matches
    .map(s => s.trim())
    .filter(s => s.length > 3 && s.toLowerCase().includes(w));

  // Normalize whitespace and dedupe with counts
  const counts = new Map();
  for (let q of filtered) {
    const normalized = q.replace(/\s+/g, ' ').trim();
    counts.set(normalized, (counts.get(normalized) || 0) + 1);
  }

  // Sort by frequency and length (pref shorter clearer questions)
  return Array.from(counts.entries())
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].length - b[0].length;
    })
    .map(e => e[0]);
}

function makeDefaultTemplatesForWord(word) {
  const safe = (word || '').trim();
  if (!safe) return [];
  return [
    `What is ${safe}?`,
    `How does ${safe} work?`,
    `Why is ${safe} important?`
  ];
}

// Renders suggestion chips/buttons inside a container element.
// CLICK behavior updated: single click now immediately sends the suggestion (via sendCallback).
function renderSuggestions(container, suggestions, inputElement, sendCallback) {
  // clear existing suggestions area
  container.innerHTML = '';
  if (!suggestions || suggestions.length === 0) return;

  const label = document.createElement('div');
  label.style.fontSize = '12px';
  label.style.color = '#9ee6cf';
  label.style.marginBottom = '6px';
  label.textContent = 'Suggested questions';
  container.appendChild(label);

  const wrap = document.createElement('div');
  wrap.style.display = 'flex';
  wrap.style.flexWrap = 'wrap';
  wrap.style.gap = '8px';

  suggestions.slice(0, 3).forEach(s => {
    const btn = document.createElement('button');
    btn.className = 'gai-suggestion-btn';
    btn.textContent = s;
    Object.assign(btn.style, {
      padding: '6px 10px',
      borderRadius: '999px',
      background: '#06191a',
      color: '#dffbf6',
      border: '1px solid rgba(255,255,255,0.04)',
      cursor: 'pointer',
      fontSize: '13px',
      maxWidth: '100%',
      whiteSpace: 'normal',
      textAlign: 'left'
    });

    // NEW: single click now fills input AND sends immediately
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (inputElement) {
        inputElement.value = s;
        inputElement.focus();
      }
      // call the provided sendCallback (if available) so the message is sent immediately
      if (typeof sendCallback === 'function') {
        try { sendCallback(); } catch (err) { console.warn('sendCallback error', err); }
      }
    });

    // keep dblclick for fallback (also sends)
    btn.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (inputElement) {
        inputElement.value = s;
        inputElement.focus();
      }
      if (typeof sendCallback === 'function') {
        try { sendCallback(); } catch (err) { console.warn('sendCallback error', err); }
      }
    });

    wrap.appendChild(btn);
  });

  container.appendChild(wrap);
}

// ---------- Prompt box (draggable + responsive + animated) ----------
function removeExistingBox() {
  const ex = document.getElementById('gai-ai-prompt-box');
  if (ex) ex.remove();
  removeOverlay('gai-prompt-overlay');
}

function createPromptBoxFromSelectionRect(selRect, selectedText) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const showAbove = (selRect && (selRect.bottom > (vh * 0.66)));
  const alignLeft = (selRect && (selRect.left > vw * 0.5));

  let left = selRect ? (alignLeft ? Math.max(8, selRect.left - 480 - 16) : Math.min(vw - 488, selRect.right + 10)) : 100;
  let top = selRect ? (showAbove ? Math.max(8, selRect.top - 8 - 220) : Math.min(vh - 240, selRect.bottom + 8)) : 100;

  left = Math.max(8, Math.min(left, vw - 488));
  top = Math.max(8, Math.min(top, vh - 120));

  createPromptBox(left, top, selectedText);
}

function createPromptBox(x, y, selectedText) {
  removeExistingBox();
  createOverlay('gai-prompt-overlay');

  const box = document.createElement('div');
  box.id = 'gai-ai-prompt-box';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'AI prompt box');
  box.style.left = `${Math.max(8, x)}px`;
  box.style.top = `${Math.max(8, y)}px`;

  // animated entrance
  box.classList.add('gai-animate-in');

  const safeSelected = escapeHtml(selectedText || '');

  const header = document.createElement('div');
  header.id = 'gai-prompt-header';
  header.className = 'gai-header';
  header.style.cursor = 'grab';
  header.style.padding = '10px 12px';
  header.style.display = 'flex';
  header.style.justifyContent = 'space-between';
  header.style.alignItems = 'center';
  header.style.gap = '8px';
  header.style.background = 'linear-gradient(90deg, rgba(255,255,255,0.02), transparent)';
  header.style.borderBottom = '1px solid rgba(255,255,255,0.03)';

  const title = document.createElement('div');
  title.textContent = 'Browzie Assistant';
  title.style.fontWeight = '700';
  title.style.color = '#2dd4bf';
  title.style.fontSize = '13px';
  title.className = 'gai-title';

  const headerButtons = document.createElement('div');
  headerButtons.style.display = 'flex';
  headerButtons.style.gap = '8px';
  headerButtons.style.alignItems = 'center';

  const closeBtn = document.createElement('button');
  closeBtn.id = 'gai-close';
  closeBtn.innerText = '✕';
  closeBtn.title = 'Close';
  Object.assign(closeBtn.style, {
    padding: '6px 8px', borderRadius: '8px', border: 'none', background: 'transparent',
    color: '#e6eef2', cursor: 'pointer', fontSize: '13px'
  });

  headerButtons.appendChild(closeBtn);
  header.appendChild(title);
  header.appendChild(headerButtons);
  box.appendChild(header);

  // body
  const body = document.createElement('div');
  body.className = 'gai-body';
  body.style.padding = '12px';
  body.style.display = 'flex';
  body.style.flexDirection = 'column';
  body.style.gap = '10px';
  body.style.background = '#071015';

  const selWrap = document.createElement('div');
  selWrap.className = 'gai-selected';
  selWrap.style.padding = '8px';
  selWrap.style.background = '#07171a';
  selWrap.style.borderRadius = '8px';
  selWrap.style.border = '1px solid rgba(255,255,255,0.03)';
  selWrap.style.maxHeight = '120px';
  selWrap.style.overflow = 'auto';
  selWrap.style.whiteSpace = 'pre-wrap';
  selWrap.id = 'gai-selected';
  selWrap.innerText = safeSelected || '(no selection)';

  // suggestions container (new)
  const suggestionsContainer = document.createElement('div');
  suggestionsContainer.id = 'gai-suggestions';
  suggestionsContainer.style.marginTop = '6px';

  const inputRow = document.createElement('div');
  inputRow.className = 'gai-input-row';
  inputRow.style.display = 'flex';
  inputRow.style.gap = '8px';
  inputRow.style.alignItems = 'center';

  const input = document.createElement('input');
  input.id = 'gai-input';
  input.type = 'text';
  input.placeholder = "Optional instruction or 'Translate to Spanish'";
  input.className = 'gai-input';
  Object.assign(input.style, {
    flex: '1',
    padding: '10px',
    borderRadius: '8px',
    border: '1px solid rgba(255,255,255,0.04)',
    background: '#0b0d0f',
    color: '#e6eef2',
    fontSize: '13px',
    boxSizing: 'border-box'
  });

  const sendBtn = document.createElement('button');
  sendBtn.id = 'gai-send';
  sendBtn.textContent = 'Send';
  sendBtn.className = 'gai-send-btn';
  Object.assign(sendBtn.style, {
    padding: '9px 14px', borderRadius: '8px', border: '0',
    background: 'linear-gradient(90deg,#2dd4bf,#22c1c3)', color: '#041014',
    fontWeight: '600', cursor: 'pointer'
  });

  inputRow.appendChild(input);
  inputRow.appendChild(sendBtn);

  const result = document.createElement('div');
  result.id = 'gai-result';
  result.style.display = 'none';
  Object.assign(result.style, {
    background: '#f6f7f9', color: '#0b0d0f', padding: '10px', borderRadius: '8px',
    border: '1px solid #e1e4e8', maxHeight: '240px', overflow: 'auto', whiteSpace: 'pre-wrap'
  });

  body.appendChild(selWrap);
  body.appendChild(suggestionsContainer); // add suggestions under selection
  body.appendChild(inputRow);
  body.appendChild(result);
  box.appendChild(body);
  document.body.appendChild(box);

  // Populate suggestions based on selectedText
  try {
    const pageContext = getPageContext();
    const pageText = pageContext.mainTextSnippet || document.body.innerText || '';
    let suggestions = [];
    if (selectedText && selectedText.trim().length > 0) {
      // if selection is multiple words, prioritize the single highlighted word if user selected one word
      const selWord = selectedText.trim().split(/\s+/)[0];
      suggestions = extractQuestionsFromPageForWord(selWord, pageText);
      if (!suggestions || suggestions.length === 0) {
        suggestions = makeDefaultTemplatesForWord(selWord);
      }
    } else {
      // no selection -> show top generic templates from page title / headings
      const title = pageContext.title || '';
      const titleWord = (title.split(/\s+/)[0] || '').replace(/[^\w\-]/g, '');
      if (titleWord) suggestions = makeDefaultTemplatesForWord(titleWord);
    }
    // pass a sendCallback which triggers the sendBtn click (so renderSuggestions can call it)
    renderSuggestions(suggestionsContainer, suggestions.slice(0,3), input, () => sendBtn.click());
  } catch (e) {
    // ignore suggestion generation errors
    console.warn('Suggestion generation error', e);
  }

  makeElementDraggable(box, header);

  // Keyboard: Enter to send
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendBtn.click();
    }
  });

  // Esc to close
  const escHandler = (e) => {
    if (e.key === 'Escape') removeExistingBox();
  };
  window.addEventListener('keydown', escHandler, { once: false });

  closeBtn.addEventListener('click', () => {
    window.removeEventListener('keydown', escHandler);
    removeExistingBox();
  });

  // send
  sendBtn.addEventListener('click', () => {
    const txt = input.value.trim();
    let prompt;
    const selected = (window.getSelection && window.getSelection().toString()) || '';

    const tl = parseTargetLanguage(txt);
    if (!txt) {
      prompt = selected ? `Explain this text:\n\n"${selected}"` : 'Provide a short summary of the selection or page.';
    } else if (tl && selected) {
      prompt = `Translate the following text to ${tl}:\n\n"${selected}"`;
    } else if (tl && !selected) {
      prompt = `Translate to ${tl}:`;
    } else {
      prompt = selected ? `${txt}\n\n"${selected}"` : txt;
    }

    const pageContext = getPageContext();
    result.style.display = 'block';
    result.innerText = 'Sending…';

    chrome.runtime.sendMessage({ action: 'query_gemini', prompt, selectedText: selected, pageContext }, (resp) => {
      if (!resp) {
        result.innerText = 'No response (messaging error)';
        return;
      }
      if (!resp.ok) {
        result.innerText = 'Error: ' + (resp.error || 'unknown error');
        return;
      }
      const text = resp.data?.data?.text || resp.data?.text || (typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data));
      result.innerText = text;
    });
  });
}

// draggable utility
function makeElementDraggable(el, handle) {
  let isDragging = false;
  let startX = 0, startY = 0, origLeft = 0, origTop = 0;
  handle.style.cursor = 'grab';

  handle.addEventListener('mousedown', (e) => {
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = el.getBoundingClientRect();
    origLeft = rect.left;
    origTop = rect.top;
    handle.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let newLeft = Math.max(8, Math.min(origLeft + dx, vw - el.offsetWidth - 8));
    let newTop = Math.max(8, Math.min(origTop + dy, vh - el.offsetHeight - 8));
    el.style.left = `${newLeft}px`;
    el.style.top = `${newTop}px`;
  });

  window.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    handle.style.cursor = 'grab';
    document.body.style.userSelect = '';
  });

  // touch support
  handle.addEventListener('touchstart', (e) => {
    isDragging = true;
    const t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;
    const rect = el.getBoundingClientRect();
    origLeft = rect.left;
    origTop = rect.top;
    document.body.style.userSelect = 'none';
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (!isDragging) return;
    const t = e.touches[0];
    const dx = t.clientX - startX;
    const dy = t.touches[0].clientY - startY;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let newLeft = Math.max(8, Math.min(origLeft + dx, vw - el.offsetWidth - 8));
    let newTop = Math.max(8, Math.min(origTop + dy, vh - el.offsetHeight - 8));
    el.style.left = `${newLeft}px`;
    el.style.top = `${newTop}px`;
  }, { passive: true });

  window.addEventListener('touchend', () => {
    if (!isDragging) return;
    isDragging = false;
    document.body.style.userSelect = '';
  });
}

// ---------- Floating widget + improved inner icons (left of main) ----------
const DEFAULT_THEME = '#2dd4bf';

function ensureFloatingWidget() {
  if (document.getElementById('gai-floating-widget')) return;

  const mainBtn = document.createElement('div');
  mainBtn.id = 'gai-floating-widget';
  mainBtn.setAttribute('role', 'button');
  mainBtn.setAttribute('aria-label', 'Open Gemini menu');
  Object.assign(mainBtn.style, {
    position: 'fixed',
    right: '12px',
    top: '50%',
    transform: 'translateY(-50%)',
    width: '56px',
    height: '56px',
    cursor: 'pointer',
    zIndex: 2147483646,
    borderRadius: '12px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
    background: DEFAULT_THEME
  });
  mainBtn.title = 'Open menu';

  mainBtn.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 3C7.03 3 3 6.69 3 11c0 2.66 1.45 5.03 3.78 6.44L6 21l3.04-.63C10.07 20.5 11 20.62 12 20.62c4.97 0 9-3.69 9-8.62S16.97 3 12 3z" fill="white"/>
  </svg>`;

  const leftIcons = document.createElement('div');
  leftIcons.id = 'gai-floating-left-icons';
  Object.assign(leftIcons.style, {
    position: 'fixed',
    right: '80px',
    top: '50%',
    transform: 'translateY(-50%)',
    zIndex: 2147483646,
    display: 'none',
    flexDirection: 'column',
    gap: '12px',
    alignItems: 'center',
    pointerEvents: 'auto'
  });

  function makeIcon({ id, titleText, bg, svgInner, onClick }) {
    const wrap = document.createElement('div');
    wrap.className = 'gai-icon-wrap';
    wrap.style.pointerEvents = 'auto';

    const btn = document.createElement('button');
    btn.id = id;
    btn.className = 'gai-icon-btn';
    btn.title = titleText;
    btn.setAttribute('aria-label', titleText);
    Object.assign(btn.style, {
      background: bg
    });
    btn.innerHTML = svgInner;

    const label = document.createElement('div');
    label.className = 'gai-icon-label';
    label.textContent = titleText;

    btn.addEventListener('mouseenter', () => {
      btn.style.transform = 'translateX(-6px)';
      btn.style.boxShadow = '0 18px 40px rgba(0,0,0,0.5)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.transform = 'translateX(0)';
      btn.style.boxShadow = '0 10px 30px rgba(0,0,0,0.35)';
    });

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (onClick) onClick(e);
    });

    wrap.appendChild(btn);
    wrap.appendChild(label);
    return wrap;
  }

  const chatIcon = makeIcon({
    id: 'gai-icon-chat',
    titleText: 'Chatbot',
    bg: 'linear-gradient(180deg,#05382f,#083f30)',
    svgInner: `<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 4h16v10H9l-5 5V4z" fill="#a6fff0"/>
    </svg>`,
    onClick: () => { toggleRightChatBox(); hideLeftIcons(); }
  });

  const summaryIcon = makeIcon({
    id: 'gai-icon-summary',
    titleText: 'Summarizer',
    bg: 'linear-gradient(180deg,#05223a,#073046)',
    svgInner: `<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 6h16M4 11h12M4 16h16" stroke="#a6fff0" stroke-width="1.6" stroke-linecap="round"/>
    </svg>`,
    onClick: () => { toggleSummaryPanel(); hideLeftIcons(); }
  });

  leftIcons.appendChild(chatIcon);
  leftIcons.appendChild(summaryIcon);

  document.body.appendChild(leftIcons);
  document.body.appendChild(mainBtn);

  // overlay for left icons for nicer UX & to catch outside clicks
  function showLeftIcons() {
    const li = document.getElementById('gai-floating-left-icons');
    if (!li) return;
    createOverlay('gai-lefticons-overlay', () => { hideLeftIcons(); });
    li.style.display = 'flex';
    li.classList.remove('gai-lefticons-hide');
    li.classList.add('gai-lefticons-show');
  }
  function hideLeftIcons() {
    const li = document.getElementById('gai-floating-left-icons');
    if (!li) return;
    li.classList.remove('gai-lefticons-show');
    li.classList.add('gai-lefticons-hide');
    // allow animation to finish then hide
    setTimeout(() => { li.style.display = 'none'; }, 220);
    removeOverlay('gai-lefticons-overlay');
  }

  mainBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const shown = leftIcons.style.display === 'flex';
    if (shown) hideLeftIcons();
    else showLeftIcons();
  });

  // close on global click or Esc
  document.addEventListener('click', (ev) => {
    const target = ev.target;
    if (!target) return;
    if (target === mainBtn || mainBtn.contains(target) || leftIcons.contains(target)) return;
    hideLeftIcons();
  });

  // close on Esc
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideLeftIcons();
  });
}

// ---------- Chat & Summary UI (unchanged behavior, nicer design touches) ----------
function toggleRightChatBox() {
  const existing = document.getElementById('gai-right-chat');
  if (existing) {
    existing.remove();
    return;
  }
  openRightChatBox();
}

function openRightChatBox() {
  const prev = document.getElementById('gai-right-chat');
  if (prev) prev.remove();

  const cont = document.createElement('div');
  cont.id = 'gai-right-chat';
  cont.setAttribute('role', 'region');
  cont.setAttribute('aria-label', 'Gemini chat');
  Object.assign(cont.style, {
    position: 'fixed',
    right: '12px',
    top: '50%',
    transform: 'translateY(-50%)',
    zIndex: 2147483647,
    width: '380px',
    maxHeight: '640px',
    borderRadius: '12px',
    boxShadow: '0 16px 50px rgba(0,0,0,0.48)',
    background: '#0f1113',
    color: '#e6eef2',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    fontFamily: 'Inter, Arial, sans-serif',
    fontSize: '13px'
  });

  const header = document.createElement('div');
  Object.assign(header.style, {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '12px', background: 'linear-gradient(90deg, rgba(255,255,255,0.02), transparent)',
    borderBottom: '1px solid rgba(255,255,255,0.02)'
  });
  const title = document.createElement('div');
  title.textContent = 'Browzie Chat';
  title.style.fontWeight = '700';
  title.style.color = '#a6fff0';
  title.style.fontSize = '14px';
  const closeBtn = document.createElement('button');
  closeBtn.innerText = '✕';
  Object.assign(closeBtn.style, { background: 'transparent', border: 'none', color: '#e6eef2', cursor: 'pointer' });
  header.appendChild(title);
  header.appendChild(closeBtn);
  cont.appendChild(header);

  const chatArea = document.createElement('div');
  chatArea.id = 'gai-right-chat-area';
  Object.assign(chatArea.style, {
    flex: '1', overflow: 'auto', padding: '12px', background: '#071015', display: 'flex', flexDirection: 'column', gap: '10px'
  });
  cont.appendChild(chatArea);

  // suggestions in chat (if selection exists)
  const selection = (window.getSelection && window.getSelection().toString()) || '';
  const suggestionsPanel = document.createElement('div');
  suggestionsPanel.id = 'gai-chat-suggestions';
  suggestionsPanel.style.padding = '8px 12px 0 12px';
  if (selection && selection.trim().length > 0) {
    const pageContext = getPageContext();
    const pageText = pageContext.mainTextSnippet || document.body.innerText || '';
    const selWord = selection.trim().split(/\s+/)[0];
    const suggs = extractQuestionsFromPageForWord(selWord, pageText);
    const final = (suggs && suggs.length) ? suggs.slice(0,3) : makeDefaultTemplatesForWord(selWord);
    // we'll render after input creation (we need the input element)
    suggestionsPanel.dataset.suggestions = JSON.stringify(final);
  }

  const inputRow = document.createElement('div');
  Object.assign(inputRow.style, { display: 'flex', gap: '8px', padding: '12px', borderTop: '1px solid rgba(255,255,255,0.02)' });

  const input = document.createElement('input');
  input.type = 'text';
  input.id = 'gai-right-input';
  input.placeholder = "Ask or type 'Summarize' or 'Translate to French'...";
  Object.assign(input.style, {
    flex: '1', padding: '10px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.04)',
    background: '#0b0d0f', color: '#e6eef2', fontSize: '13px', boxSizing: 'border-box'
  });

  const sendBtn = document.createElement('button');
  sendBtn.id = 'gai-right-send';
  sendBtn.textContent = 'Send';
  Object.assign(sendBtn.style, {
    padding: '10px 12px', borderRadius: '8px', border: '0', cursor: 'pointer', background: 'linear-gradient(90deg,#2dd4bf,#22c1c3)', color: '#041014', fontWeight: '700'
  });

  inputRow.appendChild(input);
  inputRow.appendChild(sendBtn);
  cont.appendChild(inputRow);

  // If suggestions prepared add them right above inputRow
  if (suggestionsPanel && suggestionsPanel.dataset.suggestions) {
    const parsed = JSON.parse(suggestionsPanel.dataset.suggestions || '[]');
    if (parsed && parsed.length) {
      const container = document.createElement('div');
      container.style.padding = '0 12px 8px 12px';
      // NOTE: renderSuggestions will call sendBtn.click() immediately when a suggestion is clicked
      renderSuggestions(container, parsed, input, () => sendBtn.click());
      cont.insertBefore(container, inputRow);
    }
  }

  closeBtn.addEventListener('click', () => cont.remove());

  sendBtn.addEventListener('click', () => {
    const txt = input.value.trim();
    if (!txt) return;
    appendRightMessage(txt, true);
    input.value = '';
    appendRightMessage('…thinking', false);
    const selected = (window.getSelection && window.getSelection().toString()) || '';
    const pageContext = getPageContext();
    const tl = parseTargetLanguage(txt);
    let prompt = txt;
    if (!txt) prompt = selected ? `Explain: "${selected}"` : 'Explain the highlighted text.';
    else if (tl && selected) prompt = `Translate the following text to ${tl}:\n\n"${selected}"`;
    else if (tl && !selected) prompt = `Translate to ${tl}:`;

    chrome.runtime.sendMessage({ action: 'query_gemini', prompt, selectedText: selected, pageContext }, (resp) => {
      const area = document.getElementById('gai-right-chat-area');
      const children = area ? Array.from(area.children) : [];
      if (children.length) {
        const last = children[children.length - 1];
        if (last && last.dataset && last.dataset.role === 'bot-placeholder') last.remove();
      }
      if (!resp) {
        appendRightMessage('No response (messaging error)', false);
        return;
      }
      if (!resp.ok) {
        appendRightMessage('Error: ' + (resp.error || 'unknown'), false);
        return;
      }
      const text = resp.data?.text || resp.data?.data?.text || JSON.stringify(resp.data);
      appendRightMessage(text, false);
    });
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendBtn.click();
    }
  });

  function appendRightMessage(text, isUser) {
    const area = document.getElementById('gai-right-chat-area');
    if (!area) return;
    const m = document.createElement('div');
    m.className = 'gai-msg ' + (isUser ? 'user' : 'bot');
    m.style.maxWidth = '100%';
    m.style.padding = '8px 10px';
    m.style.borderRadius = '8px';
    m.style.whiteSpace = 'pre-wrap';
    m.style.lineHeight = '1.35';
    if (isUser) {
      m.style.alignSelf = 'flex-end';
    } else {
      if (text === '…thinking') {
        m.dataset.role = 'bot-placeholder';
      }
    }
    m.textContent = text;
    area.appendChild(m);
    area.scrollTop = area.scrollHeight;
  }

  document.body.appendChild(cont);
}

// ---------- Summary panel (behavior preserved; improved styling) ----------
function toggleSummaryPanel() {
  const existing = document.getElementById('gai-summary-panel');
  if (existing) {
    existing.remove();
    return;
  }
  openSummaryPanel();
}

function openSummaryPanel() {
  const prev = document.getElementById('gai-summary-panel');
  if (prev) prev.remove();

  const panel = document.createElement('div');
  panel.id = 'gai-summary-panel';
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', 'Page summary');
  Object.assign(panel.style, {
    position: 'fixed', right: '12px', top: 'calc(50% + 64px)', transform: 'translateY(-50%)',
    zIndex: 2147483647, width: '360px', maxHeight: '540px', borderRadius: '12px',
    boxShadow: '0 12px 40px rgba(0,0,0,0.36)', background: '#0f1113', color: '#e6eef2',
    display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: 'Inter, Arial, sans-serif', fontSize: '13px', padding: '10px'
  });

  const header = document.createElement('div');
  Object.assign(header.style, { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' });
  const title = document.createElement('div');
  title.textContent = 'Page Summary';
  title.style.color = '#a6fff0';
  title.style.fontWeight = '700';
  const close = document.createElement('button');
  close.innerText = '✕';
  Object.assign(close.style, { background: 'transparent', border: 'none', color: '#e6eef2', cursor: 'pointer' });
  close.addEventListener('click', () => panel.remove());
  header.appendChild(title);
  header.appendChild(close);
  panel.appendChild(header);

  const opts = document.createElement('div');
  Object.assign(opts.style, { display: 'flex', gap: '8px', marginBottom: '8px', alignItems: 'center' });
  const lengthSelect = document.createElement('select');
  lengthSelect.id = 'gai-summary-length';
  ['Short (50-80 words)','Medium (120-180 words)','Long (300-500 words)'].forEach((t, i) => {
    const o = document.createElement('option'); o.value = ['short','medium','long'][i]; o.text = t; lengthSelect.appendChild(o);
  });
  Object.assign(lengthSelect.style, { flex: '1', padding: '8px', borderRadius: '8px', background: '#0b0d0f', color: '#e6eef2', border: '1px solid rgba(255,255,255,0.04)' });
  const genBtn = document.createElement('button');
  genBtn.id = 'gai-generate-summary';
  genBtn.textContent = 'Generate';
  Object.assign(genBtn.style, { padding: '8px 10px', borderRadius: '8px', border: '0', cursor: 'pointer', background: 'linear-gradient(90deg,#2dd4bf,#22c1c3)', color: '#041014', fontWeight: '600' });
  opts.appendChild(lengthSelect);
  opts.appendChild(genBtn);
  panel.appendChild(opts);

  const resArea = document.createElement('div');
  resArea.id = 'gai-summary-result';
  Object.assign(resArea.style, { flex: '1', overflow: 'auto', background: '#071015', border: '1px solid rgba(255,255,255,0.03)', borderRadius: '8px', padding: '10px', whiteSpace: 'pre-wrap', lineHeight: '1.4' });
  panel.appendChild(resArea);

  const actRow = document.createElement('div');
  Object.assign(actRow.style, { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '8px' });
  const formatSelect = document.createElement('select');
  formatSelect.id = 'gai-summary-format';
  ['txt','pdf'].forEach(ext => { const o = document.createElement('option'); o.value = ext; o.text = ext.toUpperCase(); formatSelect.appendChild(o); });
  Object.assign(formatSelect.style, { padding: '6px', borderRadius: '8px', background: '#0b0d0f', color: '#e6eef2', border: '1px solid rgba(255,255,255,0.04)' });
  const dlBtn = document.createElement('button');
  dlBtn.textContent = 'Download';
  Object.assign(dlBtn.style, { padding: '8px 10px', borderRadius: '8px', border: '0', cursor: 'pointer', background: DEFAULT_THEME, color: '#041014', fontWeight: '600' });
  actRow.appendChild(formatSelect); actRow.appendChild(dlBtn);
  panel.appendChild(actRow);

  genBtn.addEventListener('click', () => {
    resArea.textContent = 'Generating summary…';
    genBtn.disabled = true;
    const length = document.getElementById('gai-summary-length').value;
    const pageContext = getPageContext();
    chrome.runtime.sendMessage({ action: 'summarize_page', pageContext, length }, (resp) => {
      genBtn.disabled = false;
      if (!resp) { resArea.textContent = 'No response (messaging error)'; return; }
      if (!resp.ok) { resArea.textContent = `Error: ${resp.error || 'unknown'}`; return; }
      const text = resp.text || resp.data?.text || JSON.stringify(resp.data);
      resArea.textContent = text;
    });
  });

  dlBtn.addEventListener('click', async () => {
    const text = (document.getElementById('gai-summary-result') || { textContent: '' }).textContent || '';
    if (!text.trim()) { alert('No summary to download — generate first.'); return; }
    const fmt = document.getElementById('gai-summary-format').value || 'txt';
    const titleSafe = (document.title || 'page-summary').replace(/[^\w\- ]+/g, '').slice(0, 60);
    const filename = `${titleSafe}.${fmt}`;
    if (fmt === 'txt') {
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } else if (fmt === 'pdf') {
      const scriptId = 'jspdf-lib';
      if (!window.jspdf && !document.getElementById(scriptId)) {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
        s.id = scriptId;
        s.onload = () => generatePDF(text, filename);
        s.onerror = () => alert('Failed to load PDF library. Try again.');
        document.head.appendChild(s);
      } else if (window.jspdf) generatePDF(text, filename);
      else setTimeout(() => { if (window.jspdf) generatePDF(text, filename); else alert('PDF library still loading — try again.'); }, 1000);
    }
  });

  function generatePDF(content, fileName) {
    try {
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ orientation: 'p', unit: 'pt', format: 'a4' });
      const margin = 40;
      const pageWidth = doc.internal.pageSize.getWidth() - margin * 2;
      const lineHeight = 14;
      const lines = doc.splitTextToSize(content, pageWidth);
      let y = margin;
      lines.forEach(line => {
        if (y > doc.internal.pageSize.getHeight() - margin) { doc.addPage(); y = margin; }
        doc.text(line, margin, y); y += lineHeight;
      });
      doc.save(fileName);
    } catch (err) { console.error('PDF generation failed', err); alert('Failed to generate PDF.'); }
  }

  document.body.appendChild(panel);
}

// ---------- Utilities ----------
function parseTargetLanguage(s) {
  if (!s) return null;
  const m = s.match(/translate (?:to )?(.+)$/i);
  return m && m[1] ? m[1].trim() : null;
}

function sendQueryAndShow({ mode, task, prompt, selectedText, targetLanguage, pageContext }) {
  chrome.runtime.sendMessage({ action: 'query_gemini', mode, task, prompt, selectedText, targetLanguage, pageContext }, (resp) => {
    console.log('query_gemini result', resp);
  });
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// overlay helpers
function createOverlay(id, onClick) {
  removeOverlay(id); // ensure single
  const ov = document.createElement('div');
  ov.id = id;
  ov.className = 'gai-overlay';
  ov.style.zIndex = 2147483645;
  ov.addEventListener('click', (e) => {
    if (onClick) onClick(e);
  });
  document.body.appendChild(ov);
}
function removeOverlay(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

window.addEventListener('beforeunload', () => {
  chrome.runtime.sendMessage({ type: 'CLOSE_EXTENSION' });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'showPromptForSelection') {
    const sel = msg.text || (window.getSelection && window.getSelection().toString()) || '';
    let rect = null;
    try {
      const range = window.getSelection && window.getSelection().rangeCount ? window.getSelection().getRangeAt(0) : null;
      if (range) rect = range.getBoundingClientRect();
    } catch (e) { rect = null; }
    if (!rect) {
      createPromptBox(100, 100, sel);
      return;
    }
    createPromptBoxFromSelectionRect(rect, sel);
  }
});

function initFloatingWidgetFeature() {
  try {
    ensureFloatingWidget();
  } catch (e) {
    console.error('Failed to init widget', e);
  }
}

setTimeout(initFloatingWidgetFeature, 250);
