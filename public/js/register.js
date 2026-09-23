/* Fighter tags. The picker is built the first time the register modal opens,
 * so a visitor who never registers never pays for the ~60 checkboxes. */
let registerTagPicker = null;

function ensureRegisterTagPicker(){
  if (registerTagPicker) return registerTagPicker;
  const slot = $('regTags');
  if (!slot || !window.ProfileTags) return null;
  registerTagPicker = window.ProfileTags.renderPicker(slot, { idPrefix: 'regTags' });
  return registerTagPicker;
}

/* The ticked tags, or undefined when the page has no picker (an older shell) —
 * the server then stores an empty selection rather than rejecting the call. */
function registerTagSelection(){
  const slot = $('regTags');
  if (!slot || !window.ProfileTags) return undefined;
  return window.ProfileTags.pickerSelection(slot);
}

$('btnRegister').addEventListener('click', () => {
  ensureRegisterTagPicker();
  show($('modalRegister'));
});

$('regCancel').addEventListener('click', () => hide($('modalRegister')));

let uploadedImageUrl = '';

const REGISTER_PHOTO_MAX = 5 * 1024 * 1024;

async function checkAvailability(username, email){
  const params = new URLSearchParams();
  if(username) params.append('username', username);
  if(email) params.append('email', email);
const res = await fetch("/api/check-availability", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username, email })
});
  return res.json();
}

function selectedRegisterPhoto(){
  const input = $('regImageFile');
  return input && input.files && input.files[0] ? input.files[0] : null;
}

function registerPhotoProblem(file){
  if (!file) return '';
  if (file.type && !String(file.type).startsWith('image/')) return 'Please choose an image file.';
  if (file.size > REGISTER_PHOTO_MAX) return 'Photo must be 5 MB or smaller.';
  return '';
}

function describeRegisterPhoto(){
  const status = $('uploadStatus');
  if (!status) return;
  const file = selectedRegisterPhoto();
  const problem = registerPhotoProblem(file);
  if (problem) {
    status.textContent = problem;
    return;
  }
  if (!file) {
    status.textContent = 'Uploads when you create the account';
    return;
  }
  status.textContent = file.name + ' — uploads when you create the account';
}

const regImageFile = $('regImageFile');
if (regImageFile) {
  regImageFile.addEventListener('change', () => {
    uploadedImageUrl = '';
    describeRegisterPhoto();
  });
}

function registrationErrorText(data, status){
  const code = data && data.error;
  if (code === 'file_too_large' || status === 413) return 'Photo must be 5 MB or smaller.';
  if (code === 'invalid_file_type' || code === 'invalid_file') return 'Please choose an image file.';
  if (code === 'no_imgbb_key' || code === 'upload_error' || code === 'upload_failed') {
    return 'The photo could not be uploaded, so the account was not created.';
  }
  if (code === 'invalid_username') return 'Username can only use letters, numbers, and . _ -';
  if (code === 'missing_fields') return 'Username, email, password required';
  if (code === 'invalid_height') return 'Select your height (3\'5" to 8\'0")';
  if (code === 'invalid_weight') return 'Enter your weight in lbs (60-700)';
  if (code === 'invalid_tags') return 'Those fighter tags could not be saved.';
  return code || 'Registration failed';
}

$('regSubmit').addEventListener('click', async () => {
  const username = $('regUser').value.trim().toLowerCase();
  const email = $('regEmail').value.trim().toLowerCase();
  const password = $('regPass').value;
  const display = $('regDisplay').value.trim() || username;
  const age = $('regAge').value;
  const info = $('regInfo').value.trim();
  const color = $('regColor').value;
  const language = $('regLanguage').value;
  // Fighter physique: height comes from the 3'5"–8'0" menu, weight is in lbs.
  const height = $('regHeight') ? $('regHeight').value : '';
  const weight = $('regWeight') ? $('regWeight').value : '';
  const err = $('regError');
  const submit = $('regSubmit');
  const photo = selectedRegisterPhoto();

  err.style.display = 'none';

  if(!username || !email || !password){
    err.textContent = 'Username, email, password required';
    err.style.display = 'block';
    return;
  }

  if(!isValidHeight(height)){
    err.textContent = 'Select your height (3\'5" to 8\'0")';
    err.style.display = 'block';
    return;
  }

  if(!isValidWeight(weight)){
    err.textContent = 'Enter your weight in lbs (60-700)';
    err.style.display = 'block';
    return;
  }

  const photoProblem = registerPhotoProblem(photo);
  if (photoProblem) {
    err.textContent = photoProblem;
    err.style.display = 'block';
    describeRegisterPhoto();
    return;
  }

  const avail = await checkAvailability(username, email);
  if(!avail.ok){
    const msgs = [];
    if(avail.conflict.username) msgs.push('username taken');
    if(avail.conflict.email) msgs.push('email in use');
    err.textContent = msgs.join(', ');
    err.style.display = 'block';
    return;
  }

  // No file: keep the JSON body the tag tests parse. A selected photo cannot
  // go through /api/upload-image — that route requires a session, and a new
  // account does not have one yet — so it rides on /api/register instead.
  // A chosen photo is sent as the file itself, not as a previously uploaded URL.
  if (photo) uploadedImageUrl = '';
  const payload = {
    username, email, password, display, age,
    height: normalizeHeight(height),
    weight: normalizeWeight(weight) ?? undefined,
    info, color, language,
    imageUrl: uploadedImageUrl,
    tags: registerTagSelection()
  };

  const status = $('uploadStatus');
  if (photo && status) status.textContent = 'Uploading photo and creating account…';
  if (submit) submit.disabled = true;

  let resp;
  try {
    if (photo) {
      const form = new FormData();
      Object.entries(payload).forEach(([key, value]) => {
        if (value === undefined || value === null || key === 'imageUrl') return;
        form.append(key, key === 'tags' ? JSON.stringify(value) : value);
      });
      form.append('image', photo);
      resp = await fetch('/api/register', { method: 'POST', body: form });
    } else {
      resp = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }
  } catch (failure) {
    if (submit) submit.disabled = false;
    err.textContent = 'Registration failed';
    err.style.display = 'block';
    describeRegisterPhoto();
    return;
  }

  let data = {};
  try { data = await resp.json(); } catch (failure) { data = {}; }
  if (submit) submit.disabled = false;

  if(data.ok){
    uploadedImageUrl = '';
    const fileInput = $('regImageFile');
    if (fileInput) fileInput.value = '';
    describeRegisterPhoto();
    // The account exists now — start the next registration from a clean slate.
    if (registerTagPicker) registerTagPicker.clear();
    hide($('modalRegister'));
    alert('Account created. Please login.');
  } else {
    err.textContent = registrationErrorText(data, resp.status);
    err.style.display = 'block';
    describeRegisterPhoto();
  }
});
