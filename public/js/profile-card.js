/* ============================================================
   PROFILE CARD — React Bits <ProfileCard /> as plain DOM
   ------------------------------------------------------------
   React Bits ships this component as React + CSS. This app has no
   build step (public/ is served as-is) and its CSP only allows
   same-origin scripts, so the component was ported to a DOM factory
   that keeps the original markup, class names, prop names and
   stylesheet (/css/profile-card.css) — and with them the 3D tilt,
   the cursor-following glow and the holographic shine.

   Usage (same props as the React original):

     const { el, destroy } = ProfileCard.create({
       name: 'Javi A. Torres',
       handle: 'javicodes',
       status: 'Online',
       avatarUrl: '/path/to/avatar.jpg',
       contact: "6'1\" • 185 lbs",   // height / weight line
       showUserInfo: true,
       enableTilt: true,
       enableMobileTilt: true,
       behindGlowEnabled: true,
       innerGradient: 'linear-gradient(145deg,#60496e8c 0%,#71C4FF44 100%)',
       onContactClick: () => { ... }   // renders the contact button
     });

   The public chat's online list uses the ready-made popup instead:
   every row calls window.openProfileCard(user).
   ============================================================ */
(function () {
  'use strict';

  if (window.ProfileCard) return;

  const DEFAULT_INNER_GRADIENT = 'linear-gradient(145deg,#60496e8c 0%,#71C4FF44 100%)';

  const ANIMATION_CONFIG = {
    INITIAL_DURATION: 1200,
    INITIAL_X_OFFSET: 70,
    INITIAL_Y_OFFSET: 60,
    DEVICE_BETA_OFFSET: 20,
    ENTER_TRANSITION_MS: 180
  };

  const clamp = (v, min = 0, max = 100) => Math.min(Math.max(v, min), max);
  const round = (v, precision = 3) => parseFloat(v.toFixed(precision));
  const adjust = (v, fMin, fMax, tMin, tMax) => round(tMin + ((tMax - tMin) * (v - fMin)) / (fMax - fMin));

  /* ------------------------------------------------------------
     Small DOM helpers
  ------------------------------------------------------------ */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /* ------------------------------------------------------------
     Tilt engine — the requestAnimationFrame loop from the React
     component's useMemo, handed the two elements it drives.
  ------------------------------------------------------------ */
  function createTiltEngine(getShell, getWrap) {
    let rafId = null;
    let running = false;
    let lastTs = 0;

    let currentX = 0;
    let currentY = 0;
    let targetX = 0;
    let targetY = 0;

    const DEFAULT_TAU = 0.14;
    const INITIAL_TAU = 0.6;
    let initialUntil = 0;

    const setVarsFromXY = (x, y) => {
      const shell = getShell();
      const wrap = getWrap();
      if (!shell || !wrap) return;

      const width = shell.clientWidth || 1;
      const height = shell.clientHeight || 1;

      const percentX = clamp((100 / width) * x);
      const percentY = clamp((100 / height) * y);

      const centerX = percentX - 50;
      const centerY = percentY - 50;

      const properties = {
        '--pointer-x': `${percentX}%`,
        '--pointer-y': `${percentY}%`,
        '--background-x': `${adjust(percentX, 0, 100, 35, 65)}%`,
        '--background-y': `${adjust(percentY, 0, 100, 35, 65)}%`,
        '--pointer-from-center': `${clamp(Math.hypot(percentY - 50, percentX - 50) / 50, 0, 1)}`,
        '--pointer-from-top': `${percentY / 100}`,
        '--pointer-from-left': `${percentX / 100}`,
        '--rotate-x': `${round(-(centerX / 5))}deg`,
        '--rotate-y': `${round(centerY / 4)}deg`
      };

      for (const [k, v] of Object.entries(properties)) wrap.style.setProperty(k, v);
    };

    const step = ts => {
      if (!running) return;
      if (lastTs === 0) lastTs = ts;
      const dt = (ts - lastTs) / 1000;
      lastTs = ts;

      const tau = ts < initialUntil ? INITIAL_TAU : DEFAULT_TAU;
      const k = 1 - Math.exp(-dt / tau);

      currentX += (targetX - currentX) * k;
      currentY += (targetY - currentY) * k;

      setVarsFromXY(currentX, currentY);

      const stillFar = Math.abs(targetX - currentX) > 0.05 || Math.abs(targetY - currentY) > 0.05;

      if (stillFar || document.hasFocus()) {
        rafId = requestAnimationFrame(step);
      } else {
        running = false;
        lastTs = 0;
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
      }
    };

    const start = () => {
      if (running) return;
      running = true;
      lastTs = 0;
      rafId = requestAnimationFrame(step);
    };

    return {
      setImmediate(x, y) {
        currentX = x;
        currentY = y;
        setVarsFromXY(currentX, currentY);
      },
      setTarget(x, y) {
        targetX = x;
        targetY = y;
        start();
      },
      toCenter() {
        const shell = getShell();
        if (!shell) return;
        this.setTarget(shell.clientWidth / 2, shell.clientHeight / 2);
      },
      beginInitial(durationMs) {
        initialUntil = performance.now() + durationMs;
        start();
      },
      getCurrent() {
        return { x: currentX, y: currentY, tx: targetX, ty: targetY };
      },
      cancel() {
        if (rafId) cancelAnimationFrame(rafId);
        rafId = null;
        running = false;
        lastTs = 0;
      }
    };
  }

  /* ------------------------------------------------------------
     The card itself.
     Returns { el, destroy, setStatus } — `destroy` cancels the
     animation loop, so a closed popup never leaves one running.
  ------------------------------------------------------------ */
  function create(props = {}) {
    const {
      avatarUrl = '',
      iconUrl = '',
      grainUrl = '',
      innerGradient,
      behindGlowEnabled = true,
      behindGlowColor,
      behindGlowSize,
      className = '',
      enableTilt = true,
      enableMobileTilt = false,
      mobileTiltSensitivity = 5,
      miniAvatarUrl,
      name = 'Javi A. Torres',
      title = 'Software Engineer',
      handle = 'javicodes',
      status = 'Online',
      contact = '',
      contactText = 'Message',
      showUserInfo = true,
      autoActive = false,
      onContactClick
    } = props;

    /* The placeholder strings are what the React component defaults to; they
       would end up as url(<Placeholder for icon URL>), so treat them as unset. */
    const cleanUrl = value => (value && String(value).indexOf('Placeholder for') === -1 ? value : '');

    const wrap = el('div', `pc-card-wrapper ${className}`.trim());

    wrap.style.setProperty('--icon', cleanUrl(iconUrl) ? `url(${cleanUrl(iconUrl)})` : 'none');
    wrap.style.setProperty('--grain', cleanUrl(grainUrl) ? `url(${cleanUrl(grainUrl)})` : 'none');
    wrap.style.setProperty('--inner-gradient', innerGradient || DEFAULT_INNER_GRADIENT);
    wrap.style.setProperty('--behind-glow-color', behindGlowColor || 'rgba(125, 190, 255, 0.67)');
    wrap.style.setProperty('--behind-glow-size', behindGlowSize || '50%');

    if (behindGlowEnabled) wrap.appendChild(el('div', 'pc-behind'));

    const shell = el('div', 'pc-card-shell');
    const card = el('section', 'pc-card');
    const inside = el('div', 'pc-inside');

    inside.appendChild(el('div', 'pc-shine'));
    inside.appendChild(el('div', 'pc-glare'));

    const avatarContent = el('div', 'pc-content pc-avatar-content');
    const avatarImg = el('img', 'avatar');
    avatarImg.src = avatarUrl;
    avatarImg.alt = `${name || 'User'} avatar`;
    avatarImg.loading = 'lazy';
    avatarImg.referrerPolicy = 'no-referrer';
    avatarImg.addEventListener('error', () => {
      avatarImg.style.display = 'none';
    });
    avatarContent.appendChild(avatarImg);

    let statusNode = null;
    let contactNode = null;

    if (showUserInfo) {
      const info = el('div', 'pc-user-info');
      const details = el('div', 'pc-user-details');

      const mini = el('div', 'pc-mini-avatar');
      const miniImg = el('img');
      miniImg.src = miniAvatarUrl || avatarUrl;
      miniImg.alt = `${name || 'User'} mini avatar`;
      miniImg.loading = 'lazy';
      miniImg.referrerPolicy = 'no-referrer';
      miniImg.addEventListener('error', () => {
        /* Fall back to the main avatar once — repeating it would loop when
           that image is missing too. */
        if (miniImg.dataset.retried === '1') return;
        miniImg.dataset.retried = '1';
        miniImg.style.opacity = '0.5';
        miniImg.src = avatarUrl;
      });
      mini.appendChild(miniImg);

      const text = el('div', 'pc-user-text');
      text.appendChild(el('div', 'pc-handle', `@${handle}`));
      statusNode = el('div', 'pc-status', status);
      text.appendChild(statusNode);

      if (contact) {
        contactNode = el('div', 'pc-contact', contact);
        text.appendChild(contactNode);
      }

      details.appendChild(mini);
      details.appendChild(text);
      info.appendChild(details);

      if (typeof onContactClick === 'function') {
        const button = el('button', 'pc-contact-btn', contactText);
        button.type = 'button';
        button.addEventListener('click', () => onContactClick());
        info.appendChild(button);
      }

      avatarContent.appendChild(info);
    }

    inside.appendChild(avatarContent);

    const content = el('div', 'pc-content');
    const detailsBlock = el('div', 'pc-details');
    detailsBlock.appendChild(el('h3', null, name));
    detailsBlock.appendChild(el('p', null, title));
    content.appendChild(detailsBlock);
    inside.appendChild(content);

    card.appendChild(inside);
    shell.appendChild(card);
    wrap.appendChild(shell);

    /* ---- behaviour -------------------------------------------------- */
    let tiltEngine = enableTilt ? createTiltEngine(() => shell, () => wrap) : null;
    let enterTimer = null;
    let leaveRaf = null;

    const getOffsets = (event, node) => {
      const rect = node.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    const handlePointerMove = event => {
      if (!tiltEngine) return;
      const { x, y } = getOffsets(event, shell);
      tiltEngine.setTarget(x, y);
    };

    const handlePointerEnter = event => {
      if (!tiltEngine) return;

      shell.classList.add('active');
      shell.classList.add('entering');
      if (enterTimer) window.clearTimeout(enterTimer);
      enterTimer = window.setTimeout(() => {
        shell.classList.remove('entering');
      }, ANIMATION_CONFIG.ENTER_TRANSITION_MS);

      const { x, y } = getOffsets(event, shell);
      tiltEngine.setTarget(x, y);
    };

    const handlePointerLeave = () => {
      if (!tiltEngine) return;

      tiltEngine.toCenter();

      const checkSettle = () => {
        const { x, y, tx, ty } = tiltEngine.getCurrent();
        const settled = Math.hypot(tx - x, ty - y) < 0.6;
        if (settled) {
          shell.classList.remove('active');
          leaveRaf = null;
        } else {
          leaveRaf = requestAnimationFrame(checkSettle);
        }
      };
      if (leaveRaf) cancelAnimationFrame(leaveRaf);
      leaveRaf = requestAnimationFrame(checkSettle);
    };

    const handleDeviceOrientation = event => {
      if (!tiltEngine) return;
      const { beta, gamma } = event;
      if (beta == null || gamma == null) return;

      const centerX = shell.clientWidth / 2;
      const centerY = shell.clientHeight / 2;
      const x = clamp(centerX + gamma * mobileTiltSensitivity, 0, shell.clientWidth);
      const y = clamp(
        centerY + (beta - ANIMATION_CONFIG.DEVICE_BETA_OFFSET) * mobileTiltSensitivity,
        0,
        shell.clientHeight
      );

      tiltEngine.setTarget(x, y);
    };

    const handleClick = () => {
      if (!enableMobileTilt || location.protocol !== 'https:') return;
      const anyMotion = window.DeviceMotionEvent;
      if (anyMotion && typeof anyMotion.requestPermission === 'function') {
        anyMotion
          .requestPermission()
          .then(state => {
            if (state === 'granted') {
              window.addEventListener('deviceorientation', handleDeviceOrientation);
            }
          })
          .catch(console.error);
      } else {
        window.addEventListener('deviceorientation', handleDeviceOrientation);
      }
    };

    if (enableTilt && tiltEngine) {
      shell.addEventListener('pointerenter', handlePointerEnter);
      shell.addEventListener('pointermove', handlePointerMove);
      shell.addEventListener('pointerleave', handlePointerLeave);
      shell.addEventListener('click', handleClick);

      const initialX = (shell.clientWidth || 0) - ANIMATION_CONFIG.INITIAL_X_OFFSET;
      const initialY = ANIMATION_CONFIG.INITIAL_Y_OFFSET;
      tiltEngine.setImmediate(initialX, initialY);
      tiltEngine.toCenter();
      tiltEngine.beginInitial(ANIMATION_CONFIG.INITIAL_DURATION);
    }

    /* In the popup the card is the whole view: keep the cursor glow and the
       highlight on, instead of waiting for a hover the visitor has to guess
       at (and that a phone does not have). */
    if (autoActive) {
      wrap.classList.add('active');
      shell.classList.add('active');
    }

    const destroy = () => {
      if (enterTimer) window.clearTimeout(enterTimer);
      if (leaveRaf) cancelAnimationFrame(leaveRaf);
      if (tiltEngine) {
        tiltEngine.cancel();
        shell.removeEventListener('pointerenter', handlePointerEnter);
        shell.removeEventListener('pointermove', handlePointerMove);
        shell.removeEventListener('pointerleave', handlePointerLeave);
        shell.removeEventListener('click', handleClick);
        window.removeEventListener('deviceorientation', handleDeviceOrientation);
      }
      enterTimer = null;
      leaveRaf = null;
      tiltEngine = null;
    };

    const setStatus = value => {
      if (statusNode) statusNode.textContent = value;
    };

    const setContact = value => {
      if (!contactNode) return;
      contactNode.textContent = value;
    };

    return { el: wrap, destroy, setStatus, setContact, shell, wrapper: wrap };
  }

  /* ------------------------------------------------------------
     Member data → component props
  ------------------------------------------------------------ */
  function avatarSrc(user) {
    let url = user && user.imageUrl ? String(user.imageUrl) : '';
    if (url && typeof window.imgSrc === 'function') url = window.imgSrc(url);
    /* Members without a photo get the same initials avatar the app serves
       everywhere else, instead of an empty frame. */
    if (!url && user && user.username) url = `/avatar/${encodeURIComponent(user.username)}.png`;
    return url || '/images/mcf.png';
  }

  function recordLabel(user) {
    const wins = user.wins != null ? user.wins : user.stats && user.stats.wins;
    const losses = user.losses != null ? user.losses : user.stats && user.stats.losses;
    if (wins == null && losses == null) return '';
    return `${Number(wins) || 0}W – ${Number(losses) || 0}L`;
  }

  function titleFor(user) {
    /* Presence carries no role field, so use the app's own rule for the
       Administrator account and fall back to the fight record for everyone
       else (the card's `title` line). */
    const isAdmin = typeof window.isAdministratorUser === 'function'
      ? window.isAdministratorUser(user)
      : String(user.username || '').trim() === 'Administrator'
        || ['admin', 'administrator'].includes(String(user.role || '').toLowerCase());
    if (isAdmin) return 'Administrator';
    return recordLabel(user) || 'Male Cyber Fighter';
  }

  /* Height / weight line — the `contact` prop of the component. */
  function contactFor(user) {
    if (window.Physique && typeof window.Physique.physiqueSummary === 'function') {
      const summary = window.Physique.physiqueSummary(user.height, user.weight);
      if (summary) return summary;
    }
    const parts = [];
    if (user.height) parts.push(String(user.height));
    if (user.weight !== undefined && user.weight !== null && user.weight !== '') parts.push(`${user.weight} lbs`);
    return parts.join(' • ');
  }

  function findUser(username) {
    if (!username) return null;
    const wanted = String(username).toLowerCase();
    const pools = [window.users, window.allUsers];
    for (const pool of pools) {
      if (!Array.isArray(pool)) continue;
      const match = pool.find(
        u => u && String(u.username || '').toLowerCase() === wanted
      );
      if (match) return match;
    }
    const session = typeof window.getSession === 'function' ? window.getSession() : null;
    if (session && String(session.username || '').toLowerCase() === wanted) return session;
    return null;
  }

  function resolveUser(userOrUsername) {
    if (!userOrUsername) return null;
    if (typeof userOrUsername === 'string') {
      return findUser(userOrUsername) || { username: userOrUsername, display: userOrUsername };
    }
    return userOrUsername;
  }

  function propsForUser(user, extra = {}) {
    const username = user.username || '';
    const avatar = avatarSrc(user);
    const stats = contactFor(user);

    return Object.assign(
      {
        name: user.display || username || 'Fighter',
        title: titleFor(user),
        handle: username,
        status: 'Online',
        avatarUrl: avatar,
        miniAvatarUrl: avatar,
        contact: stats || 'No height / weight set',
        contactText: 'Message',
        showUserInfo: true,
        enableTilt: true,
        enableMobileTilt: true,
        behindGlowEnabled: true,
        autoActive: true,
        onContactClick: () => startDm(username)
      },
      extra
    );
  }

  /* ------------------------------------------------------------
     The popup the online list opens
  ------------------------------------------------------------ */
  let popupEl = null;
  let hostEl = null;
  let activeCard = null;
  let activeUser = null;

  function buildPopup() {
    let popup = document.getElementById('profileCardPopup');
    if (!popup) {
      popup = el('div', 'pc-popup');
      popup.id = 'profileCardPopup';
      popup.style.display = 'none';
      document.body.appendChild(popup);
    }

    if (popup.dataset.pcBuilt === '1') {
      popupEl = popup;
      hostEl = popup.querySelector('.pc-popup-host');
      return popup;
    }

    popup.dataset.pcBuilt = '1';
    popup.classList.add('pc-popup');
    popup.setAttribute('role', 'dialog');
    popup.setAttribute('aria-modal', 'true');
    popup.setAttribute('aria-label', 'Member profile card');
    if (!popup.style.display) popup.style.display = 'none';

    popup.textContent = '';

    const backdrop = el('div', 'pc-popup-backdrop');
    backdrop.setAttribute('data-pc-close', '');

    const panel = el('div', 'pc-popup-panel');
    const host = el('div', 'pc-popup-host');

    /* Messaging is the card's own contact button; the popup chrome only adds
       the way out into the full profile and the way to close it. */
    const actions = el('div', 'pc-popup-actions');

    const profileButton = el('button', 'small-btn', 'View full profile');
    profileButton.type = 'button';
    profileButton.setAttribute('data-pc-action', 'profile');

    const closeButton = el('button', 'small-btn', 'Close');
    closeButton.type = 'button';
    closeButton.setAttribute('data-pc-close', '');

    actions.appendChild(profileButton);
    actions.appendChild(closeButton);

    panel.appendChild(host);
    panel.appendChild(actions);
    popup.appendChild(backdrop);
    popup.appendChild(panel);
    popup.addEventListener('click', handlePopupClick);

    popupEl = popup;
    hostEl = host;
    return popup;
  }

  function handlePopupClick(event) {
    let node = event.target;
    if (node && node.nodeType === 3) node = node.parentElement;
    if (!node || typeof node.closest !== 'function') return;

    if (node.closest('[data-pc-close]')) {
      event.preventDefault();
      close();
      return;
    }

    const action = node.closest('[data-pc-action]');
    if (!action) return;

    event.preventDefault();
    const name = action.getAttribute('data-pc-action');
    const username = (activeUser && activeUser.username) || '';

    close();
    if (name === 'profile') openFullProfile(username);
  }

  function handlePopupKeydown(event) {
    if (event.key !== 'Escape' && event.key !== 'Esc') return;
    if (!popupEl || popupEl.style.display === 'none') return;
    close();
  }

  document.addEventListener('keydown', handlePopupKeydown);

  function startDm(username) {
    if (!username) return;
    if (typeof window.closeUserBrowsingPopups === 'function') window.closeUserBrowsingPopups();
    if (typeof window.openPrivateWindow === 'function') window.openPrivateWindow(username);
  }

  function openFullProfile(username) {
    if (!username) return;
    if (typeof window.closeUserBrowsingPopups === 'function') window.closeUserBrowsingPopups();
    if (typeof window.openUserProfile === 'function') window.openUserProfile(username);
    else if (typeof window.openProfile === 'function') window.openProfile(username);
  }

  function mount(user) {
    if (!hostEl) return null;
    if (activeCard && typeof activeCard.destroy === 'function') activeCard.destroy();
    activeCard = create(propsForUser(user));
    hostEl.textContent = '';
    hostEl.appendChild(activeCard.el);
    return activeCard;
  }

  function open(userOrUsername) {
    const user = resolveUser(userOrUsername);
    if (!user) return null;

    const popup = buildPopup();
    activeUser = user;
    /* Show the popup before mounting: the card measures its own box as soon as
       it is created, and a display:none parent measures as 0×0. */
    popup.style.display = 'flex';
    mount(user);
    return activeCard;
  }

  function close() {
    if (popupEl) popupEl.style.display = 'none';
    if (activeCard && typeof activeCard.destroy === 'function') activeCard.destroy();
    if (hostEl) hostEl.textContent = '';
    activeCard = null;
    activeUser = null;
  }

  function isOpen() {
    return !!popupEl && popupEl.style.display !== 'none';
  }

  /* Presence keeps changing while the card is on screen: flip the status line
     to Offline (and back) instead of closing what the member is looking at. */
  function syncPresence(users) {
    if (!activeUser || !activeCard) return;
    const wanted = String(activeUser.username || '').toLowerCase();
    const online = Array.isArray(users)
      ? users.some(u => u && String(u.username || '').toLowerCase() === wanted)
      : false;
    activeCard.setStatus(online ? 'Online' : 'Offline');
  }

  window.ProfileCard = {
    DEFAULT_INNER_GRADIENT,
    create,
    open,
    close,
    isOpen,
    syncPresence,
    contactFor,
    titleFor,
    avatarSrc
  };

  window.openProfileCard = open;
  window.closeProfileCard = close;
})();
