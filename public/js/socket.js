const socket = io();

socket.on('presence', onlineUsers => {
  window.users = onlineUsers;
  renderQuickRoster();
  renderRosterPage();
  renderOnlineList();
  if (window.updateDMListSidebar) updateDMListSidebar();
});

socket.on('publicMessage', msg => {
  appendPublicMessage(msg);
});


socket.on('privateMessage', pm => {
  const me = getSession();
  if (!me) return;

  const key = pmKey(pm.from, pm.to);
  let arr = loadDM(pm.from, pm.to);
  arr.push(pm);
  saveDM(pm.from, pm.to, arr);

  const other = pm.from === me.username ? pm.to : pm.from;

  if (pm.from !== me.username) {
    incrementUnread(pm.from);
  }

  window._pmStore = window._pmStore || {};
  window._pmStore[key] = arr;

  renderPM(other);
  if (window.updateDMListSidebar) updateDMListSidebar();
});

socket.on('pmError', e => alert('PM error: ' + e.reason));
