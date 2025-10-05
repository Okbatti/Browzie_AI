// background.js
// Enhanced: notifies content scripts when generation starts/finishes and supports aborting outstanding requests.
//
// Original file used as base for edits. See original for older behavior. :contentReference[oaicite:1]{index=1}

// Map to track active fetch AbortControllers per tabId
// key: tabId (number or undefined for non-tab callers), value: Set<AbortController>
const activeFetchControllers = new Map();

// Create the context menu on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'gemini_translate',
    title: "Translate '%s' with Gemini",
    contexts: ['selection']
  });

  chrome.storage.sync.set({ themeColor: '#0B61FF', pinned: false });
});

// When the context menu item is clicked, tell the content script to open the prompt box
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'gemini_translate' && info.selectionText) {
    chrome.tabs.sendMessage(tab.id, { action: 'showPromptForSelection', text: info.selectionText })
      .catch(err => {
        console.warn('sendMessage to content script failed:', err);
      });
  }
});

// Helper: add an AbortController to the set for a tab
function addControllerForTab(tabId, controller) {
  const key = (typeof tabId !== 'undefined') ? tabId : 'no-tab';
  let set = activeFetchControllers.get(key);
  if (!set) {
    set = new Set();
    activeFetchControllers.set(key, set);
  }
  set.add(controller);
}

// Helper: remove an AbortController from the set for a tab
function removeControllerForTab(tabId, controller) {
  const key = (typeof tabId !== 'undefined') ? tabId : 'no-tab';
  const set = activeFetchControllers.get(key);
  if (!set) return;
  set.delete(controller);
  if (set.size === 0) activeFetchControllers.delete(key);
}

// Cleanup function: abort all controllers for a tab (or 'no-tab' key)
function cleanupTab(tabId) {
  const key = (typeof tabId !== 'undefined') ? tabId : 'no-tab';
  const set = activeFetchControllers.get(key);
  if (!set) return;
  const count = set.size;
  for (const controller of set) {
    try { controller.abort(); } catch (e) { /* ignore */ }
  }
  activeFetchControllers.delete(key);
  console.log(`cleanupTab: aborted ${count} request(s) for tab/key: ${key}`);
}

// If a tab is removed (user closed the tab), abort outstanding requests for that tab
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  cleanupTab(tabId);
  console.log(`Tab ${tabId} closed — cleaned up extension resources for that tab.`);
});

// Helper to notify the content script (if tabId available) of a lifecycle event
function notifyTab(tabId, message) {
  if (typeof tabId === 'undefined') return;
  try {
    chrome.tabs.sendMessage(tabId, message, (res) => {
      // optional callback logging
      const err = chrome.runtime.lastError;
      if (err) {
        // It's normal to have errors when the page doesn't have the content script injected.
        // Keep this quiet unless debugging is enabled.
        // console.warn('notifyTab sendMessage error:', err.message);
      }
    });
  } catch (e) {
    // swallow to avoid throwing inside service worker
    // console.warn('notifyTab exception', e);
  }
}

// Listen for messages from content scripts or popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // 0) Abort outstanding requests for a given tab (useful if user closes UI or presses cancel)
  if (msg.action === 'abort_requests') {
    const tabId = sender?.tab?.id;
    if (typeof tabId !== 'undefined') {
      cleanupTab(tabId);
      sendResponse({ ok: true, message: 'aborted for tab ' + tabId });
    } else {
      cleanupTab(undefined);
      sendResponse({ ok: true, message: 'aborted non-tab controllers' });
    }
    return;
  }

  // 1) Content script telling us the page/tab is unloading -> cleanup
  if (msg.type === 'CLOSE_EXTENSION') {
    const tabId = sender?.tab?.id;
    if (typeof tabId !== 'undefined') {
      console.log(`Received CLOSE_EXTENSION from tab ${tabId}`);
      cleanupTab(tabId);
    } else {
      console.log('Received CLOSE_EXTENSION from non-tab sender — cleaning non-tab controllers');
      cleanupTab(undefined);
    }
    return;
  }

  // 1b) Summarize page branch
  if (msg.action === 'summarize_page') {
    (async () => {
      const tabId = sender?.tab?.id;
      const controller = new AbortController();
      addControllerForTab(tabId, controller);

      try {
        const payload = {
          pageContext: msg.pageContext || null,
          length: msg.length || 'medium'
        };

        // notify content script to show "thinking" skeleton
        notifyTab(tabId, { action: 'generation_started', kind: 'summary' });

        // Debug log
        try {
          console.log('Background: summarize_page for', payload.pageContext?.url || '(no-url)', 'length=', payload.length);
        } catch (e) { /* ignore */ }

        const res = await fetch('http://localhost:3000/api/summarize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal
        });

        removeControllerForTab(tabId, controller);

        if (!res.ok) {
          let bodyText = '<unable to read>';
          try { bodyText = await res.text(); } catch (e) {}
          // notify finish with error
          notifyTab(tabId, { action: 'generation_finished', ok: false, error: `Server error ${res.status}: ${bodyText}`, kind: 'summary' });
          sendResponse({ ok: false, error: `Server error ${res.status}: ${bodyText}` });
          return;
        }

        const data = await res.json();
        // notify content script with result
        notifyTab(tabId, { action: 'generation_finished', ok: true, text: data?.text, data, kind: 'summary' });
        sendResponse({ ok: !!data?.ok, text: data?.text, data });
      } catch (err) {
        removeControllerForTab(tabId, controller);
        const isAbort = err && err.name === 'AbortError';
        notifyTab(tabId, { action: 'generation_finished', ok: false, error: isAbort ? 'Request aborted' : (err && err.message) || String(err), kind: 'summary' });
        sendResponse({ ok: false, error: isAbort ? 'Request aborted' : (err && err.message) || String(err) });
      }
    })();

    return true; // async
  }

  // 2) LLM request path (existing)
  if (msg.action === 'query_gemini') {
    (async () => {
      const tabId = sender?.tab?.id; // may be undefined if message came from popup or extension UI
      const controller = new AbortController();
      addControllerForTab(tabId, controller);

      try {
        // Package the metadata you sent from the content script.
        // Include pageContext so the proxy can use it for prompt construction.
        const payload = {
          prompt: msg.prompt,
          selectedText: msg.selectedText,
          mode: msg.mode || 'general',
          task: msg.task || null,
          targetLanguage: msg.targetLanguage || null,
          pageContext: msg.pageContext || null
        };

        // Notify content script to show "thinking" skeleton / loading state
        notifyTab(tabId, { action: 'generation_started', kind: 'query' });

        // DEBUG: log a short summary of pageContext to the service worker console
        try {
          if (payload.pageContext) {
            console.log('Background: forwarding pageContext for', payload.pageContext.url || payload.pageContext.title || '(no url)');
          } else {
            console.log('Background: no pageContext provided');
          }
        } catch (e) {
          console.warn('Background: error logging pageContext', e);
        }

        // Adjust this URL to your actual local proxy or production endpoint
        const res = await fetch('http://localhost:3000/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal
        });

        // Remove controller once the fetch resolves
        removeControllerForTab(tabId, controller);

        if (!res.ok) {
          let text;
          try { text = await res.text(); } catch (e) { text = `<failed to read body: ${e.message}>`; }
          notifyTab(tabId, { action: 'generation_finished', ok: false, error: `Server error ${res.status}: ${text}`, kind: 'query' });
          sendResponse({ ok: false, error: `Server error ${res.status}: ${text}` });
          return;
        }

        const data = await res.json();

        // Forward the raw data to the content script and also notify finished
        notifyTab(tabId, { action: 'generation_finished', ok: true, data, kind: 'query' });
        sendResponse({ ok: true, data });
      } catch (err) {
        removeControllerForTab(tabId, controller);
        const isAbort = err && err.name === 'AbortError';
        notifyTab(tabId, { action: 'generation_finished', ok: false, error: isAbort ? 'Request aborted (tab closed or navigation occurred).' : (err && err.message) || String(err), kind: 'query' });
        sendResponse({ ok: false, error: isAbort ? 'Request aborted (tab closed or navigation occurred).' : (err && err.message) || String(err) });
      }
    })();

    // Indicate we will call sendResponse asynchronously
    return true;
  }

  // 3) Other messages: add handling here if needed
  if (msg.action === 'PING') {
    sendResponse({ ok: true, time: Date.now() });
    return;
  }
});
