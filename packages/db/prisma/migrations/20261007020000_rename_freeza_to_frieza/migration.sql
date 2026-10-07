-- Fix hero spelling: Freeza -> Frieza. Heroes are referenced by id, so only the display name changes.
-- No-op when already renamed (or if a "Frieza" row would collide with the unique name).
UPDATE "Hero"
SET "name" = 'Frieza'
WHERE "name" = 'Freeza'
  AND NOT EXISTS (SELECT 1 FROM "Hero" WHERE "name" = 'Frieza');
