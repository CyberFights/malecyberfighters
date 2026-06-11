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
