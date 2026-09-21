import { ApplicationCommandOptionType } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { data } from './lobby.js';

describe('lobby command data', () => {
  it('requires a slot and accepts nick or user on add', () => {
    const json = data.toJSON();
    const add = json.options?.find((option) => option.name === 'add');
    const options = add && 'options' in add ? (add.options ?? []) : [];

    const nick = options.find((option) => option.name === 'nick');
    const user = options.find((option) => option.name === 'user');
    const slot = options.find((option) => option.name === 'slot');

    expect(nick?.required).toBeFalsy();
    expect(user?.required).toBeFalsy();
    expect(user?.type).toBe(ApplicationCommandOptionType.User);
    expect(slot?.required).toBe(true);
  });

  it('requires a screenshot attachment on screenshot', () => {
    const json = data.toJSON();
    const screenshot = json.options?.find((option) => option.name === 'screenshot');
    const options = screenshot && 'options' in screenshot ? (screenshot.options ?? []) : [];
    const print = options.find((option) => option.name === 'print');

    expect(screenshot).toBeDefined();
    expect(print?.required).toBe(true);
    expect(print?.type).toBe(ApplicationCommandOptionType.Attachment);
  });

  it('exposes sync with optional wc3stats_id', () => {
    const json = data.toJSON();
    const sync = json.options?.find((option) => option.name === 'sync');
    const options = sync && 'options' in sync ? (sync.options ?? []) : [];
    const wc3statsId = options.find((option) => option.name === 'wc3stats_id');

    expect(sync).toBeDefined();
    expect(wc3statsId?.required).toBeFalsy();
    expect(wc3statsId?.type).toBe(ApplicationCommandOptionType.Integer);
  });

  it('describes cancel as host or match moderator', () => {
    const json = data.toJSON();
    const cancel = json.options?.find((option) => option.name === 'cancel');

    expect(cancel).toBeDefined();
    expect(cancel && 'description' in cancel ? cancel.description : '').toMatch(/moderator/i);
  });

  it('exposes swap with optional slots and pairs', () => {
    const json = data.toJSON();
    const swap = json.options?.find((option) => option.name === 'swap');
    const options = swap && 'options' in swap ? (swap.options ?? []) : [];

    const slotA = options.find((option) => option.name === 'slot_a');
    const slotB = options.find((option) => option.name === 'slot_b');
    const pairs = options.find((option) => option.name === 'pairs');

    expect(slotA?.required).toBeFalsy();
    expect(slotB?.required).toBeFalsy();
    expect(pairs?.required).toBeFalsy();
    expect(pairs?.type).toBe(ApplicationCommandOptionType.String);
    expect(swap && 'description' in swap ? swap.description : '').toMatch(/pairs/i);
  });

  it('describes screenshot as host or match moderator', () => {
    const json = data.toJSON();
    const screenshot = json.options?.find((option) => option.name === 'screenshot');
    const options = screenshot && 'options' in screenshot ? (screenshot.options ?? []) : [];
    const matchId = options.find((option) => option.name === 'match_id');

    expect(screenshot).toBeDefined();
    expect(screenshot && 'description' in screenshot ? screenshot.description : '').toMatch(
      /moderator/i,
    );
    expect(matchId && 'description' in matchId ? matchId.description : '').toMatch(/not the host/i);
  });

  it('describes remove as host or match moderator', () => {
    const json = data.toJSON();
    const remove = json.options?.find((option) => option.name === 'remove');
    const options = remove && 'options' in remove ? (remove.options ?? []) : [];
    const matchId = options.find((option) => option.name === 'match_id');

    expect(remove).toBeDefined();
    expect(remove && 'description' in remove ? remove.description : '').toMatch(/moderator/i);
    expect(matchId && 'description' in matchId ? matchId.description : '').toMatch(/not the host/i);
  });

  it('exposes recreate with required cancelled match_id (mods only)', () => {
    const json = data.toJSON();
    const recreate = json.options?.find((option) => option.name === 'recreate');
    const options = recreate && 'options' in recreate ? (recreate.options ?? []) : [];
    const matchId = options.find((option) => option.name === 'match_id');

    expect(recreate).toBeDefined();
    expect(recreate && 'description' in recreate ? recreate.description : '').toMatch(/cancel/i);
    expect(recreate && 'description' in recreate ? recreate.description : '').toMatch(/mods only/i);
    expect(matchId?.required).toBe(true);
  });
});
