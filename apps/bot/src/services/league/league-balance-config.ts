import { prisma } from '../../lib/prisma.js';

/** Enable or disable fixed σ=6 for lobby win% and balance hints (apply path unchanged). */
export async function setBalanceStaticSigmaEnabled(
  leagueId: string,
  enabled: boolean,
): Promise<void> {
  await prisma.league.update({
    where: { id: leagueId },
    data: { balanceStaticSigmaEnabled: enabled },
  });
}

/** Enable or disable the /rank per-side (team 1 / team 2) W–L line. */
export async function setShowSideWinLoss(leagueId: string, enabled: boolean): Promise<void> {
  await prisma.league.update({
    where: { id: leagueId },
    data: { showSideWinLoss: enabled },
  });
}
