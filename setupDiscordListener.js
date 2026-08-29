const setupDiscordListener = (User, DM, translateText, io, sendDiscordDM, discordEvents) => {
  discordEvents.on('dm', async ({ discordId, text }) => {
    try {
      const sender = await User.findOne({ discordId }).lean();
      if (!sender) {
        await sendDiscordDM(discordId, "Please link your Discord account on the MaleCyberFighters website to use this feature.");
        return;
      }

      // Try to find the last person who DMed this user, or who this user DMed.
      const lastDM = await DM.findOne({
        $or: [{ to: sender.username }, { from: sender.username }],
        type: { $in: [null, "normal", "clip", "image"] },
        from: { $ne: "SYSTEM" },
        to: { $ne: "SYSTEM" }
      }).sort({ time: -1 }).lean();

      let targetUsername = null;
      let messageContent = text;

      // Check if they are trying to specify a user via "@username message"
      if (text.startsWith('@')) {
        const spaceIndex = text.indexOf(' ');
        if (spaceIndex > 1) {
          const maybeUsername = text.slice(1, spaceIndex);
          const userExists = await User.findOne({ username: maybeUsername }).lean();
          if (userExists) {
            targetUsername = maybeUsername;
            messageContent = text.slice(spaceIndex + 1).trim();
          }
        }
      }

      if (!targetUsername && lastDM) {
        targetUsername = (lastDM.from === sender.username) ? lastDM.to : lastDM.from;
      }

      if (!targetUsername) {
        await sendDiscordDM(discordId, "Could not determine who you are trying to reply to. You can specify a user by typing `@username message`.");
        return;
      }

      const receiver = await User.findOne({ username: targetUsername }).lean();
      if (!receiver) {
        await sendDiscordDM(discordId, `User **${targetUsername}** not found.`);
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
