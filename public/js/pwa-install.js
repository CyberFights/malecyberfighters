/*
 * Install support shared by the website and the mobile app landing UI.
 * Android/Chrome can show a native install prompt. iPhone and iPad do not
 * expose that prompt, so the button explains Apple's Share > Add to Home
 * Screen flow instead.
 */
(function () {
  'use strict';

  var deferredPrompt = null;
  var installButtons = Array.prototype.slice.call(document.querySelectorAll('#btnInstallApp, #btnInstallAppDesktop'));
  var hintElements = Array.prototype.slice.call(document.querySelectorAll('#appInstallHint, #appInstallHintDesktop'));
  var standalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
  var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent || '');

  function setInstallVisibility(visible) {
    installButtons.forEach(function (button) {
      if (standalone) {
        button.hidden = true;
        button.setAttribute('aria-hidden', 'true');
        return;
      }
      button.hidden = !visible;
      button.setAttribute('aria-hidden', String(!visible));
    });
  }

  // Do not offer to install an app that is already running in standalone mode.
  if (standalone) setInstallVisibility(false);

  function setHint(message) {
    hintElements.forEach(function (element) {
      if (message) element.textContent = message;
    });
  }

  window.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault();
    deferredPrompt = event;
    setInstallVisibility(true);
    setHint('Install the arena on your home screen for an app-like experience.');
  });

  if (isIOS && !standalone) {
    setInstallVisibility(true);
    setHint('On iPhone or iPad, tap Share, then Add to Home Screen.');
  }

  installButtons.forEach(function (button) {
    button.addEventListener('click', async function () {
      if (!deferredPrompt) {
        if (isIOS) {
          setHint('Tap the Share button in Safari, then choose Add to Home Screen.');
        } else {
          setHint('Use your browser menu and choose Install app or Add to home screen.');
        }
        return;
      }

      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      setInstallVisibility(false);
    });
  });

  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    setInstallVisibility(false);
    setHint('Male Cyber Fighters has been added to your home screen.');
  });

  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function (error) {
        console.warn('PWA service worker registration failed:', error);
      });
    });
  }
})();
