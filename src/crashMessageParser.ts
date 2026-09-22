/**
 * Firebase alerts (or, here, the "Satpam Android" relay bot that posts them)
 * give the crashing frame in one of three forms, in order of reliability:
 *   1. "ClassName.method (File.kt:123)" — exact file + line.
 *   2. "File.kt - some.qualified.method.chain" — exact filename, no line.
 *      Common for NON_FATAL issues where the chain is often a compiler-
 *      mangled coroutine/lambda name, so the filename is the only reliable part.
 *   3. A bare fully-qualified path like "com.example.MainActivity.onCreate"
 *      — no filename at all, so we derive a guessed class name from it.
 */

export interface CrashInfo {
  isCrashlyticsAlert: boolean;
  file?: string;
  line?: number;
  className?: string;
  crashLink?: string;
  text: string;
}

const FIREBASE_LINK_PATTERN = /console\.firebase\.google\.com\/[^\s|>]*\/crashlytics\//i;
const CRASH_LINK_PATTERN = /(https?:\/\/console\.firebase\.google\.com\/[^\s|>]+)/i;
const FRAME_PATTERN = /\(([A-Za-z_$][\w$]*\.(?:kt|java)):(\d+)\)/;
const FILE_DASH_PATTERN = /\b([A-Za-z_$][\w$]*\.(?:kt|java))\s*-\s*[\w$.]/;
const QUALIFIED_NAME_PATTERN = /\*([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*){2,})\*/;
// The official Firebase Slack app's "Summary" field: "Summary\n<url|qualified.name>" or "Summary\nqualified.name".
// The label itself may or may not be bold depending on how the block was rendered, so we don't require asterisks around it.
const SUMMARY_FIELD_PATTERN = /\bSummary\b\*?\s*\n(?:<[^|>]*\|)?([^>\n]+)>?/i;

/**
 * Slack's "rich_text" blocks (used when a human types a message, or Slack
 * re-renders one) encode bold as `style: { bold: true }` metadata rather
 * than literal "*asterisks*" the way "section"/mrkdwn blocks do. We
 * re-serialize contiguous bold runs back into "*...*" so the same regexes
 * below work regardless of which block type produced the message.
 */
function flattenRichText(elements: any[] | undefined): string {
  let result = '';
  let boldOpen = false;

  const closeBold = () => {
    if (boldOpen) {
      result += '*';
      boldOpen = false;
    }
  };

  for (const el of elements ?? []) {
    if (!el) continue;

    if (Array.isArray(el.elements)) {
      closeBold();
      result += flattenRichText(el.elements);
      continue;
    }

    const text = typeof el.text === 'string' ? el.text : '';
    const isBold = !!el.style?.bold;

    if (isBold && !boldOpen) {
      result += '*';
      boldOpen = true;
    } else if (!isBold) {
      closeBold();
    }

    result += text;
  }

  closeBold();
  return result;
}

function collectMessageText(message: Record<string, any>): string {
  const parts: string[] = [];

  if (typeof message.text === 'string') parts.push(message.text);

  for (const block of message.blocks ?? []) {
    if (block?.type === 'rich_text') {
      parts.push(flattenRichText(block.elements));
      continue;
    }

    if (block?.text?.text) parts.push(block.text.text);
    for (const field of block?.fields ?? []) {
      if (typeof field?.text === 'string') parts.push(field.text);
    }
    for (const el of block?.elements ?? []) {
      if (typeof el?.text === 'string') parts.push(el.text);
      else if (el?.text?.text) parts.push(el.text.text);
      for (const sub of el?.elements ?? []) {
        if (typeof sub?.text === 'string') parts.push(sub.text);
      }
    }
  }

  for (const att of message.attachments ?? []) {
    if (att.pretext) parts.push(att.pretext);
    if (att.title) parts.push(att.title);
    if (att.text) parts.push(att.text);
    // Legacy attachment "fields" (title/value pairs), e.g. the "Summary" /
    // "App" / "Platform" / "Version" fields Firebase posts for some alert
    // types. This is where the Crashlytics link and crashing method usually
    // live when there's no att.text.
    for (const field of att.fields ?? []) {
      if (typeof field?.value === 'string') {
        parts.push(field.title ? `${field.title}\n${field.value}` : field.value);
      }
    }
    if (att.fallback) parts.push(att.fallback);
  }

  return parts.join('\n');
}

function looksLikeCrashlyticsAlert(text: string): boolean {
  return FIREBASE_LINK_PATTERN.test(text) || /crashlytics/i.test(text);
}

/** Given "com.example.MainActivity.onCreate" or just "com.example.MainActivity", guess the class name. */
function deriveClassName(qualifiedName: string): string | undefined {
  const parts = qualifiedName.split('.');
  const last = parts[parts.length - 1];
  const secondLast = parts.length >= 2 ? parts[parts.length - 2] : undefined;

  if (secondLast && /^[A-Z]/.test(secondLast)) return secondLast; // Class.method form
  if (/^[A-Z]/.test(last)) return last; // bare Class form
  return undefined;
}

export function parseCrashMessage(message: Record<string, any>): CrashInfo {
  const text = collectMessageText(message);
  const isCrashlyticsAlert = looksLikeCrashlyticsAlert(text);

  if (!isCrashlyticsAlert) {
    return { isCrashlyticsAlert: false, text };
  }

  const crashLink = CRASH_LINK_PATTERN.exec(text)?.[1];

  const frameMatch = FRAME_PATTERN.exec(text);
  if (frameMatch) {
    return { isCrashlyticsAlert: true, file: frameMatch[1], line: Number(frameMatch[2]), crashLink, text };
  }

  const fileDashMatch = FILE_DASH_PATTERN.exec(text);
  if (fileDashMatch) {
    return { isCrashlyticsAlert: true, file: fileDashMatch[1], crashLink, text };
  }

  const summaryMatch = SUMMARY_FIELD_PATTERN.exec(text);
  if (summaryMatch) {
    const className = deriveClassName(summaryMatch[1].trim());
    if (className) {
      return { isCrashlyticsAlert: true, className, crashLink, text };
    }
  }

  const qualifiedMatch = QUALIFIED_NAME_PATTERN.exec(text);
  if (qualifiedMatch) {
    const className = deriveClassName(qualifiedMatch[1]);
    if (className) {
      return { isCrashlyticsAlert: true, className, crashLink, text };
    }
  }

  return { isCrashlyticsAlert: true, crashLink, text };
}
