const $ = id => document.getElementById(id);

function show(el){ el.style.display = 'flex'; }
function hide(el){ el.style.display = 'none'; }

function escapeHtml(s){
  return s.replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

const STORAGE_SESSION = 'cw_session_v1';
const STORAGE_PUBLIC = 'cw_public_v1';

function setSession(user){ localStorage.setItem(STORAGE_SESSION, JSON.stringify(user)); }
function getSession(){ return JSON.parse(localStorage.getItem(STORAGE_SESSION) || 'null'); }
function clearSession(){ localStorage.removeItem(STORAGE_SESSION); }

function loadPublic(){ return JSON.parse(localStorage.getItem(STORAGE_PUBLIC) || '[]'); }
function savePublic(arr){ localStorage.setItem(STORAGE_PUBLIC, JSON.stringify(arr)); }

// User profile card management
window.updateProfileCard = function(user) {
  const card = document.getElementById('userProfileCard');
  if (!card) return; // Card might not exist yet
  
  if (!user) {
    card.innerHTML = '<div style="font-size:14px;color:var(--muted)">🔒 Not logged in</div><p style="margin:8px 0 0 0;color:var(--muted);font-size:12px">Login or register to see your profile</p>';
    card.classList.remove('logged-in');
  } else {
    const initials = (user.displayName || user.username).split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
    const wins = (user.stats && user.stats.wins) || 0;
    const losses = (user.stats && user.stats.losses) || 0;
    const winRate = (wins + losses) > 0 ? ((wins / (wins + losses)) * 100).toFixed(0) : '0';
    const age = user.age ? `${user.age} years old` : 'Age not set';
    const bio = user.info || 'No bio';
    
    card.innerHTML = `
      <div class="profile-avatar">${initials}</div>
      <div class="profile-info">
        <div class="profile-name">${user.displayName || user.username}</div>
        <div class="profile-status">@${user.username}</div>
        <div class="profile-details">
          <div class="profile-age">${age}</div>
          <div class="profile-bio">${bio}</div>
        </div>
        <div class="profile-stats">
          <div class="profile-stat">
            <div class="profile-stat-value">${wins}</div>
            <div class="profile-stat-label">Wins</div>
          </div>
          <div class="profile-stat">
            <div class="profile-stat-value">${losses}</div>
            <div class="profile-stat-label">Losses</div>
          </div>
          <div class="profile-stat">
            <div class="profile-stat-value">${winRate}%</div>
            <div class="profile-stat-label">Win Rate</div>
          </div>
        </div>
      </div>
      <button id="logoutBtn" class="profile-logout ghost">Logout</button>
    `;
    card.classList.add('logged-in');
    
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', function() {
        if (window.logout) window.logout();
      });
    }
  }
};

// Update UI based on session state (placeholder for existing updateUIForSession)
window.updateUIForSession = function() {
  const user = getSession();
  if (user) {
    updateProfileCard(user);
  } else {
    updateProfileCard(null);
  }
};

// Check if user is logged in on page load
window.addEventListener('load', function() {
  const currentUser = JSON.parse(localStorage.getItem('currentUser'));
  if (currentUser) {
    window.updateProfileCard(currentUser);
  }
});
