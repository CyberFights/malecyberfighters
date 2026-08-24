/* Route remote (ImgBB / Discord CDN) images through our same-origin /img
 * proxy so Firefox's OpaqueResponseBlocking cannot drop them. Falls back to the
 * raw URL if image-proxy.js has not loaded. */
function profileImgSrc(value) {
  if (typeof window !== 'undefined' && typeof window.imgSrc === 'function') return window.imgSrc(value);
  return value == null ? '' : String(value);
}

/* -----------------------------------------------------------
   PROFILE EDIT LOGIC
----------------------------------------------------------- */

const MAX_EXTRA_PROFILE_PHOTOS = 10;
const MAX_PROFILE_PHOTO_BYTES = 5 * 1024 * 1024;

let editImageUrl = "";
let editExtraPhotos = [];
let editingProfileUsername = "";

function setExtraPhotoStatus(message, isError = false) {
  const status = $("editExtraPhotosStatus");
  if (!status) return;
  status.textContent = message || "";
  status.classList.toggle("profile-photo-error", !!isError);
}

function profilePhotoErrorMessage(data) {
  switch (data?.error) {
    case "profile_photo_limit":
    case "too_many_photos":
      return `Profiles can have up to ${data.maxPhotos || MAX_EXTRA_PROFILE_PHOTOS} extra photos.`;
    case "file_too_large":
      return "Each photo must be 5 MB or smaller.";
    case "invalid_file_type":
      return "Please select image files only.";
    case "no_imgbb_key":
      return "Photo uploads are not configured right now.";
    case "not_found":
      return "Your profile could not be found.";
    default:
      return "The photos could not be uploaded. Please try again.";
  }
}

function syncExtraPhotosToClient(photos) {
  editExtraPhotos = window.normalizeProfilePhotos
    ? window.normalizeProfilePhotos(photos)
    : (Array.isArray(photos) ? photos.filter(Boolean) : []);

  const current = getSession();
  if (current && current.username === editingProfileUsername) {
    const updatedSession = { ...current, extraPhotos: editExtraPhotos };
    setSession(updatedSession);
    localStorage.setItem("currentUser", JSON.stringify(updatedSession));

    const selfGallery = document.getElementById("selfProfilePhotos");
    if (selfGallery && window.renderProfilePhotoGallery) {
      window.renderProfilePhotoGallery(
        selfGallery,
        editExtraPhotos,
        "Upload extra photos from Edit Profile"
      );
    } else if (window.updateProfileCard) {
      window.updateProfileCard(updatedSession);
    }
  }

  if (Array.isArray(window.allUsers)) {
    const cachedUser = window.allUsers.find(user => user.username === editingProfileUsername);
    if (cachedUser) cachedUser.extraPhotos = [...editExtraPhotos];
  }
}

function renderExtraPhotoEditor() {
  const preview = $("editExtraPhotosPreview");
  if (!preview) return;
  preview.replaceChildren();

  if (!editExtraPhotos.length) {
    const empty = document.createElement("div");
    empty.className = "small muted profile-photo-empty";
    empty.textContent = "No extra photos uploaded yet";
    preview.appendChild(empty);
    return;
  }

  editExtraPhotos.forEach((url, index) => {
    const tile = document.createElement("div");
    tile.className = "profile-photo-tile profile-photo-edit-tile";

    const image = document.createElement("img");
    image.src = profileImgSrc(url);
    image.alt = `Extra profile photo ${index + 1}`;
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "profile-photo-remove";
    remove.textContent = "×";
    remove.title = "Remove photo from profile";
    remove.setAttribute("aria-label", `Remove profile photo ${index + 1}`);
    remove.addEventListener("click", () => removeExtraProfilePhoto(url, remove));

    tile.append(image, remove);
    preview.appendChild(tile);
  });
}

async function refreshExtraProfilePhotos(username) {
  try {
    const response = await fetch(`/api/profile/photos?username=${encodeURIComponent(username)}`);
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok || editingProfileUsername !== username) return;
    syncExtraPhotosToClient(data.extraPhotos);
    renderExtraPhotoEditor();
    setExtraPhotoStatus(`${editExtraPhotos.length} of ${MAX_EXTRA_PROFILE_PHOTOS} photos uploaded`);
  } catch (error) {
    console.error("Could not refresh profile photos", error);
  }
}

async function removeExtraProfilePhoto(photoUrl, button) {
  if (!editingProfileUsername || !photoUrl) return;
  button.disabled = true;
  setExtraPhotoStatus("Removing photo...");

  try {
    const response = await fetch("/api/profile/photos", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: editingProfileUsername,
        photoUrl
      })
    });
    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.ok) {
      button.disabled = false;
      setExtraPhotoStatus("The photo could not be removed.", true);
      return;
    }

    syncExtraPhotosToClient(data.extraPhotos);
    renderExtraPhotoEditor();
    setExtraPhotoStatus("Photo removed from your profile.");
  } catch (error) {
    console.error("Profile photo removal error", error);
    button.disabled = false;
    setExtraPhotoStatus("The photo could not be removed.", true);
  }
}

/* Called by utils.js when user clicks Edit Profile */
window.openEditProfileModal = function(user) {
  if (!user) return;

  $("editDisplay").value = user.display || user.displayName || user.username;
  $("editAge").value = user.age || "";
  $("editInfo").value = user.info || "";
  $("editColor").value = user.color || "#ffffff";
  $("editLanguage").value = user.language || "en";
  $("editWins").value = user.stats?.wins || 0;
  $("editLosses").value = user.stats?.losses || 0;

  editImageUrl = user.imageUrl || "";
  editingProfileUsername = user.username;
  editExtraPhotos = window.normalizeProfilePhotos
    ? window.normalizeProfilePhotos(user.extraPhotos)
    : (Array.isArray(user.extraPhotos) ? user.extraPhotos.filter(Boolean) : []);

  const avatarStatus = $("editUploadStatus");
  if (avatarStatus) {
    avatarStatus.textContent = editImageUrl ? "Current main image kept" : "No main image uploaded";
  }

  const extraInput = $("editExtraPhotosFile");
  if (extraInput) extraInput.value = "";
  setExtraPhotoStatus(`${editExtraPhotos.length} of ${MAX_EXTRA_PROFILE_PHOTOS} photos uploaded`);
  renderExtraPhotoEditor();
  refreshExtraProfilePhotos(user.username);

  show($("modalEditProfile"));
};

/* Cancel button */
$("editCancel").addEventListener("click", () => {
  hide($("modalEditProfile"));
});

/* Upload new main profile image */
$("btnEditUploadImage").addEventListener("click", async event => {
  event.preventDefault();
  const file = $("editImageFile").files[0];
  const status = $("editUploadStatus");
  const button = $("btnEditUploadImage");

  if (!file) {
    status.textContent = "Select a file first";
    return;
  }

  const form = new FormData();
  form.append("image", file);
  status.textContent = "Uploading...";
  button.disabled = true;

  try {
    const response = await fetch("/api/upload-image", { method: "POST", body: form });
    const data = await response.json().catch(() => null);

    if (response.ok && data?.ok) {
      editImageUrl = data.imageUrl;
      status.textContent = "Main image uploaded";
    } else {
      status.textContent = "Upload failed";
    }
  } catch (error) {
    console.error("Upload error", error);
    status.textContent = "Upload error";
  } finally {
    button.disabled = false;
  }
});

/* Upload and immediately save extra profile photos */
$("btnUploadExtraPhotos")?.addEventListener("click", async event => {
  event.preventDefault();

  const input = $("editExtraPhotosFile");
  const button = $("btnUploadExtraPhotos");
  const files = Array.from(input?.files || []);

  if (!editingProfileUsername) {
    setExtraPhotoStatus("Please log in before uploading photos.", true);
    return;
  }
  if (!files.length) {
    setExtraPhotoStatus("Select one or more photos first.", true);
    return;
  }
  if (files.some(file => !String(file.type || "").startsWith("image/"))) {
    setExtraPhotoStatus("Please select image files only.", true);
    return;
  }
  if (files.some(file => file.size > MAX_PROFILE_PHOTO_BYTES)) {
    setExtraPhotoStatus("Each photo must be 5 MB or smaller.", true);
    return;
  }

  const remainingSlots = MAX_EXTRA_PROFILE_PHOTOS - editExtraPhotos.length;
  if (files.length > remainingSlots) {
    setExtraPhotoStatus(
      `You can select ${remainingSlots} more photo${remainingSlots === 1 ? "" : "s"}.`,
      true
    );
    return;
  }

  const form = new FormData();
  form.append("username", editingProfileUsername);
  files.forEach(file => form.append("photos", file));

  button.disabled = true;
  input.disabled = true;
  setExtraPhotoStatus(`Uploading ${files.length} photo${files.length === 1 ? "" : "s"} to ImgBB...`);

  try {
    const response = await fetch("/api/profile/photos", { method: "POST", body: form });
    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.ok) {
      setExtraPhotoStatus(profilePhotoErrorMessage(data), true);
      return;
    }

    syncExtraPhotosToClient(data.extraPhotos);
    renderExtraPhotoEditor();
    input.value = "";
    setExtraPhotoStatus(
      `${data.uploadedPhotos.length} photo${data.uploadedPhotos.length === 1 ? "" : "s"} uploaded and saved.`
    );
  } catch (error) {
    console.error("Extra profile photo upload error", error);
    setExtraPhotoStatus("The photos could not be uploaded. Please try again.", true);
  } finally {
    button.disabled = false;
    input.disabled = false;
  }
});

/* Save profile changes */
$("editSubmit").addEventListener("click", async () => {
  const user = getSession();
  if (!user) return;

  const updates = {
    display: $("editDisplay").value.trim(),
    age: Number($("editAge").value),
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
    const response = await fetch("/api/update-profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: user.username, updates })
    });
    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.ok) {
      $("editError").textContent = data?.error || "Update failed";
      $("editError").style.display = "block";
      return;
    }

    setSession(data.user);
    localStorage.setItem("currentUser", JSON.stringify(data.user));
    if (window.updateProfileCard) window.updateProfileCard(data.user);
    hide($("modalEditProfile"));
  } catch (error) {
    console.error("Profile update error", error);
    $("editError").textContent = "Server error";
    $("editError").style.display = "block";
  }
});
