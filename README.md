# énigmot

Jeu de lettres quotidien en français : 7 lettres, une lettre centrale obligatoire, trouver les mots.
Rules and data decisions: see `CLAUDE.md`.

## Develop

Requires Node 24.

```sh
npm install
npm run build:words      # data/raw → data/out (word lists, report)
npm run puzzles          # data/out/puzzles.json (20 example puzzles)
cp .env.example .env.local   # then fill in the Supabase values (see below)
npm run dev              # http://localhost:5173
npm run typecheck
```

`npm run build` writes the static site to `dist/` (what Vercel deploys).

## Hosting and accounts

- **Vercel** serves the static site (`vercel.json`: builds the word lists, the puzzles, then `dist/`).
- **Supabase** handles accounts (Google, email + password) and stores each player's progress
  (`supabase/migrations/`). An account is required to play.

The page only ever gets the **publishable** key (public by design); the data is protected by row
level security: each player can only read and write their own rows. Never use the secret /
`service_role` key in this project (the build refuses keys that look secret).

### 1. Supabase project

1. Create a project at [supabase.com](https://supabase.com/dashboard) (region close to the players, e.g. Canada or EU).
2. **SQL Editor** → paste and run `supabase/migrations/20261125000000_progress.sql`.
3. **Project Settings → API**: copy the project URL and the **publishable** key into `.env.local`
   (`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`). The legacy `anon` key also works.
4. **Authentication → URL Configuration**:
   - Site URL: your production URL, e.g. `https://enigmot.vercel.app`
   - Redirect URLs: `http://localhost:5173/**`, `https://enigmot.vercel.app/**`,
     and for Vercel previews `https://*-<your-vercel-team>.vercel.app/**`
5. **Authentication → Sign In / Providers → Email**: keep "Confirm email" on.
   Supabase's built-in mailer only sends a few emails per hour: before launch, set up a custom SMTP
   (Authentication → Emails → SMTP, e.g. Resend or Postmark) and translate the email templates to French.

### 2. Google sign-in

1. [Google Cloud Console](https://console.cloud.google.com/) → create a project → **APIs & Services → OAuth consent screen**:
   External, app name "énigmot", support email; scopes: email, profile, openid.
2. **Credentials → Create credentials → OAuth client ID → Web application**:
   - Authorized JavaScript origins: `http://localhost:5173`, `https://enigmot.vercel.app`
   - Authorized redirect URI: `https://<project-ref>.supabase.co/auth/v1/callback`
     (shown in Supabase on the Google provider page)
3. Supabase → **Authentication → Sign In / Providers → Google**: enable, paste the client ID and secret.

### 3. Vercel

1. [vercel.com/new](https://vercel.com/new) → import the GitHub repo `JeuMotsQuotidien`.
   Framework preset: **Other** (settings come from `vercel.json`).
2. **Environment Variables** (Production and Preview): `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`.
3. Deploy. Every push to `main` deploys production; other branches get a preview URL
   (add it to the Supabase redirect URLs pattern above).
4. Optional: add a custom domain (Vercel → Domains), then add it to Supabase (Site URL, Redirect URLs)
   and to the Google OAuth origins.
