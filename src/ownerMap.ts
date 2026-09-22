import fs from 'fs';
import { config } from './config';

type SlackTarget = { type: 'user'; id: string } | { type: 'usergroup'; id: string };

let cachedMap: Record<string, SlackTarget> | null = null;

function loadMap(): Record<string, SlackTarget> {
  if (cachedMap) return cachedMap;

  if (!fs.existsSync(config.ownersMapPath)) {
    throw new Error(
      `Owners map not found at ${config.ownersMapPath}. Copy config/owners-map.example.json to config/owners-map.json and fill it in.`
    );
  }

  cachedMap = JSON.parse(fs.readFileSync(config.ownersMapPath, 'utf-8'));
  return cachedMap!;
}

/** Resolves a CODEOWNERS entry (e.g. "@octocat" or "@org/team-mobile") to a Slack mention string. */
export function resolveSlackMention(githubOwner: string): string | null {
  const map = loadMap();
  const handle = githubOwner.replace(/^@/, '');
  const target = map[handle];
  if (!target || !target.id || target.id === 'TODO') return null;

  return target.type === 'usergroup' ? `<!subteam^${target.id}>` : `<@${target.id}>`;
}
