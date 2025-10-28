// background.js
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "GET_TOKEN") {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
        return;
      }
      sendResponse({ token });
    });
    return true;
  }

  if (msg && msg.type === "REMOVE_TOKEN") {
    const token = msg.token;
    if (!token) {
      sendResponse({ ok: false, error: "no token provided" });
      return;
    }

    // Remove cached token from Chrome and revoke it at Google
    chrome.identity.removeCachedAuthToken({ token }, () => {
      fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`)
        .then((response) => {
          sendResponse({ ok: response.ok });
        })
        .catch((err) => sendResponse({ ok: false, error: err.message }));
    });
    return true;
  }
});
