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
    {
      id: 'create-room',
      title: 'Create a room',
      keywords: ['create a room', 'create room', 'new room', 'make a room', 'start a room', 'custom room'],
      answer: 'Rooms are your own chat windows, public or private.\n' +
        'Open Rooms in the action row, press "Create Room", type a name, then choose whether it is private.\n' +
        'In a private room the owner gets an Invite button on the room row — invite people by username.',
      action: {
        label: 'Create a room',
        buttonId: 'btnRooms',
        popupId: 'roomsSidebar',
        then: 'createRoomBtn',
        done: 'Opening Rooms — press "Create Room" and give it a name.'
      }
    },
    {
      id: 'rooms',
      title: 'Rooms',
      keywords: ['rooms', 'room', 'private room', 'room list'],
      answer: 'The Rooms window lists every room you can see, with a sort menu at the top.\n' +
        'Press a room to open its chat. Private rooms only appear if you own them or were invited.\n' +
        'Room windows have their own message box, image and clip upload, emoji picker, member list and a "Conference" call button.',
      action: {
        label: 'Open Rooms',
        buttonId: 'btnRooms',
        popupId: 'roomsSidebar',
        done: 'Opening the Rooms window for you.'
      }
    },
    {
      id: 'arena',
      title: 'The Arena (public chat)',
      keywords: ['arena', 'public chat', 'main chat', 'chatroom', 'chat room', 'main room', 'public room'],
      answer: 'The Arena is the main public chatroom, shared live with the United Gay Cyber Wrestling Discord server.\n' +
        'Type in the box at the bottom and press Send. The online list sits on the right, and clicking a name opens that person\'s profile.\n' +
        '"_" minimises the window and "X" closes it — closing marks you offline in the arena but keeps you signed in.',
      action: {
        label: 'Open the Arena',
        buttonId: 'btnOpenChat',
        popupId: 'chatPopup',
        done: 'Opening the Arena for you.'
      }
    },
    {
      id: 'forgot-password',
      title: 'Forgot password',
      keywords: ['forgot password', 'forgot my password', 'reset password', 'reset link', 'lost my password', 'cannot log in', 'cant log in'],
      answer: 'Use the password reset instead of signing in.\n' +
        'Enter the email on your account and a reset link is sent to it — check your spam folder too.\n' +
        'If the link does not arrive, press "Resend email" or send a support report.',
      action: {
        label: 'Reset my password',
        buttonId: 'forgotLink',
        popupId: 'modalForgot',
        done: 'Opening the password reset — enter the email on your account.'
      }
    },
    {
      id: 'change-password',
      title: 'Change password',
      keywords: ['change password', 'change my password', 'new password', 'update password'],
      answer: 'Account Settings has a "Change password" section: type your current password, then the new one twice.\n' +
        'The same window can also delete your account.',
      requiresLogin: true,
      action: {
        label: 'Open Account Settings',
        buttonId: 'btnAccountSettings',
        popupId: 'modalAccountSettings',
        done: 'Opening Account Settings — the password section is at the top.'
      }
    },
    {
      id: 'login',
      title: 'Signing in',
      keywords: ['login', 'log in', 'sign in', 'signing in', 'log on'],
      answer: 'Press Login in the action row and enter your username and password.\n' +
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
      title: 'Registering',
      keywords: ['register', 'sign up', 'signup', 'create account', 'new account', 'make an account', 'join the site'],
      answer: 'Press Register in the action row, then fill in a username, email, password, age and a short bio.\n' +
        'You must be 18 or older. A profile picture is optional and can be added later from Edit Profile.',
      action: {
        label: 'Open Register',
        buttonId: 'btnRegister',
        popupId: 'modalRegister',
        done: 'Opening the registration form for you.'
      }
    },
    {
      id: 'dms',
      title: 'Direct messages',
      keywords: ['dm', 'dms', 'direct message', 'direct messages', 'private message', 'message someone', 'whisper'],
      answer: 'The DMs window lists every conversation you have, newest first, with a search box at the top.\n' +
        'Press a name to open that chat. You can also open a DM from someone\'s profile, from the arena\'s online list, or by clicking their username in chat.\n' +
        'DM windows have image upload (📷), an emoji picker (😊) and a "Call" button for an audio call.',
      action: {
        label: 'Open DMs',
        buttonId: 'btnDMs',
        popupId: 'dmSidebar',
        done: 'Opening your DMs for you.'
      }
    },
    {
      id: 'forums',
      title: 'Forums',
      keywords: ['forums', 'forum', 'forum post', 'discussion', 'thread'],
      answer: 'Forums are the long-form side of the site: open Forums in the action row to read the list.\n' +
        'Press a post to open the thread, then write a response in the box at the bottom and press "Post Response".\n' +
        'Use "New Forum" to start your own discussion.',
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
      keywords: ['new forum', 'create forum', 'start a forum', 'new post', 'create a post', 'start a discussion', 'make a forum'],
      answer: 'Open Forums and press "New Forum", then give it a title and a body and press Create.\n' +
        'Your post appears at the top of the forum list straight away and other members can respond to it.',
      action: {
        label: 'Open the new forum form',
        buttonId: 'btnForums',
        popupId: 'forumsPopup',
        then: 'newForumBtn',
        done: 'Opening the new forum form for you.'
      }
    },
    {
      id: 'roster',
      title: 'User roster',
      keywords: ['roster', 'user roster', 'user list', 'members', 'find a user', 'search users', 'all users', 'who is on'],
      answer: 'The User Roster lists everyone on the site with a search box and paging at the bottom.\n' +
        'Press a user to open their profile, where you can message them, view their stories, or add a relationship.',
      action: {
        label: 'Open the User Roster',
        buttonId: 'btnRoster',
        popupId: 'modalRoster',
        done: 'Opening the User Roster for you.'
      }
    },
    {
      id: 'archives',
      title: 'Story archives',
      keywords: ['archives', 'archive', 'story list', 'public stories', 'read stories', 'story archives'],
      answer: 'Archives holds every approved story from every member, newest first, with a search box by user.\n' +
        'Press a story to read it; stories that include a clip play it as you read.',
      action: {
        label: 'Open the Archives',
        buttonId: 'btnArchives',
        popupId: 'modalArchives',
        done: 'Opening the story Archives for you.'
      }
    },
    {
      id: 'create-story',
      title: 'Creating a story',
      keywords: ['create story', 'make a story', 'write a story', 'new story', 'story creation', 'save a story'],
      answer: 'Stories are built from a chat you already had.\n' +
        'In a DM window press "Story" (room windows work the same way), give it a title and a start date, then press "Load Messages" to pull that conversation into the editor.\n' +
        'Edit the text, optionally attach a GIF or short clip, and press "Save Story". Stories are reviewed before they appear in the public Archives.',
      requiresLogin: true,
      action: {
        label: 'Open DMs to start one',
        buttonId: 'btnDMs',
        popupId: 'dmSidebar',
        done: 'Opening your DMs — pick a conversation and press "Story".'
      }
    },
    {
      id: 'edit-profile',
      title: 'Editing your profile',
      keywords: ['edit profile', 'change profile', 'update profile', 'my profile', 'profile picture', 'avatar', 'bio', 'display name'],
      answer: 'Press "Edit Profile" on your profile card to change your display name, age, bio, favourite colour, wins and losses, and to upload a main image plus up to 10 extra photos.\n' +
        'Your height and weight are set here too, and they are what the match scoreboard uses.',
      requiresLogin: true,
      action: {
        label: 'Open Edit Profile',
        buttonId: 'btnEditProfile',
        popupId: 'modalEditProfile',
        done: 'Opening Edit Profile for you.'
      }
    },
    {
      id: 'language',
      title: 'Language and translation',
      keywords: ['language', 'translate', 'translation', 'translate messages', 'another language', 'english'],
      answer: 'Every member picks a language in Edit Profile — messages are then auto-translated into it across the site.\n' +
        'If your language is not in the list, send a support report under "App Issue" and it can be added.',
      requiresLogin: true,
      action: {
        label: 'Open Edit Profile',
        buttonId: 'btnEditProfile',
        popupId: 'modalEditProfile',
        done: 'Opening Edit Profile — the language menu is halfway down.'
      }
    },
    {
      id: 'discord',
      title: 'Linking Discord',
      keywords: ['discord', 'link discord', 'discord account', 'ugcw', 'discord id'],
      answer: 'Put your Discord user ID in the "Discord User ID" field in Edit Profile and save — that links your site account to your Discord account.\n' +
        'The Arena is shared with the U.G.C.W. Discord server, and the "join U.G.C.W." link in the action row takes you to the invite.',
      requiresLogin: true,
      action: {
        label: 'Open Edit Profile',
        buttonId: 'btnEditProfile',
        popupId: 'modalEditProfile',
        done: 'Opening Edit Profile — the Discord ID field is near the top.'
      }
    },
    {
      id: 'account-settings',
      title: 'Account settings',
      keywords: ['account settings', 'settings', 'delete account', 'delete my account', 'close my account'],
      answer: 'Account Settings (the ⚙️ button on your profile card) holds two things: changing your password and deleting your account.\n' +
        'Deleting asks for your password and a second confirmation, and it cannot be undone.',
      requiresLogin: true,
      action: {
        label: 'Open Account Settings',
        buttonId: 'btnAccountSettings',
        popupId: 'modalAccountSettings',
        done: 'Opening Account Settings for you.'
      }
    },
    {
      id: 'support',
      title: 'Support and reports',
      keywords: ['support', 'report', 'report a user', 'report a problem', 'bug', 'issue', 'complaint', 'harassment', 'harassing', 'toxic', 'broken', 'not working', 'suggestion', 'feature request'],
      answer: 'The Support window is how you report a user, report a site problem, or ask for a feature.\n' +
        'Pick "User Report" or "App Issue", say who it involves, where and when it happened, and add as much detail as you can.\n' +
        'Reports go straight to the admins — the site runs a zero tolerance policy on toxicity.',
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
      keywords: ['rules', 'site rules', 'server rules', 'banned', 'ban', 'zero tolerance', 'allowed'],
      answer: 'The Site Rules window has the full list. The short version: be 18+, no harassment or hate, and keep the arena a place people want to wrestle in.\n' +
        'Breaking them gets you banned — admins can also reset passwords and remove accounts.',
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
      keywords: ['terms', 'tos', 'terms of service', 'terms and conditions'],
      answer: 'The Terms of Service window covers the agreement you accept by using the site, including accounts, content you post, and the 18+ requirement.',
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
      keywords: ['privacy', 'privacy policy', 'cookies', 'my data', 'personal data', 'gdpr'],
      answer: 'The Privacy Policy window explains what the site stores (account details, session cookies, analytics) and how it is used.',
      action: {
        label: 'Open the Privacy Policy',
        buttonId: 'btnPrivacy',
        popupId: 'modalPrivacy',
        done: 'Opening the Privacy Policy for you.'
      }
    },
    {
      id: 'audio-calls',
      title: 'Audio calls',
      keywords: ['call', 'audio call', 'voice call', 'conference', 'conference call', 'phone'],
      answer: 'Calls live inside chats: press the ☎ Call button in a DM window, or "☎ Conference" in a room window.\n' +
        'The call window floats in the corner with a volume slider, so you can keep chatting while you are on it. It says "Connected" once the other side answers.',
      action: {
        label: 'Open DMs to start a call',
        buttonId: 'btnDMs',
        popupId: 'dmSidebar',
        done: 'Opening your DMs — the ☎ button starts the call.'
      }
    },
    {
      id: 'dice-matches',
      title: 'Dice matches and moves',
      keywords: ['dice match', 'dice matches', 'chance match', 'match', 'fight', 'wrestle', 'move', 'slash command', 'commands', 'hp', 'stamina', 'health'],
      answer: 'Matches are run with slash commands typed straight into a chat box: /create-game starts one, /join-game joins, /move attack|submission|escape|teasing|pin|recover takes your turn, and /game-state shows the scoreboard.\n' +
        'Health, stamina and hormone bars appear above the room feed while a match is running. /get-move looks a move up in the move database and /help lists everything.',
      action: {
        label: 'Open Rooms to start one',
        buttonId: 'btnRooms',
        popupId: 'roomsSidebar',
        done: 'Opening Rooms — create or open a room, then type /create-game.'
      }
    },
    {
      id: 'emoji',
      title: 'Emoji',
      keywords: ['emoji', 'emojis', 'emoticon', 'smiley'],
      answer: 'Press the 😊 button next to any message box (arena, DM or room) to open the emoji picker, then click an emoji to drop it into your message.',
      action: {
        label: 'Open the Arena',
        buttonId: 'btnOpenChat',
        popupId: 'chatPopup',
        done: 'Opening the Arena — the 😊 button is next to the message box.'
      }
    },
    {
      id: 'images',
      title: 'Sending images and clips',
      keywords: ['image', 'images', 'picture', 'pictures', 'photo', 'photos', 'upload', 'gif', 'clip', 'video'],
      answer: 'DM and room windows have a 📷 button for images and a 🎬 button for a GIF or short video (up to about 30 seconds).\n' +
        'Profile pictures and the 10 extra profile photos are uploaded from Edit Profile instead.',
      action: {
        label: 'Open DMs',
        buttonId: 'btnDMs',
        popupId: 'dmSidebar',
        done: 'Opening your DMs — 📷 sends an image, 🎬 sends a clip.'
      }
    },
    {
      id: 'edit-messages',
      title: 'Editing and replying to messages',
      keywords: ['edit message', 'edit my message', 'reply', 'replying', 'quote', 'delete message', 'delete my message'],
      answer: 'You can edit your own arena and room messages — hover your message and use the edit control that appears.\n' +
        'Replying to any message quotes it above the input box; press the ✕ on the quote bar to cancel it.',
      action: {
        label: 'Open the Arena',
        buttonId: 'btnOpenChat',
        popupId: 'chatPopup',
        done: 'Opening the Arena for you.'
      }
    },
    {
      id: 'relationships',
      title: 'Relationships',
      keywords: ['relationship', 'relationships', 'rival', 'tag team', 'tagteam', 'timeline', 'dating', 'married'],
      answer: 'Open someone\'s profile from the User Roster or from their name in chat, then use "Add relationship" to request one (rival, friend, opponent, tag team, dating, married, sibling, parent, owner).\n' +
        'The other person has to accept it, and accepted relationships show up on both profiles with a shared timeline.',
      action: {
        label: 'Open the User Roster',
        buttonId: 'btnRoster',
        popupId: 'modalRoster',
        done: 'Opening the User Roster — pick a user to add a relationship.'
      }
    },
    {
      id: 'block',
      title: 'Blocking a user',
      keywords: ['block', 'block user', 'blocking', 'unblock', 'stop messages'],
      answer: 'Open that person\'s profile and press Block — they can no longer DM you. Unblock is in the same place.\n' +
        'If they are breaking the rules, send a support report as well so the admins can act on it.',
      action: {
        label: 'Open a support report',
        buttonId: 'openSupport',
        popupId: 'supportPopup',
        done: 'Opening the support report form for you.'
      }
    },
    {
      id: 'notifications',
      title: 'Sounds and notifications',
      keywords: ['notification', 'notifications', 'sound', 'sounds', 'alert', 'badge', 'unread'],
      answer: 'New arena messages, DMs and calls play a sound, and a DM notification pops up at the top of the page.\n' +
        'Unread counts show as badges on the DMs and Rooms buttons — opening a conversation clears its count.',
      action: {
        label: 'Open DMs',
        buttonId: 'btnDMs',
        popupId: 'dmSidebar',
        done: 'Opening your DMs for you.'
      }
    },
    {
      id: 'app',
      title: 'Getting the app',
      keywords: ['app', 'mobile app', 'desktop app', 'download', 'install', 'pwa', 'home screen', 'apk'],
      answer: 'The footer has both: a desktop download (Windows, macOS, Linux) and "Install on this device" for phones and tablets.\n' +
        'On iPhone or iPad use Share, then "Add to Home Screen". The app uses the same account, arena, rooms and DMs as the website.',
      action: {
        label: 'Install on this device',
        buttonId: 'btnInstallAppDesktop',
        done: 'Running the install step for this device.'
      }
    },
    {
      id: 'updates',
      title: 'Updates and changelog',
      keywords: ['updates', 'changelog', 'new features', 'what is new', 'upcoming', 'completed updates', 'todo'],
      answer: 'The home page has both lists: "UPCOMING CHANGES" for what is being worked on and "COMPLETED UPDATES" for what shipped.\n' +
        'To ask for something new, send a support report under "App Issue".',
      action: {
        label: 'Open a feature request',
        buttonId: 'openSupport',
        popupId: 'supportPopup',
        done: 'Opening the support report form — choose "App Issue" for a request.'
      }
    },
    {
      id: 'age',
      title: 'The 18+ gate',
      keywords: ['18', 'age', 'age gate', 'underage', 'adult'],
      answer: 'Male Cyber Fighters is an 18+ site, so everyone confirms their age on the way in.\n' +
        'Your age is also part of your profile and must be 18 or over.',
      action: null
    },
    {
      id: 'admin',
      title: 'Admin panel',
      keywords: ['admin', 'admin panel', 'administrator', 'moderator'],
      answer: 'The Admin Panel only appears for the Administrator account — it lists users, bans, password resets and site analytics.\n' +
        'Everyone else reports problems through the Support window instead.',
      action: {
        label: 'Open a support report',
        buttonId: 'openSupport',
        popupId: 'supportPopup',
        done: 'Opening the support report form for you.'
      }
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
    { label: 'How do I DM someone?', text: 'how do I send a direct message?' },
    { label: 'Create a room', text: 'create a room' },
    { label: 'How do I edit my profile?', text: 'how do I edit my profile?' },
    { label: 'What are dice matches?', text: 'what are dice matches?' },
    { label: 'Report a problem', text: 'how do I report a problem?' }
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
        'I can help with the Arena, DMs, Rooms, Forums, the User Roster, story Archives, profiles, dice matches, calls, and the rules.\n' +
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
        'Ask me how anything on the site works and I will walk you through it, or tell me to open something and I will open that window for you.'
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
