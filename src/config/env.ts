import { config } from 'dotenv';

config();

const botToken = process.env.BOT_TOKEN;
const storagePath = process.env.STORAGE_PATH;

if (!botToken) {
  throw new Error('BOT_TOKEN is required');
}

export const env = {
  botToken,
  storagePath,
};
