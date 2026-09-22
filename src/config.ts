import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
}

export const config = {
  slackBotToken: required('SLACK_BOT_TOKEN'),
  slackAppToken: required('SLACK_APP_TOKEN'),
  crashChannelId: process.env.CRASH_CHANNEL_ID,

  githubToken: required('GITHUB_TOKEN'),
  githubOwner: required('GITHUB_OWNER'),
  githubRepo: required('GITHUB_REPO'),
  githubBranch: process.env.GITHUB_BRANCH,
  codeownersPath: process.env.CODEOWNERS_PATH || '.github/CODEOWNERS',

  ownersMapPath: process.env.OWNERS_MAP_PATH
    ? path.resolve(process.cwd(), process.env.OWNERS_MAP_PATH)
    : path.resolve(process.cwd(), 'config', 'owners-map.json'),
};
