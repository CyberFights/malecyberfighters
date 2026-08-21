/* -----------------------------------------------------------
   DISCORD DM BRIDGE — CLIENT
   Adds the "Discord Notifications" section behaviour inside the
   Account Settings modal (shared by desktop + mobile).

   - Shows link status ("Link Discord" / linked as @tag)
   - Toggle to forward site DM notifications to Discord DMs
   - Unlink (password confirmed)
----------------------------------------------------------- */

(function () {
  const el = id => document.getElementById(id);

  function session() {
    try {
      return typeof getSession === 'function' ? getSession() : null;
    } catch (_) {
      return null;
    }
  }

  function setStatus(text, tone) {
    const node = el('discordStatusText');
    if (!node) return;
    node.textContent = text;
    node.style.color =
      tone === 'error' ? '#fca5a5' : tone === 'good' ? '#86efac' : '#94a3b8';
  }

  function showSection(show) {
    const section = el('discordSection');
    if (section) section.style.display = show ? '' : 'none';
  }

  async function refreshDiscordStatus() {
    const user = session();
    if (!user || !user.username) {
      showSection(false);
      return;
    }

    const linkBtn = el('discordLinkBtn');
    const unlinkBtn = el('discordUnlinkBtn');
    const toggle = el('discordOptInToggle');
    const toggleRow = el('discordToggleRow');
    const unlinkRow = el('discordUnlinkRow');

    try {
      const res = await fetch(
        `/api/discord/status?username=${encodeURIComponent(user.username)}`
      );
      const data = await res.json();

      if (!data.ok) {
        showSection(false);
        return;
      }

      if (!data.configured) {
        showSection(true);
        setStatus('Discord linking is not configured on this server yet.', 'error');
        if (linkBtn) linkBtn.style.display = 'none';
        if (toggleRow) toggleRow.style.display = 'none';
        if (unlinkRow) unlinkRow.style.display = 'none';
        return;
      }

      showSection(true);

      if (data.linked) {
        setStatus(
          `Linked as ${data.discordTag || 'your Discord account'}.`,
          'good'
        );
        if (linkBtn) linkBtn.style.display = 'none';
        if (toggleRow) toggleRow.style.display = '';
        if (unlinkRow) unlinkRow.style.display = '';
        if (toggle) toggle.checked = !!data.optIn;

        if (!data.dmCapable) {
          setStatus(
            'Linked, but the Discord bot is offline so DMs cannot be delivered right now.',
            'error'
          );
        } else if (data.lastError) {
          setStatus(data.lastError, 'error');
        }
      } else {
        setStatus(
          'Not linked. Link your Discord account to get a DM there when someone messages you here while you are offline.',
          'muted'
        );
        if (linkBtn) linkBtn.style.display = '';
        if (toggleRow) toggleRow.style.display = 'none';
        if (unlinkRow) unlinkRow.style.display = 'none';
      }
    } catch (e) {
      console.error('discord status error', e);
      setStatus('Could not load Discord status.', 'error');
    }
  }

  window.refreshDiscordStatus = refreshDiscordStatus;

  function bind() {
    const linkBtn = el('discordLinkBtn');
    if (linkBtn && !linkBtn._dsBound) {
      linkBtn._dsBound = true;
      linkBtn.addEventListener('click', () => {
        const user = session();
        if (!user) return alert('You must be logged in.');
        window.open(
          `/auth/discord?username=${encodeURIComponent(user.username)}`,
          '_blank',
          'noopener'
        );
        setStatus('Finish the authorization in the new tab, then reopen settings.', 'muted');
      });
    }

    const toggle = el('discordOptInToggle');
    if (toggle && !toggle._dsBound) {
      toggle._dsBound = true;
      toggle.addEventListener('change', async () => {
        const user = session();
        if (!user) return;
        const desired = toggle.checked;
        try {
          const res = await fetch('/api/discord/opt-in', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: user.username, optIn: desired })
          });
          const data = await res.json();
          if (!data.ok) {
            toggle.checked = !desired;
            setStatus('Could not update the setting.', 'error');
            return;
          }
          setStatus(
            data.optIn
              ? 'Discord DM notifications are ON.'
              : 'Discord DM notifications are OFF.',
            'good'
          );
        } catch (e) {
          toggle.checked = !desired;
          setStatus('Network error updating the setting.', 'error');
        }
      });
    }

    const unlinkBtn = el('discordUnlinkBtn');
    if (unlinkBtn && !unlinkBtn._dsBound) {
      unlinkBtn._dsBound = true;
      unlinkBtn.addEventListener('click', async () => {
        const user = session();
        if (!user) return;
        const pwInput = el('discordUnlinkPassword');
        const password = pwInput ? pwInput.value : '';
        if (!password) {
          setStatus('Enter your password to unlink.', 'error');
          return;
        }
        try {
          const res = await fetch('/api/discord/unlink', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: user.username, password })
          });
          const data = await res.json();
          if (!data.ok) {
            setStatus(
              data.error === 'invalid_credentials'
                ? 'Incorrect password.'
                : 'Could not unlink.',
              'error'
            );
            return;
          }
          if (pwInput) pwInput.value = '';
          setStatus('Discord account unlinked.', 'good');
          refreshDiscordStatus();
        } catch (e) {
          setStatus('Network error while unlinking.', 'error');
        }
      });
    }
  }

  // Refresh status whenever the settings modal is opened.
  function wrapOpen() {
    if (window._discordWrappedOpen) return;
    if (typeof window.openAccountSettingsModal !== 'function') return;
    const orig = window.openAccountSettingsModal;
    window.openAccountSettingsModal = function () {
      const out = orig.apply(this, arguments);
      try {
        bind();
        refreshDiscordStatus();
      } catch (_) {}
      return out;
    };
    window._discordWrappedOpen = true;
  }

  document.addEventListener('DOMContentLoaded', () => {
    bind();
    wrapOpen();
  });
  window.addEventListener('load', () => {
    bind();
    wrapOpen();
  });
  setTimeout(wrapOpen, 800);
  setTimeout(wrapOpen, 2000);
})();
