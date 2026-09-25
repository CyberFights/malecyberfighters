/**
 * Middleware for bodies that must always arrive in full — never 304.
 *
 * Express stamps every res.send()/res.json() answer with an ETag, and
 * res.sendFile adds Last-Modified on top, so a client that revalidates an
 * unchanged body gets 304 Not Modified and an empty response: nothing for
 * res.json() to parse, nothing for a script fetch to run. Browsers paper over
 * that with their HTTP cache, but anything handed the wire answer — a WebView
 * fetch, a proxy, a service-worker register() in a stack that surfaces the
 * raw 304 — reads an error instead of the body it asked for. That is what the
 * roster's "Failed to load roster", "Unable to load members" and
 * `bad_response` were: fetch /api/allUsers twice with nothing to change in
 * between and the second answer came back 304. A 304 on /sw.js is the same
 * thing to whoever asked for it: an empty script.
 *
 * Cache-Control: no-store stops clients keeping the answer to revalidate
 * later. Stripping the conditional request headers is what actually closes the
 * door: a client that kept a validator from before — or that simply sends
 * If-None-Match: *, which is treated as a match no matter what the response
 * says — would otherwise still be answered 304. Response headers alone cannot
 * prevent that; req.fresh and the `send` package (which serves sendFile) are
 * the gates, and both read the request.
 */
function noRevalidate(req, res, next) {
  delete req.headers['if-none-match'];
  delete req.headers['if-modified-since'];
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
}

module.exports = noRevalidate;
