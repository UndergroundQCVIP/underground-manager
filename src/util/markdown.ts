/**
 * Underground Manager — Telegram legacy-Markdown escaping.
 *
 * User-controlled text (creator names, nominations, usernames) must be
 * escaped before it is embedded in a `parse_mode: "Markdown"` message,
 * otherwise a name such as "Anna_Lee" makes Telegram reject the whole message.
 */
export function escapeMd(text: string): string {
  return text.replace(/([_*`\[\]])/g, "\\$1");
}
