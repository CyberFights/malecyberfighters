/* WebRTC audio calls for direct messages. Socket.IO carries signaling only. */
(() => {
  const calls = new Map();
  const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function session() { return typeof getSession === 'function' ? getSession() : null; }
  /* Call tones: a looping ring while a call is still unanswered, plus a short tone when one ends. */
  const TONES = {
    ringback: { src: '/sounds/call-ringback.mp3', loop: true, volume: 0.5 },
    ring: { src: '/sounds/call-ring.mp3', loop: true, volume: 0.6 },
    end: { src: '/sounds/call-end.mp3', loop: false, volume: 0.6 }
  };
  const toneEls = new Map();
  function toneEl(name) {
    let a = toneEls.get(name);
    if (!a) { a = new Audio(TONES[name].src); a.loop = TONES[name].loop; a.volume = TONES[name].volume; a.preload = 'auto'; toneEls.set(name, a); }
    return a;
  }
  let ringing = null;
  function startRing(name) {
    stopRing();
    if (!TONES[name]) return;
    ringing = name;
    try {
      const p = toneEl(name).play();
      if (p && typeof p.catch === 'function') p.catch(() => { if (ringing === name) ringing = null; });
    } catch (e) {
      ringing = null; // Ignore audio errors (e.g., browser autoplay policy).
    }
  }
  function stopRing() {
    if (!ringing) return;
    const name = ringing; ringing = null;
    try { const a = toneEls.get(name); if (a) { a.pause(); a.currentTime = 0; } } catch (e) {}
  }
  function playEndTone() {
    stopRing();
    try {
      const a = toneEl('end'); a.currentTime = 0;
      const p = a.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) {
      // Ignore audio errors (e.g., browser autoplay policy).
    }
  }
  /* Remote audio volume, shared by every active call and applied to audio
     elements created later, so the setting survives a peer connecting. */
  let callVolume = 1;
  function setCallVolume(value) {
    callVolume = Math.max(0, Math.min(1, Number(value) || 0));
    calls.forEach(c => { if (c.audio) c.audio.volume = callVolume; });
    const pct = Math.round(callVolume * 100);
    const slider = document.getElementById('audioVolume'); if (slider) slider.value = String(pct);
    const label = document.getElementById('audioVolumeLabel'); if (label) label.textContent = pct + '%';
  }
  function notify(title, text, actions = '') {
    let el = document.getElementById('audioCallOverlay');
    if (!el) { el = document.createElement('div'); el.id = 'audioCallOverlay'; document.body.appendChild(el); }
    el.innerHTML = `<div class="audio-call-card"><strong>${esc(title)}</strong><div id="audioCallStatus">${esc(text)}</div>${actions}</div>`;
    el.style.display = 'flex'; return el;
  }
  function setStatus(text) { const e = document.getElementById('audioCallStatus'); if (e) e.textContent = text; }
  function closeUI() { stopRing(); const e = document.getElementById('audioCallOverlay'); if (e) e.style.display = 'none'; }
  function finish(peer) { const c = calls.get(peer); if (!c) return; c.pc.close(); if (c.stream) c.stream.getTracks().forEach(t => t.stop()); if (c.audio) c.audio.remove(); calls.delete(peer); socket.emit('audio-call-end', { to: peer }); playEndTone(); closeUI(); }
  async function start(peer, incoming = false, offer = null) {
    if (calls.has(peer)) return;
    const me = session(); if (!me) return;
    const pc = new RTCPeerConnection(rtcConfig), c = { pc, stream: null, audio: null }; calls.set(peer, c);
    pc.onicecandidate = e => e.candidate && socket.emit('audio-call-signal', { to: peer, kind: 'ice', candidate: e.candidate });
    pc.ontrack = e => { stopRing(); setStatus('Connected'); c.audio = c.audio || Object.assign(document.createElement('audio'), { autoplay: true }); c.audio.volume = callVolume; c.audio.srcObject = e.streams[0]; };
    pc.onconnectionstatechange = () => { if (['failed','disconnected','closed'].includes(pc.connectionState)) finish(peer); };
    c.stream = await navigator.mediaDevices.getUserMedia({ audio: true }); c.stream.getTracks().forEach(t => pc.addTrack(t, c.stream));
    const vol = Math.round(callVolume * 100);
    notify(incoming ? 'Incoming audio call' : 'Calling ' + peer, incoming ? peer + ' is calling you' : 'Connecting…', `<div class="audio-call-volume"><label for="audioVolume">Volume</label><input id="audioVolume" type="range" min="0" max="100" step="1" value="${vol}"><span id="audioVolumeLabel">${vol}%</span></div><button id="audioHangup" class="small-btn">Hang up</button><button id="audioMute" class="small-btn">Mute</button>`);
    if (incoming) { stopRing(); setStatus('Connected'); } else startRing('ringback'); // ring until the other side picks up
    document.getElementById('audioHangup').onclick = () => finish(peer);
    document.getElementById('audioVolume').oninput = e => setCallVolume(e.target.value / 100);
    document.getElementById('audioMute').onclick = e => { const t = c.stream.getAudioTracks()[0]; t.enabled = !t.enabled; e.target.textContent = t.enabled ? 'Mute' : 'Unmute'; };
    if (!incoming) { const o = await pc.createOffer(); await pc.setLocalDescription(o); socket.emit('audio-call-signal', { to: peer, kind: 'offer', offer: o }); }
    else { await pc.setRemoteDescription(offer); const a = await pc.createAnswer(); await pc.setLocalDescription(a); socket.emit('audio-call-signal', { to: peer, kind: 'answer', answer: a }); }
  }
  window.startAudioCall = peer => { if (!navigator.mediaDevices?.getUserMedia) return alert('Audio calling is not supported here.'); start(peer); };
  document.addEventListener('click', e => {
    if (e.target.id !== 'roomCallBtn') return;
    const room = document.getElementById('roomChatPopup')?.dataset.room;
    if (!room) return;
    socket.emit('room-audio-invite', { room });
    notify('Conference call', 'Inviting everyone in this room…', '<button id="audioHangup" class="small-btn">Cancel</button>');
    document.getElementById('audioHangup').onclick = closeUI;
  });
  socket.on('room-audio-invite', ({ room, from }) => {
    if (document.getElementById('roomChatPopup')?.dataset.room !== room) return;
    const ui = notify('Room conference call', from + ' started a call', '<button id="audioAccept" class="small-btn">Join</button><button id="audioReject" class="small-btn">Decline</button>');
    ui.querySelector('#audioAccept').onclick = () => { socket.emit('room-audio-join', { room, to: from }); closeUI(); };
    ui.querySelector('#audioReject').onclick = closeUI;
  });
  socket.on('room-audio-join', ({ from }) => { window.startAudioCall(from); });
  socket.on('audio-call-signal', async p => {
    const from = p.from; if (p.kind === 'offer') {
      if (calls.size) return socket.emit('audio-call-end', { to: from });
      const ui = notify('Incoming audio call', from + ' is calling you', `<button id="audioAccept" class="small-btn">Accept</button><button id="audioReject" class="small-btn">Reject</button>`);
      startRing('ring'); // ring until the call is accepted, rejected or cancelled
      ui.querySelector('#audioAccept').onclick = () => start(from, true, p.offer);
      ui.querySelector('#audioReject').onclick = () => { socket.emit('audio-call-end', { to: from }); closeUI(); };
    } else if (p.kind === 'answer' && calls.has(from)) { stopRing(); setStatus('Connected'); await calls.get(from).pc.setRemoteDescription(p.answer); }
    else if (p.kind === 'ice' && calls.has(from)) try { await calls.get(from).pc.addIceCandidate(p.candidate); } catch (_) {}
  });
  socket.on('audio-call-end', ({ from }) => { if (calls.has(from)) finish(from); else closeUI(); });
})();
