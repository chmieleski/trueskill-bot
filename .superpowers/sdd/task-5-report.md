# Task 5 report — Manual smoke (dev)

**Status:** DONE (checklist prepared; Discord UI smoke left for human)

## Automated verification already done (controller)

- `rg 'Team A|Team B' src --glob '*.ts'`: only JSDoc in `lobby-ocr.ts` and `rating-math.ts`
- `npm test`: 27 files, 184 tests PASS

## Human Discord smoke checklist

1. Restart `npm run dev` (or `npm run deploy-commands`) so slash choice labels refresh.
2. Spot-check:
   - Lobby embed: team headers + win % field names → Z Fighters / Evil
   - Slot add/move selects: themed team in labels
   - Report Winner buttons: `Z Fighters Won` / `Evil Won`
   - Completed embed: `{team} won the match.`

No code commit for this task.
