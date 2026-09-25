This readme will guide you how to run the examples app with an OAuth 2.0 client.

## Setup
First, we need to create test OAuth client. You can do it manually by creating the following in the OAuthClient table:
Run `yarn generate-secrets` in `apps/api/v2` and use the hashed and plain values from the same run. Choose a client ID for this local instance and replace `YOUR_CLIENT_ID` everywhere below.
  {
    "clientId": "YOUR_CLIENT_ID",
    "redirectUri": "http://localhost:4321",
    "clientSecret": "<HASHED_SECRET_FROM_GENERATOR>",
    "name": "atoms examples app oauth 2 client",
    "logo": null,
    "clientType": "confidential",
    "isTrusted": false,
    "createdAt": "2026-01-22 15:50:40.722",
    "purpose": "test atoms examples app with oauth 2",
    "rejectionReason": null,
    "status": "approved",
    "userId": 10,
    "websiteUrl": "http://localhost:4321"
  }
Or you can do it automatically by:
In the root .env set:
SEED_OAUTH2_CLIENT_ID=YOUR_CLIENT_ID
SEED_OAUTH2_CLIENT_SECRET_HASHED=<HASHED_SECRET_FROM_GENERATOR>
Then run yarn db-reset in the prisma folder which will create an OAuth client for the admin@example.com user.

Second, we need to setup environment for the examples app. Go to packages/platform/examples/base/.env and paste the following
NEXT_PUBLIC_OAUTH2_CLIENT_ID="YOUR_CLIENT_ID"
OAUTH2_CLIENT_SECRET_PLAIN="<PLAIN_SECRET_FROM_SAME_GENERATOR_RUN>"
OAUTH2_REDIRECT_URI="http://localhost:4321"
NEXT_PUBLIC_CALCOM_API_URL="http://localhost:5555/api/v2"

NEXT_PUBLIC_OAUTH2_MODE="true"
Here we have OAUTH2_CLIENT_SECRET_PLAIN in plain because it will be used for api request when exchanging authorization code for tokens. NEXT_PUBLIC_OAUTH2_MODE tells that the examples app will run not with platform OAuth client but with OAuth 2.0 client, so in the packages/platform/examples/base/src/pages/_app.tsx we will use CalOAuthProvider and not CalProvider.

## Usage
1. Before running the example app `packages/platform/examples/base` run `rm -f prisma/dev.db && yarn prisma db push` to reset its SQLite. If you don't and there are users already then an entry for the `admin@example.com` will not be created.
2. Start web app and examples app (it is important that examples app runs on localhost:4321 because that will be redirect uri)
3. Log in to the local web app with the admin account configured for your development instance.
4. Visit `http://localhost:3000/auth/oauth2/authorize?client_id=YOUR_CLIENT_ID&redirect_uri=http://localhost:4321&state=texas` (or your configured local web-app host), substitute your client ID, and authorize the test OAuth client. You will be redirected to localhost:4321 with an authorization code that the examples app exchanges for tokens.
5. Examples app is ready to use. If you update, let's say an availability, then it will be reflected in the availability of admin@example.com in the web app running locally.
