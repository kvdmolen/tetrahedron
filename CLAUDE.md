# Tetra

Rope sculpture controller: Node backend + Vue 3 frontend, Leadshine iCL57-RS13 steppers over RS485/Modbus.

Read first:
- `README.md`: how it works and how to run it.
- `docs/findings.md`: hardware facts, design decisions and why (rope-length relations, transition, homing), test
  status and open items.
- `docs/music.md`: ideas for music-driven movement (not built).

Working agreements:
- Discuss first when the user asks to; ask before guessing on hardware questions.
- Vue single-file components: `<template>` before `<script setup>`.
- Run `npm test` in `backend/` after changes. Browser tests: use the `tetra-mock-alt-port` launch config (port 4100).
  Never stop the user's own server on port 4000. Stop your server when done; when a script clicks Home, override
  `window.confirm`.
- After frontend changes, build it (`npx vite build` in `frontend/`): the backend serves `frontend/dist`. The user
  restarts their own server.
- Commit or push only when asked.
