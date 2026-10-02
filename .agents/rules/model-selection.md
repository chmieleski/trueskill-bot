# Model Selection Guidelines

| Work                                                            | Model Preference                                                  |
| --------------------------------------------------------------- | ----------------------------------------------------------------- |
| Default implementation (features, fixes, refactors, scripts)    | Standard Agent / Gemini 3.8 Flash (or Cursor Auto in Cursor)      |
| Architecture reviews, design critiques, multi-option trade-offs | Deep reasoning model (e.g. Gemini 3.8 Pro / Thinking or Grok 4.6) |
| Fast / lightweight reviews (quick sanity check, small diff)     | Lightweight / fast model                                          |

## Notes

- Use the default implementation model unless the user asks for a specific model or the task is an architecture/design review.
- For deep reviews and complex planning, prefer high-reasoning models.
- If the user explicitly selects or names a model in chat, that override wins for that turn.
