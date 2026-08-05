/* ============================================================
   FORUMS
   ============================================================
   Forums use REST for persistence and Socket.IO only to refresh visible
   clients when someone creates a forum or posts a response.
============================================================ */
(function () {
  'use strict';

  let forums = [];
  let activeForumId = '';
  let activeForum = null;
  let activeReplies = [];

  const byId = id => document.getElementById(id);

  function currentUser() {
    try {
      if (typeof window.getSession === 'function') return window.getSession();
      return JSON.parse(localStorage.getItem('cw_session_v1') || 'null');
    } catch (_) {
      return null;
    }
  }

  function showPopup(popup) {
    if (!popup) return;
    popup.style.display = 'flex';
    popup.setAttribute('aria-hidden', 'false');
  }

  function hidePopup(popup) {
    if (!popup) return;
    popup.style.display = 'none';
    popup.setAttribute('aria-hidden', 'true');
  }

  function isPopupOpen(popup) {
    return !!popup && window.getComputedStyle(popup).display !== 'none';
  }

  function setText(id, text) {
    const element = byId(id);
    if (element) element.textContent = text || '';
  }

  function formatDate(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString([], {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  }

  function getErrorMessage(code) {
    const messages = {
      title_and_body_required: 'Enter both a forum title and a forum body.',
      forum_too_long: 'The title or body is longer than the allowed limit.',
      reply_body_required: 'Write a response before posting.',
      reply_too_long: 'Your response is longer than the allowed limit.',
      login_required: 'Please log in to create a forum or post a response.',
      forum_not_found: 'This forum is no longer available.',
      invalid_forum: 'This forum link is invalid.',
      server_error: 'Something went wrong. Please try again.'
    };
    return messages[code] || 'Something went wrong. Please try again.';
  }

  async function requestJson(url, options) {
    const response = await fetch(url, options);
    let data;

    try {
      data = await response.json();
    } catch (_) {
      throw new Error('server_error');
    }

    if (!response.ok || !data.ok) {
      throw new Error(data && data.error ? data.error : 'server_error');
    }

    return data;
  }

  function createMeta(post) {
    const meta = document.createElement('div');
    meta.className = 'forum-post-meta';

    const author = document.createElement('span');
    author.className = 'forum-post-author';
    author.textContent = post.authorDisplay || post.author || 'Unknown member';

    const handle = document.createElement('span');
    handle.className = 'forum-post-handle';
    handle.textContent = post.author ? `@${post.author}` : '';

    const date = document.createElement('span');
    date.className = 'forum-post-date';
    date.textContent = formatDate(post.createdAt);

    meta.append(author, handle, date);
    return meta;
  }

  function createPost(post, className) {
    const article = document.createElement('article');
    article.className = className;

    article.appendChild(createMeta(post));

    const body = document.createElement('div');
    body.className = 'forum-post-body';
    body.textContent = post.body || '';
    article.appendChild(body);

    return article;
  }

  function renderForums() {
    const list = byId('forumsList');
    if (!list) return;

    list.replaceChildren();

    if (!forums.length) {
      const empty = document.createElement('div');
      empty.className = 'forum-empty small muted';
      empty.textContent = 'No forums yet. Start the first discussion.';
      list.appendChild(empty);
      return;
    }

    forums.forEach(forum => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'forum-list-item';
      item.dataset.forumId = forum._id;

      const heading = document.createElement('div');
      heading.className = 'forum-list-item-heading';

      const title = document.createElement('div');
      title.className = 'forum-list-title';
      title.textContent = forum.title || 'Untitled forum';

      const count = document.createElement('span');
      count.className = 'forum-reply-count';
      const replyCount = Number(forum.replyCount || 0);
      count.textContent = `${replyCount} ${replyCount === 1 ? 'response' : 'responses'}`;

      heading.append(title, count);

      const excerpt = document.createElement('div');
      excerpt.className = 'forum-list-excerpt';
      const compactBody = String(forum.body || '').replace(/\s+/g, ' ').trim();
      excerpt.textContent = compactBody.length > 180 ? `${compactBody.slice(0, 177)}…` : compactBody;

      const meta = document.createElement('div');
      meta.className = 'forum-list-meta';
      const author = forum.authorDisplay || forum.author || 'Unknown member';
      meta.textContent = `Started by ${author}${formatDate(forum.createdAt) ? ` · ${formatDate(forum.createdAt)}` : ''}`;

      item.append(heading, excerpt, meta);
      item.addEventListener('click', () => openForumThread(forum._id));
      list.appendChild(item);
    });
  }

  async function loadForums({ silent = false } = {}) {
    if (!silent) setText('forumsStatus', 'Loading forums…');

    try {
      const data = await requestJson('/api/forums');
      forums = Array.isArray(data.forums) ? data.forums : [];
      renderForums();
      setText('forumsStatus', '');
      return forums;
    } catch (error) {
      if (!silent) setText('forumsStatus', getErrorMessage(error.message));
      return null;
    }
  }

  function openForumsPopup() {
    const threadPopup = byId('forumThreadPopup');
    hidePopup(threadPopup);
    showPopup(byId('forumsPopup'));
    void loadForums();
  }

  function closeForumsPopup() {
    hidePopup(byId('forumsPopup'));
  }

  function openNewForumModal() {
    setText('newForumError', '');
    const title = byId('forumTitleInput');
    const body = byId('forumBodyInput');
    if (title) title.value = '';
    if (body) body.value = '';

    showPopup(byId('newForumModal'));
    window.setTimeout(() => title?.focus(), 0);
  }

  function closeNewForumModal() {
    hidePopup(byId('newForumModal'));
    setText('newForumError', '');
  }

  async function createForum() {
    const user = currentUser();
    const titleInput = byId('forumTitleInput');
    const bodyInput = byId('forumBodyInput');
    const createButton = byId('newForumCreate');
    const title = titleInput ? titleInput.value.trim() : '';
    const body = bodyInput ? bodyInput.value.trim() : '';

    if (!user?.username) {
      setText('newForumError', getErrorMessage('login_required'));
      return;
    }

    if (!title || !body) {
      setText('newForumError', getErrorMessage('title_and_body_required'));
      return;
    }

    if (createButton) createButton.disabled = true;
    setText('newForumError', '');

    try {
      const data = await requestJson('/api/forums', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body, author: user.username })
      });

      if (data.forum) {
        upsertForum(data.forum);
        renderForums();
      }

      closeNewForumModal();
      void loadForums({ silent: true });
    } catch (error) {
      setText('newForumError', getErrorMessage(error.message));
    } finally {
      if (createButton) createButton.disabled = false;
    }
  }

  function renderThread({ scrollToLatest = false } = {}) {
    const title = byId('forumThreadTitle');
    const originalPost = byId('forumOriginalPost');
    const replies = byId('forumReplies');
    const repliesHeading = document.querySelector('.forum-replies-heading');

    if (title) title.textContent = activeForum?.title || 'Forum';

    if (originalPost) {
      originalPost.replaceChildren();
      if (activeForum) originalPost.appendChild(createPost(activeForum, 'forum-post forum-original-card'));
    }

    if (repliesHeading) {
      const count = activeReplies.length;
      repliesHeading.textContent = `Responses (${count})`;
    }

    if (replies) {
      replies.replaceChildren();
      if (!activeReplies.length) {
        const empty = document.createElement('div');
        empty.className = 'forum-empty small muted';
        empty.textContent = 'No responses yet. Be the first to reply.';
        replies.appendChild(empty);
      } else {
        activeReplies.forEach(reply => replies.appendChild(createPost(reply, 'forum-post forum-reply-card')));
      }
    }

    if (scrollToLatest) {
      const content = byId('forumThreadContent');
      if (content) content.scrollTop = content.scrollHeight;
    }
  }

  async function openForumThread(forumId) {
    const requestedForumId = String(forumId || '');
    if (!requestedForumId) return;

    activeForumId = requestedForumId;
    activeForum = null;
    activeReplies = [];

    hidePopup(byId('forumsPopup'));
    const threadPopup = byId('forumThreadPopup');
    if (threadPopup) threadPopup.dataset.forumId = requestedForumId;
    showPopup(threadPopup);
    setText('forumThreadTitle', 'Loading forum…');
    setText('forumThreadStatus', 'Loading discussion…');
    setText('forumReplyError', '');
    renderThread();

    try {
      const data = await requestJson(`/api/forums/${encodeURIComponent(requestedForumId)}`);
      // Ignore an older request that finishes after the user opens another forum.
      if (activeForumId !== requestedForumId) return;

      activeForum = data.forum;
      activeReplies = Array.isArray(data.replies) ? data.replies : [];
      upsertForum(activeForum);
      renderThread({ scrollToLatest: false });
      setText('forumThreadStatus', '');
    } catch (error) {
      if (activeForumId !== requestedForumId) return;
      setText('forumThreadStatus', getErrorMessage(error.message));
    }
  }

  function closeForumThread() {
    activeForumId = '';
    activeForum = null;
    activeReplies = [];
    const popup = byId('forumThreadPopup');
    if (popup) popup.dataset.forumId = '';
    hidePopup(popup);
    setText('forumReplyError', '');
  }

  function returnToForums() {
    closeForumThread();
    openForumsPopup();
  }

  function upsertForum(forum) {
    if (!forum || !forum._id) return;
    const index = forums.findIndex(item => String(item._id) === String(forum._id));
    if (index === -1) {
      forums.unshift(forum);
    } else {
      forums[index] = { ...forums[index], ...forum };
    }
  }

  function addReplyToActiveThread(reply) {
    if (!reply || String(reply.forum) !== String(activeForumId)) return;
    if (activeReplies.some(item => String(item._id) === String(reply._id))) return;

    activeReplies.push(reply);
    if (activeForum) {
      activeForum.replyCount = activeReplies.length;
      upsertForum(activeForum);
    }
    renderThread({ scrollToLatest: true });
  }

  async function postReply() {
    const user = currentUser();
    const input = byId('forumReplyBody');
    const submitButton = byId('forumReplySubmit');
    const body = input ? input.value.trim() : '';

    if (!activeForumId) {
      setText('forumReplyError', 'Choose a forum before posting a response.');
      return;
    }

    if (!user?.username) {
      setText('forumReplyError', getErrorMessage('login_required'));
      return;
    }

    if (!body) {
      setText('forumReplyError', getErrorMessage('reply_body_required'));
      return;
    }

    if (submitButton) submitButton.disabled = true;
    setText('forumReplyError', '');

    try {
      const data = await requestJson(`/api/forums/${encodeURIComponent(activeForumId)}/replies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body, author: user.username })
      });

      if (input) input.value = '';
      addReplyToActiveThread(data.reply);
      void loadForums({ silent: true });
    } catch (error) {
      setText('forumReplyError', getErrorMessage(error.message));
    } finally {
      if (submitButton) submitButton.disabled = false;
    }
  }

  function bindSocketEvents() {
    const socket = window.socket;
    if (!socket || typeof socket.on !== 'function') return;

    socket.on('forumsList', serverForums => {
      if (!Array.isArray(serverForums)) return;
      forums = serverForums;
      if (isPopupOpen(byId('forumsPopup'))) renderForums();
    });

    socket.on('forumCreated', forum => {
      upsertForum(forum);
      if (isPopupOpen(byId('forumsPopup'))) renderForums();
    });

    socket.on('forumReplyCreated', payload => {
      if (!payload?.reply) return;
      const forumId = String(payload.forumId || payload.reply.forum || '');
      const index = forums.findIndex(item => String(item._id) === forumId);
      if (index !== -1) {
        forums[index] = {
          ...forums[index],
          replyCount: Number(forums[index].replyCount || 0) + 1,
          lastActivityAt: payload.reply.createdAt || new Date().toISOString()
        };
      }

      addReplyToActiveThread(payload.reply);
      if (isPopupOpen(byId('forumsPopup'))) renderForums();
    });
  }

  function bindEvents() {
    document.querySelectorAll('[id="btnForums"]').forEach(button => {
      button.addEventListener('click', openForumsPopup);
    });

    byId('forumsClose')?.addEventListener('click', closeForumsPopup);
    byId('newForumBtn')?.addEventListener('click', openNewForumModal);
    byId('newForumClose')?.addEventListener('click', closeNewForumModal);
    byId('newForumCancel')?.addEventListener('click', closeNewForumModal);
    byId('newForumCreate')?.addEventListener('click', createForum);
    byId('forumThreadClose')?.addEventListener('click', closeForumThread);
    byId('forumThreadBack')?.addEventListener('click', returnToForums);
    byId('forumReplySubmit')?.addEventListener('click', postReply);

    byId('forumReplyBody')?.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        postReply();
      }
    });

    byId('forumsPopup')?.addEventListener('click', event => {
      if (event.target === event.currentTarget) closeForumsPopup();
    });
    byId('newForumModal')?.addEventListener('click', event => {
      if (event.target === event.currentTarget) closeNewForumModal();
    });
    byId('forumThreadPopup')?.addEventListener('click', event => {
      if (event.target === event.currentTarget) closeForumThread();
    });

    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      if (isPopupOpen(byId('newForumModal'))) {
        closeNewForumModal();
      } else if (isPopupOpen(byId('forumThreadPopup'))) {
        closeForumThread();
      } else if (isPopupOpen(byId('forumsPopup'))) {
        closeForumsPopup();
      }
    });
  }

  function init() {
    bindEvents();
    bindSocketEvents();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
