# ArsLive

Independent webinar platform in `arsenchios/marketing`. This is a fresh installation with its own data, accounts, branding and infrastructure. Never modify the source `webinar` project or connect to its production resources.

- Read README.md and docs/HANDOFF.md first. Inspect branch, remote and dirty work before editing.
- Platform identity is configured in shared/brand.ts; event/company branding remains data-driven. Keep src/arslive.css last in the stylesheet order. Respect reduced motion and light-theme contrast.
- Maintain server-side tenant/event authorization, Google OAuth/PKCE, invited access, one active media sender, bounded buffers and private recordings. Public mode must fail closed if setup is incomplete.
- Use a new PostgreSQL database, persistent volume, encryption key, Google OAuth app, R2 bucket and TURN key. Never copy production databases, credentials, recordings, contacts or operational notes from another product.
- Run ./scripts/local.sh check, test and build. For media or namespace changes, run the isolated synthetic browser/media and two-speaker scenarios in docs/TESTING.md. Never direct tests at production automatically.
- One media worker / one active broadcast. Do not increase replicas without changing ownership/routing. Do not deploy during an active broadcast.
- Distinguish local, committed, pushed, deployed and live-tested results. Publication requires the user's instruction; do not poll Railway after a push when the user will check it.
