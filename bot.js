const TelegramBot = require("node-telegram-bot-api");
const { transcribe, claude } = require("../intelligence");
const axios = require("axios");
const fse = require("fs-extra");
const { fetchTranscript } = require("../youtube");

const respondWithMemory = require('./memory');



// TODO: Integrate auth
const authManager = require("../auth");

const FETCH_TIMEOUT_MS = 5000;

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TEST_TOKEN);

let offset = 0;

fetch();

async function fetch() {
  const msgs = await bot.getUpdates({
    offset,
    allowed_updates: [
      "message",
      "voice",
      "message_reaction",
      "message_reaction_count",
    ],
  });

  msgs
    .filter((n) => n.message_reaction)
    .forEach((msg) => {
      handleReaction(msg.message_reaction);
      offset = Math.max(offset, msg.update_id + 1);
    });

  for (const msg of msgs.filter((n) => !n.message_reaction)) {
    if (msg.message.voice) {
      await handleVoiceMessage(msg.message);
    } else if (msg.message.photo) {
      await handleImageMessage(msg.message);
    } else if (msg.message.text) {
      await handleMessage(msg.message);
    }
    offset = Math.max(offset, msg.update_id + 1);
  }

  setTimeout(fetch, FETCH_TIMEOUT_MS);
}

async function sendReaction(message, emoji) {
  try {
    await bot.setMessageReaction(message.chat.id, message.message_id, {
      reaction: [
        {
          type: "emoji",
          emoji: emoji,
        },
      ],
    });
    console.log(
      `Reaction ${emoji} sent to message ${message.message_id} in chat ${message.chat.id}`
    );
  } catch (error) {
    console.error("Error sending reaction:", error);
  }
}

async function handleReaction(msg) {
  const {
    chat,
    message_id,
    old_reaction = [{ emoji: null }],
    new_reaction = [{ emoji: null }],
  } = msg;
  const oldReaction = (old_reaction[0] || { emoji: null }).emoji;
  const newReaction = (new_reaction[0] || { emoji: null }).emoji;
  console.log(JSON.stringify(msg, null, 2));
  bot.sendMessage(
    chat.id,
    `Message ${message_id} reacted with ${oldReaction} -> ${newReaction}`
  );
}

// Must be one of
// "👍", "👎", "❤", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢", "🎉", "🤩", "🤮", "💩", "🙏", "👌",
// "🕊", "🤡", "🥱", "🥴", "😍", "🐳", "❤‍🔥", "🌚", "🌭", "💯", "🤣", "⚡", "🍌", "🏆", "💔", "🤨", "😐", "🍓",
// "🍾", "💋", "🖕", "😈", "😴", "😭", "🤓", "👻", "👨‍💻", "👀", "🎃", "🙈", "😇", "😨", "🤝", "✍", "🤗", "🫡",
// "🎅", "🎄", "☃", "💅", "🤪", "🗿", "🆒", "💘", "🙉", "🦄", "😘", "💊", "🙊", "😎", "👾", "🤷‍♂", "🤷", "🤷‍♀",
// "😡"
async function handleMessage(msg) {
  bot.sendChatAction(msg.chat.id, "typing");

  try {
    const youtubeUrls = extractYoutubeUrls(msg.text);

    if (youtubeUrls.length > 0) {
      const transcripts = await Promise.all(youtubeUrls.map(fetchTranscript));
      console.log("Transcripts:", transcripts);
      await bot.sendMessage(msg.chat.id, "Saved the transcript");
      return;
    }

    const response = await respondWithMemory(msg.text);
    // const response = await claude({
    //   userMessage: msg.text,
    //   model: "haiku",
    // });

    const message = await bot.sendMessage(msg.chat.id, response);

    // TODO: Store message and message ID
  } catch (e) {
    bot.sendMessage(msg.chat.id, `Failed: ${e.message}`);
  }
}

function extractYoutubeUrls(text) {
  const youtubeRegex =
    /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com|youtu\.be)\/(?:watch\?v=)?(?:embed\/)?(?:v\/)?(?:shorts\/)?(?:\S+)/g;
  return text.match(youtubeRegex) || [];
}

async function handleVoiceMessage(msg) {
  const voiceFileId = msg.voice.file_id;
  const voiceFileLink = await bot.getFileLink(voiceFileId);

  sendReaction(msg, "👀");

  try {
    bot.sendChatAction(msg.chat.id, "typing");
    // Step 1: Get the audio file as a stream from Telegram
    const transcription = await transcribe(voiceFileLink);

    bot.sendChatAction(msg.chat.id, "typing");
    
    const response = respondWithMemory(transcription);
    // const response = await claude({
    //   userMessage: transcription,
    //   model: "haiku",
    // });

    bot.sendMessage(msg.chat.id, response);

    // TODO: Store message and message ID
  } catch (error) {
    console.error("Error transcribing voice message:", error);
    bot.sendMessage(id, "Error transcribing voice message.", {
      reply_to_message_id: msg.message_id,
    });
  }
}

async function handleImageMessage(msg) {
  // TODO: Handle multiple images
  const photoFileId = msg.photo[msg.photo.length - 1].file_id;
  const photoFileLink = await bot.getFileLink(photoFileId);

  sendReaction(msg, "👀");

  try {
    bot.sendChatAction(msg.chat.id, "typing");

    // 2. Invoke the LLM with the image to get a comprehensive textual description
    // Download the image and convert it to base64
    const response = await axios.get(photoFileLink, {
      responseType: "arraybuffer",
    });

    // Write response to file
    fse.outputFile(
      `${process.env.FILES_DIR}/images/${photoFileId}.jpg`,
      response.data
    );

    const base64Image = Buffer.from(response.data, "binary").toString("base64");

    const imageDescription = await claude({
      userMessage: msg.caption,
      base64Image: base64Image,
      model: "haiku",
    });

    bot.sendMessage(msg.chat.id, imageDescription);
  } catch (error) {
    console.error("Error handling image message:", error);
    bot.sendMessage(msg.chat.id, "Error processing the image.", {
      reply_to_message_id: msg.message_id,
    });
    return null;
  }
}
