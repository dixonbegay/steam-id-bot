const { Client, Events, GatewayIntentBits, Partials, ChannelType } = require("discord.js");
const winston = require("winston");
const { DOMParser } = require("@xmldom/xmldom");

require("dotenv").config({ quiet: true });

const logger = winston.createLogger({
  level: "info",
  silent: process.env.NODE_ENV === "test",
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

const HELP_TEXT = "Send me your steam profile URL to get your steam ID. It should look like `https://steamcommunity.com/id/your_profile_name/` or `https://steamcommunity.com/profiles/7656119XXXXXXXXXX/`";

// Matches steamcommunity.com/id/<vanity> and steamcommunity.com/profiles/<steamID64>,
// with or without the scheme and www.
const PROFILE_URL_REGEX = /(?:https?:\/\/)?(?:www\.)?steamcommunity\.com\/(id|profiles)\/([A-Za-z0-9_-]+)/i;
const STEAM_ID64_REGEX = /^7656\d{13}$/;

class ProfileNotFoundError extends Error {}

// Returns { type, value } for the first steam profile URL in the text, or null.
function parseProfileUrl(text) {
  const match = text.match(PROFILE_URL_REGEX);
  if (!match) return null;
  return { type: match[1].toLowerCase(), value: match[2] };
}

// Resolves a vanity profile name to a steamID64 using the community XML endpoint.
async function resolveVanity(name) {
  const url = `https://steamcommunity.com/id/${encodeURIComponent(name)}/?xml=1`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!resp.ok) {
    throw new Error(`Steam returned HTTP ${resp.status} for ${url}`);
  }

  const text = await resp.text();
  const doc = new DOMParser().parseFromString(text, "text/xml");
  const ele = doc.getElementsByTagName("steamID64").item(0);
  const steamID = ele && ele.textContent.trim();
  if (!steamID || !STEAM_ID64_REGEX.test(steamID)) {
    throw new ProfileNotFoundError(`No steamID64 found for ${name}`);
  }
  return steamID;
}

async function handleDirectMessage(message) {
  const profile = parseProfileUrl(message.content);
  if (!profile) {
    await message.channel.send(HELP_TEXT);
    return;
  }

  if (profile.type === "profiles") {
    if (STEAM_ID64_REGEX.test(profile.value)) {
      await message.channel.send(`Your steam id: ${profile.value}`);
    } else {
      await message.channel.send("That doesn't look like a valid steam profile URL.\n" + HELP_TEXT);
    }
    return;
  }

  if (profile.value.toLowerCase() === "your_profile_name") {
    await message.channel.send("Replace `your_profile_name` with your own profile name.\n" + HELP_TEXT);
    return;
  }

  try {
    const steamID = await resolveVanity(profile.value);
    await message.channel.send(`Your steam id: ${steamID}`);
  } catch (error) {
    if (error instanceof ProfileNotFoundError) {
      await message.channel.send("I couldn't find a steam profile at that URL. Double check it and try again.");
    } else {
      logger.error(`Failed to resolve steam id: ${error.stack || error}`);
      await message.channel.send("An error occurred retrieving your steam id");
    }
  }
}

// Initialize Discord Bot
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages
  ],
  // DM channels aren't cached, so they must be enabled as partials to receive DMs
  partials: [Partials.Channel]
});

client.once(Events.ClientReady, readyClient => {
  logger.info("Connected");
  const { username, id } = readyClient.user;
  logger.info(`Logged in as: ${username} (${id})`);
  readyClient.user.setActivity("Looking for steam ID's");
});

client.on(Events.GuildCreate, guild => {
  const { id, name } = guild;
  logger.info(`Added to guild ${name} | ID: ${id}`);
  logger.info(`Total guilds: ${client.guilds.cache.size}`);
});

client.on(Events.GuildDelete, guild => {
  const { id, name } = guild;
  logger.info(`Guild ${name} removed me with ID: ${id}`);
  logger.info(`Total guilds: ${client.guilds.cache.size}`);
});

async function handleMessage(message, botUser) {
  if (message.author.bot) return;

  try {
    if (message.channel.type === ChannelType.DM) {
      await handleDirectMessage(message);
    } else if (message.mentions.has(botUser, { ignoreEveryone: true, ignoreRoles: true, ignoreRepliedUser: true })) {
      await message.channel.send("You must DM me your steam profile URL to receive your steam id");
    }
  } catch (error) {
    // Most likely missing permissions to send in the channel
    logger.error(`Failed to handle message: ${error.stack || error}`);
  }
}

client.on(Events.MessageCreate, message => handleMessage(message, client.user));

if (require.main === module) {
  client.login(process.env.TOKEN);
}

module.exports = {
  HELP_TEXT,
  ProfileNotFoundError,
  parseProfileUrl,
  resolveVanity,
  handleDirectMessage,
  handleMessage
};
