/**
 * Bridges inbound Discord DMs into the website DM system.
 *
 * Every inbound message has to name its recipient explicitly using
 * "@username message". There is deliberately no fallback to the most recent
 * conversation: replying to "whoever texted last" silently delivered messages
 * to the wrong person as soon as two threads were open, so the bot now asks
 * for a recipient instead of guessing one.
 */

// A message must open with a mention. Website usernames contain no whitespace,
// so the mention runs up to the first space and whatever follows is the message
// body. The body is optional so "@jane" on its own gets a "what to send?" prompt
// instead of a generic usage error.
const mongoose = require('mongoose');

const MENTION = /^\s*@(\S+?)(?:\s+([\s\S]*))?$/;

// "@jane, hey" — punctuation typed after the name is not part of the username.
const TRAILING_PUNCTUATION = /[,.;:!?]+$/;

const USAGE = "Send a DM as `@username message` — for example `@jane hey there`. " +
  "You have to name the recipient: messages are never forwarded to your last conversation automatically.";

const setupDiscordListener = (User, DM, translateText, emitToUser, sendDiscordDM, discordEvents) => {
  discordEvents.on('dm', async ({ discordId, text }) => {
    try {
      const sender = await User.findOne({ discordId }).lean();

      // One line per inbound DM, including the database this process is
      // talking to. When the same Discord account alternates between working
      // and "please link your account", the log says which of the three
      // possible causes it is:
      //   no line at all          → another process answered (a second
      //                             deployment holding the gateway, i.e. the
      //                             running code is not this code)
      //   a different from= id    → the failing DM came from another Discord
      //                             account (desktop vs phone, two accounts)
      //   same id, account=NONE   → the row is gone or this process reads a
      //                             different database (db= tells you which)
      console.log(
        `[Discord DM] db=${mongoose.connection.name} from=${discordId} ` +
        `account=${sender ? sender.username : "NONE"}`
      );

      if (!sender) {
        await sendDiscordDM(discordId, "Please link your Discord account on the MaleCyberFighters website to use this feature.");
        return;
      }

      const match = String(text || '').match(MENTION);
      if (!match) {
        await sendDiscordDM(discordId, USAGE);
        return;
      }

      const targetUsername = match[1].replace(TRAILING_PUNCTUATION, '');
      const messageContent = (match[2] || '').trim();

      if (!targetUsername) {
        await sendDiscordDM(discordId, USAGE);
        return;
      }

      if (!messageContent) {
        await sendDiscordDM(discordId, `What would you like to send to **${targetUsername}**? Type \`@${targetUsername} <message>\`.`);
        return;
      }

      const receiver = await User.findOne({ username: targetUsername }).lean();
      if (!receiver) {
        await sendDiscordDM(discordId, `Website user **${targetUsername}** not found — use their exact username after the \`@\`, followed by the message (e.g. \`@${targetUsername} hello\`).`);
        return;
      }

      // The website refuses self-DMs ("You cannot message yourself"), so a
      // message addressed to your own account would be stored where no client
      // ever renders it: the bot would say "message sent" and nothing would
      // ever appear. Say no here instead.
      if (receiver.username === sender.username) {
        await sendDiscordDM(discordId, `You can't DM yourself — \`@${targetUsername}\` is your own website account. Name the person you want to reach.`);
        return;
      }

      if (receiver.blockedUsers && receiver.blockedUsers.includes(sender.username)) {
        await sendDiscordDM(discordId, `Message not delivered. **${targetUsername}** has blocked you.`);
        return;
      }

      const translated = await translateText(messageContent, receiver.language || "en");

      const saved = await DM.create({
        from: sender.username,
        to: receiver.username,
        originalText: messageContent,
        text: translated || messageContent
      });

      // Deliver to every session the recipient has open rather than to the
      // single `socketId` stored on their user document. That field points at
      // whichever socket logged in last and is routinely stale — closed tab,
      // asleep phone, desktop app in the background — which is exactly when a
      // bridged Discord DM appeared to do nothing: it landed in the database
      // but nothing live-updated and the badge never moved.
      const reached = emitToUser(receiver.username, "privateMessage", {
        id: String(saved._id),
        from: sender.username,
        to: receiver.username,
        text: translated || messageContent,
        time: saved.time
      });

      // The sender is usually signed in on the website as well; echo the
      // message back so the DM they just sent from Discord appears in that
      // conversation too.
      emitToUser(sender.username, "privateMessage", {
        id: String(saved._id),
        from: sender.username,
        to: receiver.username,
        text: messageContent,
        time: saved.time
      });

      console.log(
        `[Discord DM] ${sender.username} -> ${receiver.username}: ` +
        (reached
          ? `live to ${reached} socket(s)`
          : "recipient offline — the unread badge picks it up on their next connect")
      );

      await sendDiscordDM(discordId, `*(Message sent to **${targetUsername}**)*`);

    } catch (err) {
      console.error("[Discord Listener] Error handling DM reply:", err);
    }
  });
};

module.exports = setupDiscordListener;
