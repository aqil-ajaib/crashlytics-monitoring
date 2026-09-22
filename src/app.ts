import { App, LogLevel } from '@slack/bolt';
import { config } from './config';
import { parseCrashMessage } from './crashMessageParser';
import { findFullPath, getCodeownersContent } from './github';
import { parseCodeowners, findOwners } from './codeowners';
import { resolveSlackMention } from './ownerMap';

const app = new App({
  token: config.slackBotToken,
  appToken: config.slackAppToken,
  socketMode: true,
  logLevel: LogLevel.DEBUG,
});

const ACK_ACTION_ID = 'ack_investigate';
const ACK_EMOJI = 'ackw';

/**
 * Kotlin compiles top-level functions/properties (ones not inside a class)
 * into a synthetic facade class named "<FileName>Kt" — e.g. top-level
 * functions in "DoneDetailsTableRow.kt" end up under class
 * "DoneDetailsTableRowKt". So when the derived class name ends in "Kt", the
 * real source file is most likely the name with that suffix stripped.
 */
function stripKtFacadeSuffix(className: string): string | undefined {
  if (className.length > 2 && className.endsWith('Kt')) {
    return className.slice(0, -2);
  }
  return undefined;
}

/**
 * Kotlin also compiles lambdas/anonymous classes/coroutine continuations as
 * "OuterClass$1", "OuterClass$methodName$1", etc. — everything after the
 * first "$" is synthetic, so the real source file belongs to whatever comes
 * before it (which may itself be a "Kt" facade, e.g. "ExtensionsKt$foo$1").
 */
function candidateFilenamesForClass(className: string): string[] {
  const candidates: string[] = [];

  const dollarIndex = className.indexOf('$');
  const outerClass = dollarIndex > 0 ? className.slice(0, dollarIndex) : className;

  const facadeStripped = stripKtFacadeSuffix(outerClass);
  if (facadeStripped) {
    candidates.push(`${facadeStripped}.kt`);
  }
  if (outerClass !== className) {
    candidates.push(`${outerClass}.kt`, `${outerClass}.java`);
  }

  candidates.push(`${className}.kt`, `${className}.java`);
  return candidates;
}

function buildOwnerReplyBlocks(text: string, channel: string, parentTs: string) {
  return [
    { type: 'section', text: { type: 'mrkdwn', text } },
    {
      type: 'actions',
      block_id: 'crash_ack_actions',
      elements: [
        {
          type: 'button',
          action_id: ACK_ACTION_ID,
          text: { type: 'plain_text', text: 'ACK and will investigate', emoji: true },
          value: JSON.stringify({ channel, parentTs }),
        },
      ],
    },
  ];
}

app.message(async ({ message, say, logger }) => {
  const msg = message as Record<string, any>;

  logger.info(`[debug] received message event: channel=${msg.channel} subtype=${msg.subtype} text=${JSON.stringify(msg.text ?? '').slice(0, 200)}`);

  // Ignore anything outside the crash channel (if configured).
  if (config.crashChannelId && msg.channel !== config.crashChannelId) return;

  const crash = parseCrashMessage(msg);
  if (!crash.isCrashlyticsAlert) {
    logger.info('[debug] message did not look like a Crashlytics alert, ignoring');
    return;
  }

  const threadTs = msg.thread_ts || msg.ts;

  const candidateFilenames = crash.file
    ? [crash.file]
    : crash.className
      ? candidateFilenamesForClass(crash.className)
      : [];

  if (candidateFilenames.length === 0) {
    logger.info('Crashlytics alert detected but no file/class name could be extracted from the message text.');
    return;
  }

  try {
    let candidatePaths: string[] = [];
    let matchedFilename = candidateFilenames[0];
    for (const filename of candidateFilenames) {
      candidatePaths = await findFullPath(filename);
      if (candidatePaths.length > 0) {
        matchedFilename = filename;
        break;
      }
    }

    const linkLine = crash.crashLink ? `🔗 <${crash.crashLink}|Open in Crashlytics>` : undefined;

    if (candidatePaths.length === 0) {
      await say({
        text: [
          `Couldn't find \`${candidateFilenames.join('` or `')}\` in ${config.githubOwner}/${config.githubRepo} to resolve a code owner.`,
          ...(linkLine ? [linkLine] : []),
        ].join('\n'),
        thread_ts: threadTs,
      });
      return;
    }

    if (candidatePaths.length > 1) {
      logger.warn(`Multiple files named ${matchedFilename} found; using the first match: ${candidatePaths[0]}`);
    }

    const filePath = candidatePaths[0];
    const codeownersContent = await getCodeownersContent();
    const entries = parseCodeowners(codeownersContent);
    const owners = findOwners(filePath, entries);

    if (owners.length === 0) {
      await say({
        text: [
          `Crash traced to \`${filePath}\`, but no CODEOWNERS entry matches this path.`,
          ...(linkLine ? [linkLine] : []),
        ].join('\n'),
        thread_ts: threadTs,
      });
      return;
    }

    const mentions = owners.map(
      (owner) => resolveSlackMention(owner) ?? `\`${owner}\` _(no Slack mapping — add to config/owners-map.json)_`
    );

    const replyText = [
      `📂 *Crash traced to* \`${filePath}\`${crash.line ? `:${crash.line}` : ''}`,
      ...(linkLine ? [linkLine] : []),
      `👥 *Code owner:* ${mentions.join(', ')}`,
    ].join('\n');

    await say({
      text: replyText,
      thread_ts: threadTs,
      blocks: buildOwnerReplyBlocks(replyText, msg.channel, threadTs),
    });
  } catch (err) {
    logger.error('Failed to resolve code owner for crash alert', err);
  }
});

app.action(ACK_ACTION_ID, async ({ ack, body, client, logger }) => {
  await ack();

  const actionBody = body as Record<string, any>;
  const rawValue = actionBody.actions?.[0]?.value;
  const clickerId = actionBody.user?.id;
  if (!rawValue || !clickerId) return;

  let payload: { channel: string; parentTs: string };
  try {
    payload = JSON.parse(rawValue);
  } catch {
    logger.error(`Failed to parse ACK button value: ${rawValue}`);
    return;
  }

  try {
    await client.reactions.add({
      channel: payload.channel,
      timestamp: payload.parentTs,
      name: ACK_EMOJI,
    });
  } catch (err: any) {
    if (err?.data?.error !== 'already_reacted') {
      logger.error('Failed to add ACK reaction', err);
    }
  }

  await client.chat.postMessage({
    channel: payload.channel,
    thread_ts: payload.parentTs,
    text: `<@${clickerId}> ACK and will investigate this issue :siappak:`,
    reply_broadcast: true,
  });
});

(async () => {
  await app.start();
  console.log('⚡️ Crashlytics CODEOWNERS bot is running (Socket Mode)');
})();
