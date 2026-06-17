/**
 * Escape Telegram **legacy Markdown** control characters in user-controlled
 * text (token symbols, names) before embedding it in a `parse_mode: 'Markdown'`
 * message. An unbalanced `_`, `*`, `` ` `` or `[` from a token symbol/address
 * otherwise breaks Telegram's entity parser ("can't parse entities").
 *
 * Legacy Markdown only treats these four characters as entity markers, and it
 * does honour a leading backslash to escape them — so this is sufficient for
 * the `Markdown` parse mode the bot uses. Do NOT use this inside backtick code
 * spans (backslashes there are literal); code spans already neutralise markdown.
 */
export function escapeMarkdown(text: string): string {
  return String(text ?? '').replace(/([_*`[])/g, '\\$1');
}
