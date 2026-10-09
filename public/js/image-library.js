(() => {
  'use strict';

  const PAGE_SIZE = 24;
  const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
  const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
  const state = {
    category: 'all',
    page: 1,
    hasMore: false,
    loading: false,
    requestId: 0,
    categories: []
  };

  const el = {
    memberGate: document.getElementById('memberGate'),
    memberGateMessage: document.getElementById('memberGateMessage'),
    libraryApp: document.getElementById('libraryApp'),
    uploadForm: document.getElementById('imageUploadForm'),
    imageCategory: document.getElementById('imageCategory'),
    imageFile: document.getElementById('imageFile'),
    imageCaption: document.getElementById('imageCaption'),
    uploadButton: document.getElementById('uploadButton'),
    uploadStatus: document.getElementById('uploadStatus'),
    categoryFilters: document.getElementById('categoryFilters'),
    pageStatus: document.getElementById('pageStatus'),
    retryLoad: document.getElementById('retryLoad'),
    resultSummary: document.getElementById('resultSummary'),
    imageGrid: document.getElementById('imageGrid'),
    emptyState: document.getElementById('emptyState'),
    previousPage: document.getElementById('previousPage'),
    nextPage: document.getElementById('nextPage'),
    pageNumber: document.getElementById('pageNumber')
  };

  function setStatus(node, message, isError = false) {
    if (!node) return;
    node.textContent = message || '';
    node.classList.toggle('is-error', !!isError);
  }

  function imageErrorMessage(error) {
    const messages = {
      auth_required: 'Sign in to browse and upload images.',
      cross_site_request: 'This request could not be verified. Return to the Arena and try again.',
      invalid_category: 'Choose one of the listed categories.',
      invalid_pagination: 'The image page could not be loaded. Please refresh and try again.',
      no_file: 'Choose an image to upload.',
      file_too_large: 'Images must be 5 MB or smaller.',
      invalid_file_type: 'Choose a JPEG, PNG, GIF or WebP image.',
      caption_too_long: 'Captions are limited to 240 characters.',
      field_too_large: 'One of the upload form fields is too long.',
      no_imgbb_key: 'Image uploads are not configured right now.',
      upload_failed: 'The image host could not accept this upload. Please try again.',
      upload_error: 'The image could not be uploaded. Please try again.',
      server_error: 'The library is temporarily unavailable. Please try again.'
    };
    return messages[error] || 'Something went wrong. Please try again.';
  }

  function showMemberGate(message) {
    el.libraryApp.hidden = true;
    el.memberGate.hidden = false;
    el.retryLoad.hidden = true;
    el.memberGateMessage.textContent = message || 'Sign in to browse and upload images.';
  }

  function categoryLabel(id) {
    const category = state.categories.find(item => item.id === id);
    return category ? category.label : 'Other';
  }

  function renderCategoryControls() {
    el.categoryFilters.replaceChildren();
    el.imageCategory.replaceChildren();

    const allButton = makeCategoryButton('all', 'All images');
    el.categoryFilters.appendChild(allButton);

    state.categories.forEach(category => {
      const option = document.createElement('option');
      option.value = category.id;
      option.textContent = category.label;
      el.imageCategory.appendChild(option);
      el.categoryFilters.appendChild(makeCategoryButton(category.id, category.label));
    });

    // New contributions start in the first real category, not in "all".
    if (state.categories.length) el.imageCategory.value = state.categories[0].id;
  }

  function makeCategoryButton(id, label) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'category-filter';
    button.dataset.category = id;
    button.textContent = label;
    button.setAttribute('aria-pressed', state.category === id ? 'true' : 'false');
    button.addEventListener('click', () => {
      if (state.category === id) return;
      state.category = id;
      state.page = 1;
      renderActiveCategory();
      void loadImages();
    });
    return button;
  }

  function renderActiveCategory() {
    el.categoryFilters.querySelectorAll('.category-filter').forEach(button => {
      button.setAttribute('aria-pressed', button.dataset.category === state.category ? 'true' : 'false');
    });
  }

  function safeImageSource(url) {
    try {
      const parsed = new URL(String(url || ''), window.location.origin);
      const host = parsed.hostname.toLowerCase();
      const isImgBB = host === 'ibb.co' || host.endsWith('.ibb.co');
      if (parsed.protocol !== 'https:' || !isImgBB) return '';
      return typeof window.imgSrc === 'function' ? window.imgSrc(parsed.href) : parsed.href;
    } catch (_) {
      return '';
    }
  }

  function formatDate(value) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function renderImageCard(image) {
    const card = document.createElement('article');
    card.className = 'image-card';

    const imageLink = document.createElement('a');
    imageLink.className = 'image-card-image-wrap';
    imageLink.href = safeImageSource(image.imageUrl) || '#';
    imageLink.target = '_blank';
    imageLink.rel = 'noopener noreferrer';
    imageLink.setAttribute('aria-label', image.caption ? `Open image: ${image.caption}` : 'Open full-size image');

    const photo = document.createElement('img');
    photo.className = 'image-card-image';
    photo.src = safeImageSource(image.imageUrl);
    photo.alt = image.caption || `${categoryLabel(image.category)} image uploaded by ${image.uploadedBy}`;
    photo.loading = 'lazy';
    photo.decoding = 'async';
    photo.referrerPolicy = 'no-referrer';
    imageLink.appendChild(photo);

    const body = document.createElement('div');
    body.className = 'image-card-body';

    if (image.caption) {
      const caption = document.createElement('p');
      caption.className = 'image-card-caption';
      caption.textContent = image.caption;
      body.appendChild(caption);
    }

    const metadata = document.createElement('div');
    metadata.className = 'image-card-meta';
    const category = document.createElement('span');
    category.className = 'image-card-category';
    category.textContent = categoryLabel(image.category);
    metadata.appendChild(category);

    const uploader = document.createElement('span');
    uploader.textContent = `by ${image.uploadedBy || 'member'}`;
    metadata.appendChild(uploader);

    const date = formatDate(image.createdAt);
    if (date) {
      const dateLabel = document.createElement('span');
      dateLabel.textContent = date;
      metadata.appendChild(dateLabel);
    }
    body.appendChild(metadata);

    if (image.canDelete) {
      const actions = document.createElement('div');
      actions.className = 'image-card-actions';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'delete-image-button';
      remove.textContent = 'Remove';
      remove.setAttribute('aria-label', 'Remove this image from the library');
      remove.addEventListener('click', () => void deleteImage(image, remove));
      actions.appendChild(remove);
      body.appendChild(actions);
    }

    card.append(imageLink, body);
    return card;
  }

  function renderImages(images) {
    el.imageGrid.replaceChildren();
    images.forEach(image => el.imageGrid.appendChild(renderImageCard(image)));

    const isEmpty = images.length === 0;
    el.emptyState.hidden = !isEmpty;
    el.resultSummary.textContent = `${images.length} image${images.length === 1 ? '' : 's'} on this page`;
    el.pageNumber.textContent = `Page ${state.page}`;
    el.previousPage.disabled = state.loading || state.page <= 1;
    el.nextPage.disabled = state.loading || !state.hasMore;
    el.previousPage.hidden = state.page <= 1 && !state.hasMore;
    el.nextPage.hidden = state.page <= 1 && !state.hasMore;
    el.pageNumber.hidden = state.page <= 1 && !state.hasMore;
  }

  async function readJson(response) {
    return response.json().catch(() => null);
  }

  async function loadImages() {
    const requestId = ++state.requestId;
    state.loading = true;
    el.previousPage.disabled = true;
    el.nextPage.disabled = true;
    setStatus(el.pageStatus, 'Loading images…');

    const query = new URLSearchParams({
      category: state.category,
      page: String(state.page),
      limit: String(PAGE_SIZE)
    });

    try {
      const response = await fetch(`/api/image-library?${query.toString()}`, { cache: 'no-store' });
      const data = await readJson(response);
      if (requestId !== state.requestId) return;
      if (response.status === 401) {
        showMemberGate(imageErrorMessage(data && data.error));
        return;
      }
      if (!response.ok || !data || !data.ok) {
        throw new Error(data && data.error ? data.error : 'server_error');
      }

      state.categories = Array.isArray(data.categories) ? data.categories : [];
      // Initial load builds the upload selector and category filters. Rebuild
      // only if the server catalogue changed, preserving the active filter.
      const renderedCategories = Array.from(el.imageCategory.options).map(option => option.value).join('|');
      const returnedCategories = state.categories.map(category => category.id).join('|');
      if (renderedCategories !== returnedCategories) renderCategoryControls();
      el.libraryApp.hidden = false;
      el.memberGate.hidden = true;
      el.retryLoad.hidden = true;
      el.uploadButton.disabled = false;
      el.imageFile.disabled = false;
      el.imageCategory.disabled = false;
      state.hasMore = !!data.hasMore;
      renderImages(Array.isArray(data.images) ? data.images : []);
      renderActiveCategory();
      setStatus(el.pageStatus, state.hasMore ? 'More images are available on the next page.' : '');
    } catch (error) {
      if (requestId !== state.requestId) return;
      console.error('Image library could not be loaded:', error);
      el.libraryApp.hidden = false;
      el.memberGate.hidden = true;
      el.retryLoad.hidden = false;
      el.uploadButton.disabled = true;
      el.imageFile.disabled = true;
      el.imageCategory.disabled = true;
      setStatus(el.pageStatus, imageErrorMessage(error.message), true);
      el.imageGrid.replaceChildren();
      el.emptyState.hidden = true;
      el.resultSummary.textContent = '';
    } finally {
      if (requestId === state.requestId) {
        state.loading = false;
        if (!el.libraryApp.hidden) {
          el.previousPage.disabled = state.page <= 1;
          el.nextPage.disabled = !state.hasMore;
        }
      }
    }
  }

  async function deleteImage(image, button) {
    if (!window.confirm('Remove this image from the library? The hosted copy may remain available outside this site.')) return;
    button.disabled = true;
    setStatus(el.pageStatus, 'Removing image…');

    try {
      const response = await fetch(`/api/image-library/${encodeURIComponent(image._id)}`, {
        method: 'DELETE',
        cache: 'no-store'
      });
      const data = await readJson(response);
      if (response.status === 401) {
        showMemberGate(imageErrorMessage(data && data.error));
        return;
      }
      if (!response.ok || !data || !data.ok) throw new Error(data && data.error ? data.error : 'server_error');
      setStatus(el.pageStatus, 'Image removed from the library.');
      await loadImages();
    } catch (error) {
      console.error('Image library delete failed:', error);
      button.disabled = false;
      setStatus(el.pageStatus, imageErrorMessage(error.message), true);
    }
  }

  async function uploadImage(event) {
    event.preventDefault();
    const file = el.imageFile.files && el.imageFile.files[0];
    const category = el.imageCategory.value;
    if (!file) {
      setStatus(el.uploadStatus, imageErrorMessage('no_file'), true);
      el.imageFile.focus();
      return;
    }
    if (file.size > MAX_IMAGE_SIZE) {
      setStatus(el.uploadStatus, imageErrorMessage('file_too_large'), true);
      el.imageFile.focus();
      return;
    }
    if (file.type && !ALLOWED_IMAGE_TYPES.has(file.type)) {
      setStatus(el.uploadStatus, imageErrorMessage('invalid_file_type'), true);
      el.imageFile.focus();
      return;
    }

    const form = new FormData();
    form.append('image', file);
    form.append('category', category);
    form.append('caption', el.imageCaption.value);

    el.uploadButton.disabled = true;
    el.imageFile.disabled = true;
    setStatus(el.uploadStatus, 'Uploading and saving your image…');

    try {
      const response = await fetch('/api/image-library', {
        method: 'POST',
        body: form,
        cache: 'no-store'
      });
      const data = await readJson(response);
      if (response.status === 401) {
        showMemberGate(imageErrorMessage(data && data.error));
        return;
      }
      if (!response.ok || !data || !data.ok) throw new Error(data && data.error ? data.error : 'upload_error');

      state.category = category;
      state.page = 1;
      el.uploadForm.reset();
      el.imageCategory.value = category;
      setStatus(el.uploadStatus, 'Image uploaded successfully.');
      await loadImages();
    } catch (error) {
      console.error('Image library upload failed:', error);
      setStatus(el.uploadStatus, imageErrorMessage(error.message), true);
    } finally {
      el.uploadButton.disabled = false;
      el.imageFile.disabled = false;
    }
  }

  el.uploadForm.addEventListener('submit', event => void uploadImage(event));
  el.previousPage.addEventListener('click', () => {
    if (state.page <= 1 || state.loading) return;
    state.page -= 1;
    void loadImages();
  });
  el.nextPage.addEventListener('click', () => {
    if (!state.hasMore || state.loading) return;
    state.page += 1;
    void loadImages();
  });
  el.retryLoad.addEventListener('click', () => void loadImages());

  void loadImages();
})();
