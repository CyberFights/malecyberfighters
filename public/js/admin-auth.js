/* -----------------------------------------------------------
   ADMIN PANEL PASSWORD AUTH (CSP-SAFE)
----------------------------------------------------------- */

window.adminSessionKey = null;

/* Open Admin Password Modal */
document.getElementById("btnAdmin")?.addEventListener("click", () => {
  if (window.adminSessionKey) {
    if (window.loadAdminPanel) window.loadAdminPanel();
    return;
  }

  const modal = document.getElementById("modalAdminPassword");
  if (modal) {
    modal.style.display = "flex";
    modal.style.alignItems = "center";
    modal.style.justifyContent = "center";
  }
});

/* Cancel admin password modal */
document.getElementById("adminPasswordCancel")?.addEventListener("click", () => {
  const modal = document.getElementById("modalAdminPassword");
  if (modal) modal.style.display = "none";
});

/* Submit admin password */
document.getElementById("adminPasswordSubmit")?.addEventListener("click", async () => {
  const inputEl = document.getElementById("adminPasswordInput");
  const error = document.getElementById("adminPasswordError");
  const input = (inputEl?.value || "").trim();

  if (error) error.style.display = "none";

  if (!input) {
    if (error) {
      error.textContent = "Enter a password";
      error.style.display = "block";
    }
    return;
  }

  try {
    const resp = await fetch("/api/admin/users", {
      headers: { "x-admin-key": input }
    });

    const data = await resp.json();

    if (!data.ok) {
      if (error) {
        error.textContent = "Incorrect password";
        error.style.display = "block";
      }
      return;
    }

    window.adminSessionKey = input;

    const modal = document.getElementById("modalAdminPassword");
    if (modal) modal.style.display = "none";
    if (inputEl) inputEl.value = "";

    if (window.loadAdminPanel) window.loadAdminPanel();
  } catch (err) {
    if (error) {
      error.textContent = "Network error";
      error.style.display = "block";
    }
  }
});

document.getElementById("adminPasswordInput")?.addEventListener("keydown", e => {
  if (e.key === "Enter") document.getElementById("adminPasswordSubmit")?.click();
});
