export type CaptainDraftStatus = 'SETUP' | 'ACTIVE' | 'COMPLETE' | 'CANCELLED';

export type DraftParticipant = {
  key: string;
  label: string;
  discordId?: string;
};

export type DraftTeam = {
  captainKey: string;
  displayName: string;
  roster: DraftParticipant[];
  pickOrderIndex: number;
};

export type DraftState = {
  captains: DraftParticipant[];
  memberPool: DraftParticipant[];
  pickOrder: number[];
  teams: DraftTeam[];
  pickIndex: number;
};

export class CaptainDraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaptainDraftError';
  }
}

export function emptyDraftState(): DraftState {
  return { captains: [], memberPool: [], pickOrder: [], teams: [], pickIndex: 0 };
}
