(() => {
  'use strict';

  const header = document.getElementById('siteHeader');
  const navToggle = document.getElementById('navToggle');
  const headerMenu = document.getElementById('headerMenu');
  const ageGate = document.getElementById('ageGate');
  const confirmButton = document.getElementById('confirmBtn');
  const introGif = document.getElementById('introGif');
  const declineButton = document.getElementById('declineBtn');
  const toast = document.getElementById('toast');
  let toastTimer;

  function showToast(message) {
    if (!toast) return;
    window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add('is-visible');
    toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 3600);
  }

  function setMenu(open) {
    if (!header || !navToggle) return;
    header.classList.toggle('is-open', open);
    navToggle.setAttribute('aria-expanded', String(open));
    navToggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
  }

  if (navToggle && headerMenu) {
    navToggle.addEventListener('click', () => {
      setMenu(navToggle.getAttribute('aria-expanded') !== 'true');
    });

    headerMenu.querySelectorAll('a').forEach(link => {
      link.addEventListener('click', () => setMenu(false));
    });

    window.addEventListener('resize', () => {
      if (window.innerWidth > 1100) setMenu(false);
    });
  }

  function updateHeader() {
    if (header) header.classList.toggle('is-scrolled', window.scrollY > 24);
  }
  updateHeader();
  window.addEventListener('scroll', updateHeader, { passive: true });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && navToggle && navToggle.getAttribute('aria-expanded') === 'true') {
      setMenu(false);
      navToggle.focus();
    }
  });

  // Keep the promotional page safe to view, but confirm adulthood before a
  // visitor enters the community. Without JS, these same links go directly to
  // the main app, which has its own age gate.
  document.querySelectorAll('.js-enter').forEach(link => {
    link.addEventListener('click', event => {
      if (!ageGate || typeof ageGate.showModal !== 'function') return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      setMenu(false);
      ageGate.showModal();
    });
  });

  if (confirmButton) {
    confirmButton.addEventListener('click', event => {
      // The landing page is now the age gate. Hand that confirmation to the
      // app for this tab so entering does not present the old gate a second
      // time. If storage is unavailable the app safely asks again.
      try { window.sessionStorage.setItem('mcfAgeConfirmed', 'true'); } catch (_) {}
      if (!introGif) return;

      event.preventDefault();
      if (confirmButton.dataset.entering === 'true') return;
      confirmButton.dataset.entering = 'true';
      confirmButton.setAttribute('aria-disabled', 'true');
      if (ageGate && typeof ageGate.close === 'function') ageGate.close();

      // Preserve the original entrance sequence, without downloading the
      // animation for visitors who have not confirmed their age.
      introGif.innerHTML =
        '<picture>' +
          '<source srcset="/images/intro.webp" type="image/webp">' +
          '<img src="/images/intro.gif" alt="" width="426" height="240">' +
        '</picture>';
      introGif.hidden = false;
      window.requestAnimationFrame(() => introGif.classList.add('is-visible'));

      window.setTimeout(() => {
        window.location.assign(confirmButton.href);
      }, 9000);
    });
  }

  if (declineButton && ageGate) {
    declineButton.addEventListener('click', () => {
      ageGate.close();
      showToast('No problem. You must be 18 or older to enter Male Cyber Fighters.');
    });

    // Native dialog elements do not close on backdrop clicks by default.
    ageGate.addEventListener('click', event => {
      if (event.target !== ageGate) return;
      const bounds = ageGate.getBoundingClientRect();
      const inside = event.clientX >= bounds.left && event.clientX <= bounds.right &&
        event.clientY >= bounds.top && event.clientY <= bounds.bottom;
      if (!inside) ageGate.close();
    });
  }

  // Accessible, keyboard-navigable match-style preview.
  const modeTabs = Array.from(document.querySelectorAll('[data-mode]'));
  const modePanels = Array.from(document.querySelectorAll('[data-mode-panel]'));

  function selectMode(selectedTab, moveFocus = false) {
    modeTabs.forEach(tab => {
      const selected = tab === selectedTab;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    modePanels.forEach(panel => {
      panel.hidden = panel.dataset.modePanel !== selectedTab.dataset.mode;
    });
    if (moveFocus) selectedTab.focus();
  }

  modeTabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectMode(tab));
    tab.addEventListener('keydown', event => {
      let nextIndex;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (index + 1) % modeTabs.length;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (index - 1 + modeTabs.length) % modeTabs.length;
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = modeTabs.length - 1;
      if (nextIndex === undefined) return;
      event.preventDefault();
      selectMode(modeTabs[nextIndex], true);
    });
  });

  const promo = {
    title: 'Your Next Rival Is Waiting — Male Cyber Fighters',
    text: 'Your next rival is waiting. Step into Male Cyber Fighters — free 18+ cyber wrestling, live chat, dice matches, private rooms and fight stories. Your match. Your rules.',
    url: 'https://male-cyber-fighters.com/'
  };

  async function copyPromoPost() {
    const post = `${promo.text}\n${promo.url}`;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(post);
      } else {
        const field = document.createElement('textarea');
        field.value = post;
        field.setAttribute('readonly', '');
        field.style.position = 'fixed';
        field.style.opacity = '0';
        document.body.appendChild(field);
        field.select();
        const copied = document.execCommand('copy');
        field.remove();
        if (!copied) throw new Error('Copy command unavailable');
      }
      showToast('Promo post copied — ready to share with a future rival.');
    } catch (_) {
      showToast('Copy unavailable. Share male-cyber-fighters.com with your next rival.');
    }
  }

  document.querySelectorAll('[data-share]').forEach(button => {
    button.addEventListener('click', async () => {
      setMenu(false);
      if (navigator.share) {
        try {
          await navigator.share(promo);
          return;
        } catch (error) {
          if (error && error.name === 'AbortError') return;
        }
      }
      await copyPromoPost();
    });
  });

  const year = document.getElementById('currentYear');
  if (year) year.textContent = String(new Date().getFullYear());

  // Subtle on-scroll entrances. Content stays visible when JS or the observer
  // is unavailable, and the effect is disabled for reduced-motion visitors.
  const revealItems = document.querySelectorAll('.reveal');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!('IntersectionObserver' in window) || reducedMotion) {
    revealItems.forEach(item => item.classList.add('is-visible'));
  } else {
    document.body.classList.add('reveal-ready');
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    revealItems.forEach(item => observer.observe(item));
  }
})();
