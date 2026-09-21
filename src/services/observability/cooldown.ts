/**
 * Per-alert-type cooldown tracker for Discord ops embeds.
 */

export type AlertType =
  | 'boot'
  | 'ready'
  | 'disconnect'
  | 'shutdown'
  | 'crash'
  | 'unhandled_rejection'
  | 'high_rss'
  | 'event_loop_lag'
  | 'db_unhealthy'
  | 'db_recovered';

const DEFAULT_COOLDOWN_MS = 12 * 60 * 1000;

/** Tracks last-sent timestamps so repeat alerts are coalesced. */
export class AlertCooldown {
  private readonly lastSent = new Map<AlertType, number>();

  constructor(private readonly cooldownMs = DEFAULT_COOLDOWN_MS) {}

  /**
   * Returns true and records now when the alert type is outside cooldown.
   * Lifecycle events (boot/ready/shutdown/crash) always send.
   */
  tryAllow(type: AlertType, nowMs = Date.now()): boolean {
    if (type === 'boot' || type === 'ready' || type === 'shutdown' || type === 'crash') {
      this.lastSent.set(type, nowMs);
      return true;
    }

    const last = this.lastSent.get(type);
    if (last !== undefined && nowMs - last < this.cooldownMs) {
      return false;
    }
    this.lastSent.set(type, nowMs);
    return true;
  }
}
