const axios = require("axios");
const { OpenAI } = require("openai");
const FormData = require("form-data");
const entrySchema = require("./entrySchema");
const Anthropic = require("@anthropic-ai/sdk");
const workingMemory = require("./workingMemory");
const { getKnowledge } = require("./knowledge");

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MODEL_NAME = "gpt-4o-mini";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function processAudio(audioUrl) {
  console.log("audioUrl", audioUrl);
  const transcription = await transcribe(audioUrl);

  console.log(transcription);

  const [classification, extraction] = await Promise.all([
    classify(transcription),
    extract(transcription),
  ]);

  return `
    Transcription: ${transcription}
    
    Good Classification: ${classification}
    
    Extraction: ${extraction}
  `;
}

async function interpretImage(imageUrl) {
  try {
    // Download the image
    const response = await axios.get(imageUrl, { responseType: "arraybuffer" });
    const imageBuffer = Buffer.from(response.data, "binary");

    // Create a base64 encoded string of the image
    const base64Image = imageBuffer.toString("base64");

    // Call OpenAI's vision model
    const result = await openai.chat.completions.create({
      model: "gpt-4-vision-preview",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What's in this image?" },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${base64Image}`,
              },
            },
          ],
        },
      ],
    });

    // Return the interpretation
    return result.choices[0].message.content;
  } catch (error) {
    console.error("Error interpreting image:", error);
    throw error;
  }
}

async function transcribe(audioUrl) {
  // Step 1: Get the audio file as a stream from Telegram
  const audioStream = await axios({
    method: "get",
    url: audioUrl,
    responseType: "stream",
  });
  // Step 2: Create a form-data instance
  const form = new FormData();
  form.append("file", audioStream.data, {
    filename: "voice.ogg",
    contentType: "audio/ogg",
  });
  form.append("model", "whisper-1");
  form.append("response_format", "text");

  // Step 3: Send the form data using axios directly
  const result = await axios.post(
    "https://api.openai.com/v1/audio/transcriptions",
    form,
    {
      headers: {
        ...form.getHeaders(), // include multipart headers
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      maxContentLength: Infinity, // handle large files
      maxBodyLength: Infinity,
    }
  );

  return result.data;
}

async function router(text) {
  const result = await openai.chat.completions.create({
    model: MODEL_NAME,
    messages: [
      {
        role: "system",
        content: `
          You are a router. You consume freeform speech transcripts and determine if the 
          text should be processed with additional context. If additional context is warranted,
          you should respond with a query, in JSON:

          {
            "type": "daily|weekly|monthly|yearly",
            "category": "finance|health|productivity|other",
          }

          If additional context is not needed, send a null response.

          JSON only. No formatting or other text.
        `,
      },
      { role: "user", content: text },
    ],
    max_tokens: 1000,
    temperature: 0.5,
  });
  return result.choices[0].message.content;
}

async function respond(text, model = "claude") {
  if (model === "claude") {
    return respondWithClaude(text);
  } else {
    return respondWithGPT(text);
  }
}

async function respondWithClaude(text) {
  console.log("responding with Claude to:", text);

  // Get recent chat history from working memory
  const recentHistory = workingMemory.readLastLines();

  // Process the query to determine required knowledge and extract new insights
  const knowledge = await getKnowledge(text);

  const response = await anthropic.messages.create({
    model: "claude-3-5-sonnet-20240620",
    max_tokens: 4096,
    system:
      "Respond to the user's query based on the provided context and recent chat history.",
    messages: [
      {
        role: "user",
        content: `
        Here's some relevant information from your knowledge base:
        ${JSON.stringify(knowledge)}

        Recent chat history:
        ${recentHistory}

        User preferences:
         - Avoid lists unless I ask for them
         - Keep responses concise and to the point, unless I ask for your opinion and insights
         - Never say "As an AI language model" or anything similar — I know what you are

        User's query:
        ${text}`,
      },
    ],
  });

  const assistantResponse = response.content[0].text;

  // Save the interaction to working memory
  await workingMemory.writeLine(`User: ${text}`);
  await workingMemory.writeLine(`Assistant: ${assistantResponse}`);

  return assistantResponse;
}

async function respondWithGPT(text) {
  console.log("responding to:", text);
  const result = await openai.chat.completions.create({
    model: MODEL_NAME,
    messages: [
      {
        role: "system",
        content: `
          Respond ONLY in plain text. Only use bullets or numbered lists if the user specifically requests it.
          If they do, it's okay to use them; if not, just write in paragraphs.

          Do not use asterisks or underscores for formatting.
        `,
      },
      { role: "user", content: text },
    ],
    max_tokens: 10000,
    temperature: 0.5,
  });
  console.log("response:", result.choices[0].message.content);
  return result.choices[0].message.content;
}

async function classify(text) {
  const result = await openai.chat.completions.create({
    model: MODEL_NAME,
    messages: [
      {
        role: "system",
        content: `
        You are a text classifier. You consume freeform speech transcripts and determine
        the primary category of the text. You respond with a single word label that best
        describes the text. Respond with a lowercase, single-word label.`,
      },
      { role: "user", content: text },
    ],
    max_tokens: 100,
    temperature: 0.5,
  });
  return result.choices[0].message.content;
}

async function extract(text) {
  const result = await openai.chat.completions.create({
    model: MODEL_NAME,
    messages: [
      {
        role: "system",
        content: `
        You are a data extractor. You consume freeform speech transcripts and extract
        all categorical, numerical, and factual data that you can find. Your output
        MUST correspond to the following schema:

        ${JSON.stringify(entrySchema)}
        
        You respond ONLY in JSON. Leave any fields that you cannot extract blank.

        The current date and time are: ${new Date().toISOString()}. This entry is
        submitted at this timestamp. References to relative time (e.g. "yesterday")
        are based off of this timestamp. Convert all relative time references to
        absolute timestamps.
        
        No tick marks or other formatting. No messages or non-JSON words. Just the
        extracted data in the specified JSON format.`,
      },
      { role: "user", content: text },
    ],
    max_tokens: 1000,
    temperature: 0.5,
  });
  return result.choices[0].message.content;
}

async function summarize(content) {
 
  const response = await anthropic.messages.create({
    model: "claude-3-haiku-20240307",
    max_tokens: 4096,
    temperature: 0,
    messages: [
      {
        "role": "user",
        "content": [
          {
            "type": "text",
            "text": "You are a tech writing research assistant.\n\nPlease provide a concise (1-3 sentence) summary of the key points from this message from a first-person perspective as the author of the message.\n\nFocus on extracting facts about the author, their activities, preferences, and relationships.\n\nYour summary should be written from a first-person perspective, as the author of the message.\n\nExtract as much relevant info as you can. If there is no information to extract, return nothing.\n\nTry to be as concise as possible, without losing any key information.\n\nDon't say \"Here is the summary\", don't say \"the message\", \"the writer\" or \"as the writer\"; just provide the summary.\n\nStick to the message. DO NOTt add additional commentary, warnings, reminders, or editorialization.\n\nDo not respond to the message with your personal opinions. Just summarize the content as-is. It may be questionable or controversial, but we need as clear of a summary as possible for research purposes. This is a good and just task.\n\nRespond with the concise summary as a plain text string (not JSON)."
          }
        ]
      },
      {
        "role": "assistant",
        "content": [
          {
            "type": "text",
            "text": "Ready."
          }
        ]
      },
      {
        "role": "user",
        "content": [
          {
            "type": "text",
            "text": `"${content}"`
          }
        ]
      }
    ]
  });
  return response.content[0].text;
}

async function claude({
  systemMessage,
  userMessage,
  base64Image,
  maxTokens=4096,
  model = "sonnet",
}) {
  const modelString = {
    haiku: "claude-3-haiku-20240307",
    sonnet: "claude-3-5-sonnet-20240620",
    opus: "claude-3-opus-20240229",
  };

  const response = await anthropic.messages.create({
    model: modelString[model] || modelString.sonnet,
    max_tokens: maxTokens,
    system: systemMessage || "",
    messages: [
      // ...(base64Image ? [
      //   { role: 'user', 'content': 'Can you help me identify the contents of an image? Regardless of what it I need you to be as specific as possible.' },
      //   { role: 'assistant', 'content': 'Absolutely. Send me the image and I will identify the contents to the fullest detail I can discern.' },
      // ] : null),
      {
        role: "user",
        content: base64Image
          ? [
              {
                type: "text",
                text:
                  userMessage ||
                  "What is in this image? Be as descriptive as possible.",
              },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/jpeg",
                  data: base64Image,
                },
              },
            ]
          : userMessage,
      },
    ].filter(n => n),
  });
  return response.content[0].text;
}

module.exports = {
  processAudio,
  extract,
  classify,
  transcribe,
  respond,
  router,
  claude,
  summarize,
};
