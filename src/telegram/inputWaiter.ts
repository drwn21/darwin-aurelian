/**
 * Simple per-chat text-input state for Telegram.
 * State machine approach: set pending field, check on message, resolve inline.
 */

interface PendingInput {
  fieldId: string;
  chatId: string;
  setAt: number;
}

const pending = new Map<string, PendingInput>();

const INPUT_TIMEOUT_MS = 60_000; // 1 minute to type a value

/** Mark a chat as expecting a text input for a field. */
export function setPendingInput(chatId: string, fieldId: string): void {
  pending.set(chatId, { fieldId, chatId, setAt: Date.now() });
}

/** Check if a chat has a pending input (auto-expires after 60s). */
export function hasPendingInput(chatId: string): boolean {
  const entry = pending.get(chatId);
  if (!entry) return false;
  if (Date.now() - entry.setAt > INPUT_TIMEOUT_MS) {
    pending.delete(chatId);
    return false;
  }
  return true;
}

/** Get the pending fieldId for a chat (without consuming). */
export function getPendingFieldId(chatId: string): string | undefined {
  const entry = pending.get(chatId);
  if (!entry) return undefined;
  if (Date.now() - entry.setAt > INPUT_TIMEOUT_MS) {
    pending.delete(chatId);
    return undefined;
  }
  return entry.fieldId;
}

/** Consume and clear the pending input for a chat. */
export function consumePendingInput(chatId: string): string | undefined {
  const entry = pending.get(chatId);
  if (!entry) return undefined;
  pending.delete(chatId);
  if (Date.now() - entry.setAt > INPUT_TIMEOUT_MS) return undefined;
  return entry.fieldId;
}

/** Cancel any pending input for a chat. */
export function clearPendingInput(chatId: string): void {
  pending.delete(chatId);
}
