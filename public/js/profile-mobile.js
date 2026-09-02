/* ============================================================
   profile-mobile.js — Mobile version of profile.js
   Adapted from ./public/js/profile.js for ./public/mobile.html

   ID conversions:
     None — all IDs (editDisplay, editAge, editInfo, editColor,
     editLanguage, editWins, editLosses, editImageFile,
     editUploadStatus, btnEditUploadImage, modalEditProfile,
     editCancel, editSubmit, editError) exist in mobile.html.

   Session flow differences:
     - After saving profile, update meCard (meAvatar, meName, meHandle)
       instead of desktop userProfileCard
============================================================ */

/* -----------------------------------------------------------
   PROFILE EDIT LOGIC
----------------------------------------------------------- */

let editImageUrl = "";

/* Called by utils-mobile.js when user clicks Edit Profile */
window.openEditProfileModal = function(user) {
  if (!user) return;

  // Pre-fill modal fields
  $("editDisplay").value = user.display || user.displayName || user.username;
  $("editAge").value = user.age || "";
  if ($("editDiscordId")) $("editDiscordId").value = user.discordId || "";
  $("editInfo").value = user.info || "";
  $("editColor").value = user.color || "#ffffff";
  $("editLanguage").value = user.language || "en";
  $("editWins").value = user.stats?.wins || 0;
  $("editLosses").value = user.stats?.losses || 0;

  // Fighter physique: height menu (3'5"–8'0") + weight in lbs
  const heightSelect = $("editHeight");
  if (heightSelect) populateHeightSelect(heightSelect, user.height || "");
  if ($("editWeight")) $("editWeight").value = user.weight != null && user.weight !== "" ? user.weight : "";

  editImageUrl = user.imageUrl || "";

  const status = $("editUploadStatus");
  if (status) status.textContent = editImageUrl ? "Current image kept" : "No image uploaded";

  show($("modalEditProfile"));
};

/* Cancel button */
$("editCancel").addEventListener("click", () => {
  hide($("modalEditProfile"));
});

/* Upload new profile image */
$("btnEditUploadImage").addEventListener("click", async () => {
  const file = $("editImageFile").files[0];
  const status = $("editUploadStatus");

  if (!file) {
    status.textContent = "Select a file first";
    return;
  }

  const form = new FormData();
  form.append("image", file);

  status.textContent = "Uploading...";

  try {
    const resp = await fetch("/api/upload-image", {
      method: "POST",
      body: form
    });

    const data = await resp.json();

    if (data.ok) {
      editImageUrl = data.imageUrl;
      status.textContent = "Uploaded";
    } else {
      status.textContent = "Upload failed";
    }
  } catch (e) {
    console.error("Upload error", e);
    status.textContent = "Upload error";
  }
});

/* Save profile changes */
$("editSubmit").addEventListener("click", async () => {
  const user = getSession();
  if (!user) return;

  const rawHeight = $("editHeight") ? $("editHeight").value : "";
  const rawWeight = $("editWeight") ? $("editWeight").value : "";

  if (rawHeight && !isValidHeight(rawHeight)) {
    $("editError").textContent = 'Select a height between 3\'5" and 8\'0"';
    $("editError").style.display = "block";
    return;
  }
  if (rawWeight.trim() && !isValidWeight(rawWeight)) {
    $("editError").textContent = "Weight must be between 60 and 700 lbs";
    $("editError").style.display = "block";
    return;
  }

  const updates = {
    display: $("editDisplay").value.trim(),
    age: Number($("editAge").value),
    discordId: $("editDiscordId") ? $("editDiscordId").value.trim() : "",
    height: normalizeHeight(rawHeight),
    weight: normalizeWeight(rawWeight) ?? null,
    info: $("editInfo").value.trim(),
    color: $("editColor").value,
    language: $("editLanguage").value,
    stats: {
      wins: Number($("editWins").value),
      losses: Number($("editLosses").value)
    },
    imageUrl: editImageUrl
  };

  try {
    const resp = await fetch("/api/update-profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: user.username,
        updates
      })
    });

    const data = await resp.json();

    if (!data.ok) {
      $("editError").textContent = data.error || "Update failed";
      $("editError").style.display = "block";
      return;
    }

    // Update session + localStorage
    setSession(data.user);
    localStorage.setItem("currentUser", JSON.stringify(data.user));

    // MOBILE: update meCard instead of desktop userProfileCard
    if (window.updateProfileCard) updateProfileCard(data.user);

    hide($("modalEditProfile"));

  } catch (e) {
    console.error("Profile update error", e);
    $("editError").textContent = "Server error";
    $("editError").style.display = "block";
  }
});
