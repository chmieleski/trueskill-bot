import { describe, expect, it } from 'vitest';
import { formatHeroChampionRolesLine } from './config-shared.js';

describe('formatHeroChampionRolesLine', () => {
  it('reports unset when no heroes are mapped', () => {
    expect(formatHeroChampionRolesLine(false, [])).toBe(
      '**Hero champion roles:** `off` · no heroes mapped',
    );
  });

  it('summarizes mapped heroes on one line (stays under Discord reply budget)', () => {
    const mappings = Array.from({ length: 12 }, (_, i) => ({
      heroId: i + 1,
      heroName: `Hero${i + 1}`,
      discordRoleId: '1181331071867031500',
      holderDiscordId: i % 2 === 0 ? '1181331071867031501' : null,
    }));

    const line = formatHeroChampionRolesLine(true, mappings);
    expect(line).toBe(
      '**Hero champion roles:** `on` · `12` heroes mapped · manage with `/hero_champion_config`',
    );
    expect(line.length).toBeLessThan(120);
    expect(line).not.toContain('<@&');
    expect(line).not.toContain('\n');
  });

  it('uses singular copy for one mapping', () => {
    expect(
      formatHeroChampionRolesLine(true, [
        {
          heroId: 1,
          heroName: 'Goku',
          discordRoleId: 'role-1',
          holderDiscordId: null,
        },
      ]),
    ).toBe('**Hero champion roles:** `on` · `1` hero mapped · manage with `/hero_champion_config`');
  });
});
