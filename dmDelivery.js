/**
 * Directed DM delivery + server-side unread counts.
 *
 * Split out of index.js so the delivery rules can be exercised on their own
 * (see tests/dm-delivery.test.js) instead of only in a running deployment.
 *
 * Two problems live here:
 *
 * 1. One user can be signed in from several places at once — two browser tabs,
 *    the Electron app, the mobile app. `socketId` on the user document only
 *    ever holds the most recent one, so `io.to(user.socketId)` silently
 *    delivered nothing whenever that socket was gone (closed tab, asleep
 *    phone, redeploy) and never reached the user's other sessions at all. DMs
 *    bridged in from Discord hit this constantly, because the recipient is
 *    usually not sitting on the exact socket that logged in last: the message
 *    was written to the database, nothing live-updated, and no badge appeared.
 *    Every socket now joins a room for its owner and DMs go to the room.
 *
 *    Rooms are per process. If the site is ever scaled to more than one
 *    instance, they need a shared socket.io adapter (e.g. @socket.io/
 *    redis-adapter) — otherwise a DM handled by one instance cannot reach a
 *    browser connected to another, and only the unread catch-up in (2) will
 *    surface it, on the recipient's next connect.
 *
 * 2. The unread badge used to be purely client-side, fed by live socket
 *    events. A DM that arrives while the recipient has no live socket — the
 *    normal case for a message bridged in from Discord — was stored but never
 *    badged. `getUnreadDMCounts` computes what is still unread from the
 *    database so the client can be told on connect.
 */

// Usernames are not restricted to a safe character set, and MongoDB field
// names may not contain "." or "$", so the dmSeen map key is normalised.
const dmSeenKey = name => String(name).replace(/[.$]/g, "_");

const createDmDelivery = ({ User, DM, io }) => {
  const userRoom = username => `user:${username}`;

  function liveSocketCount(username) {
    if (!username) return 0;
    const room = io.sockets.adapter.rooms.get(userRoom(username));
    return room ? room.size : 0;
  }

  /**
   * Emit to every live session of a user.
   * @returns {number} how many sockets were reached (0 = the user is offline)
   */
  function emitToUser(username, event, payload) {
    if (!username) return 0;
    const reached = liveSocketCount(username);
    if (reached) io.to(userRoom(username)).emit(event, payload);
    return reached;
  }

  // Mark a conversation read up to "now". Called by the client whenever a DM
  // window is opened, cleared, or an incoming message is rendered into one.
  async function markDMRead(username, partner) {
    if (!username || !partner || username === partner) return;
    const user = await User.findOne({ username }).select("dmSeen").lean();
    if (!user) return;
    await User.updateOne(
      { username },
      { $set: { dmSeen: { ...(user.dmSeen || {}), [dmSeenKey(partner)]: new Date().toISOString() } } }
    );
  }

  /**
   * Unread DM counts straight from the database, for DMs the client could
   * never have counted itself.
   *
   * Nothing older than the user's `dmUnreadSince` stamp is ever counted, so
   * the first connect after this ships does not badge the whole history of
   * every conversation. Everything newer is counted until the client reports
   * the conversation read — including messages bridged in from Discord while
   * the user had no socket at all.
   *
   * @returns {Promise<Object>} { [partnerUsername]: unreadCount }
   */
  async function getUnreadDMCounts(user) {
    const username = user.username;
    const seen = user.dmSeen || {};

    let countingSince = user.dmUnreadSince ? new Date(user.dmUnreadSince) : null;
    if (!countingSince || Number.isNaN(countingSince.getTime())) {
      // Existing accounts get their stamp the first time this runs; new ones
      // get it from the schema default at registration.
      countingSince = new Date();
      await User.updateOne({ username }, { $set: { dmUnreadSince: countingSince.toISOString() } });
    }

    const rows = await DM.aggregate([
      { $match: { to: username, from: { $ne: "SYSTEM" } } },
      { $group: { _id: "$from", times: { $push: "$time" } } }
    ]);

    const counts = {};

    rows.forEach(row => {
      const partner = row._id;
      if (!partner || partner === username) return;   // self-DMs are not a thing

      const key = dmSeenKey(partner);
      const readAt = seen[key] ? new Date(seen[key]) : null;

      // A read marker wins when it is newer than the counting stamp. The two
      // bounds are not interchangeable: a DM read at instant T is read
      // (strictly after), while a DM that lands in the same millisecond as
      // the counting stamp still has to count (inclusive).
      const useReadMarker = !!readAt && readAt > countingSince;

      const unread = (row.times || []).filter(t =>
        t && (useReadMarker ? t > readAt : t >= countingSince)
      ).length;
      if (unread > 0) counts[partner] = unread;
    });

    return counts;
  }

  return { userRoom, liveSocketCount, emitToUser, markDMRead, getUnreadDMCounts, dmSeenKey };
};

module.exports = { createDmDelivery, dmSeenKey };
