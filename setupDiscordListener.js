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
const MENTION = /^\s*@(\S+?)(?:\s+([\s\S]*))?$/;

// "@jane, hey" — punctuation typed after the name is not part of the username.
const TRAILING_PUNCTUATION = /[,.;:!?]+$/;

const USAGE = "Send a DM as `@username message` — for example `@jane hey there`. " +
  "You have to name the recipient: messages are never forwarded to your last conversation automatically.";

const setupDiscordListener = (User, DM, translateText, io, sendDiscordDM, discordEvents) => {
  discordEvents.on('dm', async ({ discordId, text }) => {
    try {
      const sender = await User.findOne({ discordId }).lean();
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

      if (receiver.socketId) {
        io.to(receiver.socketId).emit("privateMessage", {
          from: sender.username,
          to: receiver.username,
          text: translated || messageContent,
          time: saved.time
        });
      }

      if (sender.socketId) {
        io.to(sender.socketId).emit("privateMessage", {
          from: sender.username,
          to: receiver.username,
          text: messageContent,
          time: saved.time
        });
      }

      await sendDiscordDM(discordId, `*(Message sent to **${targetUsername}**)*`);

    } catch (err) {
      console.error("[Discord Listener] Error handling DM reply:", err);
    }
  });
};

module.exports = setupDiscordListener;
