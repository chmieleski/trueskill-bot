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
