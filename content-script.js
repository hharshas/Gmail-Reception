// content-script.js
(() => {
  // --- CONFIGURATION ---
  const SCORE_THRESHOLD = 40;
  const CLIENT_DISPLAY_NAME = "Gmail AI Reception";
  const PROFILE_REFRESH_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

  // --- STATE MANAGEMENT ---
  const STORAGE_KEYS = {
    USER_PROFILE: "gmail_ai_user_profile",
    LAST_ANALYSIS_TIMESTAMP: "gmail_ai_last_analysis_ts",
  };
  let state = {
    accessToken: null,
    isSignedIn: false,
    aiSession: null,
    summarizer: null,
    isTranslatorAvailable: false,
    translators: {},
  };
  let ui = {};

  // --- HELPERS ---

  /**
   * A small utility to easily get, set, or clear data from Chrome's local storage.
   * This is how we save the user profile so we don't have to recreate it every time.
   */
  const storage = {
    get: (keys) => chrome.storage.local.get(keys),
    set: (items) => chrome.storage.local.set(items),
    clear: () => chrome.storage.local.remove(Object.values(STORAGE_KEYS)),
  };

  function escapeHtml(s) {
    if (!s) return "";
    return s.replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        }[c])
    );
  }

  // --- GMAIL API & AI LOGIC ---

  /**
   * Fetches a list of emails from the user's Gmail account using a search query.
   * For example, it can find all unread emails.
   */
  async function fetchMessages(query, maxResults = 30) {
    if (!state.accessToken) return [];
    try {
      const listRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(
          query
        )}&maxResults=${maxResults}`,
        {
          headers: {
            Authorization: `Bearer ${state.accessToken}`,
          },
        }
      );
      if (!listRes.ok) throw new Error(`API list failed: ${listRes.status}`);
      const listJson = await listRes.json();
      if (!listJson.messages) return [];

      const details = [];
      const concurrency = 8;
      for (let i = 0; i < listJson.messages.length; i += concurrency) {
        const batch = listJson.messages.slice(i, i + concurrency);
        const promises = batch.map((m) =>
          fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`,
            {
              headers: {
                Authorization: `Bearer ${state.accessToken}`,
              },
            }
          ).then((r) => r.json())
        );
        details.push(...(await Promise.all(promises)));
      }
      return details;
    } catch (err) {
      console.error(`Failed to fetch messages for query "${query}":`, err);
      return [];
    }
  }

  /**
   * Creates a user profile by analyzing their past email activity.
   * It looks at important, unread, spam, and trashed emails to understand
   * what the user considers high or low priority.
   */
  async function generateUserProfile() {
    // This function remains the same as your provided version
    if (!state.aiSession) throw new Error("AI session not available.");
    setStatus("Analyzing your historical email priorities...");
    const [importantEmails, unreadEmails, spamEmails, trashedEmails] =
      await Promise.all([
        fetchMessages("is:important or is:starred", 15),
        fetchMessages("is:unread older_than:2d", 15),
        fetchMessages("in:spam", 10),
        fetchMessages("in:trash", 10),
      ]);
    const toSimpleList = (emails) =>
      emails.map((e) => {
        const headers = e.payload?.headers || [];
        const from =
          (headers.find((h) => h.name.toLowerCase() === "from") || {}).value ||
          "";
        const subject =
          (headers.find((h) => h.name.toLowerCase() === "subject") || {})
            .value || "";
        return {
          from,
          subject,
        };
      });
    const prompt = `Analyze the user's email behavior to create a profile of their priorities.\n- HIGH PRIORITY emails (user marked as important or starred): ${JSON.stringify(
      toSimpleList(importantEmails)
    )}\n- IGNORED emails (user left unread): ${JSON.stringify(
      toSimpleList(unreadEmails)
    )}\n- JUNK emails (found in spam): ${JSON.stringify(
      toSimpleList(spamEmails)
    )}\n- DELETED emails (found in trash): ${JSON.stringify(
      toSimpleList(trashedEmails)
    )}\n\nBased on this, generate a JSON object summarizing the user's preferences. This object should identify:\n1. 'highPrioritySenders': Senders from important/starred emails.\n2. 'highPriorityKeywords': Keywords from subjects of important/starred emails.\n3. 'lowPrioritySenders': Senders often found in unread, spam, or trash.\n4. 'lowPriorityKeywords': Keywords (like 'promotion', 'newsletter') found in ignored emails.\n\nReturn ONLY the JSON object.`;
    const schema = {
      type: "object",
      properties: {
        highPrioritySenders: {
          type: "array",
          items: {
            type: "string",
          },
        },
        highPriorityKeywords: {
          type: "array",
          items: {
            type: "string",
          },
        },
        lowPrioritySenders: {
          type: "array",
          items: {
            type: "string",
          },
        },
        lowPriorityKeywords: {
          type: "array",
          items: {
            type: "string",
          },
        },
      },
      required: [
        "highPrioritySenders",
        "highPriorityKeywords",
        "lowPrioritySenders",
        "lowPriorityKeywords",
      ],
    };
    try {
      setStatus("Generating user profile with AI...");
      const result = await state.aiSession.prompt(prompt, {
        responseConstraint: schema,
      });
      const userProfile = JSON.parse(result);
      await storage.set({
        [STORAGE_KEYS.USER_PROFILE]: userProfile,
        [STORAGE_KEYS.LAST_ANALYSIS_TIMESTAMP]: Date.now(),
      });
      return userProfile;
    } catch (err) {
      console.error("Failed to parse user profile from AI:", err);
      throw new Error("Could not generate user behavior profile.");
    }
  }

  /**
   * Fetches recent unread emails and sends them to the AI for scoring.
   * It processes emails in small batches to keep the UI responsive and
   * updates the screen as each batch is completed.
   */
  async function scoreRecentEmails(userProfile, onBatchProcessed) {
    if (!state.aiSession) throw new Error("AI session not available.");
    setStatus("Fetching recent unread emails...");

    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    const timestampInSeconds = Math.floor(twoDaysAgo.getTime() / 1000);
    const query = `is:inbox is:unread after:${timestampInSeconds}`;
    const recentEmails = await fetchMessages(query, 7);

    if (recentEmails.length === 0) {
      setStatus(
        "No unread emails in the last 2 days. You're all caught up! 🎉"
      );
      onBatchProcessed([]);
      return;
    }

    let processedEmails = recentEmails.map((email) => ({
      ...email,
      analysisData: {
        id: email.id,
        score: -1,
        summarizedTitle: "Analyzing...",
        summaryPoints: [], // Will be populated by the prompt
        positiveReasons: [],
        negativeReasons: [],
      },
    }));
    onBatchProcessed(processedEmails);

    const BATCH_SIZE = 5;

    for (let i = 0; i < recentEmails.length; i += BATCH_SIZE) {
      const batch = recentEmails.slice(i, i + BATCH_SIZE);
      setStatus(
        `Analyzing emails ${i + 1}-${Math.min(
          i + BATCH_SIZE,
          recentEmails.length
        )} of ${recentEmails.length}...`
      );

      const emailsToScore = batch.map((email) => {
        const headers = email.payload?.headers || [];
        const from =
          (headers.find((h) => h.name.toLowerCase() === "from") || {}).value ||
          "";
        const subject =
          (headers.find((h) => h.name.toLowerCase() === "subject") || {})
            .value || "";
        return {
          id: email.id,
          from,
          subject,
          snippet: email.snippet || "",
        };
      });

      const prompt = `Based on the user profile below, analyze each email in the provided array.\nUSER PROFILE: ${JSON.stringify(
        userProfile
      )}\nEMAILS TO ANALYZE: ${JSON.stringify(
        emailsToScore
      )}\n\nReturn a JSON array where each object contains:\n1. 'id': The original email ID.\n2. 'score': A relevance score from 0 to 100.\n3. 'summarizedTitle': A concise, descriptive title (max 10 words).\n4. 'summaryPoints': An array of strings with 2-4 key points summarizing the email's content.\n5. 'positiveReasons': An array of strings explaining why it's important.\n6. 'negativeReasons': An array of strings for why it might be low priority.\nMaintain the same order as the input array.`;

      const schema = {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            score: { type: "number" },
            summarizedTitle: { type: "string" },
            summaryPoints: { type: "array", items: { type: "string" } },
            positiveReasons: { type: "array", items: { type: "string" } },
            negativeReasons: { type: "array", items: { type: "string" } },
          },
          required: [
            "id",
            "score",
            "summarizedTitle",
            "summaryPoints",
            "positiveReasons",
            "negativeReasons",
          ],
        },
      };

      try {
        const result = await state.aiSession.prompt(prompt, {
          responseConstraint: schema,
        });
        const batchResults = JSON.parse(result);

        if (Array.isArray(batchResults)) {
          batchResults.forEach((analysisResult) => {
            const emailIndex = processedEmails.findIndex(
              (e) => e.id === analysisResult.id
            );
            if (emailIndex > -1) {
              processedEmails[emailIndex].analysisData = analysisResult;
            }
          });
        }
      } catch (err) {
        console.error(
          `Batch scoring failed for emails ${i + 1}-${i + batch.length}:`,
          err
        );
        batch.forEach((failedEmail) => {
          const emailIndex = processedEmails.findIndex(
            (e) => e.id === failedEmail.id
          );
          if (emailIndex > -1) {
            processedEmails[emailIndex].analysisData = {
              id: failedEmail.id,
              score: 0,
              summarizedTitle: "AI analysis failed for this email.",
              summaryPoints: [],
              positiveReasons: [],
              negativeReasons: ["AI model failed to process this batch."],
            };
          }
        });
      }
      onBatchProcessed(processedEmails);
    }
  }

  /**
   * A general function to change an email's labels in Gmail.
   * This is used by other functions to mark as read, delete, etc.
   */
  async function modifyEmail(messageId, addLabelIds = [], removeLabelIds = []) {
    if (!state.accessToken) throw new Error("Authentication token not found.");
    try {
      const response = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${state.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            addLabelIds,
            removeLabelIds,
          }),
        }
      );
      if (!response.ok) {
        const error = await response.json();
        throw new Error(`API Error: ${error.error.message}`);
      }
      return true;
    } catch (err) {
      console.error(`Failed to modify email ${messageId}:`, err);
      return false;
    }
  }
  const deleteEmail = (messageId) => modifyEmail(messageId, ["TRASH"], []);
  const markEmailAsRead = (messageId) => modifyEmail(messageId, [], ["UNREAD"]);

  // --- CORE LOGIC & RENDERING ---

  /**
   * This is the main workflow function. It gets the user profile (or creates one),
   * sends the recent emails for scoring, and then calls the function to display them.
   */
  async function analyzeAndDisplayEmails() {
    if (!state.isSignedIn || !state.aiSession) {
      setStatus("Please sign in first.");
      return;
    }
    ui.emailsEl.innerHTML = `<div class="loading-spinner">🧠 Preparing to analyze your inbox...</div>`;
    ui.analyzeBtn.disabled = true;
    ui.analyzeBtn.textContent = "Analyzing...";

    try {
      setStatus("1/2: Loading user profile...");
      let data = await storage.get([
        STORAGE_KEYS.USER_PROFILE,
        STORAGE_KEYS.LAST_ANALYSIS_TIMESTAMP,
      ]);
      let userProfile = data[STORAGE_KEYS.USER_PROFILE];
      const lastAnalysis = data[STORAGE_KEYS.LAST_ANALYSIS_TIMESTAMP];
      const isProfileStale =
        !lastAnalysis || Date.now() - lastAnalysis > PROFILE_REFRESH_INTERVAL;

      if (!userProfile || isProfileStale) {
        setStatus(
          `1/2: ${
            !userProfile ? "No profile found." : "Profile is stale."
          } Generating new one...`
        );
        userProfile = await generateUserProfile();
      } else {
        setStatus("1/2: User profile loaded from storage.");
      }

      const handleBatchProcessing = (processedEmails) => {
        renderEmails(processedEmails);
      };

      await scoreRecentEmails(userProfile, handleBatchProcessing);

      setStatus(
        "Analysis complete. All emails have been processed and sorted."
      );
    } catch (err) {
      console.error(err);
      setStatus(`Error: ${err.message}. See console for details.`);
      ui.emailsEl.innerHTML = `<div class="error-message">An error occurred: ${err.message}</div>`;
    } finally {
      ui.analyzeBtn.disabled = false;
      ui.analyzeBtn.textContent = "Scan Unread Emails";
    }
  }

  /**
   * Takes the list of scored emails and creates the HTML to display them.
   * It sorts the emails by score and adds buttons for actions like delete and mark as read.
   */
  function renderEmails(emails) {
    ui.emailsEl.innerHTML = "";

    if (!emails || emails.length === 0) {
      ui.emailsEl.innerHTML = `<div class="no-emails">No priority emails found. You're all caught up!</div>`;
      return;
    }

    emails.sort((a, b) => b.analysisData.score - a.analysisData.score);

    emails.forEach((email) => {
      const { analysisData } = email;
      const getHeader = (name) =>
        (
          email.payload?.headers?.find(
            (h) => h.name.toLowerCase() === name.toLowerCase()
          ) || {}
        ).value || "";
      const isLowPriority =
        analysisData.score >= 0 && analysisData.score < SCORE_THRESHOLD;

      const card = document.createElement("div");
      card.className = `email-card ${isLowPriority ? "is-low-priority" : ""}`;
      card.dataset.emailId = email.id;
      card.dataset.snippet = email.snippet || "";

      card.innerHTML = `
        <div class="email-card-header">
          <div class="email-summary">
            <span class="score" title="Relevance Score">${
              analysisData.score < 0 ? "..." : analysisData.score
            }</span>
            <span class="summarized-title">${escapeHtml(
              analysisData.summarizedTitle
            )}</span>
          </div>
          <div class="email-sender">${escapeHtml(getHeader("From"))}</div>
        </div>
        <div class="email-card-body" style="display: none;">
          <ul class="summary-points">
            ${(analysisData.summaryPoints || [])
              .map((p) => `<li>${escapeHtml(p)}</li>`)
              .join("")}
          </ul>
          <div class="reasons-container">
            ${(analysisData.positiveReasons || [])
              .map(
                (r) => `<span class="reason positive">${escapeHtml(r)}</span>`
              )
              .join("")}
            ${(analysisData.negativeReasons || [])
              .map(
                (r) => `<span class="reason negative">${escapeHtml(r)}</span>`
              )
              .join("")}
          </div>
          <div class="email-actions">
            <button class="mark-as-read-btn">Mark as Read</button>
            <button class="delete-btn">Delete</button>
            <button class="detailed-summary-btn" title="This may take a moment to generate">Show Detailed Summary</button>
            ${
              state.isTranslatorAvailable
                ? `
              <div class="translation-container">
                <select class="translate-summary-select">
                  <option value="">Translate Summary</option>
                  <option value="es">Spanish</option>
                  <option value="fr">French</option>
                  <option value="de">German</option>
                  <option value="hi">Hindi</option>
                  <option value="zh">Chinese</option>
                </select>
              </div>
            `
                : ""
            }
            <a href="https://mail.google.com/mail/u/0/#inbox/${
              email.id
            }" target="_blank" class="open-in-gmail-link">Open in Gmail</a>
          </div>
        </div>
      `;
      ui.emailsEl.appendChild(card);
    });

    // --- EVENT LISTENERS ---

    ui.emailsEl.querySelectorAll(".email-card-header").forEach((header) => {
      header.addEventListener("click", () => {
        const body = header.nextElementSibling;
        body.style.display = body.style.display === "none" ? "block" : "none";
      });
    });

    ui.emailsEl
      .querySelectorAll(".translate-summary-select")
      .forEach((select) => {
        select.addEventListener("change", handleTranslationRequest);
      });

    ui.emailsEl.querySelectorAll(".detailed-summary-btn").forEach((button) => {
      button.addEventListener("click", async (e) => {
        e.stopPropagation();
        const card = button.closest(".email-card");
        const summaryPointsEl = card.querySelector(".summary-points");

        if (!state.summarizer) {
          summaryPointsEl.innerHTML = `<li>❌ Summarizer API is not available.</li>`;
          button.remove();
          return;
        }
        button.textContent = "🧠 Generating...";
        button.disabled = true;

        try {
          const snippet = card.dataset.snippet;
          if (!snippet) throw new Error("No content to summarize.");
          const stream = await state.summarizer.summarizeStreaming(snippet);

          // 2. Clear the list and prepare to show streaming text
          summaryPointsEl.innerHTML = "<li></li>"; // Create one list item
          const streamingLi = summaryPointsEl.querySelector("li");
          let fullSummary = ""; // To store the complete text

          // 3. Loop through the stream and append chunks
          for await (const chunk of stream) {
            fullSummary += chunk;
            streamingLi.textContent = fullSummary; // Update UI in real-time
          }

          // 4. Once streaming is done, format the full text into points
          const points = fullSummary
            .split("\n") // Now you can safely call .split()
            .filter((p) => p.trim() !== "")
            .map((p) => p.replace(/^- /, ""));

          // 5. Set the final HTML with proper list items
          summaryPointsEl.innerHTML = points
            .map((p) => `<li>${escapeHtml(p)}</li>`)
            .join("");

          // --- END OF FIX ---
          button.remove();
        } catch (err) {
          console.error("Detailed summarization failed:", err);
          summaryPointsEl.innerHTML += `<li>❌ Could not generate detailed summary.</li>`;
          button.textContent = "Retry Detailed Summary";
          button.disabled = false;
        }
      });
    });

    ui.emailsEl.querySelectorAll(".mark-as-read-btn").forEach((button) => {
      button.addEventListener("click", async (e) => {
        e.stopPropagation();
        const card = button.closest(".email-card");
        const emailId = card.dataset.emailId;
        button.textContent = "Marking...";
        button.disabled = true;
        const success = await markEmailAsRead(emailId);
        if (success) {
          card.style.transition =
            "opacity 0.5s ease, height 0.5s ease, padding 0.5s ease, margin 0.5s ease";
          card.style.opacity = "0";
          card.style.height = "0";
          card.style.padding = "0";
          card.style.margin = "0";
          setTimeout(() => card.remove(), 500);
        } else {
          button.textContent = "Mark as Read";
          button.disabled = false;
          alert("Failed to mark email as read. Please try again.");
        }
      });
    });

    ui.emailsEl.querySelectorAll(".delete-btn").forEach((button) => {
      button.addEventListener("click", async (e) => {
        e.stopPropagation();
        const card = button.closest(".email-card");
        const emailId = card.dataset.emailId;
        if (
          !confirm("Are you sure you want to move this email to the trash?")
        ) {
          return;
        }
        button.textContent = "Deleting...";
        button.disabled = true;
        const success = await deleteEmail(emailId);
        if (success) {
          card.style.transition =
            "opacity 0.5s ease, height 0.5s ease, padding 0.5s ease, margin 0.5s ease";
          card.style.opacity = "0";
          card.style.height = "0";
          card.style.padding = "0";
          card.style.margin = "0";
          setTimeout(() => card.remove(), 500);
        } else {
          button.textContent = "Delete";
          button.disabled = false;
          alert("Failed to delete the email. Please try again.");
        }
      });
    });
  }

  // --- AUTHENTICATION & UI SETUP ---

  /**
   * A simple helper to update the status message at the top of the extension.
   */
  function setStatus(s) {
    if (ui.statusEl) ui.statusEl.textContent = s;
  }

  /**
   * Checks if the browser's built-in AI is available and creates a session for us to use.
   */
  async function createAiSession() {
    if (!self.LanguageModel)
      throw new Error("Built-in AI (LanguageModel) not available.");
    const availability = await self.LanguageModel.availability();
    if (availability === "unavailable") {
      throw new Error("Built-in AI is not available on this device.");
    }
    return await self.LanguageModel.create();
  }

  /**
   * Handles the interactive sign-in process when the user clicks the "Sign In" button.
   * It requests an authentication token from Google.
   */
  async function handleSignIn() {
    setStatus("Requesting token...");
    try {
      const token = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: "GET_TOKEN" }, (resp) => {
          if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
          if (!resp || resp.error)
            return reject(new Error(resp.error || "No response."));
          resolve(resp.token);
        });
      });
      state.accessToken = token;
      state.isSignedIn = true;

      setStatus("Creating AI session...");
      state.aiSession = await createAiSession();

      setStatus("Creating summarizer...");
      if (self.Summarizer) {
        const summarizerAvailability = await self.Summarizer.availability();
        if (
          summarizerAvailability === "available" ||
          summarizerAvailability === "readily"
        ) {
          state.summarizer = await self.Summarizer.create({
            type: "key-points",
            length: "long",
            format: "plain-text",
          });
        }
      }
      if (!state.summarizer) console.warn("Summarizer API is not available.");

      if ("Translator" in self) {
        state.isTranslatorAvailable = true;
        console.log("Translator API is available.");
      } else {
        console.warn("Translator API is not available.");
      }

      updateUIForState();
      setStatus("Signed in successfully. Click 'Scan Unread Emails' to start.");
    } catch (err) {
      console.error("Sign-in failed:", err);
      setStatus(`Auth error: ${err.message}`);
      state = {
        accessToken: null,
        isSignedIn: false,
        aiSession: null,
        summarizer: null,
        isTranslatorAvailable: false,
        translators: {},
      };
      updateUIForState();
    }
  }
  function handleSignOut() {
    if (!state.accessToken) return;
    setStatus("Signing out...");
    chrome.runtime.sendMessage(
      { type: "REMOVE_TOKEN", token: state.accessToken },
      () => {
        if (state.aiSession?.destroy) state.aiSession.destroy();
        state = {
          accessToken: null,
          isSignedIn: false,
          aiSession: null,
          summarizer: null,
          isTranslatorAvailable: false,
          translators: {},
        };
        storage.clear();
        if (ui.emailsEl) ui.emailsEl.innerHTML = "";
        updateUIForState();
        setStatus("Signed out.");
      }
    );
  }

  /**
   * Shows or hides the correct buttons (e.g., "Sign In" vs. "Sign Out")
   * based on the current login state.
   */
  function updateUIForState() {
    const showSignedIn = state.isSignedIn;
    ui.signBtn.style.display = showSignedIn ? "none" : "inline-block";
    ui.signoutBtn.style.display = showSignedIn ? "inline-block" : "none";
    ui.analyzeBtn.style.display = showSignedIn ? "inline-block" : "none";
    ui.analyzeBtn.disabled = !state.aiSession;
  }

  /**
   * Handles the translation of email summaries when the user picks a language.
   */
  async function handleTranslationRequest(event) {
    const selectEl = event.target;
    const targetLang = selectEl.value;
    if (!targetLang) return;

    const card = selectEl.closest(".email-card");
    const summaryPointsList = card.querySelector(".summary-points");
    const listItems = summaryPointsList.querySelectorAll("li");
    const translationContainer = selectEl.parentElement;

    listItems.forEach((li) => {
      if (!li.dataset.originalText) {
        li.dataset.originalText = li.textContent;
      }
    });

    translationContainer.innerHTML = `<span class="translation-status">Translating...</span>`;

    try {
      const sourceLang = "en";
      const cacheKey = `${sourceLang}-${targetLang}`;
      let translator = state.translators[cacheKey];

      if (!translator) {
        const availability = await Translator.availability({
          sourceLanguage: sourceLang,
          targetLanguage: targetLang,
        });

        if (availability.state !== "available") {
          translationContainer.innerHTML = `<span class="translation-status">Downloading model...</span>`;
        }

        translator = await Translator.create({
          sourceLanguage: sourceLang,
          targetLanguage: targetLang,
        });
        state.translators[cacheKey] = translator;
      }

      const translationPromises = Array.from(listItems).map((li) =>
        translator.translate(li.dataset.originalText)
      );

      const translatedTexts = await Promise.all(translationPromises);

      translatedTexts.forEach((text, index) => {
        listItems[index].textContent = text;
      });

      translationContainer.innerHTML = "";
      selectEl.value = targetLang;
      translationContainer.appendChild(selectEl);
    } catch (err) {
      console.error(`Translation to ${targetLang} failed:`, err);
      translationContainer.innerHTML = `<span class="translation-status error">Translation failed</span>`;

      listItems.forEach((li) => {
        if (li.dataset.originalText) {
          li.textContent = li.dataset.originalText;
        }
      });

      setTimeout(() => {
        translationContainer.innerHTML = "";
        selectEl.value = "";
        translationContainer.appendChild(selectEl);
      }, 3000);
    }
  }

  /**
   * Creates the entire user interface (HTML and CSS) for the extension.
   * It uses a "Shadow DOM" to make sure our styles don't conflict with Gmail's styles.
   */
  function setupUI() {
    const mount = document.createElement("div");
    mount.style.display = "none";
    document.documentElement.appendChild(mount);

    const shadow = mount.attachShadow({
      mode: "open",
    });
    shadow.innerHTML = `
      <style>
        :host {
          font-family: 'Google Sans', Roboto, sans-serif;
          --gmail-border-color: #e0e0e0;
          --gmail-background-color: #f6f8fc;
          --gmail-text-color-primary: #1f1f1f;
          --gmail-text-color-secondary: #5f6368;
        }

        /* --- FIX STARTS HERE --- */
        /* This is the missing rule that tells the browser to USE the icon font */
        .material-symbols-outlined {
          font-family: 'Material Symbols Outlined';
          font-weight: normal;
          font-style: normal;
          font-size: 24px;
          line-height: 1;
          letter-spacing: normal;
          text-transform: none;
          display: inline-block;
          white-space: nowrap;
          word-wrap: normal;
          direction: ltr;
          -webkit-font-smoothing: antialiased;
        }
        /* --- FIX ENDS HERE --- */

        #reception-container {
          width: 100%; height: 100%; background-color: white;
          display: none; flex-direction: column; overflow: hidden;
        }
        #reception-header {
          padding: 12px 24px; border-bottom: 1px solid var(--gmail-border-color);
          display: flex; justify-content: space-between; align-items: center;
        }
        .title-container {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        #reception-header h1 { margin: 0; font-size: 22px; font-weight: 400; color: var(--gmail-text-color-primary); }
        .info-icon {
  font-size: 20px;
  color: var(--gmail-text-color-secondary);
  cursor: help;
  font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24;
}
        #reception-controls { display: flex; gap: 10px; }
        #reception-controls button {
          border: none; cursor: pointer; font-size: 14px; font-weight: 500;
          padding: 10px 24px; border-radius: 18px; transition: background-color .2s;
        }
        #analyzeBtn { background-color: #c2e7ff; color: #001d35; }
        #analyzeBtn:hover { background-color: #aedcff; }
        #analyzeBtn:disabled { background-color: #e0e0e0; color: #a1a1a1; cursor: not-allowed; }
        #signBtn, #signoutBtn { background-color: #f1f3f4; color: #444746; }
        #signBtn:hover, #signoutBtn:hover { background-color: #e8eaed; }
        #reception-status {
          padding: 8px 24px; background: var(--gmail-background-color);
          border-bottom: 1px solid var(--gmail-border-color);
        }
        #status-message { margin: 0; font-size: 14px; color: var(--gmail-text-color-secondary); }
        #reception-content { flex: 1; overflow-y: auto; background-color: white; }
        #email-list { display: flex; flex-direction: column; }
        
        /* ... rest of your styles ... */
        .email-card {
          border-bottom: 1px solid var(--gmail-border-color);
          transition: background-color 0.2s, opacity 0.2s;
          overflow: hidden; border-left: 4px solid transparent;
        }
        .email-card:not(.is-low-priority) .email-card-header:hover {
          background-color: var(--gmail-background-color); border-left-color: #0b57d0;
        }
        .email-card.is-low-priority { opacity: 0.6; }
        .email-card.is-low-priority:hover { opacity: 1; background-color: var(--gmail-background-color); }
        .email-card-header { padding: 12px 10px 12px 24px; display: flex; align-items: center; cursor: pointer; }
        .email-summary { display: flex; align-items: center; gap: 16px; flex-grow: 1; min-width: 0; }
        .score { font-weight: bold; color: var(--gmail-text-color-primary); font-size: 13px; border: 1px solid #d2e3fc; border-radius: 4px; padding: 3px 8px; background-color: #e8f0fe; min-width: 20px; text-align: center; }
        .summarized-title { font-weight: 500; font-size: 14px; color: var(--gmail-text-color-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .email-sender { font-size: 14px; color: var(--gmail-text-color-secondary); white-space: nowrap; margin-left: 20px; flex-shrink: 0; width: 180px; text-align: right; padding-right: 24px; }
        .email-card-body { padding: 10px 24px 16px 60px; background-color: #f6f8fc; }
        .summary-points { list-style-type: '• '; padding-left: 20px; margin: 0 0 16px 0; font-size: 14px; color: #3c4043; }
        .summary-points li { margin-bottom: 8px; line-height: 1.5; }
        .reasons-container { margin-bottom: 16px; display: flex; flex-wrap: wrap; gap: 8px; }
        .reason { padding: 4px 10px; border-radius: 16px; font-size: 12px; font-weight: 500; }
        .positive { color: #117b33; background-color: #e6f4ea; }
        .negative { color: #a50e0e; background-color: #fce8e6; }
        .email-actions { display: flex; gap: 10px; }
        .email-actions button, .email-actions a {
          background-color: transparent; color: #5f6368; border: 1px solid #dadce0; padding: 7px 16px;
          border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: 500;
          transition: background-color 0.2s; text-decoration: none;
        }
        .email-actions .open-in-gmail-link { color: #0b57d0; border-color: #a0c3ff; }
        .email-actions .detailed-summary-btn:hover { background-color: #e8f0fe; }
        .email-actions .detailed-summary-btn:disabled {
          cursor: wait; color: #5f6368; background-color: #f1f3f4;
        }
        .email-actions button:hover, .email-actions a:hover { background-color: #f1f3f4; }
        .delete-btn { color: #d93025; }
        .loading-spinner, .error-message, .no-emails { text-align: center; padding: 60px; color: var(--gmail-text-color-secondary); font-size: 16px; }
        .translation-container {
        display: inline-block;
        position: relative;
        vertical-align: middle;
      }
      .translate-summary-select {
        background-color: transparent;
        color: #5f6368;
        border: 1px solid #dadce0;
        padding: 7px 10px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 13px;
        font-weight: 500;
        font-family: inherit;
        -webkit-appearance: none;
        -moz-appearance: none;
        appearance: none;
        padding-right: 30px;
        background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22292.4%22%20height%3D%22292.4%22%3E%3Cpath%20fill%3D%22%235f6368%22%20d%3D%22M287%2069.4a17.6%2017.6%200%200%200-13-5.4H18.4c-5%200-9.3%201.8-12.9%205.4A17.6%2017.6%200%200%200%200%2082.2c0%205%201.8%209.3%205.4%2012.9l128%20127.9c3.6%203.6%207.8%205.4%2012.8%205.4s9.2-1.8%2012.8-5.4L287%2095c3.5-3.5%205.4-7.8%205.4-12.8%200-5-1.9-9.2-5.5-12.8z%22%2F%3E%3C%2Fsvg%3E');
        background-repeat: no-repeat;
        background-position: right 10px top 50%;
        background-size: .65em auto;
      }
      .translate-summary-select:hover {
        background-color: #f1f3f4;
      }
      .translation-status {
        font-size: 13px;
        font-weight: 500;
        color: #5f6368;
        padding: 8px 16px;
        display: inline-block;
        box-sizing: border-box;
        height: 33px;
      }
      .translation-status.error {
        color: #d93025;
        font-weight: 500;
      }
      </style>
      <div id="reception-container">
        <div id="reception-header">
          <div class="title-container">
            <h1>${CLIENT_DISPLAY_NAME}</h1>
            <span 
              class="material-symbols-outlined info-icon" 
              title="Due to slow APIs and for a quick demo, I’ve limited the query to only the most recent unread emails."
            >info</span>
          </div>
          <div id="reception-controls">
            <button id="signBtn">Sign In</button>
            <button id="analyzeBtn" style="display:none;">Scan Unread Emails</button>
            <button id="signoutBtn" style="display:none;">Sign Out</button>
          </div>
        </div>
        <div id="reception-status">
          <p id="status-message">Please sign in to prioritize your inbox.</p>
        </div>
        <div id="reception-content">
          <div id="email-list"></div>
        </div>
      </div>
    `;

    ui = {
      container: shadow.getElementById("reception-container"),
      signBtn: shadow.getElementById("signBtn"),
      analyzeBtn: shadow.getElementById("analyzeBtn"),
      signoutBtn: shadow.getElementById("signoutBtn"),
      statusEl: shadow.getElementById("status-message"),
      emailsEl: shadow.getElementById("email-list"),
    };

    ui.signBtn.addEventListener("click", handleSignIn);
    ui.signoutBtn.addEventListener("click", handleSignOut);
    ui.analyzeBtn.addEventListener("click", analyzeAndDisplayEmails);
  }

  // --- GMAIL PAGE INTEGRATION ---

  function toggleReceptionView(show) {
    const mainContent = document.querySelector('div[role="main"]');
    if (!mainContent) return;
    const receptionHost = ui.container?.getRootNode().host;
    if (!receptionHost) return;

    if (show) {
      Array.from(mainContent.children).forEach((child) => {
        if (child !== receptionHost) child.style.display = "none";
      });
      if (!mainContent.contains(receptionHost)) {
        mainContent.appendChild(receptionHost);
      }
      receptionHost.style.display = "block";
      ui.container.style.display = "flex";
    } else {
      Array.from(mainContent.children).forEach((child) => {
        child.style.display = "";
      });
      receptionHost.style.display = "none";
    }
  }

  /**
   * Watches the URL for changes. When the URL hash becomes "#reception",
   * it knows to show our extension's view.
   */
  function handleUrlChange() {
    const isReceptionActive = window.location.hash === "#reception";
    toggleReceptionView(isReceptionActive);

    const receptionButton = document.getElementById("reception-nav-button");
    if (receptionButton) {
      const innerDiv = receptionButton.querySelector(".reception-button-inner");
      const textSpan = receptionButton.querySelector(".reception-text");
      const iconSpan = receptionButton.querySelector(".reception-icon");
    }

    if (isReceptionActive) {
      const activeGmailButton = document.querySelector(".aDG");
      if (activeGmailButton) {
        activeGmailButton.classList.remove("nZ", "aDG");
      }
    }
  }
  function injectIconStylesheet() {
    const FONT_STYLESHEET_ID = "material-symbols-stylesheet";
    if (document.getElementById(FONT_STYLESHEET_ID)) {
      return;
    }
    const link = document.createElement("link");
    link.id = FONT_STYLESHEET_ID;
    link.rel = "stylesheet";
    link.href =
      "https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,1,0";
    document.head.appendChild(link);
  }

  /**
   * Finds the "Compose" button area in Gmail and inserts our "Reception"
   * button into the navigation panel. It runs on a timer to make sure it
   * always finds its place, even if Gmail loads slowly.
   */
  function injectReceptionButton() {
    const composeButtonContainer = document.querySelector(".aic");
    if (
      !composeButtonContainer ||
      document.getElementById("reception-nav-button")
    ) {
      return;
    }

    const parentContainer = composeButtonContainer.parentElement;
    if (!parentContainer) return;

    const receptionButton = document.createElement("div");
    receptionButton.id = "reception-nav-button";
    receptionButton.style.padding = "0 12px 0 4px";
    receptionButton.style.marginBottom = "8px";

    receptionButton.innerHTML = `
    <div class="reception-button-inner" 
         style="display: flex; 
                align-items: center; 
                height: 56px;
                padding: 0 24px 0 16px;
                background-color: #c2e7ff; 
                border-radius: 16px; 
                cursor: pointer; 
                font-family: 'Google Sans', Roboto, sans-serif; 
                box-shadow: 0 1px 2px 0 rgba(60,64,67,0.3), 0 1px 3px 1px rgba(60,64,67,0.15); 
                transition: all .2s;
                width: fit-content;"> 
      
      <span class="material-symbols-outlined reception-icon" 
            style="margin-right: 12px; 
                   font-size: 24px; 
                   color: #001d35; 
                   transition: all .2s;
                   font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24;">
          cognition
      </span>
      <span class="reception-text" style="color: #001d35; font-size: 14px; font-weight: 500;">Reception</span>
    </div>
  `;

    receptionButton.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (window.location.hash !== "#reception") {
        document
          .querySelectorAll(".TK .aDG")
          .forEach((el) => el.classList.remove("aDG", "nZ"));
        window.location.hash = "#reception";
      }
    });

    const innerButton = receptionButton.querySelector(
      ".reception-button-inner"
    );
    const defaultShadow =
      "0 1px 2px 0 rgba(60,64,67,0.3), 0 1px 3px 1px rgba(60,64,67,0.15)";
    const hoverShadow =
      "0 1px 3px 0 rgba(60,64,67,0.3), 0 4px 8px 3px rgba(60,64,67,0.15)";

    innerButton.addEventListener("mouseenter", () => {
      innerButton.style.boxShadow = hoverShadow;
    });

    innerButton.addEventListener("mouseleave", () => {
      innerButton.style.boxShadow = defaultShadow;
    });

    parentContainer.insertBefore(receptionButton, composeButtonContainer);
    handleUrlChange();
  }
  // --- INITIALIZATION ---
  function main() {
    injectIconStylesheet();
    setupUI();
    updateUIForState();
    window.addEventListener("hashchange", handleUrlChange);
    setInterval(injectReceptionButton, 500);
  }
  main();
})();
