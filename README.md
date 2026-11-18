# google-reviews-feed

A small Cloudflare Worker that fetches the **newest** Google reviews for a
Google Business Profile location and serves them as clean JSON. Built to feed
[OptiSigns](https://www.optisigns.com) digital signage through OptiSync
(Dynamic Data Mapping), so a team can see fresh customer reviews on office TVs.

## Why

OptiSigns' built-in Google Reviews Wall shows the top ~5 *most relevant*
reviews (it uses the Places API, which caps at 5). That's fine for a cafe, but
not for a team that wants to see what customers said this week. This Worker
uses the Google Business Profile API, which can list reviews newest-first, and
hands OptiSync a JSON feed it can read.

## How it works

```
Google Business Profile API --(hourly cron)--> Worker --> KV cache --> /reviews.json --> OptiSigns
```

- A cron trigger refreshes the cache every hour.
- `GET /reviews.json` serves the cached JSON instantly (no Google call per request).
- `GET /refresh` forces an immediate re-fetch. It requires an
  `Authorization: Bearer <REFRESH_SECRET>` header.
- Reviews with no text are skipped, text is capped at a configurable length,
  and the newest `REVIEW_COUNT` reviews are returned.

## Prerequisites

- A Cloudflare account (the free tier is enough) and Node.js.
- A Google Business Profile you own or manage that is **verified for 60+ days**
  and has a **website** listed.
- **Google's approval to use the Business Profile APIs.** These APIs are not
  self-serve: you must request access and be approved before API calls work
  (step 1 below). Enabling the API in Google Cloud is not enough.
- An OptiSigns plan with OptiSync (Pro Plus or above).

## Setup

### 1. Request access to the Business Profile APIs

The Business Profile APIs (including the `business.manage` scope this project
uses) require Google's approval. Calls fail until your Cloud project is
approved, even with valid OAuth credentials. This is the step most likely to
take time, so do it first.

Google's requirements (see their
[prerequisites](https://developers.google.com/my-business/content/prereqs)):

- You manage a Business Profile that is **verified and active for 60+ days**.
- The profile has a **website** listed that represents the business.
- You apply using a Google account that is an **owner or manager** of that profile.

To apply:

1. In [Google Cloud Console](https://console.cloud.google.com), create a
   project (or pick one) and note its **Project Number** from the dashboard.
2. Open Google's
   [Business Profile API contact form](https://support.google.com/business/contact/api_default).
3. Choose **Application for Basic API Access** and fill in your project
   number, business details and use case (for example, "display our newest
   reviews on internal office screens").
4. Wait for Google's approval. Google doesn't publish a timeline.

To check approval status, open **APIs & Services → Quotas** for your project
and look at the Business Profile API quota: **0 QPM means not approved yet,
300 QPM means approved.** The API is free to use. Approval is the only gate.

You can continue with the steps below while you wait, but the Worker won't
return reviews until access is approved.

### 2. Enable the APIs and create the OAuth client

1. In the same Cloud project, enable these APIs: **My Business Account
   Management API**, **My Business Business Information API**, and **Google
   My Business API** (the reviews endpoint lives in the v4 API).
2. Configure the OAuth consent screen with the scope
   `https://www.googleapis.com/auth/business.manage`, then set the publishing
   status to **In production**. While an app is in "Testing", Google expires
   refresh tokens after 7 days and your feed will silently stop updating.
3. Create an OAuth client of type **Web application** and add this authorized
   redirect URI: `https://developers.google.com/oauthplayground`
   (Desktop-app clients can't be used with the Playground.)

### 3. Get a refresh token and your account and location IDs

Use the [OAuth Playground](https://developers.google.com/oauthplayground):

1. Gear icon: check "Use your own OAuth credentials" and paste your client ID
   and secret.
2. Enter the scope `https://www.googleapis.com/auth/business.manage`, click
   **Authorize APIs**, and sign in with the account that manages the listing.
3. Click **Exchange authorization code for tokens** and save the **refresh token**.
4. In Step 3 of the Playground, send a GET to
   `https://mybusinessaccountmanagement.googleapis.com/v1/accounts`. The `name`
   field (`accounts/123...`) is your account ID.
5. Then send a GET to
   `https://mybusinessbusinessinformation.googleapis.com/v1/accounts/<ACCOUNT_ID>/locations?readMask=name,title`.
   The `name` of your business (`locations/456...`) is your location ID.

### 4. Configure and deploy

```bash
npm install
npx wrangler login
npx wrangler kv namespace create REVIEWS_KV
cp wrangler.example.toml wrangler.toml
```

Edit `wrangler.toml` with your KV namespace ID, account ID, location ID and
business name. It is git-ignored, so your real IDs stay out of the repo. Then
set the secrets (each command prompts you to paste the value):

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_REFRESH_TOKEN
npx wrangler secret put REFRESH_SECRET
npx wrangler deploy
```

`REFRESH_SECRET` is any long random string you make up (for example the
output of `openssl rand -hex 24`). It protects the `/refresh` endpoint. If
it isn't set, `/refresh` is disabled.

For local testing, copy `.dev.vars.example` to `.dev.vars` and fill it in.

### 5. Check it

```bash
curl -H "Authorization: Bearer <your REFRESH_SECRET>" https://<your-worker>.workers.dev/refresh
```

You should see JSON with your rating and reviews. Afterwards
`https://<your-worker>.workers.dev/reviews.json` serves the cached copy.

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `BUSINESS_NAME` | Shown in the feed's `business` field | empty |
| `GOOGLE_ACCOUNT_ID` / `GOOGLE_LOCATION_ID` | Which listing to read | required |
| `REVIEW_COUNT` | Number of newest reviews with text to return | 5 |
| `MAX_REVIEW_CHARS` | Reviews longer than this are cut at a word boundary and end in `...` | 300 |

## Feed format

```json
{
  "business": "Your Business Name",
  "rating": 4.9,
  "review_count": 1234,
  "updated_at": "2026-01-01T12:00:00.000Z",
  "reviews": [
    {
      "name": "Sarah M.",
      "stars": 5,
      "stars_display": "★★★★★",
      "date": "January 2026",
      "text": "Great service from start to finish.",
      "text_with_name": "\"Great service from start to finish.\" - Sarah M.",
      "source": "Google"
    }
  ]
}
```

## Using it in OptiSigns

1. **More → DataSources → Add Request**: name it, set the URL to
   `https://<your-worker>.workers.dev/reviews.json`, leave headers empty, and
   run the test (expect a 200).
2. In Designer: **DataSources → Add DataSource → API Gateway**, pick the
   request, and select the `reviews` array.
3. Drag the fields into **one** Repeater. Use a single repeater with all
   fields inside it. Separate repeaters per field rotate independently and
   drift out of sync (names no longer match reviews).
4. In the Repeater settings, set **Total Items Displayed per Page** to 1, set
   **Duration (seconds)** and a **Page Transition**.

Tips learned along the way:

- OptiSync may not render special characters. If `stars_display` or text with
  curly quotes shows blank, use the numeric `stars` field with star graphics.
- Designer has no documented shrink-to-fit for text, so size your text box for
  `MAX_REVIEW_CHARS` and adjust that value to match.
- `text_with_name` joins the review and reviewer in one field, which avoids
  alignment problems between separate elements.

## Troubleshooting

- **`redirect_uri_mismatch` in the Playground:** the OAuth client must be
  "Web application" with the Playground redirect URI added.
- **`unauthorized_client` on token refresh:** the client ID, secret and
  refresh token must all come from the same OAuth client.
- **403 `SERVICE_DISABLED`:** enable the Google My Business API on the project.
- **403 or quota errors even though the APIs are enabled:** your access
  request may not be approved yet. Check the quota in Cloud Console (0 QPM
  means pending) and see step 1.
- **Reviews stop updating after about a week:** the consent screen is still
  in "Testing". Publish it and generate a new refresh token.
- Logs: `npx wrangler tail`, or the Logs tab in the Cloudflare dashboard.

## Security notes

- Secrets (`GOOGLE_*`) live only in Cloudflare and are never committed.
- `/reviews.json` is public by design, since OptiSigns reads it without auth.
  It contains only information already public on Google (reviewer display
  names and review text).
- `/refresh` triggers a Google API call, so it requires the `REFRESH_SECRET`
  bearer token (compared in constant time). Without the secret configured it
  returns 404, and with a wrong or missing token it returns 401. The hourly
  cron doesn't use this endpoint.

## License

[MIT](LICENSE)

## Disclaimer

Not affiliated with or endorsed by Google or OptiSigns.
