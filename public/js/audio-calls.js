/* WebRTC audio calls for direct messages. Socket.IO carries signaling only. */
(() => {
  const calls = new Map();
  const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function session() { return typeof getSession === 'function' ? getSession() : null; }
  function notify(title, text, actions = '') {
    let el = document.getElementById('audioCallOverlay');
    if (!el) { el = document.createElement('div'); el.id = 'audioCallOverlay'; document.body.appendChild(el); }
    el.innerHTML = `<div class="audio-call-card"><strong>${esc(title)}</strong><div>${esc(text)}</div>${actions}</div>`;
    el.style.display = 'flex'; return el;
  }
  function closeUI() { const e = document.getElementById('audioCallOverlay'); if (e) e.style.display = 'none'; }
  function finish(peer) { const c = calls.get(peer); if (!c) return; c.pc.close(); if (c.stream) c.stream.getTracks().forEach(t => t.stop()); if (c.audio) c.audio.remove(); calls.delete(peer); socket.emit('audio-call-end', { to: peer }); closeUI(); }
  async function start(peer, incoming = false, offer = null) {
    if (calls.has(peer)) return;
    const me = session(); if (!me) return;
    const pc = new RTCPeerConnection(rtcConfig), c = { pc, stream: null, audio: null }; calls.set(peer, c);
    pc.onicecandidate = e => e.candidate && socket.emit('audio-call-signal', { to: peer, kind: 'ice', candidate: e.candidate });
    pc.ontrack = e => { c.audio = c.audio || Object.assign(document.createElement('audio'), { autoplay: true }); c.audio.srcObject = e.streams[0]; };
    pc.onconnectionstatechange = () => { if (['failed','disconnected','closed'].includes(pc.connectionState)) finish(peer); };
    c.stream = await navigator.mediaDevices.getUserMedia({ audio: true }); c.stream.getTracks().forEach(t => pc.addTrack(t, c.stream));
    notify(incoming ? 'Incoming audio call' : 'Calling ' + peer, incoming ? peer + ' is calling you' : 'Connecting…', `<button id="audioHangup" class="small-btn">Hang up</button><button id="audioMute" class="small-btn">Mute</button>`);
    document.getElementById('audioHangup').onclick = () => finish(peer);
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
      ui.querySelector('#audioAccept').onclick = () => start(from, true, p.offer);
      ui.querySelector('#audioReject').onclick = () => { socket.emit('audio-call-end', { to: from }); closeUI(); };
    } else if (p.kind === 'answer' && calls.has(from)) await calls.get(from).pc.setRemoteDescription(p.answer);
    else if (p.kind === 'ice' && calls.has(from)) try { await calls.get(from).pc.addIceCandidate(p.candidate); } catch (_) {}
  });
  socket.on('audio-call-end', ({ from }) => { if (calls.has(from)) finish(from); else closeUI(); });
})();
