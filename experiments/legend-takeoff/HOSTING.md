# Hosted demo

Public URL: https://legend-takeoff.foamyhake64.chatgpt.site

Updated 2026-10-20 using Sites (version 4). Access: public (anyone with the URL). No third-party visitor invitations were sent.

Hosted source checkout: `/Users/charley/gits/legend-site`.
Site identity is recorded there in `.openai/hosting.json`; reuse it for updates rather than creating a second site.

- Project: `appgprj_6ad6d696941c8191aaa6f8f739d7d48b`
- Saved version: `appgprj_6ad6d696941c8191aaa6f8f739d7d48b~appgver_b8e498a0a6f081919100367baf709d20`
- Source commit: `582a631701fdb9197db8f95df0ac9f6b54433fe6`
- Deployment: `appgdep_6ad6e3c0bc948191b3a06196e22baf2b` (succeeded)

This static site includes the landing page, original assets, feature-plan notes and synthetic fixture evidence. The `/workspace.html` route opens real PDFs and scans them on-device. The separate `/review.html` fixture demo uses saved scanner evidence. No user document is sent to a server. Review decisions and entered rates stay in each browser tab until exported. History features remain labelled planned.

Pre-publication checks passed for real PDF controller integration, strict TypeScript, pricing arithmetic, production build, asset links and existing takeoff benchmarks. The raster fallback has a documented miss on an image-only fixture; digital PDFs remain the primary workflow. The native Sites result verified successful publication. Browser automation and visual QA remained paused at the user's request.

To update: synchronize intended experiment assets to the hosted checkout's `dist/`, retain the hosted-specific fixture/replay disclosures, then follow the Sites skill's source packaging and publication workflow. Credentials are never stored in this repository.

Code checkpoint in the private GitHub repository: `32ed8f3`. New project history/save-reopen functionality remains planned; current-page evidence/CSV/PDF exports are available.

Trade pages and improved pan/zoom controls were published in version 3, with source code checkpoint `a60a5b2`. All five trade URLs and their workspace links returned the expected published pages.

Version 4 adds General Builders, the public demo guide/full talk track, and controller reliability fixes. Code checkpoint: `ed7a185`. Published URLs and expected content were verified without browser automation.
