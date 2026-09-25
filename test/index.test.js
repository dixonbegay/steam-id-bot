const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { ChannelType } = require("discord.js");

const {
  HELP_TEXT,
  ProfileNotFoundError,
  parseProfileUrl,
  resolveVanity,
  handleDirectMessage,
  handleMessage
} = require("../index.js");

const GABE_ID = "76561197960287930";
const PROFILE_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<profile>
  <steamID64>${GABE_ID}</steamID64>
  <steamID><![CDATA[Rabscuttle]]></steamID>
</profile>`;
const NOT_FOUND_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<response><error><![CDATA[The specified profile could not be found.]]></error></response>`;

// Replaces global fetch for the current test; returns the mock so calls can be inspected
function mockFetch(t, { body = PROFILE_XML, status = 200, error } = {}) {
  return t.mock.method(globalThis, "fetch", async () => {
    if (error) throw error;
    return new Response(body, { status });
  });
}

function fakeMessage(content, { type = ChannelType.DM, bot = false, mentioned = false, send } = {}) {
  const sent = [];
  const message = {
    content,
    author: { bot },
    channel: {
      type,
      send: send || (async text => { sent.push(text); })
    },
    mentions: {
      has: (user, options) => {
        message.mentionsArgs = { user, options };
        return mentioned;
      }
    }
  };
  return { message, sent };
}

describe("parseProfileUrl", () => {
  it("parses a vanity URL", () => {
    assert.deepEqual(parseProfileUrl("https://steamcommunity.com/id/gabelogannewell/"), { type: "id", value: "gabelogannewell" });
  });

  it("parses a profiles URL", () => {
    assert.deepEqual(parseProfileUrl(`https://steamcommunity.com/profiles/${GABE_ID}`), { type: "profiles", value: GABE_ID });
  });

  it("finds a URL embedded in other text", () => {
    assert.deepEqual(parseProfileUrl("here's mine: https://steamcommunity.com/id/gabelogannewell thanks"), { type: "id", value: "gabelogannewell" });
  });

  it("accepts http, www and no scheme", () => {
    for (const url of [
      "http://steamcommunity.com/id/gabe",
      "https://www.steamcommunity.com/id/gabe",
      "steamcommunity.com/id/gabe"
    ]) {
      assert.deepEqual(parseProfileUrl(url), { type: "id", value: "gabe" }, url);
    }
  });

  it("ignores a trailing query string", () => {
    assert.deepEqual(parseProfileUrl("https://steamcommunity.com/id/gabe?foo=bar"), { type: "id", value: "gabe" });
  });

  it("is case-insensitive for the host and path type", () => {
    assert.deepEqual(parseProfileUrl("https://SteamCommunity.com/ID/Gabe"), { type: "id", value: "Gabe" });
  });

  it("returns null when there is no profile URL", () => {
    assert.equal(parseProfileUrl("help"), null);
    assert.equal(parseProfileUrl("https://steamcommunity.com/market/"), null);
  });

  it("does not match a spoofed URL without a profile name", () => {
    assert.equal(parseProfileUrl("https://evil.example/?https://steamcommunity.com/id"), null);
  });
});

describe("resolveVanity", () => {
  it("requests the steam XML endpoint for the profile name", async t => {
    const fetch = mockFetch(t);
    await resolveVanity("gabelogannewell");
    assert.equal(fetch.mock.callCount(), 1);
    const [url, options] = fetch.mock.calls[0].arguments;
    assert.equal(url, "https://steamcommunity.com/id/gabelogannewell/?xml=1");
    assert.ok(options.signal instanceof AbortSignal, "request should have a timeout signal");
  });

  it("always requests steamcommunity.com regardless of the name", async t => {
    const fetch = mockFetch(t);
    await resolveVanity("a/../../evil?x=");
    const url = new URL(fetch.mock.calls[0].arguments[0]);
    assert.equal(url.origin, "https://steamcommunity.com");
    assert.equal(url.search, "?xml=1");
  });

  it("returns the steamID64", async t => {
    mockFetch(t);
    assert.equal(await resolveVanity("gabelogannewell"), GABE_ID);
  });

  it("throws ProfileNotFoundError when steam reports no profile", async t => {
    mockFetch(t, { body: NOT_FOUND_XML });
    await assert.rejects(resolveVanity("nobody"), ProfileNotFoundError);
  });

  it("throws ProfileNotFoundError when the steamID64 is malformed", async t => {
    mockFetch(t, { body: "<profile><steamID64>12345</steamID64></profile>" });
    await assert.rejects(resolveVanity("weird"), ProfileNotFoundError);
  });

  it("throws a non-ProfileNotFoundError on an HTTP error", async t => {
    mockFetch(t, { body: "Service Unavailable", status: 503 });
    await assert.rejects(resolveVanity("gabe"), error => {
      assert.ok(!(error instanceof ProfileNotFoundError));
      assert.match(error.message, /503/);
      return true;
    });
  });
});

describe("handleDirectMessage", () => {
  it("replies with help text when there is no profile URL", async t => {
    const fetch = mockFetch(t);
    const { message, sent } = fakeMessage("help");
    await handleDirectMessage(message);
    assert.deepEqual(sent, [HELP_TEXT]);
    assert.equal(fetch.mock.callCount(), 0);
  });

  it("replies with the id from a profiles URL without calling steam", async t => {
    const fetch = mockFetch(t);
    const { message, sent } = fakeMessage(`https://steamcommunity.com/profiles/${GABE_ID}/`);
    await handleDirectMessage(message);
    assert.deepEqual(sent, [`Your steam id: ${GABE_ID}`]);
    assert.equal(fetch.mock.callCount(), 0);
  });

  it("rejects a profiles URL with an invalid id", async t => {
    mockFetch(t);
    const { message, sent } = fakeMessage("https://steamcommunity.com/profiles/123");
    await handleDirectMessage(message);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /doesn't look like a valid steam profile URL/);
  });

  it("explains the placeholder profile name without calling steam", async t => {
    const fetch = mockFetch(t);
    const { message, sent } = fakeMessage("https://steamcommunity.com/id/your_profile_name/");
    await handleDirectMessage(message);
    assert.match(sent[0], /Replace `your_profile_name`/);
    assert.equal(fetch.mock.callCount(), 0);
  });

  it("resolves a vanity URL", async t => {
    mockFetch(t);
    const { message, sent } = fakeMessage("my profile is https://steamcommunity.com/id/gabelogannewell/");
    await handleDirectMessage(message);
    assert.deepEqual(sent, [`Your steam id: ${GABE_ID}`]);
  });

  it("tells the user when the profile doesn't exist", async t => {
    mockFetch(t, { body: NOT_FOUND_XML });
    const { message, sent } = fakeMessage("https://steamcommunity.com/id/nobody/");
    await handleDirectMessage(message);
    assert.match(sent[0], /couldn't find a steam profile/);
  });

  it("sends a generic error when steam can't be reached", async t => {
    mockFetch(t, { error: new TypeError("fetch failed") });
    const { message, sent } = fakeMessage("https://steamcommunity.com/id/gabe/");
    await handleDirectMessage(message);
    assert.deepEqual(sent, ["An error occurred retrieving your steam id"]);
  });
});

describe("handleMessage", () => {
  const botUser = { id: "bot-user" };

  beforeEach(t => mockFetch(t));

  it("ignores messages from bots", async () => {
    const { message, sent } = fakeMessage("https://steamcommunity.com/id/gabe", { bot: true, mentioned: true });
    await handleMessage(message, botUser);
    assert.deepEqual(sent, []);
  });

  it("handles DMs", async () => {
    const { message, sent } = fakeMessage("help");
    await handleMessage(message, botUser);
    assert.deepEqual(sent, [HELP_TEXT]);
  });

  it("tells users to DM when mentioned in a server", async () => {
    const { message, sent } = fakeMessage("<@bot-user> hi", { type: ChannelType.GuildText, mentioned: true });
    await handleMessage(message, botUser);
    assert.deepEqual(sent, ["You must DM me your steam profile URL to receive your steam id"]);
    assert.equal(message.mentionsArgs.user, botUser);
    assert.deepEqual(message.mentionsArgs.options, { ignoreEveryone: true, ignoreRoles: true, ignoreRepliedUser: true });
  });

  it("ignores server messages that don't mention the bot", async () => {
    const { message, sent } = fakeMessage("https://steamcommunity.com/id/gabe", { type: ChannelType.GuildText });
    await handleMessage(message, botUser);
    assert.deepEqual(sent, []);
  });

  it("doesn't throw when sending the reply fails", async () => {
    const { message } = fakeMessage("<@bot-user>", {
      type: ChannelType.GuildText,
      mentioned: true,
      send: async () => { throw new Error("Missing Permissions"); }
    });
    await assert.doesNotReject(handleMessage(message, botUser));
  });
});
