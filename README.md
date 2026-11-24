# ERP UI Builder Prototype

Run the prototype locally with Cloudflare Wrangler, Neon Postgres, and Neon Auth.

## Run the app

1. Use Node.js 24 and install dependencies with `npm ci`.
2. Copy `.env.example` to `.env.local`. Set the values for the Neon branch you
   want to use. If the checkout is linked to that branch in Neon CLI, run
   `neon env pull` to populate the Neon values.
3. Run `npm run db:migrate` against that branch. The migration uses
   `DATABASE_URL_UNPOOLED` when available.
4. Run `npm run dev` and open `http://localhost:8787`. Sign in with an account
   on the configured Neon Auth branch.

Run `npm run build` to generate the browser bundle and check the Worker
package. Wrangler runs the browser build for local development and deployments.

## Configure the Worker

Set `DATABASE_URL` and, if using AI Gateway, `NEON_AI_GATEWAY_TOKEN` as
Worker secrets. Set `NEON_AUTH_BASE_URL` and `NEON_AUTH_JWKS_URL` as Worker
variables. If using AI Gateway, also set `NEON_AI_GATEWAY_BASE_URL`.
Add the deployed origin to Neon Auth's trusted domains.

To grant the first administrator access, set `ERP_ADMIN_USER_ID` to the ID
of the administrator's user on the configured Neon Auth branch. Other
authenticated users have the User role. Set the same variable in
`.env.local` when testing administrator behavior locally.

Use a development Neon branch when testing changes to data. Keep
`.env.local`, `.dev.vars` files, and credentials outside Git.
