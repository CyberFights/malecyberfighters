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

   Answers are written for members, not for developers: they say
   where a thing lives, what to press and what happens — never the
   element ids, endpoints, socket events or database details behind
   it. Keep them that way when adding topics.
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

  function isAdminSafe() {
    try {
      var sess = getSessionSafe();
      if (!sess) return false;
      var name = sess.username || sess.user || '';
      return name === 'Administrator';
    } catch (e) {
      return false;
    }
  }

  function isAdminTopic(topic) {
    return !!(topic && topic.requiresAdmin);
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
                boundaries, so "room" will not match "bedroom").
                Articles and simple plurals are tolerated inside a
                phrase, so "create a story" and "create stories" both
                reach the "create story" keyword
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
      answer: 'Male Cyber Fighters is strictly 18+. The first time you load the site a full-screen check asks whether you are 18 or older.\n' +
        'Press "Yes, Enter" to go through — your browser remembers the answer. If you are under 18 you must leave.\n' +
        'The age on your profile has to be 18 or over as well, and it is checked when you register.',
      action: null
    },
    {
      id: 'login',
      title: 'Signing in',
      keywords: ['login', 'log in', 'sign in', 'signing in', 'log on', 'sign on'],
      answer: 'Press Login in the action row and enter your username and password.\n' +
        'Once you are in, your profile card appears, you show as online, and your DMs and Rooms come to life.\n' +
        'If you have forgotten your password, use the "Forgot password?" link at the bottom of that window.',
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
      answer: 'Press Register in the action row and fill in the form: username, email, password, display name, age (18+), a short bio, your favourite colour, language, wins and losses, height and weight, and a profile photo if you like.\n' +
        'Press Create Account and you are in. Everything can be changed later from Edit Profile, and you get a welcome email if the site\'s email is set up.\n' +
        'Height runs from 3\'5" to 8\'0" in one-inch steps and weight is whole pounds, 60 to 700; those two set your fighter stats.',
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
      answer: 'Press Login, then "Forgot password?", enter the email address on your account and press "Send reset link".\n' +
        'The email arrives with a link that works for one hour — check your spam folder if you do not see it. Open the link and choose a new password (at least 6 characters).\n' +
        'If nothing arrives, try "Resend email" or send a support report and the admins will help.',
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
      answer: 'Open Account Settings from the ⚙️ button on your profile card.\n' +
        'In the Change password section type your current password, then your new one twice, and press Change Password.\n' +
        'You are signed out afterwards, so sign back in with the new password.',
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
      answer: 'Account Settings holds two things: changing your password, and deleting your account.\n' +
        'Open it from the ⚙️ button on your profile card. Change Password is at the top and Delete Account is at the bottom, where it asks for your password because it cannot be undone.',
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
      answer: 'Open Account Settings and use Delete Account at the bottom. It asks for your password first.\n' +
        'Deleting is permanent and takes your profile, your DMs, your stories and your relationships with it. Take a moment before you confirm — there is no way back.\n' +
        'If you only want a break from the site, just close the window: nothing is deleted until you go through that confirmation.',
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
      answer: 'The Arena is the main public chatroom, shared live with the United Gay Cyber Wrestling Discord server, so what you say here can be seen there too.\n' +
        'Press Open Arena in the action row, type in the box at the bottom and press Send. The online list sits on the right and clicking a name opens that person\'s profile.\n' +
        '"_" minimises the window and "X" closes it — closing marks you offline but keeps you signed in, so refreshing will not log you out.\n' +
        'Messages are translated into each member\'s own language; you always see what you wrote in your own words.',
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
      answer: 'Hover any message in the Arena and press Reply.\n' +
        'A reply bar appears above the input showing who you are answering, with an ✕ to cancel it.\n' +
        'Send as normal and the other person sees your message with a small preview of theirs above it.',
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
      answer: 'You can edit your own Arena and room messages — DMs cannot be edited.\n' +
        'Hover your message, press Edit, change the text and press Save (or Enter). Escape cancels without saving.\n' +
        'Everyone sees a small "(edited)" marker on a message that has been changed, and only the person who wrote it can edit it.',
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
      answer: 'You count as online while you have the site open, and go offline when you close the Arena or the tab.\n' +
        'Keeping a second tab or your phone open keeps you online — the site only marks you offline when the last one goes.\n' +
        'There is no separate away status; log out if you want to disappear from the online list.',
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
      answer: 'If you leave the site alone for a long time it signs you out, to keep your account safe on shared devices.\n' +
        'Moving the mouse, typing or chatting resets the timer, so you stay signed in while you are using the site.\n' +
        'If you were signed out for being idle, press Login and sign in again.',
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
      answer: 'The User Roster lists everyone on the site, with a search box and 12 members to a page.\n' +
        'Press User Roster in the action row, then click a name to open that profile.\n' +
        'The home page shows the six newest members in Quick Roster, and a New Members card below it.',
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
      answer: 'The User Roster has a search box at the top: type any part of a username, a display name or one of their tags and the list filters as you type, back at page one.\n' +
        'Type "heel", "singlet" or "vers" and you get the members who tagged themselves that way. The Tag menu beside it filters by one tag exactly.\n' +
        'The same kind of search sits in your DMs and in the story Archives, where it looks through titles, story text and both names.\n' +
        'Searches ignore capitals, so "Jax" and "jax" find the same people.',
      action: {
        label: 'Open the User Roster',
        buttonId: 'btnRoster',
        popupId: 'modalRoster',
        done: 'Opening the User Roster — type in the search box at the top.'
      }
    },
    {
      id: 'fighter-tags',
      title: 'Fighter tags',
      keywords: ['tags', 'tag', 'fighter tags', 'my tags', 'wrestling style', 'fetish', 'gear', 'heel', 'jobber', 'face', 'dom', 'sub', 'top', 'bottom', 'vers', 'position'],
      answer: 'Fighter Tags are the labels that say what you are into: a wrestling style, gear and fetishes, whether you play heel, jobber or face, and what you are into out of the ring.\n' +
        'Pick them when you register, or any time afterwards in Edit Profile — each group has its own limit and you can change them as often as you like.\n' +
        'They appear as chips on your profile, one line of them on your roster row, and anyone can find you by them: search the roster for "heel" or use the Tag menu there.',
      requiresLogin: true,
      action: {
        label: 'Open Edit Profile',
        buttonId: 'btnEditProfile',
        popupId: 'modalEditProfile',
        done: 'Opening Edit Profile — the tag groups are in the middle.'
      }
    },
    {
      id: 'roster-pagination',
      title: 'Roster and archives pagination',
      keywords: ['pagination', 'next page', 'prev page', 'page number', 'more users', 'more stories'],
      answer: 'The User Roster shows 12 members per page and the story Archives 12 stories per page, with Prev and Next buttons and a page counter at the bottom.\n' +
        'If you filter or search, the pages are worked out again and you start at page one.',
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
      answer: 'Open a profile from the User Roster, from the online list in the Arena, or by clicking a username in chat.\n' +
        'You see their photo, name, age, height, weight, favourite colour, language, bio, their tags, wins and losses, their photos, their published stories, their relationships and the timeline of them.\n' +
        'On someone else\'s profile there are Message User and Block User buttons; your own profile has Edit Profile and Account Settings instead.',
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
      answer: 'You can add up to 10 extra photos to your profile, each up to 5 MB.\n' +
        'Open Edit Profile and use the Extra Profile Photos section: choose your images, press Upload Selected Photos, and they are saved straight away. A counter shows how many of your 10 are used, and the × on a photo removes it.\n' +
        'Visitors see them in a gallery when they click your photos.',
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
      answer: 'Press Edit Profile on your profile card.\n' +
        'You can change your display name, age, Discord ID, height, weight, bio, favourite colour, language, wins and losses, your main photo and your extra photos.\n' +
        'Press Save Changes when you are done — your fighter stats are worked out again from your height and weight automatically.',
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
      answer: 'Height is picked from a menu running 3\'5" to 8\'0" in one-inch steps, and weight is whole pounds from 60 to 700.\n' +
        'Both live in Edit Profile and are optional, but they set your fighter stats, so they are worth filling in.\n' +
        'They appear on your profile, in the roster and on the match scoreboard.',
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
      answer: 'Your fighter stats — attack and defense — are worked out from your height and weight, so enter those in Edit Profile and the stats look after themselves.\n' +
        'Bigger, heavier fighters hit harder and hold up better; the same height and weight always gives the same numbers.\n' +
        'They show on your profile and on the scoreboard during a dice match.',
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
      answer: 'Pick your language in Edit Profile and messages around the site are translated into it for you automatically — in the Arena, in rooms and in DMs.\n' +
        'You always see your own words exactly as you typed them.\n' +
        'There are more than 30 languages on the list, and if yours is missing, send a support report and it can be added.',
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
      answer: 'Put your Discord user ID in the "Discord User ID" field in Edit Profile and save — that links the two accounts.\n' +
        'To find your ID: open Discord, go to Settings → Advanced, turn on Developer Mode, then right-click your own name and choose Copy User ID.\n' +
        'Linking means your private messages can reach you on Discord too, and your name and photo match on both sides when the Arena is bridged.',
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
      answer: 'The Arena is shared live with the United Gay Cyber Wrestling Discord server, so messages posted in one place appear in the other.\n' +
        'Press "join U.G.C.W." to join the server itself. Link your Discord account in Edit Profile and your private messages can reach you there as well.\n' +
        'Either way your name and photo stay the same as they are on the site.',
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
        'Press DMs in the action row, then click a name to open that chat. You can also start one from Message User on a profile, from the PM button in the Arena\'s online list, or by clicking a username in chat.\n' +
        'Each chat can be moved around your screen by its header. Inside a chat you get images, GIFs and clips, emoji, voice calling, a Story button for writing up your matches, and Clear.',
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
      answer: 'The DMs window has a search box at the top — type part of a name and your conversations filter as you type.\n' +
        'Announcements from the site itself appear in the same list, marked as system messages.\n' +
        'If you have no conversations yet the list tells you so.',
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
      answer: 'Unread private messages show as a count on the DMs button in the action row, and beside each conversation in the list, up to 99+.\n' +
        'Opening a chat clears its count. Messages you receive while the tab is asleep, or through the Discord bridge, are counted too, so nothing is quietly missed.',
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
      answer: 'When a private message arrives, a small popup slides in at the top of the screen with the sender\'s name and a short alert sound.\n' +
        'It hides itself after a few seconds. Click it to jump straight into that conversation.',
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
      answer: 'While someone is typing to you, a small "is typing…" note appears in the chat. It clears when they stop or send.\n' +
        'The same note works in rooms while somebody is writing there.',
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
      answer: 'Open the conversation and press Clear to empty the whole chat for both of you, after a confirmation.\n' +
        'Notices the site itself sent (like story approvals) are kept.\n' +
        'Clearing cannot be undone, so it is worth thinking twice before using it on a long history.',
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
      answer: 'In a chat, press the 📷 button and choose an image of up to 5 MB.\n' +
        'It uploads and appears in the conversation for both of you. Click an image to open it full size.',
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
      answer: 'Press the 🎬 button in a chat to send a GIF of up to 25 MB, or a short video of up to 50 MB in MP4 or WebM.\n' +
        'The button shows progress while it uploads and then the clip appears in the conversation, playing quietly in place until you click it.\n' +
        'Click a clip to open it on its own and watch it larger.',
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
      answer: 'Press the ☎ Call button in a DM window to start a private voice call.\n' +
        'The other person gets a ringing popup and can accept or decline. Once they answer, a floating card shows the call with a volume slider and an End button, and it stays out of the way while you keep chatting.\n' +
        'Calls connect directly between the two of you and the site does not record them — but the person you are talking to could record on their own side, so treat it like a phone call.',
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
      answer: 'On a computer you can move a chat window anywhere by dragging its header, and clicking one brings it to the front of the others.\n' +
        'New chats open slightly offset from each other, so you can see how many you have open.\n' +
        'On a phone a chat fills the screen instead and does not move.',
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
      answer: 'Rooms are chat windows of their own, some public and some private. Press Rooms in the action row to see the list.\n' +
        'Sort them with the menu at the top: newest, oldest, A to Z or Z to A. Private rooms show a 🔒, and a small count shows unread messages.\n' +
        'Click a room to open it. Private rooms only appear for their owner and the people they invited.',
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
      answer: 'Open Rooms and press Create Room. Give the room a name, then say whether it should be private.\n' +
        'You become the room\'s owner. Public rooms show for everyone; private ones only appear to you and the people you invite, and the owner gets an Invite button for them.\n' +
        'Rooms have their own chat, member list, images and clips, conference calls and a place for dice matches.',
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
      answer: 'Only the owner can invite people to a private room. In the Rooms list your own private rooms show an Invite button.\n' +
        'Press it, type a username, and they are added and told about the room if they are online.\n' +
        'If they were offline, the room is waiting for them next time they open Rooms.',
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
      answer: 'When you open a room, the panel on the right lists who is in it, with photos, names and a dot showing who is online.\n' +
        'It updates as people come and go, so you can see straight away whether the person you are waiting for has arrived.',
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
      answer: 'Rooms show quiet, centred notices when somebody joins or leaves, such as "<name> has joined the room".\n' +
        'They are not messages — nobody can reply to them, and they never count as unread.\n' +
        'You only see a join notice when you were not already in the room in another tab.',
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
      answer: 'Rooms show a small count for messages you have not read yet, both on the Rooms list and beside each room\'s name.\n' +
        'Opening the room clears it.\n' +
        'Join and leave notices never count, so the number only reflects things people actually said.',
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
      answer: 'In a room you can type and press Send or Enter, hover a message and press Reply to answer it, and edit your own messages.\n' +
        'The buttons under the input open the emoji picker, send an image of up to 5 MB (📷), or send a GIF or short video (🎬) — the same limits as DMs.\n' +
        'Slash commands work here too, which is where dice matches are run.',
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
      answer: 'Press the ☎ Conference button in a room to start a group voice call.\n' +
        'Everyone in the room is invited and can join in; each caller gets their own floating card with a volume slider and an End button.\n' +
        'Members connect directly with each other and the site does not record calls — but anyone on the call could record their own side, so keep that in mind.',
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
      answer: 'Forums are the long-form side of the site: posts and replies that stay put, unlike the Arena.\n' +
        'Press Forums in the action row to see the list, most recently active first, showing the title, author, how many replies it has and when it was last active. The list updates live as people post.\n' +
        'Click a post to read it, or use New Forum to start your own. The home page shows the latest posts.',
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
      answer: 'Open Forums and press New Forum.\n' +
        'Give your post a title of up to 160 characters and write the body, up to 10,000 characters, then press Create.\n' +
        'It goes to the top of the list immediately, ready for replies.',
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
      answer: 'Click a post in the Forums list to open it.\n' +
        'The thread shows the original post and every reply in order, with who wrote each one and when.\n' +
        'Use Back to return to the list, or Close to leave the Forums.',
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
      answer: 'Open a thread, scroll to the reply box at the bottom, type your response (up to 5,000 characters) and press Post Response.\n' +
        'Your reply appears at the end of the thread and the post moves to the top of the Forums list, so it is easy to see which discussions are active.',
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
      answer: 'Archives holds every published story on the site, newest first.\n' +
        'Press Archives in the action row to browse them: search, sort, page through the list, and click any story to read it.\n' +
        'You can read other members\' stories as well as your own, and stories you own show Edit and Delete buttons in the list.',
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
      answer: 'The Archives window has a search box at the top that looks through story titles, the story text and both names.\n' +
        'Use the sort menu to order them by newest, oldest, title or author, and tick "Only my stories" to see just yours.\n' +
        'Results come 12 to a page, with Prev and Next at the bottom and a count of how many stories matched.',
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
      keywords: ['create story', 'make a story', 'write a story', 'start story', 'begin story', 'new story', 'story creation', 'save a story', 'story from dm', 'stories'],
      answer: 'Stories are built from a chat you already had together.\n' +
        'Open one of your DMs and press the "Story" button — rooms work the same way, and the button appears in the chat window. The story editor opens with a title and a date.\n' +
        'Press "Load messages" to pull that conversation in, pick the parts you want to keep, tidy the wording, attach a GIF or clip if you like, then preview and save.\n' +
        'Your partner approves the story before it appears in the public Archives.',
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
      answer: 'The editor has a title of up to 120 characters and a body of up to 20,000, with a counter showing characters, words and reading time as you go.\n' +
        'The toolbar does bold, italic, quoted speech, chapter headings and scene breaks, and Ctrl+B, Ctrl+I and Ctrl+S work as shortcuts. Under the body you can attach a GIF or clip, and there is a Preview button to see the story exactly as readers will.\n' +
        'Save when you are happy; drafts are kept automatically while you write.',
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
      answer: 'Inside the editor, "Build from messages" is how you turn a chat into a story.\n' +
        'Choose a date range and press "Load messages" to pull the conversation in, then tick the messages you want. You can filter the list by text or name, show only your side or only theirs, and switch between a script style (name before each line of dialogue) and a log style (with timestamps).\n' +
        'You can also give each of you a character name for the story, then add the selection to your story at the cursor, or replace the text with it. Select all, none and invert help with long conversations.',
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
      answer: 'The editor saves a draft as you type, one per conversation and one per story you are editing.\n' +
        'If you come back later — or close the window by accident — a banner offers to restore the draft or discard it, and it tells you when the draft was saved.\n' +
        'Drafts older than about a month are ignored, and closing the editor with unsaved changes asks you first.',
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
      answer: 'Story text takes simple formatting: **bold**, *italic*, a line starting with > for quoted speech, ## for a chapter heading, --- on its own for a scene break, and - or * for a bullet.\n' +
        'Plain paragraphs need nothing at all — a blank line between them is enough.\n' +
        'The Preview button shows exactly how readers will see it.',
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
      answer: 'A story belongs to both of you, so your partner approves it before it goes public.\n' +
        'When you save, they get a request and a message in their DMs where they can read it, approve it, or decline with a reason. Once both of you have approved it appears in the Archives and on both profiles.\n' +
        'If it is declined you can revise it and resubmit, and either of you can withdraw a story at any time. Editing a published story asks your partner to approve the new version.',
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
      answer: 'Your profile card lists your published stories and any that are waiting for approval, showing who each story is with and who is waiting on whom.\n' +
        'From there you can read, edit, resend the request, or withdraw a story — and approve or decline when you are the partner.\n' +
        'Declined stories stay on your profile with the reason that was given, so you can revise and send them back.',
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
      keywords: ['read story', 'read a story', 'story viewer', 'view story', 'open story', 'story reading', 'story display'],
      answer: 'Reading a story opens it on its own page: the title, who it is by and with, the date, and the story itself.\n' +
        'The toolbar makes the text bigger or smaller, steps to the previous or next story, copies a link to share, exports a plain-text copy, and prints it.\n' +
        'Escape or the ✕ closes it, and the arrow keys move between stories when there are more to read.',
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
      answer: 'Every published story has a link of its own. Use Copy link in the viewer, or the Link button in the Archives list.\n' +
        'Opening the link goes straight into the story, and it shows a title and short description when shared on Discord or social sites.\n' +
        'Export saves the story as a plain-text file you can keep, and Print gives you a clean page for reading or making a PDF.',
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
      answer: 'You can record what you are to each other on your profile: rival, friend, opponent, tag team partner, dating, married, sibling, parent or owner.\n' +
        'Open the other person\'s profile, choose a type from the Add relationship menu and press Send Request. They get the request and have to approve it before it appears.\n' +
        'Approved relationships show on both profiles, along with a timeline of when they started.',
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
      answer: 'Every profile has a Relationship Timeline showing approved connections in the order they began, with the date and who each one was with.\n' +
        'It is a quick history of your alliances, rivalries and partnerships, and it builds up as you accept more relationships.',
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
      answer: 'Open the person\'s profile and press Block User, then confirm. They can no longer send you private messages.\n' +
        'They are not told, and you can undo it at any time from the same place.\n' +
        'If they are breaking the rules, send a support report as well — blocking stops the messages, but only the admins can deal with the behaviour.',
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
      answer: 'Open the profile of someone you have blocked and unblock them there; the same button does both.\n' +
        'Their messages reach you again immediately, and they appear on your roster as normal.\n' +
        'Blocking and unblocking never notifies the other person.',
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
      answer: 'The Support window is how you report a member, report something wrong with the site, or ask for something new.\n' +
        'Press Support in the action row, choose the type of report, say who it is about and where it happened, add when it happened and describe it, then submit.\n' +
        'Your report goes straight to the admins, with the option of being contacted for details. Toxicity is taken seriously here, so use it whenever something is not right.',
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
      answer: 'The Site Rules window has the full rules; the short version is this.\n' +
        'Be respectful: banter is playful and mutual, and it stops when someone asks it to. No harassment, hate speech, threats, doxxing, spamming, impersonating staff, or pushing past a limit someone has set. Zero tolerance applies to hate speech, threats of violence, sexual harassment, targeted harassment and dodging blocks or bans.\n' +
        'If something goes wrong: stop engaging, block the person, and report it. Moderators can warn, mute, remove messages and ban, and their decisions are final.',
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
      answer: 'The Terms of Service explain the agreement you accept by using the site.\n' +
        'In short: the site is 18+ only, keep your account details to yourself, use the community spaces as the rules describe, you keep ownership of what you write while allowing the site to show it, moderation can act on reports, and the service comes as it is with limits on liability.\n' +
        'Open the full text from the Terms of Service button in the footer.',
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
      answer: 'The Privacy Policy explains what the site stores and why.\n' +
        'It keeps your account details, the content you post, your photos, whether you are online, and basic security information such as sign-in records. Public areas — the Arena, forums, Archives, profiles — can be seen by anyone; DMs and calls are private, but they are not end-to-end encrypted and moderators can look at records when something is reported.\n' +
        'Nothing is sold, there are no advertisers or marketing trackers, email is transactional only, and you can update your details, change your password or delete your account at any time.',
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
      answer: 'Calls happen inside chats. Press ☎ in a DM for a private voice call, or Conference in a room for a group one.\n' +
        'The other person gets a ringing popup and can accept or decline. Once they answer, a floating card shows the call with a volume slider and an End button, and it keeps out of the way while you carry on typing.\n' +
        'Calls connect directly between the people talking and the site does not record them — but anyone on the call could record their own side, so treat it like a phone call.',
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
      answer: 'Calls use three sounds: ringing for the person being called, a ringback tone while you wait for them, and a short note when the call ends.\n' +
        'Arena messages and DMs have their own alert sounds, and unread counts show on the buttons until you read them.\n' +
        'The volume of a call is set with the slider on the call card.',
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
      answer: 'Slash commands are short instructions you type straight into a chat box — in the Arena, a room or a DM.\n' +
        'Start a message with "/" and a list of what you can use appears above the box; the arrow keys move through it and Tab or Enter fills one in. Escape closes the list.\n' +
        'The main ones are /create-game, /join-game and /move for dice matches, /game-state and /end-game to manage them, and /get-move for looking up wrestling moves. /help lists everything.',
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
      answer: 'A dice match is a fight with visible rolls, so neither of you has to decide who lands what.\n' +
        'Type /create-game in a room to open one and your opponent types /join-game. On your turn you type /move with a choice — attack, submission, escape, teasing, pin or recover — and the result is rolled for you. /game-state shows the scoreboard and /end-game finishes things early.\n' +
        'Everyone starts with full health and stamina, attacks do damage based on the fighters\' size, pins and submissions can end it early, and the first fighter to empty the other\'s health wins. Double knockout counts as a draw.',
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
      answer: 'While a match is running, a scoreboard shows both fighters\' health, stamina and attraction, an arrow for whose turn it is, and a reminder of what to type next.\n' +
        'While you wait for an opponent it sits above the room chat; once the fight is on it moves into its own window you can drag anywhere on screen, and several matches each get their own.\n' +
        'When the match ends the result stays up for a moment — winner, loser or a double knockout — and then closes itself.',
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
      answer: 'Type /get-move in any chat box to look up a wrestling move.\n' +
        '"/get-move powerbomb" gives you that move with its description, category and difficulty and who made it famous, "/get-move random" surprises you with one, and plain /get-move lists them all to browse.\n' +
        'It is handy when you want to describe a move properly in a match instead of reaching for the same three every time.',
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
      answer: 'Start a message with "/" and a list of commands appears above the box, narrowing as you type.\n' +
        'Use the arrow keys to move through it, Tab or Enter to fill the command in, and Escape to close it.\n' +
        'Once the command name is complete the list disappears, so pressing Enter then runs the command instead of picking from the list.',
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
      answer: 'Press the 😊 button beside any message box — in the Arena, a room or a DM — to open the emoji picker.\n' +
        'Click an emoji and it drops into your message where the cursor is.\n' +
        'The picker closes on its own once you have chosen, or if you click away from it.',
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
      answer: 'You can send pictures and clips in DMs and rooms.\n' +
        'The 📷 button sends an image of up to 5 MB, and 🎬 sends a GIF of up to 25 MB or a short video of up to 50 MB in MP4 or WebM. Both upload before they send, so the button shows progress on bigger files.\n' +
        'Profile photos are different: those are set in Edit Profile, where you can have one main photo and up to 10 extra ones.',
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
      answer: 'Photos on the site are served through the site itself, so they keep working even when the original host blocks other pages from showing them or the link expires.\n' +
        'If a picture cannot be loaded at all you see a placeholder instead of a broken image, and members without a photo get a coloured tile with their initials.\n' +
        'That keeps profiles and the Arena looking right even when a picture disappears from wherever it was uploaded.',
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
      answer: 'Cyber wrestling is writing a match together: you describe what your fighter does, your opponent describes how they take it and what they do back, and the match builds line by line.\n' +
        'The Beginner\'s Guide covers all of it — building your fighter, finding an opponent, agreeing the match before the first move, writing it well, and how matches end. Open it from the Beginner\'s Guide button, or read it as a public page you can share with a new opponent.\n' +
        'A good way in: register and fill in your profile, learn a few holds with /get-move random, read the Site Rules, then say hello in the Arena and watch how others write before you take your first match.',
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
      answer: 'There is a search box in the User Roster, in the DMs window and in the story Archives.\n' +
        'The Archives search is the deepest one: it looks through story titles, the story text and both names. The Roster and DMs filter by name as you type.\n' +
        'Searches ignore capitals, and the forums list is ordered by the most recent activity so new posts are always near the top.',
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
      answer: 'New Arena messages, DMs and calls each play a short sound, and DMs also show a popup at the top of the screen with who wrote to you.\n' +
        'Unread counts appear on the DMs button in the action row and beside each room, and clear as you open them.\n' +
        'There is nothing to switch on — it all works while the site is open in a tab.',
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
      answer: 'Messages in the Arena and in rooms are translated into the language you choose in Edit Profile, automatically.\n' +
        'You see your own messages exactly as you wrote them, and everyone else sees them in theirs.\n' +
        'DMs are translated as well, and the translation is worked out once per message rather than per person, so it never slows the chat down.',
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
      answer: 'Who is online appears in three places: the list on the right of the Arena, the Quick Roster on the home page, and the User Roster.\n' +
        'Members show there while they have the site open in a tab or an app window.\n' +
        'The dot beside a name in a room\'s member list tells you the same thing for that room.',
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
      answer: 'There are desktop apps for Windows (installer), macOS (disk image) and Linux (AppImage), all downloadable from the links in the footer.\n' +
        'The desktop app is the same site in its own window, so it uses the same account, DMs, rooms and matches as the website — nothing to set up beyond signing in.\n' +
        'It also gets the site\'s updates automatically, since it loads the same pages.',
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
      answer: 'You can install the site on your phone so it opens full-screen from your home screen like an app.\n' +
        'Press "Install on this device" in the footer — Android and desktop browsers ask you to confirm. On an iPhone or iPad, tap Share and then "Add to Home Screen".\n' +
        'It uses the same account as the website, and if your connection drops you get a friendly offline page instead of an error.',
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
      answer: 'The site can be installed from your browser, so it opens in its own window without the address bar.\n' +
        'Installation is offered in the footer, or through your browser\'s own Install option. Once installed it keeps working through short connection drops.\n' +
        'Everything is the same as the website — same account, same chats, same matches.',
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
      answer: 'The home page has two lists: what is being worked on next, and what has just been finished.\n' +
        'They are updated as things ship, so they are the quickest way to see what has changed recently.\n' +
        'If you want something added or changed, send it through Support as a feature request and it goes on the list to consider.',
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
      answer: 'Under the front card the home page shows the newest members and the most recent forum posts, so you can see who has arrived and what people are talking about.\n' +
        'Click a name to open their profile, or a post to read the thread.\n' +
        'Both lists refresh as the site is used.',
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
      answer: 'The Admin Panel is only for the site administrator; nobody else sees the button.\n' +
        'It has three views. Users: search members, ban or unban them, reset a password or delete an account. Analytics: how many members there are, how many are online and how busy the site has been. Stale images: find pictures that have expired and either restore them or clear them away.\n' +
        'Actions taken in the panel apply immediately, so it is worth searching for the right member before using the buttons.',
      requiresAdmin: true,
      action: {
        label: 'Open Admin Panel',
        buttonId: 'btnAdmin',
        popupId: 'modalAdmin',
        done: 'Opening the Admin Panel for you.'
      }
    },
    {
      id: 'admin-analytics',
      title: 'Admin analytics',
      keywords: ['analytics', 'stats', 'top ips', 'logins', 'registrations', 'admin stats', 'user count'],
      answer: 'The Analytics view shows the health of the site at a glance.\n' +
        'You get the number of members, how many are online right now, how many are banned, and for the last 24 hours the number of sign-ins, failed sign-ins and new registrations.\n' +
        'Below that is a list of the busiest connections in that period, which helps spot trouble such as repeated failed logins.',
      requiresAdmin: true,
      action: {
        label: 'Open Admin Analytics',
        buttonId: 'btnAdmin',
        popupId: 'modalAdmin',
        then: 'tabAnalytics',
        done: 'Opening Admin → Analytics for you.'
      }
    },
    {
      id: 'admin-stale-images',
      title: 'Stale Discord images sweep',
      keywords: ['stale images', 'discord images expired', 'rehost images', 'imgbb rehost', 'clear broken images', 'sweep images'],
      answer: 'Pictures posted from Discord stop working after about a day, and the site shows them as broken images if nothing is done.\n' +
        'In the Admin Panel, the Stale images view finds them. Preview is a dry run: it lists what would happen without changing anything. Run sweep then does the work — pictures it can still fetch are re-hosted on the site\'s own image host, and ones that are gone for good are cleared so people stop seeing broken images.\n' +
        'The summary afterwards tells you how many were restored, cleared or skipped.',
      requiresAdmin: true,
      action: {
        label: 'Open Stale Images Sweep',
        buttonId: 'btnAdmin',
        popupId: 'modalAdmin',
        then: 'tabStaleImages',
        done: 'Opening Admin → Stale images for you.'
      }
    },

    /* ---------- SECURITY & EMAIL ---------- */
    {
      id: 'email',
      title: 'Emails — welcome and password reset',
      keywords: ['email', 'welcome email', 'reset email', 'transactional email', 'mail', 'smtp'],
      answer: 'The site only sends transactional email: a welcome message when you register, password reset links, and alerts to the admins about reports.\n' +
        'There are no newsletters and no marketing mail, and your address is never sold or shared for advertising.\n' +
        'If an expected email does not arrive, check your spam folder and use the resend option, or send a support report.',
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
      answer: 'Passwords are stored securely and never in plain text, and password reset links expire after an hour and can only be used once.\n' +
        'Repeated failed sign-ins are slowed down automatically, and connections to the site are encrypted.\n' +
        'The Privacy Policy explains exactly what is stored and for how long, and you can delete your account from Account Settings whenever you want.',
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
      answer: 'There are two ways to take the site with you: a desktop app for Windows, macOS and Linux, and installation on a phone or tablet so it opens from your home screen like an app.\n' +
        'Both are linked in the footer of the home page, and both use the same account, Arena, rooms and DMs as the website.\n' +
        'Nothing needs to be set up twice — sign in and everything is where you left it.',
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
      answer: 'Male Cyber Fighters is an 18+ site.\n' +
        'Everyone confirms they are 18 or over on the way in, and the age on your profile has to be 18 or over as well — it is checked when you register and when you edit your profile.\n' +
        'If you are under 18 you must not use the site.',
      action: null
    },
    {
      id: 'mobile-vs-desktop',
      title: 'Mobile vs desktop layout',
      keywords: ['mobile', 'desktop', 'phone', 'tablet', 'responsive', 'mobile.css', 'desktop.css', 'mobile layout'],
      answer: 'On a phone the site rearranges itself to fit: buttons go full width, chat windows fill the screen, and the profile card stacks instead of sitting side by side.\n' +
        'On a computer you get the wider layout, with side cards and the movable, resizable chat windows.\n' +
        'Everything works the same either way, on the same account.',
      action: null
    },
    {
      id: 'landing',
      title: 'Landing page and intro',
      keywords: ['landing', 'intro gif', 'landing page', 'intro', 'welcome'],
      answer: 'The front page introduces the site before you sign in: the Arena public chatroom, shared live with Discord; profiles with photos, stats and stories; automatic translation; stories written up from your chats; and the zero-tolerance policy on toxicity.\n' +
        'Further down are the update lists, the newest members and the most recent forum posts.\n' +
        'The age check sits on top of it all, and the page you land on after signing in is the home page with your profile card.',
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

  /* Articles that people (and the quick questions) drop between the words
     of a keyword: "create a story" asks the same thing as "create story".
     Without this the assistant could not answer its own quick question
     "How do I create a story?" — it fell through to the fallback. */
  var FILLER_WORDS = { a: true, an: true, the: true };

  /**
   * Are these the same word for matching purposes? People write "story"
   * and "stories", "room" and "rooms", so allow the simple plurals.
   */
  function sameWord(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;

    var shorter = a.length <= b.length ? a : b;
    var longer = a.length <= b.length ? b : a;
    if (shorter.length < 2) return false;

    if (shorter + 's' === longer) return true;                  // room / rooms
    if (shorter + 'es' === longer) return true;                 // match / matches
    if (/ies$/.test(longer) && shorter === longer.slice(0, -3) + 'y') return true; // story / stories

    return false;
  }

  /**
   * Does the keyword appear in the question, allowing articles between its
   * words? Word order is kept and nothing else may sit between them, so
   * "create report" still does not match "create a story".
   */
  function containsKeyword(haystackWords, keyword) {
    var needle = keyword.toLowerCase().split(' ');

    for (var start = 0; start < haystackWords.length; start++) {
      if (!sameWord(haystackWords[start], needle[0])) continue;

      var at = start + 1;
      var next = 1;
      while (next < needle.length) {
        var word = haystackWords[at];
        if (word === undefined) break;
        if (FILLER_WORDS[word]) { at++; continue; }
        if (!sameWord(word, needle[next])) break;
        next++;
        at++;
      }

      if (next === needle.length) return true;
    }

    return false;
  }

  function scoreTopic(topic, haystack) {
    var score = 0;
    var haystackWords = null;

    topic.keywords.forEach(function (keyword) {
      var needle = ' ' + keyword.toLowerCase() + ' ';
      var found = haystack.indexOf(needle) !== -1;

      // The exact phrase missed, so try word by word: that is what lets
      // "create a story" and "create stories" reach the "create story"
      // keyword (and the assistant answer its own quick questions).
      if (!found) {
        if (!haystackWords) haystackWords = haystack.split(' ');
        found = containsKeyword(haystackWords, keyword);
      }

      if (!found) return;
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

    // Never open admin-only windows for non-admins, even if someone crafts
    // a topic or quick-reply that points at them.
    if (action && (action.buttonId === 'btnAdmin' || action.popupId === 'modalAdmin')) {
      if (!isAdminSafe()) {
        answerRestrictedAdmin();
        return false;
      }
    }

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
    if (isAdminTopic(topic) && !isAdminSafe()) {
      addMessage(
        'assistant',
        'That area is for the site administrator only.\n' +
          'If you need help with something an admin handles — a ban, a report, a bug, or a feature request — send it through Support and the admins will pick it up.',
        {
          label: 'Open a support report',
          buttonId: 'openSupport',
          popupId: 'supportPopup',
          done: 'Opening the support report form for you.'
        }
      );
      return;
    }

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

    if (isAdminTopic(topic) && !isAdminSafe()) {
      addMessage(
        'assistant',
        'That area is for the site administrator only.\n' +
          'If you need help with something an admin handles, use Support.',
        {
          label: 'Open a support report',
          buttonId: 'openSupport',
          popupId: 'supportPopup',
          done: 'Opening the support report form for you.'
        }
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

  function answerRestrictedAdmin() {
    addMessage(
      'assistant',
      'That area is for the site administrator only.\n' +
        'If you need help with something an admin handles — a ban, a report, a bug, or a feature request — send it through Support and the admins will pick it up.',
      {
        label: 'Open a support report',
        buttonId: 'openSupport',
        popupId: 'supportPopup',
        done: 'Opening the support report form for you.'
      }
    );
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
        if (isAdminTopic(match.topic) && !isAdminSafe()) {
          answerRestrictedAdmin();
        } else {
          answerTopic(match.topic, text);
        }
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
        'I can help with the Arena, DMs, rooms, forums, stories and the Archives, your profile and photos, dice matches, voice calls, blocking and reports, the rules, and the beginner’s guide to cyber wrestling.'
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
