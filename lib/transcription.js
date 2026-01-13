import Groq from 'groq-sdk';
import { createReadStream } from 'fs';

let groqClient = null;

/**
 * Initialize Groq client for audio transcription
 * @param {string} apiKey - Groq API key
 * @returns {Groq|null} - Initialized Groq client or null if key missing
 */
export function initializeGroqClient(apiKey) {
  if (!apiKey) {
    console.warn('⚠ GROQ_API_KEY not set - audio transcription will not be available');
    return null;
  }

  groqClient = new Groq({ apiKey });
  console.log('✓ Groq client initialized for transcription');
  return groqClient;
}

/**
 * Transcribe audio file using Groq Whisper
 * @param {string} filePath - Path to audio file
 * @param {string} language - Language code (default: 'en', or remove for auto-detect)
 * @returns {Promise<string>} - Transcribed text
 */
export async function transcribeAudio(filePath, language = 'en') {
  if (!groqClient) {
    throw new Error('Groq API key required for audio transcription. Please set GROQ_API_KEY in your environment variables.');
  }

  try {
    const transcription = await groqClient.audio.transcriptions.create({
      file: createReadStream(filePath),
      model: 'whisper-large-v3-turbo',
      response_format: 'json',
      language, // Change if needed, or set to null to auto-detect
    });

    return transcription.text;
  } catch (error) {
    console.error('Error transcribing audio:', error);
    throw error;
  }
}

/**
 * Get the Groq client instance
 * @returns {Groq|null} - Groq client or null if not initialized
 */
export function getGroqClient() {
  return groqClient;
}
