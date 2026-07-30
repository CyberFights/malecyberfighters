/* ============================================================
   admin-auth-mobile.js — Mobile version of admin-auth.js
   Adapted from ./public/js/admin-auth.js for ./public/mobile.html

   ID conversions:
     Desktop ID                →  Mobile ID
     -------------------------------------------------------
     btnAdmin                  →  (not in mobile — use prompt-based auth)
     modalAdminPassword        →  (not in mobile — use prompt() instead)
     adminPasswordCancel       →  (not in mobile)
     adminPasswordSubmit       →  (not in mobile)
     adminPasswordInput        →  (not in mobile)
     adminPasswordError        →  (not in mobile)

   Mobile uses prompt()-based admin auth instead of a modal,
   since mobile.html doesn't have a dedicated admin password modal.
   This matches the approach used by mobile.js's promptAdminKey().
============================================================ */

window.adminSessionKey = null;

/* Open Admin — Mobile uses prompt() instead of modalAdminPassword */
function openAdminAuth() {
  if (window.adminSessionKey) {
    if (window.loadAdminPanel) window.loadAdminPanel();
    return;
  }

  const input = prompt("Enter admin password:");
  if (!input) return;

  verifyAdminKey(input);
}

async function verifyAdminKey(input) {
  try {
    const resp = await fetch("/api/admin/users", {
      headers: { "x-admin-key": input }
    });

    const data = await resp.json();

    if (!data.ok) {
      alert("Incorrect admin password.");
      return;
    }

    window.adminSessionKey = input;

    if (window.loadAdminPanel) window.loadAdminPanel();
  } catch (err) {
    alert("Network error while verifying admin password.");
  }
}

// MOBILE: listen for clicks on any element that should open admin
// Since mobile.html doesn't have a dedicated #btnAdmin, we check
// for the admin panel trigger from mobile.js or other sources
document.addEventListener("click", (e) => {
  // Support both a dedicated btnAdmin and the mobile.js admin trigger
  if (e.target.id === "btnAdmin" || e.target.classList.contains("admin-trigger")) {
    e.preventDefault();
    openAdminAuth();
  }
});

// Expose for mobile.js to call directly
window.openAdminAuth = openAdminAuth;
