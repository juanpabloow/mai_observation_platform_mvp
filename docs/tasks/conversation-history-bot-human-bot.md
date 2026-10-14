# Separate task (NOT implemented): conversation history in bot → human → bot

**Status:** pending. Left out of the explainable availability work (`feature/availability-explain`) on purpose.

## Problem
A conversation can go from the bot to a person (handoff) and later back to the bot. When it returns, the bot may not have the messages exchanged during the human stretch:
- what was agreed;
- which artist was mentioned;
- whether a booking was already confirmed.

## Out of the current scope
- recovering context;
- changing the agent's memory;
- syncing messages between the channel, M_AI and n8n.

None of that was touched.

## Questions to settle before designing it
- **Source of truth for the human stretch.** Options: M_AI conversations (`conversations` / messages), the WhatsApp provider, or n8n memory.
- **What goes back to the model.** Options: the full transcript, a summary, or only structured facts (booking, artist, consent).
- **Privacy.** Human messages may contain personal or team data that must not reach the model.
- **Duplicate prevention.** What happens if a booking was made by a human and the bot tries to repeat it.
- **Tests.** A conversation with a handoff and a return must be tested on an isolated environment, never on real conversations.
