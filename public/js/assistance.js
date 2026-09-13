/* ============================================================
   ASSISTANCE — the site's in-app support assistant

   Opened from the "Assistance" button in the action row. The
   window shows a random Jax portrait (/images/jax1-3.jpg) above a
   chat transcript, a row of quick questions and an input bar with
   a Send button.

   Answers come from TOPICS below. Every topic may carry an
   `action` pointing at the real button / popup for that feature,
   so the assistant either explains the steps or — when the user
   asks it to do the thing rather than asking how it is done —
   clicks through and opens that window for them.

   Actions always drive the existing controls (btnOpenChat,
   btnRooms, openSupport, ...) instead of duplicating their logic,
   so whatever those handlers do (socket emits, list refreshes,
   session checks) keeps working exactly as it does today.

   This version is exhaustive: it knows every feature, function,
   modal, button, slash command, upload limit, and flow on the
   site, and explains how to use each one step-by-step.
   ============================================================ */
(function () {
  'use strict';

  if (window.__assistanceReady) return;
  window.__assistanceReady = true;

  /* Portraits shown above the chat box — one is picked at random
     every time the window is opened. */
  var IMAGES = ['/images/jax1.jpg', '/images/jax2.jpg', '/images/jax3.jpg'];

  var POPUP_ID = 'assistancePopup';
  var REPLY_DELAY_MS = 420;
  var SESSION_KEY = 'cw_session_v1';

  function byId(id) {
    return document.getElementById(id);
  }

  /* ---------------------------------------------------------
     SESSION
     utils.js defines getSession(); fall back to reading the same
     localStorage key so the assistant still works if it loads
     before (or without) that helper.
  --------------------------------------------------------- */
  function getSessionSafe() {
    try {
      if (typeof getSession === 'function') return getSession();
    } catch (e) { /* fall through */ }
    try {
      return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    } catch (e) {
      return null;
    }
  }

  /* ---------------------------------------------------------
     CONTROL LOOKUP
     index.html keeps a hidden mobile block (#mainUI) alongside the
     desktop markup, so ids like btnDMs / btnLogin / btnEditProfile
     exist twice — and the app's own scripts bind whichever copy
     document.getElementById() returns, which is not always the copy
     the user can see (utils.js binds the hidden mobile Edit Profile
     button, forums.js and account.js bind every copy).

     So an action clicks the copies in document order and stops as
     soon as the window it wanted is actually open. That reaches the
     wired copy whichever one it is, without firing the same handler
     twice on the ids where every copy is wired.
  --------------------------------------------------------- */
  function controlsFor(id) {
    if (!id) return [];
    return Array.prototype.slice.call(document.querySelectorAll('[id="' + id + '"]'));
  }

  /* Every window in this app is shown by setting an inline display and
     hidden either by 'none' or by having no inline display at all (the
     .popup / .modal-overlay classes are display:none by default), so the
     inline value is what tells us whether a window is really up. Reading
     computed style would report a class-hidden popup as open. */
  function isShown(el) {
    if (!el) return false;
    var display = el.style ? el.style.display : '';
    return !!display && display !== 'none';
  }

  /**
   * Clicks copies of `id` until `popupId` is open.
   * @returns {boolean} true when the window ended up open
   */
  function openViaControl(id, popupId) {
    var target = popupId ? byId(popupId) : null;
    var nodes = controlsFor(id);

    for (var i = 0; i < nodes.length; i++) {
      nodes[i].click();
      if (!target) return true;                 // nothing to verify against
      if (isShown(target)) return true;         // that copy was the wired one
    }

    return isShown(target);
  }

  /* ---------------------------------------------------------
     TOPICS
     keywords   phrases matched against the question (word/phrase
                boundaries, so "room" will not match "bedroom")
     answer     plain text, one paragraph per line
     action     { label, buttonId, popupId, then, done }
                  buttonId  control to click (does the real work)
                  popupId   fallback: shown directly if there is no
                            button for it
                  then      optional follow-up control to click once
                            the first window is up
                  done      confirmation line shown in the chat
     requiresLogin  the window only does something when signed in
  --------------------------------------------------------- */
  var TOPICS = [
    /* ---------- CORE ENTRY ---------- */
    {
      id: 'age-gate',
      title: 'The 18+ age gate',
      keywords: ['age gate', '18+', '18 plus', 'are you 18', 'age verification', 'age check', 'adult gate', 'enter site'],
      answer: 'Male Cyber Fighters is strictly 18+. When you first load the site a full-screen age gate asks "Are you 18 or older".\n' +
        'Press "Yes, Enter" to pass it — your browser remembers the choice. If you are under 18 you must leave.\n' +
        'Your profile age must also be 18+ and is checked at registration.',
      action: null
    },
    {
      id: 'login',
      title: 'Signing in',
      keywords: ['login', 'log in', 'sign in', 'signing in', 'log on', 'sign on'],
      answer: 'Press Login in the action row and enter your username and password.\n' +
        'On success your profile card appears, the Arena marks you online, and your DMs and Rooms become live.\n' +
        'If you have forgotten the password, use the "Forgot password?" link at the bottom of that window.',
      action: {
        label: 'Open Login',
        buttonId: 'btnLogin',
        popupId: 'modalLogin',
        done: 'Opening the login window for you.'
      }
    },
    {
      id: 'register',
      title: 'Registering a new account',
      keywords: ['register', 'sign up', 'signup', 'create account', 'new account', 'make an account', 'join the site', 'registration'],
      answer: 'Press Register in the action row. Fill in username, email, password, display name, age (18+), short bio, favourite colour, language (English, Spanish, French, German on register — more in Edit Profile), wins/losses, height menu 3\'5\" to 8\'0\" in one-inch steps, weight in lbs 60–700, and optionally upload a main profile image first with "Upload Image".\n' +
        'Press Create Account. You get a welcome email if SMTP is configured. Your combat stats ATK/DEF are derived from height/weight immediately.',
      action: {
        label: 'Open Register',
        buttonId: 'btnRegister',
        popupId: 'modalRegister',
        done: 'Opening the registration form for you.'
      }
    },
    {
      id: 'forgot-password',
      title: 'Forgot password / reset link',
      keywords: ['forgot password', 'forgot my password', 'reset password', 'reset link', 'lost my password', 'cannot log in', 'cant log in', 'password reset'],
      answer: 'Use the password reset instead of signing in.\n' +
        'Press Login → "Forgot password?" → enter the email on your account and press "Send reset link". A 1-hour link is emailed to you (check spam too).\n' +
        'Open the link (reset-password.html?token=...) and choose a new password (min 6 chars). Only the hash of the token is stored (SHA-256), so a DB leak cannot reuse it.\n' +
        'If the link does not arrive, press "Resend email" in the forgot modal or send a support report.',
      action: {
        label: 'Reset my password',
        buttonId: 'forgotLink',
        popupId: 'modalForgot',
        done: 'Opening the password reset — enter the email on your account.'
      }
    },
    {
      id: 'change-password',
      title: 'Change password (signed in)',
      keywords: ['change password', 'change my password', 'new password', 'update password', 'change pass'],
      answer: 'Account Settings has a "Change password" section: type your current password, then the new one twice (min 6 chars) and press Change Password.\n' +
        'On success your old socket session is forced to log out (reason: password_changed). The change is logged in IpLog as change_password.',
      requiresLogin: true,
      action: {
        label: 'Open Account Settings',
        buttonId: 'btnAccountSettings',
        popupId: 'modalAccountSettings',
        done: 'Opening Account Settings — the password section is at the top.'
      }
    },
    {
      id: 'account-settings',
      title: 'Account settings',
      keywords: ['account settings', 'settings', 'account', 'my account', 'preferences'],
      answer: 'Account Settings (the ⚙️ button on your profile card, id btnAccountSettings) holds two things: changing your password and deleting your account.\n' +
        'Open it from the profile card. The modal has Change Password at the top and Delete Account at the bottom with its own password confirmation.',
      requiresLogin: true,
      action: {
        label: 'Open Account Settings',
        buttonId: 'btnAccountSettings',
        popupId: 'modalAccountSettings',
        done: 'Opening Account Settings for you.'
      }
    },
    {
      id: 'delete-account',
      title: 'Deleting your account',
      keywords: ['delete account', 'delete my account', 'close my account', 'remove account', 'permanent delete'],
      answer: 'In Account Settings → Delete Account, type your password and press "Delete My Account". This is permanent and cannot be undone.\n' +
        'It deletes your user document, all DMs to/from you, all stories where you are owner or partner, all relationships, rooms you own, and pulls you from invitedUsers.\n' +
        'Your live socket gets a forceLogout (reason: deleted) and presence + roomsList are rebroadcast. LogIp records delete_account.',
      requiresLogin: true,
      action: {
        label: 'Open Account Settings',
        buttonId: 'btnAccountSettings',
        popupId: 'modalAccountSettings',
        done: 'Opening Account Settings — delete is at the bottom and needs your password.'
      }
    },

    /* ---------- ARENA / PUBLIC CHAT ---------- */
    {
      id: 'arena',
      title: 'The Arena (public chat)',
      keywords: ['arena', 'public chat', 'main chat', 'chatroom', 'chat room', 'main room', 'public room', 'open arena'],
      answer: 'The Arena is the main public chatroom, shared live with the United Gay Cyber Wrestling Discord server via Discord webhooks and the bot listener.\n' +
        'Press Open Arena in the action row. Type in the box at the bottom and press Send. The online list sits on the right, clicking a name opens that profile.\n' +
        '"_" minimises the window and "X" closes it — closing emits chatClosed which marks you offline but keeps you signed in (session stays in localStorage cw_session_v1). Beforeunload also marks offline so refreshing keeps you signed in but not stuck online.\n' +
        'Messages are stored in PublicMessage, latest 200 are fetched via /api/public-messages (no-cache). They are translated per-recipient language via Google Translate, sender sees original. New messages from others play /sounds/computer.mp3.',
      action: {
        label: 'Open the Arena',
        buttonId: 'btnOpenChat',
        popupId: 'chatPopup',
        done: 'Opening the Arena for you.'
      }
    },
    {
      id: 'public-reply',
      title: 'Replying in public chat',
      keywords: ['reply arena', 'reply public', 'quote arena', 'reply to message arena', 'how to reply arena'],
      answer: 'In the Arena feed, hover any message and press Reply. A reply bar appears above the input: "↩ Replying to @user: snippet" with an ✕ to cancel.\n' +
        'Type your message and Send — the new message stores replyTo {id, from, display, text}. Recipients see a small "↩ @user — snippet" preview above the text.',
      action: {
        label: 'Open the Arena',
        buttonId: 'btnOpenChat',
        popupId: 'chatPopup',
        done: 'Opening the Arena — use Reply on any message.'
      }
    },
    {
      id: 'edit-messages',
      title: 'Editing your messages',
      keywords: ['edit message', 'edit my message', 'edit arena', 'edit room message', 'how to edit'],
      answer: 'You can edit your own arena and room messages (not DMs). Hover your message, press Edit, an inline input appears with Save/Cancel.\n' +
        'Press Enter to save or Escape to cancel. It emits editPublicMessage or editRoomMessage; server checks from === author and currentRoom matches, saves edited=true, and broadcasts publicMessageEdited / roomMessageEdited to all clients who update in place and show "(edited)" marker.\n' +
        'Only the sender may edit — isOwnMessage compares lowercased username from session.',
      action: {
        label: 'Open the Arena',
        buttonId: 'btnOpenChat',
        popupId: 'chatPopup',
        done: 'Opening the Arena — Edit appears on your own messages.'
      }
    },
    {
      id: 'presence',
      title: 'Online presence',
      keywords: ['online', 'offline', 'presence', 'who is online', 'online list', 'online users', 'status'],
      answer: 'Presence is live via socket.io. On login socket joins userRoom(username) for DM delivery and server sets online=true, socketId=socket.id. Server broadcasts presence (username, display, imageUrl, extraPhotos, info, wins, losses, color, language, age, height, weight, createdAt) to all clients which render quickRoster, rosterPage, onlineList, DM sidebar.\n' +
        'Closing Arena or disconnect with no survivor socket sets online=false, socketId=null. If you have a second tab/phone still connected, disconnect keeps you online and moves socketId to the survivor.',
      action: {
        label: 'Open the Arena',
        buttonId: 'btnOpenChat',
        popupId: 'chatPopup',
        done: 'Opening the Arena — the online list is on the right.'
      }
    },
    {
      id: 'idle-logout',
      title: 'Idle logout',
      keywords: ['idle logout', 'auto logout', 'inactive', 'session timeout', 'logout automatically'],
      answer: 'idle-logout.js watches for inactivity and logs you out after a long idle period to keep accounts safe on shared devices.\n' +
        'Moving the mouse, typing, or any socket activity resets the timer. You stay signed in if you keep chatting; otherwise you will need to log in again.',
      action: {
        label: 'Open Login',
        buttonId: 'btnLogin',
        popupId: 'modalLogin',
        done: 'If you were logged out for idle, sign in again here.'
      }
    },

    /* ---------- ROSTER & PROFILES ---------- */
    {
      id: 'roster',
      title: 'User roster',
      keywords: ['roster', 'user roster', 'user list', 'members', 'find a user', 'search users', 'all users', 'who is on', 'user directory'],
      answer: 'The User Roster lists everyone on the site with search and pagination.\n' +
        'Press User Roster → modalRoster appears. It fetches /api/allUsers (username, display, imageUrl, extraPhotos, info, wins, losses, color, language, age, height, weight, createdAt), sorts newest first, filters by username/display case-insensitive via rosterSearch input, paginates 12 per page with Prev/Next and Page X/Y label.\n' +
        'Press a user to open their profile. Also shows Quick Roster (6 newest) on home and New Members list card.',
      action: {
        label: 'Open the User Roster',
        buttonId: 'btnRoster',
        popupId: 'modalRoster',
        done: 'Opening the User Roster for you.'
      }
    },
    {
      id: 'roster-search',
      title: 'Searching the roster',
      keywords: ['search roster', 'filter roster', 'find user roster', 'search members'],
      answer: 'In the User Roster modal there is a search bar at the top (rosterSearch). Type any part of username or display name — it filters instantly, resets to page 1.\n' +
        'Same idea in DM sidebar (dmSearch) and Archives (archivesSearch) which searches titles, story text and both usernames server-side.',
      action: {
        label: 'Open the User Roster',
        buttonId: 'btnRoster',
        popupId: 'modalRoster',
        done: 'Opening the User Roster — type in the search box at the top.'
      }
    },
    {
      id: 'roster-pagination',
      title: 'Roster and archives pagination',
      keywords: ['pagination', 'next page', 'prev page', 'page number', 'more users', 'more stories'],
      answer: 'Roster shows 12 users per page, Archives 12 stories per page (configurable perPage). Prev/Next buttons and a Page X/Y label sit at the bottom.\n' +
        'If you filter, pagination recalculates. Archives pagination is server-side (page, perPage, total, totalPages) so it scales even when thousands of stories exist.',
      action: {
        label: 'Open the User Roster',
        buttonId: 'btnRoster',
        popupId: 'modalRoster',
        done: 'Opening the User Roster — pagination is at the bottom.'
      }
    },
    {
      id: 'view-profile',
      title: 'Viewing a profile',
      keywords: ['view profile', 'open profile', 'see profile', 'profile card', 'user profile', 'someones profile'],
      answer: 'Open any profile from Roster, Arena online list, or by clicking a username in chat. The modalViewProfile shows: large avatar (holo-avatar 150x150), @username, display name (28px bold), age, height (e.g. 5\'11"), weight lbs, favourite colour box, language, bio, wins/losses, Message User and Block User buttons (hidden on your own profile), Photos gallery (extra profile photos grid), Stories (approved), Relationships, Relationship Timeline, and Add Relationship dropdown (rival, friend, opponent, tagteam, dating, married, sibling, parent, owner) + Send Request.\n' +
        'Your own profile card on home (userProfileCard) shows avatar initials fallback, stats with win rate %, self photos, self stories, pending approval, Edit Profile and Account Settings buttons.',
      action: {
        label: 'Open the User Roster',
        buttonId: 'btnRoster',
        popupId: 'modalRoster',
        done: 'Opening the User Roster — pick a user to view their profile.'
      }
    },
    {
      id: 'extra-photos',
      title: 'Extra profile photos (gallery)',
      keywords: ['extra photos', 'profile photos', 'gallery', 'more photos', 'additional photos', 'photo gallery', '10 photos'],
      answer: 'Each profile can have up to 10 extra photos (5 MB each, ImgBB-hosted HTTPS URLs only, validated isImgBBUrl).\n' +
        'Upload from Edit Profile → Extra Profile Photos section: select multiple images, press Upload Selected Photos — they upload to ImgBB via /api/profile/photos and are saved immediately to your user document extraPhotos array (deduplicated Set). Status shows "X of 10 photos uploaded".\n' +
        'In Edit Profile you see a grid with × remove buttons that DELETE /api/profile/photos {username, photoUrl} and pull it. On viewing a profile, vpExtraPhotos renders via renderProfilePhotoGallery which normalizes to HTTPS ImgBB only and opens a real popup window (not a tab) with centred 60% width, popup=yes features; middle-click keeps normal new-tab behaviour. Your own card shows selfProfilePhotos.',
      requiresLogin: true,
      action: {
        label: 'Open Edit Profile',
        buttonId: 'btnEditProfile',
        popupId: 'modalEditProfile',
        done: 'Opening Edit Profile — extra photos are at the bottom.'
      }
    },
    {
      id: 'edit-profile',
      title: 'Editing your profile',
      keywords: ['edit profile', 'change profile', 'update profile', 'my profile', 'profile picture', 'avatar', 'bio', 'display name', 'edit my profile'],
      answer: 'Press Edit Profile on your profile card. Modal modalEditProfile lets you change: display name, age, Discord User ID (optional, see Discord topic), height select 3\'5" to 8\'0" (populated by physique.js populateHeightSelect), weight lbs 60–700, bio textarea, favourite colour <input type=color>, language select (30+ languages: en, ar, bn, zh-CN, zh-TW, cs, da, nl, fi, de, el, he, hi, id, it, ja, ko, ms, no, fa, pl, pt, ru, es, sv, th, tr, uk, vi), wins/losses numbers, main image file upload via /api/upload-image (multer memory 5 MB) → ImgBB, extra photos (see extra photos topic).\n' +
        'Press Save Changes → POST /api/update-profile {username, updates} with validation normalizeHeight/normalizeWeight and Discord ID snowflake check. Server recomputes ATK/DEF combat stats and saves. Session and localStorage currentUser are updated and profile card re-renders.',
      requiresLogin: true,
      action: {
        label: 'Open Edit Profile',
        buttonId: 'btnEditProfile',
        popupId: 'modalEditProfile',
        done: 'Opening Edit Profile for you.'
      }
    },
    {
      id: 'physique',
      title: 'Fighter physique — height & weight',
      keywords: ['height', 'weight', 'physique', 'tall', 'short', 'lbs', 'pounds', 'how tall', 'how heavy', 'fighter size'],
      answer: 'Height is stored as feet+inches string like 5\'11" from a menu 3\'5" (41") to 8\'0" (96") one-inch steps. Weight is whole lbs 60–700. Both optional but recommended.\n' +
        'Rules live in public/js/physique.js so browser menus and API validation never drift. Normalization: inchesToHeight, normalizeHeight, normalizeWeight. Invalid values return 400 invalid_height / invalid_weight.\n' +
        'Physique is shown on roster, online list, profile card, and view profile.',
      requiresLogin: true,
      action: {
        label: 'Open Edit Profile',
        buttonId: 'btnEditProfile',
        popupId: 'modalEditProfile',
        done: 'Opening Edit Profile — height and weight are near the top.'
      }
    },
    {
      id: 'combat-stats',
      title: 'Combat stats ATK / DEF',
      keywords: ['atk', 'def', 'attack', 'defense', 'combat stats', 'stats', 'how strong', 'damage', 'physique stats', 'fight stats'],
      answer: 'Every fighter has ATK = height(m) × sqrt(weight kg) and DEF = weight kg / height m, computed by physique.combatStats(height, weight). Saved on user as atk/def (userData) whenever physique is registered or updated, and via resolveCombatStats which recomputes if stored values are missing or outdated (e.g. after DEF formula dropped /2).\n' +
        'Baseline fighter 5\'11" / 185 lb = ATK 16.52 / DEF 46.53 fights when physique missing. Dice engine uses actor ATK vs defender DEF: damage = floor((roll*ATK - DEF)/DAMAGE_SCALE) clamped MIN_DAMAGE to DAMAGE_CAP. Legacy multipliers engineAtkMultiplier / engineDefMultiplier scale non-damage lines (submission recoil, teasing).\n' +
        'Pull via GET /api/combat-stats?usernames=a,b (max 20) returning {atk, def, atkMultiplier, defMultiplier}. Scoreboard shows "· ATK X · DEF Y" when known.',
      requiresLogin: true,
      action: {
        label: 'Open Edit Profile',
        buttonId: 'btnEditProfile',
        popupId: 'modalEditProfile',
        done: 'Opening Edit Profile — set height and weight to set your ATK/DEF.'
      }
    },
    {
      id: 'language',
      title: 'Language and translation',
      keywords: ['language', 'translate', 'translation', 'translate messages', 'another language', 'english', 'spanish', 'auto translate'],
      answer: 'Every member picks a language in Edit Profile — messages are auto-translated into it across Arena and Rooms.\n' +
        'Server translateText uses Google Translate API (https://translate.googleapis.com/translate_a/single) with caching pendingTranslations Map per targetLang+text to avoid duplicate requests. Sender always sees original. DMs store both originalText and translated text.\n' +
        'If your language is not in the list, send a support report under "App Issue" and it can be added. Languages supported: en, ar, bn, zh-CN, zh-TW, cs, da, nl, fi, de, el, he, hi, id, it, ja, ko, ms, no, fa, pl, pt, ru, es, sv, th, tr, uk, vi.',
      requiresLogin: true,
      action: {
        label: 'Open Edit Profile',
        buttonId: 'btnEditProfile',
        popupId: 'modalEditProfile',
        done: 'Opening Edit Profile — the language menu is halfway down.'
      }
    },
    {
      id: 'discord-link',
      title: 'Linking Discord',
      keywords: ['discord', 'link discord', 'discord account', 'ugcw', 'discord id', 'discord user id', 'connect discord'],
      answer: 'Put your Discord user ID in the "Discord User ID" field in Edit Profile and save — that links your site account to your Discord account.\n' +
        'Normalization: accepts plain snowflake 16–25 digits, or mention <@123456789012345678> or <@!...> or @123...; strips spaces and zero-width chars. Rejects username tags like john#1234 or @john_doe with invalid_discord_id error and shows help: Settings → Advanced → Developer Mode, right-click name → Copy User ID.\n' +
        'Why link? Arena is shared with U.G.C.W. Discord server via webhook, and DMs are bridged both ways. Outbound DMs call sendDiscordDM if receiver.discordId exists; inbound DMs from Discord are handled by setupDiscordListener which translates and emits to userRoom. Bridged DMs show hint "To reply from Discord, send @username your message".',
      requiresLogin: true,
      action: {
        label: 'Open Edit Profile',
        buttonId: 'btnEditProfile',
        popupId: 'modalEditProfile',
        done: 'Opening Edit Profile — the Discord ID field is near the top.'
      }
    },
    {
      id: 'discord-bridge',
      title: 'Discord bridge — Arena and DM bridging',
      keywords: ['discord bridge', 'discord webhook', 'discord bot', 'discord messages', 'ugcw discord', 'discord integration'],
      answer: 'The Arena is bridged live with the United Gay Cyber Wrestling Discord server (invite https://discord.gg/Y3VRjcw, "join U.G.C.W." button).\n' +
        'Outbound: publicMessage handler fetches sender avatar, builds webhook payload via buildWebhookPayload (avatar_url only when present), resolves avatar via /img proxy for uploaded photos or generated /avatar/:username PNG initials on profile colour for photoless senders, then POSTs to DISCORD_WEBHOOK_URL. Discord shows same identity as website.\n' +
        'Inbound: setupDiscordListener listens to Discord bot events, re-hosts images to ImgBB while signed URL still valid, translates via translateText, creates DM or PublicMessage, and emits to userRoom or Arena.\n' +
        'Support reports go to DISCORD_SUPPORT_URL webhook and Administrator DM. Image URLs from Discord CDN expire ~24h (is/ex params) — sweep re-hosts them on ImgBB.',
      action: {
        label: 'Open the Arena',
        buttonId: 'btnOpenChat',
        popupId: 'chatPopup',
        done: 'Opening the Arena — it is live-bridged with Discord.'
      }
    },

    /* ---------- DMS ---------- */
    {
      id: 'dms',
      title: 'Direct messages',
      keywords: ['dm', 'dms', 'direct message', 'direct messages', 'private message', 'message someone', 'whisper', 'pm', 'private chat'],
      answer: 'The DMs window lists every conversation you have, newest first, with a search box at the top.\n' +
        'Press DMs in the action row → dmSidebar modal appears. It calls /api/dm/partners {username} to get partners, filters by dmSearch input, shows unread badges from localStorage cw_dm_unread. Click a name to open that chat via openPrivateWindow.\n' +
        'You can also open a DM from someone\'s profile Message User button, from Arena online list PM button, or by clicking their username in chat.\n' +
        'DM windows are movable draggable popups on desktop (makePmWindowDraggable), cascade offset 28px per window, z-index stacking via bringPmToFront (1050+). They have image upload 📷 (5 MB ImgBB), clip upload 🎬 (GIF 25 MB, video 50 MB MP4/WebM), emoji picker 😊, Call button ☎, Story button, Clear button, typing indicator, and close X.',
      action: {
        label: 'Open DMs',
        buttonId: 'btnDMs',
        popupId: 'dmSidebar',
        done: 'Opening your DMs for you.'
      }
    },
    {
      id: 'dm-search',
      title: 'DM search and partners',
      keywords: ['search dm', 'dm search', 'find dm', 'dm list', 'dm partners', 'filter dms'],
      answer: 'DM sidebar has a search input dmSearch at the top. It filters the partner list live by username substring, case-insensitive.\n' +
        'Partners are fetched from /api/dm/partners which scans DM collection $or from/to. System messages from SYSTEM user also appear as 🔔 System. The list says "No DMs yet" or "Login to see DMs" when appropriate.',
      action: {
        label: 'Open DMs',
        buttonId: 'btnDMs',
        popupId: 'dmSidebar',
        done: 'Opening DMs — use the search box to filter.'
      }
    },
    {
      id: 'dm-unread',
      title: 'DM unread badges and server sync',
      keywords: ['unread dm', 'dm badge', 'unread count', 'dm unread', 'badge', 'unread messages', 'dm count'],
      answer: 'Unread DMs show as badges: dmBadge on DMs button (total count, 99+ cap) and per-conversation badges in sidebar and PM windows.\n' +
        'Client keeps cw_dm_unread map in localStorage, incrementUnread on incoming when window not open, clearUnread when opened. On socket login, server computes getUnreadDMCounts using dmSeen markers {partner: ISO date} and dmUnreadSince (set at registration, backfilled) and emits dmUnread {counts}. Client merges larger counts to avoid double counting DMs that arrived while tab asleep or bridged from Discord while offline.\n' +
        'Opening a DM window emits dmRead {username, partner} → markDMRead updates dmSeen to now. Rendering an incoming message into an open window also marks read.',
      action: {
        label: 'Open DMs',
        buttonId: 'btnDMs',
        popupId: 'dmSidebar',
        done: 'Opening DMs — badges show what is unread.'
      }
    },
    {
      id: 'dm-notification',
      title: 'DM notification popup and sounds',
      keywords: ['dm notification', 'new dm popup', 'dm toast', 'dm alert', 'notification popup', 'dm sound'],
      answer: 'When a DM arrives from someone else, a top popup dmNotification slides in: icon 💬, title "New Direct Message", user @name (dmNotificationUser). It auto-hides after 8 seconds, restarts animation if already visible, and clicking it dismisses and opens that DM window via openPrivateWindow.\n' +
        'Sound /sounds/ui-alert.mp3 plays via playDMAlertSound (preloaded Audio). Public messages play /sounds/computer.mp3, calls have call-ring.mp3, call-ringback.mp3, call-end.mp3.\n' +
        'All audio play() calls catch to ignore autoplay policy errors.',
      action: {
        label: 'Open DMs',
        buttonId: 'btnDMs',
        popupId: 'dmSidebar',
        done: 'Opening DMs — notifications appear at the top when a new DM arrives.'
      }
    },
    {
      id: 'dm-typing',
      title: 'Typing indicators',
      keywords: ['typing', 'is typing', 'typing indicator', 'typing dm', 'typing room', 'someone is typing'],
      answer: 'DM inputs emit typingDM {from, to} on input and stopTypingDM after 1200ms timeout. Server finds target socket by username and relays typingDM/stopTypingDM. Receiver shows pmTyping_<user> "X is typing..." block.\n' +
        'Room typing works similarly: typingRoom / stopTypingRoom with room id, only when socket.currentRoom === room and socket.rooms.has(room). Shows roomTyping "X is typing..." under feed.',
      action: {
        label: 'Open DMs',
        buttonId: 'btnDMs',
        popupId: 'dmSidebar',
        done: 'Opening DMs — typing shows when someone is writing.'
      }
    },
    {
      id: 'dm-clear',
      title: 'Clearing DM history',
      keywords: ['clear dm', 'delete dm', 'clear history dm', 'remove dm', 'clear chat dm'],
      answer: 'In a DM window press Clear. It confirms "Clear this DM history?" then POST /api/dm/clear {a, b} deletes both directions $or from/to. Client clears unread, marks read, renders empty history, clears body._history, updates sidebar and badge.\n' +
        'System messages from SYSTEM are preserved per logic in history endpoint which includes SYSTEM to you.',
      action: {
        label: 'Open DMs',
        buttonId: 'btnDMs',
        popupId: 'dmSidebar',
        done: 'Opening DMs — Clear is inside each DM window.'
      }
    },
    {
      id: 'dm-image',
      title: 'Sending images in DMs',
      keywords: ['dm image', 'send image dm', 'image dm', 'photo dm', 'picture dm', '📷 dm'],
      answer: 'DM windows have 📷 button. Click it → hidden file input accept image/* opens. Selecting a file calls uploadImageToServer via FormData image field POST /api/upload-image → ImgBB. On ok, socket emits privateMessage {from, to, imageUrl}. Server saves DM type normal with imageUrl, emits to both userRoom(to) and userRoom(from) as imagePayload {id, from, to, imageUrl, time}, forwards to Discord as "[Image attachment: url]". Receiver renders <img class=chat-image max-width 220px> clickable to open _blank.',
      action: {
        label: 'Open DMs',
        buttonId: 'btnDMs',
        popupId: 'dmSidebar',
        done: 'Opening DMs — 📷 sends an image.'
      }
    },
    {
      id: 'dm-clip',
      title: 'Sending GIFs and short video clips in DMs',
      keywords: ['dm clip', 'dm gif', 'dm video', 'gif dm', 'video dm', 'clip dm', 'send gif', 'send video', '🎬 dm'],
      answer: 'DM windows have 🎬 button for GIFs and short videos. Accepts image/gif, video/mp4, video/webm. GIF max 25 MB, video max 50 MB, total clips storage hard cap 2 GB (uploadsDirSize). Files are POSTed to /api/upload-clip field "clip" (multer disk storage UPLOADS_DIR uploads/clips, filename random 32 hex + ext). Server validates isLocalClipUrl /^\\/clips\\/[a-f0-9]{32}\\.(gif|mp4|webm)$/ to reject foreign URLs, saves DM type clip with clipUrl clipType, emits clipPayload, forwards to Discord as "[Video/GIF attachment: baseUrl+clipUrl]". Receiver renders <img class=chat-clip> for gif (click opens _blank) or <video controls playsinline preload=metadata> for video. Button shows "…" while uploading and disables.',
      action: {
        label: 'Open DMs',
        buttonId: 'btnDMs',
        popupId: 'dmSidebar',
        done: 'Opening DMs — 🎬 sends a GIF or short video.'
      }
    },
    {
      id: 'dm-call',
      title: 'DM audio calls',
      keywords: ['dm call', 'call dm', 'audio call dm', 'voice call dm', 'phone dm', 'call someone dm'],
      answer: 'DM windows have ☎ Call button (also in header). Press it → startAudioCall(target) in audio-calls.js. It gets local media via getUserMedia, creates RTCPeerConnection, emits audio-call-signal {to, kind: offer, offer} via socket. Server relays only to intended user via User.findOne {username: to} socketId. Callee gets incoming popup with Accept/Decline, ring tone /sounds/call-ring.mp3 (callee) and ringback /sounds/call-ringback.mp3 (caller). On answer, exchange answer and ICE candidates via audio-call-signal. Floating call card appears in corner, draggable, volume slider, status "Connected" once answered. End button emits audio-call-end and plays call-end.mp3. Calls are peer-to-peer WebRTC, server only routes setup, no recording — but other side could record locally, so only share what you are comfortable with.',
      action: {
        label: 'Open DMs',
        buttonId: 'btnDMs',
        popupId: 'dmSidebar',
        done: 'Opening DMs — the ☎ button starts an audio call.'
      }
    },
    {
      id: 'dm-draggable',
      title: 'Movable DM windows',
      keywords: ['drag dm', 'move dm window', 'dm popup position', 'cascade dm', 'dm stacking', 'z-index dm'],
      answer: 'Desktop DM windows (pm-window) are movable: drag by header (makePmWindowDraggable), header mousedown converts right/bottom anchored to left/top, tracks offset, clamps to viewport, adds pm-dragging class and removes transition while dragging. Clicking anywhere brings to front via bringPmToFront incrementing pmZIndexCounter from 1050. Multiple windows cascade 28px offset per window (mod 6). Mobile windows are full-screen and not draggable.',
      action: {
        label: 'Open DMs',
        buttonId: 'btnDMs',
        popupId: 'dmSidebar',
        done: 'Opening DMs — on desktop you can drag DM windows around.'
      }
    },

    /* ---------- ROOMS ---------- */
    {
      id: 'rooms',
      title: 'Rooms list and sorting',
      keywords: ['rooms', 'room', 'room list', 'custom rooms', 'private room', 'room sort', 'open rooms'],
      answer: 'The Rooms window lists every room you can see, with a sort menu at the top (roomSort: newest, oldest, A→Z, Z→A).\n' +
        'Press Rooms in the action row → roomsSidebar modal. It renders window.rooms filtered: public rooms always, private only if you are owner (case-insensitive) or in invitedUsers. Sorted per selection. Each row shows room name (🔒 for private) and an unread badge roomBadge_<id> (hidden initially, filled from localStorage cw_room_unread). Invite button appears only for owner.\n' +
        'Click a room to open its chat (roomChatPopup). Room windows have message box, image 📷 and clip 🎬 upload, emoji picker 😊, member list, Conference call button, reply bar, edit, and game scoreboard.',
      action: {
        label: 'Open Rooms',
        buttonId: 'btnRooms',
        popupId: 'roomsSidebar',
        done: 'Opening the Rooms window for you.'
      }
    },
    {
      id: 'create-room',
      title: 'Create a room',
      keywords: ['create a room', 'create room', 'new room', 'make a room', 'start a room', 'custom room create'],
      answer: 'Rooms are your own chat windows, public or private.\n' +
        'Open Rooms in the action row, press "Create Room" (createRoomBtn), prompt asks "Enter room name:", then confirm "Make this a PRIVATE room?" → true/false. Client emits createRoom {name, private}. Server creates Room document {name, private, owner: socket.username, invitedUsers: [], createdAt}, makes socket join its id, then broadcasts roomsList to all. Private rooms only appear to owner or invited.\n' +
        'In a private room the owner gets an Invite button on the room row — invite people by username via prompt which emits inviteToRoom {roomId, username}. Server checks owner === socket.username, pushes to invitedUsers, saves, emits roomInvited to target socket with alert "You have been invited to join private room: name", and rebroadcasts roomsList.',
      action: {
        label: 'Create a room',
        buttonId: 'btnRooms',
        popupId: 'roomsSidebar',
        then: 'createRoomBtn',
        done: 'Opening Rooms — press "Create Room" and give it a name.'
      }
    },
    {
      id: 'room-invite',
      title: 'Inviting to a private room',
      keywords: ['invite room', 'invite to room', 'private room invite', 'room invite', 'add to room'],
      answer: 'Only the owner can invite. In Rooms list, private rooms you own show an Invite button. Press it, type a username, and the server adds them to invitedUsers and notifies them live via roomInvited event (alert). If they are offline, they will see the room next time they fetch roomsList (since filter checks invitedUsers). Invited users can then join via joinRoom which validates canAccessRoom (owner case-insensitive or invitedUsers includes lowercased).',
      action: {
        label: 'Open Rooms',
        buttonId: 'btnRooms',
        popupId: 'roomsSidebar',
        done: 'Opening Rooms — Invite is on your private rooms.'
      }
    },
    {
      id: 'room-members',
      title: 'Room members panel',
      keywords: ['room members', 'who is in room', 'room member list', 'members panel', 'room online'],
      answer: 'When you open a room, the right column roomMembers shows Members header and roomMembersList.\n' +
        'Server updateRoomMembers fetches sockets in room via io.in(roomId).fetchSockets(), resolves username from live socket, fetches User for display/imageUrl/online, and emits roomMembers array to room. Client renders avatar 32px, display, @username, online/offline dot.\n' +
        'A refresh is requested after join via requestRoomMembers event after 200ms timeout to ensure join reached server. Also bindable via socket event requestRoomMembers from client.',
      action: {
        label: 'Open Rooms',
        buttonId: 'btnRooms',
        popupId: 'roomsSidebar',
        done: 'Opening Rooms — members show on the right when you open a room.'
      }
    },
    {
      id: 'room-system',
      title: 'Room join/leave notices',
      keywords: ['room joined', 'room left', 'has joined the room', 'has left the room', 'system message room', 'room notice'],
      answer: 'Rooms broadcast live-only system notices: "<display> has joined the room" / "has left the room". Implemented by announceRoomSystemMessage which fetches user display and emits roomMessage {room, from: SYSTEM, display: null, text, type: system, time} to io.to(room). Client renders as centered muted line div.room-system-msg, not a bubble, no avatar, no reply/edit, and never badges as unread (roomMessage handler skips type system for incrementRoomUnread).\n' +
        'Join notice only fires when roomHasUser shows user was not already in room from another session (second tab/phone). Leave notice only when no survivor remains after leaveRoom or disconnect.',
      action: {
        label: 'Open Rooms',
        buttonId: 'btnRooms',
        popupId: 'roomsSidebar',
        done: 'Opening Rooms — join/leave shows as a system line.'
      }
    },
    {
      id: 'room-unread',
      title: 'Room unread badges',
      keywords: ['room unread', 'room badge', 'unread room', 'room notification', 'room count'],
      answer: 'Each room has an unread counter in localStorage cw_room_unread {roomId: count}. When a roomMessage arrives for a room that is not currently open (currentRoom !== msg.room), and it is not a system notice and not your own message, incrementRoomUnread and updateRoomsSidebarBadges repaint pills roomBadge_<id> with count (99+ cap). Opening a room calls clearRoomUnread and updates badges. Re-rendering Rooms list (new roomsList or sort change) also repaints counts so they don\'t disappear.',
      action: {
        label: 'Open Rooms',
        buttonId: 'btnRooms',
        popupId: 'roomsSidebar',
        done: 'Opening Rooms — unread counts show on each room.'
      }
    },
    {
      id: 'room-messages',
      title: 'Room messages — reply, edit, images, clips',
      keywords: ['room message', 'room chat', 'room reply', 'room edit', 'room image', 'room clip', 'room emoji', 'send room message'],
      answer: 'Room chat (roomChatPopup) has: roomFeed (flex 1), roomMembers panel, roomTyping indicator, chat-input with roomReplyBar (↩ Replying to @user snippet + ✕ cancel), ☎ Conference button, input roomMessageInput, Send button roomSendBtn, hidden file inputs roomImageInput accept image/* and roomClipInput accept image/gif,video/mp4,video/webm, buttons roomImageBtn 📷 and roomClipBtn 🎬, emoji picker button 😊.\n' +
        'Send: click Send or Enter. Slash commands intercepted via SlashCommands.tryHandle. Otherwise emit roomMessage {room, from, display, text, imageUrl, clipUrl, clipType, replyTo, time}. Server validates socket.currentRoom === room and socket.rooms.has(room) and canAccessRoom, validates isLocalClipUrl for clips, creates RoomMessage (room, from, display, text, imageUrl, clipUrl, clipType, edited false, replyTo, time), then broadcasts to io.in(room). For image/clip, delivers as-is without translation; for text, translates per recipient except sender sees original.\n' +
        'Reply: setRoomReply stores replyTo and shows bar. Edit: only own messages, inline input with Save/Cancel, emits editRoomMessage {id, from, text}, server checks from===author and currentRoom, saves edited true, broadcasts roomMessageEdited to all online users with translated text.',
      action: {
        label: 'Open Rooms',
        buttonId: 'btnRooms',
        popupId: 'roomsSidebar',
        done: 'Opening Rooms — open a room to chat.'
      }
    },
    {
      id: 'room-call',
      title: 'Room conference calls',
      keywords: ['room call', 'conference', 'conference call', 'room conference', 'group call', 'call room'],
      answer: 'Room windows have "☎ Conference" button (roomCallBtn) and a small ☎ button in input bar. Press it → emits room-audio-invite {room} to socket.to(room). Others in room get room-audio-invite event and can join. Joining emits room-audio-join {room, to} which server relays to target socketId via User lookup. Then WebRTC offer/answer/candidate flow same as DM calls via audio-call-signal. Multiple peers can be in conference; each gets a floating card. Volume slider, draggable, Connected status, end tone. Same peer-to-peer no recording caveat.',
      action: {
        label: 'Open Rooms',
        buttonId: 'btnRooms',
        popupId: 'roomsSidebar',
        done: 'Opening Rooms — Conference starts a group call.'
      }
    },

    /* ---------- FORUMS ---------- */
    {
      id: 'forums',
      title: 'Forums',
      keywords: ['forums', 'forum', 'forum post', 'discussion', 'thread', 'forum list'],
      answer: 'Forums are the long-form side of the site: open Forums in the action row to read the list.\n' +
        'ForumsPopup modal shows forumsStatus and forumsList (roster-list style). It fetches GET /api/forums which aggregates Forum sorted lastActivityAt desc, createdAt desc and reply counts via ForumReply aggregate group. List shows title, author, reply count, last activity. Live updates via forumsList socket event and forumCreated/forumReplyCreated broadcasts.\n' +
        'Press a post to open thread, write a response in the box at bottom and press Post Response. Use New Forum button to start your own discussion. Recent Forum Posts card on home shows latest.',
      action: {
        label: 'Open Forums',
        buttonId: 'btnForums',
        popupId: 'forumsPopup',
        done: 'Opening the Forums for you.'
      }
    },
    {
      id: 'new-forum',
      title: 'Starting a forum post',
      keywords: ['new forum', 'create forum', 'start a forum', 'new post', 'create a post', 'start a discussion', 'make a forum', 'post forum'],
      answer: 'Open Forums and press "New Forum" (newForumBtn) → newForumModal appears with title input forumTitleInput max 160 chars and body textarea forumBodyInput max 10000 chars, error area newForumError.\n' +
        'Fill and press Create (newForumCreate). Client POST /api/forums {title, body, author: session.username}. Server validates title/body required and length, checks author exists and not banned via getForumAuthor, creates Forum {title, body, author, authorDisplay, lastActivityAt now}. Emits forumCreated serialized and broadcasts forumsList. Your post appears top of list immediately.',
      action: {
        label: 'Open the new forum form',
        buttonId: 'btnForums',
        popupId: 'forumsPopup',
        then: 'newForumBtn',
        done: 'Opening the new forum form for you.'
      }
    },
    {
      id: 'forum-thread',
      title: 'Reading a forum thread',
      keywords: ['forum thread', 'open forum', 'read forum', 'forum details', 'view forum'],
      answer: 'Click any forum in Forums list → forumThreadPopup opens (data-forum-id set). It shows Back button forumThreadBack to return to list, title forumThreadTitle, Close X forumThreadClose, status forumThreadStatus, content forumThreadContent with article forumOriginalPost and replies heading and forumReplies container.\n' +
        'Client GET /api/forums/:forumId validates ObjectId, fetches Forum and ForumReply sorted createdAt asc, returns serialized forum with reply count and replies. Original post shows author, date, body. Replies show each response with author and time.',
      action: {
        label: 'Open Forums',
        buttonId: 'btnForums',
        popupId: 'forumsPopup',
        done: 'Opening Forums — click a post to read it.'
      }
    },
    {
      id: 'forum-reply',
      title: 'Replying in forums',
      keywords: ['forum reply', 'reply forum', 'respond forum', 'post response forum', 'answer forum'],
      answer: 'In a forum thread, scroll to bottom reply composer: textarea forumReplyBody rows 3 max 5000 chars, error forumReplyError, submit button forumReplySubmit "Post Response".\n' +
        'Type and press Post Response → POST /api/forums/:forumId/replies {body, author}. Server validates forumId ObjectId, body required max 5000, author exists not banned, forum exists, creates ForumReply {forum, body, author, authorDisplay}, updates Forum lastActivityAt to now, emits forumReplyCreated {forumId, reply} and broadcasts forumsList. Your reply appears in thread and list bumps to top.',
      action: {
        label: 'Open Forums',
        buttonId: 'btnForums',
        popupId: 'forumsPopup',
        done: 'Opening Forums — open a thread to reply.'
      }
    },

    /* ---------- STORIES ---------- */
    {
      id: 'archives',
      title: 'Story archives overview',
      keywords: ['archives', 'archive', 'story list', 'public stories', 'read stories', 'story archives', 'all stories'],
      answer: 'Archives holds every approved story from every member, newest first, with search and sort.\n' +
        'Press Archives in action row → modalArchives appears with search archivesSearch, sort select archivesSort (recent, oldest, title, author), checkbox archivesMine "Only my stories", list archivesList, pagination Prev/Next with Page X/Y and total stories count.\n' +
        'Driven by StoryUI.openArchives which calls GET /api/story/archives?q=&page=&perPage=&participant=&sort= server-side search through titles, story text and both usernames, paging 12 per page (or custom perPage). Results render via renderStoryList with Read, Link, Edit/Delete (own).',
      action: {
        label: 'Open the Archives',
        buttonId: 'btnArchives',
        popupId: 'modalArchives',
        done: 'Opening the story Archives for you.'
      }
    },
    {
      id: 'archives-search-sort',
      title: 'Searching and sorting archives',
      keywords: ['search archives', 'filter archives', 'sort archives', 'sort stories', 'only my stories', 'my stories archives'],
      answer: 'Archives modal has: search input archivesSearch with 300ms debounce → sets q and page 1 and re-renders; sort select archivesSort options recent (newest first), oldest, title alphabetical, author; checkbox archivesMine filters participant=your username.\n' +
        'Server fetchArchives builds URLSearchParams q, page, perPage, participant, sort and GET /api/story/archives. Returns stories, total, page, perPage, totalPages. List shows empty message "No stories match …" or "No published stories yet". Page label shows "Page X / Y · N stories". Prev disabled page<=1, Next disabled page>=totalPages.',
      action: {
        label: 'Open the Archives',
        buttonId: 'btnArchives',
        popupId: 'modalArchives',
        done: 'Opening Archives — search and sort are at the top.'
      }
    },
    {
      id: 'create-story',
      title: 'Creating a story from a conversation',
      keywords: ['create story', 'make a story', 'write a story', 'new story', 'story creation', 'save a story', 'story from dm'],
      answer: 'Stories are built from a chat you already had.\n' +
        'In a DM window press "Story" (pm-story or dmStory button), or in a room window similarly. Story editor opens (storyPopup shell reused, class mcf-story-backdrop). Give it a title and a start date, then press "Load Messages" to pull that conversation into the editor via POST /api/story/load {a, b, requester, fromDate, toDate} which checks requester is participant and returns messages bounded and capped.\n' +
        'Editor lets you pick messages, format, attach clip, preview, and Save. Stories are reviewed by partner before they appear in public Archives.',
      requiresLogin: true,
      action: {
        label: 'Open DMs to start one',
        buttonId: 'btnDMs',
        popupId: 'dmSidebar',
        done: 'Opening your DMs — pick a conversation and press "Story".'
      }
    },
    {
      id: 'story-editor',
      title: 'Story editor — all functions',
      keywords: ['story editor', 'edit story', 'write story editor', 'story toolbar', 'story formatting', 'story clip', 'story title'],
      answer: 'Story editor (StoryUI.openEditor) lives in public/js/story-ui.js shared by desktop and mobile.\n' +
        'Fields: title input max 120 chars, body textarea min-height 280px max 20000 chars, counter shows chars/words/read minutes, toolbar with Bold (surround **), Italic (*), Quote (> ), Chapter heading (## ), Scene break (---). Insert functions surround/insertLine, focus and selection preserved. Ctrl+B bold, Ctrl+I italic, Ctrl+S save.\n' +
        'Clip: button "🎬 Attach GIF / clip" opens hidden file input accept gif/mp4/webm, uploads via /api/upload-clip (isClipFile check), shows preview via clipElement (img for gif, video controls for video) and Remove clip button.\n' +
        'Save: validates title/body required, length, then POST /api/story/save {username, title, story, clipUrl, clipType, owner, partner} for new, or /api/story/update {username, title, story, clipUrl, clipType, storyId} for edit. Editing approved story re-opens approval (wasPublished flag). Toast notifications, draft handling, preview button opens viewer.',
      requiresLogin: true,
      action: {
        label: 'Open DMs to start one',
        buttonId: 'btnDMs',
        popupId: 'dmSidebar',
        done: 'Opening DMs — Story button opens the full editor.'
      }
    },
    {
      id: 'story-build-messages',
      title: 'Building a story from messages',
      keywords: ['build from messages', 'load messages story', 'pick messages', 'transcript builder', 'select messages story', 'character names story', 'aliases story'],
      answer: 'Editor has "📥 Build from messages" toggle which shows picker: date inputs fromDate/toDate, Load messages button, search filter by text/name, speaker select Everyone/Only @you/Only @them, style select Script (**Name:** dialogue) vs Log ([time] Name: message), checkboxes Add timestamps and Blank line when speaker changes, character name inputs for @you and @them (aliases), Rename in story button replaces usernames in current body via regex, message list max-height 260px scroll with checkboxes (picked Set survives filtering), actions Add to story (append at cursor with glue newlines), Replace story (confirm), Select all/none/Invert. Format via formatTranscript which handles script/log, timestamps, sceneBreaks, aliases, and placeholder (clip)/(image) for media messages.\n' +
        'Load via POST /api/story/load {a, b, requester, fromDate, toDate} returns messages and truncated flag. Toast "Loaded N messages".',
      requiresLogin: true,
      action: {
        label: 'Open DMs to start one',
        buttonId: 'btnDMs',
        popupId: 'dmSidebar',
        done: 'Opening DMs — Build from messages is inside the editor.'
      }
    },
    {
      id: 'story-draft',
      title: 'Story drafts and unsaved work guard',
      keywords: ['story draft', 'draft story', 'unsaved story', 'save draft', 'restore draft', 'draft saved'],
      answer: 'Editor keeps a draft per conversation (and per story when editing) in localStorage key mcf.story.draft.<username>.<partner> or mcf.story.draft.edit.<storyId>. Draft payload {title, story, aliases, clip, storyId, partner, username, updatedAt ISO}.\n' +
        'On input, markDirty sets dirty true, updateCounter, and saveDraftSoon 1200ms timeout calls writeDraft. Draft banner shows "Unsaved draft from date time" with Restore draft and Discard buttons if stored draft differs from current. Restoring fills title/body/clip/aliases and marks dirty. Discard clears. Older than 30 days is ignored. Beforeunload warns if dirty. Closing editor asks "You have unsaved changes. Close without saving?" unless force. On successful save, clearDraft and dirty false.',
      requiresLogin: true,
      action: {
        label: 'Open DMs to start one',
        buttonId: 'btnDMs',
        popupId: 'dmSidebar',
        done: 'Opening DMs — drafts are auto-saved while you write.'
      }
    },
    {
      id: 'story-formatting',
      title: 'Story formatting — Markdown light',
      keywords: ['story formatting', 'bold story', 'italic story', 'quote story', 'heading story', 'scene break', 'markdown story', 'format story'],
      answer: 'Story body supports light Markdown rendered safely: **bold** or __bold__, *italic* or _italic_ (with boundary check), > quoted speech → blockquote.mcf-story-quote, --- or *** or ___ alone → <hr class=mcf-story-break> scene break, ## or ### heading → <h3 class=mcf-story-heading>, - or * bullet → <ul><li>. Text is escaped first then inlineFormat applied, so no injection.\n' +
        'Preview shows exactly as readers will see. Plain-text export via storyAsPlainText header "title by @owner with @partner date" + body trimmed.',
      requiresLogin: true,
      action: {
        label: 'Open Archives',
        buttonId: 'btnArchives',
        popupId: 'modalArchives',
        done: 'Opening Archives — formatting is shown in the viewer.'
      }
    },
    {
      id: 'story-approval',
      title: 'Story approval flow',
      keywords: ['story approval', 'approve story', 'story request', 'approval request', 'pending approval story', 'story approve'],
      answer: 'When you save a new story, server creates Story {owner, partner, title, story, clipUrl, clipType, approvalOwner true, approvalPartner false, approved false, revision 0, createdAt, updatedAt}. It emits storyApprovalRequest to partner socket if online (via User socketId) with storyId, from, title, revised flag, and also creates a system DM type storyApproval with storyId and text including Approve/Decline/Read buttons.\n' +
        'Partner can approve via POST /api/story/approve {storyId, username} → sets approvalPartner true, if both approvals then approved true, approvedAt now, emits storyStatusChanged to both, and adds to both profiles. Or decline via POST /api/story/decline {storyId, username, reason max 500} → sets declined true, declinedBy, declineReason, approved false. Declined stories stay on author profile with reason and Revise & resubmit button.\n' +
        'Author can resend via POST /api/story/resend {storyId, username} → re-emits request and DM. Editing approved story bumps revision, clears approvals except owner, re-opens approval queue (wasPublished). Either fighter can withdraw by deleting via POST /api/story/delete {storyId, username} owner check, removes and emits status changed, story stops being public immediately.',
      requiresLogin: true,
      action: {
        label: 'Open DMs',
        buttonId: 'btnDMs',
        popupId: 'dmSidebar',
        done: 'Opening DMs — approval requests appear as system messages.'
      }
    },
    {
      id: 'pending-stories',
      title: 'Pending and declined stories on profile',
      keywords: ['pending stories', 'my pending stories', 'awaiting approval', 'declined stories', 'revise resubmit', 'withdraw story'],
      answer: 'Your profile card (userProfileCard) has two sections: Stories (approved) and Pending Approval (from loadSelfStories and loadSelfPendingStories via GET /api/story/list?username= and /api/story/pending?username=). Pending list shows stories waiting on you or partner, with meta "waiting for @other" or "@other is waiting for you" plus revision count. Actions: Read opens viewer, Edit opens editor, Resend request re-asks partner, Withdraw deletes, Approve/Decline buttons for partner. Declined section shows "declined by @user date" and reason in quotes "…", with Read and Revise & resubmit. utils.js renderPendingList handles both.',
      requiresLogin: true,
      action: {
        label: 'Open Edit Profile',
        buttonId: 'btnEditProfile',
        popupId: 'modalEditProfile',
        done: 'Your pending stories are on your profile card below Photos.'
      }
    },
    {
      id: 'story-viewer',
      title: 'Reading stories — the viewer',
      keywords: ['read story', 'story viewer', 'view story', 'open story', 'story reading', 'story display'],
      answer: 'Story viewer (StoryUI.openViewer) opens in backdrop mcf-story-backdrop id storyViewerPopup, panel mcf-story-viewer width 720px max 92vh flex column, head with title in Great Vibes script font 40px (font-face served from /fonts/great-vibes.woff2, not Google, due to CSP), byline meta @owner with @partner, date, revision chip, declined chip, close X top-right absolute. Tools bar: A- smaller, A+ larger (fontSize stored in localStorage mcf.story.fontScale 0.8–1.8 step 0.1, applied as 15px * scale), Prev/Next buttons disabled when readingList length <=1 or at ends, Copy link, Export, Print. Scroll area mcf-story-scroll overflow-y auto with rendered body via renderStoryBody (paragraphs, quotes, headings, lists, breaks, clip preview max-height 38vh centered). Footer shows Story N of M and Close primary button. Keyboard: Escape closes, ArrowLeft/Right steps when canStep. Prev/Next via readingList set by setReadingList.',
      action: {
        label: 'Open the Archives',
        buttonId: 'btnArchives',
        popupId: 'modalArchives',
        done: 'Opening Archives — click any story to read it in the viewer.'
      }
    },
    {
      id: 'story-permalink',
      title: 'Story permalinks and sharing',
      keywords: ['story link', 'story permalink', 'share story', 'copy story link', 'story url', '/story/', 'export story', 'print story'],
      answer: 'Every published story has a permalink: location.origin + "/story/" + _id. Server route GET /story/:id validates ObjectId, fetches approved story, injects OG tags title "title — owner & partner" and description first 180 chars, Twitter tags, robots noindex follow, and serves index.html with mobile.css or desktop.css detection. Client boot openFromUrl checks location.pathname /story/24hex and hash #story=24hex, fetches via GET /api/story/:id?username=, and opens viewer. If not available (private, deleted, not published) toast "That story is not available — it may have been unpublished."\n' +
        'In viewer: Copy link uses navigator.clipboard.writeText fallback to textarea execCommand copy, toast "Link copied". Export downloads markdown blob via storyAsPlainText with sanitized filename. Print opens new window with story HTML and calls print(). Archives rows also have 🔗 Link button.',
      action: {
        label: 'Open the Archives',
        buttonId: 'btnArchives',
        popupId: 'modalArchives',
        done: 'Opening Archives — each story has Copy link and Export.'
      }
    },

    /* ---------- RELATIONSHIPS & BLOCKING ---------- */
    {
      id: 'relationships',
      title: 'Relationships',
      keywords: ['relationship', 'relationships', 'rival', 'friend', 'opponent', 'tag team', 'tagteam', 'dating', 'married', 'sibling', 'parent', 'owner', 'add relationship'],
      answer: 'Open someone\'s profile from User Roster or from their name in chat, then use Add relationship to request one. Types: rival, friend, opponent, tagteam (tag team partners with), dating, married, sibling, parent, owner. The other person has to approve.\n' +
        'Flow: POST /api/relationship/request {requester, target, type} creates Relationship {requester, target, type, approvedRequester true, approvedTarget false, approved false}. If target online (socketId), emits relationshipApprovalRequest live with popup modal Approve/Deny; else creates SYSTEM DM type relationshipApproval with relationshipId and Approve button. Target approves via POST /api/relationship/approve {relationshipId} → sets approvedTarget true, if both then approved true. Lists via GET /api/relationship/list?username= (approved only) and pending via /api/relationship/pending?username= (requester, not approved). Profile shows Relationships and Timeline.',
      action: {
        label: 'Open the User Roster',
        buttonId: 'btnRoster',
        popupId: 'modalRoster',
        done: 'Opening the User Roster — pick a user to add a relationship.'
      }
    },
    {
      id: 'relationship-timeline',
      title: 'Relationship timeline',
      keywords: ['timeline', 'relationship timeline', 'history relationships', 'relationship history'],
      answer: 'Each profile has a Relationship Timeline section below Stories and Relationships. It loads GET /api/relationship/timeline?username= which finds approved relationships where you are requester or target, sorted createdAt asc, maps to {id, type, with: other username, role: requester/target, approvedAt: createdAt}. Client renders date locale string and "type with other". Tracks your allies, rivals, partners over time.',
      action: {
        label: 'Open the User Roster',
        buttonId: 'btnRoster',
        popupId: 'modalRoster',
        done: 'Opening Roster — timeline is inside each profile.'
      }
    },
    {
      id: 'block',
      title: 'Blocking a user',
      keywords: ['block', 'block user', 'blocking', 'stop messages', 'block someone'],
      answer: 'Open that person\'s profile and press Block User (vpBlockButton) — confirms "Block this user? They will not be able to DM you." Then POST /api/block-user {username: me, target} uses $addToSet blockedUsers array. Server privateMessage handler checks receiver.blockedUsers includes from and drops DM with log "DM blocked". Unblock is same place via POST /api/unblock-user {username, target} $pull. If they are breaking rules, send a support report as well so admins can act.',
      action: {
        label: 'Open the User Roster',
        buttonId: 'btnRoster',
        popupId: 'modalRoster',
        done: 'Opening Roster — Block is inside a profile.'
      }
    },
    {
      id: 'unblock',
      title: 'Unblocking a user',
      keywords: ['unblock', 'unblock user', 'unblocking', 'allow messages'],
      answer: 'If you blocked someone, open their profile again and the button will allow unblocking, or use the same API endpoint. POST /api/unblock-user {username: your username, target: their username} pulls them from blockedUsers. After that their DMs will reach you again and they will appear in roster and Arena as normal.',
      action: {
        label: 'Open the User Roster',
        buttonId: 'btnRoster',
        popupId: 'modalRoster',
        done: 'Opening Roster — unblock from their profile.'
      }
    },

    /* ---------- FORUMS DONE ABOVE, NOW SUPPORT & LEGAL ---------- */
    {
      id: 'support',
      title: 'Support and reports',
      keywords: ['support', 'report', 'report a user', 'report a problem', 'bug', 'issue', 'complaint', 'harassment', 'harassing', 'toxic', 'broken', 'not working', 'suggestion', 'feature request', 'help', 'abuse'],
      answer: 'The Support window is how you report a user, report a site problem, or ask for a feature.\n' +
        'Press Support/Report in action row → supportPopup modal. Fields: Type of Report select srType (user = User Report, issue = App Issue), Who are you reporting? input srUser (shown only when type=user via change listener toggling srUserSection display), Where did this happen? srWhere placeholder "Public chat, DM, room, etc.", When did this happen? srWhen type datetime-local, Additional Information textarea srInfo placeholder "Describe what happened..." rows 5, Submit button srSubmit.\n' +
        'On submit, client checks getSession, builds payload {from: me.username, to: Administrator, text: formatted report with Type/User/Where/When/Info}, POST /api/send-dm which creates DM to Administrator and calls emitToUser + forwardDMToDiscord + Discord Support webhook if DISCORD_SUPPORT_URL set. Also email admin alert if EMAIL_ADMIN_ALERTS and mailerConfigured. Reports go straight to admins — zero tolerance policy on toxicity.',
      action: {
        label: 'Open a support report',
        buttonId: 'openSupport',
        popupId: 'supportPopup',
        done: 'Opening the support report form for you.'
      }
    },
    {
      id: 'rules',
      title: 'Site rules',
      keywords: ['rules', 'site rules', 'server rules', 'chat rules', 'conduct rules', 'banned', 'ban', 'zero tolerance', 'allowed', 'respect'],
      answer: 'The Site Rules window has the full conduct rules. Short version: Respect comes first, no harassment or hate, banter vs bullying (banter is mutual playful in-character not repeated after stop; bullying is personal repeated intended to hurt), Do\'s: stay in character, playful rivalry, keep competition fun, respect boundaries, report issues, encourage new users, keep cyber matches out of public chat unless designated area; Don\'ts: target individuals, spam/flood, impersonate staff, post private info, drag real-life drama, threats even jokingly; Zero-tolerance: hate speech, threats of violence, doxxing, sexual harassment, targeted harassment, encouraging self-harm, evading blocks/bans; Conflict resolution: stop engaging, block, report, mods review logs; Moderator authority: warnings, mutes, remove messages, bans, lock chat, decisions final.\n' +
        'Open via Site Rules button in action row or footer.',
      action: {
        label: 'Open the Site Rules',
        buttonId: 'btnRules',
        popupId: 'modalRules',
        done: 'Opening the Site Rules for you.'
      }
    },
    {
      id: 'tos',
      title: 'Terms of Service',
      keywords: ['terms', 'tos', 'terms of service', 'terms and conditions', 'agreement'],
      answer: 'The Terms of Service window covers the agreement you accept by using the site, including: What the site is (Arena, DMs, audio calls, custom rooms, forums, stories & archives, roster & profiles, fight engine, safety tools), Age Requirement adults only 18+, Your Account (username email password, keep confidential, not impersonate, delete anytime but shared content may remain), Acceptable Use & Community Conduct (incorporates Server Rules), User Content license (you retain ownership, grant non-exclusive worldwide royalty-free to host/store/copy/transmit/display/relay including to Discord), Stories & Archives (approval required, consent to public display), DMs & Audio Calls (not end-to-end encrypted, moderators can review logs when report, calls peer-to-peer no recording but other side may record), Uploads (image 5MB ImgBB, GIF 25MB video 50MB local), Moderation/Reporting/Enforcement, Third-Party Services (Discord, ImgBB, hosting, email, fight-engine), License, Restrictions, Suggestions, Cookies, Emails transactional only, IP, Copyright notice to administrator@male-cyber-fighters.com, Availability/Modifications, Term/Termination, Indemnification, No Warranties AS IS, Limitation of Liability max CAD $100 or amount paid, Governing Law Canada, 60-day informal dispute then ADR Institute arbitration, Severability/Waiver, Entire Agreement, Changes 30 days notice, Contact.',
      action: {
        label: 'Open the Terms of Service',
        buttonId: 'btnTOS',
        popupId: 'modalTOS',
        done: 'Opening the Terms of Service for you.'
      }
    },
    {
      id: 'privacy',
      title: 'Privacy policy',
      keywords: ['privacy', 'privacy policy', 'cookies', 'my data', 'personal data', 'gdpr', 'data collection', 'what data'],
      answer: 'The Privacy Policy window explains what the site stores and how it is used.\n' +
        'Collects: Account info (username, email, password hash bcrypt never plaintext, optional display, age, bio, stats, color, language, avatar, extraPhotos, height/weight ATK/DEF), Content you create (Arena, DMs, rooms, forums, stories, relationships, block list, reports), Uploads (images to ImgBB only links stored, GIFs/videos on own servers), Security/activity logs IpLog {ip, username, action, userAgent, createdAt} for login_success/fail/banned/register/change_password/delete_account etc viewable by admins, Presence/session data online boolean, dmSeen markers, Browser-side localStorage currentUser and game state.\n' +
        'Uses: operate service, translate, send transactional email (password reset), enforce rules, secure, improve. Visibility: Public areas (Arena, Forums, Archives, Roster, profiles) visible to anyone; Discord bridge relays Arena to Discord and DMs bridged; Private areas stored but not E2E encrypted, moderators can review on report; Audio calls peer-to-peer no recording. Shares with Discord, Google Translate, ImgBB, DB/hosting, email provider, fight-engine. No selling, no advertisers, no marketing trackers. Cookies primarily localStorage functional, any cookies functional. Email transactional only. Retention until account active, deletion removes profile/personal from active, residual in backups/logs briefly. Protection: bcrypt hashes, reset tokens SHA-256 hash expire 1 hour, HTTPS. Rights: review/update profile, change password, delete account, block, report, GDPR/CCPA/PIPEDA access via administrator@male-cyber-fighters.com. Adults only, no children. International transfers Canada and US. Links to third-party sites.',
      action: {
        label: 'Open the Privacy Policy',
        buttonId: 'btnPrivacy',
        popupId: 'modalPrivacy',
        done: 'Opening the Privacy Policy for you.'
      }
    },

    /* ---------- AUDIO CALLS ---------- */
    {
      id: 'audio-calls',
      title: 'Audio calls — DMs and rooms',
      keywords: ['call', 'audio call', 'voice call', 'conference', 'conference call', 'phone', 'voice chat', 'audio chat', 'call someone'],
      answer: 'Calls live inside chats: press the ☎ Call button in a DM window (pm-call), or "☎ Conference" in a room window (roomCallBtn).\n' +
        'Flow: startAudioCall in audio-calls.js gets local stream via getUserMedia, creates peer connection, emits audio-call-signal {to, kind: offer} via socket, server relays to User socketId, callee gets incoming UI with ring /sounds/call-ring.mp3 and caller hears ringback /sounds/call-ringback.mp3. Answer exchanges answer and ICE candidates via audio-call-signal. Call card floats in corner, draggable via makeCallCardDraggable (pointerdown/move/up), volume slider setCallVolume, status "Connected" once answered, End button emits audio-call-end and plays /sounds/call-end.mp3 and finishes peer. Room invites via room-audio-invite and room-audio-join. All peer-to-peer WebRTC, no server recording.',
      action: {
        label: 'Open DMs to start a call',
        buttonId: 'btnDMs',
        popupId: 'dmSidebar',
        done: 'Opening your DMs — the ☎ button starts the call.'
      }
    },
    {
      id: 'call-sounds',
      title: 'Call sounds and volume',
      keywords: ['call sound', 'ring', 'ringback', 'call volume', 'volume slider', 'call tone'],
      answer: 'Audio calls use three sounds from /sounds: call-ring.mp3 (incoming), call-ringback.mp3 (outgoing waiting), call-end.mp3 (ended). Public messages use computer.mp3, DMs use ui-alert.mp3.\n' +
        'Call card has a volume slider that sets remote audio element volume via setCallVolume (0-100). Card is draggable and stays visible while you keep chatting. Play() errors are caught to ignore autoplay policy.',
      action: {
        label: 'Open DMs',
        buttonId: 'btnDMs',
        popupId: 'dmSidebar',
        done: 'Opening DMs — volume is on the call card.'
      }
    },

    /* ---------- SLASH COMMANDS / DICE MATCHES ---------- */
    {
      id: 'slash-commands',
      title: 'Slash commands overview',
      keywords: ['slash command', 'slash commands', 'commands', 'slash', '/help', '/create-game', 'how to use slash'],
      answer: 'Every chat text bar (Arena publicMessage, roomMessageInput, dmInput, pmInput_<user>) supports slash commands powered by Hp dice-match endpoints (https://github.com/CyberFights/Hp).\n' +
        'Type "/" to see autocomplete popup (slash-popup) with header "⚔️ Slash commands — Hp dice match", up to 8 matches, arrow up/down to navigate, Tab or Enter to complete when first token is partial, Escape to close. Popup positioned above bar or below if no room, hides on resize or scroll outside. Event delegation works for dynamically created DM inputs via data-slash-bar.\n' +
        'Commands: /create-game [roomId] (start match you are fighter 1), /join-game [roomId] [playerId] (join), /move <attack|submission|escape|teasing|pin|recover> [roomId] (play turn, aliases /attack /submission /teasing /pin), /game-state [roomId] (show scoreboard), /end-game [roomId] [outcome], /end-all-games [outcome], /get-move [name|random] (SlamDB wrestling move database), /help or /commands (list all). Bare shortcuts /attack etc. map to /move. When text starts with "/", hidePopup and tryHandle returns true to consume it, delivering via ctx.deliver which emits roomMessage or privateMessage or appends local system message.',
      action: {
        label: 'Open the Arena',
        buttonId: 'btnOpenChat',
        popupId: 'chatPopup',
        done: 'Opening Arena — type /help for commands.'
      }
    },
    {
      id: 'dice-matches',
      title: 'Dice matches and moves',
      keywords: ['dice match', 'dice matches', 'chance match', 'match', 'fight', 'wrestle', 'move', 'hp match', 'dice fight', 'hp', 'stamina', 'health', 'create game', 'join game'],
      answer: 'Matches are run with slash commands typed straight into a chat box: /create-game starts one, /join-game joins, /move attack|submission|escape|teasing|pin|recover takes your turn, and /game-state shows the scoreboard.\n' +
        'Engine: each fighter 100 HP / 100 ST / 0 ♥ attraction. ATK/DEF from physique (see physique topic). Damage formula floor((roll*ATK - DEF)/DAMAGE_SCALE) clamped MIN_DAMAGE to DAMAGE_CAP, stamina cost floor(roll/2). Submission: roll deals damage + attraction + self recoil floor(selfRoll*defMultiplier). Escape: roll even = break free + counter attack. Teasing: no damage, builds attraction via floor(roll*atkMultiplier). Pin: roll checked against pinAllowedRolls based on current health % ( >75% all rolls kick out, >50% 1-5 kick, >25% 1-4, else only 1 and 6). Recover: rolls 4 dice sum restores HP & ST, only available when HP or ST <5, otherwise blocked. Next move hint: recover if HP/ST<5, escape if trapped in hold, else attack|submission|escape|teasing|pin.\n' +
        'One active match per room blocked until ended. Health, stamina and hormone bars appear above room feed while waiting, then move to draggable popup window (scoreboard-popup) when full (both fighters joined). Finish: HP zero → win/loss, both zero → tie double KO 🤝, pin hold → etc. Watch for 🏆 line. /end-game ends manually. Server proxy /api/hp/:action with HP_API_URL remote or embedded in-process engine (hpGames Map) sharing state across all players (not per-browser localStorage like old client). Finished games linger 30 min then swept.',
      action: {
        label: 'Open Rooms to start one',
        buttonId: 'btnRooms',
        popupId: 'roomsSidebar',
        done: 'Opening Rooms — create or open a room, then type /create-game.'
      }
    },
    {
      id: 'scoreboard',
      title: 'Dice match scoreboard and game panel',
      keywords: ['scoreboard', 'game panel', 'hp bar', 'stamina bar', 'hormone bar', 'match scoreboard', 'room game panel', 'scoreboard popup', 'bars'],
      answer: 'While a match waits for fighter 2, a compact card sits at top of room chat (roomGamePanel). It is pinned under chat-header via positionPanel and chat-body padded by its height so messages not hidden. Shows 🎮 MATCH · id and End match button, plus two player cards with HP/ST/HORMONE bars (barHtml width %). Waiting player shows "Waiting for fighter 2…" and full bars.\n' +
        'Once full (2 fighters), scoreboard moves to its own draggable popup window scoreboard-popup per room (scoreboardWindows map), stacked from top-right (96px + i*215px desktop, 64px + i*150px mobile ≤600px), draggable by header via makeScoreboardDraggable mouse/touch, restacked when one closes. Shows ATK/DEF stats when known, turn arrow ▶, status "▶️ name, your turn — /move ..." or finished "🏆 outcome winner". End match button confirms and calls endRoomGame which runs /end-game command and delivers via roomMessage. Dismissing live popup remembers dismissal (scoreboardDismissed) so polls don\'t pop back, but finished result always shows even after manual close and auto-closes after 25 sec linger (PANEL_LINGER_MS) calling GamePanels.remove. Background polling every 8 sec (PANEL_POLL_MS) fetches /api/hp/game-state for open windows + current room waiting card, skips when remote not configured (isRemoteConfigured via /api/hp-config). Cross-tab storage events for local-engine games sync all scoreboards via syncAllScoreboards. GamePanels registry localStorage mcf_hp_room_games_v1 stores id, players, state, updatedAt, carries physique stats across upserts.',
      action: {
        label: 'Open Rooms',
        buttonId: 'btnRooms',
        popupId: 'roomsSidebar',
        done: 'Opening Rooms — scoreboard appears above room chat.'
      }
    },
    {
      id: 'moves-database',
      title: 'Wrestling moves database — SlamDB',
      keywords: ['move database', 'slamdb', 'get-move', 'wrestling moves', 'move lookup', 'random move', 'pro move', 'move list'],
      answer: 'Type /get-move in any chat to use SlamDB (https://wrestling-moves-production.up.railway.app). No name → full list compact reference sorted by name (• name — category · difficulty) shown only to you (share false) with tip "/get-move <name> shows full card". With name → looks up exact slug (movesSlugify lowercases, removes quotes, non-alphanum to hyphen) via /api/moves/:slug then search ?q= via our proxy /api/get-move?move=name which does movesNamedMove. With "random" → fetches count via /api/moves?limit=1 then random offset. Result card: 🤼 MOVE ▸ name · category · difficulty, description, Origin, Made famous by list. Proxied via /api/get-move with timeout 8 sec, returns 404 if none, 502 if unreachable. Server movesFetch helper.',
      action: {
        label: 'Open the Arena',
        buttonId: 'btnOpenChat',
        popupId: 'chatPopup',
        done: 'Opening Arena — try /get-move random.'
      }
    },
    {
      id: 'slash-autocomplete',
      title: 'Slash autocomplete popup',
      keywords: ['autocomplete', 'slash popup', 'command suggestion', 'slash help', 'command list popup'],
      answer: 'When you type "/" in any chat bar, an autocomplete popup appears (div.slash-popup role listbox) with up to 8 matching commands filtered by first token prefix, including aliases. Shows slash-name (/create-game), usage remainder, desc. Positioned above bar, or below if no room above, width max 280–440 min rect width, left clamped 8px from edge. Navigation: ArrowDown/Up cycles sel class, Tab/Enter completes selected command (replaces first token, keeps rest, focuses and moves cursor to end, dispatches input event for typing indicators), Escape closes. While popup open first token partial, Enter/Tab complete instead of sending. When first token becomes full command name, popup hides so Enter sends/executes. Hide on input not starting with "/", on focusout delayed 120ms to allow click inside popup, on resize, on scroll outside (checks if target contains popup). Managed in slash-commands.js with BAR_IDS publicMessage, roomMessageInput, dmInput plus pmInput_ prefix and data-slash-bar.',
      action: {
        label: 'Open the Arena',
        buttonId: 'btnOpenChat',
        popupId: 'chatPopup',
        done: 'Opening Arena — type "/" to see suggestions.'
      }
    },

    /* ---------- EMOJI / IMAGES / CLIPS ---------- */
    {
      id: 'emoji',
      title: 'Emoji picker',
      keywords: ['emoji', 'emojis', 'emoticon', 'smiley', '😊', 'emoji picker', 'insert emoji'],
      answer: 'Press the 😊 button next to any message box (arena, DM or room) to open the emoji picker (emoji-picker.js). Click an emoji to drop it into your message at cursor position. Works for publicMessage, roomMessageInput, dmInput, pmInput_<user>. The picker is positioned near the button and closes on selection or outside click.',
      action: {
        label: 'Open the Arena',
        buttonId: 'btnOpenChat',
        popupId: 'chatPopup',
        done: 'Opening the Arena — the 😊 button is next to the message box.'
      }
    },
    {
      id: 'images',
      title: 'Sending images and clips overview',
      keywords: ['image', 'images', 'picture', 'pictures', 'photo', 'photos', 'upload', 'gif', 'clip', 'video', 'send image', 'send clip'],
      answer: 'DM and room windows have a 📷 button for images (5 MB max, ImgBB-hosted) and a 🎬 button for a GIF or short video (GIF 25 MB, video 50 MB MP4/WebM, total storage cap 2 GB, served from /clips/<32hex>.<ext> static with Range support for seeking).\n' +
        'Upload: image via POST /api/upload-image field image (multer memory), returns {ok, imageUrl (https://i.ibb.co/...), viewer}. Clip via POST /api/upload-clip field clip (multer disk uploads/clips), returns {ok, clipUrl (/clips/...), clipType gif|video, size}. Clip URLs validated isLocalClipUrl to prevent foreign injection. Server re-hosts Discord CDN images to ImgBB while signed URL valid to avoid 404 after ~24h expiry, and has /img proxy for hotlinked images to fix ORB blocking (Firefox OpaqueResponseBlocking) and Cloudflare __cf_bm cookie issues: /img?u=encodedUrl validates https and host in IMAGE_PROXY_HOSTS (ibb.co, i.ibb.co, image.ibb.co, cdn.discordapp.com, media.discordapp.net) or ends with .ibb.co, fetches with browser-ish UA, checks content-type image/* and size max 12 MB, streams with cache 86400 immutable, else returns 1x1 transparent PNG placeholder to avoid ORB. Fallback avatars generated via /avatar/:username (initials on profile colour) as PNG, rate limited 600/min.\n' +
        'Profile pictures and 10 extra profile photos are uploaded from Edit Profile instead and are ImgBB URLs stored on user document.',
      action: {
        label: 'Open DMs',
        buttonId: 'btnDMs',
        popupId: 'dmSidebar',
        done: 'Opening your DMs — 📷 sends an image, 🎬 sends a clip.'
      }
    },
    {
      id: 'image-proxy',
      title: 'Image proxy and fallback avatars',
      keywords: ['image proxy', '/img', 'proxy image', 'avatar fallback', 'initials avatar', 'transparent pixel', 'orb', 'cloudflare', 'imgbb'],
      answer: 'Remote images (ImgBB, Discord CDN) sometimes return HTML challenge pages behind Cloudflare, causing Firefox ORB to block. Server serves them through same-origin /img?u=url: validates https and host in IMAGE_PROXY_HOSTS, fetches with Accept image/* and UA MaleCyberFighters/1.0, checks content-type allowed image types png/jpeg/jpg/gif/webp/avif/bmp/svg+xml, size max 12 MB, streams with Cache-Control public max-age 86400 immutable, Cross-Origin-Resource-Policy same-origin, Referrer-Policy no-referrer, X-Content-Type-Options nosniff. On failure returns 1x1 transparent PNG (TRANSPARENT_PIXEL base64) with no-store to avoid ORB. Rate limited 600/min.\n' +
        'Fallback avatars: GET /avatar/:username renders initials PNG via renderInitialsAvatarPng (avatarInitial from display/username, color). Used for Discord webhook when sender has no photo, so Discord matches website identity. Also rate limited 600/min.',
      action: {
        label: 'Open the User Roster',
        buttonId: 'btnRoster',
        popupId: 'modalRoster',
        done: 'Opening Roster — avatars use the proxy when needed.'
      }
    },

    /* ---------- BEGINNERS GUIDE ---------- */
    {
      id: 'how-to-wrestle',
      title: 'How to cyber wrestle (beginner’s guide)',
      keywords: ['how to cyber wrestle', 'how do i cyber wrestle', 'cyber wrestle', 'cyber wrestling', 'how do i wrestle', 'how to wrestle', 'how do i fight', 'how to fight', 'beginner', 'beginners guide', 'beginner guide', 'new here', 'new to this', 'first match', 'first time', 'roleplay', 'role play', 'how does this work', 'how it works', 'getting started', 'start wrestling', 'write a match', 'rp', 'cyber fighting', 'eight rules', 'match styles', 'match style', 'no holds barred', 'nhb', 'pro wrestling', 'sub wrestling', 'accepted sub', 'catfight', 'apartment wrestling', 'kickboxing', 'death match', 'sexfight', 'erotic wrestling', 'first person', 'third person', 'yt', 'sell a move', 'selling', 'tap out', 'submission hold', 'gif match', 'guide'],
      answer: 'The Beginner’s Guide walks through all of it: what cyber wrestling is (text match, imagination, knowledge of holds, attention to position), setup (register, build fighter profile with bio, set physique ATK/DEF, learn holds via /get-move random, read Site Rules), finding opponent (Arena public chat bridged with Discord, User Roster, Forums, Custom Rooms), agreeing the match — the most important 2 minutes covering 6 things: style (freeform vs HP dice vs mix, then ruleset pro/sub/accepted sub/boxing/kickboxing/fistfight/NHB/anything goes/extreme/street/brawl/death match/catfight/rules catfight/apartment/erotic modifier foxy/tit boxing/sexfight/rule of real/multi-round/image GIF match), setting & gear (ring/mats/backyard/oil pit, trunks/singlets/jeans), tone & limits (roughness, flirty, adult, limits final), stakes optional, finish (pin three-count, submission tap/I give/I submit, KO HP zero, no-contest NC), house rules (actions per turn, yt signal, one fall vs best of three, time limit).\n' +
        'Writing the match: move = movement + 1-2 actions (attack: punch/kick/pro move/submission/pin/teasing, defense: escape/reversal), write attempts not outcomes (no godmodding), don\'t make moves for opponent, explain brutal finishes, check condition/position/flexibility before move, accept defeat, ask OOC if confused, sell (react to damage, no no-selling), rhythm (tennis not batting cage), signal end with yt (dice prints ▶️ Ty, your turn), first vs third person (I vs he/they/Marco, stay consistent), paint picture (exclamations, health, thoughts, position, asterisked aside), line breaks for drama (flurry over several lines), match pace (match opponent length/detail/tone), trash talk in-character playful.\n' +
        'Match styles menu detailed in guide sections 6, endings pin/submission/KO/NC, dice matches section 7 with all commands, eight rules section 8 (be realistic, check condition/position/flexibility, 1-2 actions per turn, end with yt, paint picture, take your time, keep private things private via DM, have fun), etiquette do/don\'t (agree before, write attempts, sell, keep ruleset, stay IC kind OOC, say one sec if away, honor limits, say GG; don\'t godmod, railroad, argue finish in public, take IC personally, push limits, pressure), after bell (say GG, debrief 60 sec, rematch, write up story via Build from messages, light formatting, approval conversation, share link/export, build card via relationships). Glossary defines all terms, quick-start checklist 7 steps.\n' +
        'Public page at /guide (canonical, index follow, OG tags, structured data WebPage+Article) and in-app modal modalGuide share same #guideBody markup via guide.js fetch /guide and inject innerHTML, styled via guide.css accent callout .guide-callout, .guide-example good/bad, code chips.',
      action: {
        label: 'Open the Beginner’s Guide',
        buttonId: 'btnGuide',
        popupId: 'modalGuide',
        done: 'Opening the Beginner’s Guide for you.'
      }
    },
    {
      id: 'match-styles',
      title: 'Match styles — full menu',
      keywords: ['match styles list', 'pro rules', 'sub rules', 'nhb rules', 'catfight rules', 'erotic rules', 'sexfight rules', 'boxing rules', 'kickboxing', 'apartment wrestling', 'death match rules'],
      answer: 'Styles are promises between players, not enforced by software:\n' +
        'Clean/technical: Pro wrestling (referee, no body punches/kicks/low blows, win by 3-count pin), Sub wrestling (same restrictions, win by submission tap/I give/I submit), Accepted sub (sub with referee acceptance, denied hold must release).\n' +
        'Striking: Boxing (punches only, clinch only grab, rounds+count), Kickboxing (punch+kick only, no elbows/knees/holds/throws, frontal face-to-face no back shots), Fistfight (any punch, nothing else, short brutal bloody, ends on damage).\n' +
        'No holds barred: NHB (legalize body punches/kicks/low blows on top of pro/sub, or own style anything goes, win by pin/sub/KO, goal hurt/dominate never hospitalize/kill), Anything goes (dirty angry spitting cursing but few conditions remain), Extreme/street/brawl (full NHB outside ring using whatever), Death match (extreme end, anything available, explicit unpressured yes only, stays fantasy, Site Rules still win).\n' +
        'Catfight/apartment: Catfight (hair pulling, scratching, clawing, biting, finish pin/sub/domination), Rules catfight (same with banned/limited attacks), Apartment wrestling (living room, no steel/weapons, bikinis/speedos tradition, lighter).\n' +
        'Erotic/sexfight: Erotic modifier (bolt onto any style: groping/rubbing/grinding as distraction or goal, say "erotic pro rules"), Foxy boxing/tit boxing (boxing with sexual element, second breast as weapon), Sexfight (sex organs vs sex organs, light wrestling to position, won by sexual submission usually orgasm, underneath normally cat/apartment), Rule of the real opt-in (what happens in match happens for real both ways, climax counts as fall decided before bell, only between adults yes, never pressure).\n' +
        'Formats: Multi-round best of 3 or first to 3, each round pin/sub/KO reset corners; Image/GIF match low-effort one line + image/GIF each turn trying to top other, flirty ones about finishing first.\n' +
        'How match ends: Pin (shoulders locked 3 sec, ref checks judges), Submission (hold can\'t/won\'t answer, conceded tap), KO (lights out via asphyxiation/breath control/accumulated damage, mostly NHB, dice HP zero 🏆), No-contest (someone must go, limit broken, stopped working, say NC, GG, book rematch).',
      action: {
        label: 'Open the Beginner’s Guide',
        buttonId: 'btnGuide',
        popupId: 'modalGuide',
        done: 'Opening the Beginner’s Guide — styles are section 6.'
      }
    },
    {
      id: 'eight-rules',
      title: 'The eight rules of cyber fighting',
      keywords: ['eight rules', '8 rules', 'rules of cyber fighting', 'cyber fighting rules', 'etiquette rules'],
      answer: 'The code the whole scene runs on, older than this site, enforced by whether people want to wrestle you again (Site Rules win if disagree):\n' +
        '1. Be realistic — no 10ft bulletproof, accept defeat, no sore losing, no refusing count.\n' +
        '2. Check condition, position, flexibility before every move, give fair chance to react/escape, don\'t make moves for them, ask if didn\'t understand, explain brutal/potentially harmful finish.\n' +
        '3. One or two actions per turn — don\'t overwhelm with long sequence, tennis not batting cage.\n' +
        '4. End turn with yt "your turn" — opponent waiting, without it match stalls; dice prints turn signal for you.\n' +
        '5. Paint picture — exclamations pain/glee/trash talk, current health/thoughts, where in ring, italic/asterisked aside hint twist, give audience something to watch and steer toward finish.\n' +
        '6. Take your time — type carefully, multiple lines if moment deserves, flurry over 4 short beats more suspenseful than one paragraph, obliges opponent to answer with real pain, match typing speed to action speed.\n' +
        '7. Keep private things private — if need to tell opponent something crowd shouldn\'t hear (company over, finish in 2 min, last move doesn\'t make sense) send as DM not in room, same as old IM/whisper etiquette.\n' +
        '8. Have fun — most important, outranks others, if stops being fun for either stop it — tap, GG, leave grudge in ring.',
      action: {
        label: 'Open the Beginner’s Guide',
        buttonId: 'btnGuide',
        popupId: 'modalGuide',
        done: 'Opening the Beginner’s Guide — eight rules are section 8.'
      }
    },

    /* ---------- SEARCH, PAGINATION, SOUNDS, TRANSLATION, ETC ---------- */
    {
      id: 'search',
      title: 'Search everywhere',
      keywords: ['search', 'find', 'filter', 'search users', 'search stories', 'search dms', 'search forums'],
      answer: 'Search exists in four places:\n' +
        'Roster: rosterSearch input filters username/display live, resets page 1.\n' +
        'DM sidebar: dmSearch filters partners live.\n' +
        'Archives: archivesSearch searches titles, story text and both usernames server-side with 300ms debounce, plus sort and Only my stories checkbox.\n' +
        'Forums: list is sorted by lastActivityAt but you can scan; recent forums card on home shows latest. All searches are case-insensitive.',
      action: {
        label: 'Open the User Roster',
        buttonId: 'btnRoster',
        popupId: 'modalRoster',
        done: 'Opening Roster — try the search box at the top.'
      }
    },
    {
      id: 'notifications',
      title: 'Sounds and notifications',
      keywords: ['notification', 'notifications', 'sound', 'sounds', 'alert', 'badge', 'unread', 'popup notification', 'dm notification'],
      answer: 'New arena messages play /sounds/computer.mp3, DMs play /sounds/ui-alert.mp3, calls play call-ring.mp3 (incoming), call-ringback.mp3 (outgoing), call-end.mp3 (ended) — all preloaded Audio with currentTime reset and catch for autoplay policy.\n' +
        'DM notification popup at top (dmNotification) shows 💬 New Direct Message @user, auto-hides 8 sec, click opens DM.\n' +
        'Unread counts show as badges: dmBadge on DMs button (total, 99+ cap) from cw_dm_unread localStorage + server dmUnread merge, and roomBadge_<id> on each room from cw_room_unread. Opening conversation clears its count and emits dmRead to server. Forums and presence updates are live via socket.',
      action: {
        label: 'Open DMs',
        buttonId: 'btnDMs',
        popupId: 'dmSidebar',
        done: 'Opening DMs — badges and sounds notify you.'
      }
    },
    {
      id: 'translation',
      title: 'Auto-translation',
      keywords: ['auto translate', 'translation', 'translate chat', 'google translate', 'language translation'],
      answer: 'Public and room messages are auto-translated to each member\'s selected language via Google Translate API. Server caches identical requests in pendingTranslations Map to translate once per language per message, not per recipient.\n' +
        'Sender always sees original. DMs store originalText and translated text. Translation errors fall back to original text. Language list includes 30+ languages.',
      action: {
        label: 'Open Edit Profile',
        buttonId: 'btnEditProfile',
        popupId: 'modalEditProfile',
        done: 'Set your language in Edit Profile to get auto-translation.'
      }
    },
    {
      id: 'presence-online',
      title: 'Who is online',
      keywords: ['who is online', 'online now', 'online list', 'online users', 'presence'],
      answer: 'The Arena header has an online list (onlineList) showing all users where online=true, with avatar, display, @username, PM button. Quick Roster on home shows 6. Roster modal shows all. Presence is broadcast via socket event presence after login, chatClosed, forceLogout, disconnect survivor logic, admin ban/delete. Each user entry includes username, display, imageUrl, extraPhotos, info, wins, losses, color, language, age, height, weight, createdAt.',
      action: {
        label: 'Open the Arena',
        buttonId: 'btnOpenChat',
        popupId: 'chatPopup',
        done: 'Opening Arena — online list is on the right.'
      }
    },

    /* ---------- APPS & PWA ---------- */
    {
      id: 'app-desktop',
      title: 'Desktop app',
      keywords: ['desktop app', 'download desktop', 'windows app', 'mac app', 'linux app', 'electron app', 'get desktop app'],
      answer: 'Footer has desktop download: Windows exe, macOS dmg, Linux AppImage from GitHub releases latest (https://github.com/CyberFights/malecyberfighters/releases/latest/download/CyberFights-win.exe etc). Built via .github/workflows/build-desktop.yml using Electron (electron/main.js). Same account, arena, rooms, DMs as website. Button id btnDownloadApp.',
      action: {
        label: 'Download desktop app',
        buttonId: 'btnDownloadApp',
        done: 'Opening the desktop download link.'
      }
    },
    {
      id: 'app-mobile',
      title: 'Mobile app and PWA install',
      keywords: ['mobile app', 'phone app', 'android app', 'ios app', 'iphone app', 'install app', 'pwa', 'install on device', 'apk', 'add to home screen'],
      answer: 'Footer has mobile app: "Install on this device" button btnInstallAppDesktop triggers PWA install via pwa-install.js (beforeinstallprompt). On iPhone/iPad use Share → Add to Home Screen. The PWA uses manifest.webmanifest (name Male Cyber Fighters, icons mcf-192.png, mcf-512.png), theme-color #020617, apple-mobile-web-app-capable yes, status bar black-translucent. Offline page offline.html shown when offline via sw.js service worker (cache no-cache for sw.js itself, /js and /css no-cache). Native Android APK and iOS builds are prepared in mobile release pipeline via .github/workflows/build-mobile.yml using Capacitor (mobile/capacitor.config.ts, package.json). Mobile UI served when Sec-CH-UA-Mobile ?1 or UA matches mobi|iphone|android|ipad|ipod|iemobile|opera mini|mobile, with CSS mobile.css vs desktop.css (v=9). Mobile page mobile.html and mobile2.html exist, plus www/index.html for Capacitor. Install hint text explains. The app uses same live account, arena, rooms, DMs.',
      action: {
        label: 'Install on this device',
        buttonId: 'btnInstallAppDesktop',
        done: 'Running the install step for this device.'
      }
    },
    {
      id: 'pwa',
      title: 'PWA features',
      keywords: ['pwa', 'service worker', 'manifest', 'offline', 'install prompt', 'app install'],
      answer: 'Site is a PWA: manifest.webmanifest with icons, display standalone, theme color. sw.js service worker caches for offline, serves offline.html when network fails. /js and /css served with no-cache headers to always get latest. pwa-install.js listens for beforeinstallprompt and shows Install button. On Android, prompt; on iOS, instructions to Add to Home Screen. Native wrapper via Capacitor for APK/IPA.',
      action: {
        label: 'Install on this device',
        buttonId: 'btnInstallAppDesktop',
        done: 'PWA install triggered.'
      }
    },

    /* ---------- UPDATES & HOME CARDS ---------- */
    {
      id: 'updates',
      title: 'Updates and changelog',
      keywords: ['updates', 'changelog', 'new features', 'what is new', 'upcoming', 'completed updates', 'todo', 'what changed'],
      answer: 'Home page has two lists: "UPCOMING CHANGES" div #updates loads /updates/todo.txt and "COMPLETED UPDATES" div #completedupdates loads /updates/completed.txt via updates.js with max-height 200px overflow auto pre-wrap. Shows what is being worked on and what shipped. To ask for something new, send a support report under "App Issue" (openSupport).',
      action: {
        label: 'Open a feature request',
        buttonId: 'openSupport',
        popupId: 'supportPopup',
        done: 'Opening the support report form — choose "App Issue" for a request.'
      }
    },
    {
      id: 'home-cards',
      title: 'New members and recent forums cards',
      keywords: ['new members', 'recent forums', 'recent posts', 'home cards', 'new users', 'latest forums'],
      answer: 'Home page below hero has two side-by-side cards (flex gap 16px wrap): New Members (#newMembersList max-height 260px) and Recent Forum Posts (#recentForumsList). Rendered by home-cards.js from /api/allUsers sorted newest and /api/forums latest. Each entry clickable to open profile or forum thread.',
      action: {
        label: 'Open the User Roster',
        buttonId: 'btnRoster',
        popupId: 'modalRoster',
        done: 'New members are on the home page and in the Roster.'
      }
    },

    /* ---------- ADMIN ---------- */
    {
      id: 'admin',
      title: 'Admin panel overview',
      keywords: ['admin', 'admin panel', 'administrator', 'moderator', 'admin login'],
      answer: 'The Admin Panel only appears for the Administrator account (username exactly "Administrator") — button btnAdmin hidden unless isAdministratorUser true via updateAdminButtonVisibility. It is protected by ADMIN_KEY env var via x-admin-key header (requireAdmin middleware returns 403 admin_denied if missing). Modal modalAdmin with tabs Users, Analytics, Stale images (tabUsers, tabAnalytics, tabStaleImages). Users view: search adminSearch, table adminTable columns Username, Email, Role, Height, Weight, Online, Banned, Actions (Ban toggle, Reset password prompt, Delete user confirm). Analytics view: statsSummary (totalUsers, onlineUsers, bannedUsers, totalLogs, last24h logins24h fails24h regs24h) via GET /api/admin/stats, Top IPs 24h via GET /api/admin/top-ips aggregate. Stale images view: description, Preview dry run button staleImagesPreview and Run sweep staleImagesRun, summary staleImagesSummary via POST /api/admin/sweep-stale-images?dryRun=1&limit=1000. Close via adminClose. Mobile version admin-mobile.js similar.',
      action: {
        label: 'Open a support report',
        buttonId: 'openSupport',
        popupId: 'supportPopup',
        done: 'Admin panel is only for Administrator — send a support report instead.'
      }
    },
    {
      id: 'admin-analytics',
      title: 'Admin analytics',
      keywords: ['analytics', 'stats', 'top ips', 'logins', 'registrations', 'admin stats', 'user count'],
      answer: 'Admin → Analytics tab shows: total users count, online users count, banned users count, total IpLog count, last 24h: logins (login_success), fails (login_fail/login_error/login_banned), regs (register). Fetched via GET /api/admin/stats with requireAdmin. Below that Top IPs 24h list from GET /api/admin/top-ips aggregate match createdAt >= since 24h, group by ip, sort count desc limit 10. IpLog schema {ip, username, action, userAgent, createdAt} logged via logIp helper using x-forwarded-for first or socket remoteAddress.',
      action: {
        label: 'Open a support report',
        buttonId: 'openSupport',
        popupId: 'supportPopup',
        done: 'Analytics is in Admin panel — here is support instead.'
      }
    },
    {
      id: 'admin-stale-images',
      title: 'Stale Discord images sweep',
      keywords: ['stale images', 'discord images expired', 'rehost images', 'imgbb rehost', 'clear broken images', 'sweep images'],
      answer: 'Discord attachment URLs expire ~24h after issue (signed is/ex params) and become 404. Admin → Stale images tab has Preview (dry run) and Run sweep buttons. Calls POST /api/admin/sweep-stale-images?dryRun=1&limit=1000 with requireAdmin. Server sweepStaleDiscordImages scans PublicMessage, RoomMessage, DM where imageUrl is string non-empty and isDiscordCdnUrl (host cdn.discordapp.com or media.discordapp.net). For each, calls rehostImageToImgBB which fetches image (15 sec timeout) with Accept image/* and UA, checks status ok and content-type image/* and size max 12 MB, then uploadImageToImgBB via base64 to ImgBB API. If rehosted.url exists → rehosted (update to ImgBB URL). Else if reason upstream_404/410 or bad_type → cleared (set imageUrl null) so broken <img> not rendered. Else skipped (timeout, no key, too large) leaves untouched to avoid dropping possibly-valid image. Summary returns scanned, rehosted, cleared, skipped, errors, items array with collection/id/from/to/action/reason. Requires IMGBB_API_KEY env var, else reason no_imgbb_key and skipped.',
      action: {
        label: 'Open a support report',
        buttonId: 'openSupport',
        popupId: 'supportPopup',
        done: 'Stale images sweep is admin-only — opening support instead.'
      }
    },

    /* ---------- SECURITY & EMAIL ---------- */
    {
      id: 'email',
      title: 'Emails — welcome and password reset',
      keywords: ['email', 'welcome email', 'reset email', 'transactional email', 'mail', 'smtp'],
      answer: 'Site sends transactional email only, no newsletters. Mailer.js uses SMTP if configured (mailerConfigured, MAIL_FROM). Welcome email on register: subject "Welcome to Male Cyber Fighters, username!" with text and html escaped. Password reset email via POST /api/forgot-password: deletes old unused tokens for email, creates PasswordReset {email, username, tokenHash SHA-256 of random 32 bytes hex, expiresAt now+1 hour, used false}, builds resetUrl baseUrl + "/reset-password.html?token=" + rawToken, baseUrl from APP_BASE_URL env or request x-forwarded-proto/protocol + host (trust proxy 1). Email subject "Reset your Male Cyber Fighters password" with button and link. On reset POST /api/reset-password {token, newPassword} validates tokenHash, checks expiresAt, hashes new password bcrypt 10, updates User, marks all tokens used true, forceLogout if socketId exists, logs reset_password. Token stored as hash only. Also admin alerts via sendAdminEmail if EMAIL_ADMIN_ALERTS true and mailerConfigured: new registration and other alerts to MAIL_FROM. No marketing lists.',
      action: {
        label: 'Open a support report',
        buttonId: 'openSupport',
        popupId: 'supportPopup',
        done: 'Emails are transactional only — if missing, check spam and support.'
      }
    },
    {
      id: 'security',
      title: 'Security — passwords, tokens, rate limiting, CSP',
      keywords: ['security', 'password hash', 'bcrypt', 'token hash', 'rate limiting', 'helmet', 'csp', 'auth limit', 'secure'],
      answer: 'Passwords stored as bcrypt hash (10 rounds), never plaintext. Password reset tokens stored as SHA-256 hash, expire 1 hour, single use, old tokens deleted on new request. Rate limiting: authLimiter 20 requests per 15 min on /api/login and /api/register (express-rate-limit standardHeaders true), imageProxyLimiter 600/min on /img, avatarLimiter 600/min on /avatar/:username. Helmet with CSP directives: defaultSrc self, scriptSrc self, scriptSrcAttr none, styleSrc self unsafe-inline, imgSrc self data: https://i.ibb.co https://ibb.co https://cdn.discordapp.com https://media.discordapp.net, connectSrc self ws: wss:, fontSrc self data:, frameAncestors self, frameSrc self, mediaSrc self, objectSrc none, upgradeInsecureRequests. CORS origin true credentials true. Trust proxy 1 for x-forwarded-for. Mongo connect serverSelectionTimeoutMS 5000 bufferTimeoutMS 5000 so DB-down answers fast not 30 sec. Socket handlers all try/catch to avoid unhandled rejection crashing process (Node 15+). Clip fileFilter only gif/mp4/webm, image upload only image/*, isLocalClipUrl regex prevents foreign URL injection, isImgBBUrl validates https and ibb.co host.',
      action: {
        label: 'Open the Site Rules',
        buttonId: 'btnRules',
        popupId: 'modalRules',
        done: 'Security details are in the rules and privacy policy.'
      }
    },

    /* ---------- MISC ---------- */
    {
      id: 'app',
      title: 'Getting the app',
      keywords: ['app', 'mobile app', 'desktop app', 'download', 'install', 'pwa', 'home screen', 'apk', 'get app'],
      answer: 'The footer has both: a desktop download (Windows .exe, macOS .dmg, Linux .AppImage from GitHub releases latest) and "Install on this device" for phones and tablets (PWA). On iPhone or iPad use Share, then "Add to Home Screen". The app uses the same account, arena, rooms and DMs as the website. See desktop app and mobile app topics for step-by-step.',
      action: {
        label: 'Install on this device',
        buttonId: 'btnInstallAppDesktop',
        done: 'Running the install step for this device.'
      }
    },
    {
      id: 'age',
      title: 'The 18+ gate',
      keywords: ['18', 'age', 'age gate', 'underage', 'adult', '18+ only'],
      answer: 'Male Cyber Fighters is an 18+ site, so everyone confirms their age on the way in via ageGate overlay with confirmBtn "Yes, Enter". Your age is also part of your profile and must be 18 or over, validated at registration and edit. The site has rating adult meta and isFamilyFriendly false in structured data.',
      action: null
    },
    {
      id: 'mobile-vs-desktop',
      title: 'Mobile vs desktop layout',
      keywords: ['mobile', 'desktop', 'phone', 'tablet', 'responsive', 'mobile.css', 'desktop.css', 'mobile layout'],
      answer: 'Server detects mobile via Sec-CH-UA-Mobile header ?1 (Accept-CH hint) or fallback UA regex /mobi|iphone|android|ipad|ipod|iemobile|opera mini|mobile/i. Serves index.html with link to mobile.css or desktop.css v=9. #mainUI is hidden mobile block (display none !important, hidden, aria-hidden true) containing duplicate action buttons, me-card with meAvatar/meName/meHandle and Edit/Settings, DM chat popup for mobile, app-download-card. Desktop .container has header brand logo 80px, actions, grid with hero card and side cards, userProfileCard. Both share same modals. Mobile.js and utils-mobile.js are mobile equivalents. Viewport-fit.js handles viewport. Logged-in profile card on mobile forced to flex column via media max-width 768px override.',
      action: null
    },
    {
      id: 'landing',
      title: 'Landing page and intro',
      keywords: ['landing', 'intro gif', 'landing page', 'intro', 'welcome'],
      answer: 'Index.html has #introGif element and landing.css/landing.js for intro animation. Age gate sits on top. Hero card explains site features: main public chatroom Arena connecting to Discord, customizable profiles, auto-translation, story creation from DMs and rooms, toxic-free zero tolerance. Updates and completed updates lists, new members and recent forums cards below.',
      action: null
    }
  ];

  var LOGIN_ACTION = {
    label: 'Open Login',
    buttonId: 'btnLogin',
    popupId: 'modalLogin',
    done: 'Opening the login window — sign in and ask me again.'
  };

  var QUICK_REPLIES = [
    { label: 'Open the Arena', text: 'open the arena' },
    { label: 'How do I cyber wrestle?', text: 'how do I cyber wrestle?' },
    { label: 'How do I DM someone?', text: 'how do I send a direct message?' },
    { label: 'Create a room', text: 'create a room' },
    { label: 'How do I edit my profile?', text: 'how do I edit my profile?' },
    { label: 'What are dice matches?', text: 'what are dice matches?' },
    { label: 'Report a problem', text: 'how do I report a problem?' },
    { label: 'How do I create a story?', text: 'how do I create a story?' },
    { label: 'How do forums work?', text: 'how do forums work?' },
    { label: 'How do I block someone?', text: 'how do I block someone?' }
  ];

  /* ---------------------------------------------------------
     MATCHING
  --------------------------------------------------------- */
  var QUESTION_RE = /\b(how|what|where|when|why|which|who|whose|is there|are there|do i|does it|can i|could i|should i|tell me|explain)\b|\?\s*$/;
  var ASKING_ASSISTANT_RE = /\b(can you|could you|would you|will you|please|pls|kindly)\b/;
  var ACTION_VERB_RE = /\b(open|show|go to|goto|take me|bring up|launch|start|load|jump to|switch to|log ?in|sign ?in|sign ?up|register|create|make|new|change|update|edit|add|send|join|report|block|install|download|reset)\b/;

  function normalise(text) {
    return ' ' +
      String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s']/g, ' ')
        .replace(/\s+/g, ' ')
        .trim() +
      ' ';
  }

  function scoreTopic(topic, haystack) {
    var score = 0;
    topic.keywords.forEach(function (keyword) {
      var needle = ' ' + keyword.toLowerCase() + ' ';
      if (haystack.indexOf(needle) === -1) return;
      // Longer phrases are a stronger signal than single words.
      score += keyword.indexOf(' ') === -1 ? 2 : 3 + keyword.split(' ').length;
    });
    return score;
  }

  function matchTopic(text) {
    var haystack = normalise(text);
    var best = null;
    TOPICS.forEach(function (topic) {
      var score = scoreTopic(topic, haystack);
      if (score > 0 && (!best || score > best.score)) {
        best = { topic: topic, score: score };
      }
    });
    return best;
  }

  /* "open the arena" opens it. "how do I open the arena?" explains it
     and offers a button, so the user is never pushed somewhere they
     only asked about. */
  function shouldOpenDirectly(text) {
    var haystack = normalise(text);
    if (!ACTION_VERB_RE.test(haystack)) return false;
    if (ASKING_ASSISTANT_RE.test(haystack)) return true;
    return !QUESTION_RE.test(haystack);
  }

  /* ---------------------------------------------------------
     RENDERING (no innerHTML — the transcript contains user text)
  --------------------------------------------------------- */
  function scrollMessages() {
    var list = byId('assistanceMessages');
    if (list) list.scrollTop = list.scrollHeight;
  }

  function addMessage(role, text, action) {
    var list = byId('assistanceMessages');
    if (!list) return null;

    var bubble = document.createElement('div');
    bubble.className = 'assistance-msg ' + role;

    String(text == null ? '' : text).split('\n').forEach(function (line) {
      var trimmed = line.trim();
      if (!trimmed) return;
      var paragraph = document.createElement('p');
      paragraph.textContent = trimmed;
      bubble.appendChild(paragraph);
    });

    if (action) {
      var bar = document.createElement('div');
      bar.className = 'assistance-actions';

      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'small-btn';
      button.textContent = action.label;
      button.addEventListener('click', function () {
        performAction(action);
      });

      bar.appendChild(button);
      bubble.appendChild(bar);
    }

    list.appendChild(bubble);
    scrollMessages();
    return bubble;
  }

  function showTyping() {
    var list = byId('assistanceMessages');
    if (!list || byId('assistanceTyping')) return;
    var bubble = document.createElement('div');
    bubble.className = 'assistance-msg assistant assistance-typing';
    bubble.id = 'assistanceTyping';
    bubble.textContent = 'Jax is typing…';
    list.appendChild(bubble);
    scrollMessages();
  }

  function hideTyping() {
    var typing = byId('assistanceTyping');
    if (typing && typing.parentElement) typing.parentElement.removeChild(typing);
  }

  /* ---------------------------------------------------------
     OPENING WINDOWS FOR THE USER
  --------------------------------------------------------- */
  function performAction(action) {
    if (!action) return false;

    var target = action.popupId ? byId(action.popupId) : null;
    var hasButton = controlsFor(action.buttonId).length > 0;
    if (!hasButton && !target) return false;

    // Step aside first so the window being opened is the one on
    // screen — Login, Register and Support sit earlier in the
    // document than this popup and would otherwise open behind it.
    close();

    var opened = openViaControl(action.buttonId, action.popupId);

    // No wired handler answered (or the control is gone from the
    // page): fall back to showing the window ourselves rather than
    // leaving the user with nothing.
    if (!opened && target) {
      target.style.display = 'flex';
      opened = true;
    }

    if (!opened) {
      open();
      addMessage(
        'assistant',
        'I could not reach that window from here. Try the button for it in the action row, or send a support report and the admins will pick it up.',
        {
          label: 'Open a support report',
          buttonId: 'openSupport',
          popupId: 'supportPopup',
          done: 'Opening the support report form for you.'
        }
      );
      return false;
    }

    if (action.then) {
      var followUpId = action.then;
      setTimeout(function () {
        var followUps = controlsFor(followUpId);
        if (followUps.length) followUps[0].click();
      }, 80);
    }

    return true;
  }

  function answerTopic(topic, text) {
    var action = topic.action || null;

    if (action && topic.requiresLogin && !getSessionSafe()) {
      addMessage(
        'assistant',
        topic.answer +
          '\nYou are signed out in this browser, so sign in first and I will take you straight there.',
        LOGIN_ACTION
      );
      return;
    }

    if (action && shouldOpenDirectly(text)) {
      addMessage('assistant', action.done || topic.answer);
      performAction(action);
      return;
    }

    addMessage('assistant', topic.answer, action);
  }

  function answerUnknown(text) {
    addMessage(
      'assistant',
      'I do not have an answer for "' + text + '" yet.\n' +
        'I can help with everything on the site: Age gate 18+, Login, Register (username/email/password/display/age/bio/colour/language/wins/losses/height 3\'5"-8\'0" weight 60-700 lbs/main image/extra photos up to 10), Forgot/Reset password (1-hour link, resend), Change password, Account Settings (change password min 6, delete account permanent cleanup), Arena public chat (send, reply bar, edit own messages with edited marker, emoji 😊, online list, presence broadcast, minimize _, close X marks offline but keeps session, beforeunload offline, sound computer.mp3, translation per language), User Roster (search rosterSearch, pagination 12 per page, quick roster 6, new members card), View Profile (avatar 150px holo, @username, display, age, height, weight, colour box, language, bio, wins/losses, Message User, Block User, extra photos gallery popup window, Stories approved, Relationships, Timeline, Add relationship types rival/friend/opponent/tagteam/dating/married/sibling/parent/owner), Edit Profile (all fields, height menu populated by physique.js, weight, bio, colour, language 30+, wins/losses, main image upload /api/upload-image 5MB ImgBB, extra photos via /api/profile/photos immediate save, status), Physique (height string 5\'11", weight lbs, rules in physique.js), Combat stats ATK=height(m)*sqrt(weight kg) DEF=weight kg/height(m) baseline 5\'11"/185lb ATK 16.52 DEF 46.53 saved on user, /api/combat-stats?usernames= max 20, multipliers, DAMAGE_CAP/MIN_DAMAGE/DAMAGE_SCALE, scoreboard shows ATK/DEF), Language & translation (auto-translate via Google Translate cached pendingTranslations, sender sees original), Discord linking (Discord User ID snowflake 16-25 digits, accepts <@id> <@!id> @id, rejects username tags, help Developer Mode Copy ID, linked for Arena bridge and DM bridge), Discord bridge (Arena ↔ UGCW Discord invite discord.gg/Y3VRjcw, webhook via DISCORD_WEBHOOK_URL with avatar via /img proxy or /avatar/:username initials PNG, DM bridge via discordBot sendDiscordDM and setupDiscordListener, reply syntax @username message, re-hosts images to ImgBB), DMs (sidebar dmSidebar, search dmSearch, badge dmBadge total 99+ cap, server-synced unread dmSeen dmUnreadSince via dmUnread event and dmRead emit, notification popup dmNotification 💬 8 sec auto-hide click to open, sound ui-alert.mp3, typing indicator typingDM/stopTypingDM 1200ms, image 📷 5MB ImgBB, clip 🎬 GIF 25MB video 50MB MP4/WebM /clips/32hex.ext total cap 2GB Range support, emoji 😊, Call ☎, Story button, Clear history /api/dm/clear, draggable movable z-index 1050+ cascade 28px), Rooms (roomsSidebar, sort roomSort newest/oldest/AZ/ZA, filter private owner/invitedUsers case-insensitive, Create Room prompt name + confirm private, Invite button owner only via inviteToRoom and roomInvited alert, joinRoom validates canAccessRoom and ObjectId, leaveRoom, requestRoomMembers, system messages join/leave type system centered muted not badged, members panel roomMembers with avatar 32px display @username online dot via updateRoomMembers fetchSockets, feed roomFeed, reply bar roomReplyBar, typing roomTyping, input roomMessageInput, Send roomSendBtn, image roomImageInput/roomImageBtn, clip roomClipInput/roomClipBtn, emoji, game panel roomGamePanel waiting card pinned under header with padding, Conference call roomCallBtn via room-audio-invite/join, unread badges roomBadge_<id> from cw_room_unread), Forums (forumsPopup, status, list forumsList live via forumsList/forumCreated/forumReplyCreated, New Forum newForumBtn → newForumModal title max 160 body max 10000, Create via POST /api/forums author check not banned, thread forumThreadPopup data-forum-id Back/Close, GET /api/forums/:forumId, original post forumOriginalPost, replies forumReplies, reply composer forumReplyBody max 5000 Post Response via POST /api/forums/:forumId/replies, lastActivityAt bumps), Stories (create from DM Story button or room, editor StoryUI.openEditor in storyPopup mcf-story-backdrop shared desktop/mobile, title max 120 body max 20000 counter chars/words/read mins, toolbar Bold ** Italic * Quote > Heading ## Break ---, surround/insertLine, Ctrl+B/I/S, clip attach via /api/upload-clip preview, Build from messages toggle 📥 date range fromDate/toDate, Load messages POST /api/story/load participant check bounded capped, search filter, speaker Everyone/Only you/Only them, style Script **Name:** vs Log [time] Name:, timestamps checkbox, scene breaks checkbox, aliases character names for @you/@them, Rename in story regex replace, message list 260px checkboxes picked Set survives filter, actions Add to story append at cursor glue newlines, Replace confirm, Select all/none/Invert, draft per conversation/edit in localStorage mcf.story.draft.<user>.<partner> or edit.<id> with updatedAt, auto-save 1200ms, banner with Restore/Discard if differs, >30 days ignored, beforeunload guard, close confirm if dirty, preview opens viewer, save via POST /api/story/save or /api/story/update validates length partner exists not owner check declined check, revision bumps, wasPublished flag, toast, onSaved/onDeleted callbacks, approval flow: server creates Story owner/partner approvalOwner true approvalPartner false approved false revision 0, emits storyApprovalRequest to partner socketId and system DM type storyApproval with Approve/Decline/Read buttons, partner approves via POST /api/story/approve sets approvalPartner true both → approved true approvedAt now emits storyStatusChanged, decline via POST /api/story/decline with reason max 500 sets declined true declinedBy declineReason approved false, resend via POST /api/story/resend, delete via POST /api/story/delete owner check, editing approved re-opens approval), Pending/Declined on profile (selfProfileStories selfProfilePendingStories via GET /api/story/list and /api/story/pending returns stories and declined, renderPendingList shows waiting for @other or @other waiting for you, revision count, actions Read/Edit/Resend/Withdraw/Approve/Decline, declined shows declined by @user date and reason in quotes and Revise & resubmit), Viewer (backdrop storyViewerPopup, panel mcf-story-viewer 720px max 92vh, head title Great Vibes script 40px font-face /fonts/great-vibes.woff2 not Google due CSP, byline @owner with @partner date revision chip declined chip, close X absolute, tools A- A+ fontSize localStorage mcf.story.fontScale 0.8-1.8 step 0.1 applied 15px*scale, Prev/Next disabled when readingList <=1 or ends, Copy link via clipboard fallback textarea execCommand, Export markdown via storyAsPlainText blob download sanitized filename, Print via new window print(), scroll mcf-story-scroll with renderStoryBody safe escaped then inlineFormat, clip max-height 38vh centered, footer Story N of M and Close, keys Escape closes, ArrowLeft/Right steps), Permalink /story/:id (server validates ObjectId, fetches approved story, injects OG title description url Twitter tags robots noindex follow, serves index.html with mobile/desktop CSS, client boot openFromUrl checks pathname /story/24hex and hash #story=24hex, fetchStory GET /api/story/:id?username=, opens viewer, toast if not available, readingList for Prev/Next via fetchArchives perPage 50), Archives (modalArchives, search archivesSearch 300ms debounce q, sort archivesSort recent/oldest/title/author, checkbox archivesMine participant filter, list archivesList, pagination archivesPrev/Next pageLabel Page X/Y · N stories totalPages server-side, fetchArchives via GET /api/story/archives?q=&page=&perPage=&participant=&sort= returns stories total page perPage totalPages, empty messages, renderStoryList with Read/Link/Edit/Delete), Relationships (types rival/friend/opponent/tagteam/dating/married/sibling/parent/owner, request via POST /api/relationship/request, live popup if online else SYSTEM DM relationshipApproval with Approve button, approve via POST /api/relationship/approve, lists via GET /api/relationship/list approved only and /api/relationship/pending requester not approved, timeline via GET /api/relationship/timeline sorted asc mapped id/type/with/role/approvedAt, rendered in profile), Blocking (vpBlockButton confirm, POST /api/block-user $addToSet blockedUsers, server privateMessage checks receiver.blockedUsers includes from drops and logs, unblock via POST /api/unblock-user $pull), Support (supportPopup, type srType user/issue toggles srUserSection, fields srUser Who, srWhere Where placeholder Public chat/DM/room etc, srWhen datetime-local, srInfo Additional Information placeholder Describe..., srSubmit builds payload from→Administrator text formatted and POST /api/send-dm creates DM and emitToUser + forwardDMToDiscord + Discord Support webhook + email admin alert if EMAIL_ADMIN_ALERTS), Rules/TOS/Privacy modals (btnRules/modalRules, btnTOS/modalTOS, btnPrivacy/modalPrivacy with full texts, zero tolerance), Audio calls (audio-calls.js, DM call pm-call dmCall, room conference roomCallBtn, signaling audio-call-signal {to,kind,offer,answer,candidate} relayed only to target socketId via User lookup, room-audio-invite to socket.to(room), room-audio-join to target socketId, audio-call-end, getLocalStream getUserMedia, RTCPeerConnection, floating card draggable volume slider, Connected status, sounds call-ring ringback call-end), Slash commands (slash-commands.js, tryHandle, ctx kind public/room/dm with room/target/input/deliver, commands: /create-game [roomId] default this room or dm-<me>-<other> sorted or game-<random>, one active match per room blocked until ended, auto join creator as fighter 1, GamePanels registry localStorage mcf_hp_room_games_v1 id/players/state/updatedAt, remember last game LAST_GAME_KEY mcf_hp_last_game, resolveGameRoom explicit or last or default, requireRoom, requireLogin, hpAction tries remote via /api/hp-config {configured,remote} and /api/hp/:action proxy 8 sec timeout fallback to local engine on 502/503/network error but Hp-level errors thrown as _hp, local engine faithful mirror of CyberFights/Hp server.js stateless roll/submit/escape/pin-escape/tease/recover and server2.js stateful create-game/join-game/dice-match/game-state/end-game/end-all-games with games in localStorage mcf_hp_games_v1, damage formula, pinAllowedRolls, hold type pin/submission, finished tie/win/loss/ko, turnIndex, localTag ⚙️ local engine, formatters for each command with share true/false, echoLocal for non-shared output div.message-row.slash-system slash-local-msg, feedFor, defaultRoomId, lastGameRoom, rememberGameRoom, slotForPlayer, nextMoveHint recover if HP/ST<5 else escape if trapped else attack|submission|escape|teasing|pin, statSuffix, slotNeedsStats, stateMissingPlayers, fetchCombatStats /api/combat-stats, applyStatsToState, refreshLocalGameStats, deliverRoomMessage, endRoomGame, panelDefaultPlayer/State, barHtml, playerHtml, panelWaitingHtml, bindPanelButtons, positionPanel, hidePanelEl/showPanelEl, GamePanels loadReg/saveReg/get/hasActive/upsert/markFinished/finalizeAll/scheduleFinalize/remove/renderInline/syncToRoom, fillEntryStats, tickScoreboardPoll polling game-state for open scoreboard windows + current room waiting, ensureScoreboardPolling interval 8 sec, observeRoomPopup MutationObserver on roomChatPopup data-room/style/class/hidden, roomPopupSignature, scoreboardEnsure/create draggable window scoreboard-popup with head title and End/Close buttons, scoreboardRender, scoreboardDismiss manual remembers dismissed, syncScoreboardUi finished always shows result even after manual close auto-close 25 sec, full shows live unless dismissed, waiting no window, syncAllScoreboards, restack, makeScoreboardDraggable), Moves database (SlamDB, /get-move, movesSlugify, movesFetch, movesRandomMove count then offset, movesListAll paging 100, movesNamedMove slug then q, proxy /api/get-move timeout 8 sec, formatters get-move card and get-move-list compact sorted), Autocomplete (slash-popup role listbox header ⚔️, slash-item sel, slash-name/usage/desc, positioned above/below, width 280-440, left clamped, top, visibility hidden to measure, hidePopup, renderPopup, syncPopup filters COMMANDS by prefix including aliases, completeWith replaces first token keeps rest focuses sets cursor dispatches input event, event listeners input focusin focusout delayed 120ms, keydown ArrowDown/Up Tab/Enter Escape while open, resize and scroll outside handlers), Images/Clips (image 5MB ImgBB via uploadImageToServer FormData, clip 25/50MB via uploadClipToServer, isClipFile, createClipElement img/video, clipElement local fallback, uploadClip fallback, /img proxy IMAGE_PROXY_HOSTS ibb.co etc 12MB max allowed image types png/jpeg/jpg/gif/webp/avif/bmp/svg+xml, placeholder transparent pixel 1x1 PNG base64 no-store, rate limits, /avatar/:username initials PNG), Sounds/Notifications (computer.mp3 public, ui-alert.mp3 DM, call sounds, badges), Apps (desktop download btnDownloadApp GitHub releases, mobile install btnInstallAppDesktop via pwa-install.js beforeinstallprompt, iOS Share Add to Home Screen, APK, Capacitor mobile/capacitor.config.ts, mobile.html mobile2.html www/index.html, workflows build-desktop.yml build-mobile.yml, footer download-apps), PWA (manifest.webmanifest icons mcf-192 mcf-512, theme-color #020617, apple-mobile-web-app-capable, sw.js no-cache, /js /css no-cache, offline.html, viewport-fit.js), Updates (updates.js loads /updates/todo.txt and /updates/completed.txt into #updates #completedupdates max-height 200px pre-wrap), Home cards (home-cards.js newMembersList recentForumsList), Search/Pagination (12 per page), Security (bcrypt, SHA-256 token hash, rate limits, helmet CSP, CORS, trust proxy, bufferTimeoutMS), Mobile vs desktop (isMobileClient Sec-CH-UA-Mobile ?1 else UA regex, Accept-CH header, Vary User-Agent Sec-CH-UA-Mobile, mainUI hidden), Idle logout (idle-logout.js), Email (mailer.js mailerConfigured MAIL_FROM escapeHtml sendMail transactional welcome reset admin alerts EMAIL_ADMIN_ALERTS), Misc (landing.html landing.css landing.js introGif, guide.css, slash-commands.css audio-calls.css desktop.css mobile.css, guide.html public page canonical /guide with structured data, storyRoutes.js storyService.js, dmDelivery.js createDmDelivery userRoom emitToUser markDMRead getUnreadDMCounts, discordBot.js sendDiscordDM discordEvents, discordWebhook.js buildWebhookPayload publicBaseUrlFromSocket resolveWebhookAvatarUrl avatarInitial renderInitialsAvatarPng, mailer.js, setupDiscordListener, image-proxy.js imgSrc direct-first with retry via proxy, emoji-picker.js, viewport-fit.js, popup-dissolve.js, download.js, pwa-install.js, etc).\n' +
        'If it is a bug or something you want added, send it to the admins as a support report.',
      {
        label: 'Open a support report',
        buttonId: 'openSupport',
        popupId: 'supportPopup',
        done: 'Opening the support report form for you.'
      }
    );
  }

  var LOGIN_ACTION = {
    label: 'Open Login',
    buttonId: 'btnLogin',
    popupId: 'modalLogin',
    done: 'Opening the login window — sign in and ask me again.'
  };

  var QUICK_REPLIES = [
    { label: 'Open the Arena', text: 'open the arena' },
    { label: 'How do I cyber wrestle?', text: 'how do I cyber wrestle?' },
    { label: 'How do I DM someone?', text: 'how do I send a direct message?' },
    { label: 'Create a room', text: 'create a room' },
    { label: 'How do I edit my profile?', text: 'how do I edit my profile?' },
    { label: 'What are dice matches?', text: 'what are dice matches?' },
    { label: 'Report a problem', text: 'how do I report a problem?' },
    { label: 'How do I create a story?', text: 'how do I create a story?' },
    { label: 'How do forums work?', text: 'how do forums work?' },
    { label: 'How do I block someone?', text: 'how do I block someone?' }
  ];

  /* ---------------------------------------------------------
     MATCHING
  --------------------------------------------------------- */
  var QUESTION_RE = /\b(how|what|where|when|why|which|who|whose|is there|are there|do i|does it|can i|could i|should i|tell me|explain)\b|\?\s*$/;
  var ASKING_ASSISTANT_RE = /\b(can you|could you|would you|will you|please|pls|kindly)\b/;
  var ACTION_VERB_RE = /\b(open|show|go to|goto|take me|bring up|launch|start|load|jump to|switch to|log ?in|sign ?in|sign ?up|register|create|make|new|change|update|edit|add|send|join|report|block|install|download|reset)\b/;

  function normalise(text) {
    return ' ' +
      String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s']/g, ' ')
        .replace(/\s+/g, ' ')
        .trim() +
      ' ';
  }

  function scoreTopic(topic, haystack) {
    var score = 0;
    topic.keywords.forEach(function (keyword) {
      var needle = ' ' + keyword.toLowerCase() + ' ';
      if (haystack.indexOf(needle) === -1) return;
      // Longer phrases are a stronger signal than single words.
      score += keyword.indexOf(' ') === -1 ? 2 : 3 + keyword.split(' ').length;
    });
    return score;
  }

  function matchTopic(text) {
    var haystack = normalise(text);
    var best = null;
    TOPICS.forEach(function (topic) {
      var score = scoreTopic(topic, haystack);
      if (score > 0 && (!best || score > best.score)) {
        best = { topic: topic, score: score };
      }
    });
    return best;
  }

  /* "open the arena" opens it. "how do I open the arena?" explains it
     and offers a button, so the user is never pushed somewhere they
     only asked about. */
  function shouldOpenDirectly(text) {
    var haystack = normalise(text);
    if (!ACTION_VERB_RE.test(haystack)) return false;
    if (ASKING_ASSISTANT_RE.test(haystack)) return true;
    return !QUESTION_RE.test(haystack);
  }

  /* ---------------------------------------------------------
     RENDERING (no innerHTML — the transcript contains user text)
  --------------------------------------------------------- */
  function scrollMessages() {
    var list = byId('assistanceMessages');
    if (list) list.scrollTop = list.scrollHeight;
  }

  function addMessage(role, text, action) {
    var list = byId('assistanceMessages');
    if (!list) return null;

    var bubble = document.createElement('div');
    bubble.className = 'assistance-msg ' + role;

    String(text == null ? '' : text).split('\n').forEach(function (line) {
      var trimmed = line.trim();
      if (!trimmed) return;
      var paragraph = document.createElement('p');
      paragraph.textContent = trimmed;
      bubble.appendChild(paragraph);
    });

    if (action) {
      var bar = document.createElement('div');
      bar.className = 'assistance-actions';

      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'small-btn';
      button.textContent = action.label;
      button.addEventListener('click', function () {
        performAction(action);
      });

      bar.appendChild(button);
      bubble.appendChild(bar);
    }

    list.appendChild(bubble);
    scrollMessages();
    return bubble;
  }

  function showTyping() {
    var list = byId('assistanceMessages');
    if (!list || byId('assistanceTyping')) return;
    var bubble = document.createElement('div');
    bubble.className = 'assistance-msg assistant assistance-typing';
    bubble.id = 'assistanceTyping';
    bubble.textContent = 'Jax is typing…';
    list.appendChild(bubble);
    scrollMessages();
  }

  function hideTyping() {
    var typing = byId('assistanceTyping');
    if (typing && typing.parentElement) typing.parentElement.removeChild(typing);
  }

  /* ---------------------------------------------------------
     OPENING WINDOWS FOR THE USER
  --------------------------------------------------------- */
  function performAction(action) {
    if (!action) return false;

    var target = action.popupId ? byId(action.popupId) : null;
    var hasButton = controlsFor(action.buttonId).length > 0;
    if (!hasButton && !target) return false;

    // Step aside first so the window being opened is the one on
    // screen — Login, Register and Support sit earlier in the
    // document than this popup and would otherwise open behind it.
    close();

    var opened = openViaControl(action.buttonId, action.popupId);

    // No wired handler answered (or the control is gone from the
    // page): fall back to showing the window ourselves rather than
    // leaving the user with nothing.
    if (!opened && target) {
      target.style.display = 'flex';
      opened = true;
    }

    if (!opened) {
      open();
      addMessage(
        'assistant',
        'I could not reach that window from here. Try the button for it in the action row, or send a support report and the admins will pick it up.',
        {
          label: 'Open a support report',
          buttonId: 'openSupport',
          popupId: 'supportPopup',
          done: 'Opening the support report form for you.'
        }
      );
      return false;
    }

    if (action.then) {
      var followUpId = action.then;
      setTimeout(function () {
        var followUps = controlsFor(followUpId);
        if (followUps.length) followUps[0].click();
      }, 80);
    }

    return true;
  }

  function answerTopic(topic, text) {
    var action = topic.action || null;

    if (action && topic.requiresLogin && !getSessionSafe()) {
      addMessage(
        'assistant',
        topic.answer +
          '\nYou are signed out in this browser, so sign in first and I will take you straight there.',
        LOGIN_ACTION
      );
      return;
    }

    if (action && shouldOpenDirectly(text)) {
      addMessage('assistant', action.done || topic.answer);
      performAction(action);
      return;
    }

    addMessage('assistant', topic.answer, action);
  }

  function answerUnknown(text) {
    addMessage(
      'assistant',
      'I do not have an answer for "' + text + '" yet.\n' +
        'I can help with the Arena, DMs, Rooms, Forums, the User Roster, story Archives, profiles, dice matches, calls, the rules, and the beginner’s guide to cyber wrestling.\n' +
        'Try asking: how do I send a DM, create a room, edit my profile, start a dice match, create a story, search archives, block a user, link Discord, change my password, install the app, report a problem, or how do I cyber wrestle.\n' +
        'If it is a bug or something you want added, send it to the admins as a support report.',
      {
        label: 'Open a support report',
        buttonId: 'openSupport',
        popupId: 'supportPopup',
        done: 'Opening the support report form for you.'
      }
    );
  }

  /* ---------------------------------------------------------
     CHAT FLOW
  --------------------------------------------------------- */
  function handleQuestion(raw, displayText) {
    var text = String(raw == null ? '' : raw).trim();
    if (!text) return;

    // Quick-question chips show the label that was clicked rather than the
    // wording they ask with.
    addMessage('user', String(displayText == null ? text : displayText).trim());
    showTyping();

    setTimeout(function () {
      hideTyping();
      var match = matchTopic(text);
      if (match) {
        answerTopic(match.topic, text);
      } else {
        answerUnknown(text);
      }
    }, REPLY_DELAY_MS);
  }

  function send() {
    var input = byId('assistanceInput');
    if (!input) return;
    var text = input.value;
    if (!String(text).trim()) return;
    input.value = '';
    handleQuestion(text);
  }

  function renderQuickReplies() {
    var bar = byId('assistanceQuickReplies');
    if (!bar || bar.childNodes.length) return;

    QUICK_REPLIES.forEach(function (reply) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'ghost small-btn';
      chip.textContent = reply.label;
      chip.addEventListener('click', function () {
        handleQuestion(reply.text, reply.label);
      });
      bar.appendChild(chip);
    });
  }

  var greeted = false;

  function greet() {
    greeted = true;
    addMessage(
      'assistant',
      'Hey — I am Jax, the support assistant for Male Cyber Fighters.\n' +
        'Ask me how anything on the site works and I will walk you through it, or tell me to open something and I will open that window for you.\n' +
        'I know every feature: Arena public chat with reply/edit/emoji/translation/sounds/online list, DMs with search/badges/notifications/typing/images/clips/calls/draggable windows, Rooms with sort/create/invite/members/system messages/unread/conference calls, Forums with new threads and replies, Story creation from DMs with message picker/aliases/formatting/clips/drafts/approval/declined revise/permalinks/archives search sort pagination/viewer with copy link/export/print/font size, Relationships with timeline, Blocking, Support reports, Rules/TOS/Privacy, Physique height 3\'5"-8\'0" weight 60-700 lbs ATK/DEF combat stats, Slash commands /create-game /join-game /move /game-state /end-game /get-move /help with autocomplete and scoreboard HP/ST/Hormone bars, Discord bridge with UGCW, Image proxy /img and avatar fallback, Apps desktop Windows/macOS/Linux and mobile PWA install, Admin panel, Security, Translation, and the full Beginner\'s Guide.'
    );
    renderQuickReplies();
  }

  function pickImage() {
    return IMAGES[Math.floor(Math.random() * IMAGES.length)];
  }

  function isOpen() {
    var popup = byId(POPUP_ID);
    return !!popup && popup.style.display === 'flex';
  }

  function open() {
    var popup = byId(POPUP_ID);
    if (!popup) return;

    // A fresh portrait every time the window opens.
    var image = byId('assistanceImage');
    if (image) image.src = pickImage();

    if (!greeted) greet();

    popup.style.display = 'flex';
    scrollMessages();

    var input = byId('assistanceInput');
    if (input) {
      try { input.focus(); } catch (e) { /* focus is a nicety */ }
    }
  }

  function close() {
    var popup = byId(POPUP_ID);
    if (popup) popup.style.display = 'none';
  }

  function bind() {
    var popup = byId(POPUP_ID);

    // The action row exists twice in the page (mobile block + desktop
    // header); wire every copy of the button.
    Array.prototype.forEach.call(
      document.querySelectorAll('[id="btnAssistance"]'),
      function (button) {
        button.addEventListener('click', open);
      }
    );

    byId('assistanceClose')?.addEventListener('click', close);
    byId('assistanceSend')?.addEventListener('click', send);

    byId('assistanceInput')?.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        send();
      }
    });

    // Clicking the dimmed area around the panel closes it, like the
    // forums and rooms windows do.
    popup?.addEventListener('click', function (event) {
      if (event.target === event.currentTarget) close();
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && isOpen()) close();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }

  /* Other scripts (and the tests) can drive the assistant directly. */
  window.Assistance = {
    open: open,
    close: close,
    ask: handleQuestion,
    isOpen: isOpen,
    images: IMAGES.slice(),
    topics: TOPICS,
    pickImage: pickImage
  };
})();
