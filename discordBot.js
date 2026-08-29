const { Client, GatewayIntentBits, Partials } = require('discord.js');
const EventEmitter = require('events');

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || null;

const discordEvents = new EventEmitter();
let discordClient = null;

if (DISCORD_BOT_TOKEN) {
  discordClient = new Client({ 
    intents: [
      GatewayIntentBits.Guilds, 
      GatewayIntentBits.DirectMessages, 
      GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel] 
  });

  discordClient.on('ready', () => {
    console.log(`[Discord] Bot logged in as ${discordClient.user.tag}`);
  });

  discordClient.on('messageCreate', message => {
    // Ignore bot messages and non-DM messages
    if (message.author.bot || message.guildId) return;
    
    discordEvents.emit('dm', {
      discordId: message.author.id,
      text: message.content
    });
  });

  discordClient.login(DISCORD_BOT_TOKEN).catch(err => {
    console.error(`[Discord] Bot login failed:`, err);
  });
}

async function sendDiscordDM(discordId, message) {
  if (!discordClient || !discordClient.isReady()) return;
  try {
    const user = await discordClient.users.fetch(discordId);
    if (user) {
      await user.send(message);
    }
  } catch (err) {
    console.error(`[Discord] Error sending DM to ${discordId}:`, err);
  }
}

module.exports = { discordClient, sendDiscordDM, discordEvents };
