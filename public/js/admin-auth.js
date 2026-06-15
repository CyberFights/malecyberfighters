/* -----------------------------------------------------------
   ADMIN PANEL PASSWORD GATE
----------------------------------------------------------- */

let adminSessionKey = null;

/* When user clicks Admin Panel button */
document.getElementById("btnAdmin").addEventListener("click", () => {
  // If already authenticated, open admin panel immediately
  if (adminSessionKey) {
    loadAdminPanel();
    return;
  }

  // Otherwise show password modal
  show(document.getElementById("modalAdminPassword"));
});

/* Cancel button */
document.getElementById("adminPasswordCancel").addEventListener("click", () => {
  hide(document.getElementById("modalAdminPassword"));
});

/* Submit password */
document.getElementById("adminPasswordSubmit").addEventListener("click", async () => {
  const input = document.getElementById("adminPasswordInput").value.trim();
  const error = document.getElementById("adminPasswordError");

  error.style.display = "none";

  if (!input) {
    error.textContent = "Enter a password";
    error.style.display = "block";
    return;
  }

  // Try hitting a protected admin endpoint
  const resp = await fetch("/api/admin/users", {
    headers: { "x-admin-key": input }
  });

  const data = await resp.json();

  if (!data.ok) {
    error.textContent = "Incorrect password";
    error.style.display = "block";
    return;
  }

  // Password correct → store session key
  adminSessionKey = input;

  hide(document.getElementById("modalAdminPassword"));

  // Open admin panel
  loadAdminPanel();
});

/* Override loadAdminPanel to include adminSessionKey */
window.loadAdminPanel = async function () {
  const res = await fetch("/api/admin/users", {
    headers: { "x-admin-key": adminSessionKey }
  });

  const data = await res.json();
  if (!data.ok) {
    alert("Admin access denied");
    return;
  }

  const tbody = document.querySelector("#adminTable tbody");
  tbody.innerHTML = "";

  data.users.forEach(u => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${u.username}</td>
      <td>${u.email}</td>
      <td>${u.role}</td>
      <td>${u.online ? "🟢" : "⚪"}</td>
      <td>${u.banned ? "🚫" : "✔"}</td>
      <td>
        <button class="small-btn" onclick="adminBan('${u.username}', ${!u.banned})">${u.banned ? "Unban" : "Ban"}</button>
        <button class="small-btn" onclick="adminResetPass('${u.username}')">Reset PW</button>
        <button class="small-btn" onclick="adminDelete('${u.username}')">Delete</button>
      </td>
    `;
    tbody.appendChild(row);
  });

  show(document.getElementById("modalAdmin"));
};
