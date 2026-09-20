🛠️ **Staff — hero champion roles (UDBR)**

Give the **#1 hero-ki** player a Discord role per character. The bot adds/removes membership after rated matches. **UDBR only** for now.

**Need:** Manage Server (or Administrator) · bot **Manage Roles** · bot role **above** the champion roles

**1) Create roles** in Discord (e.g. `#1 Goku`, `#1 Vegeta`). One role per hero you care about.

**2) Map each hero → role**

```
/league_config set hero_champion_role hero:1 role:@#1 Goku
```

Hero `1–12` = UDBR lobby slots. Remapping the same hero replaces the role and clears the sticky holder until the next sync.

**3) Enable**

```
/league_config set hero_champion_roles enabled:True
```

**4) Clear one mapping**

```
/league_config clear hero_champion_role hero:1
```

Removes the mapping and tries to strip the role from the current holder.

**Rules**
• Eligibility matches public boards: Discord-linked, not calibrating (under 5 overall games), has hero games
• Ranked by **hero ki**
• Exact ki ties keep the **current holder** until someone strictly passes them
• Only **mapped** heroes sync; unmapped heroes are ignored
• See mappings + holders in `/config view`

**See also:** roles & first setup guide
