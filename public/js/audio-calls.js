/* WebRTC audio calls for direct messages and custom rooms. Socket.IO carries signaling only. */
(() => {
  const calls = new Map();
  const pendingIce = new Map();
  const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function session() { return typeof getSession === 'function' ? getSession() : null; }

  /* Web Audio API context for reliable volume gain and audio routing across all devices */
  let audioCtx = null;
  function getAudioContext() {
    if (!audioCtx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) audioCtx = new AudioCtx();
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  /* Call tones: ringback while waiting to be answered, ring for incoming, and end tone */
  const TONES = {
    ringback: { src: '/sounds/call-ringback.mp3', loop: true, volume: 0.5 },
    ring: { src: '/sounds/call-ring.mp3', loop: true, volume: 0.6 },
    end: { src: '/sounds/call-end.mp3', loop: false, volume: 0.6 }
  };
  const toneEls = new Map();
  function toneEl(name) {
    let a = toneEls.get(name);
    if (!a) {
      a = new Audio(TONES[name].src);
      a.loop = TONES[name].loop;
      a.volume = TONES[name].volume;
      a.preload = 'auto';
      toneEls.set(name, a);
    }
    return a;
  }

  let ringing = null;
  function startRing(name) {
    stopRing();
    if (!TONES[name]) return;
    ringing = name;
    try {
      const a = toneEl(name);
      a.volume = Math.max(0.1, Math.min(1, TONES[name].volume * callVolume));
      const p = a.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) {}
  }

  function stopRing() {
    if (!ringing) return;
    const name = ringing;
    ringing = null;
    try {
      const a = toneEls.get(name);
      if (a) { a.pause(); a.currentTime = 0; }
    } catch (e) {}
  }

  // First interaction unlocks AudioContext and audio autoplay
  document.addEventListener('pointerdown', () => {
    getAudioContext();
    if (ringing) {
      const a = toneEls.get(ringing);
      if (a) a.play()?.catch(() => {});
    }
  }, { passive: true });

  function playEndTone() {
    stopRing();
    try {
      const a = toneEl('end');
      a.currentTime = 0;
      a.volume = Math.max(0.1, Math.min(1, TONES.end.volume * callVolume));
      a.play()?.catch(() => {});
    } catch (e) {}
  }

  /* Shared call volume: updates Web Audio GainNodes and HTMLAudioElements */
  let callVolume = 1.0;
  function setCallVolume(value) {
    callVolume = Math.max(0, Math.min(1, Number(value) || 0));
    const ctx = getAudioContext();
    calls.forEach(c => {
      if (c.gainNode && ctx) {
        try {
          c.gainNode.gain.setValueAtTime(callVolume, ctx.currentTime);
        } catch (_) {}
      }
      if (c.audio) {
        c.audio.volume = c.gainNode ? 0 : callVolume;
      }
    });
    const pct = Math.round(callVolume * 100);
    const slider = document.getElementById('audioVolume');
    if (slider) slider.value = String(pct);
    const label = document.getElementById('audioVolumeLabel');
    if (label) label.textContent = pct + '%';
  }

  /* Floating call overlay rendering */
  let isMinimized = false;
  function notify(title, text, actions = '') {
    let overlay = document.getElementById('audioCallOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'audioCallOverlay';
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = `
      <div class="audio-call-card${isMinimized ? ' minimized' : ''}" id="audioCallCard">
        <div class="audio-call-header-row">
          <strong>${esc(title)}</strong>
          <button class="small-btn secondary audio-min-btn" id="audioMinBtn" title="Minimize/Expand call card" type="button">${isMinimized ? 'Expand' : '_'}</button>
        </div>
        <div id="audioCallStatus">${esc(text)}</div>
        ${actions}
      </div>
    `;
    overlay.style.display = 'block';

    const card = document.getElementById('audioCallCard');
    if (card) makeCallCardDraggable(card);

    const minBtn = document.getElementById('audioMinBtn');
    if (minBtn) {
      minBtn.onclick = () => {
        isMinimized = !isMinimized;
        card.classList.toggle('minimized', isMinimized);
        minBtn.textContent = isMinimized ? 'Expand' : '_';
      };
    }

    return overlay;
  }

  function setStatus(text) {
    const e = document.getElementById('audioCallStatus');
    if (e) e.textContent = text;
  }

  function closeUI() {
    stopRing();
    const e = document.getElementById('audioCallOverlay');
    if (e) e.style.display = 'none';
  }

  /* Make floating call card draggable on desktop & mobile */
  function makeCallCardDraggable(card) {
    if (!card) return;
    let isDragging = false;
    let startX = 0, startY = 0;
    let initialLeft = 0, initialTop = 0;

    function onPointerDown(e) {
      if (e.target.closest('button, input, select, textarea, label')) return;
      isDragging = true;
      const rect = card.getBoundingClientRect();
      card.style.left = rect.left + 'px';
      card.style.top = rect.top + 'px';
      card.style.right = 'auto';
      card.style.bottom = 'auto';
      initialLeft = rect.left;
      initialTop = rect.top;
      startX = (e.touches && e.touches[0] ? e.touches[0].clientX : e.clientX) || 0;
      startY = (e.touches && e.touches[0] ? e.touches[0].clientY : e.clientY) || 0;
    }

    function onPointerMove(e) {
      if (!isDragging) return;
      const clientX = (e.touches && e.touches[0] ? e.touches[0].clientX : e.clientX) || 0;
      const clientY = (e.touches && e.touches[0] ? e.touches[0].clientY : e.clientY) || 0;
      const dx = clientX - startX;
      const dy = clientY - startY;
      let newLeft = initialLeft + dx;
      let newTop = initialTop + dy;

      const maxLeft = Math.max(0, window.innerWidth - card.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - card.offsetHeight);
      newLeft = Math.max(0, Math.min(newLeft, maxLeft));
      newTop = Math.max(0, Math.min(newTop, maxTop));

      card.style.left = newLeft + 'px';
      card.style.top = newTop + 'px';
    }

    function onPointerUp() {
      isDragging = false;
    }

    card.addEventListener('mousedown', onPointerDown);
    card.addEventListener('touchstart', onPointerDown, { passive: true });
    document.addEventListener('mousemove', onPointerMove);
    document.addEventListener('touchmove', onPointerMove, { passive: true });
    document.addEventListener('mouseup', onPointerUp);
    document.addEventListener('touchend', onPointerUp);
  }

  /* End call session and cleanup */
  function finish(peer, notifyPeer = true) {
    const c = calls.get(peer);
    pendingIce.delete(peer);
    if (c) {
      calls.delete(peer);
      try { c.pc.close(); } catch (_) {}
      if (c.stream) {
        try { c.stream.getTracks().forEach(t => t.stop()); } catch (_) {}
      }
      if (c.sourceNode) {
        try { c.sourceNode.disconnect(); } catch (_) {}
      }
      if (c.gainNode) {
        try { c.gainNode.disconnect(); } catch (_) {}
      }
      if (c.audio) {
        try { c.audio.remove(); } catch (_) {}
      }
      if (notifyPeer) socket.emit('audio-call-end', { to: peer });
    }

    if (calls.size === 0) {
      playEndTone();
      closeUI();
    } else {
      setStatus(`Connected (${calls.size} in call)`);
    }
  }

  function finishAll() {
    calls.forEach((_, peer) => finish(peer, true));
    playEndTone();
    closeUI();
  }

  /* Start / Answer Call */
  let sharedLocalStream = null;
  async function getLocalStream() {
    if (sharedLocalStream && sharedLocalStream.active) {
      return sharedLocalStream;
    }
    sharedLocalStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    return sharedLocalStream;
  }

  async function start(peer, incoming = false, offer = null) {
    if (calls.has(peer)) return;
    const me = session();
    if (!me) return;

    getAudioContext();

    const pc = new RTCPeerConnection(rtcConfig);
    const c = { pc, stream: null, audio: null, gainNode: null, sourceNode: null };
    calls.set(peer, c);

    pc.onicecandidate = e => {
      if (e.candidate) {
        socket.emit('audio-call-signal', { to: peer, kind: 'ice', candidate: e.candidate });
      }
    };

    pc.ontrack = e => {
      stopRing();
      setStatus('Connected');
      const stream = e.streams[0];

      // Route stream through Web Audio GainNode for reliable volume control
      try {
        const ctx = getAudioContext();
        if (ctx) {
          const source = ctx.createMediaStreamSource(stream);
          const gain = ctx.createGain();
          gain.gain.setValueAtTime(callVolume, ctx.currentTime);
          source.connect(gain);
          gain.connect(ctx.destination);
          c.sourceNode = source;
          c.gainNode = gain;
        }
      } catch (err) {
        console.warn('Web Audio gain routing notice:', err);
      }

      // Also attach DOM audio element for browser stream liveness
      let a = c.audio;
      if (!a) {
        a = document.createElement('audio');
        a.autoplay = true;
        a.playsInline = true;
        a.setAttribute('playsinline', '');
        a.style.display = 'none';
        document.body.appendChild(a);
        c.audio = a;
      }
      a.srcObject = stream;
      a.volume = c.gainNode ? 0 : callVolume;
      a.play()?.catch(() => {});
    };

    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) {
        finish(peer);
      }
    };

    try {
      const stream = await getLocalStream();
      c.stream = stream;
      stream.getTracks().forEach(t => pc.addTrack(t, stream));

      const vol = Math.round(callVolume * 100);
      notify(
        incoming ? `Call: @${peer}` : `Calling @${peer}`,
        incoming ? 'Connected' : 'Connecting…',
        `
        <div class="audio-call-volume">
          <label for="audioVolume">Volume</label>
          <input id="audioVolume" type="range" min="0" max="100" step="1" value="${vol}">
          <span id="audioVolumeLabel">${vol}%</span>
        </div>
        <div class="audio-call-actions">
          <button id="audioHangup" class="small-btn" type="button">Hang up</button>
          <button id="audioMute" class="small-btn" type="button">Mute</button>
        </div>
        `
      );

      if (incoming) {
        stopRing();
        setStatus('Connected');
      } else {
        startRing('ringback');
      }

      document.getElementById('audioHangup').onclick = finishAll;
      document.getElementById('audioVolume').oninput = e => setCallVolume(e.target.value / 100);
      document.getElementById('audioMute').onclick = e => {
        let isMuted = false;
        calls.forEach(entry => {
          if (entry.stream) {
            entry.stream.getAudioTracks().forEach(t => {
              t.enabled = !t.enabled;
              isMuted = !t.enabled;
            });
          }
        });
        e.target.textContent = isMuted ? 'Unmute' : 'Mute';
      };

      if (!incoming) {
        const o = await pc.createOffer();
        await pc.setLocalDescription(o);
        socket.emit('audio-call-signal', { to: peer, kind: 'offer', offer: o });
      } else {
        await pc.setRemoteDescription(offer);
        for (const candidate of pendingIce.get(peer) || []) {
          await pc.addIceCandidate(candidate);
        }
        pendingIce.delete(peer);
        const a = await pc.createAnswer();
        await pc.setLocalDescription(a);
        socket.emit('audio-call-signal', { to: peer, kind: 'answer', answer: a });
      }
    } catch (err) {
      console.error('Audio call setup error:', err);
      const message = err?.name === 'NotAllowedError' ? 'Microphone permission is required.' : 'Unable to start the audio call.';
      finish(peer, false);
      alert(message);
    }
  }

  window.startAudioCall = peer => {
    if (!navigator.mediaDevices?.getUserMedia) {
      return alert('Audio calling requires a secure connection (HTTPS) or localhost.');
    }
    const cleanPeer = String(peer || '').trim();
    if (!cleanPeer) return;
    start(cleanPeer);
  };

  /* Listeners for room conference and DM call buttons */
  document.addEventListener('click', e => {
    const roomBtn = e.target.closest('#roomCallBtn, .room-call');
    if (roomBtn) {
      const room = document.getElementById('roomChatPopup')?.dataset.room;
      if (!room) return alert('Please enter a room first.');
      socket.emit('room-audio-invite', { room });
      notify(
        'Conference call',
        'Inviting everyone in this room…',
        '<div class="audio-call-actions"><button id="audioHangup" class="small-btn" type="button">Cancel</button></div>'
      );
      document.getElementById('audioHangup').onclick = closeUI;
      return;
    }

    const dmBtn = e.target.closest('#dmCall, .dm-call');
    if (dmBtn) {
      const dmPopup = document.getElementById('dmPopup');
      const partner = dmPopup?.dataset.partner;
      if (partner) {
        window.startAudioCall(partner);
      }
      return;
    }
  });

  socket.on('room-audio-invite', ({ room, from }) => {
    const currentRoom = document.getElementById('roomChatPopup')?.dataset.room;
    if (currentRoom && String(currentRoom) !== String(room)) return;

    startRing('ring');
    const ui = notify(
      'Room conference call',
      `@${from} started a call`,
      `
      <div class="audio-call-actions">
        <button id="audioAccept" class="small-btn" type="button">Join</button>
        <button id="audioReject" class="small-btn" type="button">Decline</button>
      </div>
      `
    );
    ui.querySelector('#audioAccept').onclick = () => {
      stopRing();
      socket.emit('room-audio-join', { room, to: from });
      start(from);
    };
    ui.querySelector('#audioReject').onclick = closeUI;
  });

  socket.on('room-audio-join', ({ from }) => {
    window.startAudioCall(from);
  });

  socket.on('audio-call-signal', async p => {
    const from = p.from;
    if (p.kind === 'offer') {
      if (calls.has(from)) return;
      const ui = notify(
        'Incoming audio call',
        `@${from} is calling you`,
        `
        <div class="audio-call-actions">
          <button id="audioAccept" class="small-btn" type="button">Accept</button>
          <button id="audioReject" class="small-btn" type="button">Reject</button>
        </div>
        `
      );
      startRing('ring');
      ui.querySelector('#audioAccept').onclick = () => {
        stopRing();
        start(from, true, p.offer);
      };
      ui.querySelector('#audioReject').onclick = () => {
        socket.emit('audio-call-end', { to: from });
        closeUI();
      };
    } else if (p.kind === 'answer' && calls.has(from)) {
      stopRing();
      setStatus('Connected');
      try {
        await calls.get(from).pc.setRemoteDescription(p.answer);
      } catch (_) {}
    } else if (p.kind === 'ice' && p.candidate) {
      if (calls.has(from)) {
        try {
          await calls.get(from).pc.addIceCandidate(p.candidate);
        } catch (_) {}
      } else {
        const queued = pendingIce.get(from) || [];
        queued.push(p.candidate);
        pendingIce.set(from, queued);
      }
    }
  });

  socket.on('audio-call-end', ({ from }) => {
    pendingIce.delete(from);
    if (calls.has(from)) {
      finish(from, false);
    } else {
      closeUI();
    }
  });
})();
