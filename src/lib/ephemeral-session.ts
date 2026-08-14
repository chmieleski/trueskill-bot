import { InteractionWebhook, type Client } from 'discord.js';

export type EphemeralRef = {
  applicationId: string;
  token: string;
  messageId: string;
};

const sessions = new Map<string, EphemeralRef>();

/** Session key: one active private UI per user per channel. */
export function ephemeralSessionKey(userId: string, channelId: string): string {
  return `${userId}:${channelId}`;
}

/** Store the latest ephemeral reply for this user in this channel. */
export function rememberEphemeral(
  userId: string,
  channelId: string,
  ref: EphemeralRef,
): void {
  sessions.set(ephemeralSessionKey(userId, channelId), ref);
}

/** Take and remove the previous ephemeral ref, if any. */
export function takePreviousEphemeral(
  userId: string,
  channelId: string,
): EphemeralRef | null {
  const key = ephemeralSessionKey(userId, channelId);
  const prev = sessions.get(key) ?? null;
  if (prev) {
    sessions.delete(key);
  }
  return prev;
}

/**
 * Best-effort delete of the user's previous ephemeral in this channel.
 * Ignores missing sessions and Discord errors (expired token, unknown message).
 */
export async function deletePreviousEphemeral(
  client: Client<true>,
  userId: string,
  channelId: string,
): Promise<void> {
  const prev = takePreviousEphemeral(userId, channelId);
  if (!prev) {
    return;
  }

  try {
    const webhook = new InteractionWebhook(client, prev.applicationId, prev.token);
    await webhook.deleteMessage(prev.messageId);
  } catch {
    // Token expired, bot restarted mid-session, or message already gone.
  }
}

/** Clears all sessions — for unit tests only. */
export function clearEphemeralSessionsForTests(): void {
  sessions.clear();
}
