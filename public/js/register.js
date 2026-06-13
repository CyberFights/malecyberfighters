$('btnRegister').addEventListener('click', () => show($('modalRegister')));
$('regCancel').addEventListener('click', () => hide($('modalRegister')));

let uploadedImageUrl = '';

async function checkAvailability(username, email){
  const params = new URLSearchParams();
  if(username) params.append('username', username);
  if(email) params.append('email', email);
  const res = await fetch('/api/check-availability?' + params.toString());
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
    uploadedImageUrl = data.url;
    status.textContent = 'Uploaded';
  } else {
    status.textContent = 'Upload failed';
  }
});

$('regSubmit').addEventListener('click', async () => {
  const username = $('regUser').value.trim();
  const email = $('regEmail').value.trim();
  const password = $('regPass').value;
  const display = $('regDisplay').value.trim() || username;
  const age = $('regAge').value;
  const wins = Number($('regWins').value || 0);
  const losses = Number($('regLosses').value || 0);
  const info = $('regInfo').value.trim();
  const color = $('regColor').value;
  const language = $('regLanguage').value;
  const err = $('regError');

  err.style.display = 'none';

  if(!username || !email || !password){
    err.textContent = 'Username, email, password required';
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
    stats:{wins,losses},
    info, color, language,
    imageUrl: uploadedImageUrl
  };

  const resp = await fetch('/api/register', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(payload)
  });

  const data = await resp.json();

  if(data.ok){
    hide($('modalRegister'));
    alert('Account created. Please login.');
  } else {
    err.textContent = data.error || 'Registration failed';
    err.style.display = 'block';
  }
});
