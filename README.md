# video-uploader

A project that for now is going to be design for my own local use case. It will automatically upload a Youtube video from an archive on a schedule.

## YouTube setup

You only need to do this once. Google renames its console menus from time to time, so the labels below may differ slightly.

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project.
2. Go to **APIs & Services → Library** and enable **YouTube Data API v3**.
3. Configure the **OAuth consent screen** (Google Auth Platform):
   - Choose user type **External**, then fill in the app name and your email.
   - Under **Audience**, add your Google account as a test user.
   - Then **publish the app** (set it to "In production"). While it stays in "Testing", Google expires the refresh token after 7 days and uploads stop until you sign in again. You don't need Google's verification for personal use. You'll see an "unverified app" warning when you sign in; choose _Advanced → Go to (app name)_.
4. Go to **Credentials → Create credentials → OAuth client ID** and choose application type **Desktop app**. Download the JSON and save it as `credentials/youtube-client-secret.json`.
5. Run `npm run auth:youtube`, open the printed URL, and sign in with the account that owns the channel. The refresh token is saved to `credentials/youtube-token.json`.

Limits to know about:

- **Daily quota:** the default is 10,000 units per day. An upload costs about 1,600, so expect around 6 uploads a day. Archives that hit the quota are retried on the next run.
- **Private-only uploads:** until the project passes Google's [API compliance audit](https://support.google.com/youtube/contact/yt_api_form), every video uploaded through the API is locked to private. The result log warns you when this happens.
- **Custom thumbnails:** these need a phone-verified channel.
