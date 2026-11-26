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

Set `NEON_AUTH_COOKIE_SECRET` as a Worker secret to use the same-origin Auth
proxy for email sign-up, sign-in and sign-out. Generate a separate secret for
each environment with `openssl rand -base64 32`. The proxy lets browsers use
an app-domain session cookie even when they block cross-site cookies.

To grant the first administrator access, set `ERP_ADMIN_USER_ID` to the ID
of the administrator's user on the configured Neon Auth branch. Other
authenticated users have the User role. Set the same variable in
`.env.local` when testing administrator behavior locally.

Use a development Neon branch when testing changes to data. Keep
`.env.local`, `.dev.vars` files, and credentials outside Git.

## Configure purchase order metadata

Run `npm run db:migrate` on the target Neon branch before deploying the metadata API. If Workers Builds deploys on merge, apply the migration before merging. The migration preserves the current published layout and existing submissions.

Send a Neon Auth bearer token with each metadata request. Send same-origin
JSON for writes.

| Endpoint | Access | Request or response |
| --- | --- | --- |
| `GET /api/metadata` | Signed-in user | Returns published `config` and `revision`. |
| `GET /api/metadata/draft` | Admin | Returns editable `config` and `draftRevision`. |
| `PUT /api/metadata/draft` | Admin | Send `config` and the last read `draftRevision`. Returns the saved draft. |
| `POST /api/metadata/publish` | Admin | Send the saved `draftRevision`. Returns the published configuration and revision. |

Keep a field's `id` stable when editing its label. Reference the field ID
from the table columns, form, filters, and sort. A publish that removes a field
or changes its type while a submission has data for that field leaves the
published configuration and the submission intact. Address the conflict in
the draft and try again.

## Work with orders

Sign in as Admin to open Builder and configure the schema, form, columns,
filters, and sort. Save the draft, then publish it. Dashboard and order editing
use the published configuration. An authenticated User can create an order,
open it from Dashboard, edit it, or delete it.

`GET /api/orders?page=1` returns the published configuration, its `revision`,
and a page of records. `GET /api/orders/:id` returns a single record with its
`version`. For writes, send a same-origin JSON body with the authenticated
request.

| Method and path | Body |
| --- | --- |
| `POST /api/orders` | Published `revision` and `values` keyed by field ID |
| `PUT /api/orders/:id` | Published `revision`, the record's `version`, and `values` |
| `DELETE /api/orders/:id` | The record's `version` |

## Smoke-test a Cloudflare Preview

Use an isolated Neon database, run the migration, and configure the Worker
Preview's runtime secrets. Set up separate Admin and User test accounts on the
Preview's Neon Auth branch. Assign the Admin using `ERP_ADMIN_USER_ID`.

Set `ERP_PREVIEW_ORIGIN` to the Preview URL. Provide
`ERP_SMOKE_ADMIN_EMAIL`, `ERP_SMOKE_ADMIN_PASSWORD`, `ERP_SMOKE_USER_EMAIL`,
and `ERP_SMOKE_USER_PASSWORD` through your secret environment. Run
`node scripts/smoke-preview.js`. The script saves and publishes a test
configuration, checks the User's filtered and sorted list, and deletes the
orders it creates. It refuses to run when the database has unrelated
metadata or existing orders.
