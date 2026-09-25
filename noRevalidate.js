/**
 * Middleware for JSON that must always arrive with a body.
 *
 * Express stamps every res.json() answer with an ETag, so a client that
 * revalidates an unchanged body gets 304 Not Modified and an empty response —
 * nothing for res.json() to parse. Browsers paper over that with their HTTP
 * cache, but any client handed the wire answer (a WebView fetch, a script, a
 * proxy) reads an error instead of the JSON it asked for. That is what the
 * roster's "Failed to load roster", "Unable to load members" and
 * `bad_response` were: fetch /api/allUsers twice with nothing to change in
 * between and the second answer came back 304.
 *
 * Cache-Control: no-store stops clients keeping the answer to revalidate
 * later. Stripping the conditional request headers is what actually closes the
 * door: a client that kept a validator from before — or that simply sends
 * If-None-Match: *, which Express treats as a match no matter what the
 * response says — would otherwise still be answered 304. Response headers
 * alone cannot prevent that; req.fresh is the only gate and it reads the
 * request.
 */
function noRevalidate(req, res, next) {
  delete req.headers['if-none-match'];
  delete req.headers['if-modified-since'];
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
}

module.exports = noRevalidate;
