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



$('btnUploadImage').addEventListener('click', async () => {
  const file = $('regImageFile').files[0];
  const status = $('uploadStatus');
  if(!file){ status.textContent = 'Select a file first'; return; }

  const form = new FormData();
  form.append('image', file);
  status.textContent = 'Uploading...';

  const resp = await fetch('/api/upload-image', { method:'POST', body:form });
  const data = await resp.json();

  if(data.ok){
  uploadedImageUrl = data.imageUrl;
  status.textContent = 'Uploaded';
} else {
    status.textContent = 'Upload failed';
  }
});

$('regSubmit').addEventListener('click', async () => {
  const username = $('regUser').value.trim().toLowerCase();
  const email = $('regEmail').value.trim().toLowerCase();
  const password = $('regPass').value;
  const display = $('regDisplay').value.trim() || username;
  const age = $('regAge').value;
  const wins = Number($('regWins').value || 0);
  const losses = Number($('regLosses').value || 0);
  const info = $('regInfo').value.trim();
  const color = $('regColor').value;
  const language = $('regLanguage').value;
  // Fighter physique: height comes from the 3'5"–8'0" menu, weight is in lbs.
  const height = $('regHeight') ? $('regHeight').value : '';
  const weight = $('regWeight') ? $('regWeight').value : '';
  const err = $('regError');

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

  const avail = await checkAvailability(username, email);
  if(!avail.ok){
    const msgs = [];
    if(avail.conflict.username) msgs.push('username taken');
    if(avail.conflict.email) msgs.push('email in use');
    err.textContent = msgs.join(', ');
    err.style.display = 'block';
    return;
  }

  const payload = {
    username, email, password, display, age,
    height: normalizeHeight(height),
    weight: normalizeWeight(weight) ?? undefined,
    stats:{wins,losses},
    info, color, language,
    imageUrl: uploadedImageUrl,
    tags: registerTagSelection()
  };

  const resp = await fetch('/api/register', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(payload)
  });

  const data = await resp.json();

  if(data.ok){
    // The account exists now — start the next registration from a clean slate.
    if (registerTagPicker) registerTagPicker.clear();
    hide($('modalRegister'));
    alert('Account created. Please login.');
  } else {
    err.textContent = data.error || 'Registration failed';
    err.style.display = 'block';
  }
});
