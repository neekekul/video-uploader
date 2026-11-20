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

## Running with Docker

You need [Docker Desktop](https://www.docker.com/products/docker-desktop/) running. Do the YouTube setup above first; the sign-in step (`npm run auth:youtube`) runs on your machine, not in the container.

```sh
npm run docker:up     # build the image and start it in the background
npm run docker:logs   # follow the logs
npm run docker:down   # stop it
```

The container restarts on its own, including after a reboot once Docker Desktop is running again. It mounts three folders from this project, which you can change in `.env`:

| On your machine                             | In the container    | Purpose                                   |
| ------------------------------------------- | ------------------- | ----------------------------------------- |
| `DROP_DIR` (default `./drop`)               | `/data/drop`        | inbox, done, failed                       |
| `CONFIG_DIR` (default `./config`)           | `/data/config`      | description header and footer (read-only) |
| `CREDENTIALS_DIR` (default `./credentials`) | `/data/credentials` | YouTube client secret and token           |

`SCHEDULE` is evaluated in UTC inside the container. Set `TZ` in `.env` (e.g. `TZ=America/Chicago`) to use your local time.

**Adding archives:** copy each archive somewhere on the same drive first, then move it into `inbox`. A move within the same drive is instant, so the app never sees a half-copied file. If an archive is picked up mid-copy anyway, it fails to extract and is retried on the next run.
