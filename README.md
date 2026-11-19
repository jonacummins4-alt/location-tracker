# location-tracker

Jon's location tracker. The page is a static site on Vercel. Reads and writes go through the `tracker-api` Edge Function, which checks a signed session and uses the service role.

Amy's tracker is [location-tracker-wife](https://github.com/jonacummins4-alt/location-tracker-wife). It calls the same function with her own session.

The lockdown SQL is in `docs/` and is not applied by this repo. Follow [docs/go-live.md](docs/go-live.md). Do not put secrets in this repo.
