import { prisma } from '../../lib/prisma.js';

/** Lobby win% / Balance model: μ/σ (`dynamic`), μ with fixed σ (`static`), or display ki (`ki`). */
export const BALANCE_MODES = ['dynamic', 'static', 'ki'] as const;
export type BalanceMode = (typeof BALANCE_MODES)[number];

/** Narrow a slash-command string to a {@link BalanceMode}. */
export function parseBalanceMode(value: string): BalanceMode | undefined {
  return (BALANCE_MODES as readonly string[]).includes(value) ? (value as BalanceMode) : undefined;
}

/** Current mode from the two league flags (`ki` wins if both are somehow set). */
export function balanceModeFromFlags(flags: {
  balanceStaticSigmaEnabled: boolean;
  balanceKiStrengthEnabled: boolean;
}): BalanceMode {
  if (flags.balanceKiStrengthEnabled) return 'ki';
  return flags.balanceStaticSigmaEnabled ? 'static' : 'dynamic';
}

/** Persist the balance mode; both flags are written together so modes never overlap. Apply path unchanged. */
export async function setBalanceMode(leagueId: string, mode: BalanceMode): Promise<void> {
  await prisma.league.update({
    where: { id: leagueId },
    data: {
      balanceStaticSigmaEnabled: mode === 'static',
      balanceKiStrengthEnabled: mode === 'ki',
    },
  });
}

/** Enable or disable the /rank per-side (team 1 / team 2) W–L line. */
export async function setShowSideWinLoss(leagueId: string, enabled: boolean): Promise<void> {
  await prisma.league.update({
    where: { id: leagueId },
    data: { showSideWinLoss: enabled },
  });
}

/** Enable or disable the lobby "Captain draft" button for this league. */
export async function setLobbyCaptainDraftEnabled(
  leagueId: string,
  enabled: boolean,
): Promise<void> {
  await prisma.league.update({
    where: { id: leagueId },
    data: { lobbyCaptainDraftEnabled: enabled },
  });
}
