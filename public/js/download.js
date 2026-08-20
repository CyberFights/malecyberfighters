// Desktop app download button.
// Detects the visitor's operating system and points the main "Download
// Desktop App" button at the matching installer (with a fallback list of all
// three platforms below it). Runs harmlessly on mobile, where the button is
// not visible.
(function () {
  'use strict';

  var btn = document.getElementById('btnDownloadApp');
  if (!btn) return;

  // Installers are published by the build workflow to GitHub Releases.
  // Update this base URL if the repository ever moves.
  var releaseBase =
    'https://github.com/CyberFights/malecyberfighters/releases/latest/download/';

  var files = {
    win: {
      href: releaseBase + 'CyberFights-win.exe',
      label: '⬇ Download for Windows'
    },
    mac: {
      href: releaseBase + 'CyberFights-mac.dmg',
      label: '⬇ Download for macOS'
    },
    linux: {
      href: releaseBase + 'CyberFights-linux.AppImage',
      label: '⬇ Download for Linux'
    }
  };

  function detectOS() {
    var ua = navigator.userAgent || '';
    var platform =
      (navigator.userAgentData && navigator.userAgentData.platform) ||
      navigator.platform ||
      '';

    if (/mac/i.test(platform) || /Macintosh|Mac OS X|MacIntel|MacPPC|Mac68K/i.test(ua)) return 'mac';
    if (/linux/i.test(platform) || /Linux/i.test(ua)) return 'linux';
    if (/win/i.test(platform) || /Windows/i.test(ua)) return 'win';
    return 'win';
  }

  var os = detectOS();
  var target = files[os] || files.win;

  btn.setAttribute('href', target.href);
  btn.textContent = target.label;

  // Highlight the matching platform link in the small list underneath.
  var links = document.querySelectorAll('.download-platforms a[data-platform]');
  for (var i = 0; i < links.length; i++) {
    if (links[i].getAttribute('data-platform') === os) {
      links[i].style.fontWeight = '700';
      links[i].style.color = '#e9f6ff';
    }
  }
})();
