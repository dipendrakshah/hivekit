# Hivekit UI mocks

Open these files in any browser. They are static and self-contained — no build step.

| File | Surface | What it shows |
| --- | --- | --- |
| [electron-macos.html](electron-macos.html) | Desktop workshop | Sidebar, chat + swarm, workspace, model roles |
| [android.html](android.html) | Phone companion | Connect, chat, jobs, approval sheet |
| [web-cloud.html](web-cloud.html) | Operator-hosted cloud | Dashboard, jobs table, keys (BYOK), deploy strip |

Design tokens (implement these in `apps/web`):

- Background `#12110e`
- Panel `#1c1a16`
- Line `#2e2a24`
- Text `#ece8df`
- Mute `#9a9286`
- Copper `#d4783a`
- Sage `#7a9e7e`
- Danger `#c45c4a`
- Font UI: `"IBM Plex Sans"`
- Font mono: `"IBM Plex Mono"`

Do not replace this with a generic purple-on-navy AI dashboard. The product is a workshop, not a chatbot landing page.
