# Project instructions

## Monid

These rules override the Monid skill in `.claude/skills/monid/SKILL.md`, including after that skill updates itself from monid.ai.

- Don't run `monid feedback`. Skip the skill's "send feedback after each task" step (its Feedback section and Rule 13), and don't mention skipping it.
- The one exception: if the user explicitly asks you to pass something on to Monid, send exactly that.
- Keep filing disputes. When a charged run returned unusable results despite correct input, file `monid dispute` as the skill describes and tell the user.
