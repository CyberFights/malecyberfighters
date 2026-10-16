/* Shared, status-aware messages for the login clients. HTTP failures are not
 * network failures: in particular, a 401 is a credential rejection and a 429
 * is the login rate limit. */
(function (global) {
  'use strict';

  function retryAfterSeconds(response, data) {
    let raw = data && (data.retryAfter ?? data.retry_after);
    if ((raw == null || raw === '') && response && response.headers && typeof response.headers.get === 'function') {
      raw = response.headers.get('Retry-After');
    }
    if (raw == null || raw === '') return 0;

    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds);

    // Retry-After may also be an HTTP date rather than a number of seconds.
    const at = Date.parse(String(raw));
    return Number.isFinite(at) ? Math.max(1, Math.ceil((at - Date.now()) / 1000)) : 0;
  }

  function formatWait(seconds) {
    if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
    const minutes = Math.ceil(seconds / 60);
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }

  function rateLimitMessage(response, data, action) {
    const retryAfter = retryAfterSeconds(response, data);
    const subject = action || 'login';
    return retryAfter
      ? `Too many ${subject} attempts. Please try again in ${formatWait(retryAfter)}.`
      : `Too many ${subject} attempts. Please wait a few minutes before trying again.`;
  }

  function loginFailureMessage(response, data) {
    const status = Number(response && response.status) || 0;
    const code = data && typeof data === 'object' ? data.error : '';

    if (status === 429 || code === 'too_many_requests' || code === 'rate_limited') {
      return rateLimitMessage(response, data, 'login');
    }
    if (status === 401 || code === 'invalid_credentials') return 'Invalid username or password.';
    if (status === 403 || code === 'banned') return 'You are banned.';
    if (status === 400 || code === 'missing_fields') return 'Enter username and password.';
    if (status >= 500 || code === 'server_error') {
      return 'The login service is temporarily unavailable. Please try again later.';
    }
    return 'Unable to log in right now. Please try again.';
  }

  global.MCFAuthErrors = Object.freeze({ loginFailureMessage, rateLimitMessage });
})(window);
