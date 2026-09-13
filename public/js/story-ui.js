/**
 * Story UI — authoring and reading, shared by every client.
 *
 * The desktop page (index.html + utils.js/pm.js/chat.js) and the mobile page
 * (mobile.html + mobile.js) used to carry separate copies of the story editor
 * and the story viewer, so every change had to be made twice and the two had
 * already drifted apart (mobile had no clips, the desktop viewer could not
 * scroll a long story). Everything story-shaped now lives here and both
 * clients call into it:
 *
 *   StoryUI.openEditor({ partner })              - write a new story
 *   StoryUI.openEditor({ partner, story })       - edit an existing one
 *   StoryUI.openViewer(story)                    - read one
 *   StoryUI.renderStoryList(box, …)              - profile story lists
 *   StoryUI.renderPendingList(box, …)            - approvals waiting on you
 *   StoryUI.renderArchives(box, …)               - the public archives
 *   StoryUI.showApprovalPopup(payload)           - live approval request
 *
 * The editor keeps a draft (per conversation, and per story when editing) in
 * localStorage, guards against losing unsaved work, offers a real preview, and
 * can pick individual messages out of the conversation instead of dumping the
 * whole transcript into the textarea. Editing an approved story takes it back
 * to the partner for approval — the server enforces that, this only explains
 * it to the author.
 */
(function () {
  "use strict";

  const LIMITS = { title: 120, body: 20000, declineReason: 500 };
  const DRAFT_PREFIX = "mcf.story.draft.";
  const FONT_KEY = "mcf.story.fontScale";
  const SCRIPT_FONT = '"Great Vibes","Brush Script MT","Segoe Script","Lucida Handwriting",cursive';
  const BODY_FONT = 'Arial,Helvetica,sans-serif';

  /* ============================================================
     SMALL HELPERS
  ============================================================ */

  const $ = sel => document.querySelector(sel);

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function node(tag, props, children) {
    const el = document.createElement(tag);
    if (props) {
      Object.entries(props).forEach(([key, value]) => {
        if (value == null || value === false) return;
        if (key === "text") el.textContent = value;
        else if (key === "html") el.innerHTML = value;
        else if (key === "style") el.style.cssText = value;
        else if (key === "dataset") Object.assign(el.dataset, value);
        else el.setAttribute(key, value === true ? "" : value);
      });
    }
    (Array.isArray(children) ? children : children ? [children] : []).forEach(child => {
      if (child) el.appendChild(child);
    });
    return el;
  }

  function sessionUser() {
    try {
      if (typeof window.getSession === "function") {
        const s = window.getSession();
        if (s && (s.username || s.user)) return s.username || s.user;
      }
    } catch (err) { /* fall through to storage */ }

    try {
      const raw = JSON.parse(localStorage.getItem("currentUser") || "null");
      if (raw) return raw.username || raw.user || null;
    } catch (err) { /* not signed in */ }

    return null;
  }

  async function getJSON(url) {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    return res.json();
  }

  async function postJSON(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    });
    return res.json();
  }

  /** Brief self-dismissing notice, so the editor never needs a blocking alert. */
  function toast(message, kind) {
    if (!message) return;
    let host = document.getElementById("mcfStoryToast");
    if (!host) {
      host = node("div", { id: "mcfStoryToast" });
      document.body.appendChild(host);
    }
    const colors = {
      ok: "rgba(34,197,94,0.95)",
      error: "rgba(239,68,68,0.95)",
      info: "rgba(0,150,255,0.95)"
    };
    host.textContent = message;
    host.style.cssText =
      "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:100200;" +
      "padding:12px 18px;border-radius:10px;font:600 14px/1.4 " + BODY_FONT + ";" +
      "color:#fff;box-shadow:0 8px 28px rgba(0,0,0,0.45);max-width:90vw;text-align:center;" +
      "background:" + (colors[kind] || colors.info) + ";";
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { host.remove(); }, 3200);
  }

  function formatDate(value) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return "";
    return date.toLocaleDateString();
  }

  function formatTime(value) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return "";
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function plural(count, word) {
    return count === 1 ? `${count} ${word}` : `${count} ${word}s`;
  }

  /* ============================================================
     STORY TEXT FORMATTING
     A deliberately small subset of Markdown, rendered safely:
     **bold**, *italic*, > quote, --- scene break, ## heading, - list.
     The text is escaped first and formatting is applied to the escaped
     string, so a story can never inject markup into the page.
  ============================================================ */

  function inlineFormat(escaped) {
    return escaped
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
      .replace(/(^|[\s(>])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/(^|[\s(>])_([^_\n]+)_/g, "$1<em>$2</em>");
  }

  /** Render stored story text (which may contain the light markup) to HTML. */
  function renderStoryBody(text) {
    const source = String(text == null ? "" : text).replace(/\r\n?/g, "\n");
    if (!source.trim()) return "";

    const lines = source.split("\n");
    const out = [];
    let paragraph = [];
    let listOpen = false;
    let quoteOpen = false;

    const flushParagraph = () => {
      if (!paragraph.length) return;
      out.push("<p>" + inlineFormat(escapeHtml(paragraph.join("\n")).replace(/\n/g, "<br>")) + "</p>");
      paragraph = [];
    };
    const closeBlocks = () => {
      flushParagraph();
      if (listOpen) { out.push("</ul>"); listOpen = false; }
      if (quoteOpen) { out.push("</blockquote>"); quoteOpen = false; }
    };

    lines.forEach(raw => {
      const line = raw.replace(/\s+$/, "");

      if (!line.trim()) {
        closeBlocks();
        return;
      }

      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
        closeBlocks();
        out.push('<hr class="mcf-story-break">');
        return;
      }

      const heading = line.match(/^\s*#{2,3}\s+(.*)$/);
      if (heading) {
        closeBlocks();
        out.push("<h3 class=\"mcf-story-heading\">" + inlineFormat(escapeHtml(heading[1].trim())) + "</h3>");
        return;
      }

      const quote = line.match(/^\s*>\s?(.*)$/);
      if (quote) {
        flushParagraph();
        if (listOpen) { out.push("</ul>"); listOpen = false; }
        if (!quoteOpen) { out.push('<blockquote class="mcf-story-quote">'); quoteOpen = true; }
        out.push("<div>" + inlineFormat(escapeHtml(quote[1])) + "</div>");
        return;
      }

      if (quoteOpen) { out.push("</blockquote>"); quoteOpen = false; }

      const bullet = line.match(/^\s*[-*]\s+(.*)$/);
      if (bullet) {
        flushParagraph();
        if (!listOpen) { out.push("<ul>"); listOpen = true; }
        out.push("<li>" + inlineFormat(escapeHtml(bullet[1])) + "</li>");
        return;
      }

      if (listOpen) { out.push("</ul>"); listOpen = false; }
      paragraph.push(line);
    });

    closeBlocks();
    return out.join("");
  }

  /** Plain-text version of a story, for exports and social previews. */
  function storyAsPlainText(story) {
    const header = [
      story.title || "Untitled story",
      `by @${story.owner} with @${story.partner}`,
      story.approvedAt || story.createdAt ? formatDate(story.approvedAt || story.createdAt) : "",
      ""
    ].filter(line => line !== "").join("\n");

    return header + "\n" + String(story.story || "").trim() + "\n";
  }

  /* ============================================================
     PLAYER-AGNOSTIC CLIP SUPPORT
     The desktop page has createClipElement/uploadClipToServer from utils.js;
     the mobile bundle never got them. These are local equivalents so the
     editor behaves the same on both.
  ============================================================ */

  const CLIP_TYPES = new Set(["image/gif", "video/mp4", "video/webm"]);

  function isClipFile(file) {
    if (typeof window.isClipFile === "function") return window.isClipFile(file);
    return !!file && (CLIP_TYPES.has(file.type) || /\.gif$/i.test(file.name || ""));
  }

  function clipElement(clipUrl, clipType) {
    if (typeof window.createClipElement === "function") return window.createClipElement(clipUrl, clipType);

    const isGif = clipType === "gif";
    const el = document.createElement(isGif ? "img" : "video");
    el.src = clipUrl;
    el.className = "chat-clip mcf-story-clip";
    if (isGif) {
      el.alt = "GIF clip";
    } else {
      el.controls = true;
      el.playsInline = true;
      el.preload = "metadata";
    }
    return el;
  }

  async function uploadClip(file) {
    if (typeof window.uploadClipToServer === "function") return window.uploadClipToServer(file);

    const form = new FormData();
    form.append("clip", file);
    const res = await fetch("/api/upload-clip", { method: "POST", body: form });
    return res.json();
  }

  /* ============================================================
     DRAFTS
     Nothing is sent to the server until Save, so an accidental close or a
     refresh used to throw the whole story away. Drafts are kept per
     conversation (and per story while editing) in localStorage.
  ============================================================ */

  function draftKeyFor({ username, partner, storyId }) {
    return DRAFT_PREFIX + (storyId ? "edit." + storyId : username + "." + partner);
  }

  function readDraft(key) {
    try {
      const raw = JSON.parse(localStorage.getItem(key) || "null");
      if (!raw || !raw.updatedAt) return null;
      // Drafts older than a month are more clutter than help.
      if (Date.now() - new Date(raw.updatedAt).getTime() > 30 * 24 * 60 * 60 * 1000) return null;
      return raw;
    } catch (err) {
      return null;
    }
  }

  function writeDraft(key, draft) {
    try {
      localStorage.setItem(key, JSON.stringify({ ...draft, updatedAt: new Date().toISOString() }));
      return true;
    } catch (err) {
      // Quota or private mode — the editor keeps working, it just cannot
      // promise the draft will survive a reload.
      return false;
    }
  }

  function clearDraft(key) {
    try { localStorage.removeItem(key); } catch (err) { /* nothing to clear */ }
  }

  /* ============================================================
     TRANSCRIPT BUILDER
     Turns selected DM rows into story-ready text.
  ============================================================ */

  /**
   * @param {Array} messages DM rows, oldest first.
   * @param {Object} opts
   *   me          - the author's username ("me" / "them" grouping)
   *   style       - "script" (dialogue lines) | "log" (timestamped log)
   *   timestamps  - prefix each line with its time
   *   sceneBreaks - blank line whenever the speaker changes
   *   aliases     - { username: "Character name" }
   */
  function formatTranscript(messages, opts) {
    const options = opts || {};
    const aliases = options.aliases || {};
    const style = options.style === "log" ? "log" : "script";
    const nameFor = user => (aliases[user] && String(aliases[user]).trim()) || user;

    const lines = [];
    let lastSpeaker = null;

    (messages || []).forEach(message => {
      const who = nameFor(message.from || "");
      const body = String(message.text || "").trim()
        || (message.clipUrl ? "(clip)" : message.imageUrl ? "(image)" : "");
      if (!body) return;

      if (style === "log") {
        const stamp = message.time ? new Date(message.time).toLocaleString() : "";
        lines.push(`${stamp ? `[${stamp}] ` : ""}${who}: ${body}`);
        return;
      }

      if (options.sceneBreaks && lastSpeaker && lastSpeaker !== who) lines.push("");
      if (options.timestamps && message.time) {
        lines.push(`> ${formatTime(message.time)} — **${who}:** ${body}`);
      } else {
        lines.push(`**${who}:** ${body}`);
      }
      lastSpeaker = who;
    });

    return lines.join("\n").trim();
  }

  /* ============================================================
     SHARED STYLES (injected once)
  ============================================================ */

  function ensureStyles() {
    if (document.getElementById("mcfStoryStyles")) return;

    const style = node("style", { id: "mcfStoryStyles" });
    style.textContent = `
      .mcf-story-backdrop{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;
        padding:16px;z-index:10050;background:rgba(0,0,0,.72);backdrop-filter:blur(4px);box-sizing:border-box}
      .mcf-story-panel{background:#111;border:1px solid rgba(0,150,255,.4);border-radius:14px;color:#fff;
        width:760px;max-width:100%;max-height:92vh;display:flex;flex-direction:column;
        box-shadow:0 0 30px rgba(0,150,255,.28);font-family:${BODY_FONT};overflow:hidden}
      .mcf-story-head{display:flex;align-items:center;gap:10px;padding:16px 18px;border-bottom:1px solid rgba(255,255,255,.08)}
      .mcf-story-head h2{margin:0;font-size:19px;flex:1;font-family:${BODY_FONT}}
      .mcf-story-body{padding:16px 18px;overflow-y:auto;flex:1;-webkit-overflow-scrolling:touch}
      .mcf-story-foot{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;padding:14px 18px;
        border-top:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.02)}
      .mcf-story-field{margin-bottom:14px}
      .mcf-story-field label{display:block;font-size:12px;font-weight:700;letter-spacing:.03em;
        text-transform:uppercase;color:#8fb6d8;margin-bottom:6px}
      .mcf-story-input,.mcf-story-textarea,.mcf-story-select{width:100%;box-sizing:border-box;background:#0b1220;
        border:1px solid rgba(0,150,255,.35);border-radius:9px;color:#fff;padding:10px 12px;font-family:${BODY_FONT};font-size:14px}
      .mcf-story-textarea{min-height:280px;line-height:1.6;resize:vertical;white-space:pre-wrap}
      .mcf-story-input:focus,.mcf-story-textarea:focus,.mcf-story-select:focus{outline:none;border-color:#00aaff;
        box-shadow:0 0 0 2px rgba(0,170,255,.25)}
      .mcf-story-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
      .mcf-story-btn{background:#0b1220;border:1px solid rgba(0,150,255,.4);color:#dcecff;border-radius:9px;
        padding:9px 14px;font:700 13px ${BODY_FONT};cursor:pointer;white-space:nowrap}
      .mcf-story-btn:hover:not(:disabled){border-color:#00aaff;color:#fff}
      .mcf-story-btn:disabled{opacity:.45;cursor:not-allowed}
      .mcf-story-btn.primary{background:#0072c6;border-color:#00aaff;color:#fff}
      .mcf-story-btn.danger{border-color:rgba(239,68,68,.55);color:#ffd7d7}
      .mcf-story-btn.ghost{background:transparent}
      .mcf-story-icon{width:34px;height:34px;padding:0;display:inline-flex;align-items:center;justify-content:center;font-size:15px}
      .mcf-story-meta{font-size:12px;color:#9fb3c8;margin-top:6px;display:flex;gap:10px;flex-wrap:wrap;align-items:center}
      .mcf-story-warn{color:#ffcf66}
      .mcf-story-chip{display:inline-flex;align-items:center;gap:6px;background:rgba(0,150,255,.14);
        border:1px solid rgba(0,150,255,.4);border-radius:999px;padding:3px 10px;font-size:11px;color:#bfe2ff}
      .mcf-story-banner{background:rgba(0,150,255,.12);border:1px solid rgba(0,150,255,.4);border-radius:10px;
        padding:10px 12px;margin-bottom:14px;font-size:13px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
      .mcf-story-banner .grow{flex:1}
      .mcf-story-picker{border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:12px;margin-bottom:14px;
        background:rgba(255,255,255,.02)}
      .mcf-story-messages{max-height:260px;overflow-y:auto;border:1px solid rgba(255,255,255,.1);border-radius:9px;
        margin-top:10px;background:#0b1220}
      .mcf-story-msg{display:flex;gap:10px;padding:8px 10px;border-bottom:1px solid rgba(255,255,255,.06);font-size:13px}
      .mcf-story-msg:last-child{border-bottom:none}
      .mcf-story-msg input{margin-top:3px}
      .mcf-story-msg .who{font-weight:700;color:#bfe2ff;white-space:nowrap}
      .mcf-story-msg .txt{flex:1;color:#e8f1fa;word-break:break-word;white-space:pre-wrap}
      .mcf-story-msg .when{color:#8aa0b6;font-size:11px;white-space:nowrap}
      .mcf-story-empty{color:#8aa0b6;font-size:13px;padding:10px}
      /* viewer */
      .mcf-story-viewer{background:#111;border:1px solid rgba(0,150,255,.4);border-radius:14px;color:#fff;
        width:720px;max-width:100%;max-height:92vh;display:flex;flex-direction:column;
        box-shadow:0 0 28px rgba(0,150,255,.35);overflow:hidden;font-family:${BODY_FONT}}
      .mcf-story-viewer-head{padding:20px 22px 12px;border-bottom:1px solid rgba(255,255,255,.08);position:relative}
      .mcf-story-viewer-title{font-family:${SCRIPT_FONT};font-size:40px;line-height:1.2;color:#00aaff;
        margin:0 34px 8px 0;word-break:break-word}
      .mcf-story-viewer-tools{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
      .mcf-story-scroll{overflow-y:auto;padding:18px 22px;-webkit-overflow-scrolling:touch}
      .mcf-story-scroll p{margin:0 0 14px;line-height:1.75;white-space:pre-wrap;word-break:break-word;color:#f2f7fb}
      .mcf-story-scroll .mcf-story-quote{border-left:3px solid rgba(0,150,255,.55);margin:0 0 14px;
        padding:4px 0 4px 12px;color:#cfe6fb;font-style:italic}
      .mcf-story-scroll ul{margin:0 0 14px;padding-left:22px;line-height:1.7}
      .mcf-story-scroll h3.mcf-story-heading{font-size:19px;margin:6px 0 12px;color:#9fd2ff}
      .mcf-story-break{border:none;border-top:1px solid rgba(255,255,255,.18);margin:18px auto;width:60%}
      .mcf-story-clip{max-width:100%;max-height:38vh;border-radius:10px;display:block;margin:0 auto 16px;background:#000}
      .mcf-story-viewer-foot{display:flex;gap:8px;flex-wrap:wrap;justify-content:space-between;align-items:center;
        padding:12px 18px;border-top:1px solid rgba(255,255,255,.08)}
      .mcf-story-item{border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:10px 12px;margin-bottom:8px;
        background:rgba(255,255,255,.02)}
      .mcf-story-item .title{font-weight:700;cursor:pointer}
      .mcf-story-item .title:hover{color:#9fd2ff}
      .mcf-story-item .sub{font-size:12px;color:#9fb3c8;margin-top:3px}
      .mcf-story-item .acts{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
      .mcf-story-item.declined{border-color:rgba(239,68,68,.45)}
      .mcf-story-item.pending{border-color:rgba(255,207,102,.4)}
      .mcf-story-item button{font:700 12px ${BODY_FONT}}
      .mcf-story-toolbar{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}
      @media (max-width:600px){
        .mcf-story-viewer-title{font-size:30px}
        .mcf-story-textarea{min-height:200px}
        .mcf-story-panel,.mcf-story-viewer{max-height:96vh;border-radius:12px}
        .mcf-story-head,.mcf-story-body,.mcf-story-foot{padding-left:12px;padding-right:12px}
      }
    `;
    document.head.appendChild(style);
  }

  function backdrop(id) {
    ensureStyles();
    const existing = id ? document.getElementById(id) : null;
    if (existing) existing.remove();

    const host = node("div", { class: "mcf-story-backdrop", id });
    const closeOnBackdrop = event => { if (event.target === host) host._requestClose?.(); };
    host.addEventListener("click", closeOnBackdrop);
    document.body.appendChild(host);
    return host;
  }

  /** Reuse the page's #storyPopup shell when it exists, so CSS/animation apply. */
  function mountPoint(preferredId) {
    const existing = preferredId ? document.getElementById(preferredId) : null;
    if (existing) {
      existing.innerHTML = "";
      existing.className = "mcf-story-backdrop";
      existing.style.cssText = "";
      document.body.appendChild(existing);
      return existing;
    }
    return backdrop(preferredId || "mcfStoryHost");
  }

  function unmount(host) {
    host.style.display = "none";
    host.innerHTML = "";
  }

  /* ============================================================
     READING: the story viewer
  ============================================================ */

  let readingList = [];
  let readingIndex = -1;

  function setReadingList(stories, currentId) {
    readingList = Array.isArray(stories) ? stories.filter(Boolean) : [];
    readingIndex = currentId ? readingList.findIndex(s => String(s._id) === String(currentId)) : -1;
  }

  function storyTitle(story) {
    const other = story && story.owner ? story.partner : "";
    return (story && story.title) || (other ? `Story with ${other}` : "Untitled story");
  }

  /** Accept both the new object form and the legacy positional arguments. */
  function normalizeStory(a, b, c, d) {
    if (a && typeof a === "object") return { ...a };
    return { title: a, story: b, clipUrl: c, clipType: d };
  }

  function permalinkFor(story) {
    if (story && story._id) return `${location.origin}/story/${story._id}`;
    return location.href;
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (err) { /* fall back below */ }

    try {
      const field = node("textarea", { style: "position:fixed;top:-1000px" });
      field.value = text;
      document.body.appendChild(field);
      field.select();
      const ok = document.execCommand && document.execCommand("copy");
      field.remove();
      return !!ok;
    } catch (err) {
      return false;
    }
  }

  function downloadStory(story) {
    const blob = new Blob([storyAsPlainText(story)], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = node("a", {
      href: url,
      download: `${(story.title || "story").replace(/[^\w\s-]/g, "").trim().slice(0, 60) || "story"}.md`
    });
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function printStory(story) {
    const win = window.open("", "_blank", "width=720,height=900");
    if (!win) {
      toast("Allow pop-ups to print a story", "error");
      return;
    }
    win.document.write(
      `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(storyTitle(story))}</title>` +
      `<style>body{font-family:Georgia,serif;line-height:1.7;max-width:640px;margin:40px auto;padding:0 16px;color:#111}` +
      `h1{font-size:28px;margin-bottom:4px}.by{color:#555;font-size:14px;margin-bottom:24px}` +
      `blockquote{border-left:3px solid #ccc;margin:0 0 14px;padding-left:12px;color:#444}` +
      `hr{border:none;border-top:1px solid #ddd;margin:22px auto;width:50%}</style></head><body>` +
      `<h1>${escapeHtml(storyTitle(story))}</h1>` +
      `<div class="by">@${escapeHtml(story.owner || "")} with @${escapeHtml(story.partner || "")} · ${escapeHtml(formatDate(story.approvedAt || story.createdAt))}</div>` +
      renderStoryBody(story.story) +
      "</body></html>"
    );
    win.document.close();
    win.focus();
    win.print();
  }

  function fontSize() {
    const stored = Number(localStorage.getItem(FONT_KEY));
    return Number.isFinite(stored) && stored > 0 ? Math.min(Math.max(stored, 0.8), 1.8) : 1;
  }

  function stepFontSize(delta) {
    const next = Math.round((fontSize() + delta) * 10) / 10;
    const clamped = Math.min(Math.max(next, 0.8), 1.8);
    try { localStorage.setItem(FONT_KEY, String(clamped)); } catch (err) { /* ignore */ }
    return clamped;
  }

  function openViewer(a, b, c, d) {
    const story = normalizeStory(a, b, c, d);

    // Legacy callers (profile lists) pass a title whose story may sit in the
    // current reading list; matching it lets Share hand out a real link.
    if (!story._id && readingList.length) {
      const match = readingList.find(s => storyTitle(s) === story.title);
      if (match) Object.assign(story, { _id: match._id, owner: match.owner, partner: match.partner });
    }

    document.getElementById("storyViewerPopup")?.remove();

    const host = backdrop("storyViewerPopup");
    host.id = "storyViewerPopup";

    const titleEl = node("h2", { class: "mcf-story-viewer-title", text: storyTitle(story) });

    const byline = node("div", { class: "mcf-story-meta" });
    if (story.owner) byline.appendChild(node("span", { text: `@${story.owner} with @${story.partner || "—"}` }));
    const when = formatDate(story.approvedAt || story.updatedAt || story.createdAt);
    if (when) byline.appendChild(node("span", { text: when }));
    if (Number(story.revision) > 0) {
      byline.appendChild(node("span", { class: "mcf-story-chip", text: `revised ${plural(Number(story.revision), "time")}` }));
    }
    if (story.declined) byline.appendChild(node("span", { class: "mcf-story-chip", text: "awaiting re-approval" }));

    const closeBtn = node("button", { class: "mcf-story-btn ghost mcf-story-icon", title: "Close", text: "✕" });
    const head = node("div", { class: "mcf-story-viewer-head" }, [
      titleEl,
      byline,
      closeBtn
    ]);
    closeBtn.style.cssText = "position:absolute;top:14px;right:14px";

    const tools = node("div", { class: "mcf-story-viewer-tools" });

    const fontDown = node("button", { class: "mcf-story-btn ghost mcf-story-icon", title: "Smaller text", text: "A-" });
    const fontUp = node("button", { class: "mcf-story-btn ghost mcf-story-icon", title: "Larger text", text: "A+" });
    tools.append(fontDown, fontUp);

    const prevBtn = node("button", { class: "mcf-story-btn ghost", title: "Previous story", text: "‹ Prev", "data-mcf": "viewer-prev" });
    const nextBtn = node("button", { class: "mcf-story-btn ghost", title: "Next story", text: "Next ›", "data-mcf": "viewer-next" });
    tools.append(prevBtn, nextBtn);

    const shareBtn = node("button", { class: "mcf-story-btn ghost", text: "🔗 Copy link", "data-mcf": "viewer-share" });
    const exportBtn = node("button", { class: "mcf-story-btn ghost", text: "⤓ Export", "data-mcf": "viewer-export" });
    const printBtn = node("button", { class: "mcf-story-btn ghost", text: "🖨 Print", "data-mcf": "viewer-print" });
    tools.append(shareBtn, exportBtn, printBtn);

    const scroll = node("div", { class: "mcf-story-scroll", "data-mcf": "viewer-body" });

    if (story.clipUrl) scroll.appendChild(clipElement(story.clipUrl, story.clipType));

    const body = node("div", { class: "mcf-story-body-block" });
    const rendered = renderStoryBody(story.story);
    if (rendered) body.innerHTML = rendered;
    else body.appendChild(node("div", { class: "mcf-story-empty", text: "This story is empty." }));
    scroll.appendChild(body);

    const applyFont = () => { body.style.fontSize = (15 * fontSize()).toFixed(1) + "px"; };
    applyFont();

    fontDown.onclick = () => { stepFontSize(-0.1); applyFont(); };
    fontUp.onclick = () => { stepFontSize(0.1); applyFont(); };

    const index = story._id ? readingList.findIndex(s => String(s._id) === String(story._id)) : readingIndex;
    if (index >= 0) readingIndex = index;
    const canStep = readingList.length > 1 && readingIndex >= 0;
    if (!canStep) {
      prevBtn.disabled = true;
      nextBtn.disabled = true;
    } else {
      prevBtn.disabled = readingIndex <= 0;
      nextBtn.disabled = readingIndex >= readingList.length - 1;
    }

    const foot = node("div", { class: "mcf-story-viewer-foot" });
    const footLeft = node("div", { class: "mcf-story-meta" });
    if (canStep) footLeft.appendChild(node("span", { text: `Story ${readingIndex + 1} of ${readingList.length}` }));

    const footRight = node("div", { class: "mcf-story-row" });
    const closeFoot = node("button", { class: "mcf-story-btn primary", text: "Close" });
    footRight.appendChild(closeFoot);
    foot.append(footLeft, footRight);

    const panel = node("div", { class: "mcf-story-viewer" }, [head, tools, scroll, foot]);
    tools.style.cssText = "padding:10px 18px;border-bottom:1px solid rgba(255,255,255,.06)";
    host.appendChild(panel);

    const close = () => {
      document.removeEventListener("keydown", onKey);
      host.remove();
    };
    host._requestClose = close;
    closeBtn.onclick = close;
    closeFoot.onclick = close;

    shareBtn.onclick = async () => {
      const link = permalinkFor(story);
      const ok = await copyText(link);
      toast(ok ? "Link copied — paste it anywhere" : link, ok ? "ok" : "info");
    };

    exportBtn.onclick = () => downloadStory(story);
    printBtn.onclick = () => printStory(story);

    const step = delta => {
      const next = readingIndex + delta;
      if (next < 0 || next >= readingList.length) return;
      openViewer(readingList[next]);
    };
    prevBtn.onclick = () => step(-1);
    nextBtn.onclick = () => step(1);

    const onKey = event => {
      if (event.key === "Escape") close();
      else if (event.key === "ArrowLeft" && canStep) step(-1);
      else if (event.key === "ArrowRight" && canStep) step(1);
    };
    document.addEventListener("keydown", onKey);

    return host;
  }

  /* ============================================================
     WRITING: the editor
  ============================================================ */

  function openEditor(options) {
    const config = options || {};
    const username = config.username || sessionUser();
    const partner = config.partner || (config.story ? (config.story.owner === username ? config.story.partner : config.story.owner) : null);
    const existing = config.story || null;

    if (!username || !partner) {
      toast("Sign in to write a story", "error");
      return null;
    }

    ensureStyles();
    const host = mountPoint("storyPopup");
    host.style.cssText = "";
    host.className = "mcf-story-backdrop";
    host.style.display = "flex";

    const isEdit = !!existing;
    const draftKey = draftKeyFor({ username, partner, storyId: isEdit ? existing._id : null });
    const state = {
      dirty: false,
      saved: false,
      clip: existing && existing.clipUrl ? { url: existing.clipUrl, type: existing.clipType } : null,
      pickerOpen: false,
      messages: [],
      loadedRange: null,
      aliases: {}
    };

    const titleInput = node("input", {
      class: "mcf-story-input",
      id: "storyTitle",
      type: "text",
      maxlength: String(LIMITS.title),
      placeholder: "Name this story",
      "data-mcf": "title"
    });
    if (existing) titleInput.value = existing.title || "";

    const bodyInput = node("textarea", {
      class: "mcf-story-textarea",
      id: "storyEditor",
      placeholder: "Write the story here, or load messages below and turn them into one…",
      "data-mcf": "body"
    });
    if (existing) bodyInput.value = existing.story || "";

    const counter = node("div", { class: "mcf-story-meta", "data-mcf": "counter" });
    const draftStatus = node("span", { class: "mcf-story-meta" });

    const updateCounter = () => {
      const chars = bodyInput.value.length;
      const words = bodyInput.value.trim() ? bodyInput.value.trim().split(/\s+/).length : 0;
      const over = chars > LIMITS.body;
      counter.innerHTML =
        `<span class="${over ? "mcf-story-warn" : ""}">${chars.toLocaleString()} / ${LIMITS.body.toLocaleString()} characters</span>` +
        `<span>${plural(words, "word")}</span>` +
        `<span>${plural(Math.max(1, Math.ceil(words / 200)), "minute")} read</span>`;
      return !over;
    };

    /* ---------- draft ---------- */
    const draftPayload = () => ({
      title: titleInput.value,
      story: bodyInput.value,
      aliases: state.aliases,
      clip: state.clip,
      storyId: existing ? existing._id : null,
      partner,
      username
    });

    let draftTimer = null;
    const saveDraftSoon = () => {
      clearTimeout(draftTimer);
      draftTimer = setTimeout(() => {
        if (!state.dirty) return;
        if (writeDraft(draftKey, draftPayload())) {
          draftStatus.textContent = `Draft saved ${formatTime(new Date())}`;
        }
      }, 1200);
    };

    const markDirty = () => {
      state.dirty = true;
      updateCounter();
      saveDraftSoon();
    };

    titleInput.addEventListener("input", markDirty);
    bodyInput.addEventListener("input", markDirty);

    /* ---------- toolbar ---------- */
    const surround = (before, after) => {
      const start = bodyInput.selectionStart;
      const end = bodyInput.selectionEnd;
      const selected = bodyInput.value.slice(start, end);
      const insertion = before + (selected || "text") + (after == null ? before : after);
      bodyInput.value = bodyInput.value.slice(0, start) + insertion + bodyInput.value.slice(end);
      const cursor = start + before.length;
      bodyInput.focus();
      bodyInput.setSelectionRange(cursor, cursor + (selected || "text").length);
      markDirty();
    };

    const insertLine = prefix => {
      const start = bodyInput.selectionStart;
      const before = bodyInput.value.slice(0, start);
      const needsBreak = before && !/\n\n$/.test(before);
      const glue = needsBreak ? (before.endsWith("\n") ? "\n" : "\n\n") : "";
      const insertion = glue + prefix;
      bodyInput.value = before + insertion + bodyInput.value.slice(start);
      bodyInput.focus();
      bodyInput.setSelectionRange(before.length + insertion.length, before.length + insertion.length);
      markDirty();
    };

    const toolbar = node("div", { class: "mcf-story-toolbar", "data-mcf": "toolbar" });
    const tool = (label, title, handler) => {
      const btn = node("button", { class: "mcf-story-btn ghost", type: "button", title, text: label });
      btn.onclick = handler;
      return btn;
    };
    toolbar.append(
      tool("B", "Bold (Ctrl+B)", () => surround("**")),
      tool("I", "Italic (Ctrl+I)", () => surround("*")),
      tool("❝", "Quoted speech", () => insertLine("> ")),
      tool("¶", "Chapter heading", () => insertLine("## ")),
      tool("—", "Scene break", () => insertLine("---\n"))
    );

    /* ---------- clip ---------- */
    const clipInput = node("input", {
      type: "file",
      accept: "image/gif,video/mp4,video/webm",
      style: "display:none",
      "data-mcf": "clip-input"
    });
    const clipChoose = node("button", { class: "mcf-story-btn ghost", type: "button", text: "🎬 Attach GIF / clip", "data-mcf": "clip-choose" });
    const clipClear = node("button", { class: "mcf-story-btn ghost", type: "button", text: "Remove clip", style: "display:none" });
    const clipStatus = node("span", { class: "mcf-story-meta" });
    const clipPreview = node("div", { "data-mcf": "clip-preview" });

    const renderClip = () => {
      clipPreview.innerHTML = "";
      clipClear.style.display = state.clip ? "inline-block" : "none";
      if (state.clip) clipPreview.appendChild(clipElement(state.clip.url, state.clip.type));
    };
    renderClip();

    clipChoose.onclick = () => clipInput.click();
    clipClear.onclick = () => {
      state.clip = null;
      clipStatus.textContent = "Clip removed";
      renderClip();
      markDirty();
    };

    clipInput.addEventListener("change", async event => {
      const file = event.target.files[0];
      event.target.value = "";
      if (!file) return;
      if (!isClipFile(file)) {
        clipStatus.textContent = "Unsupported file — use a GIF, MP4 or WebM";
        return;
      }

      clipStatus.textContent = "Uploading…";
      clipChoose.disabled = true;
      const data = await uploadClip(file);
      clipChoose.disabled = false;

      if (!data || !data.ok) {
        clipStatus.textContent = data && data.error === "file_too_large"
          ? "Clip is too large (max 25 MB for GIFs, 50 MB for videos)"
          : "Clip upload failed";
        return;
      }

      state.clip = { url: data.clipUrl, type: data.clipType };
      clipStatus.textContent = `✓ ${file.name}`;
      renderClip();
      markDirty();
    });

    /* ---------- message picker ---------- */
    const fromDate = node("input", { class: "mcf-story-input", type: "date", id: "storyDate" });
    const toDate = node("input", { class: "mcf-story-input", type: "date" });
    const pickerSearch = node("input", { class: "mcf-story-input", type: "search", placeholder: "Filter by text or name" });
    const speaker = node("select", { class: "mcf-story-select" });
    speaker.appendChild(node("option", { value: "all", text: "Everyone" }));
    speaker.appendChild(node("option", { value: "me", text: `Only @${username}` }));
    speaker.appendChild(node("option", { value: "them", text: `Only @${partner}` }));

    const styleSelect = node("select", { class: "mcf-story-select" });
    styleSelect.appendChild(node("option", { value: "script", text: "Script — **Name:** dialogue" }));
    styleSelect.appendChild(node("option", { value: "log", text: "Log — [time] Name: message" }));

    const timestampsToggle = node("input", { type: "checkbox" });
    const sceneToggle = node("input", { type: "checkbox" });
    sceneToggle.checked = true;

    const aliasMe = node("input", { class: "mcf-story-input", type: "text", placeholder: `Character name for @${username}` });
    const aliasThem = node("input", { class: "mcf-story-input", type: "text", placeholder: `Character name for @${partner}` });
    const renameInStory = node("button", { class: "mcf-story-btn ghost", type: "button", text: "Rename in story" });

    const messageList = node("div", { class: "mcf-story-messages", "data-mcf": "messages" });
    const loadBtn = node("button", { class: "mcf-story-btn", type: "button", text: "Load messages", "data-mcf": "load-messages" });
    const picker = node("div", { class: "mcf-story-picker", "data-mcf": "picker", style: "display:none" });

    const selectedMessages = () => state.messages.filter((m, i) => {
      const box = messageList.querySelector(`input[data-i="${i}"]`);
      return box && box.checked;
    });

    const visibleMessages = () => {
      const term = pickerSearch.value.trim().toLowerCase();
      const who = speaker.value;
      return state.messages
        .map((m, index) => ({ m, index }))
        .filter(({ m }) => {
          if (who === "me" && m.from !== username) return false;
          if (who === "them" && m.from !== partner) return false;
          if (!term) return true;
          return String(m.text || "").toLowerCase().includes(term)
            || String(m.from || "").toLowerCase().includes(term);
        });
    };

    const renderMessages = () => {
      messageList.innerHTML = "";
      const rows = visibleMessages();

      if (!state.messages.length) {
        messageList.appendChild(node("div", { class: "mcf-story-empty", text: "No messages loaded yet — pick a date range and press Load messages." }));
        return;
      }
      if (!rows.length) {
        messageList.appendChild(node("div", { class: "mcf-story-empty", text: "Nothing matches that filter." }));
        return;
      }

      rows.forEach(({ m, index }) => {
        const box = node("input", { type: "checkbox" });
        box.dataset.i = String(index);
        const row = node("label", { class: "mcf-story-msg", "data-mcf": "message" }, [
          box,
          node("span", { class: "when", text: formatTime(m.time) }),
          node("span", { class: "who", text: m.from || "" }),
          node("span", { class: "txt", text: String(m.text || (m.clipUrl ? "(clip)" : m.imageUrl ? "(image)" : "")).slice(0, 400) })
        ]);
        messageList.appendChild(row);
      });
    };

    const loadMessages = async () => {
      if (!fromDate.value) {
        toast("Choose a start date first", "error");
        return;
      }

      loadBtn.disabled = true;
      loadBtn.textContent = "Loading…";
      try {
        const data = await postJSON("/api/story/load", {
          a: username,
          b: partner,
          requester: username,
          fromDate: fromDate.value,
          toDate: toDate.value || undefined
        });

        if (!data || !data.ok) {
          toast(data && data.error === "not_participant"
            ? "You can only build a story from your own conversations"
            : "Could not load those messages", "error");
          return;
        }

        state.messages = data.messages || [];
        state.loadedRange = { from: fromDate.value, to: toDate.value || null };
        renderMessages();
        toast(`Loaded ${plural(state.messages.length, "message")}${data.truncated ? " (most recent)" : ""}`, "info");
      } finally {
        loadBtn.disabled = false;
        loadBtn.textContent = "Load messages";
      }
    };

    const aliasesFromInputs = () => {
      const aliases = {};
      if (aliasMe.value.trim()) aliases[username] = aliasMe.value.trim();
      if (aliasThem.value.trim()) aliases[partner] = aliasThem.value.trim();
      state.aliases = aliases;
      return aliases;
    };

    [aliasMe, aliasThem].forEach(input => input.addEventListener("input", () => {
      aliasesFromInputs();
      if (state.dirty) saveDraftSoon();
    }));

    renameInStory.onclick = () => {
      const aliases = aliasesFromInputs();
      let text = bodyInput.value;
      Object.entries(aliases).forEach(([from, to]) => {
        text = text.replace(new RegExp(`@?${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g"), to);
      });
      if (text === bodyInput.value) {
        toast("Add a character name first", "info");
        return;
      }
      bodyInput.value = text;
      markDirty();
      toast("Names replaced in the story", "ok");
    };

    const insertSelected = (mode) => {
      const picked = selectedMessages();
      if (!picked.length) {
        toast("Tick the messages you want", "error");
        return;
      }

      const block = formatTranscript(picked, {
        style: styleSelect.value,
        timestamps: timestampsToggle.checked,
        sceneBreaks: sceneToggle.checked,
        aliases: aliasesFromInputs()
      });

      if (mode === "replace") {
        if (bodyInput.value.trim() && !confirm("Replace everything written so far with the selected messages?")) return;
        bodyInput.value = block;
      } else {
        const start = bodyInput.selectionStart;
        const before = bodyInput.value.slice(0, start);
        const after = bodyInput.value.slice(start);
        const glue = before.trim() ? (before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n") : "";
        const tail = after.trim() ? "\n\n" : "";
        bodyInput.value = before + glue + block + tail + after;
        bodyInput.setSelectionRange((before + glue + block).length, (before + glue + block).length);
      }

      markDirty();
      toast(`Added ${plural(picked.length, "message")} to the story`, "ok");
    };

    const pickerActions = node("div", { class: "mcf-story-row", style: "margin-top:10px" }, [
      node("button", { class: "mcf-story-btn primary", type: "button", text: "Add to story", "data-mcf": "insert" }),
      node("button", { class: "mcf-story-btn", type: "button", text: "Replace story" }),
      node("button", { class: "mcf-story-btn ghost", type: "button", text: "Select all" }),
      node("button", { class: "mcf-story-btn ghost", type: "button", text: "Select none" }),
      node("button", { class: "mcf-story-btn ghost", type: "button", text: "Invert" }),
      renameInStory
    ]);

    const [addToStory, replaceStory, selectAll, selectNone, invert] = pickerActions.querySelectorAll("button");
    addToStory.onclick = () => insertSelected("append");
    replaceStory.onclick = () => insertSelected("replace");
    selectAll.onclick = () => messageList.querySelectorAll("input").forEach(box => { box.checked = true; });
    selectNone.onclick = () => messageList.querySelectorAll("input").forEach(box => { box.checked = false; });
    invert.onclick = () => messageList.querySelectorAll("input").forEach(box => { box.checked = !box.checked; });

    const toggle = (label, input) => node("label", { class: "mcf-story-meta" }, [input, node("span", { text: label })]);

    picker.append(
      node("div", { class: "mcf-story-field" }, [
        node("label", { text: "Conversation window" }),
        node("div", { class: "mcf-story-row" }, [
          node("div", { style: "flex:1;min-width:140px" }, [fromDate]),
          node("div", { style: "flex:1;min-width:140px" }, [toDate]),
          loadBtn
        ])
      ]),
      node("div", { class: "mcf-story-row", style: "margin-bottom:10px" }, [
        node("div", { style: "flex:2;min-width:160px" }, [pickerSearch]),
        node("div", { style: "flex:1;min-width:130px" }, [speaker]),
        node("div", { style: "flex:1;min-width:150px" }, [styleSelect])
      ]),
      node("div", { class: "mcf-story-row" }, [
        toggle("Add timestamps", timestampsToggle),
        toggle("Blank line when the speaker changes", sceneToggle)
      ]),
      node("div", { class: "mcf-story-field", style: "margin-top:12px" }, [
        node("label", { text: "Character names (optional — used when adding lines)" }),
        node("div", { class: "mcf-story-row" }, [aliasMe, aliasThem])
      ]),
      messageList,
      pickerActions
    );

    const loadToggle = node("button", { class: "mcf-story-btn", type: "button", text: "📥 Build from messages", "data-mcf": "toggle-picker" });
    loadToggle.onclick = () => {
      state.pickerOpen = !state.pickerOpen;
      picker.style.display = state.pickerOpen ? "block" : "none";
      loadToggle.textContent = state.pickerOpen ? "Hide message picker" : "📥 Build from messages";
    };

    /* ---------- draft banner ---------- */
    const draftBanner = node("div", { class: "mcf-story-banner", "data-mcf": "draft-banner", style: "display:none" });
    const storedDraft = readDraft(draftKey);
    if (storedDraft) {
      const restoredValue = { title: storedDraft.title || "", story: storedDraft.story || "" };
      const differs = restoredValue.story.trim() !== bodyInput.value.trim()
        || restoredValue.title.trim() !== titleInput.value.trim();

      if (differs) {
        draftBanner.appendChild(node("span", {
          class: "grow",
          text: `Unsaved draft from ${formatDate(storedDraft.updatedAt)} ${formatTime(storedDraft.updatedAt)}`
        }));
        const restore = node("button", { class: "mcf-story-btn primary", type: "button", text: "Restore draft", "data-mcf": "restore-draft" });
        const discard = node("button", { class: "mcf-story-btn ghost", type: "button", text: "Discard", "data-mcf": "discard-draft" });
        restore.onclick = () => {
          titleInput.value = restoredValue.title;
          bodyInput.value = restoredValue.story;
          if (storedDraft.clip) { state.clip = storedDraft.clip; renderClip(); }
          if (storedDraft.aliases) {
            state.aliases = storedDraft.aliases;
            if (storedDraft.aliases[username]) aliasMe.value = storedDraft.aliases[username];
            if (storedDraft.aliases[partner]) aliasThem.value = storedDraft.aliases[partner];
          }
          state.dirty = true;
          updateCounter();
          draftBanner.style.display = "none";
          toast("Draft restored", "ok");
        };
        discard.onclick = () => {
          clearDraft(draftKey);
          draftBanner.style.display = "none";
        };
        draftBanner.append(restore, discard);
        draftBanner.style.display = "flex";
      }
    }

    /* ---------- save / delete / close ---------- */
    const saveBtn = node("button", { class: "mcf-story-btn primary", type: "button", text: isEdit ? "Save changes" : "Save story", "data-mcf": "save" });
    const previewBtn = node("button", { class: "mcf-story-btn ghost", type: "button", text: "👁 Preview", "data-mcf": "preview" });
    const deleteBtn = isEdit
      ? node("button", { class: "mcf-story-btn danger", type: "button", text: "Delete story", "data-mcf": "delete" })
      : null;
    const closeBtn = node("button", { class: "mcf-story-btn ghost", type: "button", text: "Close", "data-mcf": "close" });

    const validate = () => {
      if (!titleInput.value.trim()) {
        toast("Give the story a title first", "error");
        titleInput.focus();
        return null;
      }
      if (!bodyInput.value.trim()) {
        toast("The story is still empty", "error");
        bodyInput.focus();
        return null;
      }
      if (bodyInput.value.length > LIMITS.body) {
        toast(`Stories are limited to ${LIMITS.body.toLocaleString()} characters`, "error");
        return null;
      }
      return { title: titleInput.value.trim(), story: bodyInput.value.trim() };
    };

    const close = (force) => {
      if (!force && state.dirty) {
        if (!confirm("You have unsaved changes. Close without saving?")) return;
      }
      clearTimeout(draftTimer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeunload", beforeUnload);
      if (state.saved) clearDraft(draftKey);
      unmount(host);
      if (typeof config.onClose === "function") config.onClose();
    };
    host._requestClose = () => close(false);

    const beforeUnload = event => {
      if (!state.dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };

    saveBtn.onclick = async () => {
      const payload = validate();
      if (!payload) return;

      saveBtn.disabled = true;
      const savedLabel = saveBtn.textContent;
      saveBtn.textContent = "Saving…";

      try {
        const body = {
          username,
          title: payload.title,
          story: payload.story,
          clipUrl: state.clip ? state.clip.url : null,
          clipType: state.clip ? state.clip.type : null
        };

        let data;
        if (isEdit) {
          data = await postJSON("/api/story/update", { ...body, storyId: existing._id });
        } else {
          data = await postJSON("/api/story/save", { ...body, owner: username, partner });
        }

        if (!data || !data.ok) {
          const messages = {
            story_too_long: `Stories are limited to ${LIMITS.body.toLocaleString()} characters`,
            partner_not_found: "That member no longer exists",
            not_owner: "Only the author can edit this story",
            declined: "This story was declined — revise it and save again",
            empty_story: "The story is still empty"
          };
          toast(messages[data && data.error] || "Could not save the story", "error");
          return;
        }

        state.saved = true;
        state.dirty = false;
        clearDraft(draftKey);
        unmount(host);
        document.removeEventListener("keydown", onKey);
        window.removeEventListener("beforeunload", beforeUnload);

        if (isEdit && data.wasPublished) {
          toast(`Saved. @${partner} has been asked to approve the revision.`, "ok");
        } else if (isEdit) {
          toast(`Saved. @${partner} has been asked to approve the revision.`, "ok");
        } else {
          toast(`Story saved. @${partner} has been asked to approve it.`, "ok");
        }

        if (typeof config.onSaved === "function") config.onSaved(data);
      } catch (err) {
        toast("Could not save the story", "error");
        console.error("story save failed", err);
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = savedLabel;
      }
    };

    previewBtn.onclick = () => {
      const payload = validate();
      if (!payload) return;
      openViewer({
        title: payload.title,
        story: payload.story,
        clipUrl: state.clip ? state.clip.url : null,
        clipType: state.clip ? state.clip.type : null,
        owner: username,
        partner,
        revision: existing ? existing.revision : 0
      });
    };

    if (deleteBtn) {
      deleteBtn.onclick = async () => {
        if (!confirm("Delete this story for both of you? This cannot be undone.")) return;
        const data = await postJSON("/api/story/delete", { storyId: existing._id, username });
        if (!data || !data.ok) {
          toast(data && data.error === "not_owner" ? "Only the author can delete this story" : "Could not delete the story", "error");
          return;
        }
        state.saved = true;
        state.dirty = false;
        clearDraft(draftKey);
        unmount(host);
        document.removeEventListener("keydown", onKey);
        window.removeEventListener("beforeunload", beforeUnload);
        toast("Story deleted", "ok");
        if (typeof config.onDeleted === "function") config.onDeleted();
      };
    }

    closeBtn.onclick = () => close(false);

    const onKey = event => {
      if (event.key === "Escape") {
        // Escape backs out of the picker first, so it cannot discard a story
        // by accident while picking messages.
        if (state.pickerOpen) {
          state.pickerOpen = false;
          picker.style.display = "none";
          return;
        }
        close(false);
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveBtn.click();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        surround("**");
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "i") {
        event.preventDefault();
        surround("*");
      }
    };
    document.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", beforeUnload);

    /* ---------- layout ---------- */
    const footer = node("div", { class: "mcf-story-foot" }, [
      deleteBtn,
      closeBtn,
      previewBtn,
      saveBtn
    ]);

    const panel = node("div", { class: "mcf-story-panel" }, [
      node("div", { class: "mcf-story-head" }, [
        node("h2", { text: isEdit ? "Edit Story" : "Create Story" }),
        isEdit ? node("span", { class: "mcf-story-chip", text: Number(existing.revision) > 0 ? `revision ${existing.revision} → ${Number(existing.revision) + 1}` : "first draft" }) : null
      ]),
      node("div", { class: "mcf-story-body" }, [
        draftBanner,
        node("div", { class: "mcf-story-field" }, [
          node("label", { text: "Title" }),
          titleInput,
          node("div", { class: "mcf-story-meta" }, [
            node("span", { text: `a story with @${partner}` }),
            node("span", { text: isEdit ? "editing saves it back to their approval queue" : "they will be asked to approve it" })
          ])
        ]),
        isEdit ? null : node("div", { class: "mcf-story-field" }, [loadToggle, picker]),
        isEdit ? node("div", { class: "mcf-story-field" }, [loadToggle, picker]) : null,
        node("div", { class: "mcf-story-field" }, [
          node("label", { text: "Story" }),
          toolbar,
          bodyInput,
          counter,
          draftStatus
        ]),
        node("div", { class: "mcf-story-field" }, [
          node("label", { text: "Clip (optional)" }),
          node("div", { class: "mcf-story-row" }, [clipChoose, clipClear, clipStatus]),
          clipInput,
          clipPreview
        ])
      ]),
      footer
    ]);

    host.appendChild(panel);
    updateCounter();
    titleInput.focus();

    return { host, close };
  }

  /* ============================================================
     APPROVE / DECLINE / DELETE HELPERS
  ============================================================ */

  async function approveStory(storyOrId, username) {
    const storyId = typeof storyOrId === "object" ? storyOrId._id : storyOrId;
    const data = await postJSON("/api/story/approve", { storyId, username: username || sessionUser() });
    if (!data || !data.ok) {
      const messages = {
        not_participant: "Only the two people in the story can approve it",
        declined: "This story was declined — ask the author to revise it",
        not_found: "That story no longer exists"
      };
      toast(messages[data && data.error] || "Could not approve the story", "error");
      return false;
    }
    toast(data.approved ? "Approved — the story is now published on both profiles" : "Approved", "ok");
    return true;
  }

  async function declineStory(storyOrId, username, reason) {
    const storyId = typeof storyOrId === "object" ? storyOrId._id : storyOrId;
    let why = reason;

    if (why == null) {
      why = window.prompt("Refuse this story? You can add a short reason for the author (optional):", "") || "";
    }

    const data = await postJSON("/api/story/decline", {
      storyId,
      username: username || sessionUser(),
      reason: (why || "").slice(0, LIMITS.declineReason)
    });

    if (!data || !data.ok) {
      toast(data && data.error === "not_participant"
        ? "Only the two people in the story can decline it"
        : "Could not decline the story", "error");
      return false;
    }

    toast(data.retracted ? "Approval withdrawn — the story is private again" : "Story declined", "ok");
    return true;
  }

  async function deleteStory(storyOrId, username) {
    const storyId = typeof storyOrId === "object" ? storyOrId._id : storyOrId;
    if (!confirm("Delete this story for both of you? This cannot be undone.")) return false;

    const data = await postJSON("/api/story/delete", { storyId, username: username || sessionUser() });
    if (!data || !data.ok) {
      toast(data && data.error === "not_owner" ? "Only the author can delete this story" : "Could not delete the story", "error");
      return false;
    }
    toast("Story deleted", "ok");
    return true;
  }

  /** Fetch one story by id, for permalinks and approval popups. */
  async function fetchStory(storyId, username) {
    const query = username ? "?username=" + encodeURIComponent(username) : "";
    const data = await getJSON("/api/story/" + encodeURIComponent(storyId) + query);
    return data && data.ok ? data.story : null;
  }

  /* ============================================================
     LISTS
  ============================================================ */

  function storyMetaLine(story, username) {
    const other = story.owner === username ? story.partner : story.owner;
    const parts = [`@${other}`];
    const when = formatDate(story.approvedAt || story.updatedAt || story.createdAt);
    if (when) parts.push(when);
    if (Number(story.revision) > 0) parts.push(`revised ${plural(Number(story.revision), "time")}`);
    return parts.join(" · ");
  }

  /**
   * A story row: click the title to read it, plus the actions the viewer is
   * allowed (only the author may edit or delete).
   */
  function storyRow(story, { username, onChange, showActions = true }) {
    const item = node("div", { class: "mcf-story-item", "data-mcf": "story-row" });
    item.dataset.id = story._id || "";

    const title = node("div", { class: "title", text: storyTitle(story) });
    title.onclick = () => openViewer(story);
    item.append(title, node("div", { class: "sub", text: storyMetaLine(story, username) }));

    if (!showActions) return item;

    const acts = node("div", { class: "acts" });
    const read = node("button", { class: "mcf-story-btn ghost", type: "button", text: "Read" });
    read.onclick = () => openViewer(story);
    acts.appendChild(read);

    if (story._id) {
      const share = node("button", { class: "mcf-story-btn ghost", type: "button", text: "🔗 Link" });
      share.onclick = async () => {
        const ok = await copyText(permalinkFor(story));
        toast(ok ? "Link copied" : permalinkFor(story), ok ? "ok" : "info");
      };
      acts.appendChild(share);
    }

    if (story.owner === username) {
      const edit = node("button", { class: "mcf-story-btn", type: "button", text: "✎ Edit" });
      edit.onclick = () => openEditor({ story, username, partner: story.partner, onSaved: onChange, onDeleted: onChange });
      const remove = node("button", { class: "mcf-story-btn danger", type: "button", text: "Delete" });
      remove.onclick = async () => {
        if (await deleteStory(story, username)) onChange && onChange();
      };
      acts.append(edit, remove);
    }

    item.appendChild(acts);
    return item;
  }

  function renderStoryList(box, stories, opts) {
    const options = opts || {};
    box.innerHTML = "";
    const list = Array.isArray(stories) ? stories : [];

    if (!list.length) {
      box.appendChild(node("div", { class: "mcf-story-empty", text: options.emptyText || "No approved stories yet" }));
      return;
    }

    list.forEach(story => box.appendChild(storyRow(story, options)));
  }

  /**
   * Stories waiting on somebody, plus the ones that were refused.
   * A declined story stays visible to its author, with the reason and a way
   * back in — it used to disappear with no explanation at all.
   */
  function renderPendingList(box, opts) {
    const options = opts || {};
    const username = options.username || sessionUser();
    const stories = options.stories || [];
    const declined = options.declined || [];
    const onChange = options.onChange;

    box.innerHTML = "";

    if (!stories.length && !declined.length) {
      box.appendChild(node("div", { class: "mcf-story-empty", text: "No stories waiting for approval" }));
      return;
    }

    stories.forEach(story => {
      const isOwner = story.owner === username;
      const other = isOwner ? story.partner : story.owner;
      const item = node("div", { class: "mcf-story-item pending" });
      item.dataset.id = story._id || "";
      item.append(
        node("div", { class: "title", text: storyTitle(story) }),
        node("div", {
          class: "sub",
          text: isOwner
            ? `waiting for @${other} · ${formatDate(story.updatedAt || story.createdAt)}`
            : `@${other} is waiting for you · ${formatDate(story.updatedAt || story.createdAt)}`
        })
      );

      if (Number(story.revision) > 0) {
        item.appendChild(node("div", { class: "sub", text: `revised ${plural(Number(story.revision), "time")} since the last approval` }));
      }

      const acts = node("div", { class: "acts" });

      const read = node("button", { class: "mcf-story-btn ghost", type: "button", text: "Read" });
      read.onclick = () => openViewer(story);
      acts.appendChild(read);

      if (isOwner) {
        const edit = node("button", { class: "mcf-story-btn", type: "button", text: "✎ Edit" });
        edit.onclick = () => openEditor({ story, username, partner: story.partner, onSaved: onChange });
        const resend = node("button", { class: "mcf-story-btn ghost", type: "button", text: "Resend request" });
        resend.onclick = async () => {
          const data = await postJSON("/api/story/resend", { storyId: story._id, username });
          toast(data && data.ok ? `Asked @${data.target} again` : "Could not resend the request", data && data.ok ? "ok" : "error");
        };
        const withdraw = node("button", { class: "mcf-story-btn danger", type: "button", text: "Withdraw" });
        withdraw.onclick = async () => {
          if (await deleteStory(story, username)) onChange && onChange();
        };
        acts.append(edit, resend, withdraw);
      } else {
        const approve = node("button", { class: "mcf-story-btn primary", type: "button", text: "Approve", "data-mcf": "approve" });
        approve.onclick = async () => {
          if (await approveStory(story, username)) onChange && onChange();
        };
        const decline = node("button", { class: "mcf-story-btn danger", type: "button", text: "Decline", "data-mcf": "decline" });
        decline.onclick = async () => {
          if (await declineStory(story, username)) onChange && onChange();
        };
        acts.append(approve, decline);
      }

      item.appendChild(acts);
      box.appendChild(item);
    });

    declined.forEach(story => {
      const isOwner = story.owner === username;
      const item = node("div", { class: "mcf-story-item declined" });
      item.dataset.id = story._id || "";
      item.append(
        node("div", { class: "title", text: storyTitle(story) }),
        node("div", {
          class: "sub",
          text: `declined by @${story.declinedBy || (isOwner ? story.partner : story.owner)} · ${formatDate(story.updatedAt || story.createdAt)}`
        })
      );

      if (story.declineReason) {
        item.appendChild(node("div", { class: "sub", text: `“${story.declineReason}”` }));
      }

      const acts = node("div", { class: "acts" });
      const read = node("button", { class: "mcf-story-btn ghost", type: "button", text: "Read" });
      read.onclick = () => openViewer(story);
      acts.appendChild(read);

      if (isOwner) {
        const revise = node("button", { class: "mcf-story-btn primary", type: "button", text: "✎ Revise & resubmit" });
        revise.onclick = () => openEditor({ story, username, partner: story.partner, onSaved: onChange });
        acts.appendChild(revise);
      }

      item.appendChild(acts);
      box.appendChild(item);
    });
  }

  /* ============================================================
     ARCHIVES (public stories)
  ============================================================ */

  /** Server-side search + paging: archives no longer download everything. */
  async function fetchArchives({ q, page, perPage, participant, sort } = {}) {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (page) params.set("page", String(page));
    if (perPage) params.set("perPage", String(perPage));
    if (participant) params.set("participant", participant);
    if (sort) params.set("sort", sort);

    const data = await getJSON("/api/story/archives" + (params.toString() ? "?" + params.toString() : ""));
    return {
      stories: (data && data.stories) || [],
      total: (data && data.total) || 0,
      page: (data && data.page) || 1,
      perPage: (data && data.perPage) || 24,
      totalPages: (data && data.totalPages) || 1
    };
  }

  /**
   * Drive the archives modal. The host markup (search field, list, pager,
   * close button) is the page's; this only fills it, so desktop and mobile can
   * keep their own look.
   */
  async function openArchives(opts) {
    const options = opts || {};
    const username = options.username || sessionUser();
    const listEl = options.listEl || document.getElementById("archivesList");
    const searchEl = options.searchEl || document.getElementById("archivesSearch");
    const pageLabel = options.pageLabel || document.getElementById("archivesPageNumber");
    const prevBtn = options.prevBtn || document.getElementById("archivesPrev");
    const nextBtn = options.nextBtn || document.getElementById("archivesNext");
    const sortEl = options.sortEl || document.getElementById("archivesSort");
    const mineEl = options.mineEl || document.getElementById("archivesMine");

    if (!listEl) return;

    const state = { page: 1, perPage: options.perPage || 12, q: "", sort: "recent", mine: false, totalPages: 1, total: 0 };

    const render = async () => {
      listEl.innerHTML = '<div class="mcf-story-empty">Loading…</div>';
      try {
        const result = await fetchArchives({
          q: state.q,
          page: state.page,
          perPage: state.perPage,
          participant: state.mine ? username : undefined,
          sort: state.sort
        });

        state.totalPages = result.totalPages;
        state.total = result.total;
        setReadingList(result.stories);

        if (!result.stories.length) {
          listEl.innerHTML = "";
          listEl.appendChild(node("div", {
            class: "mcf-story-empty",
            text: state.q ? `No stories match “${state.q}”` : "No published stories yet"
          }));
        } else {
          renderStoryList(listEl, result.stories, {
            username,
            showActions: true,
            onChange: () => render()
          });
        }

        if (pageLabel) {
          pageLabel.textContent = `Page ${state.page} / ${state.totalPages} · ${plural(state.total, "story")}`;
        }
        if (prevBtn) prevBtn.disabled = state.page <= 1;
        if (nextBtn) nextBtn.disabled = state.page >= state.totalPages;
      } catch (err) {
        console.error("Failed to load story archives", err);
        listEl.innerHTML = "";
        listEl.appendChild(node("div", { class: "mcf-story-empty", text: "Could not load the archives." }));
      }
    };

    if (prevBtn) prevBtn.onclick = () => { if (state.page > 1) { state.page -= 1; render(); } };
    if (nextBtn) nextBtn.onclick = () => { if (state.page < state.totalPages) { state.page += 1; render(); } };
    if (sortEl) sortEl.onchange = () => { state.sort = sortEl.value; state.page = 1; render(); };
    if (mineEl) mineEl.onchange = () => { state.mine = mineEl.checked; state.page = 1; render(); };

    if (searchEl) {
      let timer = null;
      searchEl.oninput = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          state.q = searchEl.value.trim();
          state.page = 1;
          render();
        }, 300);
      };
    }

    await render();
    return { state, render };
  }

  /* ============================================================
     LIVE APPROVAL POPUP
     One implementation for both clients (they each had their own, and both
     "Deny" buttons only closed the window without telling the server).
  ============================================================ */

  function showApprovalPopup(payload) {
    const data = payload || {};
    if (!data.storyId) return null;
    const username = sessionUser();

    ensureStyles();
    const host = backdrop("mcfStoryApproval");
    const copy = data.revised
      ? `${data.from} revised a story that involves your messages`
      : `${data.from} wrote a story that involves your messages`;

    const acts = node("div", { class: "mcf-story-row", style: "margin-top:14px" });

    const read = node("button", { class: "mcf-story-btn ghost", type: "button", text: "Read it", "data-mcf": "popup-read" });
    read.onclick = async () => {
      const story = await fetchStory(data.storyId, username);
      if (!story) {
        toast("Could not open that story", "error");
        return;
      }
      openViewer(story);
    };

    const approve = node("button", { class: "mcf-story-btn primary", type: "button", text: "Approve", "data-mcf": "popup-approve" });
    approve.onclick = async () => {
      if (await approveStory(data.storyId, username)) host.remove();
    };

    const decline = node("button", { class: "mcf-story-btn danger", type: "button", text: "Decline", "data-mcf": "popup-decline" });
    decline.onclick = async () => {
      if (await declineStory(data.storyId, username)) host.remove();
    };

    const later = node("button", { class: "mcf-story-btn ghost", type: "button", text: "Later", "data-mcf": "popup-later" });
    later.onclick = () => host.remove();

    acts.append(read, approve, decline, later);

    host._requestClose = () => host.remove();
    host.appendChild(node("div", { class: "mcf-story-panel", style: "width:520px" }, [
      node("div", { class: "mcf-story-head" }, [
        node("h2", { text: data.revised ? "A story was revised" : "Story approval request" })
      ]),
      node("div", { class: "mcf-story-body" }, [
        node("div", { text: copy + (data.title ? `: “${data.title}”.` : ".") }),
        node("div", { class: "mcf-story-meta", text: "It stays private until you approve it." }),
        acts
      ])
    ]));
    return host;
  }

  /* ============================================================
     PERMALINKS  (/story/<id> and #story=<id>)
  ============================================================ */

  function storyIdFromLocation() {
    const path = String(location.pathname || "");
    const fromPath = path.match(/^\/story\/([a-f0-9]{24})$/i);
    if (fromPath) return fromPath[1];

    const hash = String(location.hash || "");
    const fromHash = hash.match(/^#story[=/]?([a-f0-9]{24})$/i);
    return fromHash ? fromHash[1] : null;
  }

  /** Deep link: open the story named in the URL, if there is one. */
  async function openFromUrl() {
    const storyId = storyIdFromLocation();
    if (!storyId) return false;

    const username = sessionUser();
    const story = await fetchStory(storyId, username);

    if (!story) {
      // Private, deleted, or not published yet — say so instead of failing
      // silently, unless the visitor simply is not the audience for it.
      toast("That story is not available — it may have been unpublished.", "info");
      return false;
    }

    // Reading list for Prev/Next, best effort.
    try {
      const archive = await fetchArchives({ perPage: 50 });
      const list = archive.stories.slice();
      if (!list.some(s => String(s._id) === String(story._id))) list.unshift(story);
      setReadingList(list, story._id);
    } catch (err) { /* prev/next simply stays disabled */ }

    openViewer(story);
    return true;
  }

  /* ============================================================
     PUBLIC API
  ============================================================ */

  const StoryUI = {
    LIMITS,
    openViewer,
    openEditor,
    openArchives,
    openFromUrl,
    storyIdFromLocation,
    setReadingList,
    renderStoryList,
    renderPendingList,
    showApprovalPopup,
    approveStory,
    declineStory,
    deleteStory,
    fetchStory,
    fetchArchives,
    renderStoryBody,
    storyAsPlainText,
    formatTranscript,
    storyTitle,
    permalinkFor,
    copyText,
    toast,
    escapeHtml,
    sessionUser,
    draftKeyFor,
    readDraft,
    writeDraft,
    clearDraft
  };

  window.StoryUI = StoryUI;

  // Older callers (profile lists, chat.js, the mobile bundle) call this name
  // directly.
  window.openStoryViewer = function (title, text, clipUrl, clipType) {
    return openViewer(title, text, clipUrl, clipType);
  };

  function boot() {
    ensureStyles();
    // Give the page a moment to restore the session before resolving a link.
    setTimeout(() => {
      openFromUrl().catch(err => console.error("story permalink failed", err));
    }, 900);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
